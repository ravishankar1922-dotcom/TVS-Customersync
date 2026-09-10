const mongoose = require('mongoose');

const TokenRecordSchema = new mongoose.Schema({
  token_id:    { type: String, required: true, unique: true },
  customer_id: { type: String, required: true, index: true },
  // cycle_id was the ONLY scoping key before Lots existed, so it stays
  // required for that legacy flow. Lot-scoped tokens (phase 2 — see
  // BalanceSync_Lot_Architecture_Plan.md) are scoped by lot_id instead and
  // don't need a fabricated cycle_id, so this is no longer `required`.
  cycle_id:    { type: String, default: null },
  // ── Phase 2 additions (Lot-aware confirmation/token rework) ────────────
  // Nullable/default so every pre-existing TokenRecord (and every route
  // that never mentions Lots) is completely unaffected. Set only by the
  // new Lot-scoped token-generation endpoint (routes/lots.js).
  lot_id:        { type: mongoose.Schema.Types.ObjectId, ref: 'Lot', default: null, index: true },
  business_type: { type: String, enum: ['CUSTOMER', 'VENDOR'], default: 'CUSTOMER' },
  company:     String,
  token:       { type: String, required: true },
  portal_url:  String,
  created_at:  Date,
  expires_at:  { type: Date, required: true },
  // NOTE ON THE "REMOVE SINGLE-USE BLOCKING" REQUIREMENT: 'USED' remains a
  // valid enum value because the legacy (non-Lot) confirmation flow in
  // routes/confirmations.js still uses it exactly as before — that flow is
  // untouched in phase 2. Lot-scoped submissions (routes/lots.js) never set
  // 'USED': the link stays 'ACTIVE' (reopenable) until it naturally expires
  // or an admin revokes it, per the spec's critical change.
  status:      { type: String, enum: ['ACTIVE', 'USED', 'REVOKED', 'EXPIRED'], default: 'ACTIVE' },
  used_at:     Date,
  pan_verified_at: Date, // set once the customer successfully passes the PAN gate
}, { timestamps: true });

TokenRecordSchema.index({ lot_id: 1, customer_id: 1 });

module.exports = mongoose.model('TokenRecord', TokenRecordSchema);
