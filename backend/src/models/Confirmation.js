const mongoose = require('mongoose');

const ConfirmationSchema = new mongoose.Schema({
  customer_id:  { type: String, required: true, index: true },
  cycle_id:     { type: String, required: true },
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

module.exports = mongoose.model('Confirmation', ConfirmationSchema);
