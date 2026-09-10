import React, { useState, useEffect, useCallback } from 'react';
import { ToastProvider, Topbar, CycleRibbon, useToast, Spinner, BrandLogo, Icon } from './components/shared';
import LotOverview    from './components/admin/LotOverview';
import Reconciliation from './components/admin/Reconciliation';
import AuditLogView   from './components/admin/AuditLogView';
import CustomerPortal from './components/portal/CustomerPortal';
import api from './services/api';
import datamaticsLogo from './assets/datamatics-logo.png';
import './index.css';

// ── Main App ───────────────────────────────────────────────────────────────
export default function App() {
  const isPortal = window.location.pathname === '/portal';

  if (isPortal) {
    return (
      <ToastProvider>
        <div style={{ height: '100vh', overflow: 'hidden', background: 'var(--slate)', display: 'flex', flexDirection: 'column' }}>
          <header style={{
            height: 56, flexShrink: 0, background: '#1E1E2E', display: 'flex', alignItems: 'center',
            padding: '0 20px', borderBottom: '2px solid #C8102E',
          }}>
            <div style={{ background: '#fff', borderRadius: 6, padding: '4px 10px', display: 'flex', alignItems: 'center' }}>
              <BrandLogo height={22} />
            </div>
            <div style={{ width: 1, height: 18, background: '#ffffff20', margin: '0 14px' }} />
            <div style={{ color: '#ffffff50', fontSize: 11 }}>Customer Balance Confirmation</div>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
              <span style={{ background: '#C8102E20', border: '1px solid #C8102E50', color: '#FCA5A5', fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 999, letterSpacing: '.06em', textTransform: 'uppercase' }}>TEST DATA</span>
              <div style={{ width: 1, height: 18, background: '#ffffff20' }} />
              <div style={{ background: '#fff', borderRadius: 6, padding: '4px 10px', display: 'flex', alignItems: 'center' }}>
                <img src={datamaticsLogo} alt="Datamatics" style={{ height: 20, display: 'block' }} />
              </div>
            </div>
          </header>
          <div style={{ flex: 1, minHeight: 0 }}>
            <CustomerPortal />
          </div>
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
  const [page, setPage]           = useState('customer-overview');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('bsync_sidebar_collapsed') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('bsync_sidebar_collapsed', sidebarCollapsed ? '1' : '0'); } catch {}
  }, [sidebarCollapsed]);
  const [reconTarget, setReconTarget] = useState(null); // { lotId, customerId } — Reconciliation Studio is Lot-scoped
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

  // `target`, when given, is { lotId, customerId } — used when navigating
  // straight into Reconciliation Studio for a specific Lot+customer (e.g.
  // the "Reconcile" row action in Lot Overview). Navigating to the studio
  // without a target clears it, so the screen falls back to its own Lot ->
  // customer picker instead of reopening whatever was last selected.
  function navigate(p, target) {
    setPage(p);
    if (p === 'customer-recon' || p === 'vendor-recon') setReconTarget(target || null);
  }

  function logout() { api.setToken(null); setLoggedIn(false); }

  if (transitioning) return <LoadingTransition />;

  if (!loggedIn) return <Login onLogin={(email) => { setAdminEmail(email); setTransitioning(true); setTimeout(() => { setLoggedIn(true); setTransitioning(false); }, 1400); }} />;

  // Two fully separate modules (item 1 — user's confirmed choice: "Two full
  // separate modules"). Each has its own Overview (which now also holds the
  // Lot list — item 11 — with KPI cards that total across that module's
  // Lots or narrow to whichever one is expanded — item 2) plus its own
  // Reconciliation Studio and Audit Trail entry points. There is no
  // standalone "Ledger Sync" tab any more (item 5) — ledger upload only
  // happens inside a Lot (Overview → expand a Lot → upload).
  const NAV_GROUPS = [
    { group: 'CUSTOMER', items: [
      { id: 'customer-overview', ico: 'dashboard', label: 'Overview' },
      { id: 'customer-recon',    ico: 'search',    label: 'Reconciliation Studio' },
      { id: 'customer-audit',    ico: 'shield',    label: 'Audit Trail' },
    ] },
    { group: 'VENDOR', items: [
      { id: 'vendor-overview', ico: 'dashboard', label: 'Overview' },
      { id: 'vendor-recon',    ico: 'search',    label: 'Reconciliation Studio' },
      { id: 'vendor-audit',    ico: 'shield',    label: 'Audit Trail' },
    ] },
  ];
  const FLAT_NAV = [{ id: 'health', ico: 'refresh', label: 'System Health' }];

  return (
    <div className="app">
      <Topbar onLogout={logout} cycleId={health?.cycle_id || '—'} company={health?.company || 'TSL'} asOfDate={health?.as_of_date || '—'} adminEmail={adminEmail} />
      <CycleRibbon data={dashboard} />
      <div className="layout">
        <nav className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
          {NAV_GROUPS.map(g => (
            <div key={g.group} style={{ marginBottom: 6 }}>
              {!sidebarCollapsed && (
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', color: 'var(--muted)', padding: '10px 14px 4px' }}>{g.group}</div>
              )}
              {g.items.map(n => (
                <button key={n.id} className={`sidebar-link ${page === n.id ? 'active' : ''}`} onClick={() => navigate(n.id)}>
                  <span className="sico"><Icon name={n.ico} size={16} /></span>
                  <span className="slabel">{n.label}</span>
                  {sidebarCollapsed && <span className="sidebar-tip">{g.group} · {n.label}</span>}
                </button>
              ))}
            </div>
          ))}
          {FLAT_NAV.map(n => (
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

          <div key={page} className="page-in">
            {page === 'customer-overview' && <LotOverview businessType="CUSTOMER" onReconcile={(lotId, customerId) => navigate('customer-recon', { lotId, customerId })} />}
            {page === 'vendor-overview'   && <LotOverview businessType="VENDOR" onReconcile={(lotId, customerId) => navigate('vendor-recon', { lotId, customerId })} />}
            {(page === 'customer-recon' || page === 'vendor-recon') && (
              <Reconciliation lotId={reconTarget?.lotId} customerId={reconTarget?.customerId} onBack={() => navigate(page === 'vendor-recon' ? 'vendor-overview' : 'customer-overview')} />
            )}
            {(page === 'customer-audit' || page === 'vendor-audit') && <AuditLogView />}
            {page === 'health' && <SystemHealth health={health} onRefresh={loadHealth} />}
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
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, background: '#fff', borderRadius: 10, padding: '10px 16px', marginBottom: 16, boxShadow: '0 8px 24px rgba(0,0,0,.25)' }}>
            <BrandLogo height={30} />
            <div style={{ width: 1, height: 22, background: '#00000018' }} />
            <img src={datamaticsLogo} alt="Datamatics" style={{ height: 22, display: 'block' }} />
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
        <div className="ld-orbit">
          <svg viewBox="0 0 120 120" width="120" height="120">
            <circle cx="60" cy="60" r="52" fill="none" stroke="#ffffff12" strokeWidth="3" />
            <circle cx="60" cy="60" r="52" fill="none" stroke="var(--red)" strokeWidth="3" strokeLinecap="round"
              strokeDasharray="90 300" className="ld-arc-1" />
            <circle cx="60" cy="60" r="38" fill="none" stroke="#ffffff10" strokeWidth="2" />
            <circle cx="60" cy="60" r="38" fill="none" stroke="#ffffffb0" strokeWidth="2" strokeLinecap="round"
              strokeDasharray="50 220" className="ld-arc-2" />
            <circle cx="60" cy="60" r="7" fill="var(--red)" className="ld-core" />
          </svg>
        </div>
        <div style={{ marginTop: 20, color: '#ffffffc0', fontSize: 12, letterSpacing: '.06em', fontWeight: 600 }}>
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
