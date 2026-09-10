const request = require('supertest');
const app = require('../../src/server');
const { resetAllModels } = require('../helpers/models/index');

beforeEach(() => resetAllModels());

describe('Security headers & CORS', () => {
  test('helmet security headers are present', async () => {
    const res = await request(app).get('/api/system/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-dns-prefetch-control']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined(); // helmet strips this
  });

  test('CORS is configured with a fixed, single allowed origin (FRONTEND_URL) — verified behavior, not assumed', async () => {
    // `cors({ origin: cfg.FRONTEND_URL })` with a STRING origin makes the
    // `cors` package always emit that one static value as
    // Access-Control-Allow-Origin, regardless of the request's own Origin
    // header — it does not reflect/echo the caller's origin (that would be
    // the actual footgun: `origin: true` or `origin: (o, cb) => cb(null,
    // true)` reflects any origin back, which this codebase does NOT do).
    // Verified here: a request claiming Origin: evil.example.test still
    // gets back the fixed FRONTEND_URL value, not its own origin reflected
    // — a real browser on evil.example.test would see that mismatch and
    // block the response from JS, which is the actual CORS protection.
    const fromFrontend = await request(app).get('/api/system/health').set('Origin', 'http://localhost:3000');
    const fromEvil = await request(app).get('/api/system/health').set('Origin', 'https://evil.example.test');
    expect(fromFrontend.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(fromEvil.headers['access-control-allow-origin']).toBe('http://localhost:3000'); // NOT "https://evil.example.test"
  });
});

describe('Public system routes leak nothing sensitive', () => {
  test('GET /api/system/config never includes secrets', async () => {
    const res = await request(app).get('/api/system/config');
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/TEST_jwt_secret_do_not_use_in_prod/);
    expect(body).not.toMatch(/TEST_hmac_secret_do_not_use_in_prod/);
    expect(body).not.toMatch(/TEST_Password_123/);
    expect(body.toLowerCase()).not.toMatch(/jwt_secret|hmac_secret|password/);
  });

  test('GET /api/system/health requires no auth and returns ok', async () => {
    const res = await request(app).get('/api/system/health');
    expect(res.status).toBe(200);
  });
});

describe('Generic error handler', () => {
  test('a downstream Mongoose-style error message is returned as-is (documented risk, not a crash)', async () => {
    // system.js/health route is intentionally simple; use a route that can
    // throw from our fake model to exercise the handler end-to-end.
    const Customer = require('../helpers/models/Customer');
    const realFind = Customer.find.bind(Customer);
    Customer.find = () => { throw new Error('Simulated internal failure: connection pool exhausted'); };
    const jwtHelper = require('../helpers/seed');
    const res = await request(app).get('/api/customers').set('Authorization', `Bearer ${jwtHelper.adminJwt()}`);
    Customer.find = realFind;
    expect(res.status).toBe(500);
    // FINDING (documented, not auto-fixed — see QA report §"Known remaining
    // issues"): the generic handler returns err.message verbatim. Here it's
    // an internal message we control, but any code path where a thrown
    // Error's message embeds request data (e.g. some Mongoose CastErrors
    // include the offending value) would reflect that back to the client.
    // No secret/env value leaks through this path in the current codebase
    // (verified: JWT/HMAC secrets, DB URIs and password hashes are never
    // interpolated into thrown Error messages anywhere in src/).
    expect(res.body.error).toBe('Simulated internal failure: connection pool exhausted');
  });

  test('stack traces are never sent to the client', async () => {
    const Customer = require('../helpers/models/Customer');
    const realFind = Customer.find.bind(Customer);
    Customer.find = () => { throw new Error('boom'); };
    const jwtHelper = require('../helpers/seed');
    const res = await request(app).get('/api/customers').set('Authorization', `Bearer ${jwtHelper.adminJwt()}`);
    Customer.find = realFind;
    expect(JSON.stringify(res.body)).not.toMatch(/at Object|at Layer|node_modules/);
  });
});
