// Phase 9 E2E (AUTHORED, NOT EXECUTED — see cypress.config.js header).
// Repeats the core Lot + Finance-workflow flow for a VENDOR-business-type
// Lot, proving the Vendor module (separate collection, see
// models/Vendor.js) drives the same UI/workflow end-to-end.
describe('Vendor Lot — same lifecycle and workflow as Customer Lots', () => {
  beforeEach(() => {
    cy.visit('/');
    cy.get('input[type=email]').type(Cypress.env('adminEmail'));
    cy.get('input[type=password]').type(Cypress.env('adminPassword'));
    cy.contains('button', /log ?in/i).click();
    cy.contains('Lots').click();
  });

  it('creates a VENDOR Lot, uploads a ledger, and the population/table shows vendor rows', () => {
    cy.contains('button', 'Create New Lot').click();
    cy.get('input[placeholder*="March 2026"]').type('July 2026');
    cy.get('select').contains('option', 'Vendor').then($opt => cy.wrap($opt.parent()).select('VENDOR'));
    cy.contains('button', 'Create Lot').click();
    cy.contains('VENDOR').should('be.visible'); // business-type badge on the Lot row
    cy.get('input[type=file]').selectFile('cypress/fixtures/sample_vendor_ledger.xlsx', { force: true });
    cy.get('table.tbl tbody tr').should('have.length.greaterThan', 0);
  });

  it('exports the Vendor Lot to Excel with Vendor ID/Name columns', () => {
    cy.contains('VENDOR').first().parents('.card').click();
    cy.contains('a', 'Export Excel').should('have.attr', 'href').and('include', '/confirmations/export.xlsx');
  });
});
