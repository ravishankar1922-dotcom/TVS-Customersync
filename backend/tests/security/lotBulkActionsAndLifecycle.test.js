const request = require('supertest');
const XLSX = require('xlsx');
const app = require('../../src/server');
const fakeModels = require('../helpers/models/index');
const { resetAllModels } = fakeModels;
const { adminJwt, seedAdmin, seedCustomer } = require('../helpers/seed');

beforeEach(() => resetAllModels());

function buildLedgerXlsx(rows) {
  const header = ['customer_id', 'document_number', 'document_type', 'document_date', 'amount', 'status'];
  const data = [header, ...rows.map(r => [r.customer_id, r.document_number, r.document_type, r.document_date, r.amount, r.status])];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Ledger');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function createLotWithPopulation() {
  await seedCustomer({ customer_id: 'TEST_C001', customer_name: 'TEST Customer One', email: 'c1@example.test' });
  await seedCustomer({ customer_id: 'TEST_C002', customer_name: 'TEST Customer Two', email: 'c2@example.test' });
  const createRes = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026', remarks: 'Test batch' });
  const lot = createRes.body.lot;
  const buf = buildLedgerXlsx([
    { customer_id: 'TEST_C001', document_number: 'INV1', document_type: 'INVOICE', document_date: '2026-01-01', amount: 1000, status: 'OPEN' },
    { customer_id: 'TEST_C002', document_number: 'INV2', document_type: 'INVOICE', document_date: '2026-01-02', amount: 2000, status: 'OPEN' },
  ]);
  await request(app).post(`/api/lots/${lot._id}/ledger/upload`).set('Authorization', `Bearer ${adminJwt()}`).attach('ledger_file', buf, 'ledger.xlsx');
  return lot;
}

describe('Lot remarks (create + patch)', () => {
  test('remarks supplied at creation are stored', async () => {
    const res = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026', remarks: 'Re-run — corrected opening balances' });
    expect(res.status).toBe(200);
    expect(res.body.lot.remarks).toBe('Re-run — corrected opening balances');
  });

  test('PATCH updates remarks post-creation', async () => {
    const createRes = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026' });
    const lotId = createRes.body.lot._id;
    const patchRes = await request(app).patch(`/api/lots/${lotId}`).set('Authorization', `Bearer ${adminJwt()}`).send({ remarks: 'Updated reference note' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.lot.remarks).toBe('Updated reference note');
  });
});

describe('DELETE /api/lots/:lotId — DRAFT-only deletion', () => {
  test('deletes a DRAFT Lot', async () => {
    const createRes = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026' });
    const lotId = createRes.body.lot._id;
    const delRes = await request(app).delete(`/api/lots/${lotId}`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(delRes.status).toBe(200);
    const getRes = await request(app).get(`/api/lots/${lotId}`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(getRes.status).toBe(404);
  });

  test('refuses to delete an ACTIVE Lot (one with a ledger already uploaded)', async () => {
    const lot = await createLotWithPopulation();
    const delRes = await request(app).delete(`/api/lots/${lot._id}`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(delRes.status).toBe(400);
    const getRes = await request(app).get(`/api/lots/${lot._id}`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(getRes.status).toBe(200);
  });

  test('requires admin auth', async () => {
    const createRes = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026' });
    const lotId = createRes.body.lot._id;
    const res = await request(app).delete(`/api/lots/${lotId}`);
    expect(res.status).toBe(401);
  });
});

describe('Lot-scoped bulk actions (item 4 — every button asks for a Lot first)', () => {
  test('POST /:lotId/tokens/reset-expired only touches this Lot\'s tokens', async () => {
    const lot1 = await createLotWithPopulation();
    // A second Lot with its own token, deliberately expired, to prove isolation.
    const lot2Res = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'June 2026' });
    const lot2 = lot2Res.body.lot;
    const buf = buildLedgerXlsx([{ customer_id: 'TEST_C001', document_number: 'JUN1', document_type: 'INVOICE', document_date: '2026-06-01', amount: 500, status: 'OPEN' }]);
    await request(app).post(`/api/lots/${lot2._id}/ledger/upload`).set('Authorization', `Bearer ${adminJwt()}`).attach('ledger_file', buf, 'june.xlsx');

    await fakeModels.TokenRecord.create({ token_id: 'tok_lot1_expired', customer_id: 'TEST_C001', lot_id: lot1._id, cycle_id: lot1.lot_number, status: 'ACTIVE', expires_at: new Date(Date.now() - 1000), token: 'x', portal_url: 'http://x' });
    await fakeModels.TokenRecord.create({ token_id: 'tok_lot2_expired', customer_id: 'TEST_C001', lot_id: lot2._id, cycle_id: lot2.lot_number, status: 'ACTIVE', expires_at: new Date(Date.now() - 1000), token: 'y', portal_url: 'http://y' });

    const res = await request(app).post(`/api/lots/${lot1._id}/tokens/reset-expired`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(res.status).toBe(200);
    expect(res.body.reset).toBe(1);

    const t1 = await fakeModels.TokenRecord.findOne({ token_id: 'tok_lot1_expired' });
    const t2 = await fakeModels.TokenRecord.findOne({ token_id: 'tok_lot2_expired' });
    expect(t1.status).toBe('EXPIRED');
    expect(t2.status).toBe('ACTIVE'); // untouched — belongs to a different Lot
  });

  test('POST /:lotId/emails/remind-pending only reminds non-responders within this Lot', async () => {
    const lot = await createLotWithPopulation();
    // TEST_C001 already submitted a confirmation for this Lot — should be skipped.
    await fakeModels.Confirmation.create({ lot_id: lot._id, customer_id: 'TEST_C001', cycle_id: lot.lot_number, sap_balance: 1000, cust_balance: 1000, status: 'MATCHED' });

    const res = await request(app).post(`/api/lots/${lot._id}/emails/remind-pending`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.results[0].customer_id).toBe('TEST_C002');
  });

  test('remind-pending reports "no reminders needed" once everyone in the Lot has responded', async () => {
    const lot = await createLotWithPopulation();
    await fakeModels.Confirmation.create({ lot_id: lot._id, customer_id: 'TEST_C001', cycle_id: lot.lot_number, sap_balance: 1000, cust_balance: 1000, status: 'MATCHED' });
    await fakeModels.Confirmation.create({ lot_id: lot._id, customer_id: 'TEST_C002', cycle_id: lot.lot_number, sap_balance: 2000, cust_balance: 2000, status: 'MATCHED' });

    const res = await request(app).post(`/api/lots/${lot._id}/emails/remind-pending`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  test('GET /:lotId/emails/outlook-script generates a .ps1 scoped to this Lot\'s population', async () => {
    const lot = await createLotWithPopulation();
    const res = await request(app).get(`/api/lots/${lot._id}/emails/outlook-script`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain(lot.lot_number);
    const text = res.text || res.body.toString('utf8');
    expect(text).toContain(lot.lot_number);
  });

  test('outlook-script 404s when the Lot has no population yet', async () => {
    const createRes = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026' });
    const lotId = createRes.body.lot._id;
    const res = await request(app).get(`/api/lots/${lotId}/emails/outlook-script`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(res.status).toBe(404);
  });

  test('all three bulk actions require admin auth', async () => {
    const lot = await createLotWithPopulation();
    const r1 = await request(app).post(`/api/lots/${lot._id}/tokens/reset-expired`);
    const r2 = await request(app).post(`/api/lots/${lot._id}/emails/remind-pending`);
    const r3 = await request(app).get(`/api/lots/${lot._id}/emails/outlook-script`);
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    expect(r3.status).toBe(401);
  });

  test('GET /api/lots/summary — all-Lots totals when no lot_id given', async () => {
    const lot = await createLotWithPopulation();
    await fakeModels.Confirmation.create({ lot_id: lot._id, customer_id: 'TEST_C001', cycle_id: lot.lot_number, sap_balance: 1000, cust_balance: 1000, status: 'MATCHED' });
    await fakeModels.Confirmation.create({ lot_id: lot._id, customer_id: 'TEST_C002', cycle_id: lot.lot_number, sap_balance: 2000, cust_balance: 2500, status: 'DIFFERENCE', difference: 500 });

    const res = await request(app).get('/api/lots/summary').set('Authorization', `Bearer ${adminJwt()}`);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('all');
    expect(res.body.total_population).toBe(2);
    expect(res.body.matched).toBe(1);
    expect(res.body.difference).toBe(1);
    expect(res.body.pending).toBe(0);
  });

  test('GET /api/lots/summary?lot_id= — scoped to one Lot only', async () => {
    const lot1 = await createLotWithPopulation();
    const lot2Res = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'June 2026' });
    const lot2 = lot2Res.body.lot;
    const buf = buildLedgerXlsx([{ customer_id: 'TEST_C001', document_number: 'JUN1', document_type: 'INVOICE', document_date: '2026-06-01', amount: 500, status: 'OPEN' }]);
    await request(app).post(`/api/lots/${lot2._id}/ledger/upload`).set('Authorization', `Bearer ${adminJwt()}`).attach('ledger_file', buf, 'june.xlsx');

    const res = await request(app).get(`/api/lots/summary?lot_id=${lot1._id}`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('lot');
    expect(res.body.lot_count).toBe(1);
    expect(res.body.total_population).toBe(2); // only lot1's population, not lot2's
  });

  test('404 on an unknown Lot id for each bulk action', async () => {
    const unknown = '000000000000000000000000';
    const r1 = await request(app).post(`/api/lots/${unknown}/tokens/reset-expired`).set('Authorization', `Bearer ${adminJwt()}`);
    const r2 = await request(app).post(`/api/lots/${unknown}/emails/remind-pending`).set('Authorization', `Bearer ${adminJwt()}`);
    const r3 = await request(app).get(`/api/lots/${unknown}/emails/outlook-script`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
    expect(r3.status).toBe(404);
  });
});
