const { fmtCurrencyHTML } = require('./mailer');
const cfg = require('../config');

const BRAND_RED = '#C8102E';

function baseWrap(bodyHtml) {
  return `<!doctype html>
<html><head><meta charset="utf-8" /></head>
<body style="font-family:Calibri,Arial,sans-serif;font-size:14px;color:#1a1a1a;margin:0;padding:0;">
${bodyHtml}
</body></html>`;
}

// ── Balance confirmation request email ───────────────────────────────────
function confirmationRequestEmail(customer, sapBalance, portalUrl, asOfDate, tokenExpiryHours) {
  return baseWrap(`
<p>Dear ${customer.customer_name},</p>
<p>${cfg.COMPANY} requests you to confirm the outstanding balance in your books as on <strong>${asOfDate}</strong>.</p>
<table style="border:1px solid #ccc;border-collapse:collapse;margin:16px 0;">
  <tr style="background:${BRAND_RED};color:#fff;">
    <td style="padding:8px 16px;font-weight:bold;">Balance as per Books</td>
    <td style="padding:8px 24px;font-weight:bold;font-family:'Courier New',monospace;">${fmtCurrencyHTML(sapBalance)}</td>
  </tr>
</table>
<p>Please click the button below to review the line items, verify your PAN and submit your confirmation:</p>
<p>
  <a href="${portalUrl}" style="background:${BRAND_RED};color:#fff;padding:10px 24px;text-decoration:none;border-radius:5px;font-weight:bold;display:inline-block;">
    CONFIRM BALANCE
  </a>
</p>
<p style="font-size:11px;color:#666;">Or copy this link into your browser:<br/><a href="${portalUrl}">${portalUrl}</a></p>
<p style="font-size:11px;color:#666;">
  &#9888; This link is unique to your account and expires in ${tokenExpiryHours} hours.
  For your security, you will also be asked to enter your registered PAN before the link opens. Please do not share it.
</p>
<hr/>
<p style="font-size:12px;color:#444;">
  Regards,<br/><strong>${cfg.COMPANY} Accounts Receivable — Shared Services Centre</strong><br/>
  <em>This is an automated message. Please do not reply to this email.</em>
</p>`);
}

// ── Reconciliation-complete email (sent back to customer) ────────────────
function reconciliationCompleteEmail(customer, summary, asOfDate, notes) {
  const diffColor = summary.net_difference === 0 ? '#16A34A' : '#DC2626';
  return baseWrap(`
<p>Dear ${customer.customer_name},</p>
<p>The reconciliation of your account balance as on <strong>${asOfDate}</strong> has been completed by our Accounts Receivable team. A summary is below, with the detailed line-by-line reconciliation attached as an Excel workbook.</p>
<table style="border-collapse:collapse;margin:16px 0;width:100%;max-width:480px;">
  <tr><td style="padding:6px 12px;border:1px solid #ddd;">SAP Balance</td><td style="padding:6px 12px;border:1px solid #ddd;font-family:'Courier New',monospace;">${fmtCurrencyHTML(summary.total_sap_balance)}</td></tr>
  <tr><td style="padding:6px 12px;border:1px solid #ddd;">Your Balance</td><td style="padding:6px 12px;border:1px solid #ddd;font-family:'Courier New',monospace;">${fmtCurrencyHTML(summary.total_cust_balance)}</td></tr>
  <tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold;">Net Difference</td><td style="padding:6px 12px;border:1px solid #ddd;font-family:'Courier New',monospace;color:${diffColor};font-weight:bold;">${fmtCurrencyHTML(summary.net_difference)}</td></tr>
  <tr><td style="padding:6px 12px;border:1px solid #ddd;">Matched Items</td><td style="padding:6px 12px;border:1px solid #ddd;">${summary.matched}</td></tr>
  <tr><td style="padding:6px 12px;border:1px solid #ddd;">Items Needing Attention</td><td style="padding:6px 12px;border:1px solid #ddd;">${summary.matched_with_difference + summary.missing_in_customer + summary.not_in_sap}</td></tr>
</table>
${notes ? `<p><strong>AR Team Notes:</strong><br/>${notes.replace(/\n/g, '<br/>')}</p>` : ''}
<p>Please review the attached workbook. If you have questions about any line item, reply to this email or contact your relationship manager.</p>
<hr/>
<p style="font-size:12px;color:#444;">Regards,<br/><strong>${cfg.COMPANY} Accounts Receivable — Shared Services Centre</strong></p>`);
}

module.exports = { confirmationRequestEmail, reconciliationCompleteEmail };
