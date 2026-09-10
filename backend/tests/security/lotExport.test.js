const request = require('supertest');
const XLSX = require('xlsx');
const app = require('../../src/server');
const fakeModels = require('../helpers/models/index');
const { resetAllModels } = fakeModels;
const { adminJwt, financeJwt } = require('../helpers/seed');

beforeEach(() => resetAllModels());

function buildLedgerXlsx(rows) {
  const header = ['customer_id', 'document_number', 'document_type', 'document_date', 'amount', 'status'];
  const data = [header, ...rows.map(r => [r.customer_id, r.document_number, r.document_type, r.document_date, r.amount, r.status])];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Ledger');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// supertest/superagent doesn't know how to parse the xlsx mimetype into a
// Buffer by default (res.body comes back as {}) — collect the raw bytes
// ourselves, same technique used for any other binary-download assertion.
function binaryParser(res, callback) {
  res.setEncoding('binary');
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => callback(null, Buffer.from(data, 'binary')));
}

async function createLotWithLedger(period, rows) {
  const lotRes = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period });
  const lot = lotRes.body.lot;
  await request(app).post(`/api/lots/${lot._id}/ledger/upload`).set('Authorization', `Bearer ${adminJwt()}`).attach('ledger_file', buildLedgerXlsx(rows), 'ledger.xlsx');
  return lot;
}

// Phase 7: GET /api/lots/:lotId/confirmations/export.xlsx — Lot-aware export.
describe('GET /api/lots/:lotId/confirmations/export.xlsx — Lot-aware export (spec section 7)', () => {
  test('exports only the requested Lot\'s rows, never another Lot\'s data', async () => {
    const lot1 = await createLotWithLedger('March 2026', [
      { customer_id: 'TEST_A', document_number: 'MAR-1', document_type: 'INVOICE', document_date: '2026-03-01', amount: 1000, status: 'OPEN' },
    ]);
    const lot2 = await createLotWithLedger('June 2026', [
      { customer_id: 'TEST_A', document_number: 'JUN-1', document_type: 'INVOICE', document_date: '2026-06-01', amount: 99999, status: 'OPEN' },
      { customer_id: 'TEST_D', document_number: 'JUN-2', document_type: 'INVOICE', document_date: '2026-06-02', amount: 5000, status: 'OPEN' },
    ]);

    const res = await request(app)
      .get(`/api/lots/${lot1._id}/confirmations/export.xlsx`)
      .set('Authorization', `Bearer ${adminJwt()}`)
      .buffer(true).parse(binaryParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');

    const wb = XLSX.read(res.body, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);

    // Only Lot 1's population (TEST_A) — never TEST_D or Lot 2's balances.
    expect(rows.length).toBe(1);
    expect(rows[0]['Customer ID']).toBe('TEST_A');
    expect(rows[0]['Opening Balance']).toBe(1000); // Lot 1's balance, not Lot 2's 99999
    expect(rows.map(r => r['Customer ID'])).not.toContain('TEST_D');
    expect(rows[0]['Lot Number']).toBe(lot1.lot_number);
  });

  test('includes the expected comprehensive column set', async () => {
    const lot = await createLotWithLedger('March 2026', [
      { customer_id: 'TEST_A', document_number: 'I1', document_type: 'INVOICE', document_date: '2026-03-01', amount: 1000, status: 'OPEN' },
    ]);
    const res = await request(app).get(`/api/lots/${lot._id}/confirmations/export.xlsx`).set('Authorization', `Bearer ${adminJwt()}`).buffer(true).parse(binaryParser);
    const wb = XLSX.read(res.body, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const headerRow = XLSX.utils.sheet_to_json(ws, { header: 1 })[0];

    ['Lot Number', 'Period', 'Business Type', 'Customer ID', 'Customer Name', 'Opening Balance',
     'SAP Balance', 'Customer Balance', 'Difference', 'Status', 'Recon Status', 'Workflow Status',
     'Current Version', 'Submitted At', 'SOA Filename', 'Token Status', 'Token Expires At']
      .forEach(col => expect(headerRow).toContain(col));
  });

  test('a VENDOR-business-type Lot exports vendor rows with "Vendor ID"/"Vendor Name" headers', async () => {
    await fakeModels.Vendor.create({ vendor_id: 'TEST_V001', vendor_name: 'TEST Vendor One', email: 'v@example.test', pan: 'ABCDE1234F' });
    const lotRes = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026', business_type: 'VENDOR' });
    const lot = lotRes.body.lot;
    await request(app).post(`/api/lots/${lot._id}/ledger/upload`).set('Authorization', `Bearer ${adminJwt()}`)
      .attach('ledger_file', buildLedgerXlsx([{ customer_id: 'TEST_V001', document_number: 'I1', document_type: 'INVOICE', document_date: '2026-03-01', amount: 2000, status: 'OPEN' }]), 'ledger.xlsx');

    const res = await request(app).get(`/api/lots/${lot._id}/confirmations/export.xlsx`).set('Authorization', `Bearer ${adminJwt()}`).buffer(true).parse(binaryParser);
    const wb = XLSX.read(res.body, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const headerRow = XLSX.utils.sheet_to_json(ws, { header: 1 })[0];
    expect(headerRow).toContain('Vendor ID');
    expect(headerRow).toContain('Vendor Name');
  });

  test('Finance can read the export (read-only endpoint)', async () => {
    const lot = await createLotWithLedger('March 2026', [
      { customer_id: 'TEST_A', document_number: 'I1', document_type: 'INVOICE', document_date: '2026-03-01', amount: 1000, status: 'OPEN' },
    ]);
    const res = await request(app).get(`/api/lots/${lot._id}/confirmations/export.xlsx`).set('Authorization', `Bearer ${financeJwt()}`);
    expect(res.status).toBe(200);
  });

  test('404 on an unknown Lot id', async () => {
    const res = await request(app).get('/api/lots/000000000000000000000000/confirmations/export.xlsx').set('Authorization', `Bearer ${adminJwt()}`);
    expect(res.status).toBe(404);
  });

  test('requires admin/finance auth', async () => {
    const lot = await createLotWithLedger('March 2026', [
      { customer_id: 'TEST_A', document_number: 'I1', document_type: 'INVOICE', document_date: '2026-03-01', amount: 1000, status: 'OPEN' },
    ]);
    const res = await request(app).get(`/api/lots/${lot._id}/confirmations/export.xlsx`);
    expect(res.status).toBe(401);
  });
});
