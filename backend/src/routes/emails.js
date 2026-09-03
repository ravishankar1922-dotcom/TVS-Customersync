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

// GET /api/emails/outlook-script
// Generates a PowerShell script that uses the admin's own Desktop Outlook
// (via COM automation) to DRAFT one email per customer — for environments
// where the live backend's outbound SMTP is blocked/throttled by the mail
// provider (a common issue with cloud hosts sending direct-SMTP to O365),
// but a locally-run script still benefits from the admin's own trusted
// network/mailbox. Drafts are saved to Outlook's Drafts folder for review —
// nothing is auto-sent — so nothing leaves the building without a human
// looking at it first, and this also avoids Outlook's "a program is trying
// to send mail" security prompt, which only fires on programmatic Send().
router.get('/outlook-script', requireAdmin, async (req, res) => {
  const customers = await Customer.find().lean();
  if (!customers.length) return res.status(404).json({ error: 'No customers found' });

  const mails = [];
  for (const c of customers) {
    const { tokenRec, sapBalance } = await ensureTokenAndBalance(c);
    const subject = `${cfg.COMPANY} Customer Balance Confirmation – ${cfg.AS_OF_DATE}`;
    const html    = confirmationRequestEmail(c, sapBalance, tokenRec.portal_url, cfg.AS_OF_DATE, cfg.TOKEN_EXPIRY_HOURS);
    const to      = c.email?.match(/<(.+)>/)?.[1] || c.email;

    mails.push({ to, subjectB64: Buffer.from(subject, 'utf8').toString('base64'), bodyB64: Buffer.from(html, 'utf8').toString('base64') });

    await EmailLog.findOneAndUpdate(
      { customer_id: c.customer_id, cycle_id: cfg.CYCLE_ID, kind: 'CONFIRMATION_REQUEST' },
      {
        customer_id: c.customer_id, customer_name: c.customer_name, email: c.email,
        cycle_id: cfg.CYCLE_ID, token_id: tokenRec.token_id, portal_url: tokenRec.portal_url, subject,
        kind: 'CONFIRMATION_REQUEST', status: 'DRAFT_CREATED', error: null, sent_at: new Date(),
      },
      { upsert: true }
    );
  }

  await logAudit({ req, action: 'EMAIL_OUTLOOK_SCRIPT_GENERATED', entity_type: 'Customer', details: { total: mails.length } });

  // Each mail entry as its own PowerShell hashtable literal — To is a plain
  // string (safe, no HTML/unicode), Subject/Body travel as base64 so no
  // quoting, unicode, or injection concerns ever reach the .ps1 source.
  const mailEntries = mails.map(m =>
    `  @{ To = '${m.to.replace(/'/g, "''")}'; SubjectB64 = '${m.subjectB64}'; BodyB64 = '${m.bodyB64}' }`
  ).join(",\n");

  const script = `# BalanceSync — Outlook draft generator
# Generated ${new Date().toISOString()} for cycle ${cfg.CYCLE_ID} (${mails.length} customer(s))
#
# What this does: creates one DRAFT email per customer in your Desktop
# Outlook's Drafts folder, using YOUR machine/mailbox to send from (so it
# isn't blocked the way cloud-server SMTP sometimes is against O365).
# Nothing is sent automatically — review each draft in Outlook, then send
# manually (or select all in Drafts and send in bulk once you're satisfied).
#
# To run: right-click this file -> "Run with PowerShell". If Windows blocks
# it, open Command Prompt in this folder and run:
#   powershell -ExecutionPolicy Bypass -File "BalanceSync_Outlook_Drafts_${cfg.CYCLE_ID}.ps1"
#
# Requires: Desktop Outlook installed and signed in to the sending mailbox.

$mails = @(
${mailEntries}
)

Write-Host "Connecting to Outlook..." -ForegroundColor Cyan
$outlook = New-Object -ComObject Outlook.Application

$done = 0
foreach ($m in $mails) {
  try {
    $subject = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($m.SubjectB64))
    $body    = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($m.BodyB64))
    $mail = $outlook.CreateItem(0)  # olMailItem
    $mail.To = $m.To
    $mail.Subject = $subject
    $mail.HTMLBody = $body
    $mail.Save()  # saves to Drafts — does NOT send
    $done++
    Write-Host "  Drafted -> $($m.To)" -ForegroundColor Green
  } catch {
    Write-Host "  FAILED  -> $($m.To): $($_.Exception.Message)" -ForegroundColor Red
  }
}

Write-Host ""
Write-Host "Done. $done of $($mails.Count) draft(s) created in Outlook > Drafts." -ForegroundColor Cyan
Write-Host "Review them there, then send individually or select-all + send."
`;

  // UTF-8 BOM so Windows PowerShell 5.1 (which otherwise guesses the system
  // codepage for script files without a BOM) reads this as UTF-8 reliably.
  const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
  const buf = Buffer.concat([bom, Buffer.from(script, 'utf8')]);

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="BalanceSync_Outlook_Drafts_${cfg.CYCLE_ID}.ps1"`);
  res.send(buf);
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
