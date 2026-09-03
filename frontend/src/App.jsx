import React, { useState, useEffect } from 'react';
import { ToastProvider, Topbar, CycleRibbon, useToast, Spinner, BrandLogo } from './components/shared';
import Dashboard      from './components/admin/Dashboard';
import Reconciliation from './components/admin/Reconciliation';
import LedgerUpload   from './components/admin/LedgerUpload';
import AuditLogView   from './components/admin/AuditLogView';
import CustomerPortal from './components/portal/CustomerPortal';
import api from './services/api';
import './index.css';

// ── Main App ───────────────────────────────────────────────────────────────
export default function App() {
  const isPortal = window.location.pathname === '/portal';

  if (isPortal) {
    return (
      <ToastProvider>
        <div style={{ minHeight: '100vh', background: 'var(--slate)' }}>
          <header style={{
            height: 56, background: '#1E1E2E', display: 'flex', alignItems: 'center',
            padding: '0 20px', borderBottom: '2px solid #C8102E',
          }}>
            <div style={{ background: '#fff', borderRadius: 6, padding: '4px 10px', display: 'flex', alignItems: 'center' }}>
              <BrandLogo height={22} />
            </div>
            <div style={{ width: 1, height: 18, background: '#ffffff20', margin: '0 14px' }} />
            <div style={{ color: '#ffffff50', fontSize: 11 }}>Customer Balance Confirmation</div>
            <div style={{ marginLeft: 'auto' }}>
              <span style={{ background: '#C8102E20', border: '1px solid #C8102E50', color: '#FCA5A5', fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 999, letterSpacing: '.06em', textTransform: 'uppercase' }}>TEST DATA</span>
            </div>
          </header>
          <CustomerPortal />
        </div>
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <AdminShell />
    </ToastProvider>
  );
}

// ── Admin Shell ────────────────────────────────────────────────────────────
function AdminShell() {
  const [loggedIn, setLoggedIn]   = useState(() => api.isLoggedIn());
  const [adminEmail, setAdminEmail] = useState(null);
  const [page, setPage]           = useState('dashboard');
  const [reconId, setReconId]     = useState(null);
  const [health, setHealth]       = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const toast = useToast();

  useEffect(() => {
    if (!loggedIn) return;
    api.me().then(m => setAdminEmail(m.email)).catch(() => { setLoggedIn(false); });
    loadHealth();
    loadDashboard();
    const iv = setInterval(loadDashboard, 10000);
    return () => clearInterval(iv);
  }, [loggedIn]);

  async function loadHealth() {
    setHealthLoading(true);
    try {
      const h = await api.health();
      setHealth(h);
      if (!h.ok) toast('Database not fully seeded yet. Run "npm run seed" in backend/.', 'warn', 6000);
    } catch {
      toast('Cannot connect to backend. Is the server running on port 3001?', 'err', 8000);
    } finally {
      setHealthLoading(false);
    }
  }

  async function loadDashboard() {
    try { setDashboard(await api.dashboard()); } catch {}
  }

  function navigate(p, id) { setPage(p); if (id) setReconId(id); }

  function logout() { api.setToken(null); setLoggedIn(false); }

  if (!loggedIn) return <Login onLogin={(email) => { setAdminEmail(email); setLoggedIn(true); }} />;

  const NAV = [
    { id: 'dashboard', ico: '📊', label: 'Dashboard' },
    { id: 'recon',     ico: '🔍', label: 'Reconciliation' },
    { id: 'ledger',    ico: '📋', label: 'Upload Ledger' },
    { id: 'audit',     ico: '🛡️', label: 'Audit Log' },
    { id: 'health',    ico: '🔧', label: 'System Status' },
  ];

  return (
    <div className="app">
      <Topbar onLogout={logout} cycleId={health?.cycle_id || '—'} company={health?.company || 'TSL'} asOfDate={health?.as_of_date || '—'} adminEmail={adminEmail} />
      <CycleRibbon data={dashboard} />
      <div className="layout">
        <nav className="sidebar">
          {NAV.map(n => (
            <button key={n.id} className={`sidebar-link ${page === n.id ? 'active' : ''}`} onClick={() => navigate(n.id)}>
              <span className="sico">{n.ico}</span>{n.label}
            </button>
          ))}
        </nav>
        <main className="main-content">
          {healthLoading && <Spinner full />}
          {!healthLoading && health && !health.checks?.customerMaster?.exists && (
            <div className="info-box ib-red" style={{ marginBottom: 16 }}>
              <strong>⚠️ No Customers Loaded</strong>
              Run <code>npm run seed</code> in the backend folder to load <code>data/customer_master.json</code>.
            </div>
          )}
          {!healthLoading && health && !health.checks?.ledger?.exists && (
            <div className="info-box ib-red" style={{ marginBottom: 16 }}>
              <strong>⚠️ No Ledger Loaded</strong>
              Run <code>npm run seed</code> in the backend folder to load <code>data/TSL_ledger.json</code>.
            </div>
          )}

          {page === 'dashboard' && <Dashboard onNavigate={navigate} />}
          {page === 'recon'     && <Reconciliation customerId={reconId} onBack={() => navigate('dashboard')} />}
          {page === 'ledger'    && <LedgerUpload />}
          {page === 'audit'     && <AuditLogView />}
          {page === 'health'    && <SystemHealth health={health} onRefresh={loadHealth} />}
        </main>
      </div>
    </div>
  );
}

// ── Login (real server-side auth) ──────────────────────────────────────────
function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [pwd, setPwd]     = useState('');
  const [err, setErr]     = useState('');
  const [busy, setBusy]   = useState(false);

  async function attempt(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api.login(email.trim(), pwd);
      api.setToken(r.token);
      onLogin(r.admin.email);
    } catch (e) {
      setErr(e.message || 'Login failed.');
      setPwd('');
    } finally { setBusy(false); }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ display: 'inline-flex', background: '#fff', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 18px', marginBottom: 14 }}>
            <BrandLogo height={30} />
          </div>
          <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 18, fontWeight: 700, marginBottom: 4 }}>BalanceSync — Admin</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Balance Confirmation &amp; Reconciliation Portal</div>
        </div>
        <form onSubmit={attempt}>
          <div className="field">
            <label className="lbl">Admin Email</label>
            <input className="inp" type="email" value={email} onChange={e => { setEmail(e.target.value); setErr(''); }} placeholder="admin@yourcompany.com" autoFocus />
          </div>
          <div className="field">
            <label className="lbl">Password</label>
            <input className={`inp${err ? ' inp-err' : ''}`} type="password" value={pwd}
              onChange={e => { setPwd(e.target.value); setErr(''); }} placeholder="Enter admin password" />
            {err && <div className="err-msg">{err}</div>}
          </div>
          <button type="submit" className="btn btn-primary btn-full btn-lg" disabled={busy}>{busy ? 'Signing in…' : 'Login →'}</button>
        </form>
        <div style={{ marginTop: 16, textAlign: 'center', fontSize: 10, color: 'var(--muted)' }}>
          Set ADMIN_EMAIL / ADMIN_PASSWORD in backend/.env<br/>
          <span style={{ color: '#C8102E', fontWeight: 600 }}>TEST DATA ONLY — NOT FOR PRODUCTION</span>
        </div>
      </div>
    </div>
  );
}

// ── System Health ──────────────────────────────────────────────────────────
function SystemHealth({ health, onRefresh }) {
  return (
    <div>
      <div className="sec-hd">
        <div><div className="sec-title disp">System Status</div><div className="sec-sub">MongoDB connection &amp; collection health</div></div>
        <button className="btn btn-secondary btn-sm" onClick={onRefresh}>↺ Refresh</button>
      </div>
      {health && (
        <div className="card">
          <div className="card-body">
            <div style={{ display: 'grid', gap: 10 }}>
              {Object.entries(health.checks || {}).map(([key, check]) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 16 }}>{check.exists ? '✅' : '❌'}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{key.replace(/([A-Z])/g, ' $1').trim()}</div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: "'JetBrains Mono',monospace" }}>{check.path}</div>
                  </div>
                  {check.count !== undefined && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{check.count} records</span>}
                  <span className={`badge ${check.exists ? 'b-conf' : 'b-diff'}`}>{check.exists ? 'Found' : 'Missing'}</span>
                </div>
              ))}
            </div>
            <div className="info-box ib-blue" style={{ marginTop: 16 }}>
              <strong>Cycle Configuration</strong>
              Cycle ID: {health.cycle_id} · Company: {health.company} · As-of Date: {health.as_of_date} ·
              Customers: {health.customer_count} · Ledger: {health.ledger_count} entries
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
