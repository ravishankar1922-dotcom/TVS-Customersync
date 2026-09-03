import React, { useState, useEffect, useCallback } from 'react';
import api from '../../services/api';
import { fmtINR, fmtDate, Spinner, useToast } from '../shared';

const MATCH_CONFIG = {
  MATCHED:                 { label: '✓ Matched',              cls: 'hl-ok',      tagCls: 'rt-ok'  },
  MATCHED_WITH_DIFFERENCE: { label: '≈ Matched (Diff)',        cls: 'hl-diff',    tagCls: 'rt-diff'},
  AMOUNT_DATE_MATCH:       { label: '~ Approx Match',          cls: 'hl-diff',    tagCls: 'rt-diff'},
  MISSING_IN_CUSTOMER:     { label: '✗ Missing in Customer',   cls: 'hl-missing', tagCls: 'rt-miss'},
  NOT_IN_SAP:              { label: '+ Not in SAP',            cls: 'hl-extra',   tagCls: 'rt-extra'},
};
const ROOT_CAUSES = ['Invoice in Transit', 'Credit Note Pending', 'Payment Timing', 'Disputed', 'Data Entry Error', 'Resolved', 'Other'];

export default function Reconciliation({ customerId, onBack }) {
  const toast = useToast();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes]     = useState('');
  const [saving, setSaving]   = useState(false);
  const [sending, setSending] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [rootCauses, setRootCauses] = useState({});
  const [filter, setFilter]   = useState('ALL');
  const [q, setQ]             = useState('');

  const load = useCallback(async () => {
    if (!customerId) return;
    setLoading(true);
    try {
      const r = await api.reconcile(customerId);
      setData(r);
      setNotes(r.recon_notes || '');
      setRootCauses(r.root_causes || {});
    } catch (e) { toast(e.message, 'err'); }
    finally { setLoading(false); }
  }, [customerId, toast]);

  useEffect(() => { load(); }, [load]);

  function setRootCause(idx, val) {
    const next = { ...rootCauses, [idx]: val };
    setRootCauses(next);
    // Persist immediately so tags survive refresh / being opened by another admin.
    api.updateRecon(customerId, { root_causes: next, recon_status: 'IN_PROGRESS' }).catch(e => toast(e.message, 'err'));
  }

  async function saveNotes() {
    setSaving(true);
    try { await api.updateRecon(customerId, { recon_notes: notes, recon_status: 'IN_PROGRESS' }); toast('Notes saved.', 'success'); }
    catch (e) { toast(e.message, 'err'); }
    finally { setSaving(false); }
  }

  async function markComplete() {
    setSaving(true);
    try { await api.updateRecon(customerId, { recon_notes: notes, recon_status: 'COMPLETED' }); toast('Reconciliation marked complete.', 'success'); load(); }
    catch (e) { toast(e.message, 'err'); }
    finally { setSaving(false); }
  }

  async function exportExcel() {
    setExporting(true);
    try {
      const blob = await api.reconExportBlob(customerId);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `Reconciliation_${customerId}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) { toast(e.message, 'err'); }
    finally { setExporting(false); }
  }

  async function sendToCustomer() {
    if (!window.confirm('Email the reconciliation summary + Excel workbook to this customer now?')) return;
    setSending(true);
    try {
      const r = await api.sendReconToCustomer(customerId);
      toast(`✅ Sent to ${r.sent_to}`, 'success');
      load();
    } catch (e) { toast(e.message, 'err'); }
    finally { setSending(false); }
  }

  if (!customerId) return (
    <div style={{ textAlign: 'center', padding: 60, color: 'var(--muted)' }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>No customer selected</div>
      <div style={{ fontSize: 12 }}>Open from the Dashboard by clicking 🔍 on a customer with a submission.</div>
    </div>
  );

  if (loading) return <Spinner full />;
  if (!data) return <div className="info-box ib-red">Failed to load reconciliation data.</div>;

  const { summary, results, sap_lines, customer_lines } = data;
  let filtered = filter === 'ALL' ? results : results.filter(r => r.match_type === filter);
  if (q.trim()) {
    const needle = q.trim().toUpperCase();
    filtered = filtered.filter(r => (r.sap_doc || '').toUpperCase().includes(needle) || (r.cust_doc || '').toUpperCase().includes(needle));
  }
  const matchRate = results.length ? Math.round(((summary.matched + summary.matched_with_difference + summary.amount_date_match) / results.length) * 100) : 0;

  return (
    <div>
      <div className="sec-hd">
        <div>
          <div className="sec-title disp">Reconciliation Workspace</div>
          <div className="sec-sub">{customerId} · {data.soa_filename} · Format: {data.soa_format}
            {data.recon_sent_to_customer_at && <span style={{ color: 'var(--green)', marginLeft: 8 }}>· ✓ Sent to customer {fmtDate(data.recon_sent_to_customer_at)}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary btn-sm" onClick={onBack}>← Dashboard</button>
          <a className="btn btn-secondary btn-sm" href={api.soaDownloadUrl(customerId)} download>⬇ Download SOA</a>
          <button className="btn btn-secondary btn-sm" onClick={exportExcel} disabled={exporting}>{exporting ? '…' : '📊 Export Excel'}</button>
          <button className="btn btn-secondary btn-sm" onClick={saveNotes} disabled={saving}>💾 Save Notes</button>
          <button className="btn btn-primary btn-sm" onClick={sendToCustomer} disabled={sending}>{sending ? '…' : '📤 Send to Customer'}</button>
          <button className="btn btn-green" onClick={markComplete} disabled={saving}>✓ Mark Complete</button>
        </div>
      </div>

      {/* Summary banner with match-rate ring */}
      <div style={{ background: '#1E1E2E', borderRadius: 12, padding: '18px 22px', marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{
            width: 56, height: 56, borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 14, color: '#fff',
            background: `conic-gradient(${matchRate >= 80 ? '#6EE7B7' : matchRate >= 50 ? '#FCD34D' : '#FCA5A5'} ${matchRate * 3.6}deg, #ffffff20 0deg)`,
          }}>
            <div style={{ width: 42, height: 42, borderRadius: '50%', background: '#1E1E2E', display: 'grid', placeItems: 'center' }}>{matchRate}%</div>
          </div>
          <div>
            <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 18, fontWeight: 700, color: '#fff' }}>{data.customer_name || customerId}</div>
            <div style={{ fontSize: 10, color: '#ffffff50', marginTop: 2 }}>SAP Lines: {sap_lines?.length} · Customer Lines: {customer_lines?.length} · Match Rate: {matchRate}%</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 20 }}>
          {[
            { l: 'SAP Balance',   v: fmtINR(summary.total_sap_balance),  c: '#fff' },
            { l: 'Cust. Balance', v: fmtINR(summary.total_cust_balance),  c: '#6EE7B7' },
            { l: 'Difference',    v: fmtINR(summary.net_difference),      c: summary.net_difference === 0 ? '#6EE7B7' : '#FCA5A5' },
          ].map(({ l, v, c }) => (
            <div key={l} style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.07em', color: '#ffffff40', marginBottom: 2 }}>{l}</div>
              <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 14, fontWeight: 600, color: c }}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {[['ALL', `All (${results.length})`], ...Object.entries(MATCH_CONFIG).map(([k, cfg]) => [k, `${cfg.label} (${results.filter(r => r.match_type === k).length})`])].map(([val, label]) => (
          <button key={val} onClick={() => setFilter(val)} className={`btn btn-sm ${filter === val ? 'btn-primary' : 'btn-secondary'}`}>{label}</button>
        ))}
        <input className="inp" style={{ maxWidth: 220, marginLeft: 'auto', padding: '6px 10px', fontSize: 12 }}
          placeholder="Search doc number…" value={q} onChange={e => setQ(e.target.value)} />
      </div>

      <div className="recon-grid">
        <div className="recon-panel">
          <div className="rp-hd rp-sap">📘 SAP Ledger — Open Items ({sap_lines?.length})</div>
          {sap_lines?.map((l, i) => {
            const match = results.find(r => r.sap_doc === l.document_number);
            const mt    = match?.match_type || 'MISSING_IN_CUSTOMER';
            const cfg   = MATCH_CONFIG[mt] || {};
            return (
              <div key={i} className={`re-row ${cfg.cls || ''}`}>
                <div><div className="re-doc">{l.document_number}</div><div className="re-date">{l.document_type} · {fmtDate(l.document_date)}</div></div>
                <span className="re-amt" style={{ color: l.amount < 0 ? 'var(--diff)' : 'var(--blue)' }}>{fmtINR(l.amount)}</span>
                <span className={`re-tag ${cfg.tagCls || 'rt-miss'}`}>{cfg.label?.split(' ').slice(1).join(' ') || 'No Match'}</span>
              </div>
            );
          })}
        </div>
        <div className="recon-panel">
          <div className="rp-hd rp-cust">📗 Customer SOA — Extracted ({customer_lines?.length})</div>
          {customer_lines?.map((l, i) => {
            const match = results.find(r => r.cust_doc === l.doc_number);
            const mt    = match?.match_type || 'NOT_IN_SAP';
            const cfg   = MATCH_CONFIG[mt] || {};
            return (
              <div key={i} className={`re-row ${cfg.cls || 'hl-extra'}`}>
                <div><div className="re-doc">{l.doc_number}</div><div className="re-date">{l.doc_type} · {fmtDate(l.doc_date)}</div></div>
                <span className="re-amt" style={{ color: l.amount < 0 ? 'var(--diff)' : 'var(--green)' }}>{fmtINR(l.amount)}</span>
                <span className={`re-tag ${cfg.tagCls || 'rt-extra'}`}>{cfg.label?.split(' ').slice(1).join(' ') || 'Extra'}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-hd">
          <div className="card-hd-l">
            <div className="card-ico" style={{ background: 'var(--amber-bg)' }}>⚖️</div>
            <div><div className="card-title">Match Results ({filtered.length})</div><div className="card-sub">Hierarchy: Exact → Normalised → Amount+Date</div></div>
          </div>
          <div style={{ display: 'flex', gap: 6, fontSize: 11 }}>
            {[
              { l: '✓ Matched', v: summary.matched, c: 'var(--green)' },
              { l: '≈ Diff', v: summary.matched_with_difference + summary.amount_date_match, c: 'var(--amber)' },
              { l: '✗ Missing', v: summary.missing_in_customer, c: 'var(--diff)' },
              { l: '+ Extra', v: summary.not_in_sap, c: 'var(--amber)' },
            ].map(({ l, v, c }) => <span key={l} style={{ color: c, fontWeight: 600 }}>{l}: <span className="mono">{v}</span></span>)}
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead><tr><th>Match Type</th><th>SAP Doc</th><th>SAP Amount</th><th>Customer Doc</th><th>Cust. Amount</th><th>Difference</th><th>SAP Date</th><th>Confidence</th><th>Root Cause</th></tr></thead>
            <tbody>
              {filtered.map((r, i) => {
                const cfg = MATCH_CONFIG[r.match_type] || {};
                const key = results.indexOf(r); // stable index into the full results array for root-cause persistence
                return (
                  <tr key={i}>
                    <td><span className={`re-tag ${cfg.tagCls || 'rt-miss'}`}>{cfg.label}</span></td>
                    <td><span className="td-mono" style={{ fontSize: 11 }}>{r.sap_doc || '—'}</span></td>
                    <td><span className="td-mono">{r.sap_amount != null ? fmtINR(r.sap_amount) : '—'}</span></td>
                    <td><span className="td-mono" style={{ fontSize: 11 }}>{r.cust_doc || '—'}</span></td>
                    <td><span className="td-mono">{r.cust_amount != null ? fmtINR(r.cust_amount) : '—'}</span></td>
                    <td>{r.amount_diff != null ? <span className="td-mono" style={{ color: r.amount_diff === 0 ? 'var(--green)' : 'var(--diff)', fontWeight: 700 }}>{r.amount_diff === 0 ? 'Nil' : fmtINR(r.amount_diff)}</span> : '—'}</td>
                    <td><span style={{ fontSize: 10, color: 'var(--muted)' }}>{fmtDate(r.sap_date)}</span></td>
                    <td><span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: r.confidence >= 90 ? 'var(--green)' : r.confidence >= 60 ? 'var(--amber)' : 'var(--diff)' }}>{r.confidence}%</span></td>
                    <td>
                      <select style={{ fontSize: 10, border: '1px solid var(--border)', borderRadius: 4, padding: '2px 4px', background: 'var(--white)' }}
                        value={rootCauses[key] || ''} onChange={e => setRootCause(key, e.target.value)}>
                        <option value="">— Tag cause</option>
                        {ROOT_CAUSES.map(rc => <option key={rc}>{rc}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-hd">
          <div className="card-hd-l">
            <div className="card-ico" style={{ background: 'var(--amber-bg)' }}>📝</div>
            <div><div className="card-title">Reconciliation Notes</div><div className="card-sub">Saved to confirmation record · included in the "Send to Customer" email</div></div>
          </div>
        </div>
        <div className="card-body">
          <textarea className="inp" value={notes} onChange={e => setNotes(e.target.value)}
            style={{ minHeight: 100, lineHeight: 1.6, resize: 'vertical', fontSize: 12 }}
            placeholder="Document reconciliation findings, agreed actions, expected resolution date…" />
        </div>
      </div>
    </div>
  );
}
