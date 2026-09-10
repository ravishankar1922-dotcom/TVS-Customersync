const mongoose = require('mongoose');

// The join that makes "only the customers actually in this Lot's uploaded
// ledger are active for this Lot" real — see spec section 4. Created ONLY
// from what a Lot's ledger upload actually contains, never from the full
// Customer master. This is what every Lot-scoped screen (Overview,
// confirmation targeting, reconciliation, reporting) filters against.
const LotPopulationSchema = new mongoose.Schema({
  lot_id:       { type: mongoose.Schema.Types.ObjectId, ref: 'Lot', required: true, index: true },
  customer_id:  { type: String, required: true, index: true },
  customer_name: { type: String },
  opening_balance: { type: Number, default: 0 }, // sum of that customer's OPEN transactions in this Lot's ledger
  added_at:     { type: Date, default: Date.now },
}, { timestamps: true });

LotPopulationSchema.index({ lot_id: 1, customer_id: 1 }, { unique: true });

module.exports = mongoose.model('LotPopulation', LotPopulationSchema);
