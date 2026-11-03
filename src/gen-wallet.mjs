// src/gen-wallet.mjs — creates a PAY_TO receiver wallet.
//
//   node src/gen-wallet.mjs            -> testnet hot key on disk (.payto-key)
//   node src/gen-wallet.mjs --mainnet  -> real revenue wallet from a 12-word mnemonic
//
// Security model, deliberately asymmetric:
//   - The SERVER only ever needs the address. x402 payments are pushed to it, so the
//     private key is NOT required at runtime and is never loaded by src/server.mjs.
//   - Therefore the secret is written to a local file (.payto-mnemonic, gitignored,
//     0600) and is NEVER echoed to stdout — a terminal or CI log is a leak too.
//   - Move it to a password manager or hardware wallet, then delete the file.
import fs from 'node:fs';
import path from 'node:path';
import { generateMnemonic, mnemonicToAccount, generatePrivateKey, privateKeyToAccount, english } from 'viem/accounts';

const KEY_FILE = path.resolve('.payto-key');
const MNEMONIC_FILE = path.resolve('.payto-mnemonic');
const ENV_FILE = path.resolve('.env');
const MAINNET = process.argv.includes('--mainnet');
const ZERO = /^0x0{40}$/;

/** Write PAY_TO_ADDRESS into .env, but never silently replace a real address. */
const writeEnv = (address) => {
  const env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const m = env.match(/^\s*PAY_TO_ADDRESS\s*=\s*(\S+)\s*$/m);
  if (m && !ZERO.test(m[1])) {
    console.log(`  .env already holds PAY_TO_ADDRESS=${m[1]} — left untouched.`);
    console.log('  Delete that line and rerun if you really want to switch wallets.');
    return false;
  }
  const next = m
    ? env.replace(/^\s*PAY_TO_ADDRESS\s*=\s*\S+\s*$/m, `PAY_TO_ADDRESS=${address}`)
    : `${env}${env && !env.endsWith('\n') ? '\n' : ''}PAY_TO_ADDRESS=${address}\n`;
  fs.writeFileSync(ENV_FILE, next);
  return true;
};

if (MAINNET) {
  // Reuse an existing mnemonic so reruns cannot orphan a funded wallet.
  if (fs.existsSync(MNEMONIC_FILE)) {
    const mnemonic = fs.readFileSync(MNEMONIC_FILE, 'utf8').trim();
    const account = mnemonicToAccount(mnemonic);
    console.log('mainnet receiver wallet (existing mnemonic reused)');
    console.log('  address     :', account.address);
    console.log('  mnemonic    :', path.basename(MNEMONIC_FILE), '(gitignored — back this up)');
    writeEnv(account.address);
    process.exit(0);
  }

  const mnemonic = generateMnemonic(english);
  const account = mnemonicToAccount(mnemonic);

  // 0600 so other local accounts cannot read it.
  fs.writeFileSync(MNEMONIC_FILE, mnemonic, { mode: 0o600 });

  console.log('=== MAINNET receiver wallet created ===');
  console.log('  address   :', account.address);
  console.log('  recovery  :', path.basename(MNEMONIC_FILE), '(12-word mnemonic, gitignored, mode 600)');
  console.log('  derivation: m/44\'/60\'/0\'/0/0');
  console.log('');
  console.log('  !! The mnemonic was written to that file and NOT printed here, on purpose.');
  console.log('     A terminal scrollback or CI log is as much a leak as a committed key.');
  console.log('  !! Open the file, import it into a wallet you trust, store it offline,');
  console.log('     then delete the local file. If you lose it, the revenue is lost.');
  console.log('  !! The server never needs it: x402 only requires the address.');
  console.log('');
  console.log('  Fund it with nothing. It RECEIVES USDC on Base; receiving needs no gas.');
  process.exit(0);
}

// ---- testnet: unchanged behaviour, disk key is acceptable for Base Sepolia
const existing = fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim() : null;
const pk = existing && /^0x[0-9a-fA-F]{64}$/.test(existing) ? existing : generatePrivateKey();
if (!existing) fs.writeFileSync(KEY_FILE, pk, { mode: 0o600 });

const account = privateKeyToAccount(pk);
writeEnv(account.address);

console.log('testnet receiver wallet ready');
console.log('  address     :', account.address);
console.log('  private key :', path.basename(KEY_FILE), '(gitignored)');
console.log('  env         : PAY_TO_ADDRESS written to .env');
console.log('');
console.log('For mainnet revenue run: node src/gen-wallet.mjs --mainnet');
console.log('That creates a mnemonic-backed wallet and leaves the secret out of stdout.');
