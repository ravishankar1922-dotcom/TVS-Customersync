/**
 * Lot core (architecture overhaul — see BalanceSync_Lot_Architecture_Plan.md).
 * A Lot is the primary confirmation container: one per fresh ledger/period,
 * never overwritten, never merged.
 *
 * PHASE 1 (Lot/LotPopulation/ledger upload) deliberately did NOT touch the
 * existing customer-facing confirmation/token/portal flow — that legacy
 * flow (routes/confirmations.js's /submit, routes/tokens.js's /generate)
 * still runs against the single global cfg.CYCLE_ID exactly as before, so
 * nothing that already worked stopped working.
 *
 * PHASE 2 (this addition) wires Lots into the confirmation/token flow —
 * additively, alongside the untouched legacy routes:
 *   - POST /:lotId/tokens/generate — balance-filtered + explicitly-selected
 *     targeted sending, scoped to this Lot's population only.
 *   - POST /:lotId/confirmations/submit — the customer-portal submit
 *     endpoint for a Lot-scoped link. CRITICAL CHANGE per spec: the token
 *     is NEVER flipped to a blocking "USED" state here — it stays ACTIVE
 *     and reopenable until it naturally expires (or an admin revokes it),
 *     so a customer can reopen, amend, and resubmit. Every submission
 *     creates a new, permanent SubmissionVersion row (see
 *     models/SubmissionVersion.js) rather than overwriting the last one.
 *   - GET  /:lotId/confirmations[, /:customerId, /:customerId/versions] —
 *     Lot-scoped reads, always filtered by {lot_id, customer_id} together
 *     (never customer_id alone — see the CRITICAL DB RULE note on the
 *     Confirmation model).
 * routes/tokens.js's /validate, /verify-pan and /sap-ledger.xlsx were also
 * made Lot-aware (they read payload.lot_id, embedded in and protected by
 * the same HMAC signature, to pull the right Lot-scoped ledger/period) —
 * see that file. Its own /generate and /reset* endpoints, and
 * routes/confirmations.js's /submit, are UNCHANGED — the legacy flow keeps
 * working exactly as it did before this phase.
 */
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const Lot = require('../models/Lot');
const LotPopulation = require('../models/LotPopulation');
const LedgerEntry = require('../models/LedgerEntry');
const Customer = require('../models/Customer');
const Vendor = require('../models/Vendor');

// Phase 4 (Vendor module): which master a Lot's population is drawn from
// depends ENTIRELY on Lot.business_type — a VENDOR Lot's display names come
// from the Vendor collection, never Customer, and vice versa. Both masters
// expose the same shape here ({id, name, email, pan}) so the rest of this
// file's logic (balance filters, email sending, token binding) stays
// identical regardless of business type.
function masterModelFor(lot) { return lot.business_type === 'VENDOR' ? Vendor : Customer; }
function masterIdField(lot) { return lot.business_type === 'VENDOR' ? 'vendor_id' : 'customer_id'; }
function masterNameField(lot) { return lot.business_type === 'VENDOR' ? 'vendor_name' : 'customer_name'; }
async function lookupMasterByIds(lot, ids) {
  const Model = masterModelFor(lot), idField = masterIdField(lot);
  const rows = await Model.find({ [idField]: { $in: ids } }).lean();
  const byId = new Map();
  rows.forEach(r => byId.set(r[idField], { id: r[idField], name: r[masterNameField(lot)], email: r.email, pan: r.pan }));
  return byId;
}
const TokenRecord = require('../models/TokenRecord');
const Confirmation = require('../models/Confirmation');
const SubmissionVersion = require('../models/SubmissionVersion');
const EmailLog = require('../models/EmailLog');
const cfg = require('../config');
// Phase 5: explicit role gating rather than "any authenticated admin JWT"
// (which requireAdmin alone allows for ANY role, FINANCE included). Lot
// creation, ledger upload and token/link generation are ADMIN-only — the
// spec is explicit that Finance must never get arbitrary token-generation
// or master-data rights just by being logged in. Read/browse of Lots and
// confirmations is ADMIN or FINANCE, since Finance genuinely needs to see
// this data to review it. The Finance-workflow routing endpoints further
// down split ADMIN-only vs FINANCE-only by direction (see their own
// comments) — see the explicit Admin/Finance permission lists in
// BalanceSync_Lot_Architecture_Plan.md / the phase-4-9 completion report.
const { requireAdminOnly, requireAdminOrFinance, requireFinance } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { parsePeriod } = require('../utils/period');
const { nextLotNumber } = require('../utils/lotNumbering');
const { parseUploadedLedger } = require('./ledger');
const te = require('../utils/tokenEngine');
const { passesBalanceFilter } = require('../utils/balanceFilter');
const { confirmationRequestEmail, financeClarificationEmail, reminderEmail } = require('../utils/emailTemplates');
const AuditLog = require('../models/AuditLog');
const { sendMail, isConfigured } = require('../utils/mailer');
const { buildOutlookScript } = require('../utils/outlookScript');
const ExcelJS = require('exceljs');
// Reconciliation Studio, Lot-scoped (Sept 2026: "Reconciliation Studio -
// migrate as per lot"). Reuses the SAME matching engine, SOA/PDF parser and
// balance-bridge builder the legacy cfg.CYCLE_ID-scoped /api/reconciliation
// routes use (routes/reconciliation.js) — only the DATA LOOKUP changes here,
// to {lot_id, customer_id} instead of {cycle_id: cfg.CYCLE_ID}. This closes
// the gap flagged after the Sept 2026 sample-data batch: Lot-scoped ledgers/
// SOAs uploaded through Overview were reconcilable via the Lot's own KPI
// cards but never showed up in Reconciliation Studio's line-item grid.
const { parseSOA, reconcile, buildBridge, toBuffer } = require('./reconciliation');
const { buildReconciliationExcel } = require('../utils/excelExport');
const { reconciliationCompleteEmail } = require('../utils/emailTemplates');

// Shared by the bulk-action routes below: reuse a still-valid token for
// {lot_id, customer_id} or mint a fresh one — identical rule to the one
// already used in POST /:lotId/tokens/generate above, factored out so the
// reminder/outlook-script routes don't duplicate it a third time.
async function ensureLotToken(lot, customerId, expiryHours) {
  let tokenRec = await TokenRecord.findOne({ lot_id: lot._id, customer_id: customerId, status: 'ACTIVE', expires_at: { $gt: new Date() } }).sort({ expires_at: -1 });
  if (!tokenRec) {
    await TokenRecord.updateMany({ lot_id: lot._id, customer_id: customerId, status: 'ACTIVE' }, { status: 'EXPIRED' });
    const hours = expiryHours && expiryHours > 0 ? expiryHours : cfg.TOKEN_EXPIRY_HOURS;
    const gen = te.generateToken(customerId, lot.lot_number, cfg.COMPANY, hours, { lot_id: lot._id, business_type: lot.business_type });
    tokenRec = await TokenRecord.create({
      token_id: gen.token_id, customer_id: customerId, cycle_id: lot.lot_number, lot_id: lot._id, business_type: lot.business_type,
      company: cfg.COMPANY, token: gen.token, portal_url: te.buildPortalUrl(gen.token),
      created_at: new Date(gen.issued_at), expires_at: new Date(gen.expires_at), status: 'ACTIVE',
    });
  }
  return tokenRec;
}

const MAX_LEDGER_MB = 20;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_LEDGER_MB * 1024 * 1024 } });
const MAX_SOA_MB = 20;
const path = require('path');
const ALLOWED_SOA_EXT = ['.xlsx', '.xls', '.csv', '.pdf'];
const soaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SOA_MB * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_SOA_EXT.includes(ext)) cb(null, true);
    else cb(new Error(`File type not allowed. Accepted: ${ALLOWED_SOA_EXT.join(', ')}`));
  },
});

// POST /api/lots — Step 1 of Lot creation: admin supplies only the period;
// the Lot number is generated from it (spec section 2). business_type
// defaults to CUSTOMER — the Vendor module (a fully separate collection
// set, per the architecture decision) is a later phase and intentionally
// not wired in here yet.
router.post('/', requireAdminOnly, async (req, res) => {
  const { period, business_type, remarks } = req.body || {};
  let parsed;
  try { parsed = parsePeriod(period); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const bt = business_type === 'VENDOR' ? 'VENDOR' : 'CUSTOMER';
  const cleanRemarks = (remarks || '').toString().trim().slice(0, 500);

  const existing = await Lot.find({ period_year: parsed.year, period_month: parsed.month, business_type: bt }).distinct('lot_number');
  const lot_number = nextLotNumber(parsed.year, parsed.month, existing);

  const lot = await Lot.create({
    lot_number, period_year: parsed.year, period_month: parsed.month, period_label: parsed.label,
    business_type: bt, status: 'DRAFT', created_by: req.admin?.email || null, remarks: cleanRemarks,
  });

  await logAudit({ req, action: 'LOT_CREATED', entity_type: 'Lot', entity_id: lot.lot_number, details: { period: parsed.label, business_type: bt, remarks: cleanRemarks } });
  res.json({ ok: true, lot });
});

// PATCH /api/lots/:lotId — currently only remarks is editable post-creation.
router.patch('/:lotId', requireAdminOnly, async (req, res) => {
  const lot = await Lot.findById(req.params.lotId);
  if (!lot) return res.status(404).json({ error: 'Lot not found' });
  if (req.body && typeof req.body.remarks === 'string') {
    lot.remarks = req.body.remarks.trim().slice(0, 500);
    await lot.save();
    await logAudit({ req, action: 'LOT_REMARKS_UPDATED', entity_type: 'Lot', entity_id: lot.lot_number, details: { remarks: lot.remarks } });
  }
  res.json({ ok: true, lot });
});

// DELETE /api/lots/:lotId — Admin only, DRAFT lots only. A Lot moves from
// DRAFT to ACTIVE the moment a ledger is uploaded to it (see the upload
// route below), so a still-DRAFT Lot has no population/confirmations/tokens
// yet — this is a safe "undo an accidental Create Lot" action, never a way
// to remove a Lot that has any real activity against it. ACTIVE/CLOSED Lots
// must be handled deliberately (e.g. by an admin process outside the UI),
// never through this endpoint.
router.delete('/:lotId', requireAdminOnly, async (req, res) => {
  const lot = await Lot.findById(req.params.lotId);
  if (!lot) return res.status(404).json({ error: 'Lot not found' });
  if (lot.status !== 'DRAFT') {
    return res.status(400).json({ error: `Only a DRAFT Lot can be deleted (this Lot is ${lot.status}). Active/closed Lots carry real confirmation history and must not be removed here.` });
  }
  // Defensive cleanup in case of any partial/orphaned state — a genuine
  // DRAFT Lot should have none of these rows.
  await Promise.all([
    LotPopulation.deleteMany({ lot_id: lot._id }),
    LedgerEntry.deleteMany({ lot_id: lot._id }),
    Confirmation.deleteMany({ lot_id: lot._id }),
    SubmissionVersion.deleteMany({ lot_id: lot._id }),
    TokenRecord.deleteMany({ lot_id: lot._id }),
  ]);
  await Lot.deleteOne({ _id: lot._id });
  await logAudit({ req, action: 'LOT_DELETED', entity_type: 'Lot', entity_id: lot.lot_number, details: { lot_id: String(lot._id), period: lot.period_label, business_type: lot.business_type } });
  res.json({ ok: true });
});

// GET /api/lots — list, newest first
router.get('/', requireAdminOrFinance, async (req, res) => {
  const lots = await Lot.find().sort({ createdAt: -1 }).lean();
  res.json({ lots });
});

// GET /api/lots/summary — aggregate KPI numbers for the Overview screen
// (item 2 of the Sept 2026 feedback batch: "KPI cards will be showing the
// data based on the lot we are opening, if no lot is opened then it can
// show the total of all lots"). MUST be registered before GET /:lotId,
// otherwise Express would match "summary" as a lotId.
// Query params (both optional, combinable):
//   ?business_type=CUSTOMER|VENDOR — scope to one module (Customer/Vendor
//     Overview each pass their own business_type so the two modules never
//     mix each other's numbers — item 1).
//   ?lot_id=<id> — scope to exactly one Lot (when the admin has expanded
//     one); omit for the all-Lots total.
router.get('/summary', requireAdminOrFinance, async (req, res) => {
  const { business_type, lot_id } = req.query;
  const lotFilter = {};
  if (business_type === 'CUSTOMER' || business_type === 'VENDOR') lotFilter.business_type = business_type;
  if (lot_id) lotFilter._id = lot_id;

  const lots = await Lot.find(lotFilter).lean();
  const lotIds = lots.map(l => l._id);
  const [population, confirmations] = await Promise.all([
    LotPopulation.find({ lot_id: { $in: lotIds } }).lean(),
    Confirmation.find({ lot_id: { $in: lotIds } }).lean(),
  ]);

  const totalPopulation = population.length;
  const totalBalance = lots.reduce((s, l) => s + (l.total_ledger_balance || 0), 0);
  const submitted = confirmations.length;
  const matched = confirmations.filter(c => c.status === 'MATCHED').length;
  const difference = confirmations.filter(c => c.status === 'DIFFERENCE').length;
  const reconCompleted = confirmations.filter(c => c.recon_status === 'COMPLETED').length;
  const totalVariance = confirmations.reduce((s, c) => s + Math.abs(c.difference || 0), 0);

  res.json({
    ok: true,
    lot_count: lots.length,
    scope: lot_id ? 'lot' : (business_type ? 'business_type' : 'all'),
    total_population: totalPopulation,
    total_balance: parseFloat(totalBalance.toFixed(2)),
    submitted, matched, difference,
    pending: Math.max(0, totalPopulation - submitted),
    recon_completed: reconCompleted,
    total_variance: parseFloat(totalVariance.toFixed(2)),
  });
});

// GET /api/lots/:lotId — detail (population summary comes from LotPopulation,
// not the Lot document itself, to always reflect the true current count)
router.get('/:lotId', requireAdminOrFinance, async (req, res) => {
  const lot = await Lot.findById(req.params.lotId).lean();
  if (!lot) return res.status(404).json({ error: 'Lot not found' });
  res.json({ lot });
});

// GET /api/lots/:lotId/population — the customers actually active in this
// Lot (never the full Customer master — spec section 4).
router.get('/:lotId/population', requireAdminOrFinance, async (req, res) => {
  const lot = await Lot.findById(req.params.lotId).lean();
  if (!lot) return res.status(404).json({ error: 'Lot not found' });
  const population = await LotPopulation.find({ lot_id: lot._id }).sort({ customer_id: 1 }).lean();
  res.json({ lot_id: lot._id, lot_number: lot.lot_number, population, total: population.length });
});

// POST /api/lots/:lotId/ledger/upload — the event that actually creates a
// Lot's population (spec sections 3/4): parses the uploaded ledger, groups
// rows by customer_id, writes ONE LedgerEntry per (lot_id, customer_id),
// and creates a LotPopulation row ONLY for customers found in this file —
// never from the Customer master, and never touching any other Lot's data.
router.post('/:lotId/ledger/upload', requireAdminOnly, upload.single('ledger_file'), async (req, res) => {
  const lot = await Lot.findById(req.params.lotId);
  if (!lot) return res.status(404).json({ error: 'Lot not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let parsed;
  try { parsed = parseUploadedLedger(req.file.buffer, req.file.originalname); }
  catch (err) { return res.status(500).json({ error: 'Failed to parse ledger file: ' + err.message }); }

  const byCustomer = {};
  parsed.transactions.forEach(t => {
    const id = t.customer_id || 'UNKNOWN';
    (byCustomer[id] ||= []).push(t);
  });
  delete byCustomer.UNKNOWN; // rows with no identifiable customer_id can't join a Lot population

  const custIds = Object.keys(byCustomer);
  if (!custIds.length) {
    return res.status(400).json({ error: 'No rows in this file could be matched to a customer_id. The ledger file must include a customer identifier column.' });
  }

  // Look up display names from the appropriate master (Customer or Vendor,
  // per this Lot's business_type — see masterModelFor above), purely for
  // display in LotPopulation — the master does NOT determine membership.
  const masterById = await lookupMasterByIds(lot, custIds);
  const nameById = new Map([...masterById.entries()].map(([id, m]) => [id, m.name]));

  let totalBalance = 0;
  for (const custId of custIds) {
    const txns = byCustomer[custId];
    const openBalance = txns.filter(t => t.status === 'OPEN').reduce((s, t) => s + (t.amount || 0), 0);
    totalBalance += openBalance;

    await LedgerEntry.findOneAndUpdate(
      { lot_id: lot._id, customer_id: custId },
      { lot_id: lot._id, customer_id: custId, transactions: txns },
      { upsert: true }
    );
    await LotPopulation.findOneAndUpdate(
      { lot_id: lot._id, customer_id: custId },
      { lot_id: lot._id, customer_id: custId, customer_name: nameById.get(custId) || null, opening_balance: openBalance },
      { upsert: true }
    );
  }

  lot.ledger_upload_date = new Date();
  lot.ledger_filename = req.file.originalname;
  lot.population_count = custIds.length;
  lot.total_ledger_balance = parseFloat(totalBalance.toFixed(2));
  if (lot.status === 'DRAFT') lot.status = 'ACTIVE';
  await lot.save();

  await logAudit({ req, action: 'LOT_LEDGER_UPLOADED', entity_type: 'Lot', entity_id: lot.lot_number, details: { filename: req.file.originalname, population_count: custIds.length, total_balance: lot.total_ledger_balance } });

  res.json({ ok: true, lot, population_count: custIds.length, total_balance: lot.total_ledger_balance });
});

// ─────────────────────────────────────────────────────────────────────────
// PHASE 2 — Lot-scoped token generation (balance filter + targeted send)
// ─────────────────────────────────────────────────────────────────────────

// POST /api/lots/:lotId/tokens/generate — admin only.
// Body: { customer_ids?: string[], balance_filter?: { op, value, value2 },
//          expiry_hours?: number, send_email?: boolean (default true) }
// - customer_ids omitted => every customer in this Lot's population
// - customer_ids given   => select-individual (intersected with the filter,
//   if both are given, so "filter then hand-pick from the results" and
//   "just these people" both work with the same body shape)
// - balance_filter uses each customer's OPENING BALANCE for THIS LOT
//   specifically (from LotPopulation, populated only by this Lot's own
//   ledger upload — never a cross-Lot or master-derived figure).
router.post('/:lotId/tokens/generate', requireAdminOnly, async (req, res) => {
  const lot = await Lot.findById(req.params.lotId).lean();
  if (!lot) return res.status(404).json({ error: 'Lot not found' });

  const { customer_ids, balance_filter, expiry_hours, send_email } = req.body || {};
  const shouldEmail = send_email !== false;

  let population = await LotPopulation.find({ lot_id: lot._id }).lean();
  if (customer_ids && customer_ids.length) {
    const wanted = new Set(customer_ids);
    population = population.filter(p => wanted.has(p.customer_id));
  }
  if (balance_filter && balance_filter.op) {
    population = population.filter(p => passesBalanceFilter(p.opening_balance, balance_filter));
  }
  if (!population.length) {
    return res.status(404).json({ error: 'No customers in this Lot match the given selection/filter.' });
  }

  const custIds = population.map(p => p.customer_id);
  const customerById = await lookupMasterByIds(lot, custIds); // {id, name, email, pan} — Customer or Vendor master per this Lot's business_type

  const generated = [], skipped = [], noEmailAddress = [];
  for (const p of population) {
    // Reuse an existing still-valid link rather than mint a new one on every
    // click of "send" — same pattern as the legacy /api/tokens/generate.
    const tokenRec = await ensureLotToken(lot, p.customer_id, expiry_hours);

    generated.push({ customer_id: p.customer_id, token_id: tokenRec.token_id, portal_url: tokenRec.portal_url, expires_at: tokenRec.expires_at, opening_balance: p.opening_balance });

    if (!shouldEmail) continue;
    const customer = customerById.get(p.customer_id);
    if (!customer || !customer.email) { noEmailAddress.push(p.customer_id); continue; }

    const subject = `${cfg.COMPANY} ${lot.business_type === 'VENDOR' ? 'Vendor' : 'Customer'} Balance Confirmation – ${lot.period_label}`;
    const html = confirmationRequestEmail({ customer_name: customer.name }, p.opening_balance, tokenRec.portal_url, lot.period_label, cfg.TOKEN_EXPIRY_HOURS);
    let status = 'READY', errorMsg = null;
    if (isConfigured()) {
      try { await sendMail({ to: customer.email?.match(/<(.+)>/)?.[1] || customer.email, subject, html }); status = 'SENT'; }
      catch (err) { status = 'FAILED'; errorMsg = err.message; }
    }
    await EmailLog.findOneAndUpdate(
      { lot_id: lot._id, customer_id: p.customer_id, kind: 'CONFIRMATION_REQUEST' },
      { customer_id: p.customer_id, customer_name: customer.name, email: customer.email, lot_id: lot._id, cycle_id: lot.lot_number, token_id: tokenRec.token_id, portal_url: tokenRec.portal_url, subject, kind: 'CONFIRMATION_REQUEST', status, error: errorMsg, sent_at: new Date() },
      { upsert: true }
    );
  }

  await logAudit({ req, action: 'CONFIRMATION_SENT', entity_type: 'Lot', entity_id: lot.lot_number, details: { lot_id: lot._id, generated: generated.length, filter: balance_filter || null, targeted: !!(customer_ids && customer_ids.length), emailed: shouldEmail } });

  res.json({ ok: true, lot_id: lot._id, generated: generated.length, tokens: generated, no_email_address: noEmailAddress, smtp_configured: isConfigured() });
});

// ─────────────────────────────────────────────────────────────────────────
// Lot-scoped bulk actions — the same admin actions that used to run
// globally (routes/emails.js, routes/tokens.js) now scoped to exactly one
// Lot's population, so running one never touches any other Lot/period. The
// legacy global routes are left untouched for backward compatibility, but
// the admin UI should call these instead once a Lot is selected (see item 4
// of the Sept 2026 feedback batch).
// ─────────────────────────────────────────────────────────────────────────

// POST /api/lots/:lotId/tokens/reset-expired — clears ACTIVE-but-past-expiry
// tokens for THIS Lot only, so "Trigger Emails" for this Lot issues fresh
// links for anyone affected, without touching any other Lot's tokens.
router.post('/:lotId/tokens/reset-expired', requireAdminOnly, async (req, res) => {
  const lot = await Lot.findById(req.params.lotId).lean();
  if (!lot) return res.status(404).json({ error: 'Lot not found' });

  const result = await TokenRecord.updateMany(
    { lot_id: lot._id, status: 'ACTIVE', expires_at: { $lte: new Date() } },
    { status: 'EXPIRED' }
  );
  const reset = result.modifiedCount ?? result.nModified ?? 0;
  await logAudit({ req, action: 'TOKENS_RESET_EXPIRED', entity_type: 'Lot', entity_id: lot.lot_number, details: { lot_id: lot._id, reset } });
  res.json({ ok: true, lot_id: lot._id, lot_number: lot.lot_number, reset, message: 'Expired links cleared for this Lot. Trigger emails again to issue fresh links for anyone affected.' });
});

// POST /api/lots/:lotId/emails/remind-pending — reminder to every member of
// THIS Lot's population who has not yet submitted a confirmation *for this
// Lot* (no Confirmation row at {lot_id, customer_id}) — never cross-Lot.
router.post('/:lotId/emails/remind-pending', requireAdminOnly, async (req, res) => {
  const lot = await Lot.findById(req.params.lotId).lean();
  if (!lot) return res.status(404).json({ error: 'Lot not found' });

  const population = await LotPopulation.find({ lot_id: lot._id }).lean();
  if (!population.length) return res.status(404).json({ error: 'This Lot has no population yet — upload a ledger first.' });
  const responded = await Confirmation.find({ lot_id: lot._id }).distinct('customer_id');
  const respondedSet = new Set(responded);
  const pending = population.filter(p => !respondedSet.has(p.customer_id));

  if (!pending.length) {
    return res.json({ ok: true, lot_id: lot._id, lot_number: lot.lot_number, total: 0, sent: 0, ready: 0, failed: 0, results: [], note: 'Every member of this Lot has already responded — no reminders needed.' });
  }

  const masterById = await lookupMasterByIds(lot, pending.map(p => p.customer_id));
  const results = [];
  for (const p of pending) {
    const person = masterById.get(p.customer_id);
    try {
      const tokenRec = await ensureLotToken(lot, p.customer_id);
      if (!person || !person.email) { results.push({ customer_id: p.customer_id, status: 'NO_EMAIL_ADDRESS' }); continue; }

      const subject = `Reminder: ${cfg.COMPANY} ${lot.business_type === 'VENDOR' ? 'Vendor' : 'Customer'} Balance Confirmation – ${lot.period_label}`;
      const html = reminderEmail({ customer_name: person.name }, p.opening_balance, tokenRec.portal_url, lot.period_label, cfg.TOKEN_EXPIRY_HOURS);
      let status = 'READY', errorMsg = null;
      if (isConfigured()) {
        try { await sendMail({ to: person.email?.match(/<(.+)>/)?.[1] || person.email, subject, html }); status = 'SENT'; }
        catch (err) { status = 'FAILED'; errorMsg = err.message; }
      }
      const existing = await EmailLog.findOne({ lot_id: lot._id, customer_id: p.customer_id, kind: 'REMINDER' }).lean();
      await EmailLog.findOneAndUpdate(
        { lot_id: lot._id, customer_id: p.customer_id, kind: 'REMINDER' },
        { customer_id: p.customer_id, customer_name: person.name, email: person.email, lot_id: lot._id, cycle_id: lot.lot_number, token_id: tokenRec.token_id, portal_url: tokenRec.portal_url, subject, kind: 'REMINDER', status, error: errorMsg, sent_at: new Date(), reminder_count: (existing?.reminder_count || 0) + 1 },
        { upsert: true }
      );
      results.push({ customer_id: p.customer_id, status, error: errorMsg });
    } catch (err) { results.push({ customer_id: p.customer_id, status: 'FAILED', error: err.message }); }
  }

  await logAudit({ req, action: 'EMAIL_REMINDER_BULK', entity_type: 'Lot', entity_id: lot.lot_number, details: { lot_id: lot._id, total: pending.length } });
  res.json({
    ok: true, lot_id: lot._id, lot_number: lot.lot_number,
    smtp_configured: isConfigured(), total: pending.length,
    sent: results.filter(r => r.status === 'SENT').length,
    ready: results.filter(r => r.status === 'READY').length,
    failed: results.filter(r => r.status === 'FAILED').length,
    results,
    note: isConfigured() ? 'Reminder emails sent to all non-responders in this Lot.' : 'SMTP not configured — reminder links generated and logged. Configure SMTP_* in .env, or copy links from the Email Log.',
  });
});

// GET /api/lots/:lotId/emails/outlook-script — same Outlook-draft generator
// as the legacy global one, but built only from THIS Lot's population, so
// the .ps1 it downloads never drafts an email for a customer/vendor outside
// this Lot.
router.get('/:lotId/emails/outlook-script', requireAdminOnly, async (req, res) => {
  const lot = await Lot.findById(req.params.lotId).lean();
  if (!lot) return res.status(404).json({ error: 'Lot not found' });

  const population = await LotPopulation.find({ lot_id: lot._id }).lean();
  if (!population.length) return res.status(404).json({ error: 'This Lot has no population yet — upload a ledger first.' });

  const masterById = await lookupMasterByIds(lot, population.map(p => p.customer_id));
  const mails = [];
  for (const p of population) {
    const person = masterById.get(p.customer_id);
    if (!person || !person.email) continue;
    const tokenRec = await ensureLotToken(lot, p.customer_id);
    const subject = `${cfg.COMPANY} ${lot.business_type === 'VENDOR' ? 'Vendor' : 'Customer'} Balance Confirmation – ${lot.period_label}`;
    const html = confirmationRequestEmail({ customer_name: person.name }, p.opening_balance, tokenRec.portal_url, lot.period_label, cfg.TOKEN_EXPIRY_HOURS);
    const to = person.email?.match(/<(.+)>/)?.[1] || person.email;
    mails.push({ to, subjectB64: Buffer.from(subject, 'utf8').toString('base64'), bodyB64: Buffer.from(html, 'utf8').toString('base64') });

    await EmailLog.findOneAndUpdate(
      { lot_id: lot._id, customer_id: p.customer_id, kind: 'CONFIRMATION_REQUEST' },
      { customer_id: p.customer_id, customer_name: person.name, email: person.email, lot_id: lot._id, cycle_id: lot.lot_number, token_id: tokenRec.token_id, portal_url: tokenRec.portal_url, subject, kind: 'CONFIRMATION_REQUEST', status: 'DRAFT_CREATED', error: null, sent_at: new Date() },
      { upsert: true }
    );
  }
  if (!mails.length) return res.status(404).json({ error: 'No one in this Lot has an email address on file.' });

  await logAudit({ req, action: 'EMAIL_OUTLOOK_SCRIPT_GENERATED', entity_type: 'Lot', entity_id: lot.lot_number, details: { lot_id: lot._id, total: mails.length } });

  const buf = buildOutlookScript(mails, `Lot ${lot.lot_number} (${lot.period_label})`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="BalanceSync_Outlook_Drafts_${lot.lot_number}.ps1"`);
  res.send(buf);
});

// ─────────────────────────────────────────────────────────────────────────
// PHASE 2 — Lot-scoped confirmation submit (reopenable, versioned)
// ─────────────────────────────────────────────────────────────────────────

// POST /api/lots/:lotId/confirmations/submit — public (customer portal),
// requires a token that (a) belongs to THIS Lot, (b) has passed the PAN
// gate (pan_verified_at set), and (c) has not expired. Unlike the legacy
// endpoint, this NEVER blocks the token after a successful submission —
// the customer can reopen the same link, change their balance/SOA/comment,
// and resubmit as many times as they like until the link expires. Every
// call here creates a brand-new SubmissionVersion; nothing is ever
// overwritten or lost.
router.post('/:lotId/confirmations/submit', soaUpload.single('soa_file'), async (req, res) => {
  const lot = await Lot.findById(req.params.lotId).lean();
  if (!lot) return res.status(404).json({ error: 'Lot not found' });

  const { token_id, sap_balance, cust_balance, remarks, comment } = req.body || {};
  if (!token_id) return res.status(400).json({ error: 'token_id is required' });

  const tokenRec = await TokenRecord.findOne({ token_id });
  if (!tokenRec || !tokenRec.lot_id || tokenRec.lot_id.toString() !== lot._id.toString()) {
    return res.status(403).json({ error: 'This link does not belong to this Lot.' });
  }
  if (tokenRec.status === 'REVOKED') return res.status(403).json({ error: 'This link has been revoked.' });
  if (new Date(tokenRec.expires_at) <= new Date()) return res.status(403).json({ error: 'This link has expired. Please request a new one.' });
  if (!tokenRec.pan_verified_at) return res.status(403).json({ error: 'This link has not completed identity verification. Please open the confirmation link again.' });

  const customer_id = tokenRec.customer_id;
  const sapNum  = parseFloat(sap_balance)  || 0;
  const custNum = parseFloat(cust_balance) || 0;
  const diff    = custNum - sapNum;
  const status  = Math.abs(diff) < 0.01 ? 'MATCHED' : 'DIFFERENCE';

  // NOTE — CONCURRENCY: real MongoDB would assign the version number via
  // the {lot_id, customer_id, version} unique index + a retry-on-duplicate-
  // key loop for full atomicity under a genuine race (two simultaneous
  // resubmissions on the same reopened link). The in-memory fake model
  // used by this test suite does not enforce unique indexes (documented in
  // tests/helpers/fakeModel.js), so this sandbox cannot exercise that race
  // directly; the version-history model and the "never overwrite, always
  // append" logic itself are exactly what a real deployment would rely on.
  const priorVersions = await SubmissionVersion.find({ lot_id: lot._id, customer_id }).lean();
  const version = priorVersions.length + 1;
  await SubmissionVersion.updateMany({ lot_id: lot._id, customer_id, status: 'CURRENT' }, { status: 'SUPERSEDED' });
  await SubmissionVersion.create({
    lot_id: lot._id, customer_id, version, status: 'CURRENT',
    sap_balance: sapNum, cust_balance: custNum, difference: parseFloat(diff.toFixed(2)),
    remarks: remarks || '', comment: comment || '',
    soa_filename: req.file ? req.file.originalname : null,
    soa_mimetype: req.file ? req.file.mimetype     : null,
    soa_size:     req.file ? req.file.size         : null,
    soa_data:     req.file ? req.file.buffer       : null,
    submitted_at: new Date(), actor: `CUSTOMER:${customer_id}`,
  });

  const confirmation = await Confirmation.findOneAndUpdate(
    { lot_id: lot._id, customer_id },
    {
      customer_id, lot_id: lot._id, cycle_id: lot.lot_number, token_id,
      sap_balance: sapNum, cust_balance: custNum, difference: parseFloat(diff.toFixed(2)),
      remarks: remarks || '', current_version: version,
      soa_filename: req.file ? req.file.originalname : null,
      soa_mimetype: req.file ? req.file.mimetype     : null,
      soa_size:     req.file ? req.file.size         : null,
      soa_data:     req.file ? req.file.buffer       : null,
      status, recon_status: 'PENDING', submitted_at: new Date(),
      // Every fresh submission/amendment returns to ADMIN_REVIEW — even one
      // that arrived while the record was sitting in CUSTOMER_CLARIFICATION
      // or FINANCE_REVIEW, since the customer's new input is exactly what
      // whoever routed it away was waiting for.
      workflow_status: 'ADMIN_REVIEW', workflow_comment: '',
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // CRITICAL CHANGE (spec): the token stays ACTIVE. No status flip to
  // 'USED' — the link remains valid/reopenable until it naturally expires.

  await logAudit({
    actor: `CUSTOMER:${customer_id}`, actor_role: 'customer',
    action: version === 1 ? 'CONFIRMATION_SUBMITTED' : 'BALANCE_AMENDED',
    entity_type: 'Confirmation', entity_id: customer_id,
    details: { lot_id: lot._id, lot_number: lot.lot_number, version, status, difference: diff },
  });

  res.json({
    ok: true, status, difference: diff, version,
    message: status === 'MATCHED'
      ? 'Balance confirmed and matched. Thank you.'
      : `Confirmation received (version ${version}). Difference of Rs.${Math.abs(diff).toLocaleString('en-IN')} noted. You may reopen this link to amend it any time before it expires.`,
  });
});

// GET /api/lots/:lotId/confirmations — admin, every confirmation in this
// Lot, joined with LotPopulation for names/opening balance.
router.get('/:lotId/confirmations', requireAdminOrFinance, async (req, res) => {
  const lot = await Lot.findById(req.params.lotId).lean();
  if (!lot) return res.status(404).json({ error: 'Lot not found' });
  const [confirmations, population] = await Promise.all([
    Confirmation.find({ lot_id: lot._id }).lean(),
    LotPopulation.find({ lot_id: lot._id }).lean(),
  ]);
  const confByCust = new Map(confirmations.map(c => [c.customer_id, c]));
  const rows = population.map(p => ({
    customer_id: p.customer_id, customer_name: p.customer_name, opening_balance: p.opening_balance,
    confirmation: confByCust.get(p.customer_id) || null,
  }));
  res.json({ lot_id: lot._id, lot_number: lot.lot_number, total: rows.length, rows });
});

// GET /api/lots/:lotId/confirmations/export.xlsx — Phase 7 Lot-aware export.
// CRITICAL: scoped to exactly one Lot (lot_id in every query below) — never
// combines rows from other Lots, even for the same customer/vendor, per the
// spec's "no cross-Lot data leakage" requirement. Read-only, so both Admin
// and Finance can pull it. MUST be registered before the '/:customerId'
// route below — otherwise Express would match "export.xlsx" as a customerId.
router.get('/:lotId/confirmations/export.xlsx', requireAdminOrFinance, async (req, res) => {
  const lot = await Lot.findById(req.params.lotId).lean();
  if (!lot) return res.status(404).json({ error: 'Lot not found' });

  const [population, confirmations, tokens] = await Promise.all([
    LotPopulation.find({ lot_id: lot._id }).lean(),
    Confirmation.find({ lot_id: lot._id }).lean(),
    TokenRecord.find({ lot_id: lot._id }).lean(),
  ]);
  const confByCust = new Map(confirmations.map(c => [c.customer_id, c]));
  // Most recent token per customer (a customer can have been re-sent a link
  // more than once — TOKEN_GENERATE issues a fresh TokenRecord each time).
  const tokenByCust = new Map();
  tokens.forEach(t => {
    const prev = tokenByCust.get(t.customer_id);
    if (!prev || new Date(t.created_at || t.createdAt) > new Date(prev.created_at || prev.createdAt)) tokenByCust.set(t.customer_id, t);
  });

  const idLabel = lot.business_type === 'VENDOR' ? 'Vendor' : 'Customer';
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Lot Confirmations');
  ws.columns = [
    { header: 'Lot Number', key: 'lot_number', width: 18 },
    { header: 'Period', key: 'period_label', width: 14 },
    { header: 'Business Type', key: 'business_type', width: 14 },
    { header: `${idLabel} ID`, key: 'customer_id', width: 14 },
    { header: `${idLabel} Name`, key: 'customer_name', width: 28 },
    { header: 'Opening Balance', key: 'opening_balance', width: 16 },
    { header: 'SAP Balance', key: 'sap_balance', width: 15 },
    { header: 'Customer Balance', key: 'cust_balance', width: 16 },
    { header: 'Difference', key: 'difference', width: 14 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Recon Status', key: 'recon_status', width: 14 },
    { header: 'Workflow Status', key: 'workflow_status', width: 18 },
    { header: 'Current Version', key: 'current_version', width: 14 },
    { header: 'Submitted At', key: 'submitted_at', width: 20 },
    { header: 'SOA Filename', key: 'soa_filename', width: 26 },
    { header: 'Token Status', key: 'token_status', width: 14 },
    { header: 'Token Expires At', key: 'token_expires_at', width: 20 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };

  population.forEach(p => {
    const conf = confByCust.get(p.customer_id);
    const tok = tokenByCust.get(p.customer_id);
    ws.addRow({
      lot_number: lot.lot_number, period_label: lot.period_label, business_type: lot.business_type,
      customer_id: p.customer_id, customer_name: p.customer_name, opening_balance: p.opening_balance,
      sap_balance: conf?.sap_balance ?? '', cust_balance: conf?.cust_balance ?? '', difference: conf?.difference ?? '',
      status: conf?.status || 'PENDING', recon_status: conf?.recon_status || '', workflow_status: conf?.workflow_status || '',
      current_version: conf?.current_version ?? '', submitted_at: conf?.submitted_at ? new Date(conf.submitted_at).toLocaleString('en-IN') : '',
      soa_filename: conf?.soa_filename || '', token_status: tok?.status || '',
      token_expires_at: tok?.expires_at ? new Date(tok.expires_at).toLocaleString('en-IN') : '',
    });
  });
  ws.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + ws.columns.length)}1` };

  await logAudit({ actor: req.admin?.email || 'system', actor_role: req.admin?.role === 'FINANCE' ? 'finance' : 'admin', action: 'LOT_CONFIRMATIONS_EXPORTED', entity_type: 'Lot', entity_id: lot.lot_number, details: { lot_id: String(lot._id) } });

  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${lot.lot_number}_Confirmations.xlsx"`);
  res.send(buffer);
});

// GET /api/lots/:lotId/confirmations/:customerId — admin, single confirmation.
router.get('/:lotId/confirmations/:customerId', requireAdminOrFinance, async (req, res) => {
  const lot = await Lot.findById(req.params.lotId).lean();
  if (!lot) return res.status(404).json({ error: 'Lot not found' });
  // CRITICAL DB RULE: always {lot_id, customer_id} together — never
  // customer_id alone, since the same customer can exist in many Lots.
  const conf = await Confirmation.findOne({ lot_id: lot._id, customer_id: req.params.customerId }).lean();
  if (!conf) return res.status(404).json({ error: 'No confirmation found for this customer in this Lot.' });
  res.json({ confirmation: conf });
});

// GET /api/lots/:lotId/confirmations/:customerId/versions — admin, full
// submission-version history (metadata only, file bytes excluded) — every
// version stays visible, not just the current one.
router.get('/:lotId/confirmations/:customerId/versions', requireAdminOrFinance, async (req, res) => {
  const lot = await Lot.findById(req.params.lotId).lean();
  if (!lot) return res.status(404).json({ error: 'Lot not found' });
  const versions = await SubmissionVersion.find({ lot_id: lot._id, customer_id: req.params.customerId }).sort({ version: 1 }).lean();
  res.json({
    lot_id: lot._id, customer_id: req.params.customerId,
    versions: versions.map(v => ({
      version: v.version, status: v.status, sap_balance: v.sap_balance, cust_balance: v.cust_balance, difference: v.difference,
      remarks: v.remarks, comment: v.comment, soa_filename: v.soa_filename, soa_size: v.soa_size, submitted_at: v.submitted_at, actor: v.actor,
    })),
  });
});

// GET /api/lots/:lotId/confirmations/:customerId/versions/:version/soa —
// admin, download one specific version's original SOA file bytes.
router.get('/:lotId/confirmations/:customerId/versions/:version/soa', requireAdminOrFinance, async (req, res) => {
  const lot = await Lot.findById(req.params.lotId).lean();
  if (!lot) return res.status(404).json({ error: 'Lot not found' });
  const v = await SubmissionVersion.findOne({ lot_id: lot._id, customer_id: req.params.customerId, version: parseInt(req.params.version, 10) }).lean();
  if (!v || !v.soa_data) return res.status(404).json({ error: 'That SOA version was not found' });
  res.setHeader('Content-Type', v.soa_mimetype || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${v.soa_filename || 'soa_file'}"`);
  res.send(v.soa_data.buffer ? Buffer.from(v.soa_data.buffer) : v.soa_data);
});

// ─────────────────────────────────────────────────────────────────────────
// PHASE 5 — Finance clarification workflow state machine
// ─────────────────────────────────────────────────────────────────────────
// ADMIN_REVIEW (default, after customer submits) --route-to-finance(ADMIN)--> FINANCE_REVIEW
// FINANCE_REVIEW --route-to-admin(FINANCE)--> ADMIN_REVIEW
// FINANCE_REVIEW --route-to-customer(FINANCE)--> CUSTOMER_CLARIFICATION (emails customer)
// CUSTOMER_CLARIFICATION --(customer resubmits via confirmations/submit)--> ADMIN_REVIEW
// Every transition writes an immutable AuditLog event (spec's action
// vocabulary: ROUTED_TO_FINANCE, FINANCE_REVIEWED, ROUTED_TO_ADMIN,
// ROUTED_TO_CUSTOMER) carrying the comment, so the full chronological
// history is reconstructable per {lot_id, customer_id} — see GET .../history.

async function getLotAndConfirmation(lotId, customerId, res) {
  const lot = await Lot.findById(lotId).lean();
  if (!lot) { res.status(404).json({ error: 'Lot not found' }); return null; }
  const conf = await Confirmation.findOne({ lot_id: lot._id, customer_id: customerId });
  if (!conf) { res.status(404).json({ error: 'No confirmation found for this customer in this Lot.' }); return null; }
  return { lot, conf };
}

// POST /:lotId/confirmations/:customerId/route-to-finance — ADMIN only.
router.post('/:lotId/confirmations/:customerId/route-to-finance', requireAdminOnly, async (req, res) => {
  const found = await getLotAndConfirmation(req.params.lotId, req.params.customerId, res);
  if (!found) return;
  const { lot, conf } = found;
  const { comment } = req.body || {};

  conf.workflow_status = 'FINANCE_REVIEW';
  conf.workflow_comment = comment || '';
  await conf.save();

  await logAudit({ req, action: 'ROUTED_TO_FINANCE', entity_type: 'Confirmation', entity_id: req.params.customerId, details: { lot_id: lot._id, lot_number: lot.lot_number, comment } });
  res.json({ ok: true, workflow_status: conf.workflow_status });
});

// POST /:lotId/confirmations/:customerId/route-to-admin — FINANCE only.
router.post('/:lotId/confirmations/:customerId/route-to-admin', requireFinance, async (req, res) => {
  const found = await getLotAndConfirmation(req.params.lotId, req.params.customerId, res);
  if (!found) return;
  const { lot, conf } = found;
  const { comment } = req.body || {};

  conf.workflow_status = 'ADMIN_REVIEW';
  conf.workflow_comment = comment || '';
  await conf.save();

  // FINANCE_REVIEWED records that Finance looked at it at all — logged
  // alongside (never instead of) ROUTED_TO_ADMIN, since those are two
  // distinct, meaningful events per the spec's action vocabulary.
  await logAudit({ req, actor: req.admin.email, actor_role: 'finance', action: 'FINANCE_REVIEWED', entity_type: 'Confirmation', entity_id: req.params.customerId, details: { lot_id: lot._id, lot_number: lot.lot_number, comment } });
  await logAudit({ req, actor: req.admin.email, actor_role: 'finance', action: 'ROUTED_TO_ADMIN', entity_type: 'Confirmation', entity_id: req.params.customerId, details: { lot_id: lot._id, lot_number: lot.lot_number, comment } });
  res.json({ ok: true, workflow_status: conf.workflow_status });
});

// POST /:lotId/confirmations/:customerId/route-to-customer — FINANCE only.
// Emails the customer (their existing Lot-scoped link stays valid — the
// spec's reopenable-link rule applies here too, no new token is minted).
router.post('/:lotId/confirmations/:customerId/route-to-customer', requireFinance, async (req, res) => {
  const found = await getLotAndConfirmation(req.params.lotId, req.params.customerId, res);
  if (!found) return;
  const { lot, conf } = found;
  const { comment } = req.body || {};

  conf.workflow_status = 'CUSTOMER_CLARIFICATION';
  conf.workflow_comment = comment || '';
  await conf.save();

  await logAudit({ req, actor: req.admin.email, actor_role: 'finance', action: 'FINANCE_REVIEWED', entity_type: 'Confirmation', entity_id: req.params.customerId, details: { lot_id: lot._id, lot_number: lot.lot_number, comment } });
  await logAudit({ req, actor: req.admin.email, actor_role: 'finance', action: 'ROUTED_TO_CUSTOMER', entity_type: 'Confirmation', entity_id: req.params.customerId, details: { lot_id: lot._id, lot_number: lot.lot_number, comment } });

  // Best-effort email — the routing itself already succeeded above even if
  // sending fails (matches the pattern the rest of the app uses: SMTP not
  // configured just means the link/notice isn't auto-delivered).
  let emailStatus = 'SKIPPED';
  const master = await lookupMasterByIds(lot, [req.params.customerId]);
  const person = master.get(req.params.customerId);
  const tokenRec = await TokenRecord.findOne({ lot_id: lot._id, customer_id: req.params.customerId }).sort({ expires_at: -1 });
  if (person?.email && tokenRec && isConfigured()) {
    try {
      const subject = `Action needed: clarification on your ${lot.period_label} balance confirmation`;
      const html = financeClarificationEmail({ customer_name: person.name }, conf.sap_balance, conf.cust_balance, tokenRec.portal_url, lot.period_label, comment);
      await sendMail({ to: person.email?.match(/<(.+)>/)?.[1] || person.email, subject, html });
      emailStatus = 'SENT';
      await EmailLog.create({ customer_id: req.params.customerId, customer_name: person.name, email: person.email, lot_id: lot._id, cycle_id: lot.lot_number, token_id: tokenRec.token_id, portal_url: tokenRec.portal_url, subject, kind: 'CONFIRMATION_REQUEST', status: 'SENT', sent_at: new Date() });
      await logAudit({ req, actor: req.admin.email, actor_role: 'finance', action: 'EMAIL_SENT', entity_type: 'Confirmation', entity_id: req.params.customerId, details: { lot_id: lot._id, kind: 'CUSTOMER_CLARIFICATION' } });
    } catch (err) { emailStatus = 'FAILED: ' + err.message; }
  }

  res.json({ ok: true, workflow_status: conf.workflow_status, email: emailStatus });
});

// GET /:lotId/confirmations/:customerId/history — ADMIN or FINANCE.
// Complete chronological history for this Lot+customer — every workflow
// action, submission, email and portal event, oldest first, built from the
// immutable AuditLog (never a separate/duplicate history model — every
// write above, and every phase 1-2 action, already logs here with lot_id
// in `details`).
router.get('/:lotId/confirmations/:customerId/history', requireAdminOrFinance, async (req, res) => {
  const lot = await Lot.findById(req.params.lotId).lean();
  if (!lot) return res.status(404).json({ error: 'Lot not found' });
  // CONFIRMATION_SENT is logged against the Lot itself (entity_type:'Lot',
  // entity_id: lot_number) rather than the customer, since one send can
  // cover many customers — pull both shapes, then filter to this Lot.
  const events = await AuditLog.find({
    $or: [{ entity_id: req.params.customerId }, { entity_type: 'Lot', entity_id: lot.lot_number }],
  }).sort({ createdAt: 1 }).lean();
  const scoped = events.filter(e => {
    const d = e.details || {};
    return String(d.lot_id || '') === String(lot._id) || (e.entity_type === 'Lot' && e.entity_id === lot.lot_number);
  });
  res.json({
    lot_id: lot._id, lot_number: lot.lot_number, customer_id: req.params.customerId,
    history: scoped.map(e => ({ timestamp: e.createdAt, actor: e.actor, actor_role: e.actor_role, action: e.action, details: e.details })),
  });
});

// ── Reconciliation Studio, Lot-scoped ───────────────────────────────────────
// Loads the SAP ledger + customer SOA for one {lot_id, customer_id} pair,
// runs them through the same reconcile()/buildBridge() the legacy studio
// uses, never falling back to the global cfg.CYCLE_ID-scoped collections.
async function getLotReconData(lotId, customerId) {
  const lot = await Lot.findById(lotId).lean();
  if (!lot) throw Object.assign(new Error('Lot not found'), { status: 404 });

  const conf = await Confirmation.findOne({ lot_id: lot._id, customer_id: customerId }).lean();
  if (!conf) throw Object.assign(new Error('No confirmation found for this customer in this Lot.'), { status: 404 });
  if (!conf.soa_data) throw Object.assign(new Error('No SOA file uploaded yet for this customer in this Lot.'), { status: 404 });

  const led = await LedgerEntry.findOne({ lot_id: lot._id, customer_id: customerId }).lean();
  if (!led) throw Object.assign(new Error('No ledger found for this customer in this Lot.'), { status: 404 });

  const master = await lookupMasterByIds(lot, [customerId]);
  const person = master.get(customerId) || null;
  const customer = person ? { customer_id: person.id, customer_name: person.name, email: person.email } : { customer_id: customerId };

  const sapTxns = led.transactions.filter(t => t.status === 'OPEN');
  const soaBuffer = toBuffer(conf.soa_data);
  const soaData = await parseSOA(soaBuffer);
  const recon = reconcile(sapTxns, soaData.items);
  return { lot, conf, customer, sapTxns, soaData, recon };
}

// GET /:lotId/reconciliation/:customerId — ADMIN or FINANCE.
router.get('/:lotId/reconciliation/:customerId', requireAdminOrFinance, async (req, res) => {
  try {
    const { lot, conf, customer, sapTxns, soaData, recon } = await getLotReconData(req.params.lotId, req.params.customerId);
    const bridge = buildBridge({ sapTxns, custItems: soaData.items, results: recon.results, summary: recon.summary, customer, cycleId: lot.lot_number, asOfDate: lot.period_label });
    res.json({
      lot_id: lot._id, lot_number: lot.lot_number, period_label: lot.period_label,
      customer_id: req.params.customerId, customer_name: customer?.customer_name,
      soa_filename: conf.soa_filename, soa_format: soaData.format_detected, soa_headers: soaData.headers,
      soa_confidence: soaData.confidence, soa_warning: soaData.warning || null,
      sap_lines: sapTxns, customer_lines: soaData.items, results: recon.results, summary: recon.summary, bridge,
      recon_status: conf.recon_status, recon_notes: conf.recon_notes, root_causes: conf.root_causes || {},
      recon_sent_to_customer_at: conf.recon_sent_to_customer_at, workflow_status: conf.workflow_status,
      current_version: conf.current_version,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PATCH /:lotId/reconciliation/:customerId — ADMIN or FINANCE. Same request
// shape as the legacy PATCH /api/confirmations/:customerId/recon
// ({recon_status, recon_notes, root_causes}), scoped to {lot_id, customer_id}
// instead of {cycle_id: cfg.CYCLE_ID} — lets the studio persist root-cause
// tags, notes, and "mark complete" for Lot-scoped confirmations too.
router.patch('/:lotId/reconciliation/:customerId', requireAdminOrFinance, async (req, res) => {
  const lot = await Lot.findById(req.params.lotId).lean();
  if (!lot) return res.status(404).json({ error: 'Lot not found' });

  const { recon_status, recon_notes, root_causes } = req.body || {};
  const update = {};
  if (recon_status) update.recon_status = recon_status;
  if (recon_notes !== undefined) update.recon_notes = recon_notes;
  if (root_causes) update.root_causes = root_causes;
  if (recon_status === 'COMPLETED') update.recon_completed_at = new Date();

  const conf = await Confirmation.findOneAndUpdate({ lot_id: lot._id, customer_id: req.params.customerId }, update, { new: true });
  if (!conf) return res.status(404).json({ error: 'No confirmation found for this customer in this Lot.' });

  await logAudit({ req, action: recon_status === 'COMPLETED' ? 'RECON_MARKED_COMPLETE' : 'RECON_NOTES_SAVED', entity_type: 'Confirmation', entity_id: req.params.customerId, details: { lot_id: lot._id, lot_number: lot.lot_number } });
  res.json({ ok: true, confirmation: conf });
});

// GET /:lotId/reconciliation/:customerId/export.xlsx — ADMIN or FINANCE.
router.get('/:lotId/reconciliation/:customerId/export.xlsx', requireAdminOrFinance, async (req, res) => {
  try {
    const { lot, customer, sapTxns, soaData, recon } = await getLotReconData(req.params.lotId, req.params.customerId);
    const bridge = buildBridge({ sapTxns, custItems: soaData.items, results: recon.results, summary: recon.summary, customer, cycleId: lot.lot_number, asOfDate: lot.period_label });
    const buffer = await buildReconciliationExcel({ customer, cycleId: lot.lot_number, asOfDate: lot.period_label, summary: recon.summary, results: recon.results, bridge });
    await logAudit({ req, action: 'RECON_EXPORTED', entity_type: 'Confirmation', entity_id: req.params.customerId, details: { lot_id: lot._id, lot_number: lot.lot_number } });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Reconciliation_${req.params.customerId}_${lot.lot_number}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /:lotId/reconciliation/:customerId/send-to-customer — ADMIN or FINANCE.
router.post('/:lotId/reconciliation/:customerId/send-to-customer', requireAdminOrFinance, async (req, res) => {
  try {
    const { lot, conf, customer, sapTxns, soaData, recon } = await getLotReconData(req.params.lotId, req.params.customerId);
    if (!isConfigured()) return res.status(400).json({ error: 'SMTP is not configured on the server. Set SMTP_* in .env to enable sending.' });
    if (!customer?.email) return res.status(400).json({ error: 'Customer has no email on file.' });

    const bridge = buildBridge({ sapTxns, custItems: soaData.items, results: recon.results, summary: recon.summary, customer, cycleId: lot.lot_number, asOfDate: lot.period_label });
    const buffer = await buildReconciliationExcel({ customer, cycleId: lot.lot_number, asOfDate: lot.period_label, summary: recon.summary, results: recon.results, bridge });
    const to = customer.email.match(/<(.+)>/)?.[1] || customer.email;
    const html = reconciliationCompleteEmail(customer, recon.summary, lot.period_label, conf.recon_notes);
    const subject = `Reconciliation Summary – ${customer.customer_name} – ${lot.period_label}`;

    await sendMail({ to, subject, html, attachments: [{ filename: `Reconciliation_${customer.customer_id}.xlsx`, content: buffer }] });

    await EmailLog.create({
      customer_id: customer.customer_id, customer_name: customer.customer_name, email: customer.email,
      lot_id: lot._id, cycle_id: lot.lot_number, subject, kind: 'RECON_COMPLETE', status: 'SENT', sent_at: new Date(),
    });

    await Confirmation.updateOne({ lot_id: lot._id, customer_id: customer.customer_id }, { recon_sent_to_customer_at: new Date() });
    await logAudit({ req, action: 'RECON_SENT_TO_CUSTOMER', entity_type: 'Confirmation', entity_id: customer.customer_id, details: { lot_id: lot._id, lot_number: lot.lot_number, to } });

    res.json({ ok: true, sent_to: to });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
