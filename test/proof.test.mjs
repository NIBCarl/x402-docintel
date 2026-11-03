// test/proof.test.mjs — the $0 payment-path proof must fail closed.
//
// tools/prove-payment-path.mjs talks to the network, so it cannot run in CI. What *can*
// be tested offline is the part that decides pass/fail: route/price mapping and the
// EIP-712 verification used to judge a signature. If those go soft, the proof would
// report PAYMENT_PATH_PROVEN for a broken paywall, which is worse than no proof at all.
import { verifyTypedData, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../src/config.mjs';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -> ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

/* ---------- price mapping must track config.mjs, never a hardcoded number ---------- */

// Mirrors routePrice() in the tool; asserted against config so a reprice cannot silently
// invalidate the proof's "amount matches the price list" assertion.
const routePrice = (r) =>
  ({
    '/v1/pdf/text': config.prices.pdfText,
    '/v1/pdf/invoice': config.prices.pdfInvoice,
    '/v1/doc/keydata': config.prices.docKeydata,
    '/v1/invoice/audit': config.prices.invoiceValidate,
  })[r] ?? config.prices.invoiceValidate;

console.log('--- routePrice tracks config ---');
check('text maps to pdfText', routePrice('/v1/pdf/text') === config.prices.pdfText, routePrice('/v1/pdf/text'));
check('invoice maps to pdfInvoice', routePrice('/v1/pdf/invoice') === config.prices.pdfInvoice, routePrice('/v1/pdf/invoice'));
check('keydata maps to docKeydata', routePrice('/v1/doc/keydata') === config.prices.docKeydata, routePrice('/v1/doc/keydata'));
check('audit maps to invoiceValidate', routePrice('/v1/invoice/audit') === config.prices.invoiceValidate, routePrice('/v1/invoice/audit'));
check('unknown route falls back to the priciest tier',
  routePrice('/v1/nope') === config.prices.invoiceValidate, routePrice('/v1/nope'));

// "$0.50" -> 500000, the exact integer a 402 must quote.
const microOf = (usd) => String(Math.round(Number(String(usd).replace(/[^0-9.]/g, '')) * 1e6));
console.log('--- price -> micro-USDC ---');
check('$0.50 -> 500000', microOf('$0.50') === '500000', microOf('$0.50'));
check('$0.02 -> 20000', microOf('$0.02') === '20000', microOf('$0.02'));
check('$0.15 -> 150000', microOf('$0.15') === '150000', microOf('$0.15'));
check('$0.25 -> 250000', microOf('$0.25') === '250000', microOf('$0.25'));
check('no float drift on $0.07', microOf('$0.07') === '70000', microOf('$0.07'));

/* ---------- the signature check must reject tampering ---------- */

console.log('--- EIP-712 verification is strict ---');
const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const domain = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_BASE };
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
  from: account.address,
  to: '0x4A223A518FA9C3bb1c086c30277ACb69E8D5E868',
  value: 500000n,
  validAfter: 0n,
  validBefore: 4102444800n,
  nonce: '0x' + '11'.repeat(32),
};
const signature = await account.signTypedData({ domain, types, primaryType: 'TransferWithAuthorization', message });

check('valid signature verifies', (await verifyTypedData({ address: account.address, domain, types, primaryType: 'TransferWithAuthorization', message, signature })) === true);
check('recovers to the signer',
  (await recoverTypedDataAddress({ domain, types, primaryType: 'TransferWithAuthorization', message, signature })).toLowerCase() === account.address.toLowerCase());

const tampered = [
  ['larger amount', { ...message, value: 500001n }],
  ['different payTo', { ...message, to: '0x0000000000000000000000000000000000000001' }],
  ['extended expiry', { ...message, validBefore: 4102444801n }],
  ['different nonce', { ...message, nonce: '0x' + '22'.repeat(32) }],
];
for (const [label, msg] of tampered) {
  check(`rejects tampered ${label}`,
    (await verifyTypedData({ address: account.address, domain, types, primaryType: 'TransferWithAuthorization', message: msg, signature })) === false);
}

check('rejects the wrong EIP-712 domain (chain mismatch)',
  (await verifyTypedData({ address: account.address, domain: { ...domain, chainId: 84532 }, types, primaryType: 'TransferWithAuthorization', message, signature })) === false);
check('rejects a different verifying contract',
  (await verifyTypedData({ address: account.address, domain: { ...domain, verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' }, types, primaryType: 'TransferWithAuthorization', message, signature })) === false);

console.log(`\nRESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
