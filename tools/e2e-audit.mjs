// tools/e2e-audit.mjs — end-to-end: real PDF bytes -> unpdf -> auditInvoice.
// Unit tests inject text directly, which skips the PDF parser. This covers the
// part that actually breaks in production: layout, encoding, and text ordering.
import { readPdf, auditInvoice } from '../src/extract.mjs';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -> ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

/** Build a minimal but spec-valid single-page PDF with real text operators. */
const makePdf = (lines) => {
  const esc = (s) => s.replace(/([\\()])/g, '\\$1');
  const content = ['BT', '/F1 11 Tf', '14 TL', '72 720 Td', ...lines.map((l) => `(${esc(l)}) Tj T*`), 'ET'].join('\n');

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
};

const INVOICE_LINES = [
  'ACME SUPPLY LTD',
  '1200 Industrial Way, Makati',
  'Invoice No: INV-2026-1042',
  'Issue Date: 2026-10-01',
  'Due Date: 2026-10-31',
  'Subtotal 1,000.00',
  'VAT 12%: 120.00',
  'Grand Total: USD 1,120.00',
  'Email: ap@acmesupply.com',
];

console.log('--- real PDF: clean invoice ---');
const pdf = makePdf(INVOICE_LINES);
checkTruthySize(pdf);
function checkTruthySize(buf) { check('generated valid %PDF- header', buf.subarray(0, 5).toString() === '%PDF-', `${buf.length} bytes`); }

const doc = await readPdf(pdf);
check('pages parsed', doc.pages === 1, String(doc.pages));
check('has text layer', doc.hasTextLayer === true, `${doc.chars} chars`);
check('words extracted', doc.words >= 15, String(doc.words));

const report = auditInvoice(doc.text, { now: new Date('2026-11-03T00:00:00Z') });
check('decision approve', report.decision === 'approve', report.decision);
check('total 1120', report.extracted.total === 1120, String(report.extracted.total));
check('subtotal 1000', report.extracted.subtotal === 1000, String(report.extracted.subtotal));
check('tax 120', report.extracted.tax_amount === 120, String(report.extracted.tax_amount));
check('math verified', report.audit.math_verified === true, String(report.audit.math_verified));
check('invoice number', report.extracted.invoice_number === 'INV-2026-1042', String(report.extracted.invoice_number));
check('vendor parsed', /ACME/i.test(String(report.extracted.vendor)), String(report.extracted.vendor));
check('sha256 dedupe_key', /^[0-9a-f]{64}$/.test(report.dedupe_key), report.dedupe_key.slice(0, 16) + '...');
check('zero risk', report.risk_score === 0, String(report.risk_score));

console.log('--- real PDF: tampered total ---');
const tampered = makePdf(INVOICE_LINES.map((l) => (l.startsWith('Grand Total') ? 'Grand Total: USD 9,999.00' : l)));
const r2 = auditInvoice((await readPdf(tampered)).text, { now: new Date('2026-11-03T00:00:00Z') });
check('decision reject', r2.decision === 'reject', r2.decision);
check('MATH_MISMATCH flagged', r2.findings.some((f) => f.code === 'MATH_MISMATCH'), r2.findings.map((f) => f.code).join(','));
check('different dedupe_key', r2.dedupe_key !== report.dedupe_key, 'hash changes with amount');

console.log('--- real PDF: multi-page-ish conflicting totals ---');
const messy = makePdf([...INVOICE_LINES, 'Amount Due: 500.00', 'Balance Due: 300.00']);
const r3 = auditInvoice((await readPdf(messy)).text, { now: new Date('2026-11-03T00:00:00Z') });
check('CONFLICTING_TOTALS flagged', r3.findings.some((f) => f.code === 'CONFLICTING_TOTALS'), r3.findings.map((f) => f.code).join(','));
check('does not approve', r3.decision !== 'approve', r3.decision);

console.log(`\nRESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
