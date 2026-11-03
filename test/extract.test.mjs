// test/extract.test.mjs — validates deterministic extractors against a synthetic invoice.
import { extractInvoice, extractKeyData, pageSlice, toBuffer } from '../src/extract.mjs';

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

const INVOICE = `ACME SUPPLY LTD
1200 Industrial Way, Makati
Invoice No: INV-2026-1042
Issue Date: 2026-10-01
Due Date: 2026-10-31
PO Number: PO-7781
Subtotal 1,000.00
VAT 12%: 120.00
Grand Total: USD 1,120.00
Email: ap@acmesupply.com
Terms: https://acme.com/terms`;

console.log('--- extractInvoice ---');
const inv = extractInvoice(INVOICE);
check('invoice_number', inv.invoice_number, 'INV-2026-1042');
check('total', inv.total, 1120);
check('currency', inv.currency, 'USD');
check('issue_date', inv.issue_date, '2026-10-01');
check('due_date', inv.due_date, '2026-10-31');
check('purchase_order', inv.purchase_order, 'PO-7781');
check('vendor', inv.vendor, 'ACME SUPPLY LTD');
checkTruthy('confidence high', inv.confidence >= 0.83);
checkTruthy('tax detected', inv.tax_amount > 0);

console.log('--- extractKeyData ---');
const kd = extractKeyData(INVOICE);
check('emails', kd.emails, ['ap@acmesupply.com']);
check('currency', kd.currency, 'USD');
checkTruthy('urls', kd.urls.length >= 1);
checkTruthy('amounts', kd.amounts.includes(1120));
checkTruthy('companies', kd.companies.some((c) => /ACME/i.test(c)));

console.log('--- pageSlice ---');
check('page2', pageSlice('abcdefghij', 2, 3), { page: 2, total_pages: 4, text: 'def' });
check('page clamp', pageSlice('abcdefghij', 99, 3).page, 4);

console.log('--- toBuffer guards ---');
checkTruthy('accepts data-uri', toBuffer('data:application/pdf;base64,JVBERi0=').subarray(0, 5).toString() === '%PDF-');
let threw = false;
try { toBuffer('!!!not base64!!!'); } catch { threw = true; }
checkTruthy('rejects bad base64', threw);
threw = false;
try { toBuffer(''); } catch { threw = true; }
checkTruthy('rejects empty', threw);

console.log(`\nRESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
