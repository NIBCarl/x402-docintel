// src/discovery.mjs — the two free, static discovery documents.
//
//   GET /llms.txt               plain text, written for LLM crawlers
//   GET /.well-known/x402.json  machine-readable manifest of the four paid routes
//
// Both cost $0 to serve and are what well-built x402 sellers publish (Octodamus,
// Touchstone, OSF). They exist so an agent can learn the routes, prices and terms
// WITHOUT first paying for a 402, and so a directory entry has something to link to.
//
// Two rules keep these honest:
//   1. Everything is DERIVED from config.mjs and the same `routes` table the paywall
//      enforces. A reprice cannot leave a stale manifest behind.
//   2. Asset addresses come from the x402 SDK's own price parser, never hardcoded.
//      Hardcoding them is how a manifest ends up advertising the wrong token after
//      a testnet/mainnet switch.
//
// Nothing here is secret. `payTo` is a public receiving address that is already
// visible in every 402 challenge; no key material is read or emitted.

import { ExactEvmScheme } from '@x402/evm/exact/server';
import { config, isMainnet } from './config.mjs';

const scheme = new ExactEvmScheme();
const usd = (p) => Number(String(p).replace(/[^0-9.]/g, ''));

/**
 * Turn one route's price into real payment terms using the SDK's own parser, so the
 * `amount`/`asset`/`extra` in the manifest match byte-for-byte what the 402 issues.
 * Throws (rather than emitting a wrong asset) if the network is unsupported.
 */
const termsFor = async (price) => {
  const t = await scheme.parsePrice(usd(price), config.network);
  return { amount: t.amount, asset: t.asset, extra: t.extra };
};

/**
 * Build the static manifest served at /.well-known/x402.json.
 * @param {Record<string, object>} routes the same table the paywall enforces
 */
export const buildManifest = async (routes) => {
  const entries = await Promise.all(
    Object.entries(routes).map(async ([key, cfg]) => {
      const [method, routePath] = key.split(' ');
      return {
        method,
        path: routePath,
        url: `${config.publicUrl}${routePath}`,
        price: cfg.accepts[0].price,
        scheme: 'exact',
        network: config.network,
        ...(await termsFor(cfg.accepts[0].price)),
        description: cfg.description,
        mimeType: cfg.mimeType,
        tags: cfg.tags,
      };
    })
  );

  return {
    name: config.serviceName,
    description:
      'Document intelligence for AI agents: PDF text extraction, invoice field extraction, ' +
      'key-data mining, and audit-grade invoice decisions. Pay per call in USDC, no API key.',
    protocol: { name: 'x402', version: 2, scheme: 'exact' },
    network: config.network,
    networkLabel: isMainnet ? 'Base mainnet' : 'Base Sepolia (test USDC)',
    payTo: config.payTo,
    contact: 'https://github.com/NIBCarl/x402-docintel/issues',
    docs: { llmsTxt: `${config.publicUrl}/llms.txt`, serviceIndex: `${config.publicUrl}/` },
    endpoints: entries,
    howToCall: [
      'POST to an endpoint with no payment header -> HTTP 402 + base64 PAYMENT-REQUIRED challenge.',
      'Sign an EIP-3009 transferWithAuthorization for the exact amount (gasless for the buyer).',
      'Replay the request with header PAYMENT-SIGNATURE: <base64 JSON payload>.',
      'Receive JSON. The facilitator submits the authorization on-chain and pays the gas.',
    ],
    // Stated plainly so no directory or agent infers otherwise. An unindexed resource
    // is still callable; it just will not appear in a catalog search until settled.
    bazaarStatus: 'not_indexed',
    bazaarNote:
      'Not listed in the x402 Bazaar. Indexing is earned by a settled payment, not by deploying; ' +
      'no manual registration exists (POST /discovery/register returns 404). Calling this service ' +
      'works today regardless of catalog status.',
    generatedAt: new Date().toISOString(),
  };
};

/**
 * Build /llms.txt — the LLM-facing summary. Deliberately plain Markdown: agents that
 * read llms.txt parse headings and URLs, not JSON.
 * @param {Record<string, object>} routes the same table the paywall enforces
 */
export const buildLlmsTxt = (routes) => {
  const lines = [
    `# ${config.serviceName}`,
    '',
    '> Document intelligence for AI agents. Pay-per-call in USDC over x402 v2.',
    '> No API key, no signup, no account. Same input always returns the same output',
    '> (unpdf text layer + deterministic regex; zero LLM calls, nothing probabilistic).',
    '',
    '## What this is',
    '',
    `A paid HTTP API on ${isMainnet ? 'Base mainnet (eip155:8453)' : 'Base Sepolia (eip155:84532)'}.`,
    'Each call is metered individually. You pay for exactly the call you make, there is no',
    'subscription, and there is no free tier to sign up for. The paywall IS the auth: there',
    'are no tokens to request.',
    '',
    '## How to pay (x402 v2, scheme=exact)',
    '',
    '1. POST to an endpoint with no payment header. You get HTTP 402 plus a base64',
    '   `PAYMENT-REQUIRED` header describing amount, asset, payTo and network.',
    '2. Sign an EIP-3009 `transferWithAuthorization` for exactly that `amount`. The buyer',
    '   signs off-chain and needs no ETH: the facilitator submits and pays the gas.',
    '3. Replay the same request with `PAYMENT-SIGNATURE: <base64 JSON payload>`.',
    '4. Get JSON back. Settlement lands on-chain after the response.',
    '',
    'Base USDC uses EIP-712 domain `USD Coin` / version `2` with 6 decimals. Amounts are',
    'integers in micro-USDC, so $0.02 is `20000` (not `0.02`).',
    '',
    '## Endpoints',
    '',
    '| Method | Path | Price | What you get |',
    '|---|---|---|---|',
  ];

  for (const [key, cfg] of Object.entries(routes)) {
    const [method, routePath] = key.split(' ');
    lines.push(`| ${method} | \`${routePath}\` | ${cfg.accepts[0].price} | ${cfg.description} |`);
  }

  lines.push(
    '',
    '## Request format',
    '',
    'All endpoints take JSON. Send either `pdf_base64` (base64-encoded PDF) or `url`',
    '(an http(s) link to a PDF that is fetched once).',
    '',
    '```json',
    '{ "pdf_base64": "<base64 PDF>" }',
    '```',
    '',
    'Optional parameters:',
    '',
    '- `max_pages` (pdf/text): stop after N pages.',
    '- `max_age_days` (invoice/audit): staleness window for date checks, default 365.',
    '',
    '## Limits',
    '',
    `- PDF size: ${Math.round(config.limits.maxPdfBytes / 1024 / 1024)} MB decoded.`,
    `- Pages: ${config.limits.maxPdfPages} maximum.`,
    '- Scanned or image-only PDFs are NOT supported: there is no OCR. A PDF with no text',
    '  layer returns `has_text_layer: false` instead of guessing.',
    '',
    '## Discovery',
    '',
    `- Manifest: ${config.publicUrl}/.well-known/x402.json`,
    `- Service index: ${config.publicUrl}/`,
    `- Health: ${config.publicUrl}/health`,
    '- Source: https://github.com/NIBCarl/x402-docintel',
    '',
    '## Honest notes for agents',
    '',
    '- This service is NOT in the x402 Bazaar yet. Indexing is earned by a settled payment,',
    '  not by deploying, so a catalog search will not find it. Calling it still works.',
    '- The host is a free tier that sleeps after ~15 minutes idle. The first call of the day',
    '  can take ~40 seconds to cold-start. Retry once before treating it as down.',
    '- Prices are per call and small. Nothing here is a subscription or a bundle.',
    ''
  );

  return lines.join('\n');
};

