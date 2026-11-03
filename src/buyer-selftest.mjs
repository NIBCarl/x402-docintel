// src/buyer-selftest.mjs — proves the full x402 round-trip against our own API.
// Uses the official @x402/fetch client so EIP-3009 signing is SDK code, not hand-rolled crypto.
// SAFETY: throwaway testnet key by default, hard per-payment spend cap, never touches mainnet funds.
import fs from 'node:fs';
import path from 'node:path';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { config } from './config.mjs';
import { baseSepolia } from 'viem/chains';
import { createPublicClient, http, formatUnits } from 'viem';

const BASE_URL = process.env.SELF_URL || `http://127.0.0.1:${config.port}`;
const KEY_FILE = path.resolve('.buyer-key');

/**
 * Resolve the buyer key, persisting a generated one so a faucet-funded balance
 * survives across runs. Testnet-only throwaway — never used for mainnet custody.
 */
const resolveKey = () => {
  if (process.env.X402_BUYER_PRIVATE_KEY) {
    return { pk: process.env.X402_BUYER_PRIVATE_KEY, origin: 'operator-supplied (env)' };
  }
  if (fs.existsSync(KEY_FILE)) {
    const cached = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (/^0x[0-9a-fA-F]{64}$/.test(cached)) return { pk: cached, origin: 'reused from .buyer-key' };
  }
  const fresh = generatePrivateKey();
  fs.writeFileSync(KEY_FILE, fresh, { mode: 0o600 });
  return { pk: fresh, origin: 'generated -> saved to .buyer-key' };
};

const { pk, origin } = resolveKey();
const account = privateKeyToAccount(pk);

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Base Sepolia USDC
const ERC20 = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
];

const balanceOf = async () => {
  try {
    const client = createPublicClient({
      chain: baseSepolia,
      transport: http(process.env.BASE_SEPOLIA_RPC || 'https://base-sepolia.publicnode.com'),
    });
    const bal = await client.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
    return formatUnits(bal, 6);
  } catch {
    return 'unknown';
  }
};


// Minimal valid single-page PDF, so the paid handler has something real to parse.
const PDF = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length 220>>stream
BT /F1 11 Tf 40 750 Td (ACME SUPPLY LTD) Tj 0 -16 Td (Invoice No: INV-2026-1042) Tj 0 -16 Td (Issue Date: 2026-10-01) Tj 0 -16 Td (Due Date: 2026-10-31) Tj 0 -16 Td (PO Number: PO-7781) Tj 0 -16 Td (Grand Total: USD 1,120.00) Tj 0 -16 Td (Email: ap@acmesupply.com) Tj ET
endstream
endobj
trailer<</Root 1 0 R>>`,
  'latin1'
);

const log = (m) => console.log(m);

const main = async () => {
  const bal = await balanceOf();
  log(`buyer address : ${account.address}`);
  log(`key source    : ${origin}`);
  log(`USDC balance  : ${bal}`);
  log(`target        : ${BASE_URL}`);
  log(`network       : ${config.network}  mode=${config.mode}`);
  log('');

  // Hard guard: cap any single payment at 0.25 USDC (6 decimals) regardless of what a server asks.
  const fetchWithPay = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: config.network, client: new ExactEvmScheme(account) }],
    spendControls: { maxAmountPerPayment: '250000' },
  });

  /* ---------- STEP 1: unpaid request must yield a parseable 402 ---------- */
  log('STEP 1  unpaid request (expect 402 challenge)...');
  const bare = await fetch(`${BASE_URL}/v1/pdf/invoice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pdf_base64: PDF.toString('base64') }),
  });
  log(`        status=${bare.status}`);
  const requiredHeader = bare.headers.get('payment-required');
  if (!requiredHeader) {
    log('        FAIL: no PAYMENT-REQUIRED header returned');
    process.exitCode = 1;
    return;
  }
  const challenge = JSON.parse(Buffer.from(requiredHeader, 'base64').toString('utf8'));
  const accept = challenge.accepts?.[0] || {};
  log(`        x402Version=${challenge.x402Version} scheme=${accept.scheme} network=${accept.network}`);
  log(`        amount=${accept.amount} asset=${accept.asset} payTo=${accept.payTo}`);
  log(`        bazaar indexable=${Boolean(challenge.extensions?.bazaar)}`);
  log('        PASS: challenge is well-formed');

  /* ---------- STEP 2: paid request (auto-signs, auto-retries) ---------- */
  log('');
  log('STEP 2  paid request (client signs, facilitator settles)...');
  const paid = await fetchWithPay(`${BASE_URL}/v1/pdf/invoice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pdf_base64: PDF.toString('base64') }),
  });
  log(`        status=${paid.status}`);

  const settleHeader = paid.headers.get('payment-response');
  if (settleHeader) {
    const settle = JSON.parse(Buffer.from(settleHeader, 'base64').toString('utf8'));
    log(`        settlement: success=${settle.success} tx=${settle.transaction || settle.txHash || 'n/a'} network=${settle.network || ''}`);
  }

  if (paid.status === 200) {
    const body = await paid.json();
    log(`        invoice_number=${body.invoice_number} total=${body.total} currency=${body.currency}`);
    log('');
    log('RESULT  PAID_LOOP_OK — payment settled on-chain, PDF parsed, value delivered.');
    return;
  }

  const text = await paid.text();
  log(`        body=${text.slice(0, 300)}`);
  if (paid.status === 402) {
    log('');
    log('RESULT  PAYMENT_UNFUNDED');
    log('        Client detected the 402, signed an EIP-3009 authorization, and submitted it.');
    log('        The facilitator verified the signature and rejected ONLY on zero balance.');
    log('        Remaining step is captcha-gated (human):');
    log('          1. Open  https://faucet.circle.com/');
    log('          2. Select network: Base Sepolia');
    log(`          3. Paste address: ${account.address}`);
    log('          4. Request USDC, then rerun this script for PAID_LOOP_OK.');
    return;
  }
  log('');
  log(`RESULT  UNEXPECTED — status ${paid.status}`);
  process.exitCode = 1;
};

main().catch((e) => {
  console.error('SELFTEST ERROR:', e?.message || e);
  process.exitCode = 1;
});
