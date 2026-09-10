const request = require('supertest');
const crypto = require('crypto');
const app = require('../../src/server');
const cfg = require('../../src/config');
const { resetAllModels } = require('../helpers/models/index');
const { seedCustomer, seedLedger, seedActiveToken } = require('../helpers/seed');

beforeEach(() => resetAllModels());

// tokenEngine.js only exports generateToken/validateToken/buildPortalUrl,
// and generateToken floors any non-positive `hours` back up to the config
// default (by design, for the admin-facing generate endpoint) — so it
// cannot itself produce an already-expired token for this test. Forge one
// with the identical b64url+HMAC-SHA256 scheme instead (same algorithm,
// tests/helpers only, using the TEST_-only HMAC_SECRET from env.js).
function forgeToken(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const sig = crypto.createHmac('sha256', cfg.HMAC_SECRET).update(encoded).digest('hex');
  return `${encoded}.${sig}`;
}

describe('Token validation (factor 1)', () => {
  test('rejects a tampered token (bad signature)', async () => {
    const { rawToken } = await seedActiveToken();
    const [encoded] = rawToken.split('.');
    const tampered = `${encoded}.deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`;
    const res = await request(app).post('/api/tokens/validate').send({ token: tampered });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('INVALID_SIGNATURE');
  });

  test('rejects garbage / malformed token strings without throwing 500s', async () => {
    for (const bad of ['', 'not-a-token', 'a.b.c', '{"$ne":null}', null]) {
      const res = await request(app).post('/api/tokens/validate').send({ token: bad });
      expect([400]).toContain(res.status);
    }
  });

  test('rejects an expired token independent of DB status field', async () => {
    await seedActiveToken(); // TokenRecord exists and is ACTIVE in the DB...
    const expired = forgeToken({ token_id: 'TEST_expired_tok', customer_id: 'TEST_C001', cycle_id: 'TEST-CYCLE-2026', company: 'TEST_CO', issued_at: Date.now() - 1000, expires_at: Date.now() - 500 });
    const res = await request(app).post('/api/tokens/validate').send({ token: expired });
    // ...but expiry is enforced independently from the signed payload itself,
    // not by trusting the DB status field to have auto-flipped.
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('EXPIRED');
  });

  test('a used token cannot be validated again', async () => {
    const rec = await seedActiveToken();
    const { models } = require('../helpers/seed');
    await models.TokenRecord.updateOne({ token_id: rec.token_id }, { status: 'USED' });
    const res = await request(app).post('/api/tokens/validate').send({ token: rec.rawToken });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('ALREADY_USED');
  });
});

describe('PAN verification (factor 2) — brute force & data isolation', () => {
  test('correct PAN succeeds and returns only that customer\'s data', async () => {
    await seedCustomer();
    await seedLedger();
    const { rawToken } = await seedActiveToken();
    const res = await request(app).post('/api/tokens/verify-pan').send({ token: rawToken, pan: 'abcde1234f' }); // case-insensitive
    expect(res.status).toBe(200);
    expect(res.body.customer.customer_id).toBe('TEST_C001');
    expect(res.body.sap_balance).toBe(15000);
    res.body.transactions.forEach(t => expect(['TEST_INV001', 'TEST_INV002']).toContain(t.document_number));
  });

  test('wrong PAN is rejected and does not leak the real PAN or other fields', async () => {
    await seedCustomer();
    const { rawToken } = await seedActiveToken();
    const res = await request(app).post('/api/tokens/verify-pan').send({ token: rawToken, pan: 'WRONGPAN12' });
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe('PAN_MISMATCH');
    expect(JSON.stringify(res.body)).not.toMatch(/ABCDE1234F/);
  });

  test('CROSS-CUSTOMER IDOR: token for customer A cannot be verified with customer B\'s PAN to get A\'s data', async () => {
    await seedCustomer({ customer_id: 'TEST_C001', pan: 'ABCDE1234F' });
    await seedCustomer({ customer_id: 'TEST_C002', pan: 'ZZZZZ9999Z', customer_name: 'TEST Customer Two' });
    const { rawToken } = await seedActiveToken('TEST_C001');
    const res = await request(app).post('/api/tokens/verify-pan').send({ token: rawToken, pan: 'ZZZZZ9999Z' });
    expect(res.status).toBe(401); // customer B's PAN must NOT unlock customer A's token
  });

  test('NoSQL-injection-shaped `pan` (an object instead of a string) is rejected cleanly, not a 500 crash', async () => {
    await seedCustomer();
    const { rawToken } = await seedActiveToken();
    const res = await request(app).post('/api/tokens/verify-pan').send({ token: rawToken, pan: { $ne: null } });
    // BUGFIX regression test: this used to throw (pan.trim is not a
    // function) and surface as a 500 with the raw error message via
    // server.js's generic handler. It must now fail closed as a normal
    // PAN mismatch, never 200, never an unhandled-exception 500.
    expect(res.status).toBe(401);
    expect(res.body.valid).toBe(false);
  });

  test('a used/revoked token cannot be PAN-verified even with the correct PAN', async () => {
    await seedCustomer();
    const rec = await seedActiveToken();
    const { models } = require('../helpers/seed');
    await models.TokenRecord.updateOne({ token_id: rec.token_id }, { status: 'REVOKED' });
    const res = await request(app).post('/api/tokens/verify-pan').send({ token: rec.rawToken, pan: 'ABCDE1234F' });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('TOKEN_INVALID');
  });

  // Kept LAST in this describe block deliberately: express-rate-limit's
  // default in-memory store is keyed per-IP and is NOT reset between tests
  // in the same suite process (nor should it be — that's the real behavior
  // an attacker would hit too), so any verify-pan call after this one in the
  // same test file would also observe 429. See tests/security/README.md.
  test('SECURITY (fixed): PAN verification is rate-limited server-side — the 5-attempt lockout is not client-trust-only', async () => {
    await seedCustomer();
    const { rawToken } = await seedActiveToken();
    let last;
    for (let i = 0; i < 16; i++) {
      last = await request(app).post('/api/tokens/verify-pan').send({ token: rawToken, pan: 'WRONG' + i });
    }
    expect(last.status).toBe(429);
  });
});

describe('SAP ledger download (customer-scoped)', () => {
  test('requires the correct PAN as well as a valid token (not just the token)', async () => {
    await seedCustomer();
    await seedLedger();
    const { rawToken } = await seedActiveToken();
    const noPan = await request(app).get(`/api/tokens/${encodeURIComponent(rawToken)}/sap-ledger.xlsx`);
    expect(noPan.status).toBe(401);
    const withPan = await request(app).get(`/api/tokens/${encodeURIComponent(rawToken)}/sap-ledger.xlsx?pan=ABCDE1234F`);
    expect(withPan.status).toBe(200);
    expect(withPan.headers['content-disposition']).toContain('SAP_Ledger_TEST_C001.xlsx');
  });

  test('cannot download another customer\'s ledger via a mismatched PAN', async () => {
    await seedCustomer({ customer_id: 'TEST_C001', pan: 'ABCDE1234F' });
    await seedCustomer({ customer_id: 'TEST_C002', pan: 'ZZZZZ9999Z' });
    await seedLedger('TEST_C001');
    const { rawToken } = await seedActiveToken('TEST_C001');
    const res = await request(app).get(`/api/tokens/${encodeURIComponent(rawToken)}/sap-ledger.xlsx?pan=ZZZZZ9999Z`);
    expect(res.status).toBe(401);
  });
});
