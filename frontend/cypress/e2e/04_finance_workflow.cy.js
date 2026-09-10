// Phase 9 E2E (AUTHORED, NOT EXECUTED — see cypress.config.js header).
// Covers: the full Finance clarification workflow —
//   Admin -> Finance -> Admin -> Customer -> Admin
// using two separate logins (Admin, Finance) and the WorkflowModal added to
// LotOverview.jsx in this phase. Repeated in 05_vendor_workflow.cy.js for a
// VENDOR-business-type Lot, per the spec's requirement that the same
// workflow apply identically to both business types.
function loginAs(email, password) {
  cy.visit('/');
  cy.get('input[type=email]').type(email);
  cy.get('input[type=password]').type(password);
  cy.contains('button', /log ?in/i).click();
}

describe('Finance clarification workflow (Customer Lot)', () => {
  it('routes Admin -> Finance -> Admin -> Customer -> Admin with full history', () => {
    // 1. Admin routes a submitted confirmation to Finance with a comment.
    loginAs(Cypress.env('adminEmail'), Cypress.env('adminPassword'));
    cy.contains('Lots').click();
    cy.contains(/^LOT-/).first().click();
    cy.get('table.tbl tbody tr').first().find('[title="Finance workflow"]').click();
    cy.get('textarea').type('Please double-check the credit note.');
    cy.contains('button', 'Route to Finance').click();
    cy.contains('Routed to Finance').should('be.visible');
    cy.contains('button', /close|×/i).click({ force: true });

    // 2. Finance logs in, sees the item in FINANCE_REVIEW, routes it back
    //    to Admin (or out to the customer for clarification).
    loginAs(Cypress.env('financeEmail'), Cypress.env('financePassword'));
    cy.contains('Lots').click();
    cy.contains(/^LOT-/).first().click();
    cy.get('table.tbl tbody tr').first().find('[title="Finance workflow"]').click();
    cy.contains('Finance Review').should('be.visible'); // workflow badge
    cy.get('textarea').type('Confirmed — please ask the customer to clarify the Rs.500 gap.');
    cy.contains('button', 'Route to Customer').click();
    cy.contains('Routed to Customer').should('be.visible');

    // 3. History shows the full chronological chain, oldest first.
    cy.get('[style*="border"]').contains('ROUTED_TO_FINANCE').should('exist');
    cy.contains('ROUTED_TO_CUSTOMER').should('exist');
  });
});
