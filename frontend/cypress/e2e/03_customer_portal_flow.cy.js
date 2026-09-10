// Phase 9 E2E (AUTHORED, NOT EXECUTED — see cypress.config.js header).
// Covers: full customer portal flow via a reopenable Lot-scoped token link
// — PAN gate, initial submission, reopen, amend/resubmit (never
// single-use-blocked, per the spec's critical change from Phase 2).
describe('Customer portal — reopenable Lot-scoped confirmation link', () => {
  // The portal URL/token would come from a prior admin "send" step or be
  // seeded directly via the API for test isolation, e.g.:
  //   cy.request('POST', `${Cypress.env('apiBase')}/api/lots/:id/tokens/generate`, {...})
  // then extracting portal_url from the response.
  let portalUrl;

  before(() => {
    // Placeholder — in a real run this would seed a Lot/ledger/token via the
    // API (as an authenticated admin) and capture the resulting portal_url.
    portalUrl = Cypress.env('seededPortalUrl') || '/confirm/REPLACE_WITH_SEEDED_TOKEN';
  });

  it('gates the link behind PAN verification', () => {
    cy.visit(portalUrl);
    cy.get('input[name=pan], input[placeholder*=PAN]').type('WRONGPAN1');
    cy.contains('button', /verify|submit/i).click();
    cy.contains(/mismatch|incorrect|invalid/i).should('be.visible');
  });

  it('accepts a first submission and shows a MATCHED/DIFFERENCE result', () => {
    cy.visit(portalUrl);
    cy.get('input[name=pan], input[placeholder*=PAN]').type('ABCDE1234F');
    cy.contains('button', /verify|submit/i).click();
    cy.get('input[type=number]').clear().type('10000');
    cy.contains('button', /confirm|submit/i).click();
    cy.contains(/matched|difference/i).should('be.visible');
  });

  it('the SAME link can be reopened and the customer can amend/resubmit — never single-use-blocked', () => {
    cy.visit(portalUrl);
    cy.get('input[name=pan], input[placeholder*=PAN]').type('ABCDE1234F');
    cy.contains('button', /verify|submit/i).click();
    // Link still opens (not "already used") — the core Phase 2 requirement.
    cy.get('input[type=number]').should('be.visible');
    cy.get('input[type=number]').clear().type('9500');
    cy.contains('button', /confirm|submit|amend/i).click();
    cy.contains(/received|updated|amended/i).should('be.visible');
  });
});
