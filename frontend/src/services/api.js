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
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
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

  // Tokens (admin)
  generateTokens:   (opts)  => request('POST', '/api/tokens/generate', opts || {}),
  tokenExpiry:      (id, expiry_date) => request('PATCH', `/api/tokens/${id}/expiry`, { expiry_date }),
  resetToken:       (id)    => request('POST', `/api/tokens/reset/${id}`),
  tokens:           ()      => request('GET',  '/api/tokens'),

  // Tokens (customer portal — public, two-factor)
  validateToken:    (tok)        => request('POST', '/api/tokens/validate', { token: tok }),
  verifyPan:        (tok, pan)   => request('POST', '/api/tokens/verify-pan', { token: tok, pan }),

  // Emails
  triggerEmails:       ()   => request('POST', '/api/emails/trigger'),
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

  // Ledger
  uploadLedger:     (fd)    => request('POST', '/api/ledger/upload', fd, true),
  confirmImport:    (body)  => request('POST', '/api/ledger/confirm-import', body),
  ledger:           ()      => request('GET',  '/api/ledger'),
  ledgerHistory:    ()      => request('GET',  '/api/ledger/history'),

  // Reconciliation
  reconcile:            (id) => request('GET', `/api/reconciliation/${id}`),
  reconExportUrl:        (id) => `${BASE_URL}/api/reconciliation/${id}/export.xlsx?token=${getToken() || ''}`,
  reconExportBlob:       (id) => requestBlob('GET', `/api/reconciliation/${id}/export.xlsx`),
  sendReconToCustomer:  (id) => request('POST', `/api/reconciliation/${id}/send-to-customer`),

  // Audit
  auditLog: (params = {}) => request('GET', `/api/audit?${new URLSearchParams(params).toString()}`),

  BASE_URL,
};

export default api;
