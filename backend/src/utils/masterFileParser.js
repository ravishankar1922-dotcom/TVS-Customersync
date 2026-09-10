/**
 * Shared parser for Customer/Vendor MASTER file uploads (Sept 2026: "Where
 * is the provision to upload customer master?" — there was a working JSON
 * API endpoint, `POST /api/customers|vendors/import-json`, but no Excel/CSV
 * support and no admin UI wired up to either). Mirrors the same
 * flexible-header-matching approach already used for ledger uploads
 * (routes/ledger.js) and SOA uploads (routes/reconciliation.js) — an admin
 * shouldn't have to rename their spreadsheet's columns to exactly match
 * this app's internal field names.
 *
 * Accepts Excel/CSV (via the `xlsx` package) OR JSON (a top-level array, or
 * `{ <wrapperKey>: [...] }`), auto-detected the same way ledger uploads are:
 * by file extension, else by the buffer's first non-whitespace character.
 */
const XLSX = require('xlsx');

function normaliseKey(k) { return (k || '').toString().toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }

function looksLikeJson(buffer, originalName) {
  if (/\.json$/i.test(originalName || '')) return true;
  const head = buffer.slice(0, 200).toString('utf8').trim();
  return head.startsWith('[') || head.startsWith('{');
}

function findKey(obj, candidates) {
  const keys = Object.keys(obj || {});
  const normKeys = keys.map(normaliseKey);
  for (const c of candidates) {
    let i = normKeys.indexOf(c);
    if (i === -1) i = normKeys.findIndex(nk => nk.includes(c));
    if (i >= 0) return keys[i];
  }
  return null;
}
function jget(obj, candidates) {
  const k = findKey(obj, candidates);
  return k !== null ? obj[k] : undefined;
}

function findCol(headers, candidates) {
  const norm = headers.map(normaliseKey);
  for (const c of candidates) {
    let i = norm.indexOf(c);
    if (i === -1) i = norm.findIndex(nk => nk.includes(c));
    if (i >= 0) return i;
  }
  return -1;
}

// `fields`: [{ key: 'customer_id', aliases: [...], required: true }, ...]
// `jsonWrapperKeys`: e.g. ['customers'] or ['vendors'] — top-level object
// keys that, if present and an array, are used instead of requiring the
// JSON itself to be a bare top-level array.
function parseMasterFile(buffer, originalName, fields, jsonWrapperKeys = []) {
  if (looksLikeJson(buffer, originalName)) {
    let data;
    try { data = JSON.parse(buffer.toString('utf8')); }
    catch (err) { throw new Error('File looks like JSON but failed to parse: ' + err.message); }
    let rows = Array.isArray(data) ? data : null;
    if (!rows) {
      for (const key of jsonWrapperKeys) { if (Array.isArray(data?.[key])) { rows = data[key]; break; } }
    }
    if (!rows) throw new Error(`Expected a JSON array of records (or wrapped as { "${jsonWrapperKeys[0] || 'rows'}": [...] }).`);

    return rows.map(row => {
      const rec = {};
      fields.forEach(f => { const v = jget(row, f.aliases); if (v !== undefined && v !== null && v !== '') rec[f.key] = v.toString().trim(); });
      return rec;
    });
  }

  const wb = XLSX.read(buffer, { type: 'buffer', raw: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

  let headerIdx = 0;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const nonEmpty = (rows[i] || []).filter(c => c !== null && c !== undefined && c.toString().trim() !== '');
    if (nonEmpty.length >= 2) { headerIdx = i; break; }
  }
  const headers = (rows[headerIdx] || []).map(h => h?.toString() || '');
  const dataRows = rows.slice(headerIdx + 1).filter(r => r && r.some(c => c !== null && c !== undefined && c.toString().trim() !== ''));

  const colIdx = {};
  fields.forEach(f => { colIdx[f.key] = findCol(headers, f.aliases); });

  return dataRows.map(row => {
    const rec = {};
    fields.forEach(f => {
      const idx = colIdx[f.key];
      if (idx >= 0 && row[idx] !== null && row[idx] !== undefined && row[idx].toString().trim() !== '') rec[f.key] = row[idx].toString().trim();
    });
    return rec;
  });
}

module.exports = { parseMasterFile, looksLikeJson };
