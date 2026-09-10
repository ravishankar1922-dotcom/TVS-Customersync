const express = require('express');
const router  = express.Router();
const ExcelJS = require('exceljs');
const cfg     = require('../config');
const Customer = require('../models/Customer');
const LedgerEntry = require('../models/LedgerEntry');
const Confirmation = require('../models/Confirmation');
const TokenRecord = require('../models/TokenRecord');
const EmailLog = require('../models/EmailLog');
const { requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

function openBalance(ledgerDoc) {
  if (!ledgerDoc) return 0;
  return ledgerDoc.transactions.filter(t => t.status === 'OPEN').reduce((s, t) => s + (t.amount || 0), 0);
}

// PERFORMANCE (found via load testing — see QA report's "Load & Performance
// Testing" section): the customer overview join previously called
// Array.prototype.find() four times inside a .map() over every customer —
// O(customers × confirmations + customers × tokens + ...) linear scans. At
// 300 seeded customers this measured p50 ≈ 165ms / p99 ≈ 200ms for a single
// request even against an in-memory (zero-network-latency) fake DB; against
// real MongoDB Atlas network round-trips this join cost stacks on top, and
// it scales quadratically as the customer book grows. Build one Map per
// side-table up front (O(n) each) instead, preserving the exact "first
// matching record wins" semantics the original .find() calls had.
function firstMatchMap(arr, keyOf, filterFn) {
  const m = new Map();
  for (const item of arr) {
    if (filterFn && !filterFn(item)) continue;
    const k = keyOf(item);
    if (!m.has(k)) m.set(k, item);
  }
  return m;
}

// GET /api/customers — admin only
router.get('/', requireAdmin, async (req, res) => {
  const [customers, confirmations, tokens, emails, ledgers] = await Promise.all([
    Customer.find().sort({ customer_id: 1 }).lean(),
    Confirmation.find({ cycle_id: cfg.CYCLE_ID }).lean(),
    TokenRecord.find({ cycle_id: cfg.CYCLE_ID }).lean(),
    EmailLog.find({ cycle_id: cfg.CYCLE_ID }).lean(),
    LedgerEntry.find().lean(),
  ]);
  if (!customers.length) return res.status(404).json({ error: 'No customers found. Seed the database first (npm run seed).' });

  const confByCustomer  = firstMatchMap(confirmations, x => x.customer_id);
  const tokenByCustomer = firstMatchMap(tokens, t => t.customer_id);
  const emailByCustomer = firstMatchMap(emails, e => e.customer_id, e => e.kind !== 'RECON_COMPLETE');
  const ledgerByCustomer = firstMatchMap(ledgers, l => l.customer_id);

  const result = customers.map(c => {
    const conf  = confByCustomer.get(c.customer_id);
    const token = tokenByCustomer.get(c.customer_id);
    const email = emailByCustomer.get(c.customer_id);
    const led   = ledgerByCustomer.get(c.customer_id);

    return {
      ...c,
      sap_balance:      openBalance(led),
      cust_balance:     conf ? conf.cust_balance : null,
      difference:       conf ? conf.difference : null,
      status:           conf ? conf.status : 'PENDING',
      soa_file:         conf ? conf.soa_filename : null,
      submission_date:  conf ? conf.submitted_at : null,
      token_status:     token ? token.status : 'NOT_GENERATED',
      token_expires_at: token ? token.expires_at : null,
      email_status:     email ? email.status : 'NOT_SENT',
      recon_status:     conf ? (conf.recon_status || 'PENDING') : 'PENDING',
      recon_sent_to_customer_at: conf ? conf.recon_sent_to_customer_at : null,
      reupload_status:  conf ? (conf.reupload_status || 'NONE') : 'NONE',
    };
  });

  res.json({ customers: result, total: result.length });
});

// POST /api/customers/import-json — bulk upsert customer master from a JSON
// array (same shape as data/customer_master.json), directly from the admin
// UI instead of the local npm run seed script.
// Body: { customers: [...], mode?: 'replace'|'append', dryRun?: boolean }
// - dryRun:true just counts how many uploaded records match existing
//   customer_ids vs. are brand new, so the UI can ask Replace/Append first
//   without writing anything.
// - mode:'replace' (default) overwrites matched customers with the uploaded
//   data. mode:'append' only inserts customers that don't already exist —
//   any customer_id already on file is left completely untouched.
router.post('/import-json', requireAdmin, async (req, res) => {
  const customers = Array.isArray(req.body) ? req.body : req.body?.customers;
  const mode = req.body?.mode === 'append' ? 'append' : 'replace';
  const dryRun = !!req.body?.dryRun;
  if (!Array.isArray(customers) || !customers.length) return res.status(400).json({ error: 'Expected a JSON array of customer objects (or { "customers": [...] }).' });

  if (dryRun) {
    const ids = customers.map(c => c.customer_id).filter(Boolean);
    const existing = await Customer.find({ customer_id: { $in: ids } }).distinct('customer_id');
    const existingSet = new Set(existing);
    const matched = ids.filter(id => existingSet.has(id)).length;
    const brandNew = ids.length - matched;
    return res.json({ ok: true, dryRun: true, total: ids.length, matched, new: brandNew });
  }

  let upserted = 0, skipped = 0, appendedSkipped = 0;
  const errors = [];
  for (const c of customers) {
    if (!c.customer_id || !c.customer_name) { skipped++; errors.push(`Missing customer_id/customer_name: ${JSON.stringify(c).slice(0, 80)}`); continue; }
    if (!c.pan) { skipped++; errors.push(`${c.customer_id}: no PAN on file (required for portal login) — skipped`); continue; }
    if (mode === 'append') {
      const exists = await Customer.exists({ customer_id: c.customer_id });
      if (exists) { appendedSkipped++; continue; }
    }
    await Customer.findOneAndUpdate({ customer_id: c.customer_id }, { ...c, pan: c.pan.toUpperCase() }, { upsert: true });
    upserted++;
  }
  await logAudit({ req, action: 'CUSTOMER_MASTER_JSON_IMPORTED', entity_type: 'Customer', details: { upserted, skipped, mode, appendedSkipped } });
  res.json({ ok: true, upserted, skipped, appendedSkipped, mode, errors: errors.slice(0, 20) });
});

// GET /api/customers/export.xlsx — full customer list as a workbook
router.get('/export.xlsx', requireAdmin, async (req, res) => {
  const [customers, confirmations, tokens, ledgers] = await Promise.all([
    Customer.find().sort({ customer_id: 1 }).lean(),
    Confirmation.find({ cycle_id: cfg.CYCLE_ID }).lean(),
    TokenRecord.find({ cycle_id: cfg.CYCLE_ID }).lean(),
    LedgerEntry.find().lean(),
  ]);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Customers');
  ws.columns = [
    { header: 'Customer ID', key: 'customer_id', width: 16 },
    { header: 'Customer Name', key: 'customer_name', width: 30 },
    { header: 'Email', key: 'email', width: 26 },
    { header: 'PAN', key: 'pan', width: 14 },
    { header: 'SAP Balance', key: 'sap_balance', width: 15 },
    { header: 'Customer Balance', key: 'cust_balance', width: 16 },
    { header: 'Difference', key: 'difference', width: 14 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Recon Status', key: 'recon_status', width: 14 },
    { header: 'Token Status', key: 'token_status', width: 14 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };
  customers.forEach(c => {
    const conf  = confirmations.find(x => x.customer_id === c.customer_id);
    const token = tokens.find(t => t.customer_id === c.customer_id);
    const led   = ledgers.find(l => l.customer_id === c.customer_id);
    ws.addRow({
      customer_id: c.customer_id, customer_name: c.customer_name, email: c.email, pan: c.pan,
      sap_balance: led ? led.transactions.filter(t => t.status === 'OPEN').reduce((s, t) => s + (t.amount || 0), 0) : 0,
      cust_balance: conf ? conf.cust_balance : '', difference: conf ? conf.difference : '',
      status: conf ? conf.status : 'PENDING', recon_status: conf ? conf.recon_status : 'PENDING',
      token_status: token ? token.status : 'NOT_GENERATED',
    });
  });
  ws.autoFilter = { from: 'A1', to: 'J1' };
  const buffer = await wb.xlsx.writeBuffer();
  await logAudit({ req, action: 'CUSTOMERS_EXPORTED', entity_type: 'Customer' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Customers_${cfg.CYCLE_ID}.xlsx"`);
  res.send(buffer);
});

// GET /api/customers/:id
router.get('/:id', requireAdmin, async (req, res) => {
  const customer = await Customer.findOne({ customer_id: req.params.id }).lean();
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const led = await LedgerEntry.findOne({ customer_id: req.params.id }).lean();
  res.json({ ...customer, sap_balance: openBalance(led), ledger: led });
});

// GET /api/customers/:id/ledger
router.get('/:id/ledger', requireAdmin, async (req, res) => {
  const led = await LedgerEntry.findOne({ customer_id: req.params.id }).lean();
  if (!led) return res.status(404).json({ error: 'Ledger not found for customer' });
  res.json(led);
});

module.exports = router;
