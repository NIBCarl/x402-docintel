// src/config.mjs — single source of truth. Flipping TESTNET->MAINNET is a config change, not a rewrite.
import fs from 'node:fs';
import path from 'node:path';

const envFile = path.resolve('.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const MODE = process.env.X402_MODE || 'testnet'; // 'testnet' | 'mainnet'

// Base Sepolia (testnet, free public facilitator) vs Base mainnet (real USDC)
const NETWORKS = {
  testnet: {
    network: 'eip155:84532',
    facilitator: process.env.FACILITATOR_URL || 'https://x402.org/facilitator',
    defaultPayTo: '0x0000000000000000000000000000000000000000',
  },
  mainnet: {
    network: 'eip155:8453',
    // Coinbase CDP was the original mainnet requirement, but a public facilitator
    // supporting `exact` on eip155:8453 removes the hard dependency on CDP keys.
    // Verified 2026-11-03 against GET /supported:
    //   facilitator.payai.network      -> exact, eip155:8453 (x402Version 2)  <- default
    //   facilitator.daydreams.systems  -> exact, eip155:8453 (x402Version 2)
    //   x402.org/facilitator           -> testnets only, never settles mainnet
    // Set FACILITATOR_URL to https://api.cdp.coinbase.com/platform/v2/x402 if you
    // do hold CDP credentials and prefer the Coinbase-operated path.
    facilitator: process.env.FACILITATOR_URL || 'https://facilitator.payai.network',
    defaultPayTo: '0x0000000000000000000000000000000000000000',
  },
};

const n = NETWORKS[MODE];
if (!n) throw new Error(`X402_MODE must be 'testnet' or 'mainnet', got '${MODE}'`);

const payTo = process.env.PAY_TO_ADDRESS || n.defaultPayTo;
if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error(`PAY_TO_ADDRESS is not a valid 20-byte hex address: ${payTo}`);

export const config = {
  mode: MODE,
  network: n.network,
  facilitator: n.facilitator,
  payTo,
  port: Number(process.env.PORT || 4021),
  // hard limits: protect compute-margin. An unpaid request costs us ~0.
  limits: {
    maxBodyBytes: Number(process.env.MAX_BODY_BYTES || 8 * 1024 * 1024), // 8MB b64 -> ~6MB pdf
    maxPdfBytes: Number(process.env.MAX_PDF_BYTES || 6 * 1024 * 1024),
    maxPdfPages: Number(process.env.MAX_PDF_PAGES || 200),
    maxTextChars: Number(process.env.MAX_TEXT_CHARS || 400_000),
    fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 12_000),
  },
  prices: {
    // Pricing is set from measured on-chain data (revenue-agent/leverage.mjs):
    // among real doc sellers, revenue correlates with PRICE (Spearman 0.43) more
    // than with CALL VOLUME (0.29). blockrun does 4,500 calls/day for $45; degenscan
    // does 14 calls/day at ~$60/call. Commodity PDF text is a race to the bottom
    // ($0.002 median, and only ~57 buyers even exist), so we price the VALUE tiers up:
    //   $0.02 -> 350 calls/day for $7   (commodity floor, still above the $0.002 crowd)
    //   $0.15 ->  47 calls/day for $7
    //   $0.25 ->  28 calls/day for $7
    //   $0.50 ->  14 calls/day for $7
    pdfText: process.env.PRICE_PDF_TEXT || '$0.02',
    pdfInvoice: process.env.PRICE_PDF_INVOICE || '$0.25',
    docKeydata: process.env.PRICE_DOC_KEYDATA || '$0.15',
    invoiceValidate: process.env.PRICE_INVOICE_VALIDATE || '$0.50',
  },

};

export const isMainnet = MODE === 'mainnet';

/** Parse "$0.50" -> 0.5. Used for the spend cap and for validation. */
const usdOf = (p) => Number(String(p).replace(/[^0-9.]/g, ''));

// The buyer selftest caps a single payment so a misconfigured or hostile server
// cannot drain the test wallet. Derive it from the priciest endpoint so it can
// never drift out of sync with the price list above.
export const maxEndpointUsd = Math.max(...Object.values(config.prices).map(usdOf));
config.selftestMaxUsd = maxEndpointUsd;

export const warnIfUnconfigured = () => {
  const w = [];
  if (/^0x0{40}$/.test(config.payTo)) w.push('PAY_TO_ADDRESS is the zero address — payments would be lost. Set PAY_TO_ADDRESS.');
  // CDP keys are no longer part of this check: a public facilitator covers mainnet.
  if (!config.facilitator) w.push('No facilitator configured — nobody can settle payments.');
  return w;
};

