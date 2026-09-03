import React, { useState, useEffect, useCallback } from 'react';
import api from '../../services/api';
import { fmtINR, fmtDate, statusBadge, Modal, Spinner, useToast } from '../shared';

const PAGE = 15;

export default function Dashboard({ onNavigate }) {
  const toast = useToast();
  const [customers, setCustomers]     = useState([]);
  const [dashboard, setDashboard]     = useState(null);
  const [loading, setLoading]         = useState(true);
  const [search, setSearch]           = useState('');
  const [statusF, setStatusF]         = useState('');
  const [page, setPage]               = useState(1);
  const [selected, setSelected]       = useState(new Set());
  const [detailModal, setDetailModal] = useState(null);
  const [emailModal, setEmailModal]   = useState(false);
  const [emailResult, setEmailResult] = useState(null);
  const [triggering, setTriggering]   = useState(false);
  const [resetting, setResetting]     = useState(null);
  const [sendingId, setSendingId]     = useState(null);
  const [previewModal, setPreviewModal] = useState(null);
  const [expiryDate, setExpiryDate]   = useState('');

  const load = useCallback(async () => {
    try {
      const [custs, dash] = await Promise.all([api.customers(), api.dashboard()]);
      setCustomers(custs.customers || []);
      setDashboard(dash);
    } catch (e) { toast(e.message, 'err'); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); const iv = setInterval(load, 10000); return () => clearInterval(iv); }, [load]);

  let data = [...customers];
  if (search) data = data.filter(c =>
    c.customer_name.toLowerCase().includes(search.toLowerCase()) ||
    c.customer_id.toLowerCase().includes(search.toLowerCase()) ||
    (c.email || '').toLowerCase().includes(search.toLowerCase())
  );
  if (statusF) data = data.filter(c => c.status === statusF);
  data.sort((a, b) => (Math.abs(b.difference || 0)) - (Math.abs(a.difference || 0)));

  const totalPages = Math.ceil(data.length / PAGE);
  const pageData   = data.slice((page - 1) * PAGE, page * PAGE);

  async function triggerEmails() {
    setTriggering(true);
    try {
      const opts = {};
      if (expiryDate) opts.expiry_date = new Date(expiryDate).toISOString();
      if (Object.keys(opts).length) await api.generateTokens(opts); // apply custom expiry before sending
      const r = await api.triggerEmails();
      setEmailResult(r);
      toast(r.smtp_configured ? `✅ ${r.sent} emails sent` : `⚠️ SMTP not configured — ${r.results.length} portal links generated (see Email Log)`, 'info', 5000);
      load();
    } catch (e) { toast(e.message, 'err'); }
    finally { setTriggering(false); }
  }

  async function sendSingle(id) {
    setSendingId(id);
    try {
      const r = await api.triggerEmailsSingle(id);
      toast(r.smtp_configured ? `✅ Email sent to ${id}` : `Link generated for ${id} — SMTP not configured, copy from Email Log`, 'success');
      load();
    } catch (e) { toast(e.message, 'err'); }
    finally { setSendingId(null); }
  }

  async function resetCustomer(id) {
    setResetting(id);
    try { await api.resetToken(id); toast(`Reset complete for ${id}`, 'success'); load(); }
    catch (e) { toast(e.message, 'err'); }
    finally { setResetting(null); }
  }

  async function showPreview(id) {
    try { setPreviewModal(await api.emailPreview(id)); }
    catch (e) { toast(e.message, 'err'); }
  }

  const kpis = dashboard ? [
    { label: 'Total Customers', val: dashboard.total_customers, cls: 'kpi-ink',   foot: 'This cycle' },
    { label: 'Submitted',       val: dashboard.submitted,       cls: 'kpi-blue',  foot: `${dashboard.response_rate}% response rate` },
    { label: 'Matched',         val: dashboard.matched,         cls: 'kpi-green', foot: 'Balance agreed' },
    { label: 'Difference',      val: dashboard.difference,      cls: 'kpi-red',   foot: 'Require reconciliation' },
    { label: 'Pending',         val: dashboard.pending,         cls: 'kpi-amber', foot: 'Awaiting response' },
    { label: 'Recon Done',      val: dashboard.recon_completed, cls: 'kpi-grey',  foot: 'Fully resolved' },
    { label: 'Sent Back',       val: dashboard.recon_sent_to_customer, cls: 'kpi-blue', foot: 'Recon emailed to customer' },
    { label: 'Total Variance',  val: fmtINR(dashboard.total_variance), cls: 'kpi-red', foot: 'Across differences', isText: true },
  ] : [];

  return (
    <div>
      <div className="sec-hd">
        <div>
          <div className="sec-title disp">Confirmation Dashboard</div>
          <div className="sec-sub">Live view · auto-refreshes every 10 seconds · Cycle: {dashboard?.cycle_id}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-secondary btn-sm" onClick={() => onNavigate('ledger')}>⬆ Upload Ledger</button>
          <button className="btn btn-secondary btn-sm" onClick={() => setEmailModal(true)}>📋 Email Log</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <label style={{ fontSize: 10, color: 'var(--muted)' }}>Link expires on</label>
            <input type="date" className="inp" style={{ width: 140, padding: '5px 8px', fontSize: 11 }}
              value={expiryDate} onChange={e => setExpiryDate(e.target.value)}
              title="Custom expiry date for tokens generated by the next email trigger (leave blank to use the default expiry hours)" />
          </div>
          <button className="btn btn-primary" onClick={triggerEmails} disabled={triggering}>
            {triggering ? <><Spinner /> Triggering…</> : '📧 Trigger Customer Emails'}
          </button>
          <a href={api.outlookScriptUrl()} className="btn btn-secondary" title="If cloud SMTP is blocked by your mail provider, download a script that drafts these emails in your own Desktop Outlook instead (review &amp; send from there).">
            📥 Download Outlook Script
          </a>
        </div>
      </div>

      {loading ? <Spinner full /> : (
        <>
          <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 18 }}>
            {kpis.slice(0, 8).map(k => (
              <div key={k.label} className={`kpi ${k.cls}`}>
                <div className="kpi-lbl">{k.label}</div>
                <div className="kpi-val disp" style={k.isText ? { fontSize: 16 } : {}}>{k.val}</div>
                <div className="kpi-foot">{k.foot}</div>
              </div>
            ))}
          </div>

          <div className="filter-bar">
            <div className="srch-wrap">
              <span className="srch-ico">🔍</span>
              <input className="inp srch-inp" placeholder="Search customer name, ID or email…"
                value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
            </div>
            <select className="flt-sel" value={statusF} onChange={e => { setStatusF(e.target.value); setPage(1); }}>
              <option value="">All Status</option>
              <option value="MATCHED">✅ Matched</option>
              <option value="DIFFERENCE">⚠️ Difference</option>
              <option value="PENDING">⏳ Pending</option>
            </select>
            <button className="btn btn-ghost btn-sm" onClick={() => { setSearch(''); setStatusF(''); setPage(1); }}>Clear</button>
            <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 4 }}>{data.length} of {customers.length} customers</span>
          </div>

          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th><input type="checkbox" onChange={e => setSelected(e.target.checked ? new Set(pageData.map(c => c.customer_id)) : new Set())} style={{ accentColor: '#C8102E' }} /></th>
                  <th>Customer</th><th>Customer ID</th><th>SAP Balance</th>
                  <th>Cust. Balance</th><th>Difference</th><th>Status</th>
                  <th>Submission Date</th><th>SOA</th><th>Token</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pageData.length === 0 && (
                  <tr><td colSpan={11} style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>No customers found</td></tr>
                )}
                {pageData.map(c => {
                  const diffCls = c.difference === null ? '' : c.difference === 0 ? 'td-ok' : Math.abs(c.difference) > 100000 ? 'td-hi' : 'td-lo';
                  return (
                    <tr key={c.customer_id}>
                      <td><input type="checkbox" checked={selected.has(c.customer_id)}
                        onChange={e => { const n = new Set(selected); e.target.checked ? n.add(c.customer_id) : n.delete(c.customer_id); setSelected(n); }}
                        style={{ accentColor: '#C8102E' }} /></td>
                      <td><div className="td-prim">{c.customer_name}</div><div className="td-sub">{c.email?.replace(/<.*>/, '').trim()}</div></td>
                      <td><span className="td-mono" style={{ fontSize: 11, color: 'var(--muted)' }}>{c.customer_id}</span></td>
                      <td><span className="td-mono">{fmtINR(c.sap_balance)}</span></td>
                      <td><span className="td-mono">{c.cust_balance != null ? fmtINR(c.cust_balance) : <span style={{ color: 'var(--muted-lt)' }}>—</span>}</span></td>
                      <td><span className={`td-mono ${diffCls}`}>{c.difference === null ? '—' : c.difference === 0 ? '✓ Nil' : fmtINR(c.difference)}</span></td>
                      <td>{statusBadge(c.status)}</td>
                      <td><span style={{ fontSize: 10, color: 'var(--muted)' }}>{c.submission_date ? fmtDate(c.submission_date) : '—'}</span></td>
                      <td>{c.soa_file ? <a href={api.soaDownloadUrl(c.customer_id)} className="btn btn-ghost btn-sm" style={{ fontSize: 10 }}>📄 Download</a> : <span style={{ color: 'var(--muted-lt)', fontSize: 10 }}>—</span>}</td>
                      <td><span style={{ fontSize: 10, color: 'var(--muted)' }}>{c.token_status?.replace('_', ' ')}</span></td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="act-btn" title="Details" onClick={() => setDetailModal(c)}>👁</button>
                          <button className="act-btn" title="Preview Email" onClick={() => showPreview(c.customer_id)}>📧</button>
                          <button className="act-btn" title="Send Email to This Customer" onClick={() => sendSingle(c.customer_id)} disabled={sendingId === c.customer_id}>
                            {sendingId === c.customer_id ? '…' : '✉️'}
                          </button>
                          {c.status === 'DIFFERENCE' || c.soa_file
                            ? <button className="act-btn" title="Reconcile" onClick={() => onNavigate('recon', c.customer_id)}>🔍</button>
                            : null}
                          <button className="act-btn" title="Reset (for testing)" onClick={() => resetCustomer(c.customer_id)} disabled={resetting === c.customer_id} style={{ fontSize: 10 }}>↺</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="pgn">
              <span className="pg-info">Page {page} of {Math.max(1, totalPages)}</span>
              <button className="pg-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹</button>
              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                const pg = Math.max(1, page - 2) + i;
                if (pg > totalPages) return null;
                return <button key={pg} className={`pg-btn ${page === pg ? 'active' : ''}`} onClick={() => setPage(pg)}>{pg}</button>;
              })}
              <button className="pg-btn" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>›</button>
            </div>
          </div>

          {emailResult && (
            <div className={`info-box ${emailResult.smtp_configured ? 'ib-green' : 'ib-amber'}`} style={{ marginTop: 16 }}>
              <strong>{emailResult.smtp_configured ? '✅ Emails Sent' : '⚠️ SMTP Not Configured — Portal Links Logged'}</strong>
              {emailResult.smtp_configured ? `${emailResult.sent} emails sent via SMTP.` : `${emailResult.results.length} portal URLs generated and saved in the Email Log. Configure SMTP_* in backend/.env to send automatically.`}
            </div>
          )}
        </>
      )}

      <Modal open={!!detailModal} onClose={() => setDetailModal(null)} title={detailModal?.customer_name} sub={`${detailModal?.customer_id} · ${detailModal?.company}`}
        footer={<>
          <button className="btn btn-secondary" onClick={() => setDetailModal(null)}>Close</button>
          {detailModal?.soa_file && <button className="btn btn-primary" onClick={() => onNavigate('recon', detailModal.customer_id)}>Open Recon →</button>}
        </>}>
        {detailModal && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <tbody>
            {[
              ['Customer ID', detailModal.customer_id],
              ['Email', detailModal.email],
              ['PAN', detailModal.pan?.replace(/./g, (c, i) => i > 1 && i < 8 ? '●' : c)],
              ['SAP Balance', fmtINR(detailModal.sap_balance)],
              ['Customer Balance', detailModal.cust_balance != null ? fmtINR(detailModal.cust_balance) : '—'],
              ['Difference', detailModal.difference != null ? (detailModal.difference === 0 ? 'NIL ✓' : fmtINR(detailModal.difference)) : '—'],
              ['Status', detailModal.status],
              ['Submitted', detailModal.submission_date ? fmtDate(detailModal.submission_date) : 'Not submitted'],
              ['SOA File', detailModal.soa_file || 'Not uploaded'],
              ['Token Status', detailModal.token_status],
              ['Token Expires', detailModal.token_expires_at ? fmtDate(detailModal.token_expires_at) : '—'],
              ['Sent Back to Customer', detailModal.recon_sent_to_customer_at ? fmtDate(detailModal.recon_sent_to_customer_at) : 'Not yet'],
            ].map(([k, v]) => (
              <tr key={k} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '9px 0', color: 'var(--muted)', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', width: 160 }}>{k}</td>
                <td style={{ padding: '9px 0', fontWeight: 500 }}>{v}</td>
              </tr>
            ))}
            </tbody>
          </table>
        )}
      </Modal>

      <Modal open={emailModal} onClose={() => setEmailModal(false)} title="Email Log" sub="All confirmation & reconciliation email records" wide>
        <EmailLog />
      </Modal>

      <Modal open={!!previewModal} onClose={() => setPreviewModal(null)} title="Email Preview" sub="Exactly as sent to customer" wide>
        {previewModal && (
          <div>
            <div style={{ fontSize: 12, marginBottom: 8 }}><strong>Subject:</strong> {previewModal.subject}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}><strong>Portal URL:</strong> <a href={previewModal.portal_url} target="_blank" rel="noreferrer">{previewModal.portal_url}</a></div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <iframe title="email-preview" srcDoc={previewModal.body} style={{ width: '100%', height: 420, border: 'none' }} />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function EmailLog() {
  const [log, setLog] = useState(null);
  const toast = useToast();
  useEffect(() => { api.emailLog().then(d => setLog(d.emails || [])).catch(e => toast(e.message, 'err')); }, [toast]);
  if (!log) return <Spinner full />;
  if (log.length === 0) return <div style={{ textAlign: 'center', color: 'var(--muted)', padding: 20 }}>No emails logged yet. Trigger emails first.</div>;
  return (
    <div style={{ maxHeight: 400, overflowY: 'auto' }}>
      {log.map((e, i) => (
        <div key={i} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <strong>{e.customer_name}</strong>
              <span style={{ color: 'var(--muted)', marginLeft: 8, fontSize: 11 }}>{e.email?.replace(/<.*>/, '').trim()}</span>
              {e.kind === 'RECON_COMPLETE' && <span className="badge b-conf" style={{ marginLeft: 8 }}>Recon Sent</span>}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: e.status === 'FAILED' ? '#C8102E' : 'var(--muted)', fontWeight: e.status === 'FAILED' ? 700 : 400 }}>{e.status}</span>
              {e.portal_url && <a href={e.portal_url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm" style={{ fontSize: 10 }}>Open Link</a>}
            </div>
          </div>
          {e.status === 'FAILED' && e.error && (
            <div style={{ marginTop: 4, fontSize: 10, color: '#C8102E', fontFamily: "'JetBrains Mono',monospace", wordBreak: 'break-word' }}>
              ⚠ {e.error}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
