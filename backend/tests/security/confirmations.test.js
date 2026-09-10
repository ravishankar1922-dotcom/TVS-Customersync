const request = require('supertest');
const app = require('../../src/server');
const fakeModels = require('../helpers/models/index');
const { resetAllModels } = fakeModels;
const { seedCustomer, seedActiveToken, models } = require('../helpers/seed');

beforeEach(() => resetAllModels());

async function panVerify(rawToken) {
  const te = require('../../src/utils/tokenEngine');
  const { payload } = te.validateToken(rawToken);
  await models.TokenRecord.updateOne({ token_id: payload.token_id }, { pan_verified_at: new Date() });
  return payload;
}

describe('POST /api/confirmations/submit — IDOR (BUGFIX regression tests)', () => {
  test('SECURITY (fixed): a PAN-verified token for customer A cannot submit a confirmation claiming to be customer B', async () => {
    await seedCustomer({ customer_id: 'TEST_C001' });
    await seedCustomer({ customer_id: 'TEST_C002' });
    const tokA = await seedActiveToken('TEST_C001');
    await panVerify(tokA.rawToken);

    const res = await request(app).post('/api/confirmations/submit')
      .field('customer_id', 'TEST_C002') // <- claims to be a DIFFERENT customer than the token was issued for
      .field('cycle_id', 'TEST-CYCLE-2026')
      .field('token_id', tokA.token_id)
      .field('sap_balance', '1000')
      .field('cust_balance', '1000');

    expect(res.status).toBe(403);
    const confB = await require('../helpers/models/index').Confirmation.findOne({ customer_id: 'TEST_C002' });
    expect(confB).toBeNull(); // no confirmation was created/overwritten for the victim
  });

  test('legitimate matching customer_id + token_id + cycle_id succeeds', async () => {
    await seedCustomer({ customer_id: 'TEST_C001' });
    const tok = await seedActiveToken('TEST_C001');
    await panVerify(tok.rawToken);

    const res = await request(app).post('/api/confirmations/submit')
      .field('customer_id', 'TEST_C001')
      .field('cycle_id', 'TEST-CYCLE-2026')
      .field('token_id', tok.token_id)
      .field('sap_balance', '15000')
      .field('cust_balance', '15000');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('MATCHED');
  });

  test('rejects a submission whose token was never PAN-verified', async () => {
    await seedCustomer({ customer_id: 'TEST_C001' });
    const tok = await seedActiveToken('TEST_C001'); // no panVerify() call
    const res = await request(app).post('/api/confirmations/submit')
      .field('customer_id', 'TEST_C001').field('cycle_id', 'TEST-CYCLE-2026').field('token_id', tok.token_id)
      .field('sap_balance', '100').field('cust_balance', '100');
    expect(res.status).toBe(403);
  });

  test('SECURITY (fixed): concurrent double-submit race — only one of two simultaneous requests on the same token succeeds', async () => {
    await seedCustomer({ customer_id: 'TEST_C001' });
    const tok = await seedActiveToken('TEST_C001');
    await panVerify(tok.rawToken);

    const body = { customer_id: 'TEST_C001', cycle_id: 'TEST-CYCLE-2026', token_id: tok.token_id, sap_balance: '100', cust_balance: '100' };
    const [r1, r2] = await Promise.all([
      request(app).post('/api/confirmations/submit').field(body),
      request(app).post('/api/confirmations/submit').field(body),
    ]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    // Exactly one of the two requests succeeds (200); the other is rejected
    // — either by the atomic findOneAndUpdate(status:'ACTIVE') guard (409,
    // "already used") if it lost a genuine race, or by the earlier
    // status==='ACTIVE' check (403) if this fake in-memory model's mostly-
    // synchronous resolution let request #1 finish before #2's handler
    // started. Both outcomes prove the same thing that matters: it is now
    // IMPOSSIBLE for both requests to reach 200. NOTE: because this fake has
    // no real network I/O, it can't fully reproduce true multi-connection
    // interleaving the way a real MongoDB deployment under load would — see
    // the QA report's known-limitations section for how to re-verify this
    // specific race against a real mongod.
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);
    expect(statuses).not.toEqual([200, 200]);
  });
});

describe('POST /api/confirmations/:customerId/request-reupload — auth-bypass (BUGFIX regression test)', () => {
  test('SECURITY (fixed): omitting token_id no longer bypasses the ownership check', async () => {
    await seedCustomer({ customer_id: 'TEST_C001' });
    await fakeModels.Confirmation.create({ customer_id: 'TEST_C001', cycle_id: 'TEST-CYCLE-2026', token_id: 'TEST_real_token_id', reupload_status: 'NONE' });

    const res = await request(app).post('/api/confirmations/TEST_C001/request-reupload').send({ reason: 'wrong file' }); // token_id omitted entirely
    expect(res.status).toBe(403);
    const conf = await fakeModels.Confirmation.findOne({ customer_id: 'TEST_C001' });
    expect(conf.reupload_status).toBe('NONE'); // unchanged
  });

  test('a wrong token_id is also rejected', async () => {
    await fakeModels.Confirmation.create({ customer_id: 'TEST_C001', cycle_id: 'TEST-CYCLE-2026', token_id: 'TEST_real_token_id', reupload_status: 'NONE' });
    const res = await request(app).post('/api/confirmations/TEST_C001/request-reupload').send({ token_id: 'TEST_wrong_token_id', reason: 'x' });
    expect(res.status).toBe(403);
  });

  test('the correct token_id succeeds', async () => {
    await fakeModels.Confirmation.create({ customer_id: 'TEST_C001', cycle_id: 'TEST-CYCLE-2026', token_id: 'TEST_real_token_id', reupload_status: 'NONE' });
    const res = await request(app).post('/api/confirmations/TEST_C001/request-reupload').send({ token_id: 'TEST_real_token_id', reason: 'x' });
    expect(res.status).toBe(200);
    const conf = await fakeModels.Confirmation.findOne({ customer_id: 'TEST_C001' });
    expect(conf.reupload_status).toBe('REQUESTED');
  });
});

describe('File upload security on /submit', () => {
  test('rejects a disallowed file extension (e.g. .exe / .html)', async () => {
    await seedCustomer({ customer_id: 'TEST_C001' });
    const tok = await seedActiveToken('TEST_C001');
    await panVerify(tok.rawToken);
    const res = await request(app).post('/api/confirmations/submit')
      .field('customer_id', 'TEST_C001').field('cycle_id', 'TEST-CYCLE-2026').field('token_id', tok.token_id)
      .field('sap_balance', '100').field('cust_balance', '100')
      .attach('soa_file', Buffer.from('<script>alert(1)</script>'), { filename: 'evil.html', contentType: 'text/html' });
    expect(res.status).toBe(500); // multer fileFilter error surfaces via the generic error handler
  });

  test('rejects a file over the 20MB cap', async () => {
    await seedCustomer({ customer_id: 'TEST_C001' });
    const tok = await seedActiveToken('TEST_C001');
    await panVerify(tok.rawToken);
    const big = Buffer.alloc(21 * 1024 * 1024, 'a');
    const res = await request(app).post('/api/confirmations/submit')
      .field('customer_id', 'TEST_C001').field('cycle_id', 'TEST-CYCLE-2026').field('token_id', tok.token_id)
      .field('sap_balance', '100').field('cust_balance', '100')
      .attach('soa_file', big, { filename: 'huge.xlsx' });
    expect(res.status).toBe(413);
  }, 20000);

  test('accepts an allowed extension (.xlsx) within size limits', async () => {
    await seedCustomer({ customer_id: 'TEST_C001' });
    const tok = await seedActiveToken('TEST_C001');
    await panVerify(tok.rawToken);
    const res = await request(app).post('/api/confirmations/submit')
      .field('customer_id', 'TEST_C001').field('cycle_id', 'TEST-CYCLE-2026').field('token_id', tok.token_id)
      .field('sap_balance', '100').field('cust_balance', '100')
      .attach('soa_file', Buffer.from('fake xlsx bytes'), { filename: 'statement.xlsx' });
    expect(res.status).toBe(200);
  });
});
