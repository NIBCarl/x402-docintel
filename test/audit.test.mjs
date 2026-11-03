// test/audit.test.mjs — validates the premium audit-tier decision engine.
import { auditInvoice } from '../src/extract.mjs';

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} -> ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
  ok ? pass++ : fail++;
};
const checkTruthy = (name, actual) => {
  const ok = Boolean(actual);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} -> ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
};

const NOW = new Date('2026-11-03T00:00:00Z');

// A clean, internally consistent invoice: subtotal + tax === total, valid dates.
const CLEAN = `ACME SUPPLY LTD
1200 Industrial Way, Makati
Invoice No: INV-2026-1042
Issue Date: 2026-10-01
Due Date: 2026-10-31
Subtotal 1,000.00
VAT 12%: 120.00
Grand Total: USD 1,120.00
Email: ap@acmesupply.com`;

console.log('--- clean invoice -> approve ---');
const good = auditInvoice(CLEAN, { now: NOW });
check('decision', good.decision, 'approve');
check('risk_score', good.risk_score, 0);
check('checks_run', good.checks_run, 7);
check('math_verified', good.audit.math_verified, true);
check('extracted total', good.extracted.total, 1120);
check('extracted subtotal', good.extracted.subtotal, 1000);
checkTruthy('dedupe_key is sha256 hex', /^[0-9a-f]{64}$/.test(good.dedupe_key));

console.log('--- dedupe_key stability ---');
check('same content -> same key', auditInvoice(CLEAN, { now: NOW }).dedupe_key, good.dedupe_key);
checkTruthy('different invoice -> different key', auditInvoice(CLEAN.replace('INV-2026-1042', 'INV-2026-9999'), { now: NOW }).dedupe_key !== good.dedupe_key);

console.log('--- math mismatch -> reject ---');
const badMath = auditInvoice(CLEAN.replace('Grand Total: USD 1,120.00', 'Grand Total: USD 9,999.00'), { now: NOW });
check('decision', badMath.decision, 'reject');
check('math_verified', badMath.audit.math_verified, false);
checkTruthy('MATH_MISMATCH reported', badMath.findings.some((f) => f.code === 'MATH_MISMATCH'));
checkTruthy('risk_score high', badMath.risk_score >= 40);

console.log('--- due before issue -> review ---');
const badDates = auditInvoice(CLEAN.replace('Due Date: 2026-10-31', 'Due Date: 2026-09-01'), { now: NOW });
check('decision', badDates.decision, 'review');
checkTruthy('DUE_BEFORE_ISSUE reported', badDates.findings.some((f) => f.code === 'DUE_BEFORE_ISSUE'));

console.log('--- stale document -> minor finding, still approves ---');
const stale = auditInvoice(CLEAN, { now: new Date('2028-11-03T00:00:00Z'), maxAgeDays: 365 });
checkTruthy('STALE_DOCUMENT reported', stale.findings.some((f) => f.code === 'STALE_DOCUMENT'));
check('stale alone does not block', stale.decision, 'approve');

console.log('--- future dated -> review ---');
const future = auditInvoice(CLEAN.replace('Issue Date: 2026-10-01', 'Issue Date: 2027-06-01').replace('Due Date: 2026-10-31', 'Due Date: 2027-07-01'), { now: NOW });
checkTruthy('FUTURE_DATED reported', future.findings.some((f) => f.code === 'FUTURE_DATED'));

console.log('--- implausible tax -> review ---');
const crazyTax = auditInvoice(CLEAN.replace('VAT 12%: 120.00', 'VAT 90%: 900.00'), { now: NOW });
checkTruthy('IMPLAUSIBLE_TAX_RATE reported', crazyTax.findings.some((f) => f.code === 'IMPLAUSIBLE_TAX_RATE'));

console.log('--- scanned / empty document -> reject ---');
const scanned = auditInvoice('', { now: NOW });
check('decision', scanned.decision, 'reject');
checkTruthy('LOW_TEXT_CONTENT reported', scanned.findings.some((f) => f.code === 'LOW_TEXT_CONTENT'));
checkTruthy('missing invoice number flagged', scanned.findings.some((f) => f.code === 'MISSING_INVOICE_NUMBER'));

console.log('--- missing subtotal -> minor only ---');
const noSubtotal = auditInvoice(CLEAN.replace('Subtotal 1,000.00\n', ''));
checkTruthy('NO_SUBTOTAL reported', noSubtotal.findings.some((f) => f.code === 'NO_SUBTOTAL'));
check('math not verifiable', noSubtotal.audit.math_verified, null);

console.log('--- month-name dates parse ---');
const named = auditInvoice(CLEAN.replace('Issue Date: 2026-10-01', 'Issue Date: 1 Oct 2026').replace('Due Date: 2026-10-31', 'Due Date: 31 Oct 2026'), { now: NOW });
check('issue parsed', named.extracted.issue_date, '2026-10-01');
check('due parsed', named.extracted.due_date, '2026-10-31');

console.log(`\nRESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
