const mongoose = require('mongoose');

const AuditLogSchema = new mongoose.Schema({
  actor:       { type: String, default: 'SYSTEM' },   // admin email, or "CUSTOMER:<id>", or "SYSTEM"
  actor_role:  { type: String, default: 'system' },    // admin | customer | system
  action:      { type: String, required: true },       // e.g. TOKEN_GENERATE, TOKEN_RESET, LEDGER_IMPORT, RECON_COMPLETE...
  entity_type: String,                                  // Customer | Token | Confirmation | Ledger | Admin
  entity_id:   String,
  details:     mongoose.Schema.Types.Mixed,
  ip:          String,
}, { timestamps: true });

module.exports = mongoose.model('AuditLog', AuditLogSchema);
