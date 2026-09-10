/**
 * Token Engine
 * ─────────────
 * HMAC-SHA256 signed tokens. Payload = base64url(JSON) + "." + signature.
 * The balance is never in the token — always fetched fresh from the ledger.
 * A valid signature only proves the LINK is genuine; the customer must also
 * pass the PAN check (see routes/tokens.js /validate) before any balance
 * or transaction data is returned. This is the two-factor design requested:
 * "possession of the emailed link" + "knowledge of the registered PAN".
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const cfg = require('../config');

function b64Encode(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function b64Decode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}
function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

// `extra` (phase 2 — see BalanceSync_Lot_Architecture_Plan.md) optionally
// carries { lot_id, business_type } for a Lot-scoped token. Both are baked
// into the SAME HMAC-signed payload as everything else here, so a caller
// can never forge or swap a Lot/business-type binding by editing the URL —
// any change to the payload invalidates the signature (see validateToken).
// Omitted entirely for the legacy (non-Lot) flow, which is unaffected.
function generateToken(customerId, cycleId, company, expiryHours, extra) {
  const tokenId   = uuidv4();
  const issuedAt  = Date.now();
  const hours     = expiryHours && expiryHours > 0 ? expiryHours : cfg.TOKEN_EXPIRY_HOURS;
  const expiresAt = issuedAt + hours * 3600 * 1000;
  const { lot_id = null, business_type = null } = extra || {};

  const payload = {
    token_id: tokenId, customer_id: customerId, cycle_id: cycleId, company: company || cfg.COMPANY,
    lot_id: lot_id ? lot_id.toString() : null, business_type: business_type || null,
    issued_at: issuedAt, expires_at: expiresAt,
  };
  const encoded   = b64Encode(payload);
  const signature = sign(encoded, cfg.HMAC_SECRET);

  return {
    token: `${encoded}.${signature}`,
    token_id: tokenId,
    customer_id: customerId,
    cycle_id: cycleId,
    lot_id: payload.lot_id,
    business_type: payload.business_type,
    issued_at:  new Date(issuedAt).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
  };
}

function validateToken(tokenString) {
  if (!tokenString || typeof tokenString !== 'string') return { valid: false, reason: 'MISSING_TOKEN' };
  const parts = tokenString.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'INVALID_FORMAT' };

  const [encoded, providedSig] = parts;
  const expectedSig = sign(encoded, cfg.HMAC_SECRET);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(providedSig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
      return { valid: false, reason: 'INVALID_SIGNATURE' };
    }
  } catch {
    return { valid: false, reason: 'INVALID_SIGNATURE' };
  }

  let payload;
  try { payload = b64Decode(encoded); } catch { return { valid: false, reason: 'CORRUPT_PAYLOAD' }; }
  if (Date.now() > payload.expires_at) return { valid: false, reason: 'EXPIRED', payload };
  return { valid: true, reason: 'OK', payload };
}

function buildPortalUrl(token) {
  return `${cfg.FRONTEND_URL}/portal?t=${encodeURIComponent(token)}`;
}

module.exports = { generateToken, validateToken, buildPortalUrl };
