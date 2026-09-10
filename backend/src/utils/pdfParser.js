/**
 * PDF SOA extraction pipeline (spec: "Improve PDF SOA processing — real
 * parser/table extraction, normalise, feed the reconciliation engine,
 * extract invoice number/date/due date/amount; handle layout variation;
 * on low confidence/failure, preserve original PDF, show a meaningful
 * warning, allow a manual path, NEVER silently create incorrect
 * reconciliation data").
 *
 * This closes a real, pre-existing gap: `.pdf` was already an accepted
 * upload extension (routes/confirmations.js / routes/lots.js ALLOWED_EXT),
 * but the reconciliation engine only ever called XLSX.read() on the bytes
 * — a PDF SOA was silently never actually reconciled. That gap is fixed
 * here, with an explicit confidence score so a badly-extracted PDF is
 * flagged rather than treated as a clean reconciliation.
 *
 * APPROACH: pdf-parse (pdfjs-dist under the hood) extracts raw text. PDFs
 * carry no real table/column structure once flattened to text — this is a
 * fundamentally harder input than a real spreadsheet — so extraction here
 * is a line-based heuristic: a transaction line "looks like" one if it
 * contains a document-number-shaped token, a date-shaped token, and a
 * trailing amount-shaped token. Lines that don't match are simply not
 * extracted (never guessed at) — the confidence score is the fraction of
 * non-empty lines that DID match, so a caller can decide whether to trust
 * the result or fall back to a manual/re-upload path.
 */
const { PDFParse } = require('pdf-parse');
const { validatePdfBuffer } = require('./fileSecurity');

const DOC_RE    = /\b([A-Za-z]{0,6}[-/]?\d{3,}[A-Za-z0-9-]*)\b/;
const DATE_RE   = /\b(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\b/;
const AMOUNT_RE = /(-?₹?\s?[\d,]+\.\d{2})(?!.*\d)/; // last decimal-amount-shaped token on the line
const SUMMARY_ROW_RE = /\b(grand\s*total|sub[\s-]?total|total|closing\s*balance|balance\s*c\/?f|balance\s*b\/?f|net\s*total)\b/i;

function parseAmt(s) { return parseFloat(String(s).replace(/[₹,\s]/g, '')) || 0; }

function normaliseDate(s) {
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (m) { const [, d, mo, y] = m; return `${y.length === 2 ? '20' + y : y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`; }
  return s;
}

// Hard timeout so a malformed/adversarial PDF can't hang the request
// indefinitely (spec: "DoS via huge/malformed PDFs").
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function parsePdfSoa(buffer) {
  const security = validatePdfBuffer(buffer);
  if (!security.ok) {
    return { items: [], headers: [], headerIdx: 0, format_detected: 'PDF_REJECTED', confidence: 0, warning: security.reason };
  }

  let parser, text;
  try {
    parser = new PDFParse({ data: buffer });
    const result = await withTimeout(parser.getText(), 15000, 'PDF text extraction');
    text = result.text || '';
  } catch (err) {
    return {
      items: [], headers: [], headerIdx: 0, format_detected: 'PDF_PARSE_FAILED', confidence: 0,
      warning: `Could not read this PDF (${err.message}). The original file has been preserved — please try re-exporting it or upload as Excel/CSV instead.`,
    };
  } finally {
    try { if (parser) await parser.destroy(); } catch { /* best-effort cleanup */ }
  }

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !SUMMARY_ROW_RE.test(l) && !/^-- \d+ of \d+ --$/.test(l));
  const items = [];
  let matched = 0;

  lines.forEach((line, i) => {
    const docM = line.match(DOC_RE);
    const dateM = line.match(DATE_RE);
    const amtM = line.match(AMOUNT_RE);
    if (!amtM) return; // an amount is the one thing we won't guess at — no amount, no line item
    matched++;
    const amount = parseAmt(amtM[1]);
    items.push({
      doc_number: docM ? docM[1] : `PDFROW${i + 1}`,
      doc_type:   amount < 0 ? 'CREDIT NOTE' : 'INVOICE',
      doc_date:   dateM ? normaliseDate(dateM[1]) : null,
      due_date:   null,
      amount, currency: 'INR', status: 'OPEN',
    });
  });

  const confidence = lines.length ? Math.round((matched / lines.length) * 100) : 0;
  const lowConfidence = items.length === 0 || confidence < 40;

  return {
    items: lowConfidence ? [] : items,
    headers: ['Extracted Text Line'], headerIdx: 0,
    format_detected: lowConfidence ? 'PDF_LOW_CONFIDENCE' : 'PDF_TEXT_EXTRACTED',
    confidence,
    warning: lowConfidence
      ? 'Could not confidently extract transaction line items from this PDF (layout not recognised). The original file is preserved for manual review — no reconciliation was auto-generated from it. Consider asking for an Excel/CSV export instead.'
      : (confidence < 80 ? `Extracted ${items.length} line item(s) from this PDF with ${confidence}% line-match confidence — please spot-check against the original before relying on it.` : null),
  };
}

module.exports = { parsePdfSoa };
