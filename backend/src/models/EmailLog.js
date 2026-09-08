const mongoose = require('mongoose');

const EmailLogSchema = new mongoose.Schema({
  customer_id:   { type: String, required: true, index: true },
  customer_name: String,
  email:         String,
  cycle_id:      String,
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
