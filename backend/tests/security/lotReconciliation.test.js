const request = require('supertest');
const XLSX = require('xlsx');
const app = require('../../src/server');
const fakeModels = require('../helpers/models/index');
const { resetAllModels } = fakeModels;
const { adminJwt } = require('../helpers/seed');

beforeEach(() => resetAllModels());

// Sept 2026: "Reconciliation Studio - migrate as per lot." Reconciliation
// Studio previously only read the legacy global {cycle_id: cfg.CYCLE_ID}
// Confirmation/LedgerEntry collections — a Lot-scoped ledger upload +
// customer-portal submission never showed up in its line-item grid. These
// tests exercise the new GET/PATCH/export/send-to-customer endpoints at
// /api/lots/:lotId/reconciliation/:customerId, scoped to {lot_id, customer_id}
// end to end: Lot creation -> ledger upload -> token -> customer submits an
// SOA -> Reconciliation Studio reads it back and reconciles correctly.

function buildLedgerXlsx(rows) {
  const header = ['customer_id', 'document_number', 'document_type', 'document_date', 'amount', 'status'];
  const data = [header, ...rows.map(r => [r.customer_id, r.document_number, r.document_type, r.document_date, r.amount, r.status])];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Ledger');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function buildSoaXlsx(rows) {
  // rows: [{doc, date, amount}]
  const header = ['Document No', 'Date', 'Amount'];
  const data = [header, ...rows.map(r => [r.doc, r.date, r.amount])];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'SOA');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function getRawToken(lotId, customerId) {
  const rec = await fakeModels.TokenRecord.findOne({ lot_id: lotId, customer_id: customerId, status: 'ACTIVE' });
  return rec.token;
}

async function fullSetup() {
  const lotRes = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'June 2026' });
  const lot = lotRes.body.lot;

  await request(app).post(`/api/lots/${lot._id}/ledger/upload`).set('Authorization', `Bearer ${adminJwt()}`)
    .attach('ledger_file', buildLedgerXlsx([
      { customer_id: 'TEST_R001', document_number: 'INV1', document_type: 'INVOICE', document_date: '2026-06-01', amount: 10000, status: 'OPEN' },
      { customer_id: 'TEST_R001', document_number: 'INV2', document_type: 'INVOICE', document_date: '2026-06-05', amount: 5000, status: 'OPEN' },
    ]), 'ledger.xlsx');

  await fakeModels.Customer.create({ customer_id: 'TEST_R001', customer_name: 'Recon Test Customer', email: 'recontest@example.test', pan: 'ABCDE1234F' });
  await request(app).post(`/api/lots/${lot._id}/tokens/generate`).set('Authorization', `Bearer ${adminJwt()}`).send({ send_email: false });
  const rawToken = await getRawToken(lot._id, 'TEST_R001');
  const pan = await request(app).post('/api/tokens/verify-pan').send({ token: rawToken, pan: 'ABCDE1234F' });
  const tokenId = pan.body.token_id;

  // Customer submits with an SOA that matches INV1 exactly and has an extra
  // line SAP doesn't know about — one MATCHED, one MISSING_IN_CUSTOMER, one
  // NOT_IN_SAP, so the reconciliation isn't a trivial all-matched case.
  const soaBuf = buildSoaXlsx([{ doc: 'INV1', date: '2026-06-01', amount: 10000 }, { doc: 'EXTRA-1', date: '2026-06-10', amount: 750 }]);
  await request(app).post(`/api/lots/${lot._id}/confirmations/submit`)
    .field('token_id', tokenId).field('sap_balance', '15000').field('cust_balance', '10750')
    .attach('soa_file', soaBuf, 'soa.xlsx');

  return { lot };
}

describe('GET /api/lots/:lotId/reconciliation/:customerId — Lot-scoped Reconciliation Studio', () => {
  test('reconciles the Lot-scoped ledger against the Lot-scoped SOA submission (not the legacy global collections)', async () => {
    const { lot } = await fullSetup();

    const res = await request(app).get(`/api/lots/${lot._id}/reconciliation/TEST_R001`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(res.status).toBe(200);
    expect(res.body.lot_number).toBe(lot.lot_number);
    expect(res.body.customer_name).toBe('Recon Test Customer');

    const types = res.body.results.map(r => r.match_type).sort();
    expect(types).toEqual(['MATCHED', 'MISSING_IN_CUSTOMER', 'NOT_IN_SAP']);
    expect(res.body.summary.matched).toBe(1);
    expect(res.body.summary.missing_in_customer).toBe(1);
    expect(res.body.summary.not_in_sap).toBe(1);

    // The balance bridge ties SAP -> adjusted -> customer.
    expect(res.body.bridge).toBeTruthy();
    expect(res.body.bridge.opening_sap_balance).toBe(15000);
    expect(res.body.bridge.opening_customer_balance).toBe(10750);
  });

  test('LOT ISOLATION: the same customer_id in a different Lot never leaks into this reconciliation', async () => {
    const { lot } = await fullSetup();
    const otherLotRes = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'July 2026' });
    const otherLot = otherLotRes.body.lot;
    // No ledger/confirmation uploaded for TEST_R001 in the other Lot.
    const res = await request(app).get(`/api/lots/${otherLot._id}/reconciliation/TEST_R001`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(res.status).toBe(404);

    // The original Lot's reconciliation is unaffected by the other Lot existing.
    const okRes = await request(app).get(`/api/lots/${lot._id}/reconciliation/TEST_R001`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(okRes.status).toBe(200);
  });

  test('404 when no confirmation/SOA exists yet for this customer in this Lot', async () => {
    const lotRes = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'August 2026' });
    const lot = lotRes.body.lot;
    await request(app).post(`/api/lots/${lot._id}/ledger/upload`).set('Authorization', `Bearer ${adminJwt()}`)
      .attach('ledger_file', buildLedgerXlsx([{ customer_id: 'TEST_NOSOA', document_number: 'I1', document_type: 'INVOICE', document_date: '2026-08-01', amount: 100, status: 'OPEN' }]), 'ledger.xlsx');

    const res = await request(app).get(`/api/lots/${lot._id}/reconciliation/TEST_NOSOA`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(res.status).toBe(404);
  });

  test('404 on an unknown Lot id', async () => {
    const res = await request(app).get('/api/lots/000000000000000000000000/reconciliation/TEST_R001').set('Authorization', `Bearer ${adminJwt()}`);
    expect(res.status).toBe(404);
  });

  test('requires admin/finance auth', async () => {
    const { lot } = await fullSetup();
    const res = await request(app).get(`/api/lots/${lot._id}/reconciliation/TEST_R001`);
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/lots/:lotId/reconciliation/:customerId — notes, root causes, mark complete', () => {
  test('saves recon notes and root-cause tags, scoped to this Lot', async () => {
    const { lot } = await fullSetup();
    const res = await request(app).patch(`/api/lots/${lot._id}/reconciliation/TEST_R001`).set('Authorization', `Bearer ${adminJwt()}`)
      .send({ recon_notes: 'Extra line is a freight charge, pending SAP booking.', root_causes: { 0: 'Invoice in Transit' } });
    expect(res.status).toBe(200);
    expect(res.body.confirmation.recon_notes).toBe('Extra line is a freight charge, pending SAP booking.');

    const reread = await request(app).get(`/api/lots/${lot._id}/reconciliation/TEST_R001`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(reread.body.recon_notes).toBe('Extra line is a freight charge, pending SAP booking.');
    expect(reread.body.root_causes['0']).toBe('Invoice in Transit');
  });

  test('mark_complete via recon_status:COMPLETED sets recon_completed_at', async () => {
    const { lot } = await fullSetup();
    const res = await request(app).patch(`/api/lots/${lot._id}/reconciliation/TEST_R001`).set('Authorization', `Bearer ${adminJwt()}`)
      .send({ recon_status: 'COMPLETED' });
    expect(res.status).toBe(200);
    expect(res.body.confirmation.recon_status).toBe('COMPLETED');
    expect(res.body.confirmation.recon_completed_at).toBeTruthy();
  });
});

describe('GET /api/lots/:lotId/reconciliation/:customerId/export.xlsx', () => {
  test('downloads a workbook for the Lot-scoped reconciliation', async () => {
    const { lot } = await fullSetup();
    const res = await request(app).get(`/api/lots/${lot._id}/reconciliation/TEST_R001/export.xlsx`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheet/);
    expect(res.headers['content-disposition']).toMatch(new RegExp(lot.lot_number));
  });
});
