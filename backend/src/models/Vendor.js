const mongoose = require('mongoose');

// Vendor master — a FULLY SEPARATE collection from Customer (explicit
// architecture decision, see BalanceSync_Lot_Architecture_Plan.md phase 4:
// "Vendor data = Fully separate collections"). A Vendor record can never
// appear in a Customer workflow and vice versa: every Vendor-facing route
// queries THIS model, never Customer, and Lot.business_type gates which
// master a given Lot's population is drawn from (see routes/lots.js).
const VendorSchema = new mongoose.Schema({
  vendor_id:   { type: String, required: true, unique: true, index: true },
  vendor_name: { type: String, required: true },
  company:     { type: String, default: 'TSL' },
  email:       { type: String },
  pan:         { type: String, required: true, uppercase: true, trim: true }, // same two-factor portal gate as Customer
  status:      { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
}, { timestamps: true });

module.exports = mongoose.model('Vendor', VendorSchema);
