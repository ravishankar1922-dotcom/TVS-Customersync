/**
 * One-off fix for: "E11000 duplicate key error collection:
 * balancesync.ledgerentries index: customer_id_1 dup key: { customer_id: ... }"
 * while uploading a ledger (Sept 2026).
 *
 * WHY THIS HAPPENS: this database was created before the Lot architecture
 * change (see BalanceSync_Lot_Architecture_Plan.md). Back then,
 * LedgerEntry.customer_id was globally unique — one ledger document per
 * customer, period. The current schema (models/LedgerEntry.js) replaced
 * that with a COMPOUND unique index on {lot_id, customer_id} instead, so a
 * customer can have one LedgerEntry per Lot. But changing the Mongoose
 * schema in code only affects what NEW deploys try to create — it has NO
 * effect on an index MongoDB already built on disk for this collection.
 * The old single-field `customer_id_1` unique index is still physically
 * there, silently rejecting the second (or any later) Lot's ledger upload
 * for a customer who already has a LedgerEntry from an earlier Lot/upload.
 *
 * WHAT THIS SCRIPT DOES: connects to the database and calls
 * LedgerEntry.syncIndexes() (and the same for Confirmation, which had an
 * analogous legacy shape), which diffs the live collection's indexes
 * against the CURRENT schema and drops/creates whatever's needed — in
 * practice here, dropping the stale `customer_id_1` index and making sure
 * the compound {lot_id, customer_id} one exists. It does not touch, delete,
 * or modify any actual document/data — only index metadata.
 *
 * This is now also run automatically on every server startup (see db.js),
 * so this script is only needed if you want the fix applied immediately
 * without restarting the server, or if the automatic run logged a
 * permissions warning and you need to run it with elevated DB credentials.
 *
 * USAGE (from the backend/ directory):
 *   node src/scripts/fix-legacy-ledger-index.js
 */
const connectDB = require('../db'); // connecting already runs syncLegacyIndexes() — see db.js

(async () => {
  console.log('Connecting and syncing indexes (this also runs automatically on every server start)...');
  await connectDB();
  console.log('\nDone. The legacy customer_id_1 index (if it existed) has been dropped, and the');
  console.log('current schema\'s indexes (including the compound {lot_id, customer_id} unique index) are in place.');
  console.log('Ledger uploads for a customer who already appears in another Lot should now succeed.');
  process.exit(0);
})().catch(err => {
  console.error('\nIndex sync failed:', err.message);
  console.error('If your database user lacks index-management permission, run this manually against the');
  console.error('database instead (e.g. in mongosh or MongoDB Atlas\' console):');
  console.error("  db.ledgerentries.dropIndex('customer_id_1')");
  process.exit(1);
});
