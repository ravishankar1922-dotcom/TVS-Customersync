const ExcelJS = require('exceljs');

const INR = '#,##0.00';

/**
 * Builds the reconciliation workbook. The primary sheet is the "balance
 * bridge" statement (opening balance → reconciling items → adjusted balance)
 * in the same format the customer/finance team expects (ref: ALLFINE
 * reconciliation format). A secondary "Line Items" sheet keeps the full
 * detailed match grid available for anyone who wants it.
 */
async function buildReconciliationExcel({ customer, cycleId, asOfDate, summary, results, bridge }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BalanceSync';
  wb.created = new Date();

  if (bridge) {
    const b = wb.addWorksheet('Reconciliation');
    b.columns = [{ width: 6 }, { width: 18 }, { width: 14 }, { width: 46 }, { width: 16 }, { width: 16 }, { width: 34 }];

    b.mergeCells('A1:G1');
    b.getCell('A1').value = `Balance Reconciliation Statement – ${customer.customer_name}`;
    b.getCell('A1').font = { bold: true, size: 14 };
    b.mergeCells('A2:G2');
    b.getCell('A2').value = `Customer ID: ${customer.customer_id}   |   Cycle: ${cycleId}   |   As of: ${asOfDate}`;
    b.getCell('A2').font = { italic: true, color: { argb: 'FF666666' } };
    b.addRow([]);

    const openRow = b.addRow(['', '', '', 'Balance as per SAP (Company Books)', '', '', '']);
    b.mergeCells(`D${openRow.number}:E${openRow.number}`);
    b.getCell(`F${openRow.number}`).value = bridge.opening_sap_balance;
    b.getCell(`F${openRow.number}`).numFmt = INR;
    openRow.font = { bold: true };

    const custOpenRow = b.addRow(['', '', '', 'Balance as per Customer Statement', '', '', '']);
    b.mergeCells(`D${custOpenRow.number}:E${custOpenRow.number}`);
    b.getCell(`F${custOpenRow.number}`).value = bridge.opening_customer_balance;
    b.getCell(`F${custOpenRow.number}`).numFmt = INR;
    custOpenRow.font = { bold: true };
    b.addRow([]);

    const hdrRow = b.addRow(['S.No', 'Document No', 'Date', 'Particulars / Reconciling Item', 'Debit (₹)', 'Credit (₹)', 'Remarks']);
    hdrRow.font = { bold: true };
    hdrRow.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E1E2E' } }; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.alignment = { horizontal: 'center' }; });

    if (!bridge.items.length) {
      const r = b.addRow(['', '', '', 'No reconciling items — SAP and customer balances match fully.', '', '', '']);
      b.mergeCells(`D${r.number}:G${r.number}`);
      r.font = { italic: true, color: { argb: 'FF2E7D32' } };
    } else {
      bridge.items.forEach(it => {
        const r = b.addRow([it.s_no, it.doc_number || '-', it.doc_date || '-', it.particulars, it.debit || '', it.credit || '', it.remark]);
        r.getCell(5).numFmt = INR; r.getCell(6).numFmt = INR;
      });
    }
    b.addRow([]);

    const totRow = b.addRow(['', '', '', 'Total Reconciling Items', bridge.total_debit, bridge.total_credit, '']);
    totRow.font = { bold: true };
    totRow.getCell(5).numFmt = INR; totRow.getCell(6).numFmt = INR;
    totRow.eachCell(c => c.border = { top: { style: 'thin' } });

    const adjRow = b.addRow(['', '', '', 'Adjusted SAP Balance', '', '', '']);
    b.mergeCells(`D${adjRow.number}:E${adjRow.number}`);
    b.getCell(`F${adjRow.number}`).value = bridge.adjusted_sap_balance;
    b.getCell(`F${adjRow.number}`).numFmt = INR;
    adjRow.font = { bold: true };

    const diffRow = b.addRow(['', '', '', bridge.is_tied_out ? 'Difference (Reconciled)' : 'Unreconciled Difference', '', '', '']);
    b.mergeCells(`D${diffRow.number}:E${diffRow.number}`);
    b.getCell(`F${diffRow.number}`).value = bridge.difference;
    b.getCell(`F${diffRow.number}`).numFmt = INR;
    diffRow.font = { bold: true, color: { argb: bridge.is_tied_out ? 'FF2E7D32' : 'FFC8102E' } };
  }

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

  // ── Line items sheet (detail on demand) ─────────────────────────────────
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
