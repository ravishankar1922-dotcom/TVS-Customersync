const express = require('express');
const router  = express.Router();
const cfg     = require('../config');
const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const LedgerEntry = require('../models/LedgerEntry');
const TokenRecord = require('../models/TokenRecord');
const EmailLog = require('../models/EmailLog');
const { requireAdmin } = require('../middleware/auth');

// GET /api/system/health — public, no secrets exposed
router.get('/health', async (req, res) => {
  const dbOk = mongoose.connection.readyState === 1;
  const [customerCount, ledgerCount, tokenCount, emailCount] = dbOk ? await Promise.all([
    Customer.countDocuments(), LedgerEntry.countDocuments(), TokenRecord.countDocuments(), EmailLog.countDocuments(),
  ]) : [0, 0, 0, 0];

  res.json({
    ok: dbOk,
    cycle_id: cfg.CYCLE_ID,
    company: cfg.COMPANY,
    as_of_date: cfg.AS_OF_DATE,
    customer_count: customerCount,
    ledger_count: ledgerCount,
    checks: {
      database:       { exists: dbOk, path: 'MongoDB', type: 'database' },
      customerMaster: { exists: customerCount > 0, path: 'Customer collection', type: 'collection', count: customerCount },
      ledger:         { exists: ledgerCount > 0, path: 'LedgerEntry collection', type: 'collection', count: ledgerCount },
      tokenRegistry:  { exists: true, path: 'TokenRecord collection', type: 'collection', count: tokenCount },
      emailLog:       { exists: true, path: 'EmailLog collection', type: 'collection', count: emailCount },
    },
  });
});

// GET /api/system/config — safe subset only
router.get('/config', (req, res) => {
  res.json({
    cycleId: cfg.CYCLE_ID,
    company: cfg.COMPANY,
    asOfDate: cfg.AS_OF_DATE,
    tokenExpiryHours: cfg.TOKEN_EXPIRY_HOURS,
  });
});

module.exports = router;
