import React, { useState } from 'react';
import api from '../../services/api';
import { fmtINR, fmtDate, Spinner, useToast } from '../shared';

export default function LedgerUpload() {
  const toast = useToast();
  const [preview, setPreview]   = useState(null);
  const [loading, setLoading]   = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone]         = useState(null);
  const [dragOver, setDragOver] = useState(false);

  async function handleFile(file) {
    if (!file) return;
    const allowed = ['.xlsx', '.xls', '.csv'];
    const ext     = '.' + file.name.split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) { toast('Only Excel and CSV files accepted.', 'err'); return; }

    setLoading(true); setPreview(null); setDone(null);
    try {
      const fd = new FormData();
      fd.append('ledger_file', file);
      const r = await api.uploadLedger(fd);
      setPreview(r.preview);
      toast('Ledger parsed. Review below before confirming import.', 'info');
    } catch (e) { toast(e.message, 'err'); }
    finally { setLoading(false); }
  }

  async function confirmImport() {
    if (!preview) return;
    setConfirming(true);
    try {
      const r = await api.confirmImport({ import_id: preview.import_id, file_path: preview.file_path, filename: preview.filename });
      setDone(r);
      setPreview(null);
      toast(`✅ Ledger imported — ${r.customers_updated} customers, ${r.total_transactions} transactions`, 'success');
    } catch (e) { toast(e.message, 'err'); }
    finally { setConfirming(false); }
  }

  return (
    <div>
      <div className="sec-hd">
        <div>
          <div className="sec-title disp">Upload SAP FBL5N / Ledger</div>
          <div className="sec-sub">Admin only · Supports Excel (XLSX, XLS) and CSV · Multi-format column detection</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card">
          <div className="card-hd">
            <div className="card-hd-l">
              <div className="card-ico" style={{ background: 'var(--blue-bg)' }}>📊</div>
              <div><div className="card-title">Upload Ledger File</div><div className="card-sub">XLSX · XLS · CSV</div></div>
            </div>
          </div>
          <div className="card-body">
            <div className={`upload-zone ${dragOver ? 'drag' : ''}`}
              onClick={() => document.getElementById('ledger-file-input').click()}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>📋</div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Drop FBL5N export here or click to browse</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>Excel or CSV · Max 20 MB</div>
            </div>
            <input id="ledger-file-input" type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
              onChange={e => { if (e.target.files[0]) handleFile(e.target.files[0]); }} />
            {loading && <div style={{ textAlign: 'center', marginTop: 16 }}><Spinner /></div>}
            <div className="info-box ib-blue" style={{ marginTop: 16 }}>
              <strong>Supported Column Formats</strong>
              The engine automatically detects: Document Number / Invoice No / Ref · Document Date / Inv Date · Amount / Debit / Value · Status / Clearing · Due Date / Payment Due
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-hd">
            <div className="card-hd-l">
              <div className="card-ico" style={{ background: 'var(--green-bg)' }}>📖</div>
              <div><div className="card-title">Import Process</div></div>
            </div>
          </div>
          <div className="card-body">
            {[
              ['1', 'Export FBL5N from SAP', 'Use layout with: Customer, Document Number, Type, Date, Due Date, Amount, Status'],
              ['2', 'Upload here', 'Drop the Excel/CSV file. The engine detects the column layout automatically.'],
              ['3', 'Review preview', 'Check the first 10 rows and column mapping before confirming.'],
              ['4', 'Confirm import', 'Existing ledger is updated. Original is not deleted — import history is kept.'],
              ['5', 'Balances recalculate', 'Dashboard immediately reflects new SAP balances from the imported ledger.'],
            ].map(([n, title, desc]) => (
              <div key={n} style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                <div style={{ width: 24, height: 24, background: 'var(--red)', borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700, color: '#fff', flexShrink: 0 }}>{n}</div>
                <div><div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{title}</div><div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>{desc}</div></div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {preview && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-hd">
            <div className="card-hd-l">
              <div className="card-ico" style={{ background: 'var(--amber-bg)' }}>🔍</div>
              <div><div className="card-title">Preview — {preview.filename}</div><div className="card-sub">{preview.total_rows} transactions detected · Review before confirming</div></div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setPreview(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={confirmImport} disabled={confirming}>
                {confirming ? <><Spinner /> Importing…</> : `✓ Confirm Import (${preview.total_rows} rows)`}
              </button>
            </div>
          </div>
          <div className="card-body">
            <div className="info-box ib-amber" style={{ marginBottom: 14 }}>
              <strong>Column Mapping Detected</strong>
              {Object.entries(preview.column_mapping || {}).filter(([, v]) => v >= 0).map(([k, v]) => `${k.replace('col', '')} → Col ${v + 1}`).join(' · ')}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="tbl">
                <thead><tr>{['Document No', 'Type', 'Date', 'Due Date', 'Amount', 'Currency', 'Status', 'Customer ID'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                <tbody>
                  {(preview.preview_rows || []).map((r, i) => (
                    <tr key={i}>
                      <td className="td-mono" style={{ fontSize: 11 }}>{r.document_number}</td>
                      <td style={{ fontSize: 11 }}>{r.document_type}</td>
                      <td style={{ fontSize: 10, color: 'var(--muted)' }}>{fmtDate(r.document_date)}</td>
                      <td style={{ fontSize: 10, color: 'var(--muted)' }}>{fmtDate(r.due_date)}</td>
                      <td className="td-mono">{fmtINR(r.amount)}</td>
                      <td style={{ fontSize: 10 }}>{r.currency}</td>
                      <td><span className={`badge ${r.status === 'OPEN' ? 'b-diff' : 'b-conf'}`}>{r.status}</span></td>
                      <td style={{ fontSize: 11, color: 'var(--muted)' }}>{r.customer_id || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {done && (
        <div className="info-box ib-green" style={{ marginTop: 16 }}>
          <strong>✅ Import Successful</strong>
          {done.customers_updated} customers updated · {done.total_transactions} transactions loaded · Dashboard balances recalculated immediately.
        </div>
      )}
    </div>
  );
}
