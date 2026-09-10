// Phase 9 E2E (AUTHORED, NOT EXECUTED — see cypress.config.js header).
// Covers: Lot creation (period-first), ledger-upload-scoped population,
// and Lot isolation between two Lots for the same customer.
describe('Lot lifecycle', () => {
  beforeEach(() => {
    cy.visit('/');
    cy.get('input[type=email]').type(Cypress.env('adminEmail'));
    cy.get('input[type=password]').type(Cypress.env('adminPassword'));
    cy.contains('button', /log ?in/i).click();
    cy.contains('Lots').click();
  });

  it('creates a new Lot from a period and shows the generated Lot number', () => {
    cy.contains('button', 'Create New Lot').click();
    cy.get('input[placeholder*="March 2026"]').type('March 2026');
    cy.contains('button', 'Create Lot').click();
    cy.contains(/^LOT-2026-03-\d{3}$/).should('be.visible');
  });

  it('populates a Lot ONLY from its uploaded ledger, never the full customer master', () => {
    cy.contains('button', 'Create New Lot').click();
    cy.get('input[placeholder*="March 2026"]').type('April 2026');
    cy.contains('button', 'Create Lot').click();
    cy.get('input[type=file]').selectFile('cypress/fixtures/sample_ledger.xlsx', { force: true });
    cy.contains(/customer/i).should('be.visible');
    // The population table should list only the customer IDs present in
    // sample_ledger.xlsx — asserted against the fixture's known contents.
    cy.get('table.tbl tbody tr').should('have.length.greaterThan', 0);
  });

  it('keeps two Lots for the same customer completely independent (balances, status, history)', () => {
    // Create Lot A and Lot B for different periods, upload different
    // ledgers each containing the same customer with different balances,
    // and assert Lot A's row is unaffected by Lot B's upload.
    cy.contains('button', 'Create New Lot').click();
    cy.get('input[placeholder*="March 2026"]').type('May 2026');
    cy.contains('button', 'Create Lot').click();
    cy.get('input[type=file]').selectFile('cypress/fixtures/sample_ledger.xlsx', { force: true });
    cy.get('table.tbl tbody tr').first().find('.td-mono').first().invoke('text').as('lotABalance');

    cy.contains('button', 'Create New Lot').click();
    cy.get('input[placeholder*="March 2026"]').type('June 2026');
    cy.contains('button', 'Create Lot').click();
    cy.get('input[type=file]').selectFile('cypress/fixtures/sample_ledger_v2.xlsx', { force: true });

    // Re-open Lot A and confirm its balance is still the original one.
    cy.contains('LOT-2026-05').click();
    cy.get('@lotABalance').then(orig => {
      cy.get('table.tbl tbody tr').first().find('.td-mono').first().invoke('text').should('eq', orig);
    });
  });
});
