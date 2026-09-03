const mongoose = require('mongoose');

const AdminSchema = new mongoose.Schema({
  email:         { type: String, required: true, unique: true, lowercase: true, trim: true },
  password_hash: { type: String, required: true },
  name:          { type: String, default: 'Admin' },
  role:          { type: String, enum: ['ADMIN', 'AR_TEAM', 'VIEWER'], default: 'ADMIN' },
}, { timestamps: true });

module.exports = mongoose.model('Admin', AdminSchema);
