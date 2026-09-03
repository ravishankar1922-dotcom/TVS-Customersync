const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const cfg     = require('../config');
const TokenRecord  = require('../models/TokenRecord');
const Confirmation = require('../models/Confirmation');
const { requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const ALLOWED_EXT  = ['.xlsx', '.xls', '.csv', '.pdf'];
const MAX_SIZE_MB  = 20;
const SOA_ROOT = path.join(cfg.UPLOAD_ROOT, 'soa');

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const { cycle_id, customer_id } = req.body;
    const dir = path.join(SOA_ROOT, cycle_id || cfg.CYCLE_ID, customer_id || 'UNKNOWN');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const { customer_id } = req.body;
    const ext = path.extname(file.originalname).toLowerCase();
    const ts  = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').slice(0, 15);
    cb(null, `${customer_id}_${req.body.cycle_id || cfg.CYCLE_ID}_${ts}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.includes(ext)) cb(null, true);
    else cb(new Error(`File type not allowed. Accepted: ${ALLOWED_EXT.join(', ')}`));
  },
});

// POST /api/confirmations/submit — public (customer portal), but requires a
// token that has already passed the PAN gate (pan_verified_at set).
router.post('/submit', upload.single('soa_file'), async (req, res) => {
  const { customer_id, cycle_id, token_id, sap_balance, cust_balance, remarks } = req.body;
  if (!customer_id || !token_id) return res.status(400).json({ error: 'customer_id and token_id are required' });

  const tokenRec = await TokenRecord.findOne({ token_id });
  if (!tokenRec || tokenRec.status !== 'ACTIVE' || !tokenRec.pan_verified_at) {
    return res.status(403).json({ error: 'This link has not completed identity verification. Please open the confirmation link again.' });
  }

  tokenRec.status  = 'USED';
  tokenRec.used_at = new Date();
  await tokenRec.save();

  const sapNum  = parseFloat(sap_balance)  || 0;
  const custNum = parseFloat(cust_balance) || 0;
  const diff    = custNum - sapNum;
  const status  = Math.abs(diff) < 0.01 ? 'MATCHED' : 'DIFFERENCE';

  const record = await Confirmation.findOneAndUpdate(
    { customer_id, cycle_id: cycle_id || cfg.CYCLE_ID },
    {
      customer_id, cycle_id: cycle_id || cfg.CYCLE_ID, token_id,
      sap_balance: sapNum, cust_balance: custNum, difference: parseFloat(diff.toFixed(2)),
      remarks: remarks || '',
      soa_filename: req.file ? req.file.filename : null,
      soa_path:     req.file ? req.file.path     : null,
      soa_size:     req.file ? req.file.size     : null,
      status, recon_status: 'PENDING', submitted_at: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await logAudit({ actor: `CUSTOMER:${customer_id}`, actor_role: 'customer', action: 'CONFIRMATION_SUBMITTED', entity_type: 'Confirmation', entity_id: customer_id, details: { status, difference: diff } });

  res.json({
    ok: true, status, difference: diff,
    message: status === 'MATCHED' ? 'Balance confirmed and matched. Thank you.' : `Confirmation received. Difference of Rs.${Math.abs(diff).toLocaleString('en-IN')} noted.`,
  });
});

router.get('/', requireAdmin, async (req, res) => res.json({ confirmations: await Confirmation.find().lean() }));

router.get('/:customerId', requireAdmin, async (req, res) => {
  const conf = await Confirmation.findOne({ customer_id: req.params.customerId, cycle_id: cfg.CYCLE_ID }).lean();
  if (!conf) return res.status(404).json({ error: 'No confirmation found' });
  res.json(conf);
});

router.patch('/:customerId/recon', requireAdmin, async (req, res) => {
  const { recon_status, recon_notes, root_causes } = req.body;
  const update = {};
  if (recon_status) update.recon_status = recon_status;
  if (recon_notes !== undefined) update.recon_notes = recon_notes;
  if (root_causes) update.root_causes = root_causes;
  if (recon_status === 'COMPLETED') update.recon_completed_at = new Date();

  const conf = await Confirmation.findOneAndUpdate({ customer_id: req.params.customerId, cycle_id: cfg.CYCLE_ID }, update, { new: true });
  if (!conf) return res.status(404).json({ error: 'No confirmation found' });

  await logAudit({ req, action: recon_status === 'COMPLETED' ? 'RECON_MARKED_COMPLETE' : 'RECON_NOTES_SAVED', entity_type: 'Confirmation', entity_id: req.params.customerId });
  res.json({ ok: true, confirmation: conf });
});

router.get('/:customerId/soa', requireAdmin, async (req, res) => {
  const conf = await Confirmation.findOne({ customer_id: req.params.customerId, cycle_id: cfg.CYCLE_ID }).lean();
  if (!conf || !conf.soa_path) return res.status(404).json({ error: 'No SOA file found' });
  if (!fs.existsSync(conf.soa_path)) return res.status(404).json({ error: 'SOA file missing from disk' });
  res.download(conf.soa_path, conf.soa_filename);
});

module.exports = router;
