/**
 * Balance-confirmation covering letter, generated as a PDF the customer can
 * download once their confirmation has been submitted (Sept 2026: "Once the
 * balance confirmed they should able to download the cover letter PDF...
 * Change it to TVS Srichakra Ltd, to should for that particular customer,
 * amount, date should automatically change according to the lot").
 *
 * Layout/wording is adapted from the reference sample letter the admin
 * provided (a standard Indian corporate balance-confirmation letter with a
 * tear-off reply slip) — only the letterhead, recipient, amount and date
 * are parametrized per {lot, customer, confirmation}. Built with pdf-lib
 * (already a dependency) rather than an HTML->PDF renderer, since the
 * layout is simple enough to lay out directly and this avoids adding a
 * headless-browser dependency just for one letter template.
 */
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const cfg = require('../config');
const { lastDayOfPeriod } = require('./period');

const PAGE_W = 595.28; // A4 in points
const PAGE_H = 841.89;
const MARGIN = 56;

function fmtRs(amount) {
  const formatted = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(amount || 0));
  return `Rs. ${formatted}`;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Accepts a Date or any string a real Lot's period_label/AS_OF_DATE might
// hold (e.g. "31-Mar-2026", "March 2026") — same tolerant parsing the rest
// of the app already relies on (see frontend's fmtDate). Falls back to the
// raw string if it truly can't be parsed, rather than throwing.
function parseFlexibleDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  return isNaN(d) ? null : d;
}

function fmtLongDate(input) {
  const d = parseFlexibleDate(input);
  if (!d) return String(input || '');
  return `${ordinal(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function fmtShortDate(input) {
  const d = parseFlexibleDate(input);
  if (!d) return String(input || '');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${dd}-${MONTHS[d.getUTCMonth()].slice(0, 3)}-${d.getUTCFullYear()}`;
}

// Indian companies commonly run an April-March fiscal year; derive "FY
// 25-26" style label from the book date so the letter reads naturally
// without needing a separate fiscal-year field anywhere in the data model.
function fiscalYearLabel(input) {
  const d = parseFlexibleDate(input);
  if (!d) return '';
  const y = d.getUTCFullYear();
  const startYear = d.getUTCMonth() < 3 ? y - 1 : y; // Jan-Mar -> FY started previous calendar year
  return `${String(startYear).slice(-2)}-${String(startYear + 1).slice(-2)}`;
}

/**
 * @param {object} opts
 * @param {object} opts.lot          - Lot doc (period_year/period_month give the "book date" — see lastDayOfPeriod)
 * @param {object} opts.customer     - { customer_id, customer_name }
 * @param {object} opts.confirmation - Confirmation doc (sap_balance, cust_balance, status, submitted_at)
 * @returns {Promise<Buffer>}
 */
async function buildCoveringLetterPdf({ lot, customer, confirmation }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);

  const ink = rgb(0.1, 0.1, 0.1);
  const muted = rgb(0.4, 0.4, 0.4);
  let y = PAGE_H - MARGIN;

  const bookDate = lastDayOfPeriod(lot.period_year, lot.period_month);
  const bookDateLong = fmtLongDate(bookDate);
  const bookDateShort = fmtShortDate(bookDate);
  const fy = fiscalYearLabel(bookDate);
  const sapBalance = confirmation.sap_balance || 0;
  const custBalance = confirmation.cust_balance;
  const isDifference = confirmation.status === 'DIFFERENCE';
  const balanceSide = sapBalance >= 0 ? 'Debit' : 'Credit';

  function text(str, { x = MARGIN, size = 10.5, f = font, color = ink, maxWidth = PAGE_W - 2 * MARGIN, lineGap = 5 } = {}) {
    const words = String(str).split(/\s+/);
    let line = '';
    const lines = [];
    for (const w of words) {
      const trial = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(trial, size) > maxWidth && line) { lines.push(line); line = w; }
      else line = trial;
    }
    if (line) lines.push(line);
    for (const l of lines) {
      page.drawText(l, { x, y, size, font: f, color });
      y -= size + lineGap;
    }
  }
  function gap(px) { y -= px; }
  function centered(str, { size = 12, f = bold, color = ink } = {}) {
    const w = f.widthOfTextAtSize(str, size);
    page.drawText(str, { x: (PAGE_W - w) / 2, y, size, font: f, color });
    y -= size + 4;
  }

  // ── Letterhead ────────────────────────────────────────────────────────
  // Sept 2026: "TSL address in PDF is wrong, so please remove the address."
  // No postal address is printed — just the company name — until a correct
  // one is available (see cfg.COMPANY_CONTACT below, which stays optional).
  centered(cfg.COMPANY_FULL_NAME.toUpperCase(), { size: 13 });
  if (cfg.COMPANY_CONTACT) { page.drawText(cfg.COMPANY_CONTACT, { x: MARGIN, y, size: 9, font, color: muted }); y -= 14; }
  // underline rule under the letterhead
  page.drawLine({ start: { x: MARGIN, y: y + 4 }, end: { x: PAGE_W - MARGIN, y: y + 4 }, thickness: 0.75, color: rgb(0.75, 0.75, 0.75) });
  gap(20);

  text(fmtLongDate(new Date()), { size: 10 });
  gap(10);

  text('To,', { size: 10.5 });
  text(customer.customer_name, { size: 10.5, f: bold });
  text(`(Customer ID: ${customer.customer_id})`, { size: 9, color: muted });
  gap(10);

  text('Dear Sirs,', { size: 10.5 });
  gap(6);

  text(`Sub.: Confirmation of Balance as on ${bookDateLong}`, { size: 10.5, f: bold });
  gap(6);

  text(
    `In connection with the Internal audit process of our Accounts for FY ${fy}, we would request you to confirm, that an amount of ${fmtRs(sapBalance)} (${balanceSide} balance) due to us as on ${bookDateLong}. If the amount shown above agrees with your books, please sign, and return the duplicate copy of this letter to us. Also enclosed Invoice wise details for your reference.`
  );
  gap(4);
  text('In the event of any disagreement, please inform us immediately of the amount as per your records with invoice wise outstanding details. Your prompt compliance with our request will be appreciated.');
  gap(4);
  text('In the absence of any confirmation within FIFTEEN DAYS from the date of receipt of this letter, it will be assumed that the balance shown above by us is confirmed.');
  gap(10);

  if (isDifference && custBalance != null) {
    text(
      `Note: our records show you submitted a balance of ${fmtRs(custBalance)} for this period through our online confirmation portal, a difference of ${fmtRs(Math.abs(sapBalance - custBalance))} from our books above. This has been forwarded to our reconciliation team.`,
      { f: italic, size: 9.5, color: muted }
    );
    gap(10);
  }

  text('Thanking You,', { size: 10.5 });
  text('Yours faithfully,', { size: 10.5 });
  gap(4);
  text(`for ${cfg.COMPANY_FULL_NAME.toUpperCase()},`, { size: 10.5, f: bold });
  gap(30);
  text('Authorised Signatory', { size: 10.5 });

  // ── Tear-off reply slip ──────────────────────────────────────────────
  gap(18);
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6), dashArray: [3, 3] });
  gap(20);

  text('To', { size: 10 });
  text(cfg.COMPANY_FULL_NAME, { size: 10, f: bold });
  gap(14);

  const tick1 = !isDifference ? '[X]' : '[ ]';
  const tick2 = isDifference ? '[X]' : '[ ]';
  text(`1. ${tick1} We confirm that the above amount of ${fmtRs(sapBalance)} (Credit Balance) is due to you as on ${bookDateLong}.`);
  gap(4);
  text(`2. ${tick2} The balance due to you / us as per our record is ${isDifference && custBalance != null ? fmtRs(custBalance) : '_______________'} and our statement of Account is enclosed.`);
  gap(4);
  text('(the applicable statement above is pre-marked from your online submission; please correct if it no longer reflects your records)', { size: 8.5, f: italic, color: muted });
  gap(20);

  const placeX = MARGIN;
  const dateY = y;
  text('Place : _______________', { x: placeX, size: 10 });
  y = dateY;
  const submittedShort = confirmation.submitted_at ? fmtShortDate(confirmation.submitted_at) : bookDateShort;
  const dateLabel = `Date : ${submittedShort}`;
  page.drawText('Authorized Signatory.', { x: PAGE_W - MARGIN - font.widthOfTextAtSize('Authorized Signatory.', 10), y: dateY, size: 10, font, color: ink });
  y -= 16;
  page.drawText(dateLabel, { x: placeX, y, size: 10, font, color: ink });
  const nameLine = `(${customer.customer_name}, Designation, Company seal)`;
  page.drawText(nameLine, { x: PAGE_W - MARGIN - font.widthOfTextAtSize(nameLine, 8.5), y, size: 8.5, font, color: muted });

  return Buffer.from(await doc.save());
}

module.exports = { buildCoveringLetterPdf, fmtRs, fmtLongDate, fmtShortDate, fiscalYearLabel };
