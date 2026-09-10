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
const multer  = require('multer');
const Vendor  = require('../models/Vendor');
const { requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { parseMasterFile } = require('../utils/masterFileParser');

const MAX_MASTER_MB = 20;
const masterUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MASTER_MB * 1024 * 1024 } });

const VENDOR_FIELDS = [
  { key: 'vendor_id',   aliases: ['vendor_id', 'vendor id', 'id', 'vendor code', 'code'] },
  { key: 'vendor_name', aliases: ['vendor_name', 'vendor name', 'name'] },
  { key: 'email',       aliases: ['email', 'email address', 'e mail'] },
  { key: 'pan',         aliases: ['pan', 'pan number', 'pan no'] },
  { key: 'company',     aliases: ['company', 'company code'] },
  { key: 'status',      aliases: ['status'] },
];

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

// POST /api/vendors/import — bulk upsert vendor master from an uploaded FILE
// (Sept 2026: same fix as customers.js's /import — Excel/CSV or JSON, auto-
// detected, flexible header matching). mode:'replace' (default, matches
// import-json's existing semantics above) wipes and replaces the whole
// Vendor collection with the uploaded rows; mode:'append' only inserts
// vendor_ids not already on file.
router.post('/import', requireAdmin, masterUpload.single('master_file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const mode = req.body?.mode === 'append' ? 'append' : 'replace';
  const dryRun = req.body?.dryRun === 'true' || req.body?.dryRun === true;

  let vendors;
  try { vendors = parseMasterFile(req.file.buffer, req.file.originalname, VENDOR_FIELDS, ['vendors']); }
  catch (err) { return res.status(400).json({ error: 'Failed to parse vendor master file: ' + err.message }); }
  if (!vendors.length) return res.status(400).json({ error: 'No rows found in this file.' });

  const invalid = vendors.filter(v => !v.vendor_id || !v.vendor_name || !v.pan);
  if (invalid.length) return res.status(400).json({ error: `${invalid.length} row(s) missing a vendor id/name/PAN`, sample: invalid.slice(0, 3) });

  if (dryRun) return res.json({ ok: true, dryRun: true, would_upsert: vendors.length, mode, filename: req.file.originalname });

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

  await logAudit({ req, action: 'VENDOR_MASTER_FILE_IMPORTED', entity_type: 'Vendor', details: { filename: req.file.originalname, count: upserted, mode } });
  res.json({ ok: true, upserted, mode, filename: req.file.originalname });
});

module.exports = router;
