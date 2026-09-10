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

// ── Phase 5 additions: role + business-type gating ──────────────────────
// Deliberately built ON TOP of requireAdmin (same JWT, same session) rather
// than as parallel auth code, per the spec's explicit preference ("prefer
// role + business-type authorization over duplicating auth code").

// requireRole(...roles) — 401 if not authenticated at all (requireAdmin's
// job), 403 if authenticated but not one of the allowed roles. ADMIN is
// never implicitly included — callers that mean "ADMIN or FINANCE" say so.
function requireRole(...roles) {
  return function (req, res, next) {
    requireAdmin(req, res, (err) => {
      if (err) return next(err);
      if (!roles.includes(req.admin.role)) {
        return res.status(403).json({ error: `This action requires one of: ${roles.join(', ')}.` });
      }
      next();
    });
  };
}

const requireFinance = requireRole('FINANCE');
const requireAdminOnly = requireRole('ADMIN');
const requireAdminOrFinance = requireRole('ADMIN', 'FINANCE');

// requireBusinessAccess(lotBusinessType) — 403 if the logged-in admin/
// finance user's own business_type ('CUSTOMER' | 'VENDOR' | 'BOTH') doesn't
// cover the Lot/record's business_type. Call AFTER requireAdmin/requireRole
// has already set req.admin. Never throws for a missing admin — that's the
// earlier middleware's job.
function assertBusinessAccess(req, recordBusinessType) {
  const own = req.admin?.business_type || 'BOTH';
  if (own === 'BOTH') return true;
  return own === recordBusinessType;
}

module.exports = { requireAdmin, requireRole, requireFinance, requireAdminOnly, requireAdminOrFinance, assertBusinessAccess };
