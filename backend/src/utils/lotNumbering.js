const { periodKey } = require('./period');

/**
 * Generates the next sequential lot_number for a given period, following
 * the LOT-YYYY-MM-NNN convention from the spec. Pure function — takes the
 * list of already-existing lot_numbers for that exact period (caller
 * queries the DB for that) and returns the next one, 3-digit zero-padded,
 * rolling to 4 digits past 999 rather than colliding.
 */
function nextLotNumber(year, month, existingNumbersForPeriod) {
  const prefix = `LOT-${periodKey(year, month)}-`;
  let maxSeq = 0;
  for (const n of existingNumbersForPeriod || []) {
    if (!n.startsWith(prefix)) continue;
    const seq = parseInt(n.slice(prefix.length), 10);
    if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
  }
  const next = maxSeq + 1;
  const width = next > 999 ? String(next).length : 3;
  return `${prefix}${String(next).padStart(width, '0')}`;
}

module.exports = { nextLotNumber };
