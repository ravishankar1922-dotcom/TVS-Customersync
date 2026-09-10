const mongoose = require('mongoose');

/**
 * Every amendment a customer makes to a Lot-scoped confirmation creates a
 * NEW SubmissionVersion — never overwrites the previous one (spec: "Every
 * amendment must create a versioned submission"). The Confirmation document
 * itself always mirrors the CURRENT version's fields for fast reads
 * (dashboard, exports, reconciliation), but the full trail — every balance,
 * every SOA file, every comment, who submitted it and when — lives here,
 * permanently, and stays reachable even after a newer version supersedes it.
 *
 * Scoped by {lot_id, customer_id, version} — never customer_id alone, per
 * the same cross-Lot isolation rule as Confirmation/LedgerEntry.
 */
const SubmissionVersionSchema = new mongoose.Schema({
  lot_id:      { type: mongoose.Schema.Types.ObjectId, ref: 'Lot', required: true, index: true },
  customer_id: { type: String, required: true, index: true },
  version:     { type: Number, required: true }, // 1, 2, 3... — never reused, never renumbered
  status:      { type: String, enum: ['CURRENT', 'SUPERSEDED'], default: 'CURRENT' },

  sap_balance:  Number,
  cust_balance: Number,
  difference:   Number,
  remarks:      String,
  comment:      String, // free-text note attached to this specific amendment (distinct from `remarks`, which mirrors the portal form field)

  soa_filename: String,
  soa_mimetype: String,
  soa_size:     Number,
  soa_data:     Buffer, // original file preserved for every version, never discarded

  submitted_at: { type: Date, default: Date.now },
  actor:        String, // e.g. "CUSTOMER:TEST_C001" — who created this version
}, { timestamps: true });

SubmissionVersionSchema.index({ lot_id: 1, customer_id: 1, version: 1 }, { unique: true });

module.exports = mongoose.model('SubmissionVersion', SubmissionVersionSchema);
