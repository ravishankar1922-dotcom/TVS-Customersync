const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const ExcelJS = require('exceljs');
const cfg     = require('../config');
const TokenRecord  = require('../models/TokenRecord');
const Confirmation = require('../models/Confirmation');
const Customer = require('../models/Customer');
const { requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const ALLOWED_EXT  = ['.xlsx', '.xls', '.csv', '.pdf'];
const MAX_SIZE_MB  = 20;

// Files are kept in memory just long enough to write straight into MongoDB
// (see soa_data on the Confirmation model) — NOT written to Render's local
// disk, which is ephemeral and wipes on every restart/redeploy.
const upload = multer({
  storage: multer.memoryStorage(),
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

  // If this submission follows an admin-approved re-upload, archive the
  // previous version into soa_history before it's overwritten — admin can
  // still view/download every version, reconciliation always uses latest.
  const existing = await Confirmation.findOne({ customer_id, cycle_id: cycle_id || cfg.CYCLE_ID }).lean();
  const isReupload = existing && existing.reupload_status === 'APPROVED';
  const historyPush = isReupload && existing.soa_data ? {
    soa_filename: existing.soa_filename, soa_mimetype: existing.soa_mimetype, soa_size: existing.soa_size, soa_data: existing.soa_data,
    sap_balance: existing.sap_balance, cust_balance: existing.cust_balance, difference: existing.difference,
    submitted_at: existing.submitted_at,
  } : null;

  const update = {
    customer_id, cycle_id: cycle_id || cfg.CYCLE_ID, token_id,
    sap_balance: sapNum, cust_balance: custNum, difference: parseFloat(diff.toFixed(2)),
    remarks: remarks || '',
    soa_filename: req.file ? req.file.originalname : null,
    soa_mimetype: req.file ? req.file.mimetype     : null,
    soa_size:     req.file ? req.file.size         : null,
    soa_data:     req.file ? req.file.buffer       : null,
    status, recon_status: 'PENDING', submitted_at: new Date(),
    reupload_status: 'NONE',
  };
  const mongoUpdate = historyPush ? { $set: update, $push: { soa_history: historyPush } } : { $set: update };

  const record = await Confirmation.findOneAndUpdate(
    { customer_id, cycle_id: cycle_id || cfg.CYCLE_ID },
    mongoUpdate,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await logAudit({ actor: `CUSTOMER:${customer_id}`, actor_role: 'customer', action: isReupload ? 'CONFIRMATION_RESUBMITTED' : 'CONFIRMATION_SUBMITTED', entity_type: 'Confirmation', entity_id: customer_id, details: { status, difference: diff } });

  res.json({
    ok: true, status, difference: diff,
    message: status === 'MATCHED' ? 'Balance confirmed and matched. Thank you.' : `Confirmation received. Difference of Rs.${Math.abs(diff).toLocaleString('en-IN')} noted.`,
  });
});

router.get('/', requireAdmin, async (req, res) => res.json({ confirmations: await Confirmation.find().lean() }));

// GET /api/confirmations/export.xlsx
router.get('/export.xlsx', requireAdmin, async (req, res) => {
  const [confs, customers] = await Promise.all([
    Confirmation.find({ cycle_id: cfg.CYCLE_ID }).lean(),
    Customer.find().lean(),
  ]);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Confirmations');
  ws.columns = [
    { header: 'Customer ID', key: 'customer_id', width: 14 },
    { header: 'Customer Name', key: 'customer_name', width: 28 },
    { header: 'SAP Balance', key: 'sap_balance', width: 15 },
    { header: 'Customer Balance', key: 'cust_balance', width: 16 },
    { header: 'Difference', key: 'difference', width: 14 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Recon Status', key: 'recon_status', width: 14 },
    { header: 'SOA File', key: 'soa_filename', width: 26 },
    { header: 'Submitted At', key: 'submitted_at', width: 20 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };
  confs.forEach(c => {
    const cust = customers.find(x => x.customer_id === c.customer_id);
    ws.addRow({ ...c, customer_name: cust?.customer_name, submitted_at: c.submitted_at ? new Date(c.submitted_at).toLocaleString('en-IN') : '' });
  });
  ws.autoFilter = { from: 'A1', to: 'I1' };
  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Confirmations_${cfg.CYCLE_ID}.xlsx"`);
  res.send(buffer);
});

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

// POST /api/confirmations/:customerId/request-reupload — public (customer
// portal), lets a customer who realises they submitted the wrong SOA ask
// for a re-upload. Does NOT reopen the link by itself — an admin must
// approve first (Admin-approved SOP).
router.post('/:customerId/request-reupload', async (req, res) => {
  const { token_id, reason } = req.body;
  const conf = await Confirmation.findOne({ customer_id: req.params.customerId, cycle_id: cfg.CYCLE_ID });
  if (!conf) return res.status(404).json({ error: 'No confirmation found for this customer.' });
  if (token_id && conf.token_id !== token_id) return res.status(403).json({ error: 'Token does not match this confirmation.' });
  if (conf.reupload_status === 'REQUESTED') return res.json({ ok: true, message: 'A re-upload request is already pending admin approval.' });

  conf.reupload_status = 'REQUESTED';
  conf.reupload_reason = reason || '';
  conf.reupload_requested_at = new Date();
  await conf.save();

  await logAudit({ actor: `CUSTOMER:${req.params.customerId}`, actor_role: 'customer', action: 'SOA_REUPLOAD_REQUESTED', entity_type: 'Confirmation', entity_id: req.params.customerId, details: { reason } });
  res.json({ ok: true, message: 'Re-upload request sent to admin for approval.' });
});

// POST /api/confirmations/:customerId/approve-reupload — admin only.
// Reactivates the customer's existing token so they can resubmit through
// the same link; the current SOA is archived to soa_history on resubmit.
router.post('/:customerId/approve-reupload', requireAdmin, async (req, res) => {
  const conf = await Confirmation.findOne({ customer_id: req.params.customerId, cycle_id: cfg.CYCLE_ID });
  if (!conf) return res.status(404).json({ error: 'No confirmation found for this customer.' });

  conf.reupload_status = 'APPROVED';
  conf.reupload_approved_at = new Date();
  await conf.save();

  if (conf.token_id) {
    await TokenRecord.updateOne({ token_id: conf.token_id }, { status: 'ACTIVE', used_at: null });
  }

  await logAudit({ req, action: 'SOA_REUPLOAD_APPROVED', entity_type: 'Confirmation', entity_id: req.params.customerId });
  res.json({ ok: true, message: 'Re-upload approved. Customer can now resubmit via their existing link.' });
});

// GET /api/confirmations/:customerId/soa-history — admin only, all
// archived SOA versions (metadata only, not the file bytes).
router.get('/:customerId/soa-history', requireAdmin, async (req, res) => {
  const conf = await Confirmation.findOne({ customer_id: req.params.customerId, cycle_id: cfg.CYCLE_ID }).lean();
  if (!conf) return res.status(404).json({ error: 'No confirmation found' });
  const history = (conf.soa_history || []).map((h, i) => ({
    version: i + 1, soa_filename: h.soa_filename, soa_size: h.soa_size,
    sap_balance: h.sap_balance, cust_balance: h.cust_balance, difference: h.difference,
    submitted_at: h.submitted_at, archived_at: h.archived_at,
  }));
  history.push({ version: history.length + 1, soa_filename: conf.soa_filename, soa_size: conf.soa_size, sap_balance: conf.sap_balance, cust_balance: conf.cust_balance, difference: conf.difference, submitted_at: conf.submitted_at, is_latest: true });
  res.json({ history });
});

// GET /api/confirmations/:customerId/soa-history/:version — admin only,
// download one archived (non-latest) version's file bytes.
router.get('/:customerId/soa-history/:version', requireAdmin, async (req, res) => {
  const conf = await Confirmation.findOne({ customer_id: req.params.customerId, cycle_id: cfg.CYCLE_ID }).lean();
  if (!conf) return res.status(404).json({ error: 'No confirmation found' });
  const idx = parseInt(req.params.version, 10) - 1;
  const h = (conf.soa_history || [])[idx];
  if (!h || !h.soa_data) return res.status(404).json({ error: 'That SOA version was not found' });
  res.setHeader('Content-Type', h.soa_mimetype || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${h.soa_filename || 'soa_file'}"`);
  res.send(h.soa_data.buffer ? Buffer.from(h.soa_data.buffer) : h.soa_data);
});

router.get('/:customerId/soa', requireAdmin, async (req, res) => {
  const conf = await Confirmation.findOne({ customer_id: req.params.customerId, cycle_id: cfg.CYCLE_ID }).lean();
  if (!conf || !conf.soa_data) return res.status(404).json({ error: 'No SOA file found' });
  res.setHeader('Content-Type', conf.soa_mimetype || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${conf.soa_filename || 'soa_file'}"`);
  res.send(conf.soa_data.buffer ? Buffer.from(conf.soa_data.buffer) : conf.soa_data);
});

module.exports = router;
