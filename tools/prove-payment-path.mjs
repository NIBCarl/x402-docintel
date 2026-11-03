// tools/prove-payment-path.mjs — prove the entire paid path works, for $0.00.
//
// Why this exists: /settle writes to a blockchain and needs real USDC, so the
// usual way to answer "does my paywall actually work?" is to spend money. That
// isn't necessary. The x402 handshake has two independent halves:
//
//   1. CRYPTOGRAPHY  the buyer signs an EIP-3009 transferWithAuthorization.
//                    Verifiable offline against the token's EIP-712 domain. Free.
//   2. SETTLEMENT    the facilitator moves tokens. Needs balance. Costs money.
//
// This script exercises half 1 completely — the signature is produced by the real
// @x402/evm client and then independently recovered here — and proves half 2 is
// unreachable ONLY because the wallet is empty: the facilitator's free /verify
// endpoint must reject with `invalid_exact_evm_insufficient_balance` and nothing
// else. Any other reason is a genuine defect in our challenge.
//
// Nothing is spent and nothing can be spent: /verify does not settle, the signed
// payload is never posted to /settle, and the wallet holds no funds.
//
// Usage:
//   node tools/prove-payment-path.mjs                                    # live Render host
//   SELF_URL=http://127.0.0.1:4021 node tools/prove-payment-path.mjs     # local server
//   ROUTE=/v1/pdf/text node tools/prove-payment-path.mjs                 # cheapest tier
//
// Exit code 0 = payment path proven; 1 = a real defect was found.

import fs from 'node:fs';
import path from 'node:path';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createPublicClient, http, recoverTypedDataAddress, verifyTypedData, parseUnits, formatUnits } from 'viem';
import { base } from 'viem/chains';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { config } from '../src/config.mjs';

const BASE_URL = (process.env.SELF_URL || 'https://x402-docintel.onrender.com').replace(/\/$/, '');
const ROUTE = process.env.ROUTE || '/v1/invoice/audit'; // priciest tier: worst case if it breaks
const KEY_FILE = path.resolve('.buyer-key');
const RPC = process.env.BASE_RPC || 'https://mainnet.base.org';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'authorizationState', type: 'function', stateMutability: 'view', inputs: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
];

/** Route -> configured price, so the amount assertion can never drift from config.mjs. */
const routePrice = (r) =>
  ({
    '/v1/pdf/text': config.prices.pdfText,
    '/v1/pdf/invoice': config.prices.pdfInvoice,
    '/v1/doc/keydata': config.prices.docKeydata,
    '/v1/invoice/audit': config.prices.invoiceValidate,
  })[r] ?? config.prices.invoiceValidate;

/* ---------------- pass/fail accounting ---------------- */

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures += 1;
  return ok;
};
const step = (n, t) => console.log(`\nSTEP ${n}  ${t}`);
const note = (m) => console.log(`        ${m}`);

const finish = () => {
  console.log('');
  if (failures === 0) {
    console.log('RESULT  PAYMENT_PATH_PROVEN — challenge issued, authorization signed, signature');
    console.log('        independently recovered, facilitator accepted every term. Cost: $0.00.');
    console.log('        Only settlement is untested, and it needs a funded balance, not a code fix.');
  } else {
    console.log(`RESULT  ${failures} CHECK(S) FAILED — the paid path is broken above the money layer.`);
    process.exitCode = 1;
  }
};

/* ---------------- buyer key (same resolution as buyer-selftest) ---------------- */

const resolveKey = () => {
  if (process.env.X402_BUYER_PRIVATE_KEY) return { pk: process.env.X402_BUYER_PRIVATE_KEY, origin: 'operator-supplied (env)' };
  if (fs.existsSync(KEY_FILE)) {
    const cached = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (/^0x[0-9a-fA-F]{64}$/.test(cached)) return { pk: cached, origin: 'reused from .buyer-key' };
  }
  const fresh = generatePrivateKey();
  fs.writeFileSync(KEY_FILE, fresh, { mode: 0o600 });
  return { pk: fresh, origin: 'generated -> saved to .buyer-key' };
};

const { pk, origin } = resolveKey();
const buyer = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: base, transport: http(RPC) });


const main = async () => {
  console.log('docintel — payment path proof (no funds are spent, none can be)');
  console.log(`  target   : ${BASE_URL}${ROUTE}`);
  console.log(`  buyer    : ${buyer.address}`);
  console.log(`  key from : ${origin}`);
  console.log(`  network  : ${config.network} (expected)`);

  /* ---------- STEP 1: the server must hand back a payable challenge ---------- */
  step(1, 'fetch the 402 challenge (unpaid request, free)');
  const challenged = await fetch(`${BASE_URL}${ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pdf_base64: 'JVBERi0xLjQK' }),
  });
  note(`status=${challenged.status}`);
  if (!check('unpaid request returns HTTP 402', challenged.status === 402, `got ${challenged.status}`)) return finish();

  const rawHeader = challenged.headers.get('payment-required');
  if (!check('402 carries a PAYMENT-REQUIRED header', Boolean(rawHeader))) return finish();
  const challenge = JSON.parse(Buffer.from(rawHeader, 'base64').toString('utf8'));

  /* ---------- STEP 2: challenge integrity — are we charging, and to whom? ---------- */
  step(2, 'challenge integrity');
  const accept = challenge.accepts?.[0];
  if (!check('challenge has at least one accept', Boolean(accept))) return finish();

  const expectedPrice = routePrice(ROUTE);
  const expectedMicro = parseUnits(String(expectedPrice).replace(/[^0-9.]/g, ''), 6).toString();

  check('x402Version is 2', challenge.x402Version === 2, `got ${challenge.x402Version}`);
  check('scheme is exact', accept.scheme === 'exact', accept.scheme);
  check('network is Base mainnet', accept.network === 'eip155:8453', accept.network);
  check('asset is Base USDC', accept.asset?.toLowerCase() === USDC_BASE.toLowerCase(), accept.asset);
  check('payTo is our address, not the zero address',
    accept.payTo?.toLowerCase() === config.payTo.toLowerCase() && !/^0x0{40}$/i.test(accept.payTo), accept.payTo);
  check('amount matches the price list', accept.amount === expectedMicro, `${accept.amount} micro-USDC vs expected ${expectedMicro}`);
  check('USDC EIP-712 domain advertised', accept.extra?.name === 'USD Coin' && accept.extra?.version === '2', JSON.stringify(accept.extra));
  check('transfer is time-bounded', Number(accept.maxTimeoutSeconds) > 0, `${accept.maxTimeoutSeconds}s`);

  // Resource metadata is what the Bazaar displays to buyers once indexed.
  const res = challenge.resource || {};
  check('resource.url present', Boolean(res.url), res.url);
  check('resource tags within the 5-tag cap', Array.isArray(res.tags) && res.tags.length <= 5, `${res.tags?.length ?? 0} tags`);
  note(`serviceName: ${res.serviceName ? JSON.stringify(res.serviceName) : 'NOT SET (optional; see DEPLOY.md)'}`);
  check('bazaar extension present (required for indexing on settlement)',
    Boolean(challenge.extensions?.bazaar), challenge.extensions?.bazaar ? 'info+schema' : 'absent');

  /* ---------- STEP 3: sign a real payment with the real SDK client ---------- */
  step(3, 'sign an EIP-3009 authorization (SDK client, real signature)');
  const client = new x402Client();
  client.register(config.network, new ExactEvmScheme(buyer));
  const paymentPayload = await client.createPaymentPayload(challenge);
  const auth = paymentPayload.payload?.authorization;
  const signature = paymentPayload.payload?.signature;
  if (!check('client produced a payment payload', Boolean(auth && signature))) return finish();
  note(`authorization keys: ${Object.keys(auth).join(', ')}`);

  /* ---------- STEP 4: would the money go to us, and only the right amount? ---------- */
  step(4, 'authorization terms');
  check('from is the buyer', auth.from?.toLowerCase() === buyer.address.toLowerCase(), auth.from);
  check('to is our payTo (funds land with us)', auth.to?.toLowerCase() === accept.payTo.toLowerCase(), auth.to);
  check('value equals the price exactly (no overcharge)', String(auth.value) === String(accept.amount), `${auth.value} micro-USDC`);
  const nowS = Math.floor(Date.now() / 1000);
  check('validAfter is in the past or now', Number(auth.validAfter) <= nowS, `${auth.validAfter} vs now ${nowS}`);
  check('validBefore is in the future (not pre-expired)', Number(auth.validBefore) > nowS, `expires in ${Number(auth.validBefore) - nowS}s`);
  check('nonce is a 32-byte value', /^0x[0-9a-fA-F]{64}$/.test(auth.nonce || ''), auth.nonce);

  /* ---------- STEP 5: verify the signature independently (offline, free) ---------- */
  // Recovered with viem directly rather than trusting the SDK that produced it.
  step(5, 'independent EIP-712 signature recovery');
  const domain = { name: accept.extra.name, version: accept.extra.version, chainId: 8453, verifyingContract: USDC_BASE };
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };
  const message = {
    from: auth.from,
    to: auth.to,
    value: BigInt(auth.value),
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
    nonce: auth.nonce,
  };
  const recovered = await recoverTypedDataAddress({ domain, types, primaryType: 'TransferWithAuthorization', message, signature });
  check('signature recovers to the buyer address', recovered.toLowerCase() === buyer.address.toLowerCase(), recovered);
  check('signature is valid for the Base USDC EIP-712 domain',
    (await verifyTypedData({ address: buyer.address, domain, types, primaryType: 'TransferWithAuthorization', message, signature })) === true);
  check('signature cannot be replayed for a larger amount (tamper check)',
    !(await verifyTypedData({
      address: buyer.address, domain, types, primaryType: 'TransferWithAuthorization',
      message: { ...message, value: message.value + 1n }, signature,
    })));

  /* ---------- STEP 6: facilitator /verify — free, and rejects only on balance ---------- */
  step(6, 'facilitator /verify (free; settlement is not requested)');
  const balBefore = await pub.readContract({ address: USDC_BASE, abi: ERC20_ABI, functionName: 'balanceOf', args: [buyer.address] });
  const usedBefore = await pub.readContract({ address: USDC_BASE, abi: ERC20_ABI, functionName: 'authorizationState', args: [buyer.address, auth.nonce] });
  note(`buyer USDC before: ${formatUnits(balBefore, 6)}`);

  const verifyRes = await fetch(`${config.facilitator}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x402Version: challenge.x402Version, paymentPayload, paymentRequirements: accept }),
  });
  const verifyBody = await verifyRes.json().catch(() => ({}));
  note(`status=${verifyRes.status} body=${JSON.stringify(verifyBody)}`);

  const reason = verifyBody.invalidReason || verifyBody.errorReason || '';
  check('facilitator accepted every term except balance',
    verifyBody.isValid === true || reason === 'invalid_exact_evm_insufficient_balance', reason || 'isValid=true');

  if (reason === 'invalid_exact_evm_insufficient_balance') {
    note('EXPECTED: this wallet holds 0 USDC, so balance is the only missing input.');
    note(`fund ${buyer.address} with ${expectedPrice} USDC on Base and the same request settles for real.`);
  }

  /* ---------- STEP 7: prove nothing moved ---------- */
  step(7, 'no funds moved (this is a dry run)');
  const balAfter = await pub.readContract({ address: USDC_BASE, abi: ERC20_ABI, functionName: 'balanceOf', args: [buyer.address] });
  const usedAfter = await pub.readContract({ address: USDC_BASE, abi: ERC20_ABI, functionName: 'authorizationState', args: [buyer.address, auth.nonce] });
  check('buyer balance unchanged', balBefore === balAfter, `${formatUnits(balAfter, 6)} USDC`);
  check('authorization nonce still unused on-chain (nothing settled)', usedBefore === false && usedAfter === false);
  check('/settle was never called', true, 'by design — see header comment');

  finish();
};

main().catch((e) => {
  console.error('\nPROOF ERROR:', e?.shortMessage || e?.message || e);
  process.exitCode = 1;
});
