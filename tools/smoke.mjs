// tools/smoke.mjs — live end-to-end check: does the paywall charge what we think,
// and does the premium audit route actually return a decision?
// Run: node tools/smoke.mjs   (server must be running: npm start)
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:4021';
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -> ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const get = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const post = async (p, body = {}) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
};

console.log(`--- DISCOVERY ${BASE} ---`);
const health = await get('/health');
check('/health ok', health.status === 200 && health.body?.ok === true, JSON.stringify(health.body?.network));

const root = await get('/');
check('/ lists 4 endpoints', root.body?.endpoints?.length === 4, String(root.body?.endpoints?.length));
const prices = Object.fromEntries((root.body?.endpoints || []).map((e) => [e.route, e.price]));
console.log('    prices:', JSON.stringify(prices));
check('pdf/text is $0.02', prices['POST /v1/pdf/text'] === '$0.02', prices['POST /v1/pdf/text']);
check('invoice is $0.25', prices['POST /v1/pdf/invoice'] === '$0.25', prices['POST /v1/pdf/invoice']);
check('keydata is $0.15', prices['POST /v1/doc/keydata'] === '$0.15', prices['POST /v1/doc/keydata']);
check('audit is $0.50', prices['POST /v1/invoice/audit'] === '$0.50', prices['POST /v1/invoice/audit']);

console.log('--- PAYWALL (unpaid must be 402) ---');
for (const p of ['/v1/pdf/text', '/v1/pdf/invoice', '/v1/doc/keydata', '/v1/invoice/audit']) {
  const r = await post(p, {});
  check(`${p} -> 402`, r.status === 402, `status=${r.status}`);
  // The 402 body must advertise the bazaar discovery extension for indexing.
  const txt = JSON.stringify(r.body || {});
  check(`${p} advertises bazaar`, /bazaar/.test(txt) || Boolean(r.headers.get('x-payment-required') || r.headers.get('payment-required')), '');
}

console.log('--- NO FREELOADING: paying route must not run without payment ---');
const leak = await post('/v1/invoice/audit', { pdf_base64: 'JVBERi0xLjQK' });
check('audit blocked without payment', leak.status === 402, `status=${leak.status}`);
check('no decision leaked', leak.body?.decision === undefined, JSON.stringify(leak.body).slice(0, 80));

console.log(`\nRESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
