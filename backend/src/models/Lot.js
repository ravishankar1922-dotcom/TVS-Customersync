const mongoose = require('mongoose');

// The primary confirmation-exercise container (see BalanceSync_Lot_Architecture_Plan.md).
// Every fresh ledger/period creates a new Lot; nothing about a Lot's data
// (population, confirmations, SOAs, reconciliation, workflow, emails) is
// ever shared with another Lot, even for the same customer.
const LotSchema = new mongoose.Schema({
  lot_number:   { type: String, required: true, unique: true, index: true }, // e.g. LOT-2026-03-001
  period_year:  { type: Number, required: true },
  period_month: { type: Number, required: true, min: 1, max: 12 },
  period_label: { type: String, required: true }, // e.g. "March 2026" — display-only, derived from year/month
  business_type: { type: String, enum: ['CUSTOMER', 'VENDOR'], default: 'CUSTOMER', index: true },
  status:       { type: String, enum: ['DRAFT', 'ACTIVE', 'CLOSED'], default: 'DRAFT' },
  created_by:   { type: String }, // admin email
  ledger_upload_date: { type: Date, default: null },
  ledger_filename:    { type: String, default: null },
  population_count:      { type: Number, default: 0 }, // customers/vendors actually present in this Lot's ledger
  total_ledger_balance:  { type: Number, default: 0 }, // sum of OPEN transaction amounts across the Lot population
  // Set only on Lots created by the legacy-data migration (see
  // scripts/migrate-legacy-lots.js) — makes it visually obvious in the
  // Overview that a Lot's population/history was inferred from pre-Lot
  // data rather than created through the normal Lot-creation flow.
  is_legacy:    { type: Boolean, default: false },
  legacy_cycle_id: { type: String, default: null },
}, { timestamps: true });

LotSchema.index({ period_year: 1, period_month: 1, business_type: 1 });

module.exports = mongoose.model('Lot', LotSchema);
