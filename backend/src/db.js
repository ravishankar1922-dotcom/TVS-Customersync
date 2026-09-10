const mongoose = require('mongoose');
const cfg = require('./config');

// Sept 2026 fix: a live database created BEFORE the Lot architecture change
// (see BalanceSync_Lot_Architecture_Plan.md) still physically carries the
// old single-field unique index `ledgerentries.customer_id_1` — from when
// LedgerEntry.customer_id was globally unique, one document per customer.
// The current schema (models/LedgerEntry.js) only declares a COMPOUND
// unique index on {lot_id, customer_id} instead, but changing the Mongoose
// schema in code has NO effect on indexes MongoDB already built on disk —
// nothing in this codebase ever explicitly dropped the old one. Result: the
// very first time a second Lot's ledger upload (or any second LedgerEntry
// for the same customer) tried to insert, MongoDB itself rejected it with
// E11000 on customer_id_1, regardless of lot_id — a real production
// failure this sandbox's in-memory test models can't reproduce (they don't
// enforce indexes at all).
//
// Fix: after every connect, diff-and-sync each affected model's indexes
// against its current schema — this creates whatever is missing (e.g. the
// compound {lot_id,customer_id} index) and drops whatever the live
// collection has that the schema no longer declares (e.g. the stale
// customer_id_1). Idempotent and safe to run on every boot: once the
// collection matches the schema, syncIndexes() is a no-op. Wrapped so a
// permissions issue on a locked-down Atlas user logs a warning (with the
// manual `db.ledgerentries.dropIndex('customer_id_1')` fallback) instead of
// blocking startup — the app still runs, just with the legacy index still
// live until someone runs that manually or grants the broader permission.
const LEGACY_INDEX_MODELS = ['LedgerEntry', 'Confirmation'];

async function syncLegacyIndexes() {
  for (const name of LEGACY_INDEX_MODELS) {
    try {
      const Model = require(`./models/${name}`);
      const result = await Model.syncIndexes();
      if (Array.isArray(result) && result.length) {
        console.log(`  MongoDB      : synced indexes on ${Model.collection.collectionName} (dropped/rebuilt: ${result.join(', ')})`);
      }
    } catch (err) {
      console.warn(`  MongoDB      : could not sync indexes on ${name} (${err.message}). If you see an E11000 duplicate-key error mentioning an old single-field index (e.g. "customer_id_1"), run this once against the database directly: db.${name.toLowerCase()}s.dropIndex('customer_id_1')`);
    }
  }
}

async function connectDB() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(cfg.MONGO_URI);
  console.log(`  MongoDB      : connected → ${cfg.MONGO_URI.replace(/\/\/.*@/, '//***@')}`);
  await syncLegacyIndexes();
}

module.exports = connectDB;
