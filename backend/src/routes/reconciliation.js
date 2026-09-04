const express = require('express');
const router  = express.Router();
const XLSX    = require('xlsx');
const cfg     = require('../config');
const Customer     = require('../models/Customer');
const LedgerEntry  = require('../models/LedgerEntry');
const Confirmation = require('../models/Confirmation');
const { requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { buildReconciliationExcel } = require('../utils/excelExport');
const { sendMail, isConfigured } = require('../utils/mailer');
const { reconciliationCompleteEmail } = require('../utils/emailTemplates');

function normaliseDocNum(s) {
  if (!s) return '';
  return s.toString().toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(INV|INVOICE|CN|DN|REC|PMT|ADJ)/i, '').replace(/^0+/, '');
}
function parseAmt(v) { if (v === null || v === undefined || v === '') return 0; return parseFloat(v.toString().replace(/[₹,\s]/g, '')) || 0; }
function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().split('T')[0];
  const s = v.toString().trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) { const [, d, mo, y] = m; return `${y.length === 2 ? '20'+y : y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`; }
  const dt = new Date(s);
  return isNaN(dt) ? s : dt.toISOString().split('T')[0];
}
function norm(h) { return (h||'').toString().toLowerCase().replace(/[^a-z0-9 ]/g, '').trim(); }

const COL_GROUPS = {
  doc: ['voucher no','voucher number','voucher','document no','document number','doc no','doc number','doc#','invoice no','invoice number','inv no','inv#','invoice','reference','ref no','ref','bill no','bill number','bill','sl no'],
  type: ['type','document type','doc type','transaction type','category','particulars'],
  date: ['invoice date','inv date','bill date','doc date','document date','posting date','trans date','transaction date','voucher date','date'],
  due:  ['due date','due','payment due','maturity','payment date'],
  debit: ['debit','dr','debit amount','debit (inr)'],
  credit: ['credit','cr','credit amount','credit (inr)'],
  amount: ['amount','invoice amount','net amount','bill amount','gross amount','value','balance','outstanding','open amount','total amount'],
  status: ['status','clearing','item status','open/cleared','clearing status'],
};
function findColIdx(headers, group) {
  for (const c of (COL_GROUPS[group] || [])) {
    const i = headers.findIndex(h => norm(h) === c || norm(h).includes(c));
    if (i >= 0) return i;
  }
  return -1;
}

// Rows whose "document number" / first text cell reads like a running total,
// sub-total, or a carried-forward balance rather than an actual transaction.
// Large real-world statements (1000+ lines) almost always end with one of
// these, and without this filter it gets misread as a phantom line item
// ("Not in SAP") because it has no real SAP counterpart.
const SUMMARY_ROW_RE = /\b(grand\s*total|sub[\s-]?total|total|closing\s*balance|balance\s*c\/?f|balance\s*b\/?f|net\s*total|balance\s*carried\s*forward|balance\s*brought\s*forward)\b/i;
function isSummaryRow(row) {
  return row.some(c => c !== null && c !== undefined && SUMMARY_ROW_RE.test(c.toString().trim()));
}

function parseSOA(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  let headerIdx = 0;
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const filled = (rows[i] || []).filter(c => c !== null && c !== undefined && c.toString().trim() !== '');
    if (filled.length >= 3 && filled.some(c => isNaN(parseFloat(c)))) { headerIdx = i; break; }
  }
  const headers  = (rows[headerIdx] || []).map(h => h?.toString() || '');
  const dataRows = rows.slice(headerIdx + 1).filter(r => r && r.some(c => c !== null && c !== undefined && c.toString().trim() !== '') && !isSummaryRow(r));

  const cDoc = findColIdx(headers, 'doc'), cType = findColIdx(headers, 'type'), cDate = findColIdx(headers, 'date');
  const cDue = findColIdx(headers, 'due'), cDebit = findColIdx(headers, 'debit'), cCredit = findColIdx(headers, 'credit');
  const cAmt = cDebit >= 0 ? -1 : findColIdx(headers, 'amount'), cStatus = findColIdx(headers, 'status');

  const items = [];
  dataRows.forEach((row, ri) => {
    let amt = 0;
    if (cDebit >= 0 && cCredit >= 0) {
      const d = parseAmt(row[cDebit]), c = parseAmt(row[cCredit]);
      amt = d > 0 ? d : (c > 0 ? -c : 0);
    } else if (cAmt >= 0) {
      amt = parseAmt(row[cAmt]);
    } else {
      const firstNum = row.find(c => c !== null && !isNaN(parseFloat(c?.toString().replace(/[₹,]/g, ''))));
      amt = firstNum ? parseAmt(firstNum) : 0;
    }
    const docNum = cDoc >= 0 ? row[cDoc]?.toString().trim() : null;
    if (!docNum && amt === 0) return;
    items.push({
      doc_number: docNum || `ROW${ri + 1}`,
      doc_type:   cType >= 0 ? row[cType]?.toString().trim() : (amt < 0 ? 'CREDIT NOTE' : 'INVOICE'),
      doc_date:   parseDate(cDate >= 0 ? row[cDate] : null),
      due_date:   parseDate(cDue  >= 0 ? row[cDue]  : null),
      amount: amt, currency: 'INR',
      status: cStatus >= 0 ? (row[cStatus]?.toString().toUpperCase().includes('OPEN') ? 'OPEN' : 'CLEARED') : 'OPEN',
    });
  });
  return { items, headers, headerIdx, format_detected: cDebit >= 0 && cCredit >= 0 ? 'DEBIT_CREDIT_SPLIT' : 'SINGLE_AMOUNT' };
}

function reconcile(sapTxns, custItems) {
  const results = [];
  const usedCust = new Set();

  sapTxns.forEach(sap => {
    const exact = custItems.findIndex((c, i) => !usedCust.has(i) && c.doc_number?.toString().toUpperCase() === sap.document_number?.toString().toUpperCase());
    if (exact >= 0) {
      usedCust.add(exact);
      const c = custItems[exact], amtMatch = Math.abs((c.amount || 0) - (sap.amount || 0)) < 0.01;
      results.push({ match_type: amtMatch ? 'MATCHED' : 'MATCHED_WITH_DIFFERENCE', confidence: amtMatch ? 100 : 80,
        sap_doc: sap.document_number, cust_doc: c.doc_number, sap_amount: sap.amount, cust_amount: c.amount,
        amount_diff: parseFloat(((c.amount || 0) - (sap.amount || 0)).toFixed(2)), sap_date: sap.document_date, cust_date: c.doc_date,
        sap_type: sap.document_type, cust_type: c.doc_type, sap_status: sap.status });
      return;
    }
    const sapNorm = normaliseDocNum(sap.document_number);
    const normIdx = custItems.findIndex((c, i) => !usedCust.has(i) && normaliseDocNum(c.doc_number) === sapNorm && sapNorm.length > 3);
    if (normIdx >= 0) {
      usedCust.add(normIdx);
      const c = custItems[normIdx], amtMatch = Math.abs((c.amount || 0) - (sap.amount || 0)) < 0.01;
      results.push({ match_type: amtMatch ? 'MATCHED' : 'MATCHED_WITH_DIFFERENCE', confidence: amtMatch ? 90 : 70, note: 'Normalised document number match',
        sap_doc: sap.document_number, cust_doc: c.doc_number, sap_amount: sap.amount, cust_amount: c.amount,
        amount_diff: parseFloat(((c.amount || 0) - (sap.amount || 0)).toFixed(2)), sap_date: sap.document_date, cust_date: c.doc_date,
        sap_type: sap.document_type, cust_type: c.doc_type, sap_status: sap.status });
      return;
    }
    if (sap.amount && sap.document_date) {
      const amtDateIdx = custItems.findIndex((c, i) => !usedCust.has(i) && Math.abs((c.amount || 0) - sap.amount) < 1 && c.doc_date === sap.document_date);
      if (amtDateIdx >= 0) {
        usedCust.add(amtDateIdx);
        const c = custItems[amtDateIdx];
        results.push({ match_type: 'AMOUNT_DATE_MATCH', confidence: 60, note: 'Matched by amount + date (document numbers differ)',
          sap_doc: sap.document_number, cust_doc: c.doc_number, sap_amount: sap.amount, cust_amount: c.amount, amount_diff: 0,
          sap_date: sap.document_date, cust_date: c.doc_date, sap_type: sap.document_type, cust_type: c.doc_type, sap_status: sap.status });
        return;
      }
    }
    results.push({ match_type: 'MISSING_IN_CUSTOMER', confidence: 0, sap_doc: sap.document_number, cust_doc: null,
      sap_amount: sap.amount, cust_amount: null, amount_diff: sap.amount, sap_date: sap.document_date, cust_date: null,
      sap_type: sap.document_type, sap_status: sap.status });
  });

  custItems.forEach((c, i) => {
    if (!usedCust.has(i)) {
      results.push({ match_type: 'NOT_IN_SAP', confidence: 0, sap_doc: null, cust_doc: c.doc_number, sap_amount: null,
        cust_amount: c.amount, amount_diff: -(c.amount || 0), sap_date: null, cust_date: c.doc_date, sap_type: null, cust_type: c.doc_type });
    }
  });

  const summary = {
    matched: results.filter(r => r.match_type === 'MATCHED').length,
    matched_with_difference: results.filter(r => r.match_type === 'MATCHED_WITH_DIFFERENCE').length,
    amount_date_match: results.filter(r => r.match_type === 'AMOUNT_DATE_MATCH').length,
    missing_in_customer: results.filter(r => r.match_type === 'MISSING_IN_CUSTOMER').length,
    not_in_sap: results.filter(r => r.match_type === 'NOT_IN_SAP').length,
    total_sap_balance: sapTxns.filter(t => t.status === 'OPEN').reduce((s, t) => s + (t.amount || 0), 0),
    total_cust_balance: custItems.reduce((s, c) => s + (c.amount || 0), 0),
  };
  summary.net_difference = parseFloat((summary.total_cust_balance - summary.total_sap_balance).toFixed(2));
  return { results, summary };
}

// Builds a professional AR-style "balance bridge" reconciliation statement:
// Opening SAP balance → itemised reconciling items (Debit/Credit + remark)
// → Adjusted/Common balance. Derived algebraically from the same `results`
// array the line-item grid uses, so it always ties out to zero difference
// once every adjustment is applied.
function buildBridge({ sapTxns, custItems, results, summary, customer, cycleId, asOfDate }) {
  const items = [];
  let seq = 1;
  results.forEach(r => {
    if (r.match_type === 'MATCHED' || r.match_type === 'AMOUNT_DATE_MATCH') return; // no adjustment needed

    if (r.match_type === 'MATCHED_WITH_DIFFERENCE') {
      const delta = parseFloat(((r.cust_amount || 0) - (r.sap_amount || 0)).toFixed(2));
      if (Math.abs(delta) < 0.01) return;
      items.push({
        s_no: seq++, doc_number: r.sap_doc || r.cust_doc, doc_date: r.sap_date || r.cust_date,
        particulars: `Amount difference on Doc ${r.sap_doc || r.cust_doc} (SAP ₹${(r.sap_amount||0).toLocaleString('en-IN')} vs Customer ₹${(r.cust_amount||0).toLocaleString('en-IN')})`,
        debit: delta > 0 ? delta : 0, credit: delta < 0 ? -delta : 0,
        remark: 'Amount mismatch between SAP and customer books — needs verification',
      });
      return;
    }

    if (r.match_type === 'MISSING_IN_CUSTOMER') {
      // Item exists in SAP (as an open balance) but customer's SOA does not
      // show it — it inflates the SAP balance relative to the customer's,
      // so bridge it out as a credit-side reconciling item on the SAP side.
      const amt = r.sap_amount || 0;
      items.push({
        s_no: seq++, doc_number: r.sap_doc, doc_date: r.sap_date,
        particulars: `In SAP but not appearing in customer statement — Doc ${r.sap_doc}`,
        debit: amt < 0 ? -amt : 0, credit: amt >= 0 ? amt : 0,
        remark: 'Missing in customer books — request customer to confirm/book',
      });
      return;
    }

    if (r.match_type === 'NOT_IN_SAP') {
      // Item appears in the customer's SOA but has no SAP counterpart —
      // bridge it in as a debit-side reconciling item.
      const amt = r.cust_amount || 0;
      items.push({
        s_no: seq++, doc_number: r.cust_doc, doc_date: r.cust_date,
        particulars: `In customer statement but not in SAP — Doc ${r.cust_doc}`,
        debit: amt >= 0 ? amt : 0, credit: amt < 0 ? -amt : 0,
        remark: 'Not booked in SAP — needs investigation/booking',
      });
    }
  });

  const totalDebit  = parseFloat(items.reduce((s, i) => s + i.debit, 0).toFixed(2));
  const totalCredit = parseFloat(items.reduce((s, i) => s + i.credit, 0).toFixed(2));
  const openingSap   = parseFloat(summary.total_sap_balance.toFixed(2));
  const openingCust  = parseFloat(summary.total_cust_balance.toFixed(2));
  const adjustedSap  = parseFloat((openingSap + totalDebit - totalCredit).toFixed(2));
  const difference   = parseFloat((adjustedSap - openingCust).toFixed(2));

  return {
    customer_name: customer?.customer_name, customer_id: customer?.customer_id,
    cycle_id: cycleId, as_of_date: asOfDate,
    opening_sap_balance: openingSap, opening_customer_balance: openingCust,
    items, total_debit: totalDebit, total_credit: totalCredit,
    adjusted_sap_balance: adjustedSap, difference,
    is_tied_out: Math.abs(difference) < 1,
  };
}

async function getReconData(customerId) {
  const conf = await Confirmation.findOne({ customer_id: customerId, cycle_id: cfg.CYCLE_ID }).lean();
  if (!conf) throw Object.assign(new Error('No confirmation found for this customer'), { status: 404 });
  if (!conf.soa_data) throw Object.assign(new Error('No SOA file uploaded yet'), { status: 404 });

  const led = await LedgerEntry.findOne({ customer_id: customerId }).lean();
  if (!led) throw Object.assign(new Error('No ledger found for this customer'), { status: 404 });

  const customer = await Customer.findOne({ customer_id: customerId }).lean();
  const sapTxns = led.transactions.filter(t => t.status === 'OPEN');
  const soaBuffer = conf.soa_data.buffer ? Buffer.from(conf.soa_data.buffer) : conf.soa_data;
  const soaData = parseSOA(soaBuffer);
  const recon = reconcile(sapTxns, soaData.items);
  return { conf, customer, sapTxns, soaData, recon };
}

// GET /api/reconciliation/:customerId
router.get('/:customerId', requireAdmin, async (req, res) => {
  try {
    const { conf, customer, sapTxns, soaData, recon } = await getReconData(req.params.customerId);
    const bridge = buildBridge({ sapTxns, custItems: soaData.items, results: recon.results, summary: recon.summary, customer, cycleId: cfg.CYCLE_ID, asOfDate: cfg.AS_OF_DATE });
    res.json({
      customer_id: req.params.customerId, cycle_id: cfg.CYCLE_ID, customer_name: customer?.customer_name,
      soa_filename: conf.soa_filename, soa_format: soaData.format_detected, soa_headers: soaData.headers,
      sap_lines: sapTxns, customer_lines: soaData.items, results: recon.results, summary: recon.summary, bridge,
      recon_status: conf.recon_status, recon_notes: conf.recon_notes, root_causes: conf.root_causes || {},
      recon_sent_to_customer_at: conf.recon_sent_to_customer_at,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/reconciliation/:customerId/export.xlsx — download workbook
router.get('/:customerId/export.xlsx', requireAdmin, async (req, res) => {
  try {
    const { customer, sapTxns, soaData, recon } = await getReconData(req.params.customerId);
    const bridge = buildBridge({ sapTxns, custItems: soaData.items, results: recon.results, summary: recon.summary, customer, cycleId: cfg.CYCLE_ID, asOfDate: cfg.AS_OF_DATE });
    const buffer = await buildReconciliationExcel({ customer, cycleId: cfg.CYCLE_ID, asOfDate: cfg.AS_OF_DATE, summary: recon.summary, results: recon.results, bridge });
    await logAudit({ req, action: 'RECON_EXPORTED', entity_type: 'Confirmation', entity_id: req.params.customerId });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Reconciliation_${req.params.customerId}_${cfg.CYCLE_ID}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/reconciliation/:customerId/send-to-customer
// Emails the customer the reconciliation summary + Excel attachment, and
// (optionally) marks the reconciliation as COMPLETED at the same time.
router.post('/:customerId/send-to-customer', requireAdmin, async (req, res) => {
  try {
    const { customer, sapTxns, soaData, recon, conf } = await getReconData(req.params.customerId);
    if (!isConfigured()) return res.status(400).json({ error: 'SMTP is not configured on the server. Set SMTP_* in .env to enable sending.' });
    if (!customer?.email) return res.status(400).json({ error: 'Customer has no email on file.' });

    const bridge = buildBridge({ sapTxns, custItems: soaData.items, results: recon.results, summary: recon.summary, customer, cycleId: cfg.CYCLE_ID, asOfDate: cfg.AS_OF_DATE });
    const buffer = await buildReconciliationExcel({ customer, cycleId: cfg.CYCLE_ID, asOfDate: cfg.AS_OF_DATE, summary: recon.summary, results: recon.results, bridge });
    const to = customer.email.match(/<(.+)>/)?.[1] || customer.email;
    const html = reconciliationCompleteEmail(customer, recon.summary, cfg.AS_OF_DATE, conf.recon_notes);
    const subject = `Reconciliation Summary – ${customer.customer_name} – ${cfg.AS_OF_DATE}`;

    await sendMail({ to, subject, html, attachments: [{ filename: `Reconciliation_${customer.customer_id}.xlsx`, content: buffer }] });

    await require('../models/EmailLog').create({
      customer_id: customer.customer_id, customer_name: customer.customer_name, email: customer.email,
      cycle_id: cfg.CYCLE_ID, subject, kind: 'RECON_COMPLETE', status: 'SENT', sent_at: new Date(),
    });

    await Confirmation.updateOne({ customer_id: customer.customer_id, cycle_id: cfg.CYCLE_ID }, { recon_sent_to_customer_at: new Date() });
    await logAudit({ req, action: 'RECON_SENT_TO_CUSTOMER', entity_type: 'Confirmation', entity_id: customer.customer_id, details: { to } });

    res.json({ ok: true, sent_to: to });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
