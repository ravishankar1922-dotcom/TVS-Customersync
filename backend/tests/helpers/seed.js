const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cfg = require('../../src/config');
const te = require('../../src/utils/tokenEngine');
const models = require('./models/index');

// Every seeded record uses a TEST_ prefix per the engagement's data-isolation
// requirement — never anything resembling a real TVS Mobility customer.
async function seedAdmin() {
  const hash = await bcrypt.hash(cfg.ADMIN_PASSWORD, 4); // low cost factor, tests only
  return models.Admin.create({ email: cfg.ADMIN_EMAIL.toLowerCase(), password_hash: hash, name: 'TEST Admin', role: 'ADMIN' });
}

function adminJwt(email = cfg.ADMIN_EMAIL) {
  return jwt.sign({ sub: 'TEST_admin_id', email, role: 'ADMIN', business_type: 'BOTH' }, cfg.JWT_SECRET, { expiresIn: '12h' });
}

// Phase 4/5: a Finance-role JWT, for permission/workflow tests.
function financeJwt(email = 'test.finance@example.test') {
  return jwt.sign({ sub: 'TEST_finance_id', email, role: 'FINANCE', business_type: 'BOTH' }, cfg.JWT_SECRET, { expiresIn: '12h' });
}

async function seedCustomer(overrides = {}) {
  return models.Customer.create({
    customer_id: 'TEST_C001', customer_name: 'TEST Customer One', email: 'test.customer1@example.test',
    pan: 'ABCDE1234F', status: 'ACTIVE', ...overrides,
  });
}

async function seedVendor(overrides = {}) {
  return models.Vendor.create({
    vendor_id: 'TEST_V001', vendor_name: 'TEST Vendor One', email: 'test.vendor1@example.test',
    pan: 'ABCDE1234F', status: 'ACTIVE', ...overrides,
  });
}

async function seedLedger(customerId = 'TEST_C001', transactions) {
  return models.LedgerEntry.create({
    customer_id: customerId,
    transactions: transactions || [
      { document_number: 'TEST_INV001', document_type: 'INVOICE', document_date: '2026-01-05', due_date: '2026-02-05', amount: 10000, status: 'OPEN' },
      { document_number: 'TEST_INV002', document_type: 'INVOICE', document_date: '2026-01-15', due_date: '2026-02-15', amount: 5000, status: 'OPEN' },
    ],
  });
}

async function seedActiveToken(customerId = 'TEST_C001', cycleId = cfg.CYCLE_ID, hours = 72) {
  const result = te.generateToken(customerId, cycleId, cfg.COMPANY, hours);
  const rec = await models.TokenRecord.create({
    token_id: result.token_id, customer_id: customerId, cycle_id: cycleId, company: cfg.COMPANY,
    token: result.token, portal_url: te.buildPortalUrl(result.token),
    created_at: new Date(result.issued_at), expires_at: new Date(result.expires_at),
    status: 'ACTIVE', used_at: null, pan_verified_at: null,
  });
  return { ...rec, rawToken: result.token };
}

module.exports = { seedAdmin, adminJwt, financeJwt, seedCustomer, seedVendor, seedLedger, seedActiveToken, models };
