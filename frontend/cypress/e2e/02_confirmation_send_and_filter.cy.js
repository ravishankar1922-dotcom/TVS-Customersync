// Phase 9 E2E (AUTHORED, NOT EXECUTED — see cypress.config.js header).
// Covers: balance filter + targeted-select confirmation sending from a
// Lot's detail view.
describe('Balance filter + targeted send', () => {
  beforeEach(() => {
    cy.visit('/');
    cy.get('input[type=email]').type(Cypress.env('adminEmail'));
    cy.get('input[type=password]').type(Cypress.env('adminPassword'));
    cy.contains('button', /log ?in/i).click();
    cy.contains('Lots').click();
  });

  it('sends confirmation links only to customers matching a balance filter', () => {
    cy.contains(/^LOT-/).first().click();
    cy.get('select.flt-sel').first().select('Balance ≥');
    cy.get('input[type=number]').first().type('5000');
    cy.contains('button', 'Send Confirmation Link(s)').click();
    cy.contains(/confirmation link/i).should('be.visible');
  });

  it('sends only to explicitly checked customers (targeted send) regardless of the filter', () => {
    cy.contains(/^LOT-/).first().click();
    cy.get('table.tbl tbody tr').first().find('input[type=checkbox]').check({ force: true });
    cy.contains('button', 'Send Confirmation Link(s)').click();
    cy.contains(/1.*sent|1.*generated/i).should('be.visible');
  });
});
