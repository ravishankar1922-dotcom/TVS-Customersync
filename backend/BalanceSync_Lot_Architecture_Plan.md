# BalanceSync — Lot Architecture: Inspection & Design Plan

This is Phase 1 (inspect) + Phase 2 (design) of the requested overhaul, per your own sequencing. It is a plan for you to review and prioritize — no schema or route code has been changed yet. Given the real size of this (new data model, two new collections of workflow logic, two new roles, a new module, a PDF pipeline, and a full Cypress+security suite), I'm not going to pretend I can safely land all 46 sections as one atomic, unreviewed change. This document ends with the specific decisions I need from you before I start writing code.

---

## 1. What the current system actually is (inspected, not assumed)

**There is currently exactly one "cycle" system-wide.** `cfg.CYCLE_ID` is a single value read from an environment variable (`config.js`) — not a document, not something a user creates. Every route that filters by cycle does `{ cycle_id: cfg.CYCLE_ID }` against that one constant. There is no concept of "create a new exercise" today — changing the cycle means an admin edits an env var and redeploys.

**Data model today** (9 collections): `Customer` (global master, no lot/business-type concept), `LedgerEntry` (one document per `customer_id`, no cycle scoping at all — a fresh ledger upload today **overwrites** the previous one via `findOneAndUpdate(upsert)`), `TokenRecord` (`token_id, customer_id, cycle_id, status: ACTIVE|USED|REVOKED|EXPIRED`), `Confirmation` (`customer_id+cycle_id` compound-unique — one row per customer per cycle, `soa_data` as a single Buffer plus a `soa_history[]` subdocument array that's a *partial* start on versioning, `reupload_status` enum for the existing admin-approved-reupload flow), `EmailLog`, `AuditLog` (global, not lot-scoped), `ImportHistory`, `LedgerImportStaging`, `Admin` (has an unused `role` enum already: `ADMIN | AR_TEAM | VIEWER`).

**Auth today:** one `Admin` collection, JWT-based, single role tier in practice (the `role` field exists on the schema but nothing branches on it). No Vendor concept anywhere — `Customer` has no `business_type` field.

**PDF handling — important, previously undiscovered gap:** `confirmations.js` accepts `.pdf` as an allowed SOA upload extension and stores the bytes, but `reconciliation.js`'s `parseSOA()` calls `XLSX.read(buffer)` unconditionally — SheetJS **cannot parse PDF content**. Today, a customer-uploaded PDF SOA is stored but effectively **not reconciled** — the parse either throws or silently produces nothing useful. Section 26/27 of your spec is not "improve" PDF processing, it's "build it for the first time."

**Cypress:** there is no Cypress installation, config, or test file anywhere in the repo. Section 6/40 asks me to inspect existing Cypress tests — there are none to inspect. (Prior to this task I built a Jest+Supertest suite instead, documented in the QA report I sent you.) A real Cypress run also needs a live backend+frontend+database, which this sandbox doesn't have (same constraint as the QA report — no outbound network to install a real MongoDB).

**Frontend:** single-page admin shell (`App.jsx`) with 5 flat nav items (Overview/Reconciliation/Ledger/Audit/Health) and one customer portal route (`/portal?t=<token>`), no concept of "select a Lot first."

---

## 2. Proposed data model

I'm keeping this additive and reusing what's already correct rather than reinventing it, per your instruction not to create duplicate/conflicting models.

**New collections:**

- **`Lot`** — `lot_id` (internal), `lot_number` (human-facing, e.g. `LOT-2026-03-001`), `period` (`{year, month}` or a normalized string, dynamically drives all UI text), `business_type` (`CUSTOMER | VENDOR`), `status` (`DRAFT | ACTIVE | CLOSED`), `created_by`, `created_at`, `ledger_upload_date`, `population_count`, `total_ledger_balance` (denormalized, recomputed on ledger upload). This replaces `cfg.CYCLE_ID` as the thing every other collection scopes to — `cycle_id` fields across the codebase become `lot_id` references (I'd keep the field name `cycle_id` internally where it's already indexed, to minimize churn — open question for you, see §5).
- **`LotPopulation`** — one row per `(lot_id, entity_id)`, created from what's actually present in the uploaded ledger for that Lot (never from the full `Customer`/`Vendor` master). This is the join that makes "only 500 of 10,000 customers are active in this Lot" real.
- **`SubmissionVersion`** — replaces the ad-hoc `soa_history[]` subdocument array on `Confirmation` with a first-class collection: `(lot_id, entity_id, version_no, balance, soa_file_ref, submitted_at, actor, actor_role, comment, status)`. `Confirmation` keeps a `current_version` pointer instead of embedding growing history in one document (Mongo has a 16MB document cap — an actively-amended customer with many SOA re-uploads embedded forever is a real risk with the current `soa_history[]` approach at scale).
- **`WorkflowHistory`** — the chronological, append-only event feed section 23 describes (`lot_id, entity_id, timestamp, actor, actor_role, action, status_before, status_after, comment, related_version`). `AuditLog` already does something similar globally; I'd keep `AuditLog` as the system-wide security/ops audit trail (login events, exports, admin actions on any entity) and add `WorkflowHistory` as the lot+entity-scoped business narrative the Overview's "expand customer → history" UI reads from. Every `WorkflowHistory` write also mirrors into `AuditLog` so nothing is duplicated in *purpose*, just in *shape* (one is a flat security log, the other is a per-case timeline).
- **`Vendor`** — see the business-type decision in §4.
- **`User`** — replaces `Admin` (or extends it) with `{ email, password_hash, role: ADMIN|FINANCE, business_type: CUSTOMER|VENDOR|BOTH }`, per your own conceptual model in section 14.

**Modified collections:**

- `Customer` / `Vendor` (master data) — unchanged in spirit, stays global, is no longer what drives who's "in" a Lot.
- `LedgerEntry` — must become `(lot_id, entity_id)`-scoped instead of `(customer_id)`-unique-globally, so uploading a new period's ledger creates new rows instead of overwriting.
- `TokenRecord` — payload gains `business_type` + `lot_id`; `status` enum loses its `USED` blocking-behavior (§10) — token stays `ACTIVE` until expiry/revocation, and "has this token completed a submission" becomes a question you answer by checking `SubmissionVersion`, not by checking token status.
- `Confirmation` — unique index becomes `(lot_id, entity_id)` instead of `(customer_id, cycle_id)`; gains `workflow_status` (`OPEN | ADMIN_REVIEW | FINANCE_REVIEW | CUSTOMER_CLARIFICATION | RECONCILED | CLOSED`) as the state machine field for sections 16–22.
- `EmailLog` — gains `lot_id`.

**Indexes** (additive, matching the "avoid unnecessary indexes" instruction): `Lot.lot_number` (unique), `Lot.{period, business_type}`, `LotPopulation.{lot_id, entity_id}` (unique), `Confirmation.{lot_id, entity_id}` (unique, replaces the current `{customer_id,cycle_id}` one), `SubmissionVersion.{lot_id, entity_id, version_no}`, `TokenRecord.{lot_id, entity_id}`, `WorkflowHistory.{lot_id, entity_id, timestamp}`, `EmailLog.{lot_id, entity_id}`.

---

## 3. Conflicts I need to flag before touching anything (per your "stop and explain" instruction)

**(a) Removing single-use tokens reverses a security fix I made for you last session.** In the QA/security pass, I fixed a real IDOR + race condition where a token could be used to double-submit or submit as the wrong customer, by making the submit endpoint atomically flip `TokenRecord.status` from `ACTIVE→USED` (`findOneAndUpdate` guarded by `status:'ACTIVE'`) so two near-simultaneous submissions couldn't both land. Section 10 explicitly wants the opposite — the same link must stay usable for repeat amendment. That's a legitimate, deliberate product decision, but it means the concurrency-safety story has to move somewhere else: I'd replace "token status as the lock" with **optimistic concurrency on `SubmissionVersion.version_no`** (each submit says "I'm creating version N+1 based on version N"; a `findOneAndUpdate` guarded by the expected current version rejects a stale concurrent write with a 409, same pattern, different field). This preserves the anti-double-submit guarantee from section 42 without blocking legitimate reopens. I want you to confirm this is the right trade before I rip out the existing lock.

**(b) Existing data has no Lot.** Every `Confirmation`/`TokenRecord`/`EmailLog`/`LedgerEntry` row in the current database implicitly belongs to whatever `cfg.CYCLE_ID` was set to when it was created (e.g. today's config value). Per section 39 I will **not** delete or silently reassign this — the safe migration is: create one `Lot` document per distinct existing `cycle_id` value found in the data (a "legacy Lot," clearly labeled, `lot_number` derived from that cycle_id string), backfill `lot_id` onto every existing row that references that `cycle_id`, and leave `LotPopulation` for those legacy Lots computed from whichever customers actually have a `Confirmation`/`TokenRecord` in that cycle (since there's no original ledger-upload event to replay). This is inference, not fabrication, and I'll say exactly that in the migration output — flagging it for you rather than presenting it as equivalent to a real Lot.

**(c) `cycle_id` naming.** A lot of existing, working, indexed code (routes, the Jest suite I built, the frontend) refers to `cycle_id`. I can either (i) rename the concept to `lot_id` everywhere for clarity, which touches every file that currently says `cycle_id`, or (ii) keep the field named `cycle_id` internally but have it reference `Lot._id`/`lot_number` instead of an env constant, minimizing the diff. I'd default to (ii) for a smaller, safer change set, but say so explicitly since you may prefer the codebase to read `lot_id` throughout for clarity going forward. Your call in §5.

**(d) Vendor: shared collection vs. separate collection.** Section 13 says "logically separated," section 14 says "prefer role + business-type authorization, don't duplicate auth code." Those two pull in slightly different directions. My recommendation: **one `Party` collection with a `business_type: CUSTOMER|VENDOR` discriminator**, shared `Lot`/`Confirmation`/`SubmissionVersion`/`WorkflowHistory` schemas keyed by `business_type` alongside `lot_id`, and the *UI/routes* enforce that a Customer-context request can never touch a `business_type:'VENDOR'` row (query-level filter, not app-level trust). This avoids duplicating six collections' worth of schema and CRUD logic, while still making cross-business access structurally impossible to forget to check (it's baked into every query's filter, not something each route author has to remember). The alternative — fully separate `Customer`/`Vendor` collections — is more "logically separated" in a literal sense but means every route, model, and test gets written twice. I'd rather build it once, correctly, and prove isolation with the security tests in section 32/41 than duplicate code and risk the two copies drifting apart. Flagging this because it's a real architectural fork, not a detail.

**(e) PDF extraction is new work, not a fix.** As found in §1, there is no working PDF→transaction pipeline today. Building one that handles "realistic variation in PDF layouts" (section 26) properly is itself a multi-day effort (table-structure detection, OCR fallback for scanned PDFs, confidence scoring, the "preserve original + warn on low confidence" requirement in section 26's last bullet). I'd treat this as its own phase with its own review checkpoint rather than something that rides along with the Lot migration.

**(f) Scale of Cypress/E2E in this sandbox.** Same constraint as the QA report: this sandbox has no live MongoDB and no deployed environment, so a genuine Cypress run against a real backend isn't possible here. I can build the real Cypress test files (so they run correctly in your actual dev environment) and continue exercising the logic through the Jest/Supertest harness I already built (extending it to cover Lots), but I want to set that expectation now rather than claim a Cypress run happened when it didn't.

---

## 4. Phased plan (your own sequencing, with scope notes)

Given the size, I'd execute this as a series of reviewed increments rather than one mega-change — each phase leaves the app in a working, tested state before the next starts:

1. **Lot core** (§3a spec: `Lot` model + creation flow + numbering + Lot-scoped `LedgerEntry`/`LotPopulation`) — this alone is a substantial, self-contained change and the foundation everything else sits on.
2. **Confirmation/Token rework** — dynamic period, remove single-use blocking, optimistic-concurrency versioning (`SubmissionVersion`), balance-filtered targeted sends.
3. **Overview UX rebuild** around Lot → expand → customer → history, balance filters, Lot filter enforced at the query layer.
4. **Vendor module + Finance role** — `Party.business_type`, `User.role/businessType`, second login context.
5. **Finance clarification workflow** — the state machine (§16–22), `WorkflowHistory`.
6. **PDF extraction pipeline** — its own checkpoint per §3e.
7. **Reporting/exports** made Lot-aware.
8. **Migration script** for existing data (can actually run earlier, right after phase 1, so old data becomes queryable through the new model as soon as it exists).
9. **Cypress suite + security regression suite** (extending, not replacing, the Jest suite already in the repo) — last, once the surface it's testing is stable.

Each phase, I'll run the full existing Jest suite plus the new tests for that phase before moving on, exactly as section 43 requires.

---

## 5. Decisions I need from you before I write code

1. Confirm the concurrency approach in §3a (optimistic version-based locking replacing single-use tokens).
2. Confirm the migration approach in §3b (one inferred "legacy Lot" per existing `cycle_id`, clearly labeled as inferred).
3. `cycle_id` → keep the field name and repoint it at `Lot`, or rename to `lot_id` throughout (§3c)?
4. Vendor as `business_type` discriminator on shared collections, or fully separate collections (§3d)?
5. Which phase do you want me to actually start building right now — all of them in sequence over this and following turns, or a specific subset first (e.g., just Lot core + Overview, before committing to the Vendor/Finance/PDF work)?
