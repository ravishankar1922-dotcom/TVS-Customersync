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

const LedgerEntrySchema = new mongoose.Schema({
  customer_id:  { type: String, required: true, unique: true, index: true },
  transactions: [TxnSchema],
}, { timestamps: true });

module.exports = mongoose.model('LedgerEntry', LedgerEntrySchema);
