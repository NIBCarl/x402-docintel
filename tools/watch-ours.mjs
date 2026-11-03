// tools/watch-ours.mjs — the ONLY metric that matters: has a STRANGER paid our payTo address?
// Everything else (endpoints live, Bazaar indexed, tests green) is vanity. This scans
// Base mainnet USDC transfers INTO our address and answers:
//   - how many distinct senders (a stranger is any sender that isn't us)
//   - how much USD, on how many distinct days
// Usage: node tools/watch-ours.mjs [address] [days]   (address defaults to PAY_TO_ADDRESS)
//
// Read-only: it queries public Base RPC endpoints for Transfer logs and writes one local
// JSON summary. No key material, no transactions, no writes to the chain.
import fs from 'node:fs';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const RPCS = ['https://base.publicnode.com', 'https://base.drpc.org', 'https://gateway.tenderly.co/public/base'];
const pad = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

let RPC = RPCS[0];
const rpc = async (method, params) => {
  let lastErr;
  for (const url of [RPC, ...RPCS]) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 40000);
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'x402-docintel-watch' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctl.signal,
      });
      clearTimeout(t);
      const j = await r.json();
      if (j.error) { lastErr = new Error(`${url}: ${j.error.message}`); continue; }
      RPC = url;
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
};

// address: CLI arg > PAY_TO_ADDRESS from the project's .env > error.
// Reuse src/config.mjs instead of hand-rolling a path, so this works from any cwd.
let addr = process.argv[2];
if (!addr) {
  try {
    const { config } = await import('../src/config.mjs');
    if (!/^0x0{40}$/.test(config.payTo)) addr = config.payTo;
  } catch { /* config can throw on invalid env; fall through to usage */ }
}
if (!/^0x[0-9a-fA-F]{40}$/.test(addr || '')) {
  console.error('usage: node tools/watch-ours.mjs 0xYOURPAYTO [days]   (or set PAY_TO_ADDRESS in .env)');
  process.exit(2);
}
const DAYS = Number(process.argv[3] || 14);
// A payment from ourselves is NOT a stranger.
const SELF = new Set([addr.toLowerCase(), '0x0000000000000000000000000000000000000000']);

console.log(`watching payTo=${addr} for the last ${DAYS} days on Base mainnet\n`);

const head = parseInt(await rpc('eth_blockNumber', []), 16);
const blk = (n) => rpc('eth_getBlockByNumber', ['0x' + n.toString(16), false]);
const tHead = parseInt((await blk(head)).timestamp, 16);
const tProbe = parseInt((await blk(head - 43200)).timestamp, 16);
const blocksPerDay = Math.round((43200 * 86400) / (tHead - tProbe));
const span = Math.round(blocksPerDay * DAYS);
const from = Math.max(0, head - span);
const CHUNK = 2000;
console.log(`head=${head} blocks/day~${blocksPerDay} scanning ${span} blocks in ${Math.ceil(span / CHUNK)} chunks\n`);

// Our address is the RECIPIENT, so it is topic[2] of the Transfer event.
const payments = [];
let fails = 0;
for (let b = from; b <= head; b += CHUNK) {
  const to = Math.min(b + CHUNK - 1, head);
  try {
    const logs = await rpc('eth_getLogs', [{
      address: USDC,
      fromBlock: '0x' + b.toString(16),
      toBlock: '0x' + to.toString(16),
      topics: [TRANSFER, null, pad(addr)],
    }]);
    for (const l of logs) {
      payments.push({
        from: '0x' + l.topics[1].slice(26).toLowerCase(),
        usd: Number(BigInt(l.data)) / 1e6,
        block: parseInt(l.blockNumber, 16),
        tx: l.transactionHash,
      });
    }
  } catch (e) {
    fails++;
    if (fails <= 3) console.log(`  FAIL chunk ${b}: ${String(e.message).slice(0, 70)}`);
  }
  await new Promise((r) => setTimeout(r, 120));
  process.stdout.write(`\r  scanned ${Math.min(b + CHUNK, head) - from}/${span} blocks  payments=${payments.length}  `);
}
console.log('\n');

// Resolve block timestamps once per unique block for day bucketing
const dayOf = new Map();
for (const p of payments) {
  if (!dayOf.has(p.block)) {
    const b = await blk(p.block);
    dayOf.set(p.block, new Date(parseInt(b.timestamp, 16) * 1000).toISOString().slice(0, 10));
  }
  p.day = dayOf.get(p.block);
}

const strangers = payments.filter((p) => !SELF.has(p.from));
const bySender = new Map();
for (const p of strangers) {
  const c = bySender.get(p.from) || { usd: 0, n: 0, days: new Set() };
  c.usd += p.usd;
  c.n++;
  c.days.add(p.day);
  bySender.set(p.from, c);
}
const activeDays = new Set(payments.map((p) => p.day));
const usd = payments.reduce((s, p) => s + p.usd, 0);
const strangerUsd = strangers.reduce((s, p) => s + p.usd, 0);

console.log('=== IS THIS REAL YET? ===');
console.log(`payments in window : ${payments.length}`);
console.log(`distinct senders   : ${bySender.size}  (excluding self/zero)`);
console.log(`total received     : $${usd.toFixed(2)}   of which stranger: $${strangerUsd.toFixed(2)}`);
console.log(`active days        : ${activeDays.size} / ${DAYS}`);
console.log(`rpc chunk failures : ${fails}`);

if (!payments.length) {
  console.log('\nVERDICT: NO PAYMENTS IN WINDOW.');
  console.log('  - If the service was never deployed publicly, this is expected, not a failure.');
  console.log('  - If it IS deployed: confirm payTo matches, and that X402_MODE=mainnet.');
  console.log('  - Zero is the honest baseline. Do not pay for hosting to "give it time".');
} else if (!bySender.size) {
  console.log('\nVERDICT: ONLY SELF-PAYMENTS. These look like our own test transactions.');
  console.log('  Self-payments prove the plumbing works - they do NOT prove demand.');
} else {
  console.log('\nVERDICT: A STRANGER HAS PAID. Binary milestone reached.');
  const sorted = [...bySender.entries()].sort((a, b) => b[1].usd - a[1].usd);
  console.log('  sender'.padEnd(46) + 'USD'.padEnd(11) + 'PAYMENTS'.padEnd(10) + 'DAYS');
  for (const [s, v] of sorted.slice(0, 15)) {
    console.log(`  ${s.padEnd(44)} ${('$' + v.usd.toFixed(3)).padEnd(10)} ${String(v.n).padEnd(9)} ${v.days.size}`);
  }
  const repeat = sorted.filter(([, v]) => v.days.size > 1).length;
  console.log(`\n  repeat customers (paid on >1 day): ${repeat}`);
  if (repeat > 0) console.log('  -> Repeat payment is the strongest early signal. Consider raising price.');
}

const out = 'ours-status.json';
fs.writeFileSync(out, JSON.stringify({
  checkedAt: new Date().toISOString(),
  payTo: addr,
  windowDays: DAYS,
  head,
  blocksPerDay,
  fails,
  payments: payments.length,
  distinctStrangers: bySender.size,
  totalUsd: usd,
  strangerUsd,
  activeDays: activeDays.size,
  firstStrangerPaid: bySender.size > 0,
  monthlyRunRate: Number(((usd / Math.max(1, DAYS)) * 30).toFixed(2)),
  senders: [...bySender.entries()].map(([from, v]) => ({
    from,
    usd: Number(v.usd.toFixed(6)),
    payments: v.n,
    days: v.days.size,
  })),
}, null, 2));
console.log(`\n[saved] ${out}`);


