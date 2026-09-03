# BalanceSync — AR Balance Confirmation & Reconciliation Platform

MERN-stack rebuild of the TSL balance confirmation prototype. React frontend,
Express + MongoDB backend, JWT admin auth, SMTP email, PAN-gated customer
portal, audit logging, Excel export, and a two-way reconciliation workflow.

## What changed vs. the original prototype

- **MongoDB instead of flat JSON files** — every collection (customers, ledger,
  tokens, confirmations, email log, audit log) is now a Mongoose model. No more
  race conditions on shared JSON files, and it's ready for a managed database
  (MongoDB Atlas) instead of a folder on one desktop's D: drive.
- **Real admin authentication** — `/api/auth/login` issues a JWT; every admin
  route requires it server-side (the old build only checked the password in
  the browser, so the API itself was wide open).
- **Two-factor customer portal** — the emailed link is factor one; the
  customer must also enter their **PAN** (checked against the customer master)
  before any balance or transaction data is released. See `Customer_PAN_Reference.xlsx`.
- **Configurable token expiry** — set a specific expiry date from the
  Dashboard before triggering emails, or per-token via `PATCH /api/tokens/:id/expiry`.
- **Per-customer "send email" button** — no need to re-trigger the whole batch.
- **Real SMTP email** (Nodemailer) instead of Outlook/VBScript automation —
  works from any server, and fixes the ₹/symbol garbling the old VBScript
  approach caused (see `backend/src/utils/mailer.js` for why).
- **Reconciliation Excel export** and a **"Send to Customer"** action that
  emails the summary + workbook back to the customer and timestamps it.
- **Audit log** — every admin and customer action (logins, token resets,
  ledger imports, PAN checks, reconciliation completion, emails sent) is
  recorded and viewable under Audit Log.
- **Reconciliation workspace improvements** — persisted root-cause tags (no
  longer lost on refresh), a match-rate ring, and doc-number search/filter.
- **TVS Mobility branding** applied across the admin shell, login screen and
  customer portal header.

## Project layout

```
tsl-mern/
  backend/     Express + MongoDB API (see backend/.env.example)
  frontend/    React admin app + customer portal (same UI framework as before)
  Customer_PAN_Reference.xlsx   PAN lookup for the portal's second-factor gate
  DEPLOYMENT_GUIDE.md           How to take this live
```

## Running locally

```bash
# 1) MongoDB — install locally or use a free MongoDB Atlas cluster
#    (mongodb://127.0.0.1:27017 works out of the box if you run `mongod` locally)

# 2) Backend
cd backend
cp .env.example .env      # edit ADMIN_EMAIL / ADMIN_PASSWORD / JWT_SECRET / HMAC_SECRET
npm install
npm run seed               # loads data/customer_master.json + data/TSL_ledger.json
npm start                  # http://localhost:3001

# 3) Frontend (separate terminal)
cd frontend
npm install
npm start                  # http://localhost:3000
```

Log in with the `ADMIN_EMAIL` / `ADMIN_PASSWORD` you set in `.env`.

Without SMTP configured, "Trigger Customer Emails" still generates tokens and
logs the portal links in the Email Log — copy them manually for testing. Set
`SMTP_*` in `.env` to send real email.

## Data note

`backend/data/customer_master.json` already carries a `pan` field per
customer (used for the portal identity check) and `backend/data/TSL_ledger.json`
is the same sample ledger as the original prototype — both are TEST DATA.
Replace them with your real extract before going live, and see
`DEPLOYMENT_GUIDE.md` for production hardening (secrets, file storage, etc).
