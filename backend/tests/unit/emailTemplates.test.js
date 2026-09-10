const { confirmationRequestEmail, reconciliationCompleteEmail } = require('../../src/utils/emailTemplates');

describe('emailTemplates HTML escaping (BUGFIX regression test)', () => {
  test('a customer_name containing HTML is escaped, not injected raw', () => {
    const html = confirmationRequestEmail(
      { customer_name: '<img src=x onerror=alert(1)>TEST' }, 1000, 'http://x', '2026-01-01', 72
    );
    expect(html).not.toMatch(/<img src=x onerror=alert\(1\)>/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;TEST');
  });

  test('admin-entered reconciliation notes containing HTML are escaped', () => {
    const html = reconciliationCompleteEmail(
      { customer_name: 'TEST Customer' },
      { total_sap_balance: 1, total_cust_balance: 1, net_difference: 0, matched: 1, matched_with_difference: 0, missing_in_customer: 0, not_in_sap: 0 },
      '2026-01-01',
      '<script>alert(document.cookie)</script>'
    );
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toContain('&lt;script&gt;alert(document.cookie)&lt;/script&gt;');
  });

  test('a plain, ordinary name/notes still render unchanged (no over-escaping)', () => {
    const html = confirmationRequestEmail({ customer_name: 'Acme Traders Pvt Ltd' }, 1000, 'http://x', '2026-01-01', 72);
    expect(html).toContain('Dear Acme Traders Pvt Ltd,');
  });
});
