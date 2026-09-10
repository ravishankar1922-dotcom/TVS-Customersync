const request = require('supertest');
const XLSX = require('xlsx');
const app = require('../../src/server');
const fakeModels = require('../helpers/models/index');
const { resetAllModels } = fakeModels;
const { adminJwt } = require('../helpers/seed');

beforeEach(() => resetAllModels());

function buildLedgerXlsx(rows) {
  const header = ['customer_id', 'document_number', 'document_type', 'document_date', 'amount', 'status'];
  const data = [header, ...rows.map(r => [r.customer_id, r.document_number, r.document_type, r.document_date, r.amount, r.status])];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Ledger');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function createLotWithLedger(period, rows) {
  const lotRes = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period });
  const lot = lotRes.body.lot;
  await request(app).post(`/api/lots/${lot._id}/ledger/upload`).set('Authorization', `Bearer ${adminJwt()}`).attach('ledger_file', buildLedgerXlsx(rows), 'ledger.xlsx');
  return lot;
}

// Pulls a token out of the fake TokenRecord store by customer_id+lot_id —
// simulates "the customer clicks the emailed link" without needing real SMTP.
async function getRawToken(lotId, customerId) {
  const rec = await fakeModels.TokenRecord.findOne({ lot_id: lotId, customer_id: customerId, status: 'ACTIVE' });
  return rec.token;
}

describe('POST /api/lots/:lotId/tokens/generate — balance filter + targeted send (spec)', () => {
  test('balance filter selects only qualifying customers from the Lot population', async () => {
    const lot = await createLotWithLedger('March 2026', [
      { customer_id: 'TEST_LOW', document_number: 'I1', document_type: 'INVOICE', document_date: '2026-01-01', amount: 500, status: 'OPEN' },
      { customer_id: 'TEST_MID', document_number: 'I2', document_type: 'INVOICE', document_date: '2026-01-01', amount: 5000, status: 'OPEN' },
      { customer_id: 'TEST_HIGH', document_number: 'I3', document_type: 'INVOICE', document_date: '2026-01-01', amount: 50000, status: 'OPEN' },
    ]);

    const res = await request(app).post(`/api/lots/${lot._id}/tokens/generate`)
      .set('Authorization', `Bearer ${adminJwt()}`)
      .send({ balance_filter: { op: 'gte', value: 5000 }, send_email: false });

    expect(res.status).toBe(200);
    expect(res.body.generated).toBe(2);
    expect(res.body.tokens.map(t => t.customer_id).sort()).toEqual(['TEST_HIGH', 'TEST_MID']);
  });

  test('explicit customer_ids selection sends only to those customers (targeted send)', async () => {
    const lot = await createLotWithLedger('March 2026', [
      { customer_id: 'TEST_A', document_number: 'I1', document_type: 'INVOICE', document_date: '2026-01-01', amount: 1000, status: 'OPEN' },
      { customer_id: 'TEST_B', document_number: 'I2', document_type: 'INVOICE', document_date: '2026-01-01', amount: 2000, status: 'OPEN' },
      { customer_id: 'TEST_C', document_number: 'I3', document_type: 'INVOICE', document_date: '2026-01-01', amount: 3000, status: 'OPEN' },
    ]);

    const res = await request(app).post(`/api/lots/${lot._id}/tokens/generate`)
      .set('Authorization', `Bearer ${adminJwt()}`)
      .send({ customer_ids: ['TEST_B'], send_email: false });

    expect(res.status).toBe(200);
    expect(res.body.generated).toBe(1);
    expect(res.body.tokens[0].customer_id).toBe('TEST_B');

    // No TokenRecord was ever created for TEST_A/TEST_C in this Lot.
    const others = await fakeModels.TokenRecord.find({ lot_id: lot._id, customer_id: { $in: ['TEST_A', 'TEST_C'] } });
    expect(others.length).toBe(0);
  });

  test('zero/negative/positive/between shortcuts work', async () => {
    const lot = await createLotWithLedger('March 2026', [
      { customer_id: 'TEST_ZERO', document_number: 'I1', document_type: 'CREDIT', document_date: '2026-01-01', amount: 100, status: 'OPEN' },
      { customer_id: 'TEST_ZERO', document_number: 'I2', document_type: 'INVOICE', document_date: '2026-01-01', amount: -100, status: 'OPEN' },
      { customer_id: 'TEST_NEG', document_number: 'I3', document_type: 'CREDIT', document_date: '2026-01-01', amount: -500, status: 'OPEN' },
      { customer_id: 'TEST_BETWEEN', document_number: 'I4', document_type: 'INVOICE', document_date: '2026-01-01', amount: 750, status: 'OPEN' },
    ]);
    const between = await request(app).post(`/api/lots/${lot._id}/tokens/generate`).set('Authorization', `Bearer ${adminJwt()}`).send({ balance_filter: { op: 'between', value: 500, value2: 1000 }, send_email: false });
    expect(between.body.tokens.map(t => t.customer_id)).toEqual(['TEST_BETWEEN']);

    const neg = await request(app).post(`/api/lots/${lot._id}/tokens/generate`).set('Authorization', `Bearer ${adminJwt()}`).send({ balance_filter: { op: 'negative' }, send_email: false });
    expect(neg.body.tokens.map(t => t.customer_id)).toEqual(['TEST_NEG']);
  });

  test('404 when the filter/selection matches nobody', async () => {
    const lot = await createLotWithLedger('March 2026', [{ customer_id: 'TEST_A', document_number: 'I1', document_type: 'INVOICE', document_date: '2026-01-01', amount: 100, status: 'OPEN' }]);
    const res = await request(app).post(`/api/lots/${lot._id}/tokens/generate`).set('Authorization', `Bearer ${adminJwt()}`).send({ balance_filter: { op: 'gte', value: 999999 } });
    expect(res.status).toBe(404);
  });

  test('requires admin auth', async () => {
    const lot = await createLotWithLedger('March 2026', [{ customer_id: 'TEST_A', document_number: 'I1', document_type: 'INVOICE', document_date: '2026-01-01', amount: 100, status: 'OPEN' }]);
    const res = await request(app).post(`/api/lots/${lot._id}/tokens/generate`).send({});
    expect(res.status).toBe(401);
  });
});

describe('Customer portal flow, Lot-aware — reopen/amend/resubmit (CRITICAL spec change: no single-use blocking)', () => {
  async function setup() {
    const lot = await createLotWithLedger('March 2026', [{ customer_id: 'TEST_C001', document_number: 'I1', document_type: 'INVOICE', document_date: '2026-01-01', amount: 10000, status: 'OPEN' }]);
    await fakeModels.Customer.create({ customer_id: 'TEST_C001', customer_name: 'TEST Customer One', email: 'test@example.test', pan: 'ABCDE1234F' });
    await request(app).post(`/api/lots/${lot._id}/tokens/generate`).set('Authorization', `Bearer ${adminJwt()}`).send({ send_email: false });
    const rawToken = await getRawToken(lot._id, 'TEST_C001');
    return { lot, rawToken };
  }

  test('validate is Lot-aware and reports the Lot/period', async () => {
    const { lot, rawToken } = await setup();
    const res = await request(app).post('/api/tokens/validate').send({ token: rawToken });
    expect(res.status).toBe(200);
    expect(res.body.lot.lot_number).toBe(lot.lot_number);
    expect(res.body.lot.period_label).toBe('March 2026'); // dynamic, not hardcoded
  });

  test('verify-pan returns the LOT-SCOPED balance, and confirmation submit + reopen + amend preserves full version history', async () => {
    const { lot, rawToken } = await setup();

    const pan = await request(app).post('/api/tokens/verify-pan').send({ token: rawToken, pan: 'ABCDE1234F' });
    expect(pan.status).toBe(200);
    expect(pan.body.sap_balance).toBe(10000);
    expect(pan.body.as_of_date).toBe('March 2026'); // dynamic period, not cfg.AS_OF_DATE

    const tokenRecAfterPan = await fakeModels.TokenRecord.findOne({ token_id: pan.body.token_id });

    // First submission (version 1)
    const submit1 = await request(app).post(`/api/lots/${lot._id}/confirmations/submit`)
      .field('token_id', tokenRecAfterPan.token_id).field('sap_balance', '10000').field('cust_balance', '9000').field('remarks', 'small diff');
    expect(submit1.status).toBe(200);
    expect(submit1.body.version).toBe(1);
    expect(submit1.body.status).toBe('DIFFERENCE');

    // CRITICAL: the token must still be ACTIVE, not USED — link stays reopenable.
    const tokenAfter1 = await fakeModels.TokenRecord.findOne({ token_id: tokenRecAfterPan.token_id });
    expect(tokenAfter1.status).toBe('ACTIVE');

    // Reopen and amend (version 2) — customer changes their balance.
    const submit2 = await request(app).post(`/api/lots/${lot._id}/confirmations/submit`)
      .field('token_id', tokenRecAfterPan.token_id).field('sap_balance', '10000').field('cust_balance', '10000').field('remarks', 'corrected, now matches');
    expect(submit2.status).toBe(200);
    expect(submit2.body.version).toBe(2);
    expect(submit2.body.status).toBe('MATCHED');

    // Token STILL active after a second submission.
    const tokenAfter2 = await fakeModels.TokenRecord.findOne({ token_id: tokenRecAfterPan.token_id });
    expect(tokenAfter2.status).toBe('ACTIVE');

    // The live Confirmation reflects only the LATEST version...
    const confRes = await request(app).get(`/api/lots/${lot._id}/confirmations/TEST_C001`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(confRes.body.confirmation.cust_balance).toBe(10000);
    expect(confRes.body.confirmation.current_version).toBe(2);

    // ...but BOTH versions remain permanently visible in the history — the
    // first submission is never lost or overwritten.
    const versionsRes = await request(app).get(`/api/lots/${lot._id}/confirmations/TEST_C001/versions`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(versionsRes.body.versions.length).toBe(2);
    expect(versionsRes.body.versions[0]).toMatchObject({ version: 1, status: 'SUPERSEDED', cust_balance: 9000, remarks: 'small diff' });
    expect(versionsRes.body.versions[1]).toMatchObject({ version: 2, status: 'CURRENT', cust_balance: 10000 });
  });

  test('an expired Lot-scoped token is rejected on submit', async () => {
    const { lot } = await setup();
    // Force-expire the token directly (simulating time passing).
    const rec = await fakeModels.TokenRecord.findOne({ lot_id: lot._id, customer_id: 'TEST_C001' });
    await fakeModels.TokenRecord.updateOne({ token_id: rec.token_id }, { expires_at: new Date(Date.now() - 1000), pan_verified_at: new Date() });
    const res = await request(app).post(`/api/lots/${lot._id}/confirmations/submit`).field('token_id', rec.token_id).field('sap_balance', '10000').field('cust_balance', '10000');
    expect(res.status).toBe(403);
  });

  test('rejects submit before the PAN gate has been passed', async () => {
    const { lot } = await setup();
    const rec = await fakeModels.TokenRecord.findOne({ lot_id: lot._id, customer_id: 'TEST_C001' });
    const res = await request(app).post(`/api/lots/${lot._id}/confirmations/submit`).field('token_id', rec.token_id).field('sap_balance', '10000').field('cust_balance', '10000');
    expect(res.status).toBe(403);
  });

  test('a token from a DIFFERENT Lot is rejected (cross-Lot IDOR)', async () => {
    const { lot: lot1, rawToken: token1 } = await setup();
    const lot2 = await createLotWithLedger('June 2026', [{ customer_id: 'TEST_C001', document_number: 'I1', document_type: 'INVOICE', document_date: '2026-06-01', amount: 99999, status: 'OPEN' }]);

    const pan = await request(app).post('/api/tokens/verify-pan').send({ token: token1, pan: 'ABCDE1234F' });
    // Try to submit lot1's token against lot2's submit endpoint.
    const res = await request(app).post(`/api/lots/${lot2._id}/confirmations/submit`).field('token_id', pan.body.token_id).field('sap_balance', '10000').field('cust_balance', '10000');
    expect(res.status).toBe(403);
  });
});

describe('CROSS-LOT ISOLATION — same customer, two Lots, fully independent confirmation histories', () => {
  test('submitting in Lot A never touches Lot B\'s confirmation/version data for the same customer', async () => {
    await fakeModels.Customer.create({ customer_id: 'TEST_DUAL', customer_name: 'TEST Dual', email: 'dual@example.test', pan: 'ABCDE1234F' });

    const lotA = await createLotWithLedger('March 2026', [{ customer_id: 'TEST_DUAL', document_number: 'MA1', document_type: 'INVOICE', document_date: '2026-03-01', amount: 1000, status: 'OPEN' }]);
    const lotB = await createLotWithLedger('June 2026', [{ customer_id: 'TEST_DUAL', document_number: 'JB1', document_type: 'INVOICE', document_date: '2026-06-01', amount: 2000, status: 'OPEN' }]);

    await request(app).post(`/api/lots/${lotA._id}/tokens/generate`).set('Authorization', `Bearer ${adminJwt()}`).send({ send_email: false });
    const rawTokenA = await getRawToken(lotA._id, 'TEST_DUAL');
    const panA = await request(app).post('/api/tokens/verify-pan').send({ token: rawTokenA, pan: 'ABCDE1234F' });
    expect(panA.body.sap_balance).toBe(1000); // Lot A's own balance, not Lot B's

    await request(app).post(`/api/lots/${lotA._id}/confirmations/submit`).field('token_id', panA.body.token_id).field('sap_balance', '1000').field('cust_balance', '1000');

    // Lot B has NO confirmation for this customer — untouched by Lot A's submit.
    const confB = await request(app).get(`/api/lots/${lotB._id}/confirmations/TEST_DUAL`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(confB.status).toBe(404);

    // Lot A's confirmation exists and is exactly what was submitted.
    const confA = await request(app).get(`/api/lots/${lotA._id}/confirmations/TEST_DUAL`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(confA.status).toBe(200);
    expect(confA.body.confirmation.cust_balance).toBe(1000);

    // Now respond in Lot B independently, with a totally different balance.
    await request(app).post(`/api/lots/${lotB._id}/tokens/generate`).set('Authorization', `Bearer ${adminJwt()}`).send({ send_email: false });
    const rawTokenB = await getRawToken(lotB._id, 'TEST_DUAL');
    const panB = await request(app).post('/api/tokens/verify-pan').send({ token: rawTokenB, pan: 'ABCDE1234F' });
    expect(panB.body.sap_balance).toBe(2000);
    await request(app).post(`/api/lots/${lotB._id}/confirmations/submit`).field('token_id', panB.body.token_id).field('sap_balance', '2000').field('cust_balance', '2500');

    // Lot A's confirmation is STILL exactly what it was — Lot B's submit
    // never mutated it.
    const confAAfter = await request(app).get(`/api/lots/${lotA._id}/confirmations/TEST_DUAL`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(confAAfter.body.confirmation.cust_balance).toBe(1000);
    const confBAfter = await request(app).get(`/api/lots/${lotB._id}/confirmations/TEST_DUAL`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(confBAfter.body.confirmation.cust_balance).toBe(2500);

    // Version histories are separate collections of ONE row each, never merged.
    const versionsA = await request(app).get(`/api/lots/${lotA._id}/confirmations/TEST_DUAL/versions`).set('Authorization', `Bearer ${adminJwt()}`);
    const versionsB = await request(app).get(`/api/lots/${lotB._id}/confirmations/TEST_DUAL/versions`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(versionsA.body.versions.length).toBe(1);
    expect(versionsB.body.versions.length).toBe(1);
    expect(versionsA.body.versions[0].cust_balance).toBe(1000);
    expect(versionsB.body.versions[0].cust_balance).toBe(2500);
  });
});

describe('Legacy (non-Lot) flow is completely unaffected by phase 2', () => {
  test('the original /api/confirmations/submit still single-use-blocks exactly as before', async () => {
    const { seedCustomer, seedLedger, seedActiveToken } = require('../helpers/seed');
    await seedCustomer();
    await seedLedger();
    const tok = await seedActiveToken();
    await fakeModels.TokenRecord.updateOne({ token_id: tok.token_id }, { pan_verified_at: new Date() });

    const first = await request(app).post('/api/confirmations/submit').field('customer_id', 'TEST_C001').field('token_id', tok.token_id).field('sap_balance', '15000').field('cust_balance', '15000');
    expect(first.status).toBe(200);
    const second = await request(app).post('/api/confirmations/submit').field('customer_id', 'TEST_C001').field('token_id', tok.token_id).field('sap_balance', '15000').field('cust_balance', '15000');
    expect(second.status).toBe(403); // legacy single-use blocking is UNCHANGED (token no longer ACTIVE after first submit)
  });
});
