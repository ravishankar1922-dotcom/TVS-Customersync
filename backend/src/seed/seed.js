/**
 * One-time / repeatable seed script.
 * Loads data/customer_master.json and data/TSL_ledger.json into MongoDB,
 * and creates the admin user if missing.
 *
 * Usage: npm run seed   (from backend/)
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const connectDB = require('../db');
const cfg   = require('../config');
const Customer    = require('../models/Customer');
const LedgerEntry  = require('../models/LedgerEntry');
const Admin        = require('../models/Admin');

async function run() {
  await connectDB();

  const custPath   = path.join(__dirname, '..', '..', 'data', 'customer_master.json');
  const ledgerPath = path.join(__dirname, '..', '..', 'data', 'TSL_ledger.json');

  if (fs.existsSync(custPath)) {
    const customers = JSON.parse(fs.readFileSync(custPath, 'utf8'));
    for (const c of customers) {
      if (!c.pan) { console.warn(`  ! Skipping ${c.customer_id} — no PAN on file (required for portal login).`); continue; }
      await Customer.findOneAndUpdate({ customer_id: c.customer_id }, { ...c, pan: c.pan.toUpperCase() }, { upsert: true });
    }
    console.log(`  Customers    : ${customers.length} upserted`);
  } else {
    console.log('  Customers    : data/customer_master.json not found — skipped');
  }

  if (fs.existsSync(ledgerPath)) {
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    for (const l of ledger) {
      await LedgerEntry.findOneAndUpdate({ customer_id: l.customer_id }, { customer_id: l.customer_id, transactions: l.transactions }, { upsert: true });
    }
    console.log(`  Ledger       : ${ledger.length} customer ledgers upserted`);
  } else {
    console.log('  Ledger       : data/TSL_ledger.json not found — skipped');
  }

  const existingAdmin = await Admin.findOne({ email: cfg.ADMIN_EMAIL.toLowerCase() });
  if (!existingAdmin) {
    const hash = await bcrypt.hash(cfg.ADMIN_PASSWORD, 10);
    await Admin.create({ email: cfg.ADMIN_EMAIL.toLowerCase(), password_hash: hash, name: 'Admin' });
    console.log(`  Admin user   : created (${cfg.ADMIN_EMAIL})`);
  } else {
    console.log(`  Admin user   : already exists (${cfg.ADMIN_EMAIL})`);
  }

  console.log('\n✅ Seed complete.\n');
  process.exit(0);
}

run().catch(err => { console.error('Seed failed:', err); process.exit(1); });
