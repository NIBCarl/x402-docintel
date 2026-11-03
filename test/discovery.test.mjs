// test/discovery.test.mjs — the two free discovery documents must never drift from the
// paywall, and must never leak anything. Runs fully offline: no server, no network.
import { config } from '../src/config.mjs';
import { buildLlmsTxt, buildManifest } from '../src/discovery.mjs';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -> ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

// A stand-in for the real route table. Mirrors the shape server.mjs builds, including the
// `resource` field added for https pinning, so the builders are exercised as used.
const fakeRoutes = {
  'POST /v1/pdf/text': {
    accepts: [{ scheme: 'exact', price: '$0.02', network: config.network, payTo: config.payTo }],
    description: 'Extract plaintext from a PDF.',
    mimeType: 'application/json',
    tags: ['pdf', 'text'],
  },
  'POST /v1/invoice/audit': {
    accepts: [{ scheme: 'exact', price: '$0.50', network: config.network, payTo: config.payTo }],
    description: 'Audit-grade invoice decision.',
    mimeType: 'application/json',
    tags: ['invoice', 'audit'],
  },
};

const llms = buildLlmsTxt(fakeRoutes);
const mf = await buildManifest(fakeRoutes);
const audit = mf.endpoints.find((e) => e.path === '/v1/invoice/audit');
const blob = llms + JSON.stringify(mf);

/* ---------- llms.txt ---------- */
check('llms.txt names the service', /^# DocIntel/.test(llms));
check('llms.txt lists every route', llms.includes('/v1/pdf/text') && llms.includes('/v1/invoice/audit'));
check('llms.txt states live prices', llms.includes('$0.02') && llms.includes('$0.50'));
check('llms.txt admits not indexed', /NOT in the x402 Bazaar/.test(llms));
// A buyer that signs 0.02 instead of 20000 gets rejected. Spelled out on purpose.
check('llms.txt teaches micro-USDC not dollars', /20000/.test(llms));

/* ---------- .well-known/x402.json ---------- */
check('manifest lists every route', mf.endpoints.length === 2, String(mf.endpoints.length));
check('audit amount is 500000 micro-USDC', audit.amount === '500000', audit.amount);
// Derived from the SDK, never hardcoded — a wrong token address would be worse than no manifest.
check('asset comes from the SDK parse', /^0x[0-9a-fA-F]{40}$/.test(audit.asset), audit.asset);
check('EIP-712 domain name is USD Coin', audit.extra.name === 'USD Coin', audit.extra.name);
check('EIP-712 domain version is 2', audit.extra.version === '2', audit.extra.version);
check(
  'manifest prices match the route table',
  mf.endpoints.every((e) => e.price === fakeRoutes[`POST ${e.path}`].accepts[0].price)
);
check('manifest reports not_indexed', mf.bazaarStatus === 'not_indexed', mf.bazaarStatus);
check('manifest cites the 404 registration fact', /404/.test(mf.bazaarNote));
check('manifest urls are all https', mf.endpoints.every((e) => e.url.startsWith('https://')));
check('manifest docs link is https', mf.docs.llmsTxt.startsWith('https://'));

/* ---------- no leaks ---------- */
// payTo is a public receiving address, already present in every 402. A private key is 64 hex.
check('no 64-hex key material', !/0x[0-9a-fA-F]{64}/.test(blob));
check('no secret wording', !/private\s*key|mnemonic|seed phrase/i.test(blob));
check('payTo IS published (needed to pay)', blob.includes(config.payTo), config.payTo);

console.log(`\nRESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
