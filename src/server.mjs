// src/server.mjs — DocIntel x402 API: document intelligence for AI agents, pay-per-call.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { config, warnIfUnconfigured, isMainnet } from './config.mjs';
import { toBuffer, readPdf, extractInvoice, extractKeyData, auditInvoice } from './extract.mjs';

export const app = express();
const started = Date.now();

app.use(express.json({ limit: config.limits.maxBodyBytes }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

const facilitatorClient = new HTTPFacilitatorClient({ url: config.facilitator });
const resourceServer = new x402ResourceServer(facilitatorClient).register(config.network, new ExactEvmScheme());

const route = (price, description, tags, example) => ({
  accepts: [{ scheme: 'exact', price, network: config.network, payTo: config.payTo }],
  description,
  mimeType: 'application/json',
  tags,
  extensions: {
    bazaar: {
      info: {
        input: { type: 'http', method: 'POST', bodyType: 'json', body: example.body },
        output: { type: 'json', example: example.output },
      },
      // The bazaar extension requires a JSON Schema that validates `info` itself.
      // Kept inline (no $ref/$id) because external schema refs are rejected.
      schema: {
        type: 'object',
        required: ['input'],
        properties: {
          input: {
            type: 'object',
            required: ['type'],
            properties: {
              type: { type: 'string', enum: ['http', 'mcp'] },
              method: { type: 'string', enum: ['GET', 'HEAD', 'DELETE', 'POST', 'PUT', 'PATCH'] },
              bodyType: { type: 'string', enum: ['json', 'form-data', 'text'] },
              body: { type: 'object' },
              queryParams: { type: 'object' },
            },
          },
          output: {
            type: 'object',
            required: ['type'],
            properties: {
              type: { type: 'string', enum: ['json', 'text'] },
              example: { type: 'object' },
            },
          },
        },
      },
    },
  },
});

export const routes = {
  'POST /v1/pdf/text': route(
    config.prices.pdfText,
    'Extract clean plaintext from a PDF (base64 in, merged text + metadata out).',
    ['pdf', 'text', 'extraction'],
    { body: { pdf_base64: '<base64 pdf>' }, output: { pages: 4, chars: 8123, words: 1340, has_text_layer: true, text: 'Invoice ...' } }
  ),
  'POST /v1/pdf/invoice': route(
    config.prices.pdfInvoice,
    'Structured invoice fields from a PDF: invoice number, vendor, total, tax, currency, dates, PO.',
    ['pdf', 'invoice', 'finance', 'accounts-payable'],
    { body: { pdf_base64: '<base64 pdf>' }, output: { invoice_number: 'INV-1042', vendor: 'Acme Ltd', currency: 'USD', total: 1250, confidence: 1 } }
  ),
  'POST /v1/doc/keydata': route(
    config.prices.docKeydata,
    'Regex-extracted key data from a PDF: emails, phones, URLs, dates, amounts, companies, addresses.',
    ['pdf', 'entities', 'structured-data'],
    { body: { pdf_base64: '<base64 pdf>' }, output: { emails: ['ap@acme.com'], amounts: [1250], dates: ['2026-10-01'] } }
  ),
  // Premium tier: a DECISION, not fields. This is what AP/audit teams actually buy —
  // "should I pay this invoice, why/why not, and have I already paid it?" (dedupe_key).
  'POST /v1/invoice/audit': route(
    config.prices.invoiceValidate,
    'Audit-grade invoice decision: approve/review/reject with reason codes, math verification, and a dedupe_key for duplicate-payment prevention.',
    ['invoice', 'audit', 'compliance', 'accounts-payable', 'fraud'],
    {
      body: { pdf_base64: '<base64 pdf>' },
      output: {
        decision: 'review',
        risk_score: 15,
        checks_run: 7,
        checks_failed: 1,
        findings: [{ code: 'DUE_BEFORE_ISSUE', severity: 'major', detail: 'due 2026-01-05 precedes issue 2026-02-01' }],
        dedupe_key: '9f2c...e41a',
        extracted: { invoice_number: 'INV-1042', vendor: 'Acme Ltd', currency: 'USD', total: 1250, subtotal: 1213.59, tax_amount: 36.41, issue_date: '2026-02-01', due_date: '2026-03-03' },
        audit: { math_verified: true, tolerance_abs: 0.02, max_age_days: 365, as_of: '2026-11-03' },
      },
    }
  ),
};


// MUST be registered before the handlers below, otherwise Express serves them for free.
app.use(paymentMiddleware(routes, resourceServer));

/* ---------------- handlers ---------------- */

const fail = (res, e) => res.status(e.status || 500).json({ error: e.message });

const parseBody = async (req) => {
  const { pdf_base64, url } = req.body || {};
  if (pdf_base64) {
    const buf = toBuffer(pdf_base64);
    if (buf.length > config.limits.maxPdfBytes) throw Object.assign(new Error(`PDF exceeds ${config.limits.maxPdfBytes} bytes`), { status: 413 });
    return buf;
  }
  if (url) {
    let u;
    try { u = new URL(url); } catch { throw Object.assign(new Error('invalid url'), { status: 400 }); }
    if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('url must be http(s)'), { status: 400 });
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), config.limits.fetchTimeoutMs);
    try {
      const r = await fetch(u, { signal: ctl.signal, headers: { 'User-Agent': 'docintel-x402/1.0' } });
      if (!r.ok) throw Object.assign(new Error(`upstream returned ${r.status}`), { status: 502 });
      const ab = await r.arrayBuffer();
      if (ab.byteLength > config.limits.maxPdfBytes) throw Object.assign(new Error('remote PDF too large'), { status: 413 });
      return Buffer.from(ab);
    } finally { clearTimeout(t); }
  }
  throw Object.assign(new Error('provide pdf_base64 or url'), { status: 400 });
};

app.post('/v1/pdf/text', async (req, res) => {
  try {
    const doc = await readPdf(await parseBody(req), req.body?.max_pages || config.limits.maxPdfPages);
    res.json({
      pages: doc.pages, chars: doc.chars, words: doc.words, has_text_layer: doc.hasTextLayer,
      truncated: doc.truncated, text: doc.text, metadata: doc.meta,
      notice: doc.hasTextLayer ? undefined : 'No text layer (likely scanned). OCR is not supported.',
    });
  } catch (e) { fail(res, e); }
});

app.post('/v1/pdf/invoice', async (req, res) => {
  try {
    const doc = await readPdf(await parseBody(req));
    res.json({ ...extractInvoice(doc.text), meta: { pages: doc.pages, chars: doc.chars, has_text_layer: doc.hasTextLayer } });
  } catch (e) { fail(res, e); }
});

app.post('/v1/doc/keydata', async (req, res) => {
  try {
    const doc = await readPdf(await parseBody(req));
    res.json({ ...extractKeyData(doc.text), meta: { pages: doc.pages, chars: doc.chars } });
  } catch (e) { fail(res, e); }
});

app.post('/v1/invoice/audit', async (req, res) => {
  try {
    const doc = await readPdf(await parseBody(req));
    const maxAgeDays = req.body?.max_age_days ? Number(req.body.max_age_days) : 365;
    const report = auditInvoice(doc.text, { maxAgeDays });
    res.json({ ...report, meta: { pages: doc.pages, chars: doc.chars, has_text_layer: doc.hasTextLayer } });
  } catch (e) { fail(res, e); }
});


/* ---------------- free discovery + ops ---------------- */

app.get('/', (_req, res) => {
  res.json({
    service: 'docintel-x402',
    tagline: 'Document intelligence for AI agents. Pay-per-call, no API key.',
    protocol: `x402 v2 · ${config.network} · scheme=exact`,
    mode: config.mode,
    network: config.network,
    payTo: config.payTo,
    payWith: isMainnet ? 'USDC on Base' : 'USDC on Base Sepolia (test USDC)',
    endpoints: Object.entries(routes).map(([k, cfg]) => ({
      route: k,
      url: k.split(' ')[1],
      price: cfg.accepts[0].price,
      description: cfg.description,
      tags: cfg.tags,
    })),
    howToCall: [
      '1. Call an endpoint with no payment header -> HTTP 402 + payment requirements.',
      '2. Sign an EIP-3009 transferWithAuthorization for the exact amount (gasless for you).',
      '3. Replay with header PAYMENT-SIGNATURE: <base64 JSON payload>.',
      '4. Receive JSON. Settlement happens on-chain; the facilitator pays gas.',
    ],
    notes: 'Echo the bazaar extension on payment to index this service. Scanned/image-only PDFs need OCR and are unsupported.',
  });
});

app.get('/health', (_req, res) =>
  res.json({ ok: true, mode: config.mode, network: config.network, facilitator: config.facilitator, uptime_s: Math.round((Date.now() - started) / 1000) })
);

/** Test hook: extract logic without payment, used only by local tests when ALLOW_LOCAL_TEST=1. */
export const testHarness = async ({ pdf_base64, max_pages }) => readPdf(toBuffer(pdf_base64), max_pages || config.limits.maxPdfPages);

export const start = () => {
  warnIfUnconfigured().forEach((w) => console.warn('[CONFIG WARN]', w));
  return app.listen(config.port, () => {
    console.log(`DocIntel x402 listening on :${config.port}  mode=${config.mode} network=${config.network}`);
    console.log(`facilitator=${config.facilitator}`);
    console.log(`payTo=${config.payTo}`);
    console.log('prices:', JSON.stringify(config.prices));
  });
};

// Only auto-start when this file is the process entry point (not when imported by tests).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) start();
