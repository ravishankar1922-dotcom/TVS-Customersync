/**
 * One-off fix for: "I uploaded 2 customer's SOA but it is not showing in
 * admin. Why?" (Sept 2026).
 *
 * WHY THIS HAPPENS: the customer portal (frontend/src/components/portal/
 * CustomerPortal.jsx) always posted a submission to the LEGACY endpoint
 * (POST /api/confirmations/submit), even for a customer whose token was
 * issued through a Lot (routes/lots.js's /tokens/generate). The legacy
 * route upserts a Confirmation but never sets lot_id — it stays null (the
 * schema default). The ONLY admin screen that exists today, Lot Overview,
 * reads confirmations with Confirmation.find({ lot_id: <the open Lot> }),
 * so a null-lot_id record never appears there or anywhere else in the UI —
 * it silently saved (the customer's "submitted successfully" screen was
 * real) but became an orphan only visible in the raw Audit Log.
 *
 * The portal has been fixed (CustomerPortal.jsx now posts to the Lot-scoped
 * endpoint whenever the token carries lot info) so this cannot recur for
 * NEW submissions. This script repairs confirmations that already went in
 * under the old, broken code path: for every Confirmation with lot_id:null,
 * it looks up that customer's most recent Lot-issued TokenRecord, backfills
 * lot_id/cycle_id/workflow_status onto the Confirmation, and creates the
 * matching version-1 SubmissionVersion record so the Lot-scoped screens
 * (Overview, Reconciliation Studio, exports) see it exactly as if it had
 * come in through the fixed endpoint. It does not touch any Confirmation
 * that already has a lot_id, and it does not touch any Confirmation with no
 * Lot-issued token at all (genuinely legacy, pre-Lot submissions) — those
 * are left as-is and reported separately.
 *
 * USAGE (from the backend/ directory):
 *   node src/scripts/fix-orphaned-confirmations.js         # dry run (default)
 *   node src/scripts/fix-orphaned-confirmations.js --apply # actually writes
 */
const connectDB = require('../db');
const Confirmation = require('../models/Confirmation');
const TokenRecord = require('../models/TokenRecord');
const SubmissionVersion = require('../models/SubmissionVersion');
const Lot = require('../models/Lot');

const APPLY = process.argv.includes('--apply');

(async () => {
  await connectDB();

  const orphans = await Confirmation.find({ lot_id: null }).lean();
  if (!orphans.length) {
    console.log('No orphaned confirmations found (every Confirmation already has a lot_id). Nothing to do.');
    process.exit(0);
  }

  console.log(`Found ${orphans.length} confirmation(s) with no lot_id.\n`);

  let fixed = 0, skipped = 0;
  for (const conf of orphans) {
    // Prefer the exact token the submission was made with; fall back to
    // this customer's most recently issued Lot token if the stored
    // token_id doesn't resolve (e.g. it was later reset/regenerated).
    let tokenRec = conf.token_id ? await TokenRecord.findOne({ token_id: conf.token_id }) : null;
    if (!tokenRec || !tokenRec.lot_id) {
      tokenRec = await TokenRecord.findOne({ customer_id: conf.customer_id, lot_id: { $ne: null } }).sort({ createdAt: -1 });
    }

    if (!tokenRec || !tokenRec.lot_id) {
      console.log(`  SKIP  ${conf.customer_id} — no Lot-issued token found; this looks like a genuine legacy (pre-Lot) submission, not the bug. Left untouched.`);
      skipped++;
      continue;
    }

    const lot = await Lot.findById(tokenRec.lot_id).lean();
    if (!lot) {
      console.log(`  SKIP  ${conf.customer_id} — token references Lot ${tokenRec.lot_id} which no longer exists.`);
      skipped++;
      continue;
    }

    console.log(`  FIX   ${conf.customer_id} -> Lot ${lot.lot_number} (${lot.period_label})`);
    if (!APPLY) { fixed++; continue; }

    await Confirmation.updateOne(
      { _id: conf._id },
      {
        $set: {
          lot_id: lot._id,
          cycle_id: lot.lot_number,
          token_id: tokenRec.token_id,
          current_version: 1,
          workflow_status: 'ADMIN_REVIEW',
        },
      }
    );

    // Only backfill a SubmissionVersion if one doesn't already exist for
    // this {lot_id, customer_id} — safe to re-run the script.
    const existingVersion = await SubmissionVersion.findOne({ lot_id: lot._id, customer_id: conf.customer_id });
    if (!existingVersion) {
      await SubmissionVersion.create({
        lot_id: lot._id, customer_id: conf.customer_id, version: 1, status: 'CURRENT',
        sap_balance: conf.sap_balance, cust_balance: conf.cust_balance, difference: conf.difference,
        remarks: conf.remarks || '', comment: '',
        soa_filename: conf.soa_filename, soa_mimetype: conf.soa_mimetype, soa_size: conf.soa_size, soa_data: conf.soa_data,
        submitted_at: conf.submitted_at || new Date(), actor: `CUSTOMER:${conf.customer_id}`,
      });
    }

    fixed++;
  }

  console.log(`\n${APPLY ? 'Applied' : 'Would apply'}: ${fixed} fixed, ${skipped} skipped.`);
  if (!APPLY) console.log('This was a DRY RUN — no data was changed. Re-run with --apply to write the fix.');
  process.exit(0);
})().catch(err => {
  console.error('\nBackfill failed:', err.message);
  process.exit(1);
});
