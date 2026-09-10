/**
 * API Service Layer — all HTTP calls go through here.
 * Adds JWT auth header automatically for admin calls.
 */
const BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001';

function getToken() { return localStorage.getItem('bsync_token'); }
function setToken(t) { t ? localStorage.setItem('bsync_token', t) : localStorage.removeItem('bsync_token'); }

async function request(method, path, body, isFormData = false) {
  const token = getToken();
  const headers = isFormData ? {} : { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const opts = { method, headers, body: body ? (isFormData ? body : JSON.stringify(body)) : undefined };
  const res  = await fetch(`${BASE_URL}${path}`, opts);
  const data = await res.json().catch(() => ({ error: 'Invalid response' }));

  if (res.status === 401 && token) {
    setToken(null); // session expired — force re-login on next render
  }
  if (!res.ok) {
    const err = new Error(data.error || data.reason || `Request failed: ${res.status}`);
    err.data = data; // full response body (e.g. { reason, customer_id }) for callers that need more than the message
    throw err;
  }
  return data;
}

async function requestBlob(method, path) {
  const token = getToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${BASE_URL}${path}`, { method, headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return res.blob();
}

const api = {
  // Auth
  login:            (email, password) => request('POST', '/api/auth/login', { email, password }),
  me:               ()      => request('GET',  '/api/auth/me'),
  logout:           ()      => setToken(null),
  setToken,
  isLoggedIn:       ()      => !!getToken(),

  // System / dashboard
  health:           ()      => request('GET',  '/api/system/health'),
  config:           ()      => request('GET',  '/api/system/config'),
  dashboard:        ()      => request('GET',  '/api/dashboard'),

  // Customers
  customers:        ()      => request('GET',  '/api/customers'),
  customer:         (id)    => request('GET',  `/api/customers/${id}`),
  customerLedger:   (id)    => request('GET',  `/api/customers/${id}/ledger`),
  customersExportUrl: ()    => `${BASE_URL}/api/customers/export.xlsx?token=${getToken() || ''}`,
  importCustomersJson: (customers, opts = {}) => request('POST', '/api/customers/import-json', { customers, mode: opts.mode, dryRun: !!opts.dryRun }),
  // Customer master file upload (Sept 2026: "Where is the provision to
  // upload customer master?") — Excel/CSV or JSON, same fd pattern as
  // uploadLedger below.
  importCustomerMasterFile: (fd) => request('POST', '/api/customers/import', fd, true),

  // Vendors
  vendors:            ()    => request('GET', '/api/vendors'),
  vendor:              (id) => request('GET', `/api/vendors/${id}`),
  importVendorMasterFile: (fd) => request('POST', '/api/vendors/import', fd, true),

  // Tokens (admin)
  generateTokens:   (opts)  => request('POST', '/api/tokens/generate', opts || {}),
  tokenExpiry:      (id, expiry_date) => request('PATCH', `/api/tokens/${id}/expiry`, { expiry_date }),
  resetToken:       (id)    => request('POST', `/api/tokens/reset/${id}`),
  resetExpiredTokens: ()    => request('POST', '/api/tokens/reset-expired'),
  tokens:           ()      => request('GET',  '/api/tokens'),

  // Tokens (customer portal — public, two-factor)
  validateToken:    (tok)        => request('POST', '/api/tokens/validate', { token: tok }),
  verifyPan:        (tok, pan)   => request('POST', '/api/tokens/verify-pan', { token: tok, pan }),
  sapLedgerUrl:     (tok, pan)   => `${BASE_URL}/api/tokens/${encodeURIComponent(tok)}/sap-ledger.xlsx?pan=${encodeURIComponent(pan || '')}`,

  // Emails
  triggerEmails:       ()   => request('POST', '/api/emails/trigger'),
  remindPending:       ()   => request('POST', '/api/emails/remind-pending'),
  triggerEmailsSingle: (id) => request('POST', `/api/emails/trigger/${id}`),
  emailLog:            ()   => request('GET',  '/api/emails/log'),
  emailPreview:         (id) => request('GET', `/api/emails/preview/${id}`),
  outlookScriptUrl:     ()   => `${BASE_URL}/api/emails/outlook-script?token=${getToken() || ''}`,

  // Confirmations
  submitConfirmation: (fd)   => request('POST', '/api/confirmations/submit', fd, true),
  confirmations:      ()     => request('GET',  '/api/confirmations'),
  confirmation:       (id)   => request('GET',  `/api/confirmations/${id}`),
  updateRecon:        (id, b) => request('PATCH', `/api/confirmations/${id}/recon`, b),
  soaDownloadUrl:      (id)  => `${BASE_URL}/api/confirmations/${id}/soa?token=${getToken() || ''}`,
  confirmationsExportUrl: () => `${BASE_URL}/api/confirmations/export.xlsx?token=${getToken() || ''}`,
  requestReupload:    (id, reason, tokenId) => request('POST', `/api/confirmations/${id}/request-reupload`, { reason, token_id: tokenId }),
  approveReupload:    (id)  => request('POST', `/api/confirmations/${id}/approve-reupload`),
  soaHistory:         (id)  => request('GET', `/api/confirmations/${id}/soa-history`),
  soaHistoryDownloadUrl: (id, version) => `${BASE_URL}/api/confirmations/${id}/soa-history/${version}?token=${getToken() || ''}`,

  // Ledger
  uploadLedger:     (fd)    => request('POST', '/api/ledger/upload', fd, true),
  confirmImport:    (body)  => request('POST', '/api/ledger/confirm-import', body),
  ledger:           ()      => request('GET',  '/api/ledger'),
  ledgerHistory:    ()      => request('GET',  '/api/ledger/history'),
  ledgerExportUrl:  ()      => `${BASE_URL}/api/ledger/export.xlsx?token=${getToken() || ''}`,
  importLedgerJson: (ledgers, opts = {}) => request('POST', '/api/ledger/import-json', { ledgers, mode: opts.mode, dryRun: !!opts.dryRun }),

  // Reconciliation
  reconcile:            (id) => request('GET', `/api/reconciliation/${id}`),
  reconExportUrl:        (id) => `${BASE_URL}/api/reconciliation/${id}/export.xlsx?token=${getToken() || ''}`,
  reconExportBlob:       (id) => requestBlob('GET', `/api/reconciliation/${id}/export.xlsx`),
  sendReconToCustomer:  (id) => request('POST', `/api/reconciliation/${id}/send-to-customer`),

  // Audit
  auditLog: (params = {}) => request('GET', `/api/audit?${new URLSearchParams(params).toString()}`),
  auditExportUrl: (params = {}) => `${BASE_URL}/api/audit/export.xlsx?${new URLSearchParams(params).toString()}&token=${getToken() || ''}`,

  // Lots (architecture overhaul phase 1 — see BalanceSync_Lot_Architecture_Plan.md).
  // No screen consumes these yet; added so the service layer is ready for
  // the Overview rebuild (phase 3).
  createLot:       (period, businessType, remarks) => request('POST', '/api/lots', { period, business_type: businessType, remarks }),
  updateLotRemarks: (id, remarks) => request('PATCH', `/api/lots/${id}`, { remarks }),
  deleteLot:       (id) => request('DELETE', `/api/lots/${id}`),
  lots:            ()   => request('GET', '/api/lots'),
  lot:             (id) => request('GET', `/api/lots/${id}`),
  lotsSummary:     (params = {}) => request('GET', `/api/lots/summary?${new URLSearchParams(params).toString()}`),
  lotPopulation:   (id) => request('GET', `/api/lots/${id}/population`),
  uploadLotLedger: (id, fd) => request('POST', `/api/lots/${id}/ledger/upload`, fd, true),

  // Lot-scoped bulk actions (item 4 — every bulk send/reset/remind is
  // scoped to one Lot, never global).
  resetLotExpiredTokens: (id) => request('POST', `/api/lots/${id}/tokens/reset-expired`),
  remindLotPending:      (id) => request('POST', `/api/lots/${id}/emails/remind-pending`),
  lotOutlookScriptUrl:   (id) => `${BASE_URL}/api/lots/${id}/emails/outlook-script?token=${getToken() || ''}`,

  // Lot-scoped confirmations/tokens (phase 2 — see BalanceSync_Lot_Architecture_Plan.md).
  // Balance-filtered + targeted-select token generation, and the reopenable/
  // versioned customer-portal submit flow. No screen consumes these yet
  // (the Overview rebuild that will is phase 3) — the legacy, non-Lot
  // tokens/generate + confirmations/submit methods above are unchanged and
  // still power the current customer portal.
  generateLotTokens:  (lotId, opts = {}) => request('POST', `/api/lots/${lotId}/tokens/generate`, opts),
  submitLotConfirmation: (lotId, fd)     => request('POST', `/api/lots/${lotId}/confirmations/submit`, fd, true),
  lotConfirmations:      (lotId)         => request('GET', `/api/lots/${lotId}/confirmations`),
  lotConfirmation:       (lotId, custId) => request('GET', `/api/lots/${lotId}/confirmations/${custId}`),
  lotConfirmationVersions: (lotId, custId) => request('GET', `/api/lots/${lotId}/confirmations/${custId}/versions`),
  lotConfirmationVersionSoaUrl: (lotId, custId, version) => `${BASE_URL}/api/lots/${lotId}/confirmations/${custId}/versions/${version}/soa?token=${getToken() || ''}`,
  lotConfirmationsExportUrl: (lotId) => `${BASE_URL}/api/lots/${lotId}/confirmations/export.xlsx?token=${getToken() || ''}`,

  // Phase 5: Finance clarification workflow (Admin<->Finance<->Customer
  // routing) — see routes/lots.js's route-to-finance/admin/customer +
  // history endpoints, and models/Confirmation.js's workflow_status.
  routeToFinance:  (lotId, custId, comment) => request('POST', `/api/lots/${lotId}/confirmations/${custId}/route-to-finance`, { comment }),
  routeToAdmin:    (lotId, custId, comment) => request('POST', `/api/lots/${lotId}/confirmations/${custId}/route-to-admin`, { comment }),
  routeToCustomer: (lotId, custId, comment) => request('POST', `/api/lots/${lotId}/confirmations/${custId}/route-to-customer`, { comment }),
  confirmationHistory: (lotId, custId) => request('GET', `/api/lots/${lotId}/confirmations/${custId}/history`),

  // Reconciliation Studio, Lot-scoped (Sept 2026: "Reconciliation Studio -
  // migrate as per lot"). Mirrors the legacy reconcile()/reconExportUrl()/
  // sendReconToCustomer() methods above, but scoped to {lot_id, customer_id}
  // — reads/writes routes/lots.js's Lot-scoped reconciliation endpoints, so
  // ledgers/SOAs uploaded through Overview are the ones the studio reflects.
  lotReconcile:          (lotId, custId)      => request('GET', `/api/lots/${lotId}/reconciliation/${custId}`),
  updateLotRecon:        (lotId, custId, b)   => request('PATCH', `/api/lots/${lotId}/reconciliation/${custId}`, b),
  lotReconExportUrl:     (lotId, custId)      => `${BASE_URL}/api/lots/${lotId}/reconciliation/${custId}/export.xlsx?token=${getToken() || ''}`,
  lotReconExportBlob:    (lotId, custId)      => requestBlob('GET', `/api/lots/${lotId}/reconciliation/${custId}/export.xlsx`),
  sendLotReconToCustomer: (lotId, custId)     => request('POST', `/api/lots/${lotId}/reconciliation/${custId}/send-to-customer`),

  BASE_URL,
};

export default api;
