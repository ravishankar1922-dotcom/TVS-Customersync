const mongoose = require('mongoose');

const ConfirmationSchema = new mongoose.Schema({
  customer_id:  { type: String, required: true, index: true },
  // cycle_id stays required — it's the sole scoping key for the untouched
  // legacy flow. Lot-scoped confirmations (phase 2) set lot_id instead and
  // carry cycle_id only informationally (the Lot's lot_number), never as
  // the scoping key — see the CRITICAL DB RULE note below.
  cycle_id:     { type: String, required: true },
  // ── Phase 2: Lot-aware confirmations ────────────────────────────────────
  // CRITICAL DB RULE (spec): a Confirmation must never be looked up by
  // customer_id alone once Lots exist — the same customer can have a
  // separate, fully independent Confirmation in every Lot they appear in.
  // Every Lot-scoped query in routes/lots.js therefore filters by BOTH
  // lot_id AND customer_id together. null/default for every legacy record.
  lot_id:       { type: mongoose.Schema.Types.ObjectId, ref: 'Lot', default: null, index: true },
  // Points at the CURRENT SubmissionVersion (see models/SubmissionVersion.js)
  // for this Lot+customer — the version history itself lives there, never
  // overwritten; this is just "which one is current" for fast reads.
  current_version: { type: Number, default: 1 },
  token_id:     String,
  sap_balance:  Number,
  cust_balance: Number,
  difference:   Number,
  remarks:      String,
  soa_filename: String,
  soa_path:     String,   // legacy — old records only, no longer written
  soa_size:     Number,
  soa_mimetype: String,
  soa_data:     Buffer,   // file bytes stored directly in MongoDB (Render's local
                          // disk is ephemeral and wipes on every restart/redeploy,
                          // which silently lost customer-submitted SOA files —
                          // storing in Atlas instead means it survives restarts)
  status:       { type: String, enum: ['MATCHED', 'DIFFERENCE'], default: 'DIFFERENCE' },
  recon_status: { type: String, enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED'], default: 'PENDING' },
  recon_notes:  String,
  recon_completed_at: Date,
  recon_sent_to_customer_at: Date,
  root_causes:  { type: Map, of: String, default: {} }, // keyed by result line index
  submitted_at: Date,

  // ── Phase 5: Finance clarification workflow state machine ──────────────
  // Lot-scoped confirmations only (legacy flow doesn't route through
  // Finance). ADMIN_REVIEW is the resting/default state after a customer
  // submits; Admin can route to FINANCE_REVIEW with a comment; Finance can
  // route back to ADMIN_REVIEW or out to CUSTOMER_CLARIFICATION (which
  // emails the customer); the customer's next submission/amendment always
  // returns the record to ADMIN_REVIEW. See routes/lots.js's
  // route-to-finance / route-to-admin / route-to-customer endpoints.
  workflow_status: { type: String, enum: ['ADMIN_REVIEW', 'FINANCE_REVIEW', 'CUSTOMER_CLARIFICATION', 'COMPLETED'], default: 'ADMIN_REVIEW' },
  workflow_comment: String, // the comment attached to the most recent routing action

  // ── Admin-approved SOA re-upload SOP ──────────────────────────────────
  // Customer requests a re-upload (e.g. they submitted the wrong SOA);
  // admin must approve before the customer's link accepts a new submission.
  // Every prior submission is preserved in soa_history so admin can see/
  // download any version, but reconciliation always runs off the latest
  // (the live soa_* fields above).
  reupload_status:      { type: String, enum: ['NONE', 'REQUESTED', 'APPROVED'], default: 'NONE' },
  reupload_reason:      String,
  reupload_requested_at: Date,
  reupload_approved_at:  Date,
  soa_history: [{
    soa_filename: String, soa_mimetype: String, soa_size: Number, soa_data: Buffer,
    sap_balance: Number, cust_balance: Number, difference: Number,
    submitted_at: Date, archived_at: { type: Date, default: Date.now },
  }],
}, { timestamps: true });

ConfirmationSchema.index({ customer_id: 1, cycle_id: 1 }, { unique: true });
// Lot-scoped uniqueness — partial so it never collides with (or is affected
// by) the millions of possible legacy null-lot_id documents matching the
// same customer_id under the old index above.
ConfirmationSchema.index(
  { lot_id: 1, customer_id: 1 },
  { unique: true, partialFilterExpression: { lot_id: { $type: 'objectId' } } }
);

module.exports = mongoose.model('Confirmation', ConfirmationSchema);
