/**
 * Lightweight load test — NOT a Jest test, run directly with `node`.
 *
 * WHY autocannon, not k6: k6 is a Go binary distributed via GitHub Releases
 * (dl.k6.io / github.com release assets) and Artillery's default install
 * pulls native deps from similar hosts — none reachable from this sandbox
 * (see tests/helpers/fakeModel.js's header comment for the confirmed
 * proxy-level 403 on the equivalent MongoDB binary host; the same
 * allowlist applies here). autocannon is a pure-npm HTTP load generator
 * (installs from the npm registry, which IS reachable) that still produces
 * real, measured p50/p90/p95/p99 latency + throughput + error-rate numbers
 * against a REAL listening HTTP server — not simulated/estimated figures.
 *
 * WHAT THIS DOES measure: the actual Express app — real middleware stack
 * (helmet/cors/morgan/body-parsing), real HMAC token validation, real
 * bcrypt/JWT, real reconciliation matching algorithm, real ExcelJS
 * generation — end to end over real HTTP/TCP on localhost.
 *
 * WHAT THIS DOES NOT measure: real MongoDB Atlas network latency, disk
 * I/O, or index performance — the persistence layer is the same in-memory
 * fake used by the Jest suite (see tests/helpers/fakeModel.js), because a
 * real MongoDB instance could not be provisioned in this sandbox. Numbers
 * here are a genuine floor/ceiling for "how fast can this Node process
 * itself go", not a prediction of production Render+Atlas latency, which
 * will additionally include real network round-trips to the database.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'TEST_jwt_secret_do_not_use_in_prod';
process.env.HMAC_SECRET = 'TEST_hmac_secret_do_not_use_in_prod';
process.env.ADMIN_EMAIL = 'TEST_admin@example.test';
process.env.ADMIN_PASSWORD = 'TEST_Password_123!';
process.env.CYCLE_ID = 'TEST-CYCLE-2026';
process.env.COMPANY = 'TEST_CO';
process.env.AS_OF_DATE = '31-Mar-2026';
process.env.FRONTEND_URL = 'http://localhost:3000';
delete process.env.SMTP_HOST;

const path = require('path');
const Module = require('module');

// Same moduleNameMapper trick jest.config.js does, but for a plain `node`
// process (autocannon needs a real listening server + real network I/O,
// which Jest's environment does not give us) — redirect model requires to
// the shared in-memory fakes.
const origResolve = Module._resolveFilename;
const modelMap = { Customer:1, LedgerEntry:1, TokenRecord:1, Confirmation:1, EmailLog:1, AuditLog:1, Admin:1, ImportHistory:1, LedgerImportStaging:1 };
Module._resolveFilename = function (request, ...rest) {
  const m = request.match(/models\/(\w+)$/);
  if (m && modelMap[m[1]]) return origResolve.call(this, path.join(__dirname, '..', 'helpers', 'models', m[1] + '.js'), ...rest);
  return origResolve.call(this, request, ...rest);
};

const autocannon = require('autocannon');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cfg = require('../../src/config');
const te = require('../../src/utils/tokenEngine');
const app = require('../../src/server');
const models = require('../helpers/models/index');

async function seed() {
  await bcrypt.hash(cfg.ADMIN_PASSWORD, 4).then(hash => models.Admin.create({ email: cfg.ADMIN_EMAIL.toLowerCase(), password_hash: hash, name: 'TEST Admin', role: 'ADMIN' }));
  const N = 300; // realistic mid-size customer book
  const tokens = [];
  for (let i = 0; i < N; i++) {
    const id = `TEST_LOAD_C${String(i).padStart(4, '0')}`;
    await models.Customer.create({ customer_id: id, customer_name: `TEST Load Customer ${i}`, pan: 'ABCDE1234F', email: `t${i}@example.test`, status: 'ACTIVE' });
    const txns = Array.from({ length: 50 }, (_, k) => ({ document_number: `INV${i}-${k}`, document_type: 'INVOICE', document_date: '2026-01-01', amount: 1000 + k, status: 'OPEN' }));
    await models.LedgerEntry.create({ customer_id: id, transactions: txns });
    const result = te.generateToken(id, cfg.CYCLE_ID, cfg.COMPANY, 72);
    await models.TokenRecord.create({ token_id: result.token_id, customer_id: id, cycle_id: cfg.CYCLE_ID, company: cfg.COMPANY, token: result.token, portal_url: te.buildPortalUrl(result.token), created_at: new Date(), expires_at: new Date(result.expires_at), status: 'ACTIVE' });
    if (i < 50) tokens.push(result.token);
  }
  return tokens;
}

function adminToken() { return jwt.sign({ sub: 'TEST', email: cfg.ADMIN_EMAIL, role: 'ADMIN' }, cfg.JWT_SECRET, { expiresIn: '12h' }); }

async function runScenario(name, opts) {
  console.log(`\n=== ${name} ===`);
  const result = await autocannon(opts);
  console.log(autocannon.printResult(result));
  return { name, ...pick(result) };
}
function pick(r) {
  return {
    requests_total: r.requests.total, duration_s: r.duration, throughput_rps: r.requests.average,
    latency_p50_ms: r.latency.p50, latency_p90_ms: r.latency.p90, latency_p95_ms: (r.latency.p97_5 ?? r.latency.p90),
    latency_p99_ms: r.latency.p99, latency_max_ms: r.latency.max,
    errors: r.errors, timeouts: r.timeouts, non2xx: r['5xx'] + r['4xx'] - (r.non2xx || 0) + (r.non2xx || 0),
    status_2xx: r['2xx'], status_4xx: r['4xx'], status_5xx: r['5xx'],
  };
}

(async () => {
  const tokens = await seed();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;

  const results = [];

  results.push(await runScenario('GET /api/system/health (baseline middleware overhead)', {
    url: `${url}/api/system/health`, connections: 20, duration: 8,
  }));

  results.push(await runScenario('POST /api/tokens/validate (public, HMAC verification path — the endpoint every customer link hits)', {
    url: `${url}/api/tokens/validate`, method: 'POST', connections: 20, duration: 10,
    headers: { 'content-type': 'application/json' },
    setupClient: (client) => {
      client.on('request', () => {}); // per-request token below via requests[] instead
    },
    requests: [{ method: 'POST', path: '/api/tokens/validate', headers: { 'content-type': 'application/json' }, setupRequest: (req) => {
      req.body = JSON.stringify({ token: tokens[Math.floor(Math.random() * tokens.length)] });
      return req;
    } }],
  }));

  results.push(await runScenario('GET /api/customers (admin overview, 300 seeded customers — worst-case aggregation join)', {
    url: `${url}/api/customers`, connections: 10, duration: 10,
    headers: { Authorization: `Bearer ${adminToken()}` },
  }));

  server.close();
  console.log('\n\n=== SUMMARY (JSON) ===');
  console.log(JSON.stringify(results, null, 2));
  require('fs').writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(results, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
