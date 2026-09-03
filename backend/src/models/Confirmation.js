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
  soa_path:     String,
  soa_size:     Number,
  status:       { type: String, enum: ['MATCHED', 'DIFFERENCE'], default: 'DIFFERENCE' },
  recon_status: { type: String, enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED'], default: 'PENDING' },
  recon_notes:  String,
  recon_completed_at: Date,
  recon_sent_to_customer_at: Date,
  root_causes:  { type: Map, of: String, default: {} }, // keyed by result line index
  submitted_at: Date,
}, { timestamps: true });

ConfirmationSchema.index({ customer_id: 1, cycle_id: 1 }, { unique: true });

module.exports = mongoose.model('Confirmation', ConfirmationSchema);
