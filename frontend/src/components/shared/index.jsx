import React, { createContext, useContext, useState, useCallback } from 'react';
import logo from '../../assets/logo.png';

// ── Icon system ──────────────────────────────────────────────────────────
// A small, consistent set of inline-SVG line icons (20x20, stroke=currentColor)
// replacing the emoji used throughout the app for a cleaner, "world class" look.
// Usage: <Icon name="dashboard" size={16} />
const ICON_PATHS = {
  dashboard:  'M3 13h6V3H3v10zm0 8h6v-6H3v6zm8 0h6V11h-6v10zm0-18v6h6V3h-6z',
  search:     'M9 17a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35',
  ledger:     'M4 4h12l4 4v12H4V4zM16 4v4h4M8 12h8M8 16h8M8 8h3',
  mail:       'M3 5h18v14H3V5zm0 0l9 7 9-7',
  mailLog:    'M3 5h18v14H3V5zm0 0l9 7 9-7M6 17h5',
  download:   'M12 3v12m0 0l-5-5m5 5l5-5M4 21h16',
  outlook:    'M3 6h13v12H3V6zm13 3l5-2v10l-5-2M7 12a2 2 0 100-4 2 2 0 000 4z',
  excel:      'M4 4h11l5 5v11H4V4zM15 4v5h5M9 12l6 6M15 12l-6 6',
  eye:        'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM12 15a3 3 0 100-6 3 3 0 000 6z',
  sendMail:   'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
  reconcile:  'M21 12a9 9 0 11-3.5-7.1M21 3v6h-6',
  reset:      'M3 12a9 9 0 1 1 3.5 7.1M3 21v-6h6',
  approve:    'M20 6L9 17l-5-5',
  back:       'M19 12H5m0 0l7 7m-7-7l7-7',
  bridge:     'M2 20h20M4 20V10a2 2 0 012-2h1a2 2 0 012 2v10M15 20V10a2 2 0 012-2h1a2 2 0 012 2v10M9 8V6a3 3 0 016 0v2',
  detail:     'M4 6h16M4 12h16M4 18h7',
  book:       'M4 19.5A2.5 2.5 0 016.5 17H20V4H6.5A2.5 2.5 0 004 6.5v13z',
  scale:      'M12 3v18M5 8l-3 6a3.5 3.5 0 007 0l-3-6zm14 0l-3 6a3.5 3.5 0 007 0l-3-6zM5 8h7M12 8h7M8 21h8',
  note:       'M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9l-6-6zM14 3v6h6M9 13h6M9 17h4',
  upload:     'M12 16V4m0 0L7 9m5-5l5 5M4 20h16',
  cloud:      'M7 18a4.5 4.5 0 01-1-8.9A5 5 0 0116 7a4 4 0 011 7.9M9 15l3-3 3 3M12 12v9',
  folder:     'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  checklist:  'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  shield:     'M12 2l8 4v6c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6l8-4z',
  lock:       'M6 10V7a6 6 0 1112 0v3m-13 0h14v10H5V10z',
  checkCircle:'M22 11.1V12a10 10 0 11-5.9-9.1M22 4L12 14.01l-3-3',
  xCircle:    'M12 22a10 10 0 100-20 10 10 0 000 20zM15 9l-6 6M9 9l6 6',
  clock:      'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2',
  warning:    'M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0zM12 9v4M12 17h.01',
  info:       'M12 22a10 10 0 100-20 10 10 0 000 20zM12 16v-4M12 8h.01',
  json:       'M8 4a2 2 0 00-2 2v3a2 2 0 01-2 2 2 2 0 012 2v3a2 2 0 002 2M16 4a2 2 0 012 2v3a2 2 0 002 2 2 2 0 00-2 2v3a2 2 0 01-2 2',
  refresh:    'M21 2v6h-6M3 22v-6h6M3.5 9a9 9 0 0114.9-4.2L21 8M20.5 15a9 9 0 01-14.9 4.2L3 16',
  arrow:      'M5 12h14m0 0l-6-6m6 6l-6 6',
};
export function Icon({ name, size = 16, color = 'currentColor', style, ...rest }) {
  const d = ICON_PATHS[name];
  if (!d) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }} {...rest}>
      <path d={d} />
    </svg>
  );
}

const ToastCtx = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const add = useCallback((msg, type = 'success', duration = 3500) => {
    const id = Date.now() + Math.random();
    setToasts(p => [...p, { id, msg, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), duration);
  }, []);

  const remove = id => setToasts(p => p.filter(t => t.id !== id));
  const icons  = { success: 'checkCircle', err: 'xCircle', warn: 'warning', info: 'info' };

  return (
    <ToastCtx.Provider value={add}>
      {children}
      <div className="toast-ct">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>
            <Icon name={icons[t.type] || 'checkCircle'} size={16} />
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
  const cfg = {
    MATCHED: ['checkCircle', 'Matched'], DIFFERENCE: ['warning', 'Difference'], PENDING: ['clock', 'Pending'],
    IN_PROGRESS: ['search', 'In Progress'], COMPLETED: ['checkCircle', 'Completed'],
    ACTIVE: ['checkCircle', 'Active'], USED: ['checkCircle', 'Used'], REVOKED: ['xCircle', 'Revoked'],
    NOT_GENERATED: [null, '—'], SENT: ['mail', 'Sent'], READY: ['clock', 'Ready'], FAILED: ['warning', 'Failed'],
  };
  const cls = map[status] || 'b-grey';
  const [icon, label] = cfg[status] || [null, status];
  return <span className={`badge ${cls}`}>{icon ? <Icon name={icon} size={11} /> : <span className="b-dot" />}{label}</span>;
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
