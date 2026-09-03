const ExcelJS = require('exceljs');

/**
 * Builds a formatted reconciliation workbook (2 sheets: Summary + Line Items)
 * and returns it as a Buffer, ready to stream in a response or attach to email.
 */
async function buildReconciliationExcel({ customer, cycleId, asOfDate, summary, results }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BalanceSync';
  wb.created = new Date();

  // ── Summary sheet ─────────────────────────────────────────────────────
  const s = wb.addWorksheet('Summary');
  s.columns = [{ width: 32 }, { width: 28 }];
  s.addRow(['Customer', customer.customer_name]).font = { bold: true };
  s.addRow(['Customer ID', customer.customer_id]);
  s.addRow(['Cycle', cycleId]);
  s.addRow(['As of Date', asOfDate]);
  s.addRow([]);
  s.addRow(['SAP Balance (Rs.)', summary.total_sap_balance]);
  s.addRow(['Customer Balance (Rs.)', summary.total_cust_balance]);
  s.addRow(['Net Difference (Rs.)', summary.net_difference]);
  s.addRow([]);
  s.addRow(['Matched', summary.matched]);
  s.addRow(['Matched with Difference', summary.matched_with_difference]);
  s.addRow(['Amount+Date Match', summary.amount_date_match]);
  s.addRow(['Missing in Customer SOA', summary.missing_in_customer]);
  s.addRow(['Extra in Customer SOA (not in SAP)', summary.not_in_sap]);
  s.getRow(1).font = { bold: true, size: 13 };

  // ── Line items sheet ──────────────────────────────────────────────────
  const l = wb.addWorksheet('Line Items');
  l.columns = [
    { header: 'Match Type',    key: 'match_type', width: 22 },
    { header: 'SAP Doc No',    key: 'sap_doc',     width: 18 },
    { header: 'SAP Amount',    key: 'sap_amount',  width: 15 },
    { header: 'Customer Doc No', key: 'cust_doc',  width: 18 },
    { header: 'Customer Amount', key: 'cust_amount', width: 15 },
    { header: 'Difference',    key: 'amount_diff', width: 14 },
    { header: 'SAP Date',      key: 'sap_date',     width: 14 },
    { header: 'Confidence %',  key: 'confidence',   width: 12 },
    { header: 'Root Cause',    key: 'root_cause',   width: 20 },
  ];
  l.getRow(1).font = { bold: true };
  l.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };
  results.forEach(r => l.addRow(r));
  l.autoFilter = { from: 'A1', to: 'I1' };

  return wb.xlsx.writeBuffer();
}

module.exports = { buildReconciliationExcel };
