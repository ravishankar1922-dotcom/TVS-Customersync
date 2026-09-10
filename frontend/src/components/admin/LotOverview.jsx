/**
 * Lot Overview (architecture overhaul, phase 3 — see
 * BalanceSync_Lot_Architecture_Plan.md). Makes the Lot the PRIMARY
 * navigation hierarchy: Lot list -> expand -> Customer list -> drill into
 * one customer's confirmation, submission-version history and comments.
 *
 * SCOPE NOTE: this is additive, alongside the existing "Overview" (Dashboard)
 * screen and its legacy cfg.CYCLE_ID-scoped flow — nothing there changed.
 * This screen is the front-end for the phase 1/2 Lot-scoped API
 * (routes/lots.js): Lot creation, Lot-scoped ledger upload, balance-filtered
 * + targeted-select confirmation sending, and the reopenable/versioned
 * customer-portal submissions. Every period/label shown here comes from
 * Lot.period_label — never a hardcoded month.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../../services/api';
import { fmtINR, fmtDate, statusBadge, Modal, Spinner, useToast, Icon } from '../shared';

const FILTER_OPS = [
  { v: '', label: 'No filter — everyone' },
  { v: 'gt', label: 'Balance >' },
  { v: 'gte', label: 'Balance ≥' },
  { v: 'lt', label: 'Balance <' },
  { v: 'lte', label: 'Balance ≤' },
  { v: 'eq', label: 'Balance =' },
  { v: 'between', label: 'Balance between' },
  { v: 'zero', label: 'Zero balance' },
  { v: 'negative', label: 'Negative balance' },
  { v: 'positive', label: 'Positive balance' },
];

// businessType: 'CUSTOMER' | 'VENDOR' — this screen is now the full Overview
// for one module (item 1: two fully separate modules, item 11: the Lot list
// lives here instead of its own nav tab). KPI cards default to the total
// across every Lot in this module; expanding one Lot switches them to that
// Lot's own numbers (item 2).
export default function LotOverview({ businessType = 'CUSTOMER', onReconcile }) {
  const toast = useToast();
  const [lots, setLots] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [masterOpen, setMasterOpen] = useState(false);
  const [summary, setSummary] = useState(null);

  const loadLots = useCallback(async () => {
    try { setLots(((await api.lots()).lots || []).filter(l => l.business_type === businessType)); }
    catch (e) { toast(e.message, 'err'); }
  }, [toast, businessType]);

  const loadSummary = useCallback(async () => {
    try { setSummary(await api.lotsSummary(expandedId ? { lot_id: expandedId } : { business_type: businessType })); }
    catch (e) { toast(e.message, 'err'); }
  }, [toast, businessType, expandedId]);

  useEffect(() => { loadLots(); }, [loadLots]);
  useEffect(() => { loadSummary(); }, [loadSummary]);

  const noun = businessType === 'VENDOR' ? 'Vendor' : 'Customer';
  const expandedLot = lots?.find(l => l._id === expandedId);

  function refreshAll() { loadLots(); loadSummary(); }

  const kpis = summary ? [
    { label: expandedLot ? `${noun}s in this Lot` : `Total ${noun}s`, val: summary.total_population, cls: 'kpi-ink' },
    { label: 'Submitted', val: summary.submitted, cls: 'kpi-blue' },
    { label: 'Matched', val: summary.matched, cls: 'kpi-green' },
    { label: 'Difference', val: summary.difference, cls: 'kpi-red' },
    { label: 'Pending', val: summary.pending, cls: 'kpi-amber' },
    { label: 'Recon Done', val: summary.recon_completed, cls: 'kpi-grey' },
    { label: 'Total Balance', val: fmtINR(summary.total_balance), cls: 'kpi-ink', isText: true },
    { label: 'Total Variance', val: fmtINR(summary.total_variance), cls: 'kpi-red', isText: true },
  ] : [];

  return (
    <div>
      <div className="sec-hd">
        <div>
          <div className="sec-title disp">{noun} Overview</div>
          <div className="sec-sub">
            {expandedLot
              ? `Showing ${expandedLot.lot_number} (${expandedLot.period_label}) only — collapse it to see totals across every ${noun.toLowerCase()} Lot.`
              : `Totals across every ${noun.toLowerCase()} Lot. Every fresh ledger/period upload is its own Lot — isolated confirmations, SOAs, reconciliation and history, never merged.`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={refreshAll}><Icon name="refresh" size={13} /> Refresh</button>
          <button className="btn btn-secondary btn-sm" onClick={() => setMasterOpen(true)} title={`Upload/refresh the ${noun.toLowerCase()} master list (Excel/CSV/JSON) — separate from Lot ledger uploads`}>
            <Icon name="upload" size={13} /> {noun} Master
          </button>
          <button className="btn btn-primary" onClick={() => setCreateOpen(true)}><Icon name="folder" size={13} /> Create New Lot</button>
        </div>
      </div>

      {summary && (
        <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 18 }}>
          {kpis.map(k => (
            <div key={k.label} className={`kpi ${k.cls}`}>
              <div className="kpi-lbl">{k.label}</div>
              <div className="kpi-val disp" style={k.isText ? { fontSize: 16 } : {}}>{k.val}</div>
            </div>
          ))}
        </div>
      )}

      {!lots ? <Spinner full /> : lots.length === 0 ? (
        <div className="info-box ib-blue">
          <strong><Icon name="info" size={13} /> No {noun} Lots yet</strong>
          Click "Create New Lot" to start — you'll be asked for a period first, then you upload that period's ledger to populate it.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {lots.map(lot => (
            <LotRow
              key={lot._id}
              lot={lot}
              expanded={expandedId === lot._id}
              onToggle={() => setExpandedId(expandedId === lot._id ? null : lot._id)}
              onChanged={refreshAll}
              onReconcile={onReconcile}
            />
          ))}
        </div>
      )}

      <CreateLotModal businessType={businessType} open={createOpen} onClose={() => setCreateOpen(false)} onCreated={lot => { setCreateOpen(false); refreshAll(); setExpandedId(lot._id); }} />
      <MasterImportModal businessType={businessType} open={masterOpen} onClose={() => setMasterOpen(false)} />
    </div>
  );
}

// ── Create Lot (period-first flow) ──────────────────────────────────────
function CreateLotModal({ businessType, open, onClose, onCreated }) {
  const toast = useToast();
  const [period, setPeriod] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!period.trim()) return toast('Enter a period, e.g. "March 2026" or "2026-03"', 'err');
    setBusy(true);
    try {
      const r = await api.createLot(period.trim(), businessType, remarks.trim());
      toast(`${r.lot.lot_number} created for ${r.lot.period_label}. Now upload that period's ledger to populate it.`, 'success', 5000);
      setPeriod(''); setRemarks('');
      onCreated(r.lot);
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Create New ${businessType === 'VENDOR' ? 'Vendor' : 'Customer'} Lot`} sub="Step 1: tell us the period — the Lot number is generated for you">
      <form onSubmit={submit}>
        <div className="field">
          <label className="lbl">Period</label>
          <input className="inp" placeholder='e.g. "March 2026" or "2026-03"' value={period} onChange={e => setPeriod(e.target.value)} autoFocus />
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>A repeat Lot for the same period gets the next sequence number automatically (e.g. LOT-2026-03-002).</div>
        </div>
        <div className="field">
          <label className="lbl">Remarks <span style={{ fontWeight: 400, color: 'var(--muted)', textTransform: 'none' }}>(optional)</span></label>
          <input className="inp" placeholder='e.g. "Re-run — corrected opening balances"' value={remarks} onChange={e => setRemarks(e.target.value)} maxLength={500} />
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>A free-text reference to help you identify this Lot later. Editable any time from the Lot's row.</div>
        </div>
        <button type="submit" className="btn btn-primary btn-full" disabled={busy}>{busy ? <><Spinner /> Creating…</> : 'Create Lot'}</button>
      </form>
    </Modal>
  );
}

// ── Customer/Vendor MASTER upload (Sept 2026: "Where is the provision to
// upload customer master?") ────────────────────────────────────────────
// This is deliberately separate from a Lot's ledger upload: the master list
// (customer_id/vendor_id, name, email, PAN) is who CAN appear in a Lot and
// what the portal's PAN second-factor checks against; a Lot's ledger upload
// only decides who actually appears in that one Lot's population. Accepts
// Excel/CSV or JSON, with a dry-run preview (matched vs. brand-new records)
// before committing, same pattern as ledger upload's staging step.
function MasterImportModal({ businessType, open, onClose }) {
  const toast = useToast();
  const noun = businessType === 'VENDOR' ? 'Vendor' : 'Customer';
  const [file, setFile] = useState(null);
  const [mode, setMode] = useState('replace');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) { setFile(null); setPreview(null); setMode('replace'); } }, [open]);

  const importFn = businessType === 'VENDOR' ? api.importVendorMasterFile : api.importCustomerMasterFile;

  async function runPreview() {
    if (!file) return toast('Choose a file first.', 'err');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('master_file', file);
      fd.append('mode', mode);
      fd.append('dryRun', 'true');
      setPreview(await importFn(fd));
    } catch (e) { toast(e.message, 'err'); setPreview(null); }
    finally { setBusy(false); }
  }

  async function confirmImport() {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('master_file', file);
      fd.append('mode', mode);
      const r = await importFn(fd);
      toast(`${noun} master updated — ${r.upserted ?? r.would_upsert ?? 0} record(s) upserted${r.skipped ? `, ${r.skipped} skipped` : ''}.`, 'success', 5000);
      setFile(null); setPreview(null);
      onClose();
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={`${noun} Master`} sub={`Upload/refresh the ${noun.toLowerCase()} list this app checks Lots and portal logins against — Excel, CSV or JSON`}>
      <div className="field">
        <label className="lbl">File</label>
        <input type="file" accept=".xlsx,.xls,.csv,.json" onChange={e => { setFile(e.target.files[0] || null); setPreview(null); }} />
        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>
          Column headers are matched flexibly (e.g. "Customer Code", "PAN Number" all work) — no need to rename them to match exactly.
          Required: {noun.toLowerCase()} ID, name, PAN.
        </div>
      </div>
      <div className="field">
        <label className="lbl">Mode</label>
        <select className="inp" value={mode} onChange={e => { setMode(e.target.value); setPreview(null); }}>
          <option value="replace">Replace — overwrite matched {noun.toLowerCase()}s with the uploaded data</option>
          <option value="append">Append — only add {noun.toLowerCase()}s not already on file; leave existing ones untouched</option>
        </select>
      </div>

      {preview && (
        <div className="info-box ib-blue" style={{ marginBottom: 14 }}>
          <strong><Icon name="info" size={13} /> Preview</strong>
          {preview.dryRun
            ? `${preview.total ?? preview.would_upsert} row(s) in this file — ${preview.matched ?? 0} match existing ${noun.toLowerCase()}s, ${preview.new ?? (preview.would_upsert || 0)} are new.`
            : 'Ready to import.'}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-secondary btn-full" onClick={runPreview} disabled={busy || !file}>{busy ? <Spinner /> : 'Preview'}</button>
        <button className="btn btn-primary btn-full" onClick={confirmImport} disabled={busy || !file || !preview}>{busy ? <><Spinner /> Importing…</> : 'Confirm Import'}</button>
      </div>
    </Modal>
  );
}

// ── One Lot row, expandable to its full detail ──────────────────────────
function LotRow({ lot, expanded, onToggle, onChanged, onReconcile }) {
  const toast = useToast();
  const [remarksOpen, setRemarksOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const statusCls = { DRAFT: 'b-pend', ACTIVE: 'b-conf', CLOSED: 'b-grey' }[lot.status] || 'b-grey';

  async function deleteDraft(e) {
    e.stopPropagation();
    if (!window.confirm(`Delete draft Lot ${lot.lot_number}? This cannot be undone. Only possible while it's still DRAFT (no ledger uploaded yet).`)) return;
    setDeleting(true);
    try { await api.deleteLot(lot._id); toast(`${lot.lot_number} deleted.`, 'success'); onChanged(); }
    catch (e) { toast(e.message, 'err'); }
    finally { setDeleting(false); }
  }

  return (
    <div className="card">
      <div className="card-body" style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px' }} onClick={onToggle}>
        <Icon name={expanded ? 'back' : 'arrow'} size={14} style={{ transform: expanded ? 'rotate(-90deg)' : 'rotate(90deg)', transition: 'transform .15s', flexShrink: 0, color: 'var(--muted)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontWeight: 700, fontSize: 13 }}>{lot.lot_number}</span>
            <span className={`badge ${statusCls}`}>{lot.status}</span>
            {lot.is_legacy && <span className="badge b-diff" title={lot.legacy_cycle_id ? `Inferred from legacy cycle_id: ${lot.legacy_cycle_id}` : 'Pre-Lot sample/test data, moved here automatically'}>LEGACY</span>}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{lot.period_label} · created by {lot.created_by || '—'}</div>
          {lot.remarks && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3, fontStyle: 'italic' }}>"{lot.remarks}"</div>}
        </div>
        <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--muted)' }}>
          <div>{lot.population_count} record{lot.population_count === 1 ? '' : 's'}</div>
          <div className="td-mono" style={{ fontSize: 12, color: 'var(--ink)', fontWeight: 600 }}>{fmtINR(lot.total_ledger_balance)}</div>
        </div>
        <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
          <button className="act-btn" title="Edit remarks" onClick={() => setRemarksOpen(true)}><Icon name="detail" size={14} /></button>
          {lot.status === 'DRAFT' && (
            <button className="act-btn" title="Delete this draft Lot" onClick={deleteDraft} disabled={deleting} style={{ color: 'var(--red, #C8102E)' }}>
              {deleting ? '…' : <Icon name="trash" size={14} />}
            </button>
          )}
        </div>
      </div>
      {expanded && <LotDetail lot={lot} onChanged={onChanged} onReconcile={onReconcile} />}
      <RemarksModal lot={lot} open={remarksOpen} onClose={() => setRemarksOpen(false)} onChanged={onChanged} />
    </div>
  );
}

// ── Edit remarks modal ───────────────────────────────────────────────────
function RemarksModal({ lot, open, onClose, onChanged }) {
  const toast = useToast();
  const [remarks, setRemarks] = useState(lot.remarks || '');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) setRemarks(lot.remarks || ''); }, [open, lot.remarks]);

  async function save() {
    setBusy(true);
    try { await api.updateLotRemarks(lot._id, remarks.trim()); toast('Remarks updated.', 'success'); onChanged(); onClose(); }
    catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Remarks — ${lot.lot_number}`} sub="A free-text reference to help identify this Lot later">
      <textarea className="inp" rows={3} maxLength={500} style={{ resize: 'vertical' }} value={remarks} onChange={e => setRemarks(e.target.value)} autoFocus />
      <button className="btn btn-primary btn-full" style={{ marginTop: 12 }} onClick={save} disabled={busy}>{busy ? <><Spinner /> Saving…</> : 'Save Remarks'}</button>
    </Modal>
  );
}

// ── Expanded Lot detail: ledger upload, targeted send, customer list ────
function LotDetail({ lot, onChanged, onReconcile }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [search, setSearch] = useState('');
  const [statusF, setStatusF] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [filterOp, setFilterOp] = useState('');
  const [filterVal, setFilterVal] = useState('');
  const [filterVal2, setFilterVal2] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [versionsFor, setVersionsFor] = useState(null);
  const [workflowFor, setWorkflowFor] = useState(null);

  const loadRows = useCallback(async () => {
    try { setRows((await api.lotConfirmations(lot._id)).rows || []); }
    catch (e) { toast(e.message, 'err'); }
  }, [lot._id, toast]);

  useEffect(() => { loadRows(); }, [loadRows]);

  async function uploadLedger(file) {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('ledger_file', file);
      const r = await api.uploadLotLedger(lot._id, fd);
      toast(`Ledger uploaded — ${r.population_count} customer(s) now in this Lot, total ${fmtINR(r.total_balance)}.`, 'success', 5000);
      loadRows();
      onChanged();
    } catch (e) { toast(e.message, 'err'); }
    finally { setUploading(false); }
  }

  async function sendConfirmations() {
    const balance_filter = filterOp ? { op: filterOp, value: filterVal, value2: filterVal2 } : undefined;
    const customer_ids = selected.size ? [...selected] : undefined;
    setSending(true);
    try {
      const r = await api.generateLotTokens(lot._id, { customer_ids, balance_filter, send_email: true });
      toast(
        r.smtp_configured
          ? `${r.generated} confirmation link(s) sent for ${lot.period_label}.`
          : `${r.generated} link(s) generated (SMTP not configured — see Email Log to copy them).`,
        'success', 5000
      );
      setSelected(new Set());
      loadRows();
    } catch (e) { toast(e.message, 'err'); }
    finally { setSending(false); }
  }

  // Item 4: mail trigger, download script, reset expiry, remind non-
  // responders — every one of these is scoped to THIS Lot only (being
  // inside its expanded detail row already is "picking the Lot"; nothing
  // here can ever touch another Lot's tokens/emails).
  const [resettingExpired, setResettingExpired] = useState(false);
  async function resetExpiredLinks() {
    setResettingExpired(true);
    try {
      const r = await api.resetLotExpiredTokens(lot._id);
      toast(r.reset > 0 ? `Cleared ${r.reset} expired link(s) in ${lot.lot_number}. Send confirmation links again to issue fresh ones.` : `No expired links in ${lot.lot_number} — everything is current.`, 'success');
      loadRows();
    } catch (e) { toast(e.message, 'err'); }
    finally { setResettingExpired(false); }
  }

  const [reminding, setReminding] = useState(false);
  async function remindPending() {
    setReminding(true);
    try {
      const r = await api.remindLotPending(lot._id);
      toast(r.total === 0 ? r.note : `Reminder sent to ${r.total} non-responder(s) in ${lot.lot_number}${r.smtp_configured ? '' : ' (SMTP not configured — links logged, see Email Log)'}`, 'success', 5000);
      loadRows();
    } catch (e) { toast(e.message, 'err'); }
    finally { setReminding(false); }
  }

  const filteredRows = useMemo(() => {
    let d = rows || [];
    if (search) {
      const s = search.toLowerCase();
      d = d.filter(r => (r.customer_name || '').toLowerCase().includes(s) || r.customer_id.toLowerCase().includes(s));
    }
    if (statusF) {
      d = d.filter(r => statusF === 'NOT_SUBMITTED' ? !r.confirmation : r.confirmation?.status === statusF);
    }
    return d;
  }, [rows, search, statusF]);

  function toggleAll(checked) {
    setSelected(checked ? new Set(filteredRows.map(r => r.customer_id)) : new Set());
  }
  function toggleOne(id, checked) {
    const n = new Set(selected);
    checked ? n.add(id) : n.delete(id);
    setSelected(n);
  }

  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: '16px', background: 'var(--panel-2, #fafafa)' }} onClick={e => e.stopPropagation()}>
      {lot.population_count === 0 ? (
        <div className="info-box ib-amber">
          <strong><Icon name="upload" size={13} /> This Lot has no population yet</strong>
          Upload this period's ledger below — only customers found in that file become this Lot's population (never the full Customer master).
          <div style={{ marginTop: 10 }}>
            <input type="file" accept=".xlsx,.xls,.csv,.json" disabled={uploading} onChange={e => uploadLedger(e.target.files[0])} />
            {uploading && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--muted)' }}><Spinner /> Uploading…</span>}
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end', marginBottom: 14, padding: 12, background: 'var(--card-bg, #fff)', border: '1px solid var(--border)', borderRadius: 8 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)', marginBottom: 6 }}>Balance Filter</div>
              <select className="flt-sel" value={filterOp} onChange={e => setFilterOp(e.target.value)}>
                {FILTER_OPS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
              </select>
            </div>
            {filterOp && !['zero', 'negative', 'positive'].includes(filterOp) && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 6 }}>{filterOp === 'between' ? 'From' : 'Value'}</div>
                  <input className="inp" type="number" style={{ width: 110 }} value={filterVal} onChange={e => setFilterVal(e.target.value)} />
                </div>
                {filterOp === 'between' && (
                  <div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 6 }}>To</div>
                    <input className="inp" type="number" style={{ width: 110 }} value={filterVal2} onChange={e => setFilterVal2(e.target.value)} />
                  </div>
                )}
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              {selected.size > 0 ? `${selected.size} selected — sending only to them` : filterOp ? 'Filter applies to everyone matching' : 'No filter/selection — sends to the whole Lot'}
            </div>
            <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={sendConfirmations} disabled={sending}>
              {sending ? <><Spinner /> Sending…</> : <><Icon name="sendMail" size={13} /> Send Confirmation Link(s)</>}
            </button>
            <label className="btn btn-secondary btn-sm" style={{ cursor: uploading ? 'default' : 'pointer' }}>
              <Icon name="upload" size={13} /> {uploading ? 'Uploading…' : 'Re-upload / Refresh Ledger'}
              <input type="file" accept=".xlsx,.xls,.csv,.json" style={{ display: 'none' }} disabled={uploading} onChange={e => uploadLedger(e.target.files[0])} />
            </label>
            <a href={api.lotOutlookScriptUrl(lot._id)} className="btn btn-secondary btn-sm" title="If cloud SMTP is blocked by your mail provider, download a script that drafts these emails (for this Lot only) in your own Desktop Outlook instead.">
              <Icon name="outlook" size={13} /> Download Outlook Script
            </a>
            <button className="btn btn-secondary btn-sm" onClick={resetExpiredLinks} disabled={resettingExpired} title="Clear every expired confirmation link in this Lot only. Then send confirmation links again to issue fresh ones.">
              {resettingExpired ? '…' : <><Icon name="reset" size={13} /> Reset Expired Links</>}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={remindPending} disabled={reminding} title="Send a reminder to everyone in this Lot who has not yet submitted a confirmation. Safe to run as often as you like.">
              {reminding ? <><Spinner /> Sending…</> : <><Icon name="mail" size={13} /> Remind Non-Responders</>}
            </button>
            <a href={api.lotConfirmationsExportUrl(lot._id)} className="btn btn-secondary btn-sm"><Icon name="excel" size={13} /> Export Excel</a>
          </div>

          <div className="filter-bar">
            <div className="srch-wrap">
              <span className="srch-ico"><Icon name="search" size={14} /></span>
              <input className="inp srch-inp" placeholder="Search customer name or ID within this Lot…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <select className="flt-sel" value={statusF} onChange={e => setStatusF(e.target.value)}>
              <option value="">All Status</option>
              <option value="MATCHED">Matched</option>
              <option value="DIFFERENCE">Difference</option>
              <option value="NOT_SUBMITTED">Not Submitted</option>
            </select>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>{filteredRows.length} of {rows?.length || 0} in this Lot</span>
          </div>

          {!rows ? <Spinner full /> : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th><input type="checkbox" checked={selected.size > 0 && selected.size === filteredRows.length} onChange={e => toggleAll(e.target.checked)} style={{ accentColor: '#C8102E' }} /></th>
                    <th>Customer</th><th>Opening Balance</th><th>Cust. Balance</th><th>Difference</th>
                    <th>Status</th><th>Workflow</th><th>Version</th><th>Submitted</th><th>SOA</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 && <tr><td colSpan={11} style={{ textAlign: 'center', padding: 30, color: 'var(--muted)' }}>No customers match this search/filter.</td></tr>}
                  {filteredRows.map(r => {
                    const c = r.confirmation;
                    return (
                      <tr key={r.customer_id}>
                        <td><input type="checkbox" checked={selected.has(r.customer_id)} onChange={e => toggleOne(r.customer_id, e.target.checked)} style={{ accentColor: '#C8102E' }} /></td>
                        <td><div className="td-prim">{r.customer_name || r.customer_id}</div><div className="td-sub mono">{r.customer_id}</div></td>
                        <td><span className="td-mono">{fmtINR(r.opening_balance)}</span></td>
                        <td><span className="td-mono">{c?.cust_balance != null ? fmtINR(c.cust_balance) : <span style={{ color: 'var(--muted-lt)' }}>—</span>}</span></td>
                        <td><span className="td-mono">{c?.difference != null ? (c.difference === 0 ? '✓ Nil' : fmtINR(c.difference)) : '—'}</span></td>
                        <td>{c ? statusBadge(c.status) : statusBadge('PENDING')}</td>
                        <td>{c ? <WorkflowBadge status={c.workflow_status} /> : '—'}</td>
                        <td>{c?.current_version ? <span className="badge b-grey">v{c.current_version}</span> : '—'}</td>
                        <td><span style={{ fontSize: 10, color: 'var(--muted)' }}>{c?.submitted_at ? fmtDate(c.submitted_at) : '—'}</span></td>
                        <td>{c?.soa_filename ? <span title={c.soa_filename}><Icon name="excel" size={13} /></span> : <span style={{ color: 'var(--muted-lt)', fontSize: 10 }}>—</span>}</td>
                        <td>
                          <button className="act-btn" title="Version / comment history" onClick={() => setVersionsFor(r.customer_id)}><Icon name="detail" size={14} /></button>
                          {c && <button className="act-btn" title="Finance workflow" onClick={() => setWorkflowFor(r.customer_id)}><Icon name="sendMail" size={14} /></button>}
                          {c?.soa_filename && onReconcile && (
                            <button className="act-btn" title="Open in Reconciliation Studio" onClick={() => onReconcile(lot._id, r.customer_id)}><Icon name="search" size={14} /></button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <VersionHistoryModal lotId={lot._id} customerId={versionsFor} onClose={() => setVersionsFor(null)} />
      <WorkflowModal lotId={lot._id} customerId={workflowFor} onClose={() => setWorkflowFor(null)} onChanged={loadRows} />
    </div>
  );
}

// ── Small workflow_status badge used in the customer table ──────────────
function WorkflowBadge({ status }) {
  const cfg = {
    ADMIN_REVIEW: { label: 'Admin Review', cls: 'b-grey' },
    FINANCE_REVIEW: { label: 'Finance Review', cls: 'b-pend' },
    CUSTOMER_CLARIFICATION: { label: 'Awaiting Customer', cls: 'b-diff' },
    COMPLETED: { label: 'Completed', cls: 'b-conf' },
  }[status] || { label: status || '—', cls: 'b-grey' };
  return <span className={`badge ${cfg.cls}`} style={{ fontSize: 9 }}>{cfg.label}</span>;
}

// ── Finance clarification workflow modal (phase 5) — route the current
// confirmation Admin<->Finance<->Customer, with a comment, and show the full
// chronological history pulled from the AuditLog-backed /history endpoint.
function WorkflowModal({ lotId, customerId, onClose, onChanged }) {
  const toast = useToast();
  const [role, setRole] = useState(null);
  const [history, setHistory] = useState(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!customerId) { setHistory(null); setComment(''); return; }
    api.me().then(m => setRole(m.role)).catch(() => {});
    api.confirmationHistory(lotId, customerId).then(d => setHistory(d.history || [])).catch(e => toast(e.message, 'err'));
  }, [lotId, customerId, toast]);

  async function route(action) {
    setBusy(true);
    try {
      const fn = { finance: api.routeToFinance, admin: api.routeToAdmin, customer: api.routeToCustomer }[action];
      await fn(lotId, customerId, comment);
      toast(`Routed to ${action === 'customer' ? 'Customer for clarification' : action[0].toUpperCase() + action.slice(1)}.`, 'success');
      setComment('');
      const d = await api.confirmationHistory(lotId, customerId);
      setHistory(d.history || []);
      onChanged();
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={!!customerId} onClose={onClose} title={`Finance Workflow — ${customerId}`} sub="Route between Admin, Finance and the customer; every action is recorded below" wide>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap' }}>
        <textarea className="inp" placeholder="Optional comment for this routing action…" rows={2} style={{ flex: 1, minWidth: 220, resize: 'vertical' }} value={comment} onChange={e => setComment(e.target.value)} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {role === 'ADMIN' && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => route('finance')}>Route to Finance</button>}
          {role === 'FINANCE' && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => route('admin')}>Route back to Admin</button>}
          {role === 'FINANCE' && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => route('customer')}>Route to Customer</button>}
        </div>
      </div>

      {!history ? <Spinner full /> : history.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--muted)', padding: 20 }}>No workflow history yet for this customer in this Lot.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {history.map((h, i) => (
            <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong>{h.action}</strong>
                <span style={{ fontSize: 10, color: 'var(--muted)' }}>{fmtDate(h.timestamp)} · {h.actor}</span>
              </div>
              {h.details?.comment && <div style={{ marginTop: 4, color: 'var(--muted)' }}>{h.details.comment}</div>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ── Version history modal — every amendment, never overwritten ──────────
function VersionHistoryModal({ lotId, customerId, onClose }) {
  const toast = useToast();
  const [versions, setVersions] = useState(null);

  useEffect(() => {
    if (!customerId) { setVersions(null); return; }
    api.lotConfirmationVersions(lotId, customerId).then(d => setVersions(d.versions || [])).catch(e => toast(e.message, 'err'));
  }, [lotId, customerId, toast]);

  return (
    <Modal open={!!customerId} onClose={onClose} title={`Submission History — ${customerId}`} sub="Every amendment is preserved; nothing is ever overwritten" wide>
      {!versions ? <Spinner full /> : versions.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--muted)', padding: 20 }}>No submissions yet for this customer in this Lot.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[...versions].reverse().map(v => (
            <div key={v.version} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: v.status === 'CURRENT' ? '#F0FDF4' : 'transparent' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="badge b-grey">v{v.version}</span>
                  <span className={`badge ${v.status === 'CURRENT' ? 'b-conf' : 'b-grey'}`}>{v.status}</span>
                </div>
                <span style={{ fontSize: 10, color: 'var(--muted)' }}>{fmtDate(v.submitted_at)} · {v.actor}</span>
              </div>
              <div style={{ display: 'flex', gap: 20, fontSize: 12 }}>
                <div><span style={{ color: 'var(--muted)' }}>SAP:</span> {fmtINR(v.sap_balance)}</div>
                <div><span style={{ color: 'var(--muted)' }}>Customer:</span> {fmtINR(v.cust_balance)}</div>
                <div><span style={{ color: 'var(--muted)' }}>Diff:</span> {v.difference === 0 ? '✓ Nil' : fmtINR(v.difference)}</div>
              </div>
              {(v.remarks || v.comment) && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>{v.remarks}{v.comment ? ` — ${v.comment}` : ''}</div>}
              {v.soa_filename && (
                <div style={{ marginTop: 6 }}>
                  <a href={api.lotConfirmationVersionSoaUrl(lotId, customerId, v.version)} className="btn btn-ghost btn-sm" style={{ fontSize: 10 }}>
                    <Icon name="download" size={11} /> {v.soa_filename}
                  </a>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
