/**
 * File-upload security checks for SOA/ledger uploads (spec: "PDF security —
 * validate file type/size/MIME/extension/parser errors; prevent embedded-
 * content execution, path traversal, arbitrary execution, malicious
 * payloads, DoS via huge/malformed PDFs").
 *
 * SCOPE: every upload route in this app already uses multer's
 * memoryStorage() — nothing is ever written to disk keyed by a
 * user-supplied filename, so there is no filesystem path built from
 * `originalname` for an attacker to traverse with `../../` in the first
 * place. That class of vulnerability doesn't exist here by construction;
 * this module is defense-in-depth on top of that for the PDF-specific
 * risks (a PDF can embed JavaScript, launch actions, or other executable
 * content; a byte stream can also just be *not actually a PDF* despite its
 * extension/declared MIME type).
 */

const PDF_MAGIC = Buffer.from('%PDF-');

// A conservative denylist of PDF dictionary keys associated with active
// content or embedded files. This is a heuristic scan of the raw bytes —
// NOT a substitute for a real sanitizer — but it's enough to catch the
// overwhelmingly common case (a PDF crafted to auto-run something when
// opened) and to refuse it outright rather than hand it to the parser.
const SUSPICIOUS_TOKENS = [
  '/JavaScript', '/JS', '/Launch', '/EmbeddedFile', '/OpenAction', '/AA',
];

function validatePdfBuffer(buffer, { maxBytes = 20 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, reason: 'Empty or unreadable file.' };
  }
  if (buffer.length > maxBytes) {
    return { ok: false, reason: `File exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.` };
  }
  // Real magic-byte check — never trust the declared extension/MIME alone.
  // A PDF's header can be preceded by up to ~1KB of garbage per spec, but
  // requiring it in the first 1024 bytes is a reasonable, tighter bar than
  // trusting Content-Type, and matches what every major PDF reader accepts.
  const head = buffer.subarray(0, 1024);
  if (head.indexOf(PDF_MAGIC) === -1) {
    return { ok: false, reason: 'File does not have a valid PDF signature — it may be mislabeled or corrupted.' };
  }

  const asLatin1 = buffer.toString('latin1'); // byte-preserving, cheap, fine for a substring scan of PDF names
  const hit = SUSPICIOUS_TOKENS.find(tok => asLatin1.includes(tok));
  if (hit) {
    return { ok: false, reason: `This PDF contains an active-content marker (${hit}) that is not accepted for security reasons. Please upload a static/flattened PDF, or an Excel/CSV export instead.` };
  }

  return { ok: true };
}

module.exports = { validatePdfBuffer };
