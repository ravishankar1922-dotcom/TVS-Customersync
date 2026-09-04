import React, { useState, useEffect, useRef } from 'react';
import api from '../../services/api';
import { fmtINR, fmtDate, Spinner, Icon } from '../shared';

export default function CustomerPortal() {
  const [token]      = useState(() => new URLSearchParams(window.location.search).get('t') || '');
  const [state, setState] = useState('LOADING'); // LOADING | INVALID | EXPIRED | USED | PAN_GATE | ACTIVE | SUCCESS
  const [reason, setReason]   = useState('');
  const [usedCustomerId, setUsedCustomerId] = useState(null);
  const [reuploadReason, setReuploadReason] = useState('');
  const [reuploadSent, setReuploadSent]     = useState(false);
  const [reuploadBusy, setReuploadBusy]     = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [pan, setPan]         = useState('');
  const [panErr, setPanErr]   = useState('');
  const [panAttempts, setPanAttempts] = useState(0);
  const [verifying, setVerifying] = useState(false);
  const [tokenData, setTokenData] = useState(null);
  const [step, setStep]       = useState(1);
  const [custBal, setCustBal] = useState('');
  const [remarks, setRemarks] = useState('');
  const [file, setFile]       = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult]   = useState(null);
  const [errors, setErrors]   = useState({});
  const fileRef = useRef();

  useEffect(() => {
    if (!token) { setState('INVALID'); setReason('NO_TOKEN'); return; }
    api.validateToken(token)
      .then(d => { setCustomerName(d.customer_name || ''); setState('PAN_GATE'); })
      .catch(e => {
        const r = e.data?.reason || e.message || '';
        if (r.includes('EXPIRED'))      { setState('EXPIRED');  setReason('EXPIRED'); }
        else if (r.includes('ALREADY')) { setState('USED');     setReason('ALREADY_USED'); setUsedCustomerId(e.data?.customer_id || null); }
        else                            { setState('INVALID');  setReason(r); }
      });
  }, [token]);

  async function submitPan(e) {
    e.preventDefault();
    if (!pan.trim()) { setPanErr('Please enter your PAN.'); return; }
    setVerifying(true); setPanErr('');
    try {
      const d = await api.verifyPan(token, pan.trim());
      setTokenData(d);
      setState('ACTIVE');
    } catch (err) {
      const attempts = panAttempts + 1;
      setPanAttempts(attempts);
      setPanErr(attempts >= 5 ? 'Too many failed attempts. Please contact the AR team for a new link.' : 'PAN does not match our records. Please check and try again.');
    } finally { setVerifying(false); }
  }

  function validate(s) {
    const errs = {};
    if (s === 1 && (!custBal || isNaN(parseFloat(custBal)))) errs.bal = 'Please enter your book balance.';
    if (s === 2 && !file) errs.file = 'Please upload your Statement of Account.';
    return errs;
  }
  function next(s) {
    const errs = validate(s);
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setErrors({}); setStep(s + 1);
  }
  function handleFile(f) {
    const allowed = ['.xlsx', '.xls', '.csv', '.pdf'];
    const ext = '.' + f.name.split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) { setErrors({ file: 'Only Excel, CSV or PDF files accepted.' }); return; }
    if (f.size > 20 * 1024 * 1024) { setErrors({ file: 'File too large. Maximum 20 MB.' }); return; }
    setFile(f); setErrors(e => ({ ...e, file: null }));
  }

  async function submit() {
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('customer_id',  tokenData.customer_id);
      fd.append('cycle_id',     tokenData.cycle_id);
      fd.append('token_id',     tokenData.token_id);
      fd.append('sap_balance',  tokenData.sap_balance);
      fd.append('cust_balance', custBal);
      fd.append('remarks',      remarks);
      if (file) fd.append('soa_file', file);
      const r = await api.submitConfirmation(fd);
      setResult(r); setState('SUCCESS');
    } catch (e) { setErrors({ submit: e.message }); }
    finally { setSubmitting(false); }
  }

  if (state === 'LOADING') return (
    <div className="portal-wrap" style={{ textAlign: 'center', paddingTop: 60 }}>
      <Spinner /><div style={{ marginTop: 12, color: 'var(--muted)', fontSize: 12 }}>Validating your link…</div>
    </div>
  );

  if (state === 'INVALID') return <StatusScreen icon="xCircle" title="Invalid Link" color="var(--diff)"
    desc={`This confirmation link is invalid or has been tampered with. (${reason})`} contact />;
  if (state === 'EXPIRED') return <StatusScreen icon="clock" title="Link Expired" color="var(--amber)"
    desc="Your confirmation link has expired. Please contact the AR team to receive a new link." contact />;
  async function requestReupload() {
    if (!usedCustomerId) return;
    setReuploadBusy(true);
    try { await api.requestReupload(usedCustomerId, reuploadReason); setReuploadSent(true); }
    catch (e) { setReuploadSent(false); alert(e.message); }
    finally { setReuploadBusy(false); }
  }

  if (state === 'USED') return (
    <div style={{ maxWidth: 440, margin: '60px auto', textAlign: 'center', padding: '0 20px' }}>
      <div style={{ marginBottom: 16, color: 'var(--green)' }}><Icon name="checkCircle" size={48} /></div>
      <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 22, fontWeight: 700, color: 'var(--green)', marginBottom: 10 }}>Already Submitted</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 20 }}>
        This confirmation has already been submitted. If you uploaded the wrong Statement of Account, you can request a re-upload below — an admin will review and reopen your link.
      </div>
      {usedCustomerId && !reuploadSent && (
        <div className="card" style={{ padding: 20, textAlign: 'left' }}>
          <div className="field">
            <label className="lbl">Reason for re-upload (optional)</label>
            <textarea className="inp" value={reuploadReason} onChange={e => setReuploadReason(e.target.value)}
              style={{ minHeight: 70, resize: 'vertical' }} placeholder="e.g. Uploaded the wrong customer's statement by mistake" />
          </div>
          <button className="btn btn-primary btn-full" onClick={requestReupload} disabled={reuploadBusy}>
            {reuploadBusy ? 'Sending…' : <><Icon name="reset" size={13} /> Request Re-upload Approval</>}
          </button>
        </div>
      )}
      {reuploadSent && (
        <div className="info-box ib-green">
          <strong>Request sent</strong>
          Your re-upload request has been sent to the AR admin team for approval. You'll be able to use your existing link again once approved.
        </div>
      )}
    </div>
  );

  // ── Second factor: PAN gate ─────────────────────────────────────────────
  if (state === 'PAN_GATE') return (
    <div className="portal-wrap" style={{ maxWidth: 420, margin: '40px auto' }}>
      <div className="card" style={{ padding: '28px 24px' }}>
        <div style={{ textAlign: 'center', marginBottom: 18 }}>
          <div style={{ marginBottom: 8, color: 'var(--red)' }}><Icon name="lock" size={30} /></div>
          <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Verify Your Identity</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            {customerName ? `Hello ${customerName}, please` : 'Please'} enter your registered PAN to open this balance confirmation link.
            This is a security check in addition to the emailed link.
          </div>
        </div>
        <form onSubmit={submitPan}>
          <div className="field">
            <label className="lbl">PAN <span className="lbl-req">*</span></label>
            <input className={`inp${panErr ? ' inp-err' : ''}`} value={pan} maxLength={10}
              style={{ textTransform: 'uppercase', letterSpacing: '1px' }}
              onChange={e => { setPan(e.target.value.toUpperCase()); setPanErr(''); }}
              placeholder="e.g. ABCDE1234F" autoFocus disabled={panAttempts >= 5} />
            {panErr && <div className="err-msg">{panErr}</div>}
          </div>
          <button type="submit" className="btn btn-primary btn-full btn-lg" disabled={verifying || panAttempts >= 5}>
            {verifying ? 'Verifying…' : 'Unlock Confirmation →'}
          </button>
        </form>
        <div style={{ marginTop: 14, fontSize: 10, color: 'var(--muted)', textAlign: 'center' }}>
          Don't know your registered PAN? Contact the AR team.
        </div>
      </div>
    </div>
  );

  if (state === 'SUCCESS') return (
    <div className="portal-wrap">
      <div style={{ textAlign: 'center', padding: '40px 16px' }}>
        <div className="ps-check"><Icon name="checkCircle" size={30} color="var(--green)" /></div>
        <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Confirmation Submitted</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 16, maxWidth: 420, margin: '0 auto 16px' }}>
          {result?.message}<br/>The AR team will review and respond within 3 working days.
        </div>
        <div className="ps-ref">REF: BC-{tokenData?.customer_id}-{Date.now().toString().slice(-6)}</div>
        <div style={{ marginTop: 14, fontSize: 10, color: 'var(--muted)' }}>[TEST DATA ONLY — Not a real submission]</div>
      </div>
    </div>
  );

  const { customer, sap_balance, transactions, as_of_date } = tokenData || {};
  const custNum  = parseFloat(custBal) || 0;
  const liveDiff = custBal ? sap_balance - custNum : null;

  return (
    <div className="portal-wrap">
      <div className="portal-hdr">
        <div className="pi-eye">Accounts Receivable</div>
        <div className="pi-co">Balance Confirmation Request</div>
        <div className="pi-desc">Please confirm the outstanding balance in your books and upload your Statement of Account.</div>
        <div className="pi-meta">
          {[
            { l: 'Customer', v: customer?.customer_name },
            { l: 'Customer ID', v: customer?.customer_id },
            { l: 'Confirmation Date', v: as_of_date },
            { l: 'Company', v: customer?.company },
          ].map(({ l, v }) => (
            <div key={l} className="pi-mi"><div className="pi-ml">{l}</div><div className="pi-mv">{v}</div></div>
          ))}
        </div>
      </div>

      <div className="steps-bar">
        {['Balance', 'Upload SOA', 'Review', 'Submit'].map((s, i) => (
          <div key={s} className={`step-item${i + 1 < step ? ' done' : i + 1 === step ? ' active' : ''}`}>
            <div className="step-num">{String(i + 1).padStart(2, '0')}</div>{s}
          </div>
        ))}
      </div>

      {step === 1 && (
        <>
          <div className="bal-widget">
            <div className="bw-hd" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="scale" size={15} /> Balance as per Our Books vs Your Books</div>
            <div className="bw-body">
              <div className="bw-cmp">
                <div className="bw-box bw-sap">
                  <div className="bw-lbl">Our Books (SAP)</div>
                  <div className="bw-amt">{fmtINR(sap_balance)}</div>
                  <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 3 }}>As on {as_of_date}</div>
                </div>
                <div className="bw-vs">vs</div>
                <div className="bw-box bw-cust">
                  <div className="bw-lbl">Your Books</div>
                  <div className="bw-amt" style={{ color: custBal ? 'var(--green)' : 'var(--muted-lt)', fontSize: custBal ? 18 : 14 }}>
                    {custBal ? fmtINR(custNum) : 'Enter below →'}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 3 }}>Accounts Payable balance</div>
                </div>
              </div>
              {liveDiff !== null && (
                <div className={`info-box ${liveDiff === 0 ? 'ib-green' : 'ib-amber'}`} style={{ marginBottom: 12 }}>
                  <strong><Icon name={liveDiff === 0 ? 'checkCircle' : 'warning'} size={13} /> {liveDiff === 0 ? 'Balances Agree' : 'Difference Detected'}</strong>
                  {liveDiff === 0 ? 'Your balance matches our records.' : `${fmtINR(Math.abs(liveDiff))} difference. Please explain in remarks.`}
                </div>
              )}
              <div className="field">
                <label className="lbl">Your Book Balance (₹) <span className="lbl-req">*</span></label>
                <input className={`inp${errors.bal ? ' inp-err' : ''}`} type="number" value={custBal}
                  placeholder="Enter your AP books balance for this vendor"
                  onChange={e => { setCustBal(e.target.value); setErrors(p => ({ ...p, bal: null })); }} />
                {errors.bal && <div className="err-msg">{errors.bal}</div>}
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="lbl">Remarks {liveDiff ? <span className="lbl-req">*</span> : '(optional)'}</label>
                <textarea className="inp" value={remarks} onChange={e => setRemarks(e.target.value)}
                  style={{ resize: 'vertical', minHeight: 72, lineHeight: 1.6 }}
                  placeholder="Explain any differences (e.g. invoice not yet received, payment in transit)…" />
              </div>
            </div>
          </div>

          {transactions?.length > 0 && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="card-hd">
                <div className="card-hd-l">
                  <div className="card-ico" style={{ background: 'var(--blue-bg)' }}><Icon name="checklist" size={17} /></div>
                  <div><div className="card-title">Open Items as per Our Books</div><div className="card-sub">{transactions.filter(t => t.status === 'OPEN').length} open items</div></div>
                </div>
              </div>
              <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                <table className="tbl" style={{ minWidth: 'unset' }}>
                  <thead><tr><th>Document No</th><th>Type</th><th>Date</th><th>Due Date</th><th>Amount</th></tr></thead>
                  <tbody>
                    {transactions.filter(t => t.status === 'OPEN').map((t, i) => (
                      <tr key={i}>
                        <td><span className="mono" style={{ fontSize: 11 }}>{t.document_number}</span></td>
                        <td style={{ fontSize: 11 }}>{t.document_type}</td>
                        <td style={{ fontSize: 10, color: 'var(--muted)' }}>{fmtDate(t.document_date)}</td>
                        <td style={{ fontSize: 10, color: 'var(--muted)' }}>{fmtDate(t.due_date)}</td>
                        <td><span className="mono" style={{ color: t.amount < 0 ? 'var(--diff)' : 'var(--blue)', fontWeight: 600 }}>{fmtINR(t.amount)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <button className="btn btn-primary btn-full btn-lg" onClick={() => next(1)}>Continue to SOA Upload →</button>
        </>
      )}

      {step === 2 && (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-hd">
              <div className="card-hd-l">
                <div className="card-ico" style={{ background: 'var(--blue-bg)' }}><Icon name="cloud" size={17} /></div>
                <div><div className="card-title">Upload Statement of Account</div><div className="card-sub">Excel, CSV or PDF · Max 20 MB</div></div>
              </div>
            </div>
            <div className="card-body">
              <div className={`upload-zone ${dragOver ? 'drag' : ''}`}
                onClick={() => fileRef.current.click()}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}>
                <div style={{ marginBottom: 8, color: 'var(--muted)' }}><Icon name="cloud" size={28} /></div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Drop your SOA here or click to browse</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Excel (.xlsx, .xls), CSV, PDF · Maximum 20 MB</div>
              </div>
              <input ref={fileRef} type="file" style={{ display: 'none' }} accept=".xlsx,.xls,.csv,.pdf"
                onChange={e => { if (e.target.files[0]) handleFile(e.target.files[0]); }} />
              {file && (
                <div className="up-preview">
                  <Icon name="checkCircle" size={20} color="var(--green)" />
                  <div><div className="up-name">{file.name}</div><div style={{ fontSize: 9, color: 'var(--muted)' }}>{(file.size / 1024).toFixed(1)} KB</div></div>
                  <button className="btn btn-ghost btn-sm" onClick={() => setFile(null)}>Remove</button>
                </div>
              )}
              {errors.file && <div className="err-msg" style={{ marginTop: 8 }}>{errors.file}</div>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary" onClick={() => setStep(1)}>← Back</button>
            <button className="btn btn-primary btn-full btn-lg" onClick={() => next(2)}>Review & Submit →</button>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-hd"><div className="card-hd-l"><div className="card-ico" style={{ background: 'var(--amber-bg)' }}><Icon name="checklist" size={17} /></div><div><div className="card-title">Review Your Submission</div></div></div></div>
            <div className="card-body">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <tbody>
                {[
                  ['Customer', customer?.customer_name],
                  ['SAP Balance', fmtINR(sap_balance)],
                  ['Your Balance', fmtINR(parseFloat(custBal))],
                  ['Difference', (() => { const d = sap_balance - parseFloat(custBal); return d === 0 ? 'NIL ✓' : fmtINR(d); })()],
                  ['SOA File', file?.name || '(None uploaded)'],
                  ['Remarks', remarks || '(None)'],
                ].map(([k, v]) => (
                  <tr key={k} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '10px 0', color: 'var(--muted)', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', width: 140 }}>{k}</td>
                    <td style={{ padding: '10px 0', fontWeight: 500 }}>{v}</td>
                  </tr>
                ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="info-box ib-green" style={{ marginBottom: 12 }}>
            <strong>Ready to submit</strong>
            Once submitted, this link becomes one-time use. Contact the AR team for any corrections.
          </div>
          {errors.submit && <div className="info-box ib-red" style={{ marginBottom: 12 }}>{errors.submit}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary" onClick={() => setStep(2)}>← Back</button>
            <button className="btn btn-green btn-full btn-lg" onClick={submit} disabled={submitting}>
              {submitting ? <><Spinner /> Submitting…</> : <><Icon name="checkCircle" size={14} /> Submit Confirmation</>}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function StatusScreen({ icon, title, color, desc, contact }) {
  return (
    <div style={{ maxWidth: 440, margin: '60px auto', textAlign: 'center', padding: '0 20px' }}>
      <div style={{ marginBottom: 16, color }}><Icon name={icon} size={48} /></div>
      <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 22, fontWeight: 700, color, marginBottom: 10 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 20 }}>{desc}</div>
      {contact && (
        <div className="info-box ib-blue">
          <strong>AR Team Contact</strong>
          ar.confirmation@yourcompany.com<br/>[TEST DATA ONLY]
        </div>
      )}
    </div>
  );
}
