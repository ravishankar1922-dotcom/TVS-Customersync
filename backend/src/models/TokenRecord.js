const mongoose = require('mongoose');

const TokenRecordSchema = new mongoose.Schema({
  token_id:    { type: String, required: true, unique: true },
  customer_id: { type: String, required: true, index: true },
  cycle_id:    { type: String, required: true },
  company:     String,
  token:       { type: String, required: true },
  portal_url:  String,
  created_at:  Date,
  expires_at:  { type: Date, required: true },
  status:      { type: String, enum: ['ACTIVE', 'USED', 'REVOKED', 'EXPIRED'], default: 'ACTIVE' },
  used_at:     Date,
  pan_verified_at: Date, // set once the customer successfully passes the PAN gate
}, { timestamps: true });

module.exports = mongoose.model('TokenRecord', TokenRecordSchema);
