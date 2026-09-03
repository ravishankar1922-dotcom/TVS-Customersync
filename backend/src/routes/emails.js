const express = require('express');
const router  = express.Router();
const cfg     = require('../config');
const Customer = require('../models/Customer');
const LedgerEntry = require('../models/LedgerEntry');
const TokenRecord = require('../models/TokenRecord');
const EmailLog = require('../models/EmailLog');
const te = require('../utils/tokenEngine');
const { sendMail, isConfigured } = require('../utils/mailer');
const { confirmationRequestEmail } = require('../utils/emailTemplates');
const { requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

async function ensureTokenAndBalance(customer) {
  let tokenRec = await TokenRecord.findOne({ customer_id: customer.customer_id, cycle_id: cfg.CYCLE_ID, status: 'ACTIVE' });
  if (!tokenRec) {
    const gen = te.generateToken(customer.customer_id, cfg.CYCLE_ID, cfg.COMPANY, cfg.TOKEN_EXPIRY_HOURS);
    tokenRec = await TokenRecord.create({
      token_id: gen.token_id, customer_id: customer.customer_id, cycle_id: cfg.CYCLE_ID, company: cfg.COMPANY,
      token: gen.token, portal_url: te.buildPortalUrl(gen.token),
      created_at: new Date(gen.issued_at), expires_at: new Date(gen.expires_at), status: 'ACTIVE',
    });
  }
  const led = await LedgerEntry.findOne({ customer_id: customer.customer_id }).lean();
  const sapBalance = led ? led.transactions.filter(t => t.status === 'OPEN').reduce((s, t) => s + (t.amount || 0), 0) : 0;
  return { tokenRec, sapBalance };
}

async function sendConfirmationEmail(customer) {
  const { tokenRec, sapBalance } = await ensureTokenAndBalance(customer);
  const subject = `${cfg.COMPANY} Customer Balance Confirmation – ${cfg.AS_OF_DATE}`;
  const html    = confirmationRequestEmail(customer, sapBalance, tokenRec.portal_url, cfg.AS_OF_DATE, cfg.TOKEN_EXPIRY_HOURS);

  let status = 'READY', errorMsg = null;
  if (isConfigured()) {
    try {
      await sendMail({ to: customer.email?.match(/<(.+)>/)?.[1] || customer.email, subject, html });
      status = 'SENT';
    } catch (err) {
      status = 'FAILED';
      errorMsg = err.message;
    }
  } else {
    status = 'READY'; // SMTP not configured — link is generated/logged, admin can copy it manually
  }

  await EmailLog.findOneAndUpdate(
    { customer_id: customer.customer_id, cycle_id: cfg.CYCLE_ID, kind: 'CONFIRMATION_REQUEST' },
    {
      customer_id: customer.customer_id, customer_name: customer.customer_name, email: customer.email,
      cycle_id: cfg.CYCLE_ID, token_id: tokenRec.token_id, portal_url: tokenRec.portal_url, subject,
      kind: 'CONFIRMATION_REQUEST', status, error: errorMsg, sent_at: new Date(),
    },
    { upsert: true }
  );

  return { customer_id: customer.customer_id, customer_name: customer.customer_name, status, portal_url: tokenRec.portal_url, error: errorMsg };
}

// POST /api/emails/trigger — bulk, all customers
router.post('/trigger', requireAdmin, async (req, res) => {
  const customers = await Customer.find().lean();
  if (!customers.length) return res.status(404).json({ error: 'No customers found' });

  const results = [];
  for (const c of customers) {
    try { results.push(await sendConfirmationEmail(c)); }
    catch (err) { results.push({ customer_id: c.customer_id, status: 'FAILED', error: err.message }); }
  }
  await logAudit({ req, action: 'EMAIL_TRIGGER_BULK', entity_type: 'Customer', details: { total: customers.length } });

  res.json({
    ok: true,
    smtp_configured: isConfigured(),
    total: customers.length,
    sent: results.filter(r => r.status === 'SENT').length,
    ready: results.filter(r => r.status === 'READY').length,
    failed: results.filter(r => r.status === 'FAILED').length,
    results,
    note: isConfigured()
      ? 'Emails sent via SMTP.'
      : 'SMTP not configured — portal links generated and logged. Configure SMTP_* in .env to send automatically, or copy links from the Email Log.',
  });
});

// POST /api/emails/trigger/:customerId — single customer, on demand
router.post('/trigger/:customerId', requireAdmin, async (req, res) => {
  const customer = await Customer.findOne({ customer_id: req.params.customerId }).lean();
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const result = await sendConfirmationEmail(customer);
  await logAudit({ req, action: 'EMAIL_TRIGGER_SINGLE', entity_type: 'Customer', entity_id: customer.customer_id });
  res.json({ ok: true, smtp_configured: isConfigured(), result });
});

// GET /api/emails/log
router.get('/log', requireAdmin, async (req, res) => {
  const emails = await EmailLog.find().sort({ createdAt: -1 }).lean();
  res.json({ emails });
});

// GET /api/emails/preview/:customerId
router.get('/preview/:customerId', requireAdmin, async (req, res) => {
  const customer = await Customer.findOne({ customer_id: req.params.customerId }).lean();
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const tokenRec = await TokenRecord.findOne({ customer_id: customer.customer_id, cycle_id: cfg.CYCLE_ID }).lean();
  const portalUrl = tokenRec ? tokenRec.portal_url : `${cfg.FRONTEND_URL}/portal?t=PREVIEW_ONLY`;
  const led = await LedgerEntry.findOne({ customer_id: customer.customer_id }).lean();
  const sapBalance = led ? led.transactions.filter(t => t.status === 'OPEN').reduce((s, t) => s + (t.amount || 0), 0) : 0;

  const html = confirmationRequestEmail(customer, sapBalance, portalUrl, cfg.AS_OF_DATE, cfg.TOKEN_EXPIRY_HOURS);
  res.json({ subject: `${cfg.COMPANY} Customer Balance Confirmation – ${cfg.AS_OF_DATE}`, body: html, portal_url: portalUrl });
});

module.exports = router;
