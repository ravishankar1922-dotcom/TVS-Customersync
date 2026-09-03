const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const XLSX    = require('xlsx');
const path    = require('path');
const fs      = require('fs');
const cfg     = require('../config');
const LedgerEntry = require('../models/LedgerEntry');
const ImportHistory = require('../models/ImportHistory');
const { requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const UPLOAD_TMP = path.join(cfg.UPLOAD_ROOT, '_uploads');
fs.mkdirSync(UPLOAD_TMP, { recursive: true });
const upload = multer({ dest: UPLOAD_TMP });

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

function parseUploadedLedger(filePath, originalName) {
  const wb = XLSX.readFile(filePath, { raw: false });
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

router.post('/upload', requireAdmin, upload.single('ledger_file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const parsed = parseUploadedLedger(req.file.path, req.file.originalname);
    res.json({ ok: true, preview: {
      import_id: `IMP-${Date.now()}`, filename: req.file.originalname, file_path: req.file.path,
      total_rows: parsed.transactions.length, column_mapping: parsed.colMappings, headers: parsed.headers,
      preview_rows: parsed.transactions.slice(0, 10), uploaded_at: new Date().toISOString(),
    }});
  } catch (err) {
    res.status(500).json({ error: 'Failed to parse ledger file: ' + err.message });
  }
});

router.post('/confirm-import', requireAdmin, async (req, res) => {
  const { import_id, file_path, filename } = req.body;
  if (!file_path || !fs.existsSync(file_path)) return res.status(400).json({ error: 'Import file not found. Please re-upload.' });

  try {
    const parsed = parseUploadedLedger(file_path, filename);
    const byCustomer = {};
    parsed.transactions.forEach(t => {
      const id = t.customer_id || 'UNKNOWN';
      (byCustomer[id] ||= []).push(t);
    });

    for (const [custId, txns] of Object.entries(byCustomer)) {
      await LedgerEntry.findOneAndUpdate({ customer_id: custId }, { transactions: txns }, { upsert: true });
    }

    await ImportHistory.create({
      import_id, filename, customers_updated: Object.keys(byCustomer).length,
      total_transactions: parsed.transactions.length, imported_by: req.admin?.email, imported_at: new Date(),
    });
    await logAudit({ req, action: 'LEDGER_IMPORT', entity_type: 'Ledger', details: { filename, customers_updated: Object.keys(byCustomer).length } });

    res.json({ ok: true, customers_updated: Object.keys(byCustomer).length, total_transactions: parsed.transactions.length });
  } catch (err) {
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

router.get('/', requireAdmin, async (req, res) => {
  const ledger = await LedgerEntry.find().lean();
  if (!ledger.length) return res.status(404).json({ error: 'Ledger not found' });
  res.json({ ledger, total: ledger.length });
});

router.get('/history', requireAdmin, async (req, res) => res.json({ imports: await ImportHistory.find().sort({ createdAt: -1 }).lean() }));

module.exports = router;
