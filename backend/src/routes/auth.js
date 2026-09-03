const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const cfg      = require('../config');
const Admin    = require('../models/Admin');
const { logAudit } = require('../utils/audit');
const { requireAdmin } = require('../middleware/auth');

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many login attempts. Try again later.' } });

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const admin = await Admin.findOne({ email: email.toLowerCase().trim() });
  if (!admin) return res.status(401).json({ error: 'Invalid email or password.' });

  const ok = await bcrypt.compare(password, admin.password_hash);
  if (!ok) {
    await logAudit({ req, actor: email, actor_role: 'admin', action: 'LOGIN_FAILED', entity_type: 'Admin', entity_id: email });
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const token = jwt.sign({ sub: admin._id, email: admin.email, role: admin.role }, cfg.JWT_SECRET, { expiresIn: '12h' });
  await logAudit({ req, actor: admin.email, actor_role: 'admin', action: 'LOGIN_SUCCESS', entity_type: 'Admin', entity_id: admin.email });

  res.json({ ok: true, token, admin: { email: admin.email, name: admin.name, role: admin.role } });
});

// GET /api/auth/me — verify current session
router.get('/me', requireAdmin, (req, res) => res.json({ email: req.admin.email, role: req.admin.role }));

module.exports = router;
