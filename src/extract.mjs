// src/extract.mjs — deterministic PDF/text intelligence. No LLM call => no per-request token cost.
// Margin model: compute is ~0, so gross margin ≈ 100% (x402 takes no platform fee).
import { extractText, getDocumentProxy } from 'unpdf';
import { createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');


const LIMIT = 400_000; // char cap guards memory

/** Accept raw base64 (data-uri tolerated) and return a Buffer. */
export const toBuffer = (b64) => {
  if (typeof b64 !== 'string' || !b64.length) throw Object.assign(new Error('pdf_base64 required'), { status: 400 });
  const clean = b64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) throw Object.assign(new Error('pdf_base64 is not valid base64'), { status: 400 });
  return Buffer.from(clean, 'base64');
};

/** Pull text + structural metadata out of a PDF buffer. */
export const readPdf = async (buf, maxPages = 200) => {
  if (buf.subarray(0, 5).toString() !== '%PDF-') {
    throw Object.assign(new Error('payload is not a PDF (missing %PDF- header)'), { status: 415 });
  }
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buf));
  } catch (e) {
    throw Object.assign(new Error(`could not parse PDF: ${e.message}`), { status: 422 });
  }
  const pages = pdf.numPages || 0;
  if (pages > maxPages) throw Object.assign(new Error(`PDF has ${pages} pages, limit is ${maxPages}`), { status: 413 });

  const { text } = await extractText(pdf, { mergePages: true });
  const raw = String(text || '');
  const meta = await pdf.getMetadata().catch(() => ({ info: {} }));
  const info = meta?.info || {};

  const clean = raw.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return {
    pages,
    chars: clean.length,
    text: clean.slice(0, LIMIT),
    truncated: clean.length > LIMIT,
    words: clean ? clean.split(/\s+/).filter(Boolean).length : 0,
    hasTextLayer: clean.length > 20,
    meta: {
      title: info.Title || null,
      author: info.Author || null,
      producer: info.Producer || null,
      creator: info.Creator || null,
      createdAt: info.CreationDate || null,
    },
  };
};


/* ---------------- deterministic field extractors (zero token cost) ---------------- */

const NUM = String.raw`(-?\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,4})?|-?\d+(?:\.\d{1,4})?)`;

const toNumber = (s) => {
  if (s === null || s === undefined) return null;
  const n = Number(String(s).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const findCurrency = (t) => {
  const map = [
    [/€/g, 'EUR'], [/£/g, 'GBP'], [/¥/g, 'JPY'], [/₱/g, 'PHP'], [/₹/g, 'INR'], [/\$/g, 'USD'],
    [/\bEUR\b/gi, 'EUR'], [/\bGBP\b/gi, 'GBP'], [/\bPHP\b/gi, 'PHP'], [/\bINR\b/gi, 'INR'],
    [/\bCAD\b/gi, 'CAD'], [/\bAUD\b/gi, 'AUD'], [/\bSGD\b/gi, 'SGD'], [/\bAED\b/gi, 'AED'],
    [/\bUSD\b/gi, 'USD'],
  ];
  const hits = {};
  for (const [re, code] of map) {
    const m = t.match(re);
    if (m) hits[code] = (hits[code] || 0) + m.length;
  }
  const best = Object.entries(hits).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
};

const grabAll = (re, t, cap = 200) => {
  const out = [];
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = rx.exec(t)) !== null) {
    out.push(m);
    if (m.index === rx.lastIndex) rx.lastIndex++;
    if (out.length >= cap) break;
  }
  return out;
};

const DATE_PATTERNS = [
  /\b(\d{4}-\d{2}-\d{2})\b/,
  /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/,
  /\b(\d{1,2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*-\d{2,4})\b/i,
  // "1 Oct 2026" — day-first with a month name, very common on invoices.
  // Must come before the month-first pattern so "1 Oct 2026" isn't read as "Oct 2026".
  /\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{2,4})\b/i,
  /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/i,
];


const uniq = (arr, n = 25) => [...new Set(arr)].slice(0, n);


export const extractInvoice = (text) => {
  const t = text || '';
  const lines = t.split('\n');
  const joined = t.replace(/\n/g, ' ');

  const labelledAmounts = [];
  for (const m of grabAll(/(?:grand\s*total|amount\s*due|balance\s*due|total\s*payable|total)\s*[:\-]?\s*[^\d\-]{0,4}(\d[\d,.\s]*)/gi, joined)) {
    const v = toNumber(m[1]);
    if (v !== null && v > 0) labelledAmounts.push(v);
  }

  // totals fall back to the largest amount seen in any of the three currency shapes
  const anyAmounts = [
    ...grabAll(new RegExp(`[\\$€£¥₱₹]\\s?${NUM}`, 'gi'), joined).map((m) => toNumber(m[1])),
    ...grabAll(new RegExp(`${NUM}\\s?(?:USD|EUR|GBP|PHP|INR|CAD|AUD|SGD)\\b`, 'gi'), joined).map((m) => toNumber(m[1])),
    ...grabAll(new RegExp(`(?:USD|EUR|GBP|PHP|INR|CAD|AUD|SGD)\\s?${NUM}\\b`, 'gi'), joined).map((m) => toNumber(m[1])),
  ].filter((v) => v !== null && v > 0);

  const total = labelledAmounts.length ? Math.max(...labelledAmounts) : anyAmounts.length ? Math.max(...anyAmounts) : null;

  // Tax amount, two passes. Labels often carry the RATE ("VAT 12%: 120.00"), and a
  // single-pass regex would capture the rate (12) instead of the amount (120.00),
  // which then makes every downstream subtotal+tax check fail.
  const tax = (() => {
    const explicit = grabAll(/(?:sales\s*)?(?:tax|vat|gst|hst)\s*(?:\([^)]*\)|\d{1,2}(?:\.\d+)?\s*%)?\s*[:\-]\s*[^\d\-]{0,4}(\d[\d,.]*)/gi, joined)
      .map((m) => toNumber(m[1]))
      .filter((v) => v !== null && v >= 0);
    if (explicit.length) return explicit;
    return grabAll(/(?:sales\s*)?(?:tax|vat|gst|hst)\s*(?:\([^)]*\))?\s*[:\-]?\s*[^\d\-]{0,4}(\d[\d,.]*)/gi, joined)
      .map((m) => toNumber(m[1]))
      .filter((v) => v !== null && v >= 0);
  })();


  const invoiceNumber = (joined.match(/(?:invoice|inv|bill)\s*(?:no\.?|number|#)?\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-\/_]{2,24})/i) || [])[1] || null;

  const dueDateRaw = (joined.match(/due\s*(?:date|on|by)?\s*[:\-]?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})/i) || [])[1] || null;

  const issueDateRaw = (() => {
    for (const re of DATE_PATTERNS) {
      const m = joined.match(re);
      if (m) return m[1];
    }
    return null;
  })();

  const purchaseOrder = (joined.match(/\b(?:p\.?o\.?|purchase\s*order)\s*(?:no\.?|number|#)?\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-\/_]{2,24})/i) || [])[1] || null;
  const currency = findCurrency(t);

  const vendor = (() => {
    for (const l of lines.slice(0, 25)) {
      const s = l.trim();
      if (s.length < 3 || s.length > 60) continue;
      if (/^(invoice|receipt|bill|statement|tax invoice|page)\b/i.test(s)) continue;
      if (/^[\d\s\-\/.,:]+$/.test(s)) continue;
      if (/(total|amount due|subtotal|balance)/i.test(s)) continue;
      return s;
    }
    return null;
  })();

  const emails = uniq((t.match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi) || []).map((e) => e.toLowerCase()), 10);
  const lineItemCount = lines.filter((l) => /\d[\d,.]*\s*$/.test(l.trim()) && /[A-Za-z]/.test(l)).length;

  const signals = [total, invoiceNumber, currency, dueDateRaw, issueDateRaw, vendor].filter((x) => x !== null && x !== undefined).length;
  return {
    invoice_number: invoiceNumber,
    vendor,
    currency,
    total,
    tax_amount: tax.length ? Math.max(...tax) : null,
    tax_rates_seen: uniq(tax, 10),
    issue_date: issueDateRaw,
    due_date: dueDateRaw,
    purchase_order: purchaseOrder,
    amounts_detected: uniq(anyAmounts, 40),
    line_item_candidates: lineItemCount,
    emails,
    fields_found: signals,
    confidence: Math.round((signals / 6) * 100) / 100,
  };
};

export const extractKeyData = (text) => {
  const t = text || '';
  // amounts: cover all three real-world shapes — $1,120 / 1,120 USD / USD 1,120
  const money = [
    ...grabAll(new RegExp(`[\\$€£¥₱₹]\\s?${NUM}`, 'gi'), t).map((m) => toNumber(m[1])),
    ...grabAll(new RegExp(`${NUM}\\s?(?:USD|EUR|GBP|PHP|INR|CAD|AUD|SGD|AED|JPY)\\b`, 'gi'), t).map((m) => toNumber(m[1])),
    ...grabAll(new RegExp(`(?:USD|EUR|GBP|PHP|INR|CAD|AUD|SGD|AED|JPY)\\s?${NUM}\\b`, 'gi'), t).map((m) => toNumber(m[1])),
  ].filter((v) => v !== null);
  return {
    emails: uniq((t.match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi) || []).map((e) => e.toLowerCase())),
    phones: uniq(t.match(/(?:\+\d{1,3}[\s\-.]?)?\(?\d{2,4}\)?[\s\-.]?\d{3}[\s\-.]?\d{3,4}\b/g) || []),
    urls: uniq(t.match(/https?:\/\/[^\s)<>"']+/gi) || []),
    dates: uniq(DATE_PATTERNS.flatMap((re) => grabAll(re, t).map((m) => m[1]))),
    amounts: uniq(money).sort((a, b) => b - a).slice(0, 25),
    currency: findCurrency(t),
    percentages: uniq(t.match(/\b\d{1,3}(?:\.\d+)?\s?%/g) || []),
    ids: uniq(t.match(/\b(?:[A-Z]{2,6}[-\/]?\d{4,12}|#\d{4,12})\b/g) || []),
    labelled_names: uniq(grabAll(/(?:name|client|customer|patient|student|employee)\s*[:\-]\s*([A-Z][A-Za-z.\-' ]{2,40})/gi, t).map((m) => m[1].trim())),
    // case-insensitive so ALL-CAPS letterheads ("ACME SUPPLY LTD") are captured, not just Title Case
    companies: uniq(grabAll(/\b([A-Z][A-Za-z&.'\- ]{2,40}?(?:Inc|LLC|Ltd|Limited|Corp|Corporation|GmbH|PLC|Pty)\.?)\b/gi, t).map((m) => m[1].trim())),
    streets: uniq(grabAll(/\b(\d{1,5}\s+[A-Z][A-Za-z.\- ]{3,40}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way))\b/gi, t).map((m) => m[1].trim())),
  };
};

/* ---------------- audit-grade invoice decision (premium tier) ---------------- */
// Why this exists: raw field extraction is a commodity (median $0.002/call, ~57 buyers).
// The thing an AP/audit team actually pays for is a DECISION with reason codes and an
// idempotency hash they can dedupe against — "should I pay this, and have I seen it
// before?". Still 100% deterministic: no LLM, so per-call cost stays ~0.

const neg = (re, t) => {
  const m = grabAll(re, t).map((x) => toNumber(x[1])).filter((v) => v !== null && v >= 0);
  return m.length ? Math.max(...m) : null;
};

/** yyyy-mm-dd from the several shapes invoices actually use; null if unparseable. */
const toISODate = (s) => {
  if (!s) return null;
  const str = String(s).trim();
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yr}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  }
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const parseLooseDate = (s) => {
  if (!s) return null;
  const str = String(s).trim();

  // Month-name shapes first — Date() cannot be trusted to order day/month/year.
  // Try day-first ("1 Oct 2026"), then month-first ("Oct 1, 2026").
  const dm = str.match(/(\d{1,2})\s*[\-\s\/]?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s*[\-\s\/,]?\s*(\d{2,4})?/i);
  const md = str.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*[\-\s\/,]?\s*(\d{1,2})\s*,?\s*(\d{2,4})?/i);
  const parts = dm && MONTHS[dm[2].toLowerCase().slice(0, 3)]
    ? { day: Number(dm[1]), mon: MONTHS[dm[2].toLowerCase().slice(0, 3)], yr: dm[3] }
    : md && MONTHS[md[1].toLowerCase().slice(0, 3)]
      ? { day: Number(md[2]), mon: MONTHS[md[1].toLowerCase().slice(0, 3)], yr: md[3] }
      : null;

  if (parts && parts.mon && parts.day >= 1 && parts.day <= 31) {
    const year = parts.yr ? (String(parts.yr).length === 2 ? `20${parts.yr}` : String(parts.yr)) : String(new Date().getUTCFullYear());
    return `${year}-${String(parts.mon).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  }
  return toISODate(str);
};



/**
 * Deterministic AP-style audit. Returns a decision, not just data.
 * @param {string} text extracted document text
 * @param {{now?: Date, maxAgeDays?: number, tolerance?: number}} opts
 */
export const auditInvoice = (text, opts = {}) => {
  const t = text || '';
  const joined = t.replace(/\n/g, ' ');
  const now = opts.now instanceof Date ? opts.now : new Date();
  const maxAgeDays = Number(opts.maxAgeDays ?? 365);
  const tolAbs = Number(opts.tolerance ?? 0.02); // 2 cents rounding slack
  const tolRel = 0.005;                           // or 0.5%, whichever is looser

  const fields = extractInvoice(t);
  const subtotal = neg(/(?:sub\s*total|subtotal|net\s*total|net\s*amount|goods\s*total)\s*[:\-]?\s*[^\d\-]{0,4}(\d[\d,.\s]*)/gi, joined);
  const taxAmount = fields.tax_amount;
  const total = fields.total;

  const issue = parseLooseDate(fields.issue_date);
  const due = parseLooseDate(fields.due_date);

  const findings = [];
  const add = (code, severity, detail) => findings.push({ code, severity, detail });

  // 1. required-field presence
  const required = [
    ['invoice_number', fields.invoice_number],
    ['vendor', fields.vendor],
    ['total', total],
    ['currency', fields.currency],
    ['issue_date', issue],
  ];
  for (const [name, v] of required) {
    if (v === null || v === undefined || v === '') {
      add(`MISSING_${name.toUpperCase()}`, name === 'total' || name === 'invoice_number' ? 'critical' : 'major', `${name} could not be extracted`);
    }
  }

  // 2. arithmetic: subtotal + tax should equal total
  let mathOk = null;
  if (subtotal !== null && total !== null) {
    const expected = subtotal + (taxAmount ?? 0);
    const slack = Math.max(tolAbs, Math.abs(total) * tolRel);
    mathOk = Math.abs(expected - total) <= slack;
    if (!mathOk) {
      add('MATH_MISMATCH', 'critical', `subtotal ${subtotal} + tax ${taxAmount ?? 0} = ${Number(expected.toFixed(2))} but total is ${total}`);
    }
  } else if (subtotal === null) {
    add('NO_SUBTOTAL', 'minor', 'no subtotal line found; line-item math could not be verified');
  }

  // 3. tax sanity
  if (taxAmount !== null && total !== null && taxAmount > total) {
    add('TAX_EXCEEDS_TOTAL', 'critical', `tax ${taxAmount} > total ${total}`);
  }
  if (taxAmount !== null && subtotal !== null && subtotal > 0) {
    const rate = (taxAmount / subtotal) * 100;
    if (rate > 35) add('IMPLAUSIBLE_TAX_RATE', 'major', `tax is ${rate.toFixed(1)}% of subtotal; typical is 0-27%`);
  }

  // 4. date ordering and staleness
  if (issue && due && due < issue) add('DUE_BEFORE_ISSUE', 'major', `due ${due} precedes issue ${issue}`);
  if (issue) {
    const ageDays = Math.floor((now - new Date(`${issue}T00:00:00Z`)) / 86_400_000);
    if (ageDays > maxAgeDays) add('STALE_DOCUMENT', 'minor', `issued ${ageDays} days ago (threshold ${maxAgeDays})`);
    if (ageDays < -2) add('FUTURE_DATED', 'major', `issued ${-ageDays} days in the future`);
  }

  // 5. conflicting totals: several distinct "total-ish" figures is the classic
  //    signature of a multi-invoice bundle or a tampered document.
  const totalCandidates = uniq([
    ...grabAll(/(?:grand\s*total|amount\s*due|balance\s*due|total\s*payable|total)\s*[:\-]?\s*[^\d\-]{0,4}(\d[\d,.\s]*)/gi, joined).map((m) => toNumber(m[1])),
  ].filter((v) => v !== null && v > 0), 20);
  if (totalCandidates.length > 1) {
    const spread = Math.max(...totalCandidates) - Math.min(...totalCandidates);
    if (spread > Math.max(tolAbs, Math.max(...totalCandidates) * 0.25)) {
      add('CONFLICTING_TOTALS', 'major', `${totalCandidates.length} differing total figures found (${totalCandidates.join(', ')})`);
    }
  }

  // 6. total below subtotal with no discount/credit line
  if (subtotal !== null && total !== null && total < subtotal && !/(discount|credit|less|minus|rebate)/i.test(joined)) {
    add('TOTAL_BELOW_SUBTOTAL', 'major', `total ${total} < subtotal ${subtotal} with no discount line`);
  }

  // 7. text-layer detection: an OCR'd scan can silently drop a decimal point
  if (t.trim().length < 40) add('LOW_TEXT_CONTENT', 'critical', 'document has almost no extractable text (likely a scanned image)');

  const critical = findings.filter((f) => f.severity === 'critical').length;
  const major = findings.filter((f) => f.severity === 'major').length;
  const minor = findings.filter((f) => f.severity === 'minor').length;

  const decision = critical > 0 ? 'reject' : major > 0 ? 'review' : 'approve';
  const riskScore = Math.min(100, critical * 40 + major * 15 + minor * 5);

  return {
    decision,
    risk_score: riskScore,
    checks_run: 7,
    checks_failed: findings.length,
    findings,
    fields_found: fields.fields_found,
    confidence: fields.confidence,
    // Idempotency key for duplicate-payment prevention: identical invoice content
    // yields an identical hash, so a second submission is caught before payment.
    dedupe_key: sha256([
      String(fields.invoice_number ?? '').toUpperCase().trim(),
      String(fields.vendor ?? '').toLowerCase().replace(/\s+/g, ' ').trim(),
      total ?? '',
      fields.currency ?? '',
      issue ?? '',
    ].join('|')),
    extracted: {
      invoice_number: fields.invoice_number,
      vendor: fields.vendor,
      currency: fields.currency,
      total,
      subtotal,
      tax_amount: taxAmount,
      issue_date: issue,
      due_date: due,
      purchase_order: fields.purchase_order,
    },
    audit: { math_verified: mathOk, tolerance_abs: tolAbs, max_age_days: maxAgeDays, as_of: now.toISOString().slice(0, 10) },
  };
};


export const pageSlice = (text, page, perPage) => {
  const chars = (text || '').length;
  const total = Math.max(1, Math.ceil(chars / Math.max(1, perPage)));
  const p = Math.min(Math.max(1, Number(page) || 1), total);
  const start = (p - 1) * perPage;
  return { page: p, total_pages: total, text: (text || '').slice(start, start + perPage) };
};
