const { PDFDocument, StandardFonts } = require('pdf-lib');
const { parsePdfSoa } = require('../../src/utils/pdfParser');
const { validatePdfBuffer } = require('../../src/utils/fileSecurity');

async function buildTestPdf(lines) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([500, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let y = 360;
  lines.forEach(l => { page.drawText(l, { x: 20, y, size: 10, font }); y -= 18; });
  return Buffer.from(await doc.save());
}

describe('fileSecurity.validatePdfBuffer', () => {
  test('rejects a buffer with no PDF magic bytes', () => {
    const r = validatePdfBuffer(Buffer.from('not a pdf at all'));
    expect(r.ok).toBe(false);
  });

  test('rejects an oversized buffer', () => {
    const r = validatePdfBuffer(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10)]), { maxBytes: 5 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/exceeds/i);
  });

  test('rejects a PDF-shaped buffer carrying an active-content marker', () => {
    const malicious = Buffer.from('%PDF-1.4\n1 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj');
    const r = validatePdfBuffer(malicious);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/JavaScript/);
  });

  test('accepts a plain, well-formed PDF header', () => {
    const r = validatePdfBuffer(Buffer.from('%PDF-1.7\n%normal pdf content here, no active markers\n'));
    expect(r.ok).toBe(true);
  });
});

describe('parsePdfSoa — real PDF text extraction', () => {
  test('extracts recognisable transaction lines with a high confidence score', async () => {
    const buf = await buildTestPdf([
      'Statement of Account',
      'Doc No       Date          Amount',
      'INV-1001     2026-01-05    10,000.00',
      'INV-1002     2026-01-15    5,000.00',
      'CN-2001      2026-01-20    -500.00',
    ]);
    const result = await parsePdfSoa(buf);
    expect(result.format_detected).toBe('PDF_TEXT_EXTRACTED');
    expect(result.items.length).toBeGreaterThanOrEqual(3);
    const amounts = result.items.map(i => i.amount).sort((a, b) => a - b);
    expect(amounts).toContain(10000);
    expect(amounts).toContain(5000);
    expect(amounts).toContain(-500);
  });

  test('never fabricates line items from a PDF with no amount-shaped text — low confidence, empty items, clear warning', async () => {
    const buf = await buildTestPdf(['This PDF has no tabular data at all.', 'Just some prose with numbers like 2026 in it.']);
    const result = await parsePdfSoa(buf);
    expect(result.items).toEqual([]);
    expect(result.format_detected).toBe('PDF_LOW_CONFIDENCE');
    expect(result.warning).toMatch(/original file is preserved/i);
  });

  test('a non-PDF buffer is rejected before parsing is even attempted', async () => {
    const result = await parsePdfSoa(Buffer.from('this is definitely not a pdf'));
    expect(result.items).toEqual([]);
    expect(result.format_detected).toBe('PDF_REJECTED');
    expect(result.warning).toBeTruthy();
  });

  test('a PDF carrying a /JavaScript marker is rejected, never parsed', async () => {
    const malicious = Buffer.from('%PDF-1.4\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n%%EOF');
    const result = await parsePdfSoa(malicious);
    expect(result.format_detected).toBe('PDF_REJECTED');
    expect(result.items).toEqual([]);
  });
});
