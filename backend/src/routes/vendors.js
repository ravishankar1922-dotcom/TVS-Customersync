/**
 * Vendor module (phase 4 — see BalanceSync_Lot_Architecture_Plan.md).
 * A fully separate collection/route file from Customer — never shares a
 * model, a query, or a portal token payload's identity with the Customer
 * flow. This mirrors the minimal subset of routes/customers.js that the
 * Lot-scoped confirmation flow (routes/lots.js) actually needs to look up
 * vendor names/emails/PANs for VENDOR-business-type Lots; it deliberately
 * does not duplicate every Customer-side dashboard feature.
 */
const express = require('express');
const router  = express.Router();
const Vendor  = require('../models/Vendor');
const { requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

// GET /api/vendors — admin only
router.get('/', requireAdmin, async (req, res) => {
  const vendors = await Vendor.find().sort({ vendor_id: 1 }).lean();
  res.json({ vendors });
});

// GET /api/vendors/:vendorId
router.get('/:vendorId', requireAdmin, async (req, res) => {
  const vendor = await Vendor.findOne({ vendor_id: req.params.vendorId }).lean();
  if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
  res.json({ vendor });
});

// POST /api/vendors/import-json — admin only, same shape/semantics as
// /api/customers/import-json (append or replace-all, optional dry run) but
// against the separate Vendor collection.
router.post('/import-json', requireAdmin, async (req, res) => {
  const { vendors, mode, dryRun } = req.body || {};
  if (!Array.isArray(vendors) || !vendors.length) return res.status(400).json({ error: 'vendors must be a non-empty array' });

  const invalid = vendors.filter(v => !v.vendor_id || !v.vendor_name || !v.pan);
  if (invalid.length) return res.status(400).json({ error: `${invalid.length} row(s) missing vendor_id/vendor_name/pan`, sample: invalid.slice(0, 3) });

  if (dryRun) return res.json({ ok: true, dryRun: true, would_upsert: vendors.length, mode: mode || 'append' });

  if (mode === 'replace') await Vendor.deleteMany({});

  let upserted = 0;
  for (const v of vendors) {
    await Vendor.findOneAndUpdate(
      { vendor_id: v.vendor_id },
      { vendor_id: v.vendor_id, vendor_name: v.vendor_name, company: v.company || 'TSL', email: v.email, pan: v.pan, status: v.status || 'ACTIVE' },
      { upsert: true }
    );
    upserted++;
  }

  await logAudit({ req, action: 'VENDOR_MASTER_JSON_IMPORTED', entity_type: 'Vendor', details: { count: upserted, mode: mode || 'append' } });
  res.json({ ok: true, upserted, mode: mode || 'append' });
});

module.exports = router;
