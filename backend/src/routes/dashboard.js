const express = require('express');
const router  = express.Router();
const cfg     = require('../config');
const Customer = require('../models/Customer');
const Confirmation = require('../models/Confirmation');
const TokenRecord = require('../models/TokenRecord');
const EmailLog = require('../models/EmailLog');
const LedgerEntry = require('../models/LedgerEntry');
const { requireAdmin } = require('../middleware/auth');

router.get('/', requireAdmin, async (req, res) => {
  const [total, cycleConfs, cycleTokens, cycleEmails, ledgers] = await Promise.all([
    Customer.countDocuments(),
    Confirmation.find({ cycle_id: cfg.CYCLE_ID }).lean(),
    TokenRecord.find({ cycle_id: cfg.CYCLE_ID }).lean(),
    EmailLog.find({ cycle_id: cfg.CYCLE_ID }).lean(),
    LedgerEntry.find().lean(),
  ]);

  const submitted   = cycleConfs.length;
  const matched     = cycleConfs.filter(c => c.status === 'MATCHED').length;
  const difference  = cycleConfs.filter(c => c.status === 'DIFFERENCE').length;
  const pending     = total - submitted;
  const reconDone   = cycleConfs.filter(c => c.recon_status === 'COMPLETED').length;
  const reconInProg = cycleConfs.filter(c => c.recon_status === 'IN_PROGRESS').length;
  const sentToCust  = cycleConfs.filter(c => c.recon_sent_to_customer_at).length;
  const drafted     = cycleEmails.filter(e => e.status === 'SENT' || e.status === 'DRAFT_CREATED').length;
  const emailsReady = cycleTokens.filter(t => t.status === 'ACTIVE').length;

  const totalVariance = cycleConfs.filter(c => c.status === 'DIFFERENCE').reduce((s, c) => s + Math.abs(c.difference || 0), 0);
  const totalSapBalance = ledgers.reduce((sum, l) => sum + (l.transactions || []).filter(t => t.status === 'OPEN').reduce((s, t) => s + (t.amount || 0), 0), 0);
  const responseRate = total > 0 ? Math.round((submitted / total) * 100) : 0;

  res.json({
    cycle_id: cfg.CYCLE_ID, company: cfg.COMPANY, as_of_date: cfg.AS_OF_DATE,
    total_customers: total, submitted, matched, difference, pending,
    recon_completed: reconDone, recon_in_progress: reconInProg, recon_sent_to_customer: sentToCust,
    emails_drafted: drafted, emails_ready: emailsReady,
    total_variance: parseFloat(totalVariance.toFixed(2)), total_sap_balance: parseFloat(totalSapBalance.toFixed(2)),
    response_rate: responseRate,
  });
});

module.exports = router;
