// src/gen-wallet.mjs — creates a PAY_TO receiver wallet for this service.
// TESTNET use: this hot key on disk is fine (no real value).
// MAINNET use: do NOT use a disk key for revenue. Point PAY_TO_ADDRESS at a wallet you
// control (hardware / Coinbase / Safe). This script only helps for testnet.
import fs from 'node:fs';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const KEY_FILE = path.resolve('.payto-key');
const ENV_FILE = path.resolve('.env');

const existing = fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim() : null;
const pk = existing && /^0x[0-9a-fA-F]{64}$/.test(existing) ? existing : generatePrivateKey();
if (!existing) fs.writeFileSync(KEY_FILE, pk, { mode: 0o600 });

const account = privateKeyToAccount(pk);

// Write/refresh .env so `npm start` picks the address up without extra flags.
let env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
if (!/^PAY_TO_ADDRESS=/m.test(env)) {
  env += `${env && !env.endsWith('\n') ? '\n' : ''}PAY_TO_ADDRESS=${account.address}\n`;
  fs.writeFileSync(ENV_FILE, env);
}

console.log('receiver wallet ready');
console.log('  address     :', account.address);
console.log('  private key :', path.basename(KEY_FILE), '(gitignored)');
console.log('  env         : PAY_TO_ADDRESS written to .env');
console.log('');
console.log('This is where every x402 payment settles. Back it up if you funded it.');
console.log('For mainnet revenue, prefer a wallet you control rather than this disk key.');
