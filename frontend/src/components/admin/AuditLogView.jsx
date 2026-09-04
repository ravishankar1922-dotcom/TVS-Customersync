import React, { useEffect, useState } from 'react';
import api from '../../services/api';
import { fmtDate, Spinner, useToast, Icon } from '../shared';

const ACTION_LABELS = {
  LOGIN_SUCCESS: 'Admin login', LOGIN_FAILED: 'Failed login attempt',
  TOKEN_GENERATE: 'Tokens generated', TOKEN_EXPIRY_CHANGED: 'Token expiry changed',
  CUSTOMER_RESET: 'Customer reset', PAN_VERIFY_SUCCESS: 'PAN verified (customer)', PAN_VERIFY_FAILED: 'PAN mismatch (customer)',
  CONFIRMATION_SUBMITTED: 'Confirmation submitted', EMAIL_TRIGGER_BULK: 'Bulk emails triggered', EMAIL_TRIGGER_SINGLE: 'Single email sent',
  LEDGER_IMPORT: 'Ledger imported', RECON_NOTES_SAVED: 'Reconciliation notes saved', RECON_MARKED_COMPLETE: 'Reconciliation marked complete',
  RECON_EXPORTED: 'Reconciliation exported', RECON_SENT_TO_CUSTOMER: 'Reconciliation emailed to customer',
  SOA_REUPLOAD_REQUESTED: 'SOA re-upload requested (customer)', SOA_REUPLOAD_APPROVED: 'SOA re-upload approved (admin)',
  CONFIRMATION_RESUBMITTED: 'Confirmation resubmitted (re-upload)', CUSTOMER_MASTER_JSON_IMPORTED: 'Customer master imported (JSON)',
  LEDGER_JSON_IMPORTED: 'Ledger imported (JSON)', CUSTOMERS_EXPORTED: 'Customer list exported', LEDGER_EXPORTED: 'Ledger exported',
};

export default function AuditLogView() {
  const toast = useToast();
  const [logs, setLogs]   = useState(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    api.auditLog().then(d => setLogs(d.logs)).catch(e => toast(e.message, 'err'));
  }, [toast]);

  if (!logs) return <Spinner full />;
  const filtered = filter ? logs.filter(l => l.action === filter) : logs;
  const actions = [...new Set(logs.map(l => l.action))];

  return (
    <div>
      <div className="sec-hd">
        <div><div className="sec-title disp">Audit Log</div><div className="sec-sub">Every admin and customer action affecting confirmations, tokens and the ledger</div></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select className="flt-sel" value={filter} onChange={e => setFilter(e.target.value)}>
            <option value="">All Actions</option>
            {actions.map(a => <option key={a} value={a}>{ACTION_LABELS[a] || a}</option>)}
          </select>
          <a href={api.auditExportUrl(filter ? { action: filter } : {})} className="btn btn-secondary btn-sm"><Icon name="excel" size={13} /> Export Excel</a>
        </div>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
          <tbody>
            {filtered.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', padding: 30, color: 'var(--muted)' }}>No audit events yet.</td></tr>}
            {filtered.map((l, i) => (
              <tr key={i}>
                <td style={{ fontSize: 11, color: 'var(--muted)' }}>{fmtDate(l.createdAt)} {new Date(l.createdAt).toLocaleTimeString('en-IN')}</td>
                <td><span className="mono" style={{ fontSize: 11 }}>{l.actor}</span></td>
                <td style={{ fontSize: 12 }}>{ACTION_LABELS[l.action] || l.action}</td>
                <td style={{ fontSize: 11, color: 'var(--muted)' }}>{l.entity_type ? `${l.entity_type}${l.entity_id ? ' · ' + l.entity_id : ''}` : '—'}</td>
                <td style={{ fontSize: 10, color: 'var(--muted)', fontFamily: "'JetBrains Mono',monospace" }}>{l.details ? JSON.stringify(l.details) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
