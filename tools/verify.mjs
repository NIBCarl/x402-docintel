// verify.mjs — confirm installed SDK exports + facilitator network support
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('./node_modules/@x402/express/package.json', 'utf8'));
console.log('@x402/express', pkg.version);
console.log('exports keys:', Object.keys(pkg.exports || {}).join(', '));

const core = JSON.parse(fs.readFileSync('./node_modules/@x402/core/package.json', 'utf8'));
console.log('@x402/core', core.version, '| exports:', Object.keys(core.exports || {}).join(', '));

// live import test
try {
  const ex = await import('@x402/express');
  console.log('\n@x402/express runtime exports:', Object.keys(ex).join(', '));
  const cs = await import('@x402/core/server');
  console.log('@x402/core/server runtime exports:', Object.keys(cs).slice(0, 20).join(', '));
  const evm = await import('@x402/evm/exact/server');
  console.log('@x402/evm/exact/server exports:', Object.keys(evm).join(', '));
} catch (e) {
  console.log('IMPORT ERROR:', e.message);
}

// facilitator network + asset support
const fac = await fetch('https://x402.org/facilitator/supported').then((r) => r.json()).catch((e) => ({ err: e.message }));
console.log('\n=== x402.org facilitator supported ===');
console.log(JSON.stringify(fac, null, 1));
