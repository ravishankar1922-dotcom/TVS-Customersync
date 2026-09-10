const express = require('express');
const router  = express.Router();
const rateLimit = require('express-rate-limit');
const cfg     = require('../config');
const Customer     = require('../models/Customer');
const TokenRecord  = require('../models/TokenRecord');
const LedgerEntry  = require('../models/LedgerEntry');
const Confirmation = require('../models/Confirmation');
const Lot          = require('../models/Lot');
const te = require('../utils/tokenEngine');
const { requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const ExcelJS = require('exceljs');

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
    // Skip only if there's a token that is BOTH status ACTIVE and not yet
    // past its own expiry — an ACTIVE-but-expired record must still be
    // replaced (status never auto-flips to EXPIRED on its own).
    const existing = await TokenRecord.findOne({ customer_id: c.customer_id, cycle_id: cfg.CYCLE_ID, status: 'ACTIVE' }).sort({ expires_at: -1 });
    if (existing && existing.expires_at > new Date()) { skipped.push(c.customer_id); continue; }

    let hours = expiry_hours && expiry_hours > 0 ? expiry_hours : cfg.TOKEN_EXPIRY_HOURS;
    if (expiry_date) {
      const target = new Date(expiry_date);
      hours = Math.max(1, Math.round((target.getTime() - Date.now()) / 3600000));
    }

    // Retire any stale ACTIVE-but-expired record first, then create the
    // fresh one — avoids ever having two ACTIVE tokens for the same
    // customer/cycle where a later lookup could pick the wrong (dead) one.
    await TokenRecord.updateMany({ customer_id: c.customer_id, cycle_id: cfg.CYCLE_ID, status: 'ACTIVE' }, { status: 'EXPIRED' });

    const result = te.generateToken(c.customer_id, cfg.CYCLE_ID, cfg.COMPANY, hours);
    const record = await TokenRecord.create({
      token_id: result.token_id, customer_id: c.customer_id, cycle_id: cfg.CYCLE_ID, company: cfg.COMPANY,
      token: result.token, portal_url: te.buildPortalUrl(result.token),
      created_at: new Date(result.issued_at), expires_at: new Date(result.expires_at),
      status: 'ACTIVE', used_at: null,
    });
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

  // Lot-aware (phase 2): a Lot-scoped link additionally carries which Lot
  // and period it belongs to, so the portal can show a real period instead
  // of a hardcoded one, and so the frontend knows to submit through the
  // Lot-scoped endpoint (routes/lots.js) rather than the legacy one.
  let lotInfo = null;
  if (payload.lot_id) {
    const lot = await Lot.findById(payload.lot_id).lean();
    if (lot) lotInfo = { lot_id: lot._id, lot_number: lot.lot_number, period_label: lot.period_label, business_type: lot.business_type };
  }

  await logAudit({ actor: `CUSTOMER:${payload.customer_id}`, actor_role: 'customer', action: 'PORTAL_OPENED', entity_type: 'Customer', entity_id: payload.customer_id, details: lotInfo ? { lot_id: lotInfo.lot_id, lot_number: lotInfo.lot_number } : undefined });

  res.json({
    valid: true,
    customer_id: payload.customer_id,
    cycle_id: payload.cycle_id,
    token_id: payload.token_id,
    expires_at: payload.expires_at,
    customer_name: customer ? customer.customer_name : null,
    requires_pan: true,
    lot: lotInfo,
  });
});

// SECURITY: the customer portal's 5-attempt PAN lockout (CustomerPortal.jsx)
// is client-side state only — a direct API caller can retry /verify-pan as
// fast as the network allows, with no server-side limit, making a PAN
// (India's tax-ID format, e.g. ABCDE1234F) brute-forceable per token given
// enough requests. Rate-limit by IP: generous enough for a real customer
// mistyping their PAN a few times, tight enough to make brute force
// impractical. Keyed per-IP (not per-token) so an attacker also can't just
// spray many tokens from one IP to dodge a per-token limit.
const panVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 15,
  message: { valid: false, reason: 'TOO_MANY_ATTEMPTS' },
  standardHeaders: true, legacyHeaders: false,
});

// POST /api/tokens/verify-pan — second factor: customer proves they hold the PAN on file.
// Only after this succeeds do we release balance + transaction lines.
router.post('/verify-pan', panVerifyLimiter, async (req, res) => {
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

  // BUGFIX: `pan` is attacker-controlled JSON body input. A non-string value
  // (e.g. `{"pan":{"$ne":null}}`, an object/array/number sent to probe for a
  // NoSQL-injection style bypass) previously reached `pan.trim()` directly
  // and threw, which server.js's generic handler turned into a 500 with the
  // raw error message. It was never an actual auth bypass (Mongoose/the
  // driver would reject the malformed query), but it's an unhandled crash
  // on untrusted input — reject non-strings cleanly instead.
  if (typeof pan !== 'string' || !pan.trim() || pan.trim().toUpperCase() !== customer.pan) {
    await logAudit({ req, actor: `CUSTOMER:${customer.customer_id}`, actor_role: 'customer', action: 'PAN_VERIFY_FAILED', entity_type: 'Customer', entity_id: customer.customer_id });
    return res.status(401).json({ valid: false, reason: 'PAN_MISMATCH' });
  }

  record.pan_verified_at = new Date();
  await record.save();
  await logAudit({ req, actor: `CUSTOMER:${customer.customer_id}`, actor_role: 'customer', action: 'PAN_VERIFY_SUCCESS', entity_type: 'Customer', entity_id: customer.customer_id });

  // Lot-aware (phase 2): a Lot-scoped token's ledger/balance must come from
  // THAT Lot's own LedgerEntry ({lot_id, customer_id}), never the global
  // one — the same customer can have a different balance in every Lot.
  let asOfDate = cfg.AS_OF_DATE;
  let lotInfo = null;
  let ledger;
  if (payload.lot_id) {
    const lot = await Lot.findById(payload.lot_id).lean();
    if (lot) { lotInfo = { lot_id: lot._id, lot_number: lot.lot_number, period_label: lot.period_label, business_type: lot.business_type }; asOfDate = lot.period_label; }
    ledger = await LedgerEntry.findOne({ lot_id: payload.lot_id, customer_id: payload.customer_id }).lean();
  } else {
    ledger = await LedgerEntry.findOne({ customer_id: payload.customer_id }).lean();
  }
  const sapBalance = ledger ? ledger.transactions.filter(t => t.status === 'OPEN').reduce((s, t) => s + (t.amount || 0), 0) : 0;

  res.json({
    valid: true,
    customer_id: payload.customer_id,
    cycle_id: payload.cycle_id,
    token_id: payload.token_id,
    expires_at: payload.expires_at,
    customer: { customer_id: customer.customer_id, customer_name: customer.customer_name, company: customer.company },
    sap_balance: sapBalance,
    as_of_date: asOfDate,
    transactions: ledger ? ledger.transactions : [],
    lot: lotInfo,
  });
});

// GET /api/tokens/:token/sap-ledger.xlsx?pan=XXXXX — customer-portal download
// Same two-factor bar as the portal itself (valid, unexpired token + matching
// PAN) — lets the customer download only THEIR OWN SAP open-items ledger as a
// reference file while filling in their book balance. Never exposes any
// other customer's data.
router.get('/:token/sap-ledger.xlsx', async (req, res) => {
  const result = te.validateToken(req.params.token);
  if (!result.valid) return res.status(400).json({ error: 'Invalid or expired link', reason: result.reason });

  const { payload } = result;
  const record = await TokenRecord.findOne({ token_id: payload.token_id });
  if (!record || record.status === 'REVOKED') return res.status(400).json({ error: 'Link no longer valid' });

  const customer = await Customer.findOne({ customer_id: payload.customer_id }).lean();
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const pan = (req.query.pan || '').toString().trim().toUpperCase();
  if (!pan || pan !== customer.pan) return res.status(401).json({ error: 'PAN verification required' });

  // Lot-aware: same rule as /verify-pan — a Lot-scoped token's ledger comes
  // from that Lot's own LedgerEntry, never the global one.
  let periodLabel = `Cycle: ${cfg.CYCLE_ID}   |   As of: ${cfg.AS_OF_DATE}`;
  let led;
  if (payload.lot_id) {
    const lot = await Lot.findById(payload.lot_id).lean();
    if (lot) periodLabel = `Lot: ${lot.lot_number}   |   Period: ${lot.period_label}`;
    led = await LedgerEntry.findOne({ lot_id: payload.lot_id, customer_id: customer.customer_id }).lean();
  } else {
    led = await LedgerEntry.findOne({ customer_id: customer.customer_id }).lean();
  }
  const openTxns = led ? led.transactions.filter(t => t.status === 'OPEN') : [];

  const wb = new ExcelJS.Workbook();
  wb.creator = 'BalanceSync';
  wb.created = new Date();
  const sh = wb.addWorksheet('SAP Ledger');
  sh.columns = [{ width: 20 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 18 }, { width: 10 }];
  sh.mergeCells('A1:F1');
  sh.getCell('A1').value = `SAP Open Items – ${customer.customer_name} (${customer.customer_id})`;
  sh.getCell('A1').font = { bold: true, size: 13 };
  sh.mergeCells('A2:F2');
  sh.getCell('A2').value = `${periodLabel}   |   Company: ${cfg.COMPANY}`;
  sh.getCell('A2').font = { italic: true, color: { argb: 'FF666666' } };
  sh.addRow([]);
  const hdr = sh.addRow(['Document No', 'Type', 'Document Date', 'Due Date', 'Amount', 'Currency']);
  hdr.font = { bold: true };
  hdr.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E1E2E' } }; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });
  openTxns.forEach(t => {
    sh.addRow([t.document_number, t.document_type, t.document_date, t.due_date, t.amount, t.currency || 'INR']);
  });
  const totalRow = sh.addRow(['', '', '', 'TOTAL', openTxns.reduce((s, t) => s + (t.amount || 0), 0), '']);
  totalRow.font = { bold: true };
  sh.getColumn(5).numFmt = '#,##0.00';

  await logAudit({ req, actor: `CUSTOMER:${customer.customer_id}`, actor_role: 'customer', action: 'SAP_LEDGER_DOWNLOADED', entity_type: 'Customer', entity_id: customer.customer_id });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="SAP_Ledger_${customer.customer_id}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// POST /api/tokens/reset-expired — bulk: marks every ACTIVE-but-past-expiry
// token as EXPIRED across all customers in this cycle. Doesn't touch
// Confirmations (an expired, never-verified token has none to worry about)
// and doesn't send anything — it just clears the way so the next
// "Trigger Customer Emails" issues a fresh, working link for anyone whose
// link had died. Safe to run any time, including right before a demo.
router.post('/reset-expired', requireAdmin, async (req, res) => {
  const result = await TokenRecord.updateMany(
    { cycle_id: cfg.CYCLE_ID, status: 'ACTIVE', expires_at: { $lte: new Date() } },
    { status: 'EXPIRED' }
  );
  await logAudit({ req, action: 'TOKENS_RESET_EXPIRED', entity_type: 'Token', details: { matched: result.matchedCount ?? result.n, modified: result.modifiedCount ?? result.nModified } });
  res.json({ ok: true, reset: result.modifiedCount ?? result.nModified ?? 0, message: 'Expired links cleared. Trigger customer emails again to issue fresh links for anyone affected.' });
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
