const express = require('express');
const router  = express.Router();
const ExcelJS = require('exceljs');
const AuditLog = require('../models/AuditLog');
const { requireAdmin } = require('../middleware/auth');

// GET /api/audit?limit=200&action=&entity_id=
router.get('/', requireAdmin, async (req, res) => {
  const { limit = 200, action, entity_id, actor } = req.query;
  const q = {};
  if (action)    q.action = action;
  if (entity_id) q.entity_id = entity_id;
  if (actor)     q.actor = actor;
  const logs = await AuditLog.find(q).sort({ createdAt: -1 }).limit(Math.min(parseInt(limit, 10) || 200, 1000));
  res.json({ logs, total: logs.length });
});

// GET /api/audit/export.xlsx — same filters as above, as a workbook
router.get('/export.xlsx', requireAdmin, async (req, res) => {
  const { limit = 1000, action, entity_id, actor } = req.query;
  const q = {};
  if (action)    q.action = action;
  if (entity_id) q.entity_id = entity_id;
  if (actor)     q.actor = actor;
  const logs = await AuditLog.find(q).sort({ createdAt: -1 }).limit(Math.min(parseInt(limit, 10) || 1000, 1000)).lean();

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Audit Log');
  ws.columns = [
    { header: 'Timestamp', key: 'createdAt', width: 22 },
    { header: 'Actor', key: 'actor', width: 24 },
    { header: 'Role', key: 'actor_role', width: 12 },
    { header: 'Action', key: 'action', width: 26 },
    { header: 'Entity Type', key: 'entity_type', width: 16 },
    { header: 'Entity ID', key: 'entity_id', width: 16 },
    { header: 'Details', key: 'details', width: 50 },
    { header: 'IP', key: 'ip', width: 16 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };
  logs.forEach(l => ws.addRow({ ...l, createdAt: l.createdAt ? new Date(l.createdAt).toLocaleString('en-IN') : '', details: l.details ? JSON.stringify(l.details) : '' }));
  ws.autoFilter = { from: 'A1', to: 'H1' };
  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Audit_Log.xlsx"`);
  res.send(buffer);
});

module.exports = router;
