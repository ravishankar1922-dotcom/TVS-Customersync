const request = require('supertest');
const XLSX = require('xlsx');
const app = require('../../src/server');
const fakeModels = require('../helpers/models/index');
const { resetAllModels } = fakeModels;
const { adminJwt, seedAdmin } = require('../helpers/seed');

beforeEach(() => resetAllModels());

function buildLedgerXlsx(rows) {
  // rows: [{customer_id, document_number, document_type, document_date, amount, status}]
  const header = ['customer_id', 'document_number', 'document_type', 'document_date', 'amount', 'status'];
  const data = [header, ...rows.map(r => [r.customer_id, r.document_number, r.document_type, r.document_date, r.amount, r.status])];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Ledger');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('POST /api/lots — Lot creation (period-first flow, spec section 2)', () => {
  test('creates a Lot from a period and generates a lot_number', async () => {
    const res = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026' });
    expect(res.status).toBe(200);
    expect(res.body.lot.lot_number).toBe('LOT-2026-03-001');
    expect(res.body.lot.period_label).toBe('March 2026');
    expect(res.body.lot.status).toBe('DRAFT');
  });

  test('sequential Lot numbers for the same period (spec: LOT-2026-03-001, -002, -003)', async () => {
    const r1 = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026' });
    const r2 = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026' });
    const r3 = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: '2026-03' }); // same period, different input format
    expect([r1, r2, r3].map(r => r.body.lot.lot_number)).toEqual(['LOT-2026-03-001', 'LOT-2026-03-002', 'LOT-2026-03-003']);
  });

  test('a different period starts its own sequence at 001', async () => {
    await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026' });
    const r = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'June 2026' });
    expect(r.body.lot.lot_number).toBe('LOT-2026-06-001');
  });

  test('rejects an invalid/missing period', async () => {
    const res = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({});
    expect(res.status).toBe(400);
  });

  test('requires admin auth', async () => {
    const res = await request(app).post('/api/lots').send({ period: 'March 2026' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/lots/:lotId/ledger/upload — Lot population comes ONLY from the uploaded ledger (spec section 4)', () => {
  test('only customers present in the uploaded ledger become the Lot population', async () => {
    const createRes = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026' });
    const lotId = createRes.body.lot._id;

    const buf = buildLedgerXlsx([
      { customer_id: 'TEST_C001', document_number: 'INV1', document_type: 'INVOICE', document_date: '2026-01-01', amount: 1000, status: 'OPEN' },
      { customer_id: 'TEST_C002', document_number: 'INV2', document_type: 'INVOICE', document_date: '2026-01-02', amount: 2000, status: 'OPEN' },
      { customer_id: 'TEST_C002', document_number: 'INV3', document_type: 'INVOICE', document_date: '2026-01-03', amount: 500, status: 'OPEN' },
    ]);

    const uploadRes = await request(app).post(`/api/lots/${lotId}/ledger/upload`).set('Authorization', `Bearer ${adminJwt()}`).attach('ledger_file', buf, 'ledger.xlsx');
    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.population_count).toBe(2);
    expect(uploadRes.body.lot.status).toBe('ACTIVE'); // DRAFT -> ACTIVE on first ledger upload
    expect(uploadRes.body.lot.total_ledger_balance).toBe(3500);

    const popRes = await request(app).get(`/api/lots/${lotId}/population`).set('Authorization', `Bearer ${adminJwt()}`);
    const ids = popRes.body.population.map(p => p.customer_id).sort();
    expect(ids).toEqual(['TEST_C001', 'TEST_C002']);
    expect(popRes.body.total).toBe(2); // NOT the full Customer master
  });

  test('a customer NOT in the uploaded ledger never appears in this Lot, even if seeded in the global Customer master', async () => {
    await fakeModels.Customer.create({ customer_id: 'TEST_MASTER_ONLY', customer_name: 'Never Uploaded', pan: 'ABCDE1234F' });
    const createRes = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026' });
    const lotId = createRes.body.lot._id;
    const buf = buildLedgerXlsx([{ customer_id: 'TEST_C001', document_number: 'INV1', document_type: 'INVOICE', document_date: '2026-01-01', amount: 1000, status: 'OPEN' }]);
    await request(app).post(`/api/lots/${lotId}/ledger/upload`).set('Authorization', `Bearer ${adminJwt()}`).attach('ledger_file', buf, 'ledger.xlsx');

    const popRes = await request(app).get(`/api/lots/${lotId}/population`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(popRes.body.population.map(p => p.customer_id)).not.toContain('TEST_MASTER_ONLY');
  });

  test('LOT ISOLATION: the same customer in two different Lots gets two independent LedgerEntry documents, never merged/overwritten (spec sections 1 & 3)', async () => {
    const lot1 = (await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026' })).body.lot;
    const lot2 = (await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'June 2026' })).body.lot;

    const marchBuf = buildLedgerXlsx([{ customer_id: 'TEST_A', document_number: 'MAR-INV1', document_type: 'INVOICE', document_date: '2026-03-01', amount: 10000, status: 'OPEN' }]);
    const juneBuf = buildLedgerXlsx([
      { customer_id: 'TEST_A', document_number: 'JUN-INV1', document_type: 'INVOICE', document_date: '2026-06-01', amount: 99999, status: 'OPEN' },
      { customer_id: 'TEST_D', document_number: 'JUN-INV2', document_type: 'INVOICE', document_date: '2026-06-02', amount: 5000, status: 'OPEN' },
    ]);

    await request(app).post(`/api/lots/${lot1._id}/ledger/upload`).set('Authorization', `Bearer ${adminJwt()}`).attach('ledger_file', marchBuf, 'march.xlsx');
    await request(app).post(`/api/lots/${lot2._id}/ledger/upload`).set('Authorization', `Bearer ${adminJwt()}`).attach('ledger_file', juneBuf, 'june.xlsx');

    // Lot 1 (March) population: only TEST_A, balance unaffected by June's upload
    const pop1 = await request(app).get(`/api/lots/${lot1._id}/population`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(pop1.body.population.map(p => p.customer_id)).toEqual(['TEST_A']);
    expect(pop1.body.population[0].opening_balance).toBe(10000); // NOT overwritten by June's 99999

    // Lot 2 (June) population: TEST_A and TEST_D, TEST_A's June balance is independent of March's
    const pop2 = await request(app).get(`/api/lots/${lot2._id}/population`).set('Authorization', `Bearer ${adminJwt()}`);
    const byId = Object.fromEntries(pop2.body.population.map(p => [p.customer_id, p]));
    expect(Object.keys(byId).sort()).toEqual(['TEST_A', 'TEST_D']);
    expect(byId.TEST_A.opening_balance).toBe(99999);

    // The underlying LedgerEntry docs are genuinely two separate documents
    const ledgerA_lot1 = await fakeModels.LedgerEntry.findOne({ lot_id: lot1._id, customer_id: 'TEST_A' });
    const ledgerA_lot2 = await fakeModels.LedgerEntry.findOne({ lot_id: lot2._id, customer_id: 'TEST_A' });
    expect(ledgerA_lot1.transactions[0].document_number).toBe('MAR-INV1');
    expect(ledgerA_lot2.transactions[0].document_number).toBe('JUN-INV1');
  });

  test('a ledger with no recognisable customer identifier column is rejected rather than silently creating an empty/garbage Lot', async () => {
    const createRes = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026' });
    const lotId = createRes.body.lot._id;
    const ws = XLSX.utils.aoa_to_sheet([['foo', 'bar'], ['a', 'b']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const res = await request(app).post(`/api/lots/${lotId}/ledger/upload`).set('Authorization', `Bearer ${adminJwt()}`).attach('ledger_file', buf, 'bad.xlsx');
    expect(res.status).toBe(400);
  });

  test('404 on an unknown Lot id', async () => {
    const res = await request(app).get('/api/lots/000000000000000000000000').set('Authorization', `Bearer ${adminJwt()}`);
    expect(res.status).toBe(404);
  });
});
