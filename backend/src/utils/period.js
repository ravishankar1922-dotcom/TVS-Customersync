/**
 * Period parsing/formatting — the single source of truth for how a Lot's
 * period is normalised and displayed. Accepts several natural input shapes
 * from the "Create New Lot" step (a plain object, an ISO "YYYY-MM" string,
 * or a human string like "March 2026") and always returns the same
 * canonical {year, month, label} shape so nothing downstream (lot numbering,
 * the customer portal, emails, exports) has to re-parse it.
 */
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function formatPeriodLabel(year, month) {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

function parsePeriod(input) {
  if (input && typeof input === 'object' && input.year != null && input.month != null) {
    const year = parseInt(input.year, 10), month = parseInt(input.month, 10);
    if (month < 1 || month > 12) throw new Error('Invalid month; expected 1-12.');
    return { year, month, label: formatPeriodLabel(year, month) };
  }
  const s = (input || '').toString().trim();
  if (!s) throw new Error('Period is required.');

  // "YYYY-MM" or "YYYY/MM"
  let m = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m) {
    const year = parseInt(m[1], 10), month = parseInt(m[2], 10);
    if (month < 1 || month > 12) throw new Error('Invalid month; expected 1-12.');
    return { year, month, label: formatPeriodLabel(year, month) };
  }

  // "March 2026" / "Mar 2026" (case-insensitive, abbreviations allowed)
  m = s.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const monthStr = m[1].toLowerCase();
    const idx = MONTH_NAMES.findIndex(mn => mn.toLowerCase() === monthStr || mn.toLowerCase().startsWith(monthStr.slice(0, 3)));
    if (idx === -1) throw new Error(`Could not recognise month "${m[1]}".`);
    const year = parseInt(m[2], 10);
    return { year, month: idx + 1, label: formatPeriodLabel(year, idx + 1) };
  }

  throw new Error(`Could not parse period "${s}". Expected e.g. "March 2026" or "2026-03".`);
}

function periodKey(year, month) { return `${year}-${String(month).padStart(2, '0')}`; }

// Sept 2026: "Add one more column under lot for the date of books... which
// is nothing but the lot name, changed to DD-MMM-YYYY" / "Book as of
// DD-MMM-YYYY" on the portal login / covering-letter date. A Lot only
// stores a MONTH (period_year/period_month — "March 2026"), never a day,
// since "Create New Lot" only ever asks for a period. Balance confirmation
// letters conventionally read "as on" the LAST calendar day of that period
// (this app's own legacy default, AS_OF_DATE=31-Mar-2026, is exactly the
// last day of CYCLE_ID's "TSL-MAR-2026" period) — so that's the single,
// consistent rule used everywhere a specific day is needed for a Lot.
function lastDayOfPeriod(year, month) {
  // Date.UTC(year, month, 0) — `month` here is already 1-indexed, so passing
  // it straight as the (0-indexed) target month rolls back from day 1 of
  // the FOLLOWING month to the last day of the period's own month.
  return new Date(Date.UTC(year, month, 0));
}

module.exports = { parsePeriod, formatPeriodLabel, periodKey, lastDayOfPeriod, MONTH_NAMES };
