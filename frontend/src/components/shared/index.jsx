import React, { createContext, useContext, useState, useCallback } from 'react';
import logo from '../../assets/logo.png';

const ToastCtx = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const add = useCallback((msg, type = 'success', duration = 3500) => {
    const id = Date.now() + Math.random();
    setToasts(p => [...p, { id, msg, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), duration);
  }, []);

  const remove = id => setToasts(p => p.filter(t => t.id !== id));
  const icons  = { success: '✅', err: '❌', warn: '⚠️', info: 'ℹ️' };

  return (
    <ToastCtx.Provider value={add}>
      {children}
      <div className="toast-ct">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>
            <span>{icons[t.type] || '✅'}</span>
            <span className="t-msg">{t.msg}</span>
            <span className="t-x" onClick={() => remove(t.id)}>×</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ── Brand ─────────────────────────────────────────────────────────────────
export function BrandLogo({ height = 26 }) {
  return <img src={logo} alt="TVS Mobility" style={{ height, display: 'block' }} />;
}

// ── Modal ──────────────────────────────────────────────────────────────────
export function Modal({ open, onClose, title, sub, children, footer, wide }) {
  if (!open) return null;
  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={wide ? { maxWidth: 720 } : {}}>
        <div className="modal-hd">
          <div>
            <div className="modal-title">{title}</div>
            {sub && <div className="modal-sub">{sub}</div>}
          </div>
          <button className="modal-x" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-ft">{footer}</div>}
      </div>
    </div>
  );
}

// ── Spinner ────────────────────────────────────────────────────────────────
export function Spinner({ full }) {
  if (full) return <div className="loading-full"><div className="spinner" /></div>;
  return <div className="spinner" />;
}

// ── Format helpers ─────────────────────────────────────────────────────────
export function fmtINR(n) {
  if (n === null || n === undefined) return '—';
  return '₹' + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtDate(s) {
  if (!s) return '—';
  try {
    const d = new Date(s);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return s; }
}

export function statusBadge(status) {
  const map = {
    MATCHED: 'b-conf', DIFFERENCE: 'b-diff', PENDING: 'b-pend', IN_PROGRESS: 'b-recon',
    COMPLETED: 'b-conf', ACTIVE: 'b-conf', USED: 'b-grey', REVOKED: 'b-diff',
    NOT_GENERATED: 'b-grey', SENT: 'b-conf', READY: 'b-recon', FAILED: 'b-diff',
  };
  const labels = {
    MATCHED: '✅ Matched', DIFFERENCE: '⚠️ Difference', PENDING: '⏳ Pending',
    IN_PROGRESS: '🔍 In Progress', COMPLETED: '✓ Completed',
    ACTIVE: '🟢 Active', USED: '✓ Used', REVOKED: '✗ Revoked',
    NOT_GENERATED: '—', SENT: '📧 Sent', READY: '🟡 Ready', FAILED: '⚠️ Failed',
  };
  const cls = map[status] || 'b-grey';
  return <span className={`badge ${cls}`}><span className="b-dot" />{labels[status] || status}</span>;
}

// ── Topbar ─────────────────────────────────────────────────────────────────
export function Topbar({ onLogout, cycleId, company, asOfDate, adminEmail }) {
  return (
    <header style={{
      height: 56, background: '#1E1E2E', display: 'flex', alignItems: 'center',
      justifyContent: 'space-between', padding: '0 20px',
      borderBottom: '2px solid #C8102E', position: 'sticky', top: 0, zIndex: 200,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ background: '#fff', borderRadius: 6, padding: '4px 10px', display: 'flex', alignItems: 'center' }}>
          <BrandLogo height={22} />
        </div>
        <div style={{ width: 1, height: 20, background: '#ffffff20' }} />
        <div style={{ color: '#ffffff80', fontSize: 11 }}>Balance Confirmation &amp; Reconciliation Portal</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          background: '#ffffff10', border: '1px solid #ffffff15', color: '#ffffff70',
          fontSize: 10, fontWeight: 600, padding: '3px 10px', borderRadius: 999,
        }}>{company} · {asOfDate} · {cycleId}</span>
        {adminEmail && (
          <span style={{ color: '#ffffff60', fontSize: 11 }}>{adminEmail}</span>
        )}
        <span style={{
          background: '#C8102E20', border: '1px solid #C8102E50', color: '#FCA5A5',
          fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
          letterSpacing: '.06em', textTransform: 'uppercase',
        }}>TEST DATA</span>
        {onLogout && (
          <button onClick={onLogout} style={{
            background: 'transparent', border: '1px solid #ffffff20', color: '#ffffff60',
            padding: '5px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
          }}>Logout</button>
        )}
      </div>
    </header>
  );
}

// ── Cycle Ribbon ───────────────────────────────────────────────────────────
export function CycleRibbon({ data }) {
  if (!data) return null;
  const pct = data.total_customers > 0 ? Math.round((data.submitted / data.total_customers) * 100) : 0;
  const fillColor = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--amber)' : 'var(--diff)';

  return (
    <div className="ribbon">
      {[
        { label: 'Total', val: data.total_customers, color: 'var(--ink)' },
        { label: 'Submitted', val: data.submitted, color: 'var(--green)' },
        { label: 'Matched', val: data.matched, color: 'var(--green)' },
        { label: 'Difference', val: data.difference, color: 'var(--diff)' },
        { label: 'Pending', val: data.pending, color: 'var(--amber)' },
        { label: 'Recon Done', val: data.recon_completed, color: 'var(--blue)' },
        { label: 'Sent Back', val: data.recon_sent_to_customer, color: 'var(--green)' },
      ].map(({ label, val, color }) => (
        <div key={label} className="rib-item">
          <span className="rib-lbl">{label}</span>
          <span className="rib-val" style={{ color }}>{val}</span>
        </div>
      ))}
      <div className="rib-sep" />
      <div className="rib-item">
        <span className="rib-lbl">Variance</span>
        <span className="rib-val mono" style={{ color: 'var(--diff)', fontSize: 11 }}>{fmtINR(data.total_variance)}</span>
      </div>
      <div className="rib-sep" />
      <div className="rib-prog">
        <span className="rib-lbl">Response</span>
        <div className="rib-track"><div className="rib-fill" style={{ width: pct + '%', background: fillColor }} /></div>
        <span className="rib-pct">{pct}%</span>
      </div>
    </div>
  );
}
