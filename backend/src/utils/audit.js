const AuditLog = require('../models/AuditLog');

/**
 * Fire-and-forget audit log write. Never throws into the caller —
 * an audit-log failure should never break the underlying business action.
 */
async function logAudit({ req, actor, actor_role, action, entity_type, entity_id, details }) {
  try {
    await AuditLog.create({
      actor:       actor || req?.admin?.email || 'SYSTEM',
      actor_role:  actor_role || (req?.admin ? 'admin' : 'system'),
      action,
      entity_type,
      entity_id,
      details,
      ip: req?.ip,
    });
  } catch (err) {
    console.error('[Audit] Failed to write audit log:', err.message);
  }
}

module.exports = { logAudit };
