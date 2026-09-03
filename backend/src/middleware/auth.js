const jwt = require('jsonwebtoken');
const cfg = require('../config');

/** Protects all /api/admin/* style routes. Expects `Authorization: Bearer <jwt>`. */
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  // Plain <a href> downloads (SOA files, Excel export) can't set headers, so
  // also accept ?token=... on those specific GET links.
  const token  = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || null);
  if (!token) return res.status(401).json({ error: 'Not authenticated. Please log in.' });

  try {
    const payload = jwt.verify(token, cfg.JWT_SECRET);
    req.admin = payload; // { sub, email, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }
}

module.exports = { requireAdmin };
