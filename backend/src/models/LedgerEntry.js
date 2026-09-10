const mongoose = require('mongoose');

const TxnSchema = new mongoose.Schema({
  document_number: String,
  document_type:   String,
  document_date:   String,
  due_date:         String,
  amount:           Number,
  currency:         { type: String, default: 'INR' },
  status:           { type: String, enum: ['OPEN', 'CLEARED'], default: 'OPEN' },
}, { _id: false });

// SCHEMA CHANGE (Lot architecture, phase 1): added lot_id, nullable, and
// replaced the old customer_id-only unique index with a compound
// (lot_id, customer_id) unique index. This is additive and backward
// compatible: every LedgerEntry document created before this change has no
// lot_id (undefined) and keeps working exactly as before through the
// existing (not-yet-Lot-aware) /api/ledger/* routes, since a compound
// unique index treats distinct customer_id values as distinct pairs
// regardless of lot_id. New Lot-scoped ledger uploads (POST
// /api/lots/:lotId/ledger/upload) set lot_id, so the SAME customer_id can
// now have one LedgerEntry per Lot without colliding — the whole point of
// "a fresh ledger/period must create a new Lot, never overwrite the last
// one" (spec section 3).
const LedgerEntrySchema = new mongoose.Schema({
  lot_id:       { type: mongoose.Schema.Types.ObjectId, ref: 'Lot', default: null, index: true },
  customer_id:  { type: String, required: true, index: true },
  transactions: [TxnSchema],
}, { timestamps: true });

LedgerEntrySchema.index({ lot_id: 1, customer_id: 1 }, { unique: true });

module.exports = mongoose.model('LedgerEntry', LedgerEntrySchema);
