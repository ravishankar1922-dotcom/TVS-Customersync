/**
 * One-time migration: moves the pre-Lot GLOBAL sample/test data — the
 * customer_master.json + TSL_ledger.json rows loaded by `npm run seed`
 * (routes/ledger.js's legacy /api/ledger/upload, and any LedgerEntry with
 * no lot_id at all) — into one dedicated, clearly-labeled Lot, per items 3
 * and 7 of the Sept 2026 feedback batch ("whatever the old test data we can
 * move it to a lot" / "the already available test data can be under a
 * separate lot").
 *
 * This is DELIBERATELY separate from src/scripts/migrate-legacy-lots.js,
 * which backfills lot_id onto historical Confirmation/TokenRecord/EmailLog
 * rows by inferring a population from *response/token history*. That script
 * finds nothing for data that was only ever seeded/uploaded but never
 * actually sent to anyone (exactly the "sample test data" case here, which
 * may have zero Confirmations or TokenRecords). This script instead looks
 * directly at the GLOBAL LedgerEntry rows (lot_id: null) — the real source
 * of truth for "what test data exists" — and gives them a proper Lot home.
 *
 * WHAT IT DOES:
 *   1. Finds every LedgerEntry with lot_id: null (the legacy/global ledger).
 *   2. Creates ONE Lot for them — business_type CUSTOMER, is_legacy: true,
 *      remarks explaining its origin, lot_number LOT-LEGACY-DATA-001 (or
 *      the next free suffix if re-run after a partial prior run).
 *   3. Re-points each of those LedgerEntry documents at the new lot_id (an
 *      update, not a copy — there is only ever one copy of this data).
 *   4. Builds a matching LotPopulation row per customer, with opening_balance
 *      computed the same way lots.js's own ledger-upload route does (sum of
 *      OPEN transactions), and customer_name looked up from the Customer
 *      master where available.
 *   5. Sets the Lot's population_count/total_ledger_balance/status ACTIVE,
 *      exactly as a normal ledger upload would.
 *
 * WHAT IT DOES NOT DO: touch any LedgerEntry that already has a lot_id (a
 * real Lot's data is never touched), delete anything, or invent data that
 * wasn't already there. Safe to re-run — idempotent (skips if a Lot with
 * is_legacy_data_seed: true already exists and no un-lotted LedgerEntry
 * rows remain).
 *
 * IMPORTANT — NOT RUN AGAINST A REAL DATABASE (same sandbox limitation as
 * migrate-legacy-lots.js — see that file's header). Verified here against
 * the same in-memory fake models the Jest suite uses
 * (tests/unit/seedLegacyDataIntoLot.test.js). Before running for real: take
 * a MongoDB backup first, run with --dry-run, review the printed plan.
 *
 * Usage:
 *   node src/scripts/seed-legacy-data-into-lot.js --dry-run
 *   node src/scripts/seed-legacy-data-into-lot.js
 */
require('dotenv').config();

async function seedLegacyDataIntoLot({ Lot, LotPopulation, LedgerEntry, Customer }, opts = {}) {
  const dryRun = !!opts.dryRun;
  const log = opts.log || console.log;

  const orphanLedgers = await LedgerEntry.find({ lot_id: null }).lean();
  if (!orphanLedgers.length) {
    log('Nothing to do — no legacy/global LedgerEntry rows found (lot_id: null). Either there is no old test data, or it has already been moved into a Lot.');
    return { created: false, population_count: 0 };
  }

  const custIds = orphanLedgers.map(l => l.customer_id);
  let totalBalance = 0;
  const balanceByCust = new Map();
  orphanLedgers.forEach(l => {
    const openBalance = (l.transactions || []).filter(t => t.status === 'OPEN').reduce((s, t) => s + (t.amount || 0), 0);
    balanceByCust.set(l.customer_id, openBalance);
    totalBalance += openBalance;
  });

  const now = new Date();
  const existingLegacyDataLots = await Lot.find({ is_legacy_data_seed: true }).distinct('lot_number');
  const seq = existingLegacyDataLots.length + 1;
  const lot_number = `LOT-LEGACY-DATA-${String(seq).padStart(3, '0')}`;
  const period_label = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')} (legacy test data)`;

  if (dryRun) {
    log('[DRY RUN] Would create:', JSON.stringify({ lot_number, population_count: custIds.length, total_balance: parseFloat(totalBalance.toFixed(2)) }));
    return { dryRun: true, lot_number, population_count: custIds.length, total_balance: parseFloat(totalBalance.toFixed(2)) };
  }

  const lot = await Lot.create({
    lot_number, period_year: now.getFullYear(), period_month: now.getMonth() + 1, period_label,
    business_type: 'CUSTOMER', status: 'ACTIVE',
    is_legacy: true, is_legacy_data_seed: true, legacy_cycle_id: null,
    created_by: 'MIGRATION',
    remarks: 'Pre-Lot sample/test data (customer_master.json + TSL_ledger.json), moved here automatically so it no longer sits outside the Lot structure.',
    population_count: custIds.length, total_ledger_balance: parseFloat(totalBalance.toFixed(2)),
  });

  const knownCustomers = await Customer.find({ customer_id: { $in: custIds } }).lean();
  const nameById = new Map(knownCustomers.map(c => [c.customer_id, c.customer_name]));

  for (const custId of custIds) {
    await LedgerEntry.updateOne({ customer_id: custId, lot_id: null }, { lot_id: lot._id });
    await LotPopulation.findOneAndUpdate(
      { lot_id: lot._id, customer_id: custId },
      { lot_id: lot._id, customer_id: custId, customer_name: nameById.get(custId) || null, opening_balance: balanceByCust.get(custId) || 0 },
      { upsert: true }
    );
  }

  log('Created:', JSON.stringify({ lot_number, lot_id: lot._id, population_count: custIds.length, total_balance: lot.total_ledger_balance }));
  return { created: true, lot_number, lot_id: lot._id, population_count: custIds.length, total_balance: lot.total_ledger_balance };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const connectDB = require('../db');
  const Lot = require('../models/Lot');
  const LotPopulation = require('../models/LotPopulation');
  const LedgerEntry = require('../models/LedgerEntry');
  const Customer = require('../models/Customer');

  (async () => {
    console.log(dryRun ? '=== DRY RUN — no writes will be made ===' : '=== LIVE RUN ===');
    await connectDB();
    await seedLegacyDataIntoLot({ Lot, LotPopulation, LedgerEntry, Customer }, { dryRun });
    console.log('\nDone.');
    process.exit(0);
  })().catch(err => { console.error('Migration failed:', err); process.exit(1); });
}

module.exports = { seedLegacyDataIntoLot };
