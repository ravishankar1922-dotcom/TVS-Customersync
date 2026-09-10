const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const XLSX    = require('xlsx');
const ExcelJS = require('exceljs');
const LedgerEntry = require('../models/LedgerEntry');
const ImportHistory = require('../models/ImportHistory');
const LedgerImportStaging = require('../models/LedgerImportStaging');
const { requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

// In-memory only for the duration of one request — the parsed result gets
// staged in MongoDB (see LedgerImportStaging) before this buffer is
// discarded, so nothing depends on Render's ephemeral local disk.
// Same 20MB cap as the customer-facing SOA upload (confirmations.js) — this
// route had no limit at all, which let an authenticated admin session (or a
// stolen/leaked admin token) push an unbounded-size file straight into a
// 50mb-limited JSON body / memory buffer with no backpressure control.
const MAX_LEDGER_MB = 20;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_LEDGER_MB * 1024 * 1024 } });

const DOC_NUM_KEYS  = ['document_number','doc_number','document number','document no','doc no','doc#','invoice no','invoice number','inv no','inv#','reference','ref no','ref','voucher no','voucher','bill no','bill number'];
const DOC_TYPE_KEYS = ['document_type','doc_type','type','transaction type','doc type'];
const DOC_DATE_KEYS = ['document_date','doc_date','date','invoice date','inv date','posting date','trans date'];
const DUE_DATE_KEYS = ['due_date','due date','payment due','due'];
const AMOUNT_KEYS   = ['amount','invoice amount','invoice value','debit','value','gross amount','total'];
const STATUS_KEYS   = ['status','clearing status','item status'];

function normaliseHeader(h) { return (h || '').toString().toLowerCase().replace(/[^a-z0-9 _]/g, '').trim(); }
function findCol(headers, candidates) {
  for (const c of candidates) {
    const idx = headers.findIndex(h => normaliseHeader(h) === c || normaliseHeader(h).includes(c));
    if (idx >= 0) return idx;
  }
  return -1;
}
function parseAmount(v) {
  if (v === null || v === undefined || v === '') return 0;
  return parseFloat(v.toString().replace(/[₹,\s]/g, '')) || 0;
}
function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().split('T')[0];
  const s = v.toString().trim();
  const m1 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m1) { const [, d, mo, y] = m1; return `${y.length === 2 ? '20' + y : y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`; }
  const d = new Date(s);
  return isNaN(d) ? s : d.toISOString().split('T')[0];
}

// Ledger upload accepts BOTH Excel/CSV (parsed below via XLSX) and JSON.
// Detected by .json extension or by the buffer's first non-whitespace
// character, so it works whether or not the uploader's file picker
// preserved the extension. TWO JSON shapes are accepted, auto-detected:
//
//  1. GROUPED (the app's own shape, e.g. data/TSL_ledger.json / the sample
//     ledger JSON files): a top-level array — or { "ledgers": [...] } — of
//     { customer_id, transactions: [{document_number, ...}, ...] }.
//
//  2. FLAT / "SAP-style" rows: a top-level array — or { "rows"/"data": [...] }
//     — of one object PER TRANSACTION, mirroring an SAP FBL5N-style export
//     converted straight to JSON (so keys are whatever that export used —
//     "Customer", "Document Number", "Posting Date", etc., not this app's
//     internal field names). Detected when entries have no `transactions`
//     array. Column matching reuses the SAME flexible header aliases
//     (DOC_NUM_KEYS etc. below) as the Excel/CSV path, checked
//     case/punctuation-insensitively against each object's own keys, so a
//     real SAP export's exact column names don't need to match this app's
//     naming — only a recognisable customer-identifier key is required
//     (customer_id, customer, customer code, cust id, sold-to, kunnr,
//     account, etc. — see CUSTOMER_ID_KEYS).
const CUSTOMER_ID_KEYS = ['customer_id','customer id','customer','customer code','customer no','customer number','cust id','cust no','cust code','account','account number','sold-to','sold to','sold-to party','kunnr','id'];

function normaliseJsonKey(k) { return (k || '').toString().toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }

// Case/punctuation-insensitive lookup of the first present key in `obj`
// matching any of `candidates` (checked as exact-normalised-match first,
// then substring, mirroring findCol()'s Excel-header matching below).
function findJsonKey(obj, candidates) {
  const keys = Object.keys(obj || {});
  const normKeys = keys.map(normaliseJsonKey);
  for (const c of candidates) {
    let i = normKeys.indexOf(c);
    if (i === -1) i = normKeys.findIndex(nk => nk.includes(c));
    if (i >= 0) return keys[i];
  }
  return null;
}
function jget(obj, candidates) {
  const k = findJsonKey(obj, candidates);
  return k ? obj[k] : undefined;
}

function looksLikeJsonLedger(buffer, originalName) {
  if (/\.json$/i.test(originalName || '')) return true;
  const head = buffer.slice(0, 200).toString('utf8').trim();
  return head.startsWith('[') || head.startsWith('{');
}

// One flat row (either the grouped shape's per-transaction object, or one
// element of the flat/SAP-style array) -> a transaction record, using the
// same flexible key matching regardless of shape. Returns null if the row
// has no usable document number or amount (mirrors the Excel path, which
// silently skips such rows rather than erroring the whole file).
function jsonRowToTxn(t) {
  const amt = parseAmount(jget(t, AMOUNT_KEYS));
  const docNum = (jget(t, DOC_NUM_KEYS) ?? '').toString().trim();
  if (!docNum || amt === 0) return null;
  const statusRaw = jget(t, STATUS_KEYS);
  return {
    document_number: docNum,
    document_type:   (jget(t, DOC_TYPE_KEYS) ?? 'UNKNOWN').toString().trim(),
    document_date:   parseDate(jget(t, DOC_DATE_KEYS)),
    due_date:        parseDate(jget(t, DUE_DATE_KEYS)),
    amount: amt, currency: t.currency || t.Currency || 'INR',
    status: statusRaw ? (statusRaw.toString().toUpperCase().includes('OPEN') ? 'OPEN' : 'CLEARED') : 'OPEN',
  };
}

function parseJsonLedger(buffer) {
  let data;
  try { data = JSON.parse(buffer.toString('utf8')); }
  catch (err) { throw new Error('File looks like JSON but failed to parse: ' + err.message); }
  const rows = Array.isArray(data) ? data
    : Array.isArray(data?.ledgers) ? data.ledgers
    : Array.isArray(data?.rows) ? data.rows
    : Array.isArray(data?.data) ? data.data
    : null;
  if (!rows) throw new Error('Expected a JSON array of ledger rows/entries (or wrapped as { "ledgers": [...] }, { "rows": [...] } or { "data": [...] }).');

  const transactions = [];
  const isGrouped = rows.some(r => Array.isArray(r?.transactions));

  if (isGrouped) {
    rows.forEach(entry => {
      const custKey = findJsonKey(entry, CUSTOMER_ID_KEYS);
      const custId = custKey ? (entry[custKey] ?? '').toString().trim() || null : null;
      const txns = Array.isArray(entry?.transactions) ? entry.transactions : [];
      txns.forEach(t => {
        const txn = jsonRowToTxn(t);
        if (txn) transactions.push({ ...txn, customer_id: custId });
      });
    });
  } else {
    // Flat/SAP-style: one row per transaction, customer identifier lives on
    // the row itself (whatever key it's under — see CUSTOMER_ID_KEYS).
    rows.forEach(row => {
      const custKey = findJsonKey(row, CUSTOMER_ID_KEYS);
      const custId = custKey ? (row[custKey] ?? '').toString().trim() || null : null;
      const txn = jsonRowToTxn(row);
      if (txn) transactions.push({ ...txn, customer_id: custId });
    });
  }

  return { transactions, headers: ['customer_id', 'document_number', 'document_type', 'document_date', 'due_date', 'amount', 'currency', 'status'], colMappings: { source: 'json', shape: isGrouped ? 'grouped' : 'flat' } };
}

function parseUploadedLedger(buffer, originalName) {
  if (looksLikeJsonLedger(buffer, originalName)) return parseJsonLedger(buffer);
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const nonEmpty = (rows[i] || []).filter(c => c !== null && c !== undefined && c.toString().trim() !== '');
    if (nonEmpty.length >= 4) { headerRowIdx = i; break; }
  }
  const headers  = (rows[headerRowIdx] || []).map(h => h?.toString() || '');
  const dataRows = rows.slice(headerRowIdx + 1).filter(r => r && r.some(c => c !== null && c !== undefined && c.toString().trim() !== ''));

  const colDoc = findCol(headers, DOC_NUM_KEYS), colType = findCol(headers, DOC_TYPE_KEYS), colDate = findCol(headers, DOC_DATE_KEYS);
  const colDue = findCol(headers, DUE_DATE_KEYS), colAmt = findCol(headers, AMOUNT_KEYS), colStatus = findCol(headers, STATUS_KEYS);
  const colCust = headers.findIndex(h => normaliseHeader(h).includes('customer'));

  const transactions = [];
  dataRows.forEach((row, ri) => {
    const docNum = colDoc >= 0 ? row[colDoc]?.toString().trim() : `ROW${ri + 1}`;
    const amt    = colAmt >= 0 ? parseAmount(row[colAmt]) : 0;
    if (!docNum || amt === 0) return;
    transactions.push({
      document_number: docNum,
      document_type:   colType >= 0 ? row[colType]?.toString().trim() : 'UNKNOWN',
      document_date:   parseDate(colDate >= 0 ? row[colDate] : null),
      due_date:        parseDate(colDue  >= 0 ? row[colDue]  : null),
      amount: amt, currency: 'INR',
      status: colStatus >= 0 ? (row[colStatus]?.toString().toUpperCase().includes('OPEN') ? 'OPEN' : 'CLEARED') : 'OPEN',
      customer_id: colCust >= 0 ? row[colCust]?.toString().trim() : null,
    });
  });
  return { transactions, headers, colMappings: { colDoc, colType, colDate, colDue, colAmt, colStatus } };
}

router.post('/upload', requireAdmin, upload.single('ledger_file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const parsed = parseUploadedLedger(req.file.buffer, req.file.originalname);
    const import_id = `IMP-${Date.now()}`;
    await LedgerImportStaging.create({
      import_id, filename: req.file.originalname,
      transactions: parsed.transactions, headers: parsed.headers, col_mappings: parsed.colMappings,
    });
    res.json({ ok: true, preview: {
      import_id, filename: req.file.originalname,
      total_rows: parsed.transactions.length, column_mapping: parsed.colMappings, headers: parsed.headers,
      preview_rows: parsed.transactions.slice(0, 10), uploaded_at: new Date().toISOString(),
    }});
  } catch (err) {
    res.status(500).json({ error: 'Failed to parse ledger file: ' + err.message });
  }
});

router.post('/confirm-import', requireAdmin, async (req, res) => {
  const { import_id, filename } = req.body;
  if (!import_id) return res.status(400).json({ error: 'import_id is required' });

  const staged = await LedgerImportStaging.findOne({ import_id }).lean();
  if (!staged) return res.status(400).json({ error: 'This import has expired or was not found. Please re-upload the file.' });

  try {
    const byCustomer = {};
    staged.transactions.forEach(t => {
      const id = t.customer_id || 'UNKNOWN';
      (byCustomer[id] ||= []).push(t);
    });

    for (const [custId, txns] of Object.entries(byCustomer)) {
      await LedgerEntry.findOneAndUpdate({ customer_id: custId }, { transactions: txns }, { upsert: true });
    }

    await ImportHistory.create({
      import_id, filename: filename || staged.filename, customers_updated: Object.keys(byCustomer).length,
      total_transactions: staged.transactions.length, imported_by: req.admin?.email, imported_at: new Date(),
    });
    await logAudit({ req, action: 'LEDGER_IMPORT', entity_type: 'Ledger', details: { filename: filename || staged.filename, customers_updated: Object.keys(byCustomer).length } });
    await LedgerImportStaging.deleteOne({ import_id }); // consumed — no need to keep it around

    res.json({ ok: true, customers_updated: Object.keys(byCustomer).length, total_transactions: staged.transactions.length });
  } catch (err) {
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// POST /api/ledger/import-json — bulk upsert ledgers from JSON, same shape
// as data/TSL_ledger.json: [{ customer_id, transactions: [...] }, ...]
// Body: { ledgers: [...], mode?: 'replace'|'append', dryRun?: boolean }
// - dryRun:true counts customers that already have a ledger on file vs. ones
//   that don't, without writing anything.
// - mode:'replace' (default) overwrites a matched customer's transactions
//   list entirely with the uploaded one.
// - mode:'append' merges the uploaded transactions into whatever that
//   customer already has, de-duplicating by document_number (an uploaded
//   line with the same document number replaces that one line; anything new
//   is added on). A customer with no existing ledger is created either way.
router.post('/import-json', requireAdmin, async (req, res) => {
  const ledgers = Array.isArray(req.body) ? req.body : req.body?.ledgers;
  const mode = req.body?.mode === 'append' ? 'append' : 'replace';
  const dryRun = !!req.body?.dryRun;
  if (!Array.isArray(ledgers) || !ledgers.length) return res.status(400).json({ error: 'Expected a JSON array of { customer_id, transactions } objects (or { "ledgers": [...] }).' });

  if (dryRun) {
    const ids = ledgers.map(l => l.customer_id).filter(Boolean);
    const existing = await LedgerEntry.find({ customer_id: { $in: ids } }).distinct('customer_id');
    const existingSet = new Set(existing);
    const matched = ids.filter(id => existingSet.has(id)).length;
    const brandNew = ids.length - matched;
    return res.json({ ok: true, dryRun: true, total: ids.length, matched, new: brandNew });
  }

  let upserted = 0, skipped = 0;
  for (const l of ledgers) {
    if (!l.customer_id || !Array.isArray(l.transactions)) { skipped++; continue; }
    if (mode === 'append') {
      const existingDoc = await LedgerEntry.findOne({ customer_id: l.customer_id }).lean();
      if (existingDoc) {
        const byDocNo = new Map(existingDoc.transactions.map(t => [t.document_number, t]));
        for (const t of l.transactions) byDocNo.set(t.document_number, t);
        await LedgerEntry.updateOne({ customer_id: l.customer_id }, { transactions: Array.from(byDocNo.values()) });
        upserted++;
        continue;
      }
    }
    await LedgerEntry.findOneAndUpdate({ customer_id: l.customer_id }, { customer_id: l.customer_id, transactions: l.transactions }, { upsert: true });
    upserted++;
  }
  await logAudit({ req, action: 'LEDGER_JSON_IMPORTED', entity_type: 'Ledger', details: { upserted, skipped, mode } });
  res.json({ ok: true, upserted, skipped, mode });
});

router.get('/', requireAdmin, async (req, res) => {
  const ledger = await LedgerEntry.find().lean();
  if (!ledger.length) return res.status(404).json({ error: 'Ledger not found' });
  res.json({ ledger, total: ledger.length });
});

// GET /api/ledger/export.xlsx — full open-items ledger as a workbook
router.get('/export.xlsx', requireAdmin, async (req, res) => {
  const ledgers = await LedgerEntry.find().sort({ customer_id: 1 }).lean();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Ledger');
  ws.columns = [
    { header: 'Customer ID', key: 'customer_id', width: 14 },
    { header: 'Document No', key: 'document_number', width: 18 },
    { header: 'Type', key: 'document_type', width: 14 },
    { header: 'Document Date', key: 'document_date', width: 14 },
    { header: 'Due Date', key: 'due_date', width: 14 },
    { header: 'Amount', key: 'amount', width: 15 },
    { header: 'Status', key: 'status', width: 12 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };
  ledgers.forEach(l => (l.transactions || []).forEach(t => ws.addRow({ customer_id: l.customer_id, ...t })));
  ws.autoFilter = { from: 'A1', to: 'G1' };
  const buffer = await wb.xlsx.writeBuffer();
  await logAudit({ req, action: 'LEDGER_EXPORTED', entity_type: 'Ledger' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Ledger_Export.xlsx"`);
  res.send(buffer);
});

router.get('/history', requireAdmin, async (req, res) => res.json({ imports: await ImportHistory.find().sort({ createdAt: -1 }).lean() }));

module.exports = router;
// Exposed for reuse by routes/lots.js (Lot-scoped ledger upload) so the
// column-detection/parsing logic isn't duplicated — router is an Express
// function; attaching a property to it doesn't affect app.use() behavior.
module.exports.parseUploadedLedger = parseUploadedLedger;
