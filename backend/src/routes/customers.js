const express = require('express');
const router  = express.Router();
const cfg     = require('../config');
const Customer = require('../models/Customer');
const LedgerEntry = require('../models/LedgerEntry');
const Confirmation = require('../models/Confirmation');
const TokenRecord = require('../models/TokenRecord');
const EmailLog = require('../models/EmailLog');
const { requireAdmin } = require('../middleware/auth');

function openBalance(ledgerDoc) {
  if (!ledgerDoc) return 0;
  return ledgerDoc.transactions.filter(t => t.status === 'OPEN').reduce((s, t) => s + (t.amount || 0), 0);
}

// GET /api/customers — admin only
router.get('/', requireAdmin, async (req, res) => {
  const [customers, confirmations, tokens, emails, ledgers] = await Promise.all([
    Customer.find().sort({ customer_id: 1 }).lean(),
    Confirmation.find({ cycle_id: cfg.CYCLE_ID }).lean(),
    TokenRecord.find({ cycle_id: cfg.CYCLE_ID }).lean(),
    EmailLog.find({ cycle_id: cfg.CYCLE_ID }).lean(),
    LedgerEntry.find().lean(),
  ]);
  if (!customers.length) return res.status(404).json({ error: 'No customers found. Seed the database first (npm run seed).' });

  const result = customers.map(c => {
    const conf  = confirmations.find(x => x.customer_id === c.customer_id);
    const token = tokens.find(t => t.customer_id === c.customer_id);
    const email = emails.find(e => e.customer_id === c.customer_id && e.kind !== 'RECON_COMPLETE');
    const led   = ledgers.find(l => l.customer_id === c.customer_id);

    return {
      ...c,
      sap_balance:      openBalance(led),
      cust_balance:     conf ? conf.cust_balance : null,
      difference:       conf ? conf.difference : null,
      status:           conf ? conf.status : 'PENDING',
      soa_file:         conf ? conf.soa_filename : null,
      submission_date:  conf ? conf.submitted_at : null,
      token_status:     token ? token.status : 'NOT_GENERATED',
      token_expires_at: token ? token.expires_at : null,
      email_status:     email ? email.status : 'NOT_SENT',
      recon_status:     conf ? (conf.recon_status || 'PENDING') : 'PENDING',
      recon_sent_to_customer_at: conf ? conf.recon_sent_to_customer_at : null,
    };
  });

  res.json({ customers: result, total: result.length });
});

// GET /api/customers/:id
router.get('/:id', requireAdmin, async (req, res) => {
  const customer = await Customer.findOne({ customer_id: req.params.id }).lean();
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const led = await LedgerEntry.findOne({ customer_id: req.params.id }).lean();
  res.json({ ...customer, sap_balance: openBalance(led), ledger: led });
});

// GET /api/customers/:id/ledger
router.get('/:id/ledger', requireAdmin, async (req, res) => {
  const led = await LedgerEntry.findOne({ customer_id: req.params.id }).lean();
  if (!led) return res.status(404).json({ error: 'Ledger not found for customer' });
  res.json(led);
});

module.exports = router;
