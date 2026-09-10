const mongoose = require('mongoose');

const AdminSchema = new mongoose.Schema({
  email:         { type: String, required: true, unique: true, lowercase: true, trim: true },
  password_hash: { type: String, required: true },
  name:          { type: String, default: 'Admin' },
  // FINANCE added (phase 4/5 — see BalanceSync_Lot_Architecture_Plan.md):
  // a distinct, restricted role for the clarification-workflow reviewer.
  // See middleware/auth.js's requireFinance/requireAdminOrFinance and the
  // explicit Finance permission list in the architecture doc — Finance does
  // NOT inherit ADMIN's system-config, master-data, token-generation or
  // audit-deletion rights just by having a role on the same Admin model.
  role:          { type: String, enum: ['ADMIN', 'AR_TEAM', 'VIEWER', 'FINANCE'], default: 'ADMIN' },
  // Which business line this login may act on — reused for authorization
  // instead of duplicating auth code per business type (spec: "prefer
  // role + business-type authorization over duplicating auth code").
  business_type: { type: String, enum: ['CUSTOMER', 'VENDOR', 'BOTH'], default: 'BOTH' },
}, { timestamps: true });

module.exports = mongoose.model('Admin', AdminSchema);
