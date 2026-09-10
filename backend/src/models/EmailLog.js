const mongoose = require('mongoose');

const EmailLogSchema = new mongoose.Schema({
  customer_id:   { type: String, required: true, index: true },
  customer_name: String,
  email:         String,
  cycle_id:      String,
  // Phase 2: nullable — set only for emails sent through the Lot-scoped
  // targeted-send endpoint (routes/lots.js), so email history stays
  // queryable per Lot+customer without disturbing legacy log rows.
  lot_id:        { type: mongoose.Schema.Types.ObjectId, ref: 'Lot', default: null, index: true },
  token_id:      String,
  portal_url:    String,
  subject:       String,
  kind:          { type: String, enum: ['CONFIRMATION_REQUEST', 'RECON_COMPLETE', 'REMINDER'], default: 'CONFIRMATION_REQUEST' },
  reminder_count: { type: Number, default: 0 },
  status:        String, // SENT | FAILED | DRAFT_CREATED | OUTLOOK_UNAVAILABLE | READY
  error:         String,
  sent_at:       Date,
}, { timestamps: true });

module.exports = mongoose.model('EmailLog', EmailLogSchema);
