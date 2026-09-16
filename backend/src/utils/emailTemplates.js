const { fmtCurrencyHTML } = require('./mailer');
const cfg = require('../config');

const BRAND_RED = '#C8102E';
const INK = '#1A1D29';
const MUTED = '#5B6572';
const BORDER = '#E4E7EB';
const PANEL_BG = '#F4F5F7';

// HARDENING: customer_name (admin-imported customer master) and recon_notes
// (free text an admin types into the Reconciliation Studio) were previously
// interpolated straight into these HTML email bodies with no escaping. Both
// are admin-authenticated inputs (not directly customer-controlled), so this
// was never a customer-facing XSS path — but an imported customer master
// from an external/partner source, or a careless paste into the notes
// field, containing raw HTML could still deface the outgoing email or inject
// misleading links/markup. Escape before interpolation as defense in depth;
// behavior for normal names/notes (no special characters) is unchanged.
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Sept 2026 portal revamp: "Expiry date can be mentioned in body of the
// mail" — every email used to say only "expires in N hours", which tells
// the customer nothing without doing the arithmetic themselves. Render the
// actual expiry date/time (IST, since every customer here is India-based)
// whenever we have the token's real expires_at; fall back to the old
// "in N hours" phrasing only if a caller genuinely has no timestamp yet.
function fmtExpiry(expiresAt, tokenExpiryHours) {
  if (expiresAt) {
    try {
      const d = new Date(expiresAt);
      if (!isNaN(d)) {
        const datePart = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
        const timePart = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
        return `on <strong>${datePart}</strong> at <strong>${timePart} IST</strong>`;
      }
    } catch { /* fall through to the hours-based fallback below */ }
  }
  return `in <strong>${tokenExpiryHours} hours</strong>`;
}

// ── Shared letter shell ───────────────────────────────────────────────────
// Sept 2026: "Email Template can be more professional." Replaces the old
// plain left-aligned Calibri text with a table-based letterhead layout — a
// centered card on a light background, a brand-red masthead with the full
// company name and an eyebrow label, a clear content area, and a quiet
// footer — built entirely from HTML tables + inline styles (no flex/grid/
// box-shadow/border-radius reliance) so it degrades gracefully rather than
// breaking in Outlook desktop, which a real AR distribution list will hit.
function emailShell({ eyebrow, bodyHtml, footerNote }) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <!--[if mso]>
  <style>* { font-family: Arial, sans-serif !important; }</style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background:${PANEL_BG};-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PANEL_BG};padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid ${BORDER};border-radius:10px;overflow:hidden;">
          <tr>
            <td style="height:5px;line-height:5px;font-size:0;background:${BRAND_RED};">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:26px 36px 20px 36px;">
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:1.5px;color:${BRAND_RED};text-transform:uppercase;margin-bottom:6px;">${escapeHtml(eyebrow)}</div>
              <div style="font-family:'Segoe UI',Arial,Helvetica,sans-serif;font-size:19px;font-weight:700;color:${INK};">${escapeHtml(cfg.COMPANY_FULL_NAME)}</div>
            </td>
          </tr>
          <tr><td style="padding:0 36px;"><div style="border-top:1px solid ${BORDER};line-height:0;font-size:0;">&nbsp;</div></td></tr>
          <tr>
            <td style="padding:28px 36px 8px 36px;font-family:'Segoe UI',Calibri,Arial,sans-serif;font-size:14px;line-height:1.7;color:${INK};">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:22px 36px 26px 36px;">
              <div style="border-top:1px solid ${BORDER};padding-top:16px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.7;color:${MUTED};">
                ${footerNote || 'This is an automated message from our Accounts Receivable system. Please do not reply directly to this email.'}
              </div>
            </td>
          </tr>
        </table>
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:10px;color:#98A0AB;padding:16px 8px;">
          &copy; ${new Date().getFullYear()} ${escapeHtml(cfg.COMPANY_FULL_NAME)}. All rights reserved.
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function ctaButton(url, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 8px 0;">
  <tr>
    <td style="border-radius:6px;background:${BRAND_RED};">
      <a href="${url}" style="display:inline-block;padding:13px 32px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.4px;color:#ffffff;text-decoration:none;border-radius:6px;">${label}</a>
    </td>
  </tr>
</table>`;
}

function balanceCard(rows, { highlight = false } = {}) {
  const body = rows.map(([label, value, opts = {}]) => `
    <tr>
      <td style="padding:12px 18px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${highlight ? '#ffffffcc' : MUTED};${opts.strong ? 'font-weight:700;' : ''}">${label}</td>
      <td align="right" style="padding:12px 18px;font-family:'Courier New',Consolas,monospace;font-size:14px;font-weight:700;color:${highlight ? '#ffffff' : (opts.color || INK)};">${value}</td>
    </tr>`).join('');
  const bg = highlight ? BRAND_RED : '#ffffff';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BORDER};border-radius:8px;overflow:hidden;margin:18px 0;background:${bg};">${body}</table>`;
}

function noticeBox(html, { color = '#92400E', bg = '#FFF7E6', border = '#D97706' } = {}) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;">
  <tr><td style="background:${bg};border-left:3px solid ${border};padding:12px 16px;font-size:13px;line-height:1.6;color:${color};border-radius:4px;">${html}</td></tr>
</table>`;
}

function signOff(team) {
  return `<p style="margin:22px 0 0 0;">Warm regards,<br/><strong>${escapeHtml(team)}</strong><br/><span style="color:${MUTED};font-size:12.5px;">${escapeHtml(cfg.COMPANY_FULL_NAME)}</span></p>`;
}

// ── Balance confirmation request email ───────────────────────────────────
function confirmationRequestEmail(customer, sapBalance, portalUrl, asOfDate, tokenExpiryHours, expiresAt) {
  return emailShell({
    eyebrow: 'Balance Confirmation Request',
    bodyHtml: `
<p style="margin:0 0 14px 0;">Dear ${escapeHtml(customer.customer_name)},</p>
<p style="margin:0 0 4px 0;">As part of our periodic Accounts Receivable review, we request you to kindly confirm the outstanding balance in your books as on <strong>${asOfDate}</strong>.</p>
${balanceCard([['Balance as per Our Books', fmtCurrencyHTML(sapBalance)]], { highlight: true })}
<p style="margin:16px 0 0 0;">Please click below to review the line-item details, verify your registered PAN, and submit your confirmation. The process takes only a few minutes.</p>
${ctaButton(portalUrl, 'CONFIRM BALANCE')}
${noticeBox(`&#128274; This link is unique to your account and expires ${fmtExpiry(expiresAt, tokenExpiryHours)}. For your security, you will also be asked to verify your registered PAN before it opens — please do not forward or share it.`, { color: MUTED, bg: PANEL_BG, border: BORDER })}
${signOff('Accounts Receivable — Shared Services Centre')}`,
  });
}

// ── Reconciliation-complete email (sent back to customer) ────────────────
function reconciliationCompleteEmail(customer, summary, asOfDate, notes) {
  const diffColor = summary.net_difference === 0 ? '#16A34A' : BRAND_RED;
  return emailShell({
    eyebrow: 'Reconciliation Complete',
    bodyHtml: `
<p style="margin:0 0 14px 0;">Dear ${escapeHtml(customer.customer_name)},</p>
<p style="margin:0;">The reconciliation of your account balance as on <strong>${asOfDate}</strong> has been completed by our Accounts Receivable team. A summary is set out below, with the full line-by-line reconciliation attached as an Excel workbook for your records.</p>
${balanceCard([
  ['Balance as per Our Books', fmtCurrencyHTML(summary.total_sap_balance)],
  ['Balance as per Your Records', fmtCurrencyHTML(summary.total_cust_balance)],
  ['Net Difference', fmtCurrencyHTML(summary.net_difference), { strong: true, color: diffColor }],
  ['Matched Line Items', String(summary.matched)],
  ['Items Requiring Attention', String(summary.matched_with_difference + summary.missing_in_customer + summary.not_in_sap)],
])}
${notes ? `<p style="margin:16px 0 4px 0;"><strong>Notes from our Accounts Receivable team:</strong></p>${noticeBox(escapeHtml(notes).replace(/\n/g, '<br/>'))}` : ''}
<p style="margin:16px 0 0 0;">Please review the attached workbook at your convenience. Should you have any questions on a specific line item, do reach out to your relationship manager.</p>
${signOff('Accounts Receivable — Shared Services Centre')}`,
  });
}

// ── Reminder email (customer hasn't responded yet) ───────────────────────
function reminderEmail(customer, sapBalance, portalUrl, asOfDate, tokenExpiryHours, expiresAt) {
  return emailShell({
    eyebrow: 'Reminder — Action Required',
    bodyHtml: `
<p style="margin:0 0 14px 0;">Dear ${escapeHtml(customer.customer_name)},</p>
${noticeBox(`<strong>Gentle reminder:</strong> we have not yet received your balance confirmation for the period ending <strong>${asOfDate}</strong>. We would appreciate it if you could take a few minutes to review and submit at your earliest convenience.`)}
${balanceCard([['Balance as per Our Books', fmtCurrencyHTML(sapBalance)]], { highlight: true })}
${ctaButton(portalUrl, 'CONFIRM BALANCE NOW')}
${noticeBox(`&#128274; This link expires ${fmtExpiry(expiresAt, tokenExpiryHours)}. You will be asked to verify your registered PAN before it opens.`, { color: MUTED, bg: PANEL_BG, border: BORDER })}
${signOff('Accounts Receivable — Shared Services Centre')}`,
  });
}

// ── Finance-clarification email (phase 5 workflow) ───────────────────────
// Sent when Finance routes a Lot-scoped confirmation to CUSTOMER_CLARIFICATION
// — the reopenable portal link lets them see the SAP balance side-by-side,
// comment, amend and resubmit (see routes/lots.js's route-to-customer).
function financeClarificationEmail(customer, sapBalance, custBalance, portalUrl, asOfDate, comment, expiresAt) {
  return emailShell({
    eyebrow: 'Clarification Requested',
    bodyHtml: `
<p style="margin:0 0 14px 0;">Dear ${escapeHtml(customer.customer_name)},</p>
<p style="margin:0;">Our Finance team has reviewed your balance confirmation for <strong>${asOfDate}</strong> and requires a clarification before it can be finalised.</p>
${comment ? `<p style="margin:16px 0 4px 0;"><strong>Note from our Finance team:</strong></p>${noticeBox(escapeHtml(comment).replace(/\n/g, '<br/>'))}` : ''}
${balanceCard([
  [`Balance as per ${escapeHtml(cfg.COMPANY_FULL_NAME)}`, fmtCurrencyHTML(sapBalance)],
  ['Balance You Submitted', fmtCurrencyHTML(custBalance)],
])}
<p style="margin:16px 0 0 0;">Please reopen your confirmation link, review the note above, and amend or re-submit your response with a comment if required:</p>
${ctaButton(portalUrl, 'REVIEW & RESPOND')}
${expiresAt ? noticeBox(`&#128274; This link expires ${fmtExpiry(expiresAt)}.`, { color: MUTED, bg: PANEL_BG, border: BORDER }) : ''}
${signOff('Finance Team')}`,
  });
}

module.exports = { confirmationRequestEmail, reconciliationCompleteEmail, reminderEmail, financeClarificationEmail };
