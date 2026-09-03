# Going Live — Deployment Guide

This app is now a standard MERN stack, so it deploys like any other: a
managed database, a hosted Node backend, and a static-hosted React build.
Nothing in this stack requires a Windows desktop or Outlook anymore.

## 1. Database — MongoDB Atlas

1. Create a free/shared cluster at https://www.mongodb.com/cloud/atlas (M0 tier
   is enough to start; upgrade as data grows).
2. Create a database user and note the connection string, e.g.
   `mongodb+srv://<user>:<password>@<cluster>.mongodb.net/balancesync`.
3. Under Network Access, allow the IP ranges of wherever you host the backend
   (or `0.0.0.0/0` only if your backend host doesn't have a fixed IP — narrow
   it down once you know your host's egress IPs).
4. Put that URI in `MONGO_URI` in production.

## 2. Backend hosting

Any Node host works (Render, Railway, Fly.io, AWS Elastic Beanstalk, an
Azure/AWS VM, etc). Render or Railway are the fastest path:

1. Push this repo to GitHub.
2. Create a new Web Service pointing at `backend/`, build command `npm install`,
   start command `npm start`.
3. Set environment variables from `.env.example` — at minimum:
   `MONGO_URI`, `JWT_SECRET`, `HMAC_SECRET` (generate both with
   `openssl rand -hex 32`), `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `FRONTEND_URL`
   (the deployed frontend's URL — this becomes the CORS origin and the base
   of every portal link emailed to customers), `SMTP_*`, `CYCLE_ID`,
   `COMPANY`, `AS_OF_DATE`.
4. **File storage**: `UPLOAD_ROOT` writes SOA uploads to local disk by
   default. Most PaaS hosts (Render, Railway, Heroku-style) have an
   *ephemeral* filesystem — uploaded files disappear on redeploy/restart.
   For production, either (a) attach a persistent volume if your host offers
   one, or (b) swap the `multer.diskStorage` calls in
   `backend/src/routes/confirmations.js` and `routes/ledger.js` for
   `multer-s3` (or Azure Blob) so uploads go straight to object storage.
   This is the one piece of the original design that assumed a single
   always-on machine and needs a deliberate decision before go-live.
5. Run the seed script once against production data:
   `MONGO_URI=<prod-uri> npm run seed` (or trigger it as a one-off job on
   your host) after replacing `backend/data/customer_master.json` and
   `TSL_ledger.json` with your real extract.

## 3. Frontend hosting

1. Deploy `frontend/` to Vercel, Netlify, or any static host.
2. Set the build's env var `REACT_APP_API_URL` to your backend's public URL
   (e.g. `https://balancesync-api.onrender.com`).
3. Point your domain (or subdomain) at it, e.g. `confirm.yourcompany.com`.

## 4. Outbound email

Any SMTP provider works with the existing `nodemailer` setup — SendGrid, AWS
SES, Postmark, Mailgun, or your company's Office 365/Google Workspace SMTP
relay. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` in
the backend's environment. For deliverability, set up SPF/DKIM for the
sending domain with your provider — otherwise confirmation emails are likely
to land in spam.

## 5. Domain & HTTPS

Both the frontend and backend hosts above provision HTTPS automatically for
custom domains. Make sure:
- `FRONTEND_URL` in the backend matches the exact frontend origin (used for
  CORS and for building the `/portal?t=...` links emailed to customers).
- The portal is served over HTTPS — customers are entering a PAN, which is
  sensitive personal data in India under the DPDP Act; it must never travel
  over plain HTTP.

## 6. Secrets checklist before go-live

- [ ] `JWT_SECRET` and `HMAC_SECRET` are freshly generated, not the repo defaults
- [ ] `ADMIN_PASSWORD` changed from any default, and additional admin users
      created via a script against the `Admin` model if more than one person
      needs access (there's no self-service admin signup by design)
- [ ] `.env` is never committed — `.gitignore` already excludes it
- [ ] Real `customer_master.json` / ledger data replaces the sample files,
      and the sample `Customer_PAN_Reference.xlsx` is deleted/regenerated
      from real PANs, not the demo ones
- [ ] Rate limiting (already on `/api/auth/login`) reviewed for your expected
      traffic
- [ ] MongoDB Atlas network access locked to your backend's IP range, not `0.0.0.0/0`
- [ ] A backup schedule enabled on the Atlas cluster (point-in-time recovery
      on the M10+ tiers, or scheduled snapshots on shared tiers)

## 7. Suggested next hardening steps (not blocking for a pilot)

- Move file storage to S3/Azure Blob (see step 2.4) before real customer
  documents are uploaded at any volume.
- Add a "forgot password" flow or an admin-invite flow if more than one AR
  team member needs a login — today the seed script provisions exactly one
  admin from `.env`.
- Add structured monitoring (e.g. a hosted logging/APM tool) — `morgan` logs
  to stdout today, which most hosts capture, but nothing alerts you on
  errors yet.
- Consider moving the reconciliation matcher's heavy Excel parsing off the
  request thread (a queue/worker) if SOA files or customer count grow large
  enough to make `/api/reconciliation/:id` slow.
