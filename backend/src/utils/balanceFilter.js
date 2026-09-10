/**
 * Balance-based confirmation filter (spec section on targeted sending):
 * >, >=, <, <=, =, between, zero, negative, positive, plus a plain custom
 * range (reuses "between"). Used to select which of a Lot's population
 * should receive a confirmation link, independent of / combinable with an
 * explicit customer_ids selection.
 */
function passesBalanceFilter(balance, filter) {
  if (!filter || !filter.op) return true;
  const b = typeof balance === 'number' ? balance : parseFloat(balance) || 0;
  const v1 = filter.value != null ? parseFloat(filter.value) : null;
  const v2 = filter.value2 != null ? parseFloat(filter.value2) : null;

  switch (filter.op) {
    case 'gt':  return v1 != null && b > v1;
    case 'gte': return v1 != null && b >= v1;
    case 'lt':  return v1 != null && b < v1;
    case 'lte': return v1 != null && b <= v1;
    case 'eq':  return v1 != null && Math.abs(b - v1) < 0.005;
    case 'between':
    case 'custom': {
      if (v1 == null || v2 == null) return true; // incomplete range = no filtering
      const lo = Math.min(v1, v2), hi = Math.max(v1, v2);
      return b >= lo && b <= hi;
    }
    case 'zero':     return Math.abs(b) < 0.005;
    case 'negative': return b < 0;
    case 'positive': return b > 0;
    default: return true; // unknown op — fail open (no filtering) rather than silently excluding everyone
  }
}

module.exports = { passesBalanceFilter };
