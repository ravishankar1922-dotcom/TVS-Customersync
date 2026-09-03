const mongoose = require('mongoose');

const CustomerSchema = new mongoose.Schema({
  customer_id:   { type: String, required: true, unique: true, index: true },
  customer_name: { type: String, required: true },
  company:       { type: String, default: 'TSL' },
  email:         { type: String },
  pan:           { type: String, required: true, uppercase: true, trim: true }, // used as second factor on portal
  status:        { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
  scenario:      { type: String }, // demo/test tagging, harmless to keep
}, { timestamps: true });

module.exports = mongoose.model('Customer', CustomerSchema);
