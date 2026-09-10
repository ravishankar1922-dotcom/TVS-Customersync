const { passesBalanceFilter } = require('../../src/utils/balanceFilter');

describe('passesBalanceFilter — balance-based confirmation filters (spec)', () => {
  test('no filter / missing op passes everything', () => {
    expect(passesBalanceFilter(5000, null)).toBe(true);
    expect(passesBalanceFilter(5000, {})).toBe(true);
  });

  test('comparison operators', () => {
    expect(passesBalanceFilter(5000, { op: 'gt', value: 4999 })).toBe(true);
    expect(passesBalanceFilter(5000, { op: 'gt', value: 5000 })).toBe(false);
    expect(passesBalanceFilter(5000, { op: 'gte', value: 5000 })).toBe(true);
    expect(passesBalanceFilter(4999, { op: 'lt', value: 5000 })).toBe(true);
    expect(passesBalanceFilter(5000, { op: 'lte', value: 5000 })).toBe(true);
    expect(passesBalanceFilter(5000, { op: 'eq', value: 5000 })).toBe(true);
    expect(passesBalanceFilter(5000.001, { op: 'eq', value: 5000 })).toBe(true); // float tolerance
  });

  test('between / custom range is inclusive and order-independent', () => {
    expect(passesBalanceFilter(500, { op: 'between', value: 100, value2: 1000 })).toBe(true);
    expect(passesBalanceFilter(100, { op: 'between', value: 100, value2: 1000 })).toBe(true);
    expect(passesBalanceFilter(1000, { op: 'between', value: 100, value2: 1000 })).toBe(true);
    expect(passesBalanceFilter(1001, { op: 'between', value: 100, value2: 1000 })).toBe(false);
    expect(passesBalanceFilter(500, { op: 'between', value: 1000, value2: 100 })).toBe(true); // reversed bounds still work
  });

  test('zero / negative / positive shortcuts', () => {
    expect(passesBalanceFilter(0, { op: 'zero' })).toBe(true);
    expect(passesBalanceFilter(0.001, { op: 'zero' })).toBe(true); // float tolerance
    expect(passesBalanceFilter(-5, { op: 'negative' })).toBe(true);
    expect(passesBalanceFilter(5, { op: 'negative' })).toBe(false);
    expect(passesBalanceFilter(5, { op: 'positive' })).toBe(true);
    expect(passesBalanceFilter(-5, { op: 'positive' })).toBe(false);
    expect(passesBalanceFilter(0, { op: 'positive' })).toBe(false);
  });

  test('an unknown op fails open (no filtering) rather than silently excluding everyone', () => {
    expect(passesBalanceFilter(5000, { op: 'bogus' })).toBe(true);
  });
});
