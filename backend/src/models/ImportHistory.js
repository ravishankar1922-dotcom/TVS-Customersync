const mongoose = require('mongoose');

const ImportHistorySchema = new mongoose.Schema({
  import_id:          String,
  filename:            String,
  customers_updated:   Number,
  total_transactions:  Number,
  imported_by:         String,
  imported_at:         Date,
}, { timestamps: true });

module.exports = mongoose.model('ImportHistory', ImportHistorySchema);
