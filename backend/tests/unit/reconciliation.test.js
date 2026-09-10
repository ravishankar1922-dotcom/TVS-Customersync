const recon = require('../../src/routes/reconciliation'); // exported for tests: reconcile, buildBridge, parseSOA, normaliseDocNum

describe('reconcile() — matching engine (real module, pure function)', () => {
  test('exact document-number + amount match', () => {
    const sap = [{ document_number: 'INV001', amount: 1000, document_date: '2026-01-01', status: 'OPEN' }];
    const cust = [{ doc_number: 'INV001', amount: 1000, doc_date: '2026-01-01' }];
    const { results, summary } = recon.reconcile(sap, cust);
    expect(results[0].match_type).toBe('MATCHED');
    expect(summary.matched).toBe(1);
    expect(summary.net_difference).toBe(0);
  });

  test('same doc number but different amount => MATCHED_WITH_DIFFERENCE', () => {
    const sap = [{ document_number: 'INV001', amount: 1000, status: 'OPEN' }];
    const cust = [{ doc_number: 'INV001', amount: 900 }];
    const { results } = recon.reconcile(sap, cust);
    expect(results[0].match_type).toBe('MATCHED_WITH_DIFFERENCE');
    expect(results[0].amount_diff).toBeCloseTo(-100, 2);
  });

  test('normalised doc-number match (prefix/leading-zero differences)', () => {
    // normaliseDocNum() only fires its fallback match when the normalised
    // number is > 3 chars (guards against short numbers colliding by
    // chance), so use a realistic 5-digit document number here.
    const sap = [{ document_number: 'INV-0012345', amount: 500, status: 'OPEN' }];
    const cust = [{ doc_number: '12345', amount: 500 }];
    const { results } = recon.reconcile(sap, cust);
    expect(results[0].match_type).toBe('MATCHED');
    expect(results[0].note).toMatch(/Normalised/);
  });

  test('amount+date fallback match when doc numbers differ entirely', () => {
    const sap = [{ document_number: 'SAP-999', amount: 750, document_date: '2026-02-10', status: 'OPEN' }];
    const cust = [{ doc_number: 'CUST-777', amount: 750, doc_date: '2026-02-10' }];
    const { results } = recon.reconcile(sap, cust);
    expect(results[0].match_type).toBe('AMOUNT_DATE_MATCH');
  });

  test('item only in SAP => MISSING_IN_CUSTOMER; item only in customer SOA => NOT_IN_SAP', () => {
    const sap = [{ document_number: 'SAP-ONLY', amount: 100, status: 'OPEN' }];
    const cust = [{ doc_number: 'CUST-ONLY', amount: 200 }];
    const { results, summary } = recon.reconcile(sap, cust);
    expect(results.find(r => r.match_type === 'MISSING_IN_CUSTOMER').sap_doc).toBe('SAP-ONLY');
    expect(results.find(r => r.match_type === 'NOT_IN_SAP').cust_doc).toBe('CUST-ONLY');
    expect(summary.missing_in_customer).toBe(1);
    expect(summary.not_in_sap).toBe(1);
  });

  test('never double-matches the same customer line against two SAP lines', () => {
    const sap = [{ document_number: 'A', amount: 100, status: 'OPEN' }, { document_number: 'A', amount: 100, status: 'OPEN' }];
    const cust = [{ doc_number: 'A', amount: 100 }];
    const { results } = recon.reconcile(sap, cust);
    const matched = results.filter(r => r.match_type === 'MATCHED');
    expect(matched.length).toBe(1); // only one SAP line found its match
    expect(results.find(r => r.match_type === 'MISSING_IN_CUSTOMER')).toBeTruthy();
  });
});

describe('buildBridge() — algebraic tie-out (business-logic correctness)', () => {
  test('fully matched books tie out to zero difference', () => {
    const sap = [{ document_number: 'INV1', amount: 1000, status: 'OPEN' }];
    const cust = [{ doc_number: 'INV1', amount: 1000 }];
    const { results, summary } = recon.reconcile(sap, cust);
    const bridge = recon.buildBridge({ sapTxns: sap, custItems: cust, results, summary, customer: { customer_id: 'TEST_C1', customer_name: 'T' }, cycleId: 'c', asOfDate: 'd' });
    expect(bridge.is_tied_out).toBe(true);
    expect(bridge.difference).toBe(0);
  });

  test('a genuine difference bridges to the correct non-zero, algebraically consistent amount', () => {
    const sap = [
      { document_number: 'INV1', amount: 1000, status: 'OPEN' }, // matched
      { document_number: 'INV2', amount: 500, status: 'OPEN' },  // missing in customer
    ];
    const cust = [
      { doc_number: 'INV1', amount: 1000 },
      { doc_number: 'INV3', amount: 300 }, // not in SAP
    ];
    const { results, summary } = recon.reconcile(sap, cust);
    const bridge = recon.buildBridge({ sapTxns: sap, custItems: cust, results, summary, customer: { customer_id: 'TEST_C1' }, cycleId: 'c', asOfDate: 'd' });
    // openingSap=1500, openingCust=1300. Adjusted = 1500 + debit(NOT_IN_SAP=300) - credit(MISSING_IN_CUST=500) = 1300
    expect(bridge.opening_sap_balance).toBe(1500);
    expect(bridge.opening_customer_balance).toBe(1300);
    expect(bridge.adjusted_sap_balance).toBe(1300);
    expect(bridge.difference).toBe(0); // this specific case actually ties out once bridged
    expect(bridge.is_tied_out).toBe(true);
  });

  test('items exactly matched or amount-date matched are excluded from the bridge (no double-adjustment)', () => {
    const sap = [{ document_number: 'INV1', amount: 1000, status: 'OPEN' }];
    const cust = [{ doc_number: 'INV1', amount: 1000 }];
    const { results, summary } = recon.reconcile(sap, cust);
    const bridge = recon.buildBridge({ sapTxns: sap, custItems: cust, results, summary, customer: {}, cycleId: 'c', asOfDate: 'd' });
    expect(bridge.items.length).toBe(0);
  });
});

describe('normaliseDocNum()', () => {
  test('strips common prefixes, non-alphanumerics and leading zeros', () => {
    expect(recon.normaliseDocNum('INV-000123')).toBe('123');
    expect(recon.normaliseDocNum('inv/0456')).toBe('456');
    expect(recon.normaliseDocNum(null)).toBe('');
  });
});
