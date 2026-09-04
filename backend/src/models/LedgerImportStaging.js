const mongoose = require('mongoose');

// Holds a parsed-but-not-yet-confirmed ledger upload between the
// preview step and the "confirm import" step. Stored in MongoDB (not on
// Render's local disk, which is ephemeral and wipes on restart/redeploy)
// so the admin's preview survives even if the backend redeploys/restarts
// in between the two clicks. Auto-expires after 6 hours via TTL index —
// an abandoned upload shouldn't linger forever.
const LedgerImportStagingSchema = new mongoose.Schema({
  import_id:     { type: String, required: true, unique: true },
  filename:      String,
  transactions:  { type: Array, default: [] },
  headers:       { type: Array, default: [] },
  col_mappings:  { type: mongoose.Schema.Types.Mixed, default: {} },
  created_at:    { type: Date, default: Date.now, expires: 21600 }, // 6h TTL
});

module.exports = mongoose.model('LedgerImportStaging', LedgerImportStagingSchema);
