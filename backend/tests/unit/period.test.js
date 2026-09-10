const { parsePeriod, formatPeriodLabel, periodKey } = require('../../src/utils/period');
const { nextLotNumber } = require('../../src/utils/lotNumbering');

describe('parsePeriod()', () => {
  test('parses "March 2026"', () => {
    expect(parsePeriod('March 2026')).toEqual({ year: 2026, month: 3, label: 'March 2026' });
  });
  test('parses abbreviated "Mar 2026"', () => {
    expect(parsePeriod('Mar 2026')).toEqual({ year: 2026, month: 3, label: 'March 2026' });
  });
  test('parses ISO "2026-06"', () => {
    expect(parsePeriod('2026-06')).toEqual({ year: 2026, month: 6, label: 'June 2026' });
  });
  test('parses an object { year, month }', () => {
    expect(parsePeriod({ year: 2026, month: 12 })).toEqual({ year: 2026, month: 12, label: 'December 2026' });
  });
  test('rejects an empty/missing period', () => {
    expect(() => parsePeriod('')).toThrow(/required/);
    expect(() => parsePeriod(null)).toThrow(/required/);
  });
  test('rejects an invalid month number', () => {
    expect(() => parsePeriod('2026-13')).toThrow(/Invalid month/);
    expect(() => parsePeriod({ year: 2026, month: 0 })).toThrow(/Invalid month/);
  });
  test('rejects unparseable garbage without throwing something unexpected', () => {
    expect(() => parsePeriod('not a period at all')).toThrow(/Could not parse/);
  });
});

describe('nextLotNumber()', () => {
  test('first Lot of a period is 001', () => {
    expect(nextLotNumber(2026, 3, [])).toBe('LOT-2026-03-001');
  });
  test('increments sequentially within the same period', () => {
    expect(nextLotNumber(2026, 3, ['LOT-2026-03-001'])).toBe('LOT-2026-03-002');
    expect(nextLotNumber(2026, 3, ['LOT-2026-03-001', 'LOT-2026-03-002'])).toBe('LOT-2026-03-003');
  });
  test('ignores lot numbers from OTHER periods entirely', () => {
    expect(nextLotNumber(2026, 6, ['LOT-2026-03-001', 'LOT-2026-03-002'])).toBe('LOT-2026-06-001');
  });
  test('is resilient to out-of-order/gappy input (takes the max, not the count)', () => {
    expect(nextLotNumber(2026, 3, ['LOT-2026-03-001', 'LOT-2026-03-005'])).toBe('LOT-2026-03-006');
  });
});
