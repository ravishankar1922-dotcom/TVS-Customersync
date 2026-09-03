/**
 * Mailer
 * ───────
 * Sends real email via SMTP (Nodemailer) instead of the old Outlook/VBScript
 * COM-automation approach. This is what made the ₹ symbol and other glyphs
 * render as garbage: VBScript files were written as UTF-8 without a BOM and
 * `cscript` (Windows Script Host) reads that as the ANSI code page, mangling
 * ₹, ✓, ≈ etc. Nodemailer sends proper `charset=UTF-8` MIME, so every symbol
 * renders correctly in Outlook/Gmail/any client — and it works from any
 * cloud server, not just one Windows desktop with Outlook installed.
 */

const nodemailer = require('nodemailer');
const cfg = require('../config');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!cfg.SMTP.host) return null; // not configured — caller should handle gracefully
  transporter = nodemailer.createTransport({
    host: cfg.SMTP.host,
    port: cfg.SMTP.port,
    secure: cfg.SMTP.secure,
    auth: cfg.SMTP.user ? { user: cfg.SMTP.user, pass: cfg.SMTP.pass } : undefined,
  });
  return transporter;
}

/**
 * @param {object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} opts.html
 * @param {Array}  [opts.attachments] - nodemailer attachment array
 */
async function sendMail({ to, subject, html, attachments }) {
  const t = getTransporter();
  if (!t) {
    return { sent: false, reason: 'SMTP_NOT_CONFIGURED' };
  }
  const info = await t.sendMail({
    from: cfg.SMTP.from,
    to,
    subject,
    html,
    attachments,
  });
  return { sent: true, messageId: info.messageId };
}

// ── HTML currency formatter — always use the numeric entity, never a raw
//    ₹ glyph, so encoding never depends on the sending environment. ──────
function fmtCurrencyHTML(amount) {
  const formatted = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(amount || 0));
  return `&#8377;${formatted}`; // &#8377; = ₹
}

module.exports = { sendMail, fmtCurrencyHTML, isConfigured: () => !!cfg.SMTP.host };
