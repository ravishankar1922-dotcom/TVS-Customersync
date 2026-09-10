import React, { useState, useEffect, useCallback } from 'react';
import api from '../../services/api';
import { fmtINR, fmtDate, Spinner, useToast, Icon } from '../shared';

const MATCH_CONFIG = {
  MATCHED:                 { label: 'Matched',              icon: 'checkCircle', cls: 'hl-ok',      tagCls: 'rt-ok'  },
  MATCHED_WITH_DIFFERENCE: { label: 'Matched (Diff)',        icon: 'warning',     cls: 'hl-diff',    tagCls: 'rt-diff'},
  AMOUNT_DATE_MATCH:       { label: 'Approx Match',          icon: 'warning',     cls: 'hl-diff',    tagCls: 'rt-diff'},
  MISSING_IN_CUSTOMER:     { label: 'Missing in Customer',   icon: 'xCircle',     cls: 'hl-missing', tagCls: 'rt-miss'},
  NOT_IN_SAP:              { label: 'Not in SAP',            icon: 'info',        cls: 'hl-extra',   tagCls: 'rt-extra'},
};
const ROOT_CAUSES = ['Invoice in Transit', 'Credit Note Pending', 'Payment Timing', 'Disputed', 'Data Entry Error', 'Resolved', 'Other'];

export default function Reconciliation({ lotId, customerId, onBack }) {
  const toast = useToast();
  // Reconciliation Studio is Lot-scoped (Sept 2026: "migrate as per lot") —
  // every reconciliation now belongs to exactly one {lot_id, customer_id}
  // pair, matching the Lot-scoped ledger/SOA data the rest of the app
  // works with. `lotId`/`customerId` let a caller that already knows both
  // (e.g. a "Reconcile" row action in Lot Overview) open directly; pickedLot/
  // pickedId are what the screen actually uses, and default to null so the
  // Lot -> customer picker below shows when reached from the nav directly.
  const [pickedLot, setPickedLot]   = useState(lotId || null);
  const [pickedId, setPickedId]     = useState(customerId || null);
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes]     = useState('');
  const [saving, setSaving]   = useState(false);
  const [sending, setSending] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [rootCauses, setRootCauses] = useState({});
  const [filter, setFilter]   = useState('ALL');
  const [q, setQ]             = useState('');
  const [showDetail, setShowDetail] = useState(false); // Bridge statement is the default view; detail grid is one click away

  useEffect(() => { if (lotId) setPickedLot(lotId); }, [lotId]);
  useEffect(() => { if (customerId) setPickedId(customerId); }, [customerId]);

  function choosePair(lot, cust) { setPickedLot(lot); setPickedId(cust); }
  function reset() { setPickedLot(null); setPickedId(null); }

  const load = useCallback(async () => {
    if (!pickedLot || !pickedId) return;
    setLoading(true);
    try {
      const r = await api.lotReconcile(pickedLot, pickedId);
      setData(r);
      setNotes(r.recon_notes || '');
      setRootCauses(r.root_causes || {});
    } catch (e) { toast(e.message, 'err'); }
    finally { setLoading(false); }
  }, [pickedLot, pickedId, toast]);

  useEffect(() => { load(); }, [load]);

  function setRootCause(idx, val) {
    const next = { ...rootCauses, [idx]: val };
    setRootCauses(next);
    // Persist immediately so tags survive refresh / being opened by another admin.
    api.updateLotRecon(pickedLot, pickedId, { root_causes: next, recon_status: 'IN_PROGRESS' }).catch(e => toast(e.message, 'err'));
  }

  async function saveNotes() {
    setSaving(true);
    try { await api.updateLotRecon(pickedLot, pickedId, { recon_notes: notes, recon_status: 'IN_PROGRESS' }); toast('Notes saved.', 'success'); }
    catch (e) { toast(e.message, 'err'); }
    finally { setSaving(false); }
  }

  async function markComplete() {
    setSaving(true);
    try { await api.updateLotRecon(pickedLot, pickedId, { recon_notes: notes, recon_status: 'COMPLETED' }); toast('Reconciliation marked complete.', 'success'); load(); }
    catch (e) { toast(e.message, 'err'); }
    finally { setSaving(false); }
  }

  async function exportExcel() {
    setExporting(true);
    try {
      const blob = await api.lotReconExportBlob(pickedLot, pickedId);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `Reconciliation_${pickedId}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) { toast(e.message, 'err'); }
    finally { setExporting(false); }
  }

  async function sendToCustomer() {
    if (!window.confirm('Email the reconciliation summary + Excel workbook to this customer now?')) return;
    setSending(true);
    try {
      const r = await api.sendLotReconToCustomer(pickedLot, pickedId);
      toast(`Sent to ${r.sent_to}`, 'success');
      load();
    } catch (e) { toast(e.message, 'err'); }
    finally { setSending(false); }
  }

  if (!pickedLot || !pickedId) return <CustomerPicker onPick={choosePair} onBack={onBack} initialLotId={pickedLot} />;

  if (loading) return <Spinner full />;
  if (!data) return (
    <div className="info-box ib-red">
      Failed to load reconciliation data for {pickedId}.
      <div style={{ marginTop: 8 }}><button className="btn btn-secondary btn-sm" onClick={reset}><Icon name="back" size={13} /> Choose a different customer</button></div>
    </div>
  );

  const { summary, results, sap_lines, customer_lines, bridge } = data;
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
          <div className="sec-title disp">Reconciliation Studio</div>
          <div className="sec-sub">{data.lot_number || pickedLot} · {pickedId} · {data.soa_filename} · Format: {data.soa_format}
            {data.recon_sent_to_customer_at && <span style={{ color: 'var(--green)', marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 3 }}>· <Icon name="checkCircle" size={11} /> Sent to customer {fmtDate(data.recon_sent_to_customer_at)}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary btn-sm" onClick={reset}><Icon name="back" size={13} /> Choose Another Customer</button>
          <a className="btn btn-secondary btn-sm" href={api.lotConfirmationVersionSoaUrl(pickedLot, pickedId, data.current_version)} download><Icon name="download" size={13} /> Download SOA</a>
          <button className="btn btn-secondary btn-sm" onClick={exportExcel} disabled={exporting}>{exporting ? '…' : <><Icon name="excel" size={13} /> Export Excel</>}</button>
          <button className="btn btn-secondary btn-sm" onClick={saveNotes} disabled={saving}><Icon name="note" size={13} /> Save Notes</button>
          <button className="btn btn-primary btn-sm" onClick={sendToCustomer} disabled={sending}>{sending ? '…' : <><Icon name="sendMail" size={13} /> Send to Customer</>}</button>
          <button className="btn btn-green" onClick={markComplete} disabled={saving}><Icon name="checkCircle" size={13} /> Mark Complete</button>
        </div>
      </div>

      {/* Customer identity + match-rate banner */}
      <div style={{ background: 'linear-gradient(135deg,#1E1E2E 0%,#14213D 100%)', borderRadius: 12, padding: '18px 22px', marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{
            width: 56, height: 56, borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 14, color: '#fff',
            background: `conic-gradient(${matchRate >= 80 ? '#6EE7B7' : matchRate >= 50 ? '#FCD34D' : '#FCA5A5'} ${matchRate * 3.6}deg, #ffffff20 0deg)`,
          }}>
            <div style={{ width: 42, height: 42, borderRadius: '50%', background: '#1E1E2E', display: 'grid', placeItems: 'center' }}>{matchRate}%</div>
          </div>
          <div>
            <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 18, fontWeight: 700, color: '#fff' }}>{data.customer_name || pickedId}</div>
            <div style={{ fontSize: 10, color: '#ffffff50', marginTop: 2 }}>SAP Lines: {sap_lines?.length} · Customer Lines: {customer_lines?.length} · Match Rate: {matchRate}%</div>
          </div>
        </div>
        {bridge && (
          <span className={`cert-badge ${bridge.is_tied_out ? 'cert-ok' : 'cert-warn'}`}>
            <Icon name={bridge.is_tied_out ? 'checkCircle' : 'warning'} size={13} />
            {bridge.is_tied_out ? 'Fully Reconciled' : 'Unreconciled Difference'}
          </span>
        )}
      </div>

      {/* Bridge statement — the default reconciliation view (opening balance →
          reconciling items → adjusted balance), matching the ALLFINE-style
          statement format. The detailed line-item grid is one click away. */}
      {bridge && !showDetail && (
        <>
          <div className="bridge-stat-strip">
            <div className="bridge-stat">
              <div className="bridge-stat-lbl">SAP Balance</div>
              <div className="bridge-stat-val" style={{ color: 'var(--ink)' }}>{fmtINR(bridge.opening_sap_balance)}</div>
            </div>
            <div className="bridge-stat">
              <div className="bridge-stat-lbl">Customer Balance</div>
              <div className="bridge-stat-val" style={{ color: 'var(--blue)' }}>{fmtINR(bridge.opening_customer_balance)}</div>
            </div>
            <div className="bridge-stat">
              <div className="bridge-stat-lbl">Adjusted SAP Balance</div>
              <div className="bridge-stat-val" style={{ color: 'var(--ink)' }}>{fmtINR(bridge.adjusted_sap_balance)}</div>
            </div>
            <div className="bridge-stat">
              <div className="bridge-stat-lbl">{bridge.is_tied_out ? 'Difference' : 'Unreconciled'}</div>
              <div className="bridge-stat-val" style={{ color: bridge.is_tied_out ? 'var(--green)' : 'var(--diff)' }}>{fmtINR(bridge.difference)}</div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-hd">
              <div className="card-hd-l">
                <div className="card-ico" style={{ background: 'var(--amber-bg)' }}><Icon name="bridge" size={17} /></div>
                <div><div className="card-title">Balance Reconciliation Statement</div><div className="card-sub">SAP balance bridged to customer balance via reconciling items</div></div>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowDetail(true)}><Icon name="detail" size={13} /> View Detailed Line Items <Icon name="arrow" size={13} /></button>
            </div>
            <div className="card-body">
              <div style={{ overflowX: 'auto', maxHeight: 460, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                <table className="tbl bridge-tbl">
                  <thead><tr><th>S.No</th><th>Document No</th><th>Date</th><th>Particulars / Reconciling Item</th><th>Debit (₹)</th><th>Credit (₹)</th><th>Remarks</th></tr></thead>
                  <tbody>
                    {bridge.items.length === 0 && (
                      <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--green)', fontWeight: 600, padding: 24 }}><Icon name="checkCircle" size={16} style={{ marginRight: 6 }} />No reconciling items — SAP and customer balances match fully.</td></tr>
                    )}
                    {bridge.items.map(it => (
                      <tr key={it.s_no}>
                        <td>{it.s_no}</td>
                        <td><span className="td-mono" style={{ fontSize: 11 }}>{it.doc_number || '—'}</span></td>
                        <td><span style={{ fontSize: 10, color: 'var(--muted)' }}>{fmtDate(it.doc_date)}</span></td>
                        <td style={{ fontSize: 12 }}>{it.particulars}</td>
                        <td><span className="td-mono">{it.debit ? fmtINR(it.debit) : ''}</span></td>
                        <td><span className="td-mono">{it.credit ? fmtINR(it.credit) : ''}</span></td>
                        <td style={{ fontSize: 11, color: 'var(--muted)' }}>{it.remark}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)', background: 'var(--surf2)' }}>
                      <td colSpan={4}>Total Reconciling Items</td>
                      <td className="td-mono">{fmtINR(bridge.total_debit)}</td>
                      <td className="td-mono">{fmtINR(bridge.total_credit)}</td>
                      <td></td>
                    </tr>
                    <tr style={{ fontWeight: 700, background: 'var(--surf2)' }}>
                      <td colSpan={3}>Adjusted SAP Balance</td>
                      <td colSpan={2} className="td-mono">{fmtINR(bridge.adjusted_sap_balance)}</td>
                      <td colSpan={2}></td>
                    </tr>
                    <tr style={{ fontWeight: 700, background: 'var(--surf2)' }}>
                      <td colSpan={3} style={{ color: bridge.is_tied_out ? 'var(--green)' : 'var(--diff)' }}>{bridge.is_tied_out ? 'Difference (Reconciled)' : 'Unreconciled Difference'}</td>
                      <td colSpan={2} className="td-mono" style={{ color: bridge.is_tied_out ? 'var(--green)' : 'var(--diff)' }}>{fmtINR(bridge.difference)}</td>
                      <td colSpan={2}></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </div>

        </>
      )}

      {showDetail && (
      <>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-secondary btn-sm" onClick={() => setShowDetail(false)}><Icon name="back" size={13} /> Back to Bridge Statement</button>
        {[['ALL', `All (${results.length})`], ...Object.entries(MATCH_CONFIG).map(([k, cfg]) => [k, `${cfg.label} (${results.filter(r => r.match_type === k).length})`])].map(([val, label]) => (
          <button key={val} onClick={() => setFilter(val)} className={`btn btn-sm ${filter === val ? 'btn-primary' : 'btn-secondary'}`}>{label}</button>
        ))}
        <input className="inp" style={{ maxWidth: 220, marginLeft: 'auto', padding: '6px 10px', fontSize: 12 }}
          placeholder="Search doc number…" value={q} onChange={e => setQ(e.target.value)} />
      </div>

      <div className="recon-grid">
        <div className="recon-panel">
          <div className="rp-hd rp-sap"><Icon name="book" size={14} /> SAP Ledger — Open Items ({sap_lines?.length})</div>
          {sap_lines?.map((l, i) => {
            const match = results.find(r => r.sap_doc === l.document_number);
            const mt    = match?.match_type || 'MISSING_IN_CUSTOMER';
            const cfg   = MATCH_CONFIG[mt] || {};
            return (
              <div key={i} className={`re-row ${cfg.cls || ''}`}>
                <div><div className="re-doc">{l.document_number}</div><div className="re-date">{l.document_type} · {fmtDate(l.document_date)}</div></div>
                <span className="re-amt" style={{ color: l.amount < 0 ? 'var(--diff)' : 'var(--blue)' }}>{fmtINR(l.amount)}</span>
                <span className={`re-tag ${cfg.tagCls || 'rt-miss'}`}>{cfg.icon && <Icon name={cfg.icon} size={10} />} {cfg.label || 'No Match'}</span>
              </div>
            );
          })}
        </div>
        <div className="recon-panel">
          <div className="rp-hd rp-cust"><Icon name="folder" size={14} /> Customer SOA — Extracted ({customer_lines?.length})</div>
          {customer_lines?.map((l, i) => {
            const match = results.find(r => r.cust_doc === l.doc_number);
            const mt    = match?.match_type || 'NOT_IN_SAP';
            const cfg   = MATCH_CONFIG[mt] || {};
            return (
              <div key={i} className={`re-row ${cfg.cls || 'hl-extra'}`}>
                <div><div className="re-doc">{l.doc_number}</div><div className="re-date">{l.doc_type} · {fmtDate(l.doc_date)}</div></div>
                <span className="re-amt" style={{ color: l.amount < 0 ? 'var(--diff)' : 'var(--green)' }}>{fmtINR(l.amount)}</span>
                <span className={`re-tag ${cfg.tagCls || 'rt-extra'}`}>{cfg.icon && <Icon name={cfg.icon} size={10} />} {cfg.label || 'Extra'}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-hd">
          <div className="card-hd-l">
            <div className="card-ico" style={{ background: 'var(--amber-bg)' }}><Icon name="scale" size={17} /></div>
            <div><div className="card-title">Match Results ({filtered.length})</div><div className="card-sub">Hierarchy: Exact → Normalised → Amount+Date</div></div>
          </div>
          <div style={{ display: 'flex', gap: 10, fontSize: 11 }}>
            {[
              { l: 'Matched', v: summary.matched, c: 'var(--green)' },
              { l: 'Diff', v: summary.matched_with_difference + summary.amount_date_match, c: 'var(--amber)' },
              { l: 'Missing', v: summary.missing_in_customer, c: 'var(--diff)' },
              { l: 'Extra', v: summary.not_in_sap, c: 'var(--amber)' },
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
                    <td><span className={`re-tag ${cfg.tagCls || 'rt-miss'}`}>{cfg.icon && <Icon name={cfg.icon} size={10} />} {cfg.label}</span></td>
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
      </>
      )}

      <div className="card">
        <div className="card-hd">
          <div className="card-hd-l">
            <div className="card-ico" style={{ background: 'var(--amber-bg)' }}><Icon name="note" size={17} /></div>
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

// ── Lot -> Customer picker — Reconciliation Studio's own entry point ────
// Reconciliation is now Lot-scoped (Sept 2026 migration), so opening it
// without a {lotId, customerId} already in hand (e.g. from the nav
// directly, with no Lot pre-chosen) means picking a Lot first, then a
// customer within it — mirroring the "Lot list -> expand -> customer list"
// hierarchy Lot Overview already uses. `initialLotId` lets a caller that
// knows the Lot but not yet the customer (e.g. Lot Overview's own picker
// state) skip straight to step two.
function CustomerPicker({ onPick, onBack, initialLotId }) {
  const toast = useToast();
  const [lots, setLots] = useState(null);
  const [lotId, setLotId] = useState(initialLotId || null);

  useEffect(() => {
    api.lots().then(d => setLots(d.lots || [])).catch(e => toast(e.message, 'err'));
  }, [toast]);

  if (!lots) return <Spinner full />;

  if (!lotId) {
    return (
      <div>
        <div className="sec-hd">
          <div>
            <div className="sec-title disp">Reconciliation Studio</div>
            <div className="sec-sub">Pick a Lot to open its customers for line-item reconciliation.</div>
          </div>
          {onBack && <button className="btn btn-secondary btn-sm" onClick={onBack}><Icon name="back" size={13} /> Back</button>}
        </div>
        {lots.length === 0 ? (
          <div className="info-box ib-blue"><strong><Icon name="info" size={13} /> No Lots yet</strong> Create a Lot and upload its ledger in Overview first.</div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Lot</th><th>Period</th><th>Type</th><th>Population</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {lots.map(l => (
                  <tr key={l._id} style={{ cursor: 'pointer' }} onClick={() => setLotId(l._id)}>
                    <td><span className="td-mono">{l.lot_number}</span></td>
                    <td>{l.period_label}</td>
                    <td>{l.business_type}</td>
                    <td>{l.population_count ?? '—'}</td>
                    <td>{l.status}</td>
                    <td><button className="act-btn" title="Open"><Icon name="arrow" size={14} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  return <CustomerPickerForLot lotId={lotId} onPick={custId => onPick(lotId, custId)} onBack={() => setLotId(null)} />;
}

// Step two: pick a customer within the chosen Lot. Defaults to showing only
// customers with an SOA on file, since those are the only ones reconciliation
// can actually run for; "Show all" reveals the rest so nothing is hidden.
function CustomerPickerForLot({ lotId, onPick, onBack }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    api.lotConfirmations(lotId).then(d => setRows(d.rows || [])).catch(e => toast(e.message, 'err'));
  }, [lotId, toast]);

  if (!rows) return <Spinner full />;

  let list = showAll ? rows : rows.filter(r => r.confirmation?.soa_filename);
  if (q.trim()) {
    const needle = q.trim().toLowerCase();
    list = list.filter(r => r.customer_id.toLowerCase().includes(needle) || (r.customer_name || '').toLowerCase().includes(needle));
  }

  return (
    <div>
      <div className="sec-hd">
        <div>
          <div className="sec-title disp">Reconciliation Studio</div>
          <div className="sec-sub">Pick a customer with an SOA on file to open their line-item reconciliation.</div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={onBack}><Icon name="back" size={13} /> Choose Another Lot</button>
      </div>

      <div className="filter-bar">
        <div className="srch-wrap">
          <span className="srch-ico"><Icon name="search" size={14} /></span>
          <input className="inp srch-inp" placeholder="Search customer name or ID…" value={q} onChange={e => setQ(e.target.value)} autoFocus />
        </div>
        <button className={`btn btn-sm ${showAll ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setShowAll(s => !s)}>
          {showAll ? 'Showing All Customers' : 'Only With SOA Uploaded'}
        </button>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{list.length} of {rows.length}</span>
      </div>

      {list.length === 0 ? (
        <div className="info-box ib-blue">
          <strong><Icon name="info" size={13} /> No customers to show</strong>
          {showAll ? 'No customers match your search.' : 'No customer in this Lot has an SOA uploaded yet — toggle "Showing All Customers" to browse everyone, or wait for a customer to submit their confirmation.'}
        </div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Customer</th><th>Opening Balance</th><th>Cust. Balance</th><th>Difference</th><th>Status</th><th>SOA</th><th></th></tr></thead>
            <tbody>
              {list.map(r => {
                const c = r.confirmation;
                return (
                  <tr key={r.customer_id} style={{ cursor: 'pointer' }} onClick={() => onPick(r.customer_id)}>
                    <td><div className="td-prim">{r.customer_name}</div><div className="td-sub mono">{r.customer_id}</div></td>
                    <td><span className="td-mono">{fmtINR(r.opening_balance)}</span></td>
                    <td><span className="td-mono">{c?.cust_balance != null ? fmtINR(c.cust_balance) : <span style={{ color: 'var(--muted-lt)' }}>—</span>}</span></td>
                    <td><span className="td-mono">{c?.difference != null ? (c.difference === 0 ? '✓ Nil' : fmtINR(c.difference)) : '—'}</span></td>
                    <td>{c?.status || 'PENDING'}</td>
                    <td>{c?.soa_filename ? <Icon name="excel" size={14} /> : <span style={{ color: 'var(--muted-lt)', fontSize: 10 }}>—</span>}</td>
                    <td><button className="act-btn" title="Open"><Icon name="arrow" size={14} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
