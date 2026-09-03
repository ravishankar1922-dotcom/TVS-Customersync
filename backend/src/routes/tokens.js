const express = require('express');
const router  = express.Router();
const cfg     = require('../config');
const Customer     = require('../models/Customer');
const TokenRecord  = require('../models/TokenRecord');
const LedgerEntry  = require('../models/LedgerEntry');
const Confirmation = require('../models/Confirmation');
const te = require('../utils/tokenEngine');
const { requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

// POST /api/tokens/generate — admin only
// Body: { customer_ids?: string[], expiry_hours?: number, expiry_date?: ISOString }
// - customer_ids omitted => generate for ALL customers
// - expiry_date, if given, wins over expiry_hours
router.post('/generate', requireAdmin, async (req, res) => {
  const { customer_ids, expiry_hours, expiry_date } = req.body || {};

  const filter = customer_ids && customer_ids.length ? { customer_id: { $in: customer_ids } } : {};
  const customers = await Customer.find(filter).lean();
  if (!customers.length) return res.status(404).json({ error: 'No matching customers found' });

  const generated = [];
  const skipped   = [];

  for (const c of customers) {
    const existing = await TokenRecord.findOne({ customer_id: c.customer_id, cycle_id: cfg.CYCLE_ID, status: 'ACTIVE' });
    if (existing && existing.expires_at > new Date()) { skipped.push(c.customer_id); continue; }

    let hours = expiry_hours && expiry_hours > 0 ? expiry_hours : cfg.TOKEN_EXPIRY_HOURS;
    if (expiry_date) {
      const target = new Date(expiry_date);
      hours = Math.max(1, Math.round((target.getTime() - Date.now()) / 3600000));
    }

    const result = te.generateToken(c.customer_id, cfg.CYCLE_ID, cfg.COMPANY, hours);
    const record = await TokenRecord.findOneAndUpdate(
      { customer_id: c.customer_id, cycle_id: cfg.CYCLE_ID, status: { $ne: 'ACTIVE' } },
      {
        token_id: result.token_id, customer_id: c.customer_id, cycle_id: cfg.CYCLE_ID, company: cfg.COMPANY,
        token: result.token, portal_url: te.buildPortalUrl(result.token),
        created_at: new Date(result.issued_at), expires_at: new Date(result.expires_at),
        status: 'ACTIVE', used_at: null,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    generated.push({ customer_id: c.customer_id, token_id: record.token_id, portal_url: record.portal_url, expires_at: record.expires_at });
  }

  await logAudit({ req, action: 'TOKEN_GENERATE', entity_type: 'Token', details: { generated: generated.length, skipped: skipped.length, expiry_hours, expiry_date } });
  res.json({ ok: true, generated: generated.length, skipped: skipped.length, tokens: generated });
});

// PATCH /api/tokens/:tokenId/expiry — admin adjusts expiry on an existing token
router.patch('/:tokenId/expiry', requireAdmin, async (req, res) => {
  const { expiry_date } = req.body;
  if (!expiry_date) return res.status(400).json({ error: 'expiry_date is required' });
  const rec = await TokenRecord.findOneAndUpdate({ token_id: req.params.tokenId }, { expires_at: new Date(expiry_date) }, { new: true });
  if (!rec) return res.status(404).json({ error: 'Token not found' });
  await logAudit({ req, action: 'TOKEN_EXPIRY_CHANGED', entity_type: 'Token', entity_id: rec.token_id, details: { new_expiry: rec.expires_at } });
  res.json({ ok: true, token: rec });
});

// POST /api/tokens/validate — first factor: is the link itself genuine + unexpired?
// Does NOT return balance/transactions yet — see /verify-pan for that (two-factor gate).
router.post('/validate', async (req, res) => {
  const { token } = req.body;
  const result = te.validateToken(token);
  if (!result.valid) return res.status(400).json({ valid: false, reason: result.reason });

  const { payload } = result;
  const record = await TokenRecord.findOne({ token_id: payload.token_id });
  if (!record) return res.status(400).json({ valid: false, reason: 'TOKEN_NOT_REGISTERED' });
  if (record.status === 'USED')    return res.status(400).json({ valid: false, reason: 'ALREADY_USED', customer_id: payload.customer_id });
  if (record.status === 'REVOKED') return res.status(400).json({ valid: false, reason: 'REVOKED' });

  const customer = await Customer.findOne({ customer_id: payload.customer_id }).lean();
  res.json({
    valid: true,
    customer_id: payload.customer_id,
    cycle_id: payload.cycle_id,
    token_id: payload.token_id,
    expires_at: payload.expires_at,
    customer_name: customer ? customer.customer_name : null,
    requires_pan: true,
  });
});

// POST /api/tokens/verify-pan — second factor: customer proves they hold the PAN on file.
// Only after this succeeds do we release balance + transaction lines.
router.post('/verify-pan', async (req, res) => {
  const { token, pan } = req.body;
  const result = te.validateToken(token);
  if (!result.valid) return res.status(400).json({ valid: false, reason: result.reason });

  const { payload } = result;
  const record = await TokenRecord.findOne({ token_id: payload.token_id });
  if (!record || record.status === 'USED' || record.status === 'REVOKED') {
    return res.status(400).json({ valid: false, reason: 'TOKEN_INVALID' });
  }

  const customer = await Customer.findOne({ customer_id: payload.customer_id });
  if (!customer) return res.status(404).json({ valid: false, reason: 'CUSTOMER_NOT_FOUND' });

  if (!pan || pan.trim().toUpperCase() !== customer.pan) {
    await logAudit({ req, actor: `CUSTOMER:${customer.customer_id}`, actor_role: 'customer', action: 'PAN_VERIFY_FAILED', entity_type: 'Customer', entity_id: customer.customer_id });
    return res.status(401).json({ valid: false, reason: 'PAN_MISMATCH' });
  }

  record.pan_verified_at = new Date();
  await record.save();
  await logAudit({ req, actor: `CUSTOMER:${customer.customer_id}`, actor_role: 'customer', action: 'PAN_VERIFY_SUCCESS', entity_type: 'Customer', entity_id: customer.customer_id });

  const ledger = await LedgerEntry.findOne({ customer_id: payload.customer_id }).lean();
  const sapBalance = ledger ? ledger.transactions.filter(t => t.status === 'OPEN').reduce((s, t) => s + (t.amount || 0), 0) : 0;

  res.json({
    valid: true,
    customer_id: payload.customer_id,
    cycle_id: payload.cycle_id,
    token_id: payload.token_id,
    expires_at: payload.expires_at,
    customer: { customer_id: customer.customer_id, customer_name: customer.customer_name, company: customer.company },
    sap_balance: sapBalance,
    as_of_date: cfg.AS_OF_DATE,
    transactions: ledger ? ledger.transactions : [],
  });
});

// POST /api/tokens/reset/:customerId — admin resets token + confirmation for re-testing
router.post('/reset/:customerId', requireAdmin, async (req, res) => {
  await TokenRecord.updateMany({ customer_id: req.params.customerId, cycle_id: cfg.CYCLE_ID }, { status: 'REVOKED' });
  await Confirmation.deleteOne({ customer_id: req.params.customerId, cycle_id: cfg.CYCLE_ID });
  await logAudit({ req, action: 'CUSTOMER_RESET', entity_type: 'Customer', entity_id: req.params.customerId });
  res.json({ ok: true, message: `Token and confirmation reset for ${req.params.customerId}` });
});

// GET /api/tokens — admin view of all tokens
router.get('/', requireAdmin, async (req, res) => {
  const tokens = await TokenRecord.find().lean();
  res.json({ tokens });
});

module.exports = router;
