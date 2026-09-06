import React, { useState, useEffect, useCallback } from 'react';
import { ToastProvider, Topbar, CycleRibbon, useToast, Spinner, BrandLogo, Icon } from './components/shared';
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
  const [transitioning, setTransitioning] = useState(false); // animated loading screen shown right after a fresh sign-in
  const [adminEmail, setAdminEmail] = useState(null);
  const [page, setPage]           = useState('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('bsync_sidebar_collapsed') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('bsync_sidebar_collapsed', sidebarCollapsed ? '1' : '0'); } catch {}
  }, [sidebarCollapsed]);
  const [reconId, setReconId]     = useState(null);
  const [health, setHealth]       = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const toast = useToast();

  const loadHealth = useCallback(async () => {
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
  }, [toast]);

  const loadDashboard = useCallback(async () => {
    try { setDashboard(await api.dashboard()); } catch {}
  }, []);

  useEffect(() => {
    if (!loggedIn) return;
    api.me().then(m => setAdminEmail(m.email)).catch(() => { setLoggedIn(false); });
    loadHealth();
    loadDashboard();
    const iv = setInterval(loadDashboard, 10000);
    return () => clearInterval(iv);
  }, [loggedIn, loadHealth, loadDashboard]);

  function navigate(p, id) { setPage(p); if (id) setReconId(id); }

  function logout() { api.setToken(null); setLoggedIn(false); }

  if (transitioning) return <LoadingTransition />;

  if (!loggedIn) return <Login onLogin={(email) => { setAdminEmail(email); setTransitioning(true); setTimeout(() => { setLoggedIn(true); setTransitioning(false); }, 1400); }} />;

  const NAV = [
    { id: 'dashboard', ico: 'dashboard', label: 'Overview' },
    { id: 'recon',     ico: 'search',    label: 'Reconciliation Studio' },
    { id: 'ledger',    ico: 'ledger',    label: 'Ledger Sync' },
    { id: 'audit',     ico: 'shield',    label: 'Audit Trail' },
    { id: 'health',    ico: 'refresh',   label: 'System Health' },
  ];

  return (
    <div className="app">
      <Topbar onLogout={logout} cycleId={health?.cycle_id || '—'} company={health?.company || 'TSL'} asOfDate={health?.as_of_date || '—'} adminEmail={adminEmail} />
      <CycleRibbon data={dashboard} />
      <div className="layout">
        <nav className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
          {NAV.map(n => (
            <button key={n.id} className={`sidebar-link ${page === n.id ? 'active' : ''}`} onClick={() => navigate(n.id)}>
              <span className="sico"><Icon name={n.ico} size={16} /></span>
              <span className="slabel">{n.label}</span>
              {sidebarCollapsed && <span className="sidebar-tip">{n.label}</span>}
            </button>
          ))}
          <button className="sidebar-toggle" onClick={() => setSidebarCollapsed(c => !c)} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            <Icon name={sidebarCollapsed ? 'arrow' : 'back'} size={12} />
            {!sidebarCollapsed && <span>Collapse</span>}
          </button>
        </nav>
        <main className="main-content">
          {healthLoading && <Spinner full />}
          {!healthLoading && health && !health.checks?.customerMaster?.exists && (
            <div className="info-box ib-red" style={{ marginBottom: 16 }}>
              <strong><Icon name="warning" size={13} /> No Customers Loaded</strong>
              Run <code>npm run seed</code> in the backend folder to load <code>data/customer_master.json</code>.
            </div>
          )}
          {!healthLoading && health && !health.checks?.ledger?.exists && (
            <div className="info-box ib-red" style={{ marginBottom: 16 }}>
              <strong><Icon name="warning" size={13} /> No Ledger Loaded</strong>
              Run <code>npm run seed</code> in the backend folder to load <code>data/TSL_ledger.json</code>.
            </div>
          )}

          <div key={page} className="page-in">
            {page === 'dashboard' && <Dashboard onNavigate={navigate} />}
            {page === 'recon'     && <Reconciliation customerId={reconId} onBack={() => navigate('dashboard')} />}
            {page === 'ledger'    && <LedgerUpload />}
            {page === 'audit'     && <AuditLogView />}
            {page === 'health'    && <SystemHealth health={health} onRefresh={loadHealth} />}
          </div>
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
    <div className="ct-login-wrap">
      <svg className="ct-mesh" viewBox="0 0 1200 800" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <radialGradient id="ctGlow" cx="70%" cy="20%" r="60%">
            <stop offset="0%" stopColor="#C8102E" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#C8102E" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="1200" height="800" fill="url(#ctGlow)" />
        {Array.from({ length: 9 }).map((_, i) => (
          <line key={`h${i}`} x1="0" y1={i * 90} x2="1200" y2={i * 90 + 60} className="ct-line" style={{ animationDelay: `${i * 0.4}s` }} />
        ))}
        {[120, 340, 560, 780, 1000].map((cx, i) => (
          <circle key={i} cx={cx} cy={140 + (i % 3) * 220} r="3.2" className="ct-node" style={{ animationDelay: `${i * 0.6}s` }} />
        ))}
      </svg>

      <div className="login-card ct-glass">
        <div style={{ textAlign: 'center', marginBottom: 26 }}>
          <div style={{ display: 'inline-flex', background: '#fff', borderRadius: 10, padding: '10px 18px', marginBottom: 16, boxShadow: '0 8px 24px rgba(0,0,0,.25)' }}>
            <BrandLogo height={30} />
          </div>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: '#FCA5A5', marginBottom: 8 }}>Accounts Receivable Platform</div>
          <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 20, fontWeight: 700, marginBottom: 5, color: '#fff' }}>BalanceSync</div>
          <div style={{ fontSize: 12, color: '#ffffffa0', lineHeight: 1.5 }}>Balance Confirmation &amp; Reconciliation Console</div>
        </div>
        <form onSubmit={attempt}>
          <div className="field">
            <label className="lbl" style={{ color: '#ffffffb0' }}>Admin Email</label>
            <input className="inp ct-inp" type="email" value={email} onChange={e => { setEmail(e.target.value); setErr(''); }} placeholder="admin@yourcompany.com" autoFocus />
          </div>
          <div className="field">
            <label className="lbl" style={{ color: '#ffffffb0' }}>Password</label>
            <input className={`inp ct-inp${err ? ' inp-err' : ''}`} type="password" value={pwd}
              onChange={e => { setPwd(e.target.value); setErr(''); }} placeholder="Enter admin password" />
            {err && <div className="err-msg">{err}</div>}
          </div>
          <button type="submit" className="btn btn-primary btn-full btn-lg" disabled={busy}>
            {busy ? <><Spinner /> Signing in…</> : <>Sign In to Console <Icon name="arrow" size={14} /></>}
          </button>
        </form>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 20, fontSize: 10, color: '#ffffff65' }}>
          <Icon name="shield" size={12} /> Two-factor verified customer links · Encrypted balance data
        </div>
        <div style={{ marginTop: 14, textAlign: 'center', fontSize: 10, color: '#ffffff55' }}>
          Set ADMIN_EMAIL / ADMIN_PASSWORD in backend/.env<br/>
          <span style={{ color: '#FCA5A5', fontWeight: 600 }}>TEST DATA ONLY — NOT FOR PRODUCTION</span>
        </div>
      </div>
    </div>
  );
}

// ── Animated loading transition (login → portal) ────────────────────────────
const LOADING_STEPS = ['Authenticating session', 'Loading customer ledger', 'Preparing your workspace'];
function LoadingTransition() {
  const [step, setStep] = useState(0);
  const STEPS = LOADING_STEPS;
  useEffect(() => {
    const iv = setInterval(() => setStep(s => Math.min(s + 1, LOADING_STEPS.length - 1)), 420);
    return () => clearInterval(iv);
  }, []);
  return (
    <div className="ct-login-wrap" style={{ display: 'grid', placeItems: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <div className="ct-ring-wrap">
          <div className="ct-ring" />
          <div className="ct-logo-pulse"><BrandLogo height={30} /></div>
        </div>
        <div style={{ marginTop: 22, color: '#ffffffc0', fontSize: 12, letterSpacing: '.06em', fontWeight: 600 }}>
          {STEPS[step]}…
        </div>
        <div style={{ width: 160, height: 3, background: '#ffffff15', borderRadius: 999, margin: '14px auto 0', overflow: 'hidden' }}>
          <div style={{ height: '100%', background: 'var(--red)', borderRadius: 999, width: `${((step + 1) / STEPS.length) * 100}%`, transition: 'width .35s ease' }} />
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
                  <Icon name={check.exists ? 'checkCircle' : 'xCircle'} size={17} color={check.exists ? 'var(--green)' : 'var(--diff)'} />
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
