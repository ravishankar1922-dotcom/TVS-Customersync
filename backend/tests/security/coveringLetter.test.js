const request = require('supertest');
const XLSX = require('xlsx');
const app = require('../../src/server');
const fakeModels = require('../helpers/models/index');
const { resetAllModels } = fakeModels;
const { adminJwt } = require('../helpers/seed');

beforeEach(() => resetAllModels());

// Sept 2026: "Once the balance confirmed they should able to download the
// cover letter PDF... amount, date should automatically change according
// to the lot." Covers both the public customer-portal download (token+PAN
// gated, routes/tokens.js) and the admin download (routes/lots.js).

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

async function getRawToken(lotId, customerId) {
  const rec = await fakeModels.TokenRecord.findOne({ lot_id: lotId, customer_id: customerId, status: 'ACTIVE' });
  return rec.token;
}

async function setup() {
  const lot = await createLotWithLedger('March 2026', [{ customer_id: 'TEST_CL01', document_number: 'I1', document_type: 'INVOICE', document_date: '2026-01-01', amount: 25000, status: 'OPEN' }]);
  await fakeModels.Customer.create({ customer_id: 'TEST_CL01', customer_name: 'TEST Covering Letter Co', email: 'cl@example.test', pan: 'ABCDE1234F' });
  await request(app).post(`/api/lots/${lot._id}/tokens/generate`).set('Authorization', `Bearer ${adminJwt()}`).send({ send_email: false });
  const rawToken = await getRawToken(lot._id, 'TEST_CL01');
  return { lot, rawToken };
}

function isPdf(buf) {
  return Buffer.isBuffer(buf) && buf.slice(0, 5).toString('utf8') === '%PDF-';
}

// supertest/superagent doesn't know how to parse application/pdf into a
// Buffer by default (res.body comes back as {}) — collect the raw bytes
// ourselves, same technique used for xlsx binary downloads elsewhere.
function binaryParser(res, callback) {
  res.setEncoding('binary');
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => callback(null, Buffer.from(data, 'binary')));
}

describe('GET /api/tokens/:token/covering-letter.pdf — customer-portal download', () => {
  test('404 before any confirmation has been submitted', async () => {
    const { rawToken } = await setup();
    const pan = await request(app).post('/api/tokens/verify-pan').send({ token: rawToken, pan: 'ABCDE1234F' });
    const res = await request(app).get(`/api/tokens/${encodeURIComponent(rawToken)}/covering-letter.pdf`).query({ pan: 'ABCDE1234F' });
    expect(pan.status).toBe(200);
    expect(res.status).toBe(404);
  });

  test('returns a real PDF after submit, with correct content-type', async () => {
    const { lot, rawToken } = await setup();
    const pan = await request(app).post('/api/tokens/verify-pan').send({ token: rawToken, pan: 'ABCDE1234F' });
    await request(app).post(`/api/lots/${lot._id}/confirmations/submit`)
      .field('token_id', pan.body.token_id).field('sap_balance', '25000').field('cust_balance', '25000');

    const res = await request(app).get(`/api/tokens/${encodeURIComponent(rawToken)}/covering-letter.pdf`).query({ pan: 'ABCDE1234F' }).buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(isPdf(res.body)).toBe(true);
  });

  test('rejects a missing/incorrect PAN', async () => {
    const { lot, rawToken } = await setup();
    const pan = await request(app).post('/api/tokens/verify-pan').send({ token: rawToken, pan: 'ABCDE1234F' });
    await request(app).post(`/api/lots/${lot._id}/confirmations/submit`)
      .field('token_id', pan.body.token_id).field('sap_balance', '25000').field('cust_balance', '25000');

    const noPan = await request(app).get(`/api/tokens/${encodeURIComponent(rawToken)}/covering-letter.pdf`);
    expect(noPan.status).toBe(401);
    const wrongPan = await request(app).get(`/api/tokens/${encodeURIComponent(rawToken)}/covering-letter.pdf`).query({ pan: 'ZZZZZ9999Z' });
    expect(wrongPan.status).toBe(401);
  });
});

describe('GET /api/lots/:lotId/confirmations/:customerId/covering-letter.pdf — admin download', () => {
  test('admin can download once a confirmation exists', async () => {
    const { lot, rawToken } = await setup();
    const pan = await request(app).post('/api/tokens/verify-pan').send({ token: rawToken, pan: 'ABCDE1234F' });
    await request(app).post(`/api/lots/${lot._id}/confirmations/submit`)
      .field('token_id', pan.body.token_id).field('sap_balance', '25000').field('cust_balance', '20000');

    const res = await request(app).get(`/api/lots/${lot._id}/confirmations/TEST_CL01/covering-letter.pdf`).set('Authorization', `Bearer ${adminJwt()}`).buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(isPdf(res.body)).toBe(true);
  });

  test('404 for a customer with no confirmation in this Lot', async () => {
    const { lot } = await setup();
    const res = await request(app).get(`/api/lots/${lot._id}/confirmations/TEST_CL01/covering-letter.pdf`).set('Authorization', `Bearer ${adminJwt()}`);
    expect(res.status).toBe(404);
  });

  test('requires admin auth', async () => {
    const { lot } = await setup();
    const res = await request(app).get(`/api/lots/${lot._id}/confirmations/TEST_CL01/covering-letter.pdf`);
    expect(res.status).toBe(401);
  });
});
