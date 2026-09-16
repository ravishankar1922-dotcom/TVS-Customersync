/**
 * BalanceSync Configuration
 * All values come from environment variables (.env). See .env.example.
 */
require('dotenv').config();

module.exports = {
  PORT:              parseInt(process.env.PORT || '3001', 10),
  FRONTEND_URL:      process.env.FRONTEND_URL || 'http://localhost:3000',
  NODE_ENV:          process.env.NODE_ENV || 'development',

  MONGO_URI:         process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/balancesync',

  JWT_SECRET:        process.env.JWT_SECRET || 'dev-only-change-me',
  HMAC_SECRET:       process.env.HMAC_SECRET || 'dev-only-change-me-2',
  ADMIN_EMAIL:       process.env.ADMIN_EMAIL || 'admin@tvsmobility.com',
  ADMIN_PASSWORD:    process.env.ADMIN_PASSWORD || 'ChangeMe@123',
  // Second seeded login for the Finance role (Phase 4/5 workflow). Given a
  // real default here — same pattern as ADMIN_EMAIL/ADMIN_PASSWORD above —
  // so `npm run seed` creates it out of the box, same as Admin. Change the
  // password after first login, same as you would for Admin.
  FINANCE_EMAIL:     process.env.FINANCE_EMAIL || 'finance@tvsmobility.com',
  FINANCE_PASSWORD:  process.env.FINANCE_PASSWORD || 'ChangeMe@456',
  TOKEN_EXPIRY_HOURS: parseInt(process.env.TOKEN_EXPIRY_HOURS || '72', 10),

  CYCLE_ID:          process.env.CYCLE_ID || 'TSL-MAR-2026',
  COMPANY:           process.env.COMPANY || 'TSL',
  AS_OF_DATE:        process.env.AS_OF_DATE || '31-Mar-2026',
  // Sept 2026: "download the cover letter PDF... Change it to TVS Srichakra
  // Ltd". COMPANY above stays the short code used throughout the app
  // (badges, cycle IDs, etc.) — this is the full legal name used on the
  // covering-letter PDF's letterhead and in the redesigned email templates.
  // NOTE: no postal address is printed on the letter — the admin flagged
  // the placeholder address as wrong, so it was removed entirely rather
  // than risk printing another incorrect one. Set COMPANY_CONTACT (e.g. a
  // phone/email line) if you want one shown under the company name; it's
  // blank by default and simply omitted when unset.
  COMPANY_FULL_NAME: process.env.COMPANY_FULL_NAME || 'TVS Srichakra Limited',
  COMPANY_CONTACT:   process.env.COMPANY_CONTACT || '',

  SMTP: {
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user:   process.env.SMTP_USER,
    pass:   process.env.SMTP_PASS,
    from:   process.env.MAIL_FROM || '"AR Team" <no-reply@example.com>',
  },

  UPLOAD_ROOT: process.env.UPLOAD_ROOT || './storage',
};
