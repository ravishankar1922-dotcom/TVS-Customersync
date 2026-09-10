const { parseUploadedLedger } = require('../../src/routes/ledger');

// Ledger upload now accepts BOTH Excel/CSV and JSON (same shape as
// data/TSL_ledger.json) — see the Sept 2026 "Ledger upload can be both JSON
// and excel" request.
describe('parseUploadedLedger() — JSON ledger support', () => {
  function jsonBuf(obj) { return Buffer.from(JSON.stringify(obj), 'utf8'); }

  test('parses a JSON array of {customer_id, transactions} into flat transactions with customer_id attached', () => {
    const buf = jsonBuf([
      { customer_id: 'TEST_C001', transactions: [
        { document_number: 'INV1', document_type: 'INVOICE', document_date: '2026-06-01', due_date: '2026-07-01', amount: 1000, status: 'OPEN' },
        { document_number: 'INV2', document_type: 'CREDIT_MEMO', document_date: '2026-06-05', amount: 200, status: 'CLEARED' },
      ] },
      { customer_id: 'TEST_C002', transactions: [
        { document_number: 'INV3', document_date: '2026-06-02', amount: 500, status: 'OPEN' },
      ] },
    ]);
    const result = parseUploadedLedger(buf, 'ledger_June_2026.json');
    expect(result.transactions.length).toBe(3);
    expect(result.transactions.map(t => t.customer_id)).toEqual(['TEST_C001', 'TEST_C001', 'TEST_C002']);
    expect(result.transactions[0]).toMatchObject({ document_number: 'INV1', amount: 1000, status: 'OPEN', currency: 'INR' });
    expect(result.transactions[1].status).toBe('CLEARED');
  });

  test('also accepts the { "ledgers": [...] } wrapped shape', () => {
    const buf = jsonBuf({ ledgers: [{ customer_id: 'TEST_C001', transactions: [{ document_number: 'INV1', amount: 100, status: 'OPEN' }] }] });
    const result = parseUploadedLedger(buf, 'ledger.json');
    expect(result.transactions.length).toBe(1);
  });

  test('is detected by content even without a .json extension', () => {
    const buf = jsonBuf([{ customer_id: 'TEST_C001', transactions: [{ document_number: 'INV1', amount: 100, status: 'OPEN' }] }]);
    const result = parseUploadedLedger(buf, 'upload'); // no extension at all
    expect(result.transactions.length).toBe(1);
  });

  test('skips lines with a zero amount or missing document number, same as the Excel path', () => {
    const buf = jsonBuf([{ customer_id: 'TEST_C001', transactions: [
      { document_number: 'INV1', amount: 0, status: 'OPEN' },
      { document_number: '', amount: 500, status: 'OPEN' },
      { document_number: 'INV2', amount: 500, status: 'OPEN' },
    ] }]);
    const result = parseUploadedLedger(buf, 'ledger.json');
    expect(result.transactions.length).toBe(1);
    expect(result.transactions[0].document_number).toBe('INV2');
  });

  test('throws a clear error on malformed JSON', () => {
    const buf = Buffer.from('{ not: valid json', 'utf8');
    expect(() => parseUploadedLedger(buf, 'bad.json')).toThrow(/failed to parse/i);
  });

  test('throws a clear error when JSON is valid but not the expected shape', () => {
    const buf = jsonBuf({ hello: 'world' });
    expect(() => parseUploadedLedger(buf, 'bad.json')).toThrow(/Expected a JSON array/i);
  });

  test('Excel/CSV upload is unaffected — still parsed via the XLSX path', () => {
    const XLSX = require('xlsx');
    const header = ['customer_id', 'document_number', 'document_type', 'document_date', 'amount', 'status'];
    const data = [header, ['TEST_C001', 'INV1', 'INVOICE', '2026-06-01', 1000, 'OPEN']];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Ledger');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const result = parseUploadedLedger(buf, 'ledger.xlsx');
    expect(result.transactions.length).toBe(1);
    expect(result.transactions[0].customer_id).toBe('TEST_C001');
  });
});

// Sept 2026 fix: "No rows in this file could be matched to a customer_id"
// on a JSON upload — the file was valid JSON and parsed structurally, but
// every row's customer identifier lived under a DIFFERENT key than exactly
// "customer_id" (e.g. a real SAP export converted straight to JSON keeps
// SAP's own column names), so every row silently collapsed to
// customer_id: null. Fixed by flexible, case/punctuation-insensitive key
// matching (CUSTOMER_ID_KEYS) — same idea as the Excel path's header
// matching — plus support for a FLAT row-per-transaction shape (no
// `transactions` grouping at all), which is what a straight SAP FBL5N
// export converted to JSON actually looks like.
describe('parseUploadedLedger() — JSON ledger support: real-world key/shape variants', () => {
  function jsonBuf(obj) { return Buffer.from(JSON.stringify(obj), 'utf8'); }

  test('grouped shape: an alternate customer-identifier key ("Customer") is recognised, not just "customer_id"', () => {
    const buf = jsonBuf([
      { Customer: 'CUST0049', transactions: [{ 'Document Number': 'INV1', Amount: 1000, Status: 'OPEN' }] },
    ]);
    const result = parseUploadedLedger(buf, 'sap_export.json');
    expect(result.transactions.length).toBe(1);
    expect(result.transactions[0].customer_id).toBe('CUST0049');
    expect(result.transactions[0].document_number).toBe('INV1');
    expect(result.transactions[0].amount).toBe(1000);
  });

  test('FLAT/SAP-style shape: one flat object per transaction (no transactions[] grouping), SAP column names', () => {
    const buf = jsonBuf([
      { Customer: 'CUST0001', 'Document Number': 'RV0001', 'Document Type': 'RV', 'Posting Date': '2026-06-01', 'Amount in Local Currency': 15000, 'Item Status': 'Open' },
      { Customer: 'CUST0001', 'Document Number': 'RV0002', 'Document Type': 'RV', 'Posting Date': '2026-06-05', 'Amount in Local Currency': 5000, 'Item Status': 'Open' },
      { Customer: 'CUST0002', 'Document Number': 'RV0003', 'Document Type': 'RV', 'Posting Date': '2026-06-02', 'Amount in Local Currency': 8000, 'Item Status': 'Cleared' },
    ]);
    const result = parseUploadedLedger(buf, 'sap_flat_export.json');
    expect(result.transactions.length).toBe(3);
    expect(result.transactions.map(t => t.customer_id)).toEqual(['CUST0001', 'CUST0001', 'CUST0002']);
    expect(result.transactions[0]).toMatchObject({ document_number: 'RV0001', amount: 15000, status: 'OPEN' });
    expect(result.transactions[2].status).toBe('CLEARED');
  });

  test('flat shape also recognised via { "rows": [...] } / { "data": [...] } wrappers', () => {
    const row = { customer_code: 'CUST0099', doc_no: 'INV9', amount: 250, status: 'OPEN' };
    expect(parseUploadedLedger(jsonBuf({ rows: [row] }), 'x.json').transactions.length).toBe(1);
    expect(parseUploadedLedger(jsonBuf({ data: [row] }), 'x.json').transactions.length).toBe(1);
  });

  test('a flat row with no recognisable customer-identifier key is skipped (customer_id: null), not crashed on', () => {
    const buf = jsonBuf([{ 'Document Number': 'INV1', Amount: 100, Status: 'OPEN' }]);
    const result = parseUploadedLedger(buf, 'x.json');
    expect(result.transactions.length).toBe(1);
    expect(result.transactions[0].customer_id).toBeNull();
  });
});
