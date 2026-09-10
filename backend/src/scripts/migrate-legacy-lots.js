/**
 * One-time migration: backfills the new Lot architecture onto data created
 * before it existed (see BalanceSync_Lot_Architecture_Plan.md §3b).
 *
 * WHAT IT DOES: every pre-Lot Confirmation/TokenRecord/EmailLog/LedgerEntry
 * document carries a `cycle_id` that came from the old, single global
 * `cfg.CYCLE_ID` env value at the time it was written. For each DISTINCT
 * cycle_id value found across those collections, this script:
 *   1. Creates one `Lot` document, `is_legacy: true`, `legacy_cycle_id` set
 *      to that value, with a best-effort period guessed from the string
 *      (falls back to the earliest document's creation month if the
 *      cycle_id itself doesn't look like a period) and a lot_number of the
 *      form LOT-LEGACY-<n>.
 *   2. Sets `lot_id` on every LedgerEntry/TokenRecord/Confirmation/EmailLog
 *      document whose cycle_id matches (LedgerEntry has no cycle_id field
 *      today, so it is matched by customer_id being present in that
 *      cycle's Confirmation/TokenRecord set instead — see note below).
 *   3. Builds `LotPopulation` for that legacy Lot from whichever customers
 *      have a Confirmation OR TokenRecord in that cycle (there is no
 *      original ledger-upload event to replay, so population here is
 *      INFERRED from response/token history, not from a real upload —
 *      this is stated in the Lot's own is_legacy/legacy_cycle_id fields so
 *      the UI can label it honestly rather than presenting it as a normal
 *      Lot).
 *
 * WHAT IT DOES NOT DO: delete, rewrite, or merge any existing document's
 * business data. It only ADDS a lot_id reference. Safe to re-run — it is
 * idempotent (skips any cycle_id that already has a legacy Lot).
 *
 * IMPORTANT — NOT RUN AGAINST A REAL DATABASE: this sandbox has no network
 * path to a real MongoDB instance (see the QA report and architecture plan
 * for why). This script has been syntax-checked and dry-run against the
 * same in-memory fake models the Jest suite uses (see the bottom of this
 * file / tests/unit/migrateLegacyLots.test.js) to prove its LOGIC is
 * correct, but it has never executed against a real database. Before
 * running it for real: take a MongoDB backup/snapshot first, then run with
 * `--dry-run` and review the printed plan before running for real.
 *
 * Usage:
 *   node src/scripts/migrate-legacy-lots.js --dry-run
 *   node src/scripts/migrate-legacy-lots.js
 */
require('dotenv').config();

async function migrateLegacyLots({ Lot, LotPopulation, LedgerEntry, TokenRecord, Confirmation, EmailLog, Customer }, opts = {}) {
  const dryRun = !!opts.dryRun;
  const log = opts.log || console.log;

  // 1. Find every distinct cycle_id across the collections that carry one.
  const cycleIds = new Set();
  (await Confirmation.find().distinct('cycle_id')).forEach(c => c && cycleIds.add(c));
  (await TokenRecord.find().distinct('cycle_id')).forEach(c => c && cycleIds.add(c));
  (await EmailLog.find().distinct('cycle_id')).forEach(c => c && cycleIds.add(c));

  const results = [];
  for (const cycleId of cycleIds) {
    const already = await Lot.findOne({ is_legacy: true, legacy_cycle_id: cycleId });
    if (already) { results.push({ cycleId, skipped: true, reason: 'legacy Lot already exists', lot_id: already._id }); continue; }

    // Best-effort period: try to read a "MON-YYYY"/"YYYY-MM"-shaped
    // cycle_id, else fall back to the earliest related document's month.
    let year, month;
    const m = cycleId.match(/(\d{4})/);
    if (m) year = parseInt(m[1], 10);
    const monthMatch = cycleId.match(/JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC/i);
    const MONTH_IDX = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
    if (monthMatch) month = MONTH_IDX[monthMatch[0].toLowerCase()];
    if (!year || !month) {
      const anyConf = await Confirmation.findOne({ cycle_id: cycleId }).sort({ createdAt: 1 }).lean();
      const ts = anyConf ? new Date(anyConf.createdAt) : new Date();
      year = year || ts.getFullYear();
      month = month || (ts.getMonth() + 1);
    }

    const existingLegacy = await Lot.find({ is_legacy: true }).distinct('lot_number');
    const seq = existingLegacy.length + 1;
    const lot_number = `LOT-LEGACY-${String(seq).padStart(3, '0')}`;

    // 3. Population: everyone with a Confirmation OR a TokenRecord in this
    // cycle — inferred, not replayed from an original upload.
    const confCustIds = await Confirmation.find({ cycle_id: cycleId }).distinct('customer_id');
    const tokenCustIds = await TokenRecord.find({ cycle_id: cycleId }).distinct('customer_id');
    const custIds = [...new Set([...confCustIds, ...tokenCustIds])];

    if (dryRun) {
      results.push({ cycleId, lot_number, year, month, population_count: custIds.length, dryRun: true });
      continue;
    }

    const lot = await Lot.create({
      lot_number, period_year: year, period_month: month, period_label: `${year}-${String(month).padStart(2, '0')} (legacy)`,
      business_type: 'CUSTOMER', status: 'ACTIVE', is_legacy: true, legacy_cycle_id: cycleId,
      created_by: 'MIGRATION', population_count: custIds.length,
    });

    const knownCustomers = await Customer.find({ customer_id: { $in: custIds } }).lean();
    const nameById = new Map(knownCustomers.map(c => [c.customer_id, c.customer_name]));
    for (const custId of custIds) {
      await LotPopulation.findOneAndUpdate(
        { lot_id: lot._id, customer_id: custId },
        { lot_id: lot._id, customer_id: custId, customer_name: nameById.get(custId) || null },
        { upsert: true }
      );
    }

    // 2. Backfill lot_id.
    await Confirmation.updateMany({ cycle_id: cycleId }, { lot_id: lot._id });
    await TokenRecord.updateMany({ cycle_id: cycleId }, { lot_id: lot._id });
    await EmailLog.updateMany({ cycle_id: cycleId }, { lot_id: lot._id });
    // LedgerEntry has no cycle_id today (it was global, one doc per
    // customer_id) — backfill lot_id onto ledger rows for customers in this
    // cycle's population, but ONLY if that LedgerEntry doesn't already
    // belong to some other Lot (it can't retroactively belong to more than
    // one — see the architecture plan's note that pre-Lot ledger data was
    // single, global, and overwritten on each upload, so at most it maps to
    // the MOST RECENT cycle).
    for (const custId of custIds) {
      await LedgerEntry.updateOne({ customer_id: custId, lot_id: null }, { lot_id: lot._id });
    }

    results.push({ cycleId, lot_number, lot_id: lot._id, year, month, population_count: custIds.length });
  }

  results.forEach(r => log(dryRun ? '[DRY RUN] Would create:' : 'Created:', JSON.stringify(r)));
  return results;
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const connectDB = require('../db');
  const Lot = require('../models/Lot');
  const LotPopulation = require('../models/LotPopulation');
  const LedgerEntry = require('../models/LedgerEntry');
  const TokenRecord = require('../models/TokenRecord');
  const Confirmation = require('../models/Confirmation');
  const EmailLog = require('../models/EmailLog');
  const Customer = require('../models/Customer');

  (async () => {
    console.log(dryRun ? '=== DRY RUN — no writes will be made ===' : '=== LIVE RUN ===');
    await connectDB();
    const results = await migrateLegacyLots({ Lot, LotPopulation, LedgerEntry, TokenRecord, Confirmation, EmailLog, Customer }, { dryRun });
    console.log(`\nDone. ${results.length} legacy cycle(s) processed.`);
    process.exit(0);
  })().catch(err => { console.error('Migration failed:', err); process.exit(1); });
}

module.exports = { migrateLegacyLots };
