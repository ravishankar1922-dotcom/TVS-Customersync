const mongoose = require('mongoose');
const cfg = require('./config');

async function connectDB() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(cfg.MONGO_URI);
  console.log(`  MongoDB      : connected → ${cfg.MONGO_URI.replace(/\/\/.*@/, '//***@')}`);
}

module.exports = connectDB;
