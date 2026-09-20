/**
 * Generate a Solana keypair file without solana-keygen.
 *
 * The from-source `solana-cli` install on aarch64 provides only the `solana` binary, not
 * `solana-keygen`, and installing another crate just to make one devnet wallet is not worth
 * the compile. Node's crypto module produces ed25519 keys natively, and Solana's id.json is
 * simply the 64-byte secret (32-byte seed followed by the 32-byte public key) as a JSON
 * array of numbers.
 *
 *   node scripts/wsl/gen-keypair.mjs ~/.config/solana/id.json
 *
 * Refuses to overwrite an existing file, so it cannot destroy a funded wallet.
 */
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const raw = process.argv[2] ?? '~/.config/solana/id.json';
const out = resolve(raw.startsWith('~') ? raw.replace(/^~/, homedir()) : raw);

if (existsSync(out)) {
  console.error(`Refusing to overwrite existing keypair at ${out}`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
// DER wrappers put the raw key material at the end: the last 32 bytes of the PKCS#8
// private key are the seed, and the last 32 of the SPKI public key are the public key.
const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
const secret = Buffer.concat([seed, pub]);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify([...secret]));
try {
  chmodSync(out, 0o600);
} catch {
  // Best effort; not fatal on filesystems that do not support it.
}

// base58, so the address can be confirmed against `solana address`.
const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let n = 0n;
for (const b of pub) n = n * 256n + BigInt(b);
let s = '';
while (n > 0n) {
  s = A[Number(n % 58n)] + s;
  n /= 58n;
}
for (const b of pub) {
  if (b === 0) s = '1' + s;
  else break;
}

console.log(`wrote   ${out}`);
console.log(`address ${s}`);
