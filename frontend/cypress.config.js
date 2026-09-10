// Phase 9 — Cypress E2E configuration.
//
// IMPORTANT / KNOWN LIMITATION: these specs are AUTHORED but UNEXECUTED in
// this engagement's sandbox — there is no live deployed frontend+backend
// (with a real MongoDB and SMTP) reachable from here, and Cypress itself is
// not installed (no network access to fetch its binary). They are written
// against the actual, shipped API/UI contracts (routes/lots.js, api.js,
// LotOverview.jsx) so that once the app is deployed to a real environment,
// running `npx cypress run` (after `npm i -D cypress` and `npm start`)
// should need no changes beyond baseUrl/test credentials. See the final
// report's Testing section for the full list of what these specs cover and
// why they could not be executed here.
const { defineConfig } = require('cypress');

module.exports = defineConfig({
  e2e: {
    baseUrl: process.env.CYPRESS_BASE_URL || 'http://localhost:3000',
    supportFile: false,
    specPattern: 'cypress/e2e/**/*.cy.js',
    viewportWidth: 1280,
    viewportHeight: 800,
    defaultCommandTimeout: 8000,
  },
  env: {
    apiBase: process.env.CYPRESS_API_BASE || 'http://localhost:5000',
    adminEmail: process.env.CYPRESS_ADMIN_EMAIL || 'admin@example.test',
    adminPassword: process.env.CYPRESS_ADMIN_PASSWORD || 'change-me',
    financeEmail: process.env.CYPRESS_FINANCE_EMAIL || 'finance@example.test',
    financePassword: process.env.CYPRESS_FINANCE_PASSWORD || 'change-me',
  },
});
