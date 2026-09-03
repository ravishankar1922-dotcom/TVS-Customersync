const express = require('express');
const router  = express.Router();
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

module.exports = router;
