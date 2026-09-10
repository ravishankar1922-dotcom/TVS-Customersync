# BalanceSync Architecture Overhaul — Final Report

**Scope:** Full move from a customer/cycle-oriented model to
**Business Type → Lot → Customer/Vendor → Confirmation → Reconciliation →
Complete History**, delivered across 9 phases without breaking any existing
(legacy, non-Lot) functionality.

**Status at delivery:** Phases 1–7 and 9 fully implemented and tested against
this sandbox's in-memory Jest harness (**124/124 backend tests passing, zero
regressions**). Phase 8 (running the migration against a real database) is
blocked by this sandbox having no live MongoDB — see "Production Readiness"
below for the exact command to run it once deployed.

---

## 1. Architecture Changes

- **New primary hierarchy:** `Lot` (one per period × business type × upload)
  now owns everything below it — its own `LotPopulation`, `Confirmation`s,
  `SubmissionVersion` history, `TokenRecord`s, and audit trail. Nothing about
  one Lot is ever shared with another, even for the identical customer.
- **Business Type split:** every Lot has `business_type: CUSTOMER | VENDOR`.
  A `masterModelFor(lot)` / `lookupMasterByIds(lot, ids)` abstraction in
  `routes/lots.js` normalizes Customer and Vendor into the same
  `{id, name, email, pan}` shape so the rest of the Lot-routing code never
  needs to branch on business type.
- **Vendor kept as a fully separate collection** (not a discriminator or
  shared schema) — an explicit decision from earlier in this engagement,
  re-verified this phase with a test that seeds a Customer and a Vendor with
  the same ID but different names and proves a VENDOR Lot only ever reads
  from Vendor.
- **Role/authorization layer** added on top of (not duplicating) the
  existing JWT `requireAdmin` middleware: `requireRole(...)`,
  `requireFinance`, `requireAdminOnly`, `requireAdminOrFinance`, and an
  `assertBusinessAccess()` helper for future per-business-type scoping.
- **Finance clarification workflow** is a small state machine
  (`ADMIN_REVIEW ⇄ FINANCE_REVIEW ⇄ CUSTOMER_CLARIFICATION`, with
  `COMPLETED` reserved for future use) living on `Confirmation.workflow_status`,
  routed through three new endpoints in `routes/lots.js`.
- **PDF SOA extraction** closes a previously-documented gap: PDFs were
  accepted for upload but never actually parsed. `utils/pdfParser.js` now
  extracts real text (via `pdf-parse`/`pdfjs-dist`) and a line-based
  heuristic, with a confidence score gating whether any reconciliation data
  is produced at all.
- **Lot-aware Excel export** (`GET /api/lots/:lotId/confirmations/export.xlsx`)
  gives Admin/Finance a single-Lot, never-cross-Lot download of the full
  confirmation state.

Nothing in the legacy (pre-Lot, `cycle_id`-scoped) flow — `routes/confirmations.js`,
the original customer portal, the original Overview/Dashboard — was touched
beyond the one shared `parseSOA()` helper, which now also serves the Lot flow.

---

## 2. Database Changes

### New models
| Model | Purpose |
|---|---|
| `Lot` | Period × business-type container; `lot_number`, `period_label`, `status`, population/balance rollups, `is_legacy` flag for migrated data. |
| `LotPopulation` | The customers/vendors actually present in one Lot's uploaded ledger — never the full master. |
| `SubmissionVersion` | Full, append-only amendment history for one `{lot_id, customer_id}` — a customer's re-submission never overwrites a prior version. |
| `Vendor` | Fully separate master collection mirroring `Customer` (`vendor_id`, `vendor_name`, `company`, `email`, `pan`, `status`). |

### Modified models
| Model | Change |
|---|---|
| `Confirmation` | + `lot_id` (nullable, indexed — null for all legacy records), `current_version`, `workflow_status`, `workflow_comment`. New partial unique index on `{lot_id, customer_id}` so it never collides with the legacy `{customer_id, cycle_id}` index. |
| `TokenRecord` | + `lot_id` (nullable), `business_type`. Lot-scoped tokens never set `status: 'USED'` — they stay `ACTIVE` (reopenable) until expiry/revocation, per the spec's critical single-use-removal requirement. Legacy tokens are completely unaffected. |
| `Admin` | `role` enum extended with `FINANCE`; + `business_type` (`CUSTOMER \| VENDOR \| BOTH`). |

### Indexes added
- `LotSchema.index({ period_year, period_month, business_type })`
- `ConfirmationSchema.index({ lot_id, customer_id }, { unique: true, partialFilterExpression: { lot_id: { $type: 'objectId' } } })`
- `TokenRecordSchema.index({ lot_id, customer_id })`

### Migration
`backend/src/scripts/migrate-legacy-lots.js` (written in an earlier phase)
backfills a synthetic Lot per legacy `cycle_id`, tagged `is_legacy: true`.
Its logic is unit-tested (`tests/unit/migrateLegacyLots.test.js`) against the
same fake-model harness as everything else in this report, but **has not
been run against a real database** — this sandbox has no reachable MongoDB.
See "Production Readiness" for the exact run instructions.

---

## 3. API Changes

All new/changed routes live in `backend/src/routes/lots.js` and
`backend/src/routes/vendors.js`. Every Lot-scoped route validates
`{lot_id, customer_id}` together — never `customer_id` alone, since the same
customer can have independent Confirmations across many Lots.

| Method & Path | Auth | Purpose |
|---|---|---|
| `POST /api/lots` | Admin only | Create a Lot from a period + business type |
| `GET /api/lots`, `GET /api/lots/:lotId` | Admin or Finance | List / read |
| `GET /api/lots/:lotId/population` | Admin or Finance | This Lot's population only |
| `POST /api/lots/:lotId/ledger/upload` | Admin only | Populate a Lot from an uploaded ledger |
| `POST /api/lots/:lotId/tokens/generate` | Admin only | Balance-filtered / targeted-select confirmation links |
| `POST /api/lots/:lotId/confirmations/submit` | Public (token+PAN gated) | Customer/vendor portal submission (reopenable, versioned) |
| `GET /api/lots/:lotId/confirmations` | Admin or Finance | Full Lot roster + confirmation status |
| `GET /api/lots/:lotId/confirmations/:customerId` | Admin or Finance | One confirmation |
| `GET /api/lots/:lotId/confirmations/:customerId/versions` | Admin or Finance | Full amendment history |
| `GET /api/lots/:lotId/confirmations/:customerId/versions/:version/soa` | Admin or Finance | Download one version's original file |
| `POST /api/lots/:lotId/confirmations/:customerId/route-to-finance` | Admin only | Workflow: → FINANCE_REVIEW |
| `POST /api/lots/:lotId/confirmations/:customerId/route-to-admin` | Finance only | Workflow: → ADMIN_REVIEW |
| `POST /api/lots/:lotId/confirmations/:customerId/route-to-customer` | Finance only | Workflow: → CUSTOMER_CLARIFICATION, emails the customer |
| `GET /api/lots/:lotId/confirmations/:customerId/history` | Admin or Finance | Full chronological workflow/audit history |
| `GET /api/lots/:lotId/confirmations/export.xlsx` | Admin or Finance | Single-Lot Excel export (new, phase 7) |
| `GET /api/vendors`, `GET /api/vendors/:vendorId` | Admin | Vendor master reads |
| `POST /api/vendors/import-json` | Admin | Vendor master import (dry-run supported) |

Legacy endpoints (`/api/customers`, `/api/confirmations`, `/api/reconciliation`,
`/api/tokens`, `/api/audit`, `/api/dashboard`) are unchanged, with one
exception: `GET /api/reconciliation/:customerId` now also returns
`soa_confidence` and `soa_warning` for PDF-sourced SOAs (see §6).

`/api/auth/login` and `/api/auth/me` now include `role` and `business_type`
in their response, and JWTs carry both claims.

---

## 4. UI Changes

- **New "Lots" nav tab** (`LotOverview.jsx`, phase 3) sits alongside the
  existing Overview/Dashboard — Lot list → expand → customer/vendor table →
  drill into version history. Nothing about the existing Overview screen
  changed.
- **This phase's additions to `LotOverview.jsx`:**
  - An **Export Excel** button in the Lot-detail toolbar
    (`api.lotConfirmationsExportUrl`).
  - A **Workflow** status badge per customer row (Admin Review / Finance
    Review / Awaiting Customer / Completed).
  - A **Finance Workflow modal** (new `WorkflowModal` component) — a comment
    box, role-appropriate routing buttons (Admin sees "Route to Finance";
    Finance sees "Route back to Admin" / "Route to Customer"), and the full
    chronological history pulled from `GET .../history`.
- **`AuditLogView.jsx`** label map extended with the new workflow, vendor
  import, and export actions so the existing Audit Log screen already
  reads them correctly.
- The Create-Lot modal's `business_type` selector (built in phase 3) is
  unchanged and is what drives every Vendor-vs-Customer branch end-to-end.

No dedicated Vendor master-list/import screen was built this phase — the
Vendor master is currently managed via `POST /api/vendors/import-json`
directly (same pattern the Customer master used before its own screen
existed). Flagged under Known Issues.

---

## 5. Workflow — final Admin ⇄ Finance ⇄ Customer flow

```
Customer submits/amends
        │
        ▼
  ADMIN_REVIEW  ──route-to-finance──▶  FINANCE_REVIEW
        ▲                                   │
        │                    ┌──route-to-admin
        │                    │
        │                    └──route-to-customer──▶ CUSTOMER_CLARIFICATION
        │                                                   │
        └───────────────── customer re-submits ─────────────┘
```

- Every fresh submission/amendment resets `workflow_status` to
  `ADMIN_REVIEW` unconditionally — Finance never has to "catch" a
  resubmission manually.
- Every routing action is written to the existing, immutable `AuditLog`
  collection (`ROUTED_TO_FINANCE`, `FINANCE_REVIEWED` + `ROUTED_TO_ADMIN` /
  `ROUTED_TO_CUSTOMER`, plus `EMAIL_SENT` when the customer is notified) —
  deliberately reusing `AuditLog` rather than introducing a duplicate
  "WorkflowHistory" model, per the spec's own instruction to avoid
  unnecessary duplicate models.
- `GET .../history` merges the customer-keyed and Lot-keyed audit events for
  one `{lot_id, customer_id}` pair and returns them in chronological order;
  a routing action in one Lot never leaks into another Lot's history for the
  same customer (tested).
- The legacy (non-Lot) confirmation flow does not route through Finance at
  all — `workflow_status` is meaningless there and is simply never set.

---

## 6. Security

- **Role-based access control:** the pre-existing generic `requireAdmin`
  middleware allowed *any* authenticated role — including the newly added
  `FINANCE` role — onto every Lot-management endpoint, including Lot
  creation and arbitrary token generation. This was found and fixed this
  phase: `requireAdminOnly` / `requireAdminOrFinance` / `requireFinance` now
  gate every route by least privilege (write/mutate operations that the
  spec reserves for Admin are Admin-only; reads are shared; workflow
  routing is split by direction). Tested directly (`financeAndVendor.test.js`).
- **Cross-Lot / cross-customer / cross-vendor isolation:** covered across
  `lots.test.js`, `lotConfirmations.test.js`, `financeAndVendor.test.js`,
  `lotExport.test.js`, and `tokens_pan.test.js` — a customer's data, a
  Lot's population, a Lot's workflow history, and a Lot's Excel export are
  all proven to never leak into a sibling Lot or a different customer/vendor.
- **Token security (unchanged from phase 2, reconfirmed this phase):**
  HMAC-signed, tamper-evident tokens carrying `lot_id` + `business_type` in
  the signed payload; tampering, malformed tokens, and expiry are all
  rejected without crashing; PAN verification is server-side rate-limited;
  a used/revoked token cannot be PAN-verified even with the correct PAN.
- **PDF security hardening** (defense-in-depth, `utils/fileSecurity.js`):
  magic-byte verification (`%PDF-` in the first 1KB), an active-content
  denylist scan (`/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile`,
  `/OpenAction`, `/AA`), a 20MB size cap, and a hard 15-second extraction
  timeout to bound worst-case CPU on an adversarial file. Path traversal
  does not apply — every upload route uses multer's `memoryStorage()`, so
  nothing is ever written to disk under a user-controlled filename.
- **Email HTML injection:** `customer_name` (admin-imported master data) and
  free-text notes/comments are HTML-escaped before interpolation into
  outgoing email bodies (defense-in-depth; these were never
  customer-controlled, but an imported master from an external source or a
  careless paste could otherwise deface an email or inject a misleading
  link).

---

## 7. PDF Extraction Pipeline

`utils/pdfParser.js`:

1. `validatePdfBuffer()` — magic bytes, size cap, active-content denylist.
   Any failure short-circuits to `format_detected: 'PDF_REJECTED'` with a
   human-readable `warning`, and the original file is still preserved.
2. Text extraction via `pdf-parse@2.4.5`'s `PDFParse` class (modern
   `pdfjs-dist` under the hood — the older `pdf-parse@1.x` could not read
   files produced by common PDF-generation libraries; see the version note
   below).
3. A line-based heuristic looks for a document-number-shaped token + a
   date-shaped token + a trailing decimal-amount token per line.
4. **Confidence = % of non-empty lines that matched.** Below 40% confidence,
   or zero matched items, the pipeline returns an **empty item list** plus
   an explicit warning (`format_detected: 'PDF_LOW_CONFIDENCE'`) — it never
   fabricates reconciliation line items from a low-confidence read. The
   `GET /api/reconciliation/:customerId` response surfaces both
   `soa_confidence` and `soa_warning` so an admin sees exactly why a PDF
   produced no auto-matched lines.
5. A hard 15-second timeout wraps extraction so a malformed/adversarial PDF
   cannot hang the request.

Tested in `tests/unit/pdfParser.test.js` (8 tests, using `pdf-lib`-built real
test PDFs): rejects non-PDF and JS-marker files before parsing; extracts
amounts with high confidence from a tabular-looking PDF; never fabricates
items from a prose-only PDF.

---

## 8. Testing

### Backend (Jest) — fully executed
**124 / 124 tests passing, 15 suites, zero regressions**, run against the
in-memory `FakeModel` harness (this sandbox has no reachable MongoDB — see
§9). Breakdown relevant to this phase:

| Suite | Tests | Covers |
|---|---|---|
| `tests/unit/pdfParser.test.js` | 8 | PDF security + extraction + confidence gating |
| `tests/security/financeAndVendor.test.js` | 12 | Vendor isolation, Finance permission boundaries, full workflow round-trip, cross-Lot history isolation |
| `tests/security/lotExport.test.js` | 6 | Lot-scoped export, column completeness, Vendor-Lot headers, Finance read access, 404/401 |
| *(all prior-phase suites)* | 98 | Lot core, tokens, confirmations, PAN gating, headers/error handling, migration logic, etc. |

### Frontend build — executed
`react-scripts build` compiles cleanly with the new `WorkflowModal`, export
button, and workflow badge added to `LotOverview.jsx`.

### Cypress E2E — **authored, not executed**
Five spec files under `frontend/cypress/e2e/` cover: Lot creation and
lot-scoped population, cross-Lot isolation, balance filter + targeted send,
the full customer-portal reopen/amend flow, the full
Admin→Finance→Admin→Customer→Admin workflow, and the same workflow repeated
for a VENDOR Lot. **These could not be run in this sandbox** — there is no
live deployed frontend+backend+MongoDB+SMTP environment or browser available
here, and Cypress itself is not installed (no network access to its
binary). `cypress.config.js` and each spec file document this explicitly.
Fixture ledger files referenced by the specs are not yet generated; see
`cypress/fixtures/README.md` for the exact script to produce them once a
real environment is available.

---

## 9. Known Issues

1. **Phase 8 (legacy-data migration) has not been run against a real
   database.** The script (`scripts/migrate-legacy-lots.js`) is logic-tested
   only. This sandbox cannot reach a real MongoDB instance. Run it in a
   staging environment first (see §10) before touching production data.
2. **Cypress specs are unexecuted**, as above — treat them as a starting
   point to validate, not as proof the UI flows work end-to-end.
3. **No dedicated Vendor master screen** — Vendor import is currently
   JSON-only via `POST /api/vendors/import-json`, mirroring how Customer
   import worked before it got its own screen.
4. `pdf-parse@2.4.5`'s Node worker-fallback path uses a dynamic `import()`
   that Jest's default CJS environment cannot execute without
   `--experimental-vm-modules` — this is now baked into the `test` /
   `test:coverage` npm scripts via `cross-env`. **This is a test-tooling
   concern only**; the real Express server runs under plain `node`, not
   Jest, and is unaffected (verified directly).
5. The PDF confidence heuristic is line-regex-based, not a true tabular/PDF
   layout parser — it is intentionally conservative (fails toward "no data"
   rather than "wrong data"), but a real-world SOA with an unusual layout
   may need format-specific tuning after seeing production PDFs.
6. `workflow_status: 'COMPLETED'` is defined in the schema but nothing sets
   it yet — currently the workflow's terminal state in practice is simply
   "no further routing action taken," which is sufficient for the spec's
   requirements but is an obvious next increment if a formal "close out"
   step is wanted.

---

## 10. Production Readiness

Before going live:

1. **Run the legacy migration against a staging copy of the real database
   first**, then production:
   ```
   node backend/src/scripts/migrate-legacy-lots.js
   ```
   Review its console output — it is designed to be idempotent per
   `cycle_id` (skips a `cycle_id` that already has an `is_legacy: true` Lot),
   but a staging dry run is still strongly recommended given it touches
   every historical Confirmation/TokenRecord/EmailLog/LedgerEntry.
2. **Install and run the Cypress suite** against a real deployed
   environment (`npm i -D cypress`, generate the fixture files per
   `cypress/fixtures/README.md`, then `npx cypress run`) before relying on
   it as a regression gate.
3. **Seed at least one Finance-role Admin account** — the schema/route
   support exists, but no seed script currently creates one by default.
4. Confirm SMTP is configured in the target environment — `route-to-customer`
   depends on it exactly the same way the existing confirmation-request
   email does (`utils/mailer.js`'s `isConfigured()` check governs both).
5. Re-run `npm test` in the target Node version/OS to confirm the
   `cross-env`/`--experimental-vm-modules` test-tooling fix still applies
   cleanly (Windows was the confirmed target per this engagement's earlier
   phases).

---

*Generated as the final deliverable for the BalanceSync Lot architecture
overhaul. All test counts and pass/fail results in this report reflect
actual `npm test` / `react-scripts build` runs in this session, not
estimates.*
