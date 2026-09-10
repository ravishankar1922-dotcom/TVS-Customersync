const request = require('supertest');
const XLSX = require('xlsx');
const app = require('../../src/server');
const fakeModels = require('../helpers/models/index');
const { resetAllModels } = fakeModels;
const { adminJwt, financeJwt, seedVendor } = require('../helpers/seed');

beforeEach(() => resetAllModels());

function buildLedgerXlsx(rows) {
  const header = ['customer_id', 'document_number', 'document_type', 'document_date', 'amount', 'status'];
  const data = [header, ...rows.map(r => [r.customer_id, r.document_number, r.document_type, r.document_date, r.amount, r.status])];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Ledger');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('Vendor module — fully separate collection (spec phase 4)', () => {
  test('a Vendor record never appears on /api/customers, and vice versa', async () => {
    await fakeModels.Customer.create({ customer_id: 'TEST_C001', customer_name: 'A Customer', pan: 'ABCDE1234F' });
    await seedVendor();
    const custRes = await request(app).get('/api/customers').set('Authorization', `Bearer ${adminJwt()}`);
    expect(custRes.body.customers.map(c => c.customer_id)).not.toContain('TEST_V001');

    const vendorRes = await request(app).get('/api/vendors').set('Authorization', `Bearer ${adminJwt()}`);
    expect(vendorRes.body.vendors.map(v => v.vendor_id)).toEqual(['TEST_V001']);
    expect(vendorRes.body.vendors.map(v => v.vendor_id)).not.toContain('TEST_C001');
  });

  test('a VENDOR-business-type Lot draws its population display names from Vendor, never Customer', async () => {
    await seedVendor({ vendor_id: 'TEST_V001', vendor_name: 'Vendor Real Name' });
    await fakeModels.Customer.create({ customer_id: 'TEST_V001', customer_name: 'WRONG — this is the Customer master, must never be used', pan: 'ABCDE1234F' });

    const lotRes = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026', business_type: 'VENDOR' });
    const lotId = lotRes.body.lot._id;
    const buf = buildLedgerXlsx([{ customer_id: 'TEST_V001', document_number: 'PO1', document_type: 'INVOICE', document_date: '2026-01-01', amount: 1000, status: 'OPEN' }]);
    await request(app).post(`/api/lots/${lotId}/ledger/upload`).set('Authorization', `Bearer ${adminJwt()}`).attach('ledger_file', buf, 'ledger.xlsx');

    const pop = await request(app).get(`/api/lots/${lotId}/population`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(pop.body.population[0].customer_name).toBe('Vendor Real Name');
  });

  test('vendor import-json validates required fields and supports dry run', async () => {
    const bad = await request(app).post('/api/vendors/import-json').set('Authorization', `Bearer ${adminJwt()}`).send({ vendors: [{ vendor_id: 'X' }] });
    expect(bad.status).toBe(400);

    const dry = await request(app).post('/api/vendors/import-json').set('Authorization', `Bearer ${adminJwt()}`)
      .send({ vendors: [{ vendor_id: 'TEST_V002', vendor_name: 'V2', pan: 'ABCDE1234F' }], dryRun: true });
    expect(dry.body.would_upsert).toBe(1);
    const check = await request(app).get('/api/vendors').set('Authorization', `Bearer ${adminJwt()}`);
    expect(check.body.vendors.length).toBe(0); // dry run wrote nothing
  });
});

describe('Finance role — explicit permission boundaries (spec phase 4/5)', () => {
  test('Finance CANNOT create a Lot (ADMIN-only — no arbitrary system/master-data rights)', async () => {
    const res = await request(app).post('/api/lots').set('Authorization', `Bearer ${financeJwt()}`).send({ period: 'March 2026' });
    expect(res.status).toBe(403);
  });

  test('Finance CANNOT upload a Lot ledger', async () => {
    const lot = (await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026' })).body.lot;
    const buf = buildLedgerXlsx([{ customer_id: 'TEST_A', document_number: 'I1', document_type: 'INVOICE', document_date: '2026-01-01', amount: 100, status: 'OPEN' }]);
    const res = await request(app).post(`/api/lots/${lot._id}/ledger/upload`).set('Authorization', `Bearer ${financeJwt()}`).attach('ledger_file', buf, 'l.xlsx');
    expect(res.status).toBe(403);
  });

  test('Finance CANNOT generate confirmation tokens (arbitrary token generation stays ADMIN-only)', async () => {
    const lot = (await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026' })).body.lot;
    const res = await request(app).post(`/api/lots/${lot._id}/tokens/generate`).set('Authorization', `Bearer ${financeJwt()}`).send({});
    expect(res.status).toBe(403);
  });

  test('Finance CAN read Lots and confirmations (needs visibility to review)', async () => {
    const res = await request(app).get('/api/lots').set('Authorization', `Bearer ${financeJwt()}`);
    expect(res.status).toBe(200);
  });

  test('ADMIN cannot call the FINANCE-only route-to-admin / route-to-customer actions', async () => {
    const lot = (await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026' })).body.lot;
    const res = await request(app).post(`/api/lots/${lot._id}/confirmations/TEST_A/route-to-admin`).set('Authorization', `Bearer ${adminJwt()}`).send({ comment: 'nope' });
    expect(res.status).toBe(403);
  });

  test('FINANCE cannot call the ADMIN-only route-to-finance action', async () => {
    const lot = (await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026' })).body.lot;
    const res = await request(app).post(`/api/lots/${lot._id}/confirmations/TEST_A/route-to-finance`).set('Authorization', `Bearer ${financeJwt()}`).send({ comment: 'nope' });
    expect(res.status).toBe(403);
  });
});

describe('Finance clarification workflow state machine (spec phase 5)', () => {
  async function setupSubmittedConfirmation() {
    const lot = (await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'March 2026' })).body.lot;
    const buf = buildLedgerXlsx([{ customer_id: 'TEST_C001', document_number: 'I1', document_type: 'INVOICE', document_date: '2026-01-01', amount: 10000, status: 'OPEN' }]);
    await request(app).post(`/api/lots/${lot._id}/ledger/upload`).set('Authorization', `Bearer ${adminJwt()}`).attach('ledger_file', buf, 'l.xlsx');
    await fakeModels.Customer.create({ customer_id: 'TEST_C001', customer_name: 'TEST Customer', email: 'test@example.test', pan: 'ABCDE1234F' });
    await request(app).post(`/api/lots/${lot._id}/tokens/generate`).set('Authorization', `Bearer ${adminJwt()}`).send({ send_email: false });
    const tokenRec = await fakeModels.TokenRecord.findOne({ lot_id: lot._id, customer_id: 'TEST_C001' });
    const pan = await request(app).post('/api/tokens/verify-pan').send({ token: tokenRec.token, pan: 'ABCDE1234F' });
    await request(app).post(`/api/lots/${lot._id}/confirmations/submit`).field('token_id', pan.body.token_id).field('sap_balance', '10000').field('cust_balance', '9000');
    return { lot };
  }

  test('default workflow_status after submit is ADMIN_REVIEW', async () => {
    const { lot } = await setupSubmittedConfirmation();
    const conf = await request(app).get(`/api/lots/${lot._id}/confirmations/TEST_C001`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(conf.body.confirmation.workflow_status).toBe('ADMIN_REVIEW');
  });

  test('full Admin -> Finance -> Admin -> Customer -> Admin round trip, with comments and chronological history preserved', async () => {
    const { lot } = await setupSubmittedConfirmation();

    const toFinance = await request(app).post(`/api/lots/${lot._id}/confirmations/TEST_C001/route-to-finance`).set('Authorization', `Bearer ${adminJwt()}`).send({ comment: 'Please check this variance' });
    expect(toFinance.body.workflow_status).toBe('FINANCE_REVIEW');

    const toAdmin = await request(app).post(`/api/lots/${lot._id}/confirmations/TEST_C001/route-to-admin`).set('Authorization', `Bearer ${financeJwt()}`).send({ comment: 'Looks like a timing difference, please confirm with customer' });
    expect(toAdmin.body.workflow_status).toBe('ADMIN_REVIEW');

    const toCustomer = await request(app).post(`/api/lots/${lot._id}/confirmations/TEST_C001/route-to-finance`).set('Authorization', `Bearer ${adminJwt()}`).send({ comment: 'agree, routing to customer' });
    expect(toCustomer.body.workflow_status).toBe('FINANCE_REVIEW');
    const toClarify = await request(app).post(`/api/lots/${lot._id}/confirmations/TEST_C001/route-to-customer`).set('Authorization', `Bearer ${financeJwt()}`).send({ comment: 'Can you confirm invoice INV-1 timing?' });
    expect(toClarify.body.workflow_status).toBe('CUSTOMER_CLARIFICATION');

    // Customer sees clarification state, amends and resubmits — returns to ADMIN_REVIEW automatically.
    const tokenRec = await fakeModels.TokenRecord.findOne({ lot_id: lot._id, customer_id: 'TEST_C001' });
    const pan = await request(app).post('/api/tokens/verify-pan').send({ token: tokenRec.token, pan: 'ABCDE1234F' });
    const resubmit = await request(app).post(`/api/lots/${lot._id}/confirmations/submit`).field('token_id', pan.body.token_id).field('sap_balance', '10000').field('cust_balance', '10000').field('remarks', 'Confirmed, timing difference resolved');
    expect(resubmit.body.version).toBe(2);

    const finalConf = await request(app).get(`/api/lots/${lot._id}/confirmations/TEST_C001`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(finalConf.body.confirmation.workflow_status).toBe('ADMIN_REVIEW');
    expect(finalConf.body.confirmation.cust_balance).toBe(10000);

    // Full chronological history includes every routing action AND the resubmission.
    const history = await request(app).get(`/api/lots/${lot._id}/confirmations/TEST_C001/history`).set('Authorization', `Bearer ${adminJwt()}`);
    const actions = history.body.history.map(h => h.action);
    expect(actions).toEqual(expect.arrayContaining([
      'CONFIRMATION_SENT', 'CONFIRMATION_SUBMITTED', 'ROUTED_TO_FINANCE', 'FINANCE_REVIEWED', 'ROUTED_TO_ADMIN', 'ROUTED_TO_CUSTOMER', 'BALANCE_AMENDED',
    ]));
    // Chronological order preserved (ROUTED_TO_FINANCE before ROUTED_TO_ADMIN before the final BALANCE_AMENDED).
    const idxFinance = actions.indexOf('ROUTED_TO_FINANCE');
    const idxAdmin = actions.lastIndexOf('ROUTED_TO_ADMIN');
    const idxAmend = actions.indexOf('BALANCE_AMENDED');
    expect(idxFinance).toBeLessThan(idxAdmin);
    expect(idxAdmin).toBeLessThan(idxAmend);
  });

  test('history for one Lot never includes another Lot\'s events for the same customer (cross-Lot isolation)', async () => {
    const { lot: lot1 } = await setupSubmittedConfirmation();
    const lot2Res = await request(app).post('/api/lots').set('Authorization', `Bearer ${adminJwt()}`).send({ period: 'June 2026' });
    const lot2 = lot2Res.body.lot;
    const buf = buildLedgerXlsx([{ customer_id: 'TEST_C001', document_number: 'I2', document_type: 'INVOICE', document_date: '2026-06-01', amount: 500, status: 'OPEN' }]);
    await request(app).post(`/api/lots/${lot2._id}/ledger/upload`).set('Authorization', `Bearer ${adminJwt()}`).attach('ledger_file', buf, 'l.xlsx');

    await request(app).post(`/api/lots/${lot1._id}/confirmations/TEST_C001/route-to-finance`).set('Authorization', `Bearer ${adminJwt()}`).send({ comment: 'lot1 only' });

    const lot2History = await request(app).get(`/api/lots/${lot2._id}/confirmations/TEST_C001/history`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(lot2History.body.history.map(h => h.action)).not.toContain('ROUTED_TO_FINANCE');
  });
});
