/**
 * Finish uploading a program buffer at a pace a rate-limited RPC will accept.
 *
 *   node scripts/wsl/upload-buffer.mjs <BUFFER_KEYPAIR_OR_ADDRESS> <RPC_URL> [SO_PATH]
 *
 * `solana program deploy` sends buffer writes as fast as it can. Against public devnet
 * (about 40 sends per 10 s per IP) that turns into a storm of 429s in which almost nothing
 * lands, and the CLI keeps retrying for as long as it is allowed to. This does the one
 * part that needs pacing: it reads the buffer, writes only the chunks that differ from the
 * binary at ~3 transactions a second, then reads again and repeats until they match.
 *
 * Creates the buffer first if it does not exist (pass the buffer's keypair file for that).
 * scripts/wsl/deploy-program.sh calls this, then applies the finished buffer in a single
 * transaction.
 *
 * Signs with ~/.config/solana/id.json, which must be the buffer's authority (it is, for
 * buffers created by deploy-program.sh). Only the RPC host is printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const HEADER = 37; // UpgradeableLoaderState::Buffer: u32 tag + Option<Pubkey>
const CHUNK = 1000; // fits a legacy transaction with one signer and no compute-budget ix
const SENDS_PER_SECOND = 3;

const [bufferArg, rpc, soPath = 'target/deploy/rung.so'] = process.argv.slice(2);
if (!bufferArg || !rpc) {
  console.error('usage: upload-buffer.mjs <BUFFER_KEYPAIR_OR_ADDRESS> <RPC_URL> [SO_PATH]');
  process.exit(1);
}
const loadKeypair = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
const bufferKeypair = existsSync(bufferArg) ? loadKeypair(bufferArg) : null;
const buffer = bufferKeypair ? bufferKeypair.publicKey : new PublicKey(bufferArg);
const authority = loadKeypair(`${process.env.HOME}/.config/solana/id.json`);
const conn = new Connection(rpc, 'confirmed');
const so = readFileSync(soPath);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** bincode of UpgradeableLoaderInstruction::Write { offset: u32, bytes: Vec<u8> }. */
function writeIx(offset, bytes) {
  const data = Buffer.alloc(4 + 4 + 8 + bytes.length);
  data.writeUInt32LE(1, 0);
  data.writeUInt32LE(offset, 4);
  data.writeBigUInt64LE(BigInt(bytes.length), 8);
  bytes.copy(data, 16);
  return new TransactionInstruction({
    programId: LOADER,
    keys: [
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });
}

async function withBackoff(label, fn) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 8) throw e;
      const wait = /429|Too many/i.test(String(e)) ? 5000 * i : 1000 * i;
      console.log(`  ${label}: ${String(e).slice(0, 90)} -- retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

/**
 * Create and initialize the buffer if it does not exist yet. Needs the buffer's keypair,
 * since the new account must sign its own creation.
 */
async function ensureBuffer() {
  if (await withBackoff('read buffer', () => conn.getAccountInfo(buffer, 'confirmed'))) return;
  if (!bufferKeypair) throw new Error(`Buffer ${buffer.toBase58()} does not exist; pass its keypair file to create it`);
  const space = HEADER + so.length;
  const lamports = await withBackoff('rent', () => conn.getMinimumBalanceForRentExemption(space));
  // UpgradeableLoaderInstruction::InitializeBuffer is variant 0: [buffer (w), authority].
  const init = new TransactionInstruction({
    programId: LOADER,
    keys: [
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([0, 0, 0, 0]),
  });
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: buffer, lamports, space, programId: LOADER }),
    init,
  );
  const sig = await withBackoff('create buffer', () => sendAndConfirmTransaction(conn, tx, [authority, bufferKeypair], { commitment: 'confirmed' }));
  console.log(`Created buffer (${(lamports / 1e9).toFixed(4)} SOL rent, returned when the deploy lands): ${sig}`);
}

async function missingChunks() {
  const info = await withBackoff('read buffer', () => conn.getAccountInfo(buffer, 'confirmed'));
  if (!info) throw new Error(`Buffer ${buffer.toBase58()} does not exist`);
  if (!info.owner.equals(LOADER)) throw new Error('That account is not a program buffer');
  const data = info.data.subarray(HEADER);
  if (data.length < so.length) throw new Error(`Buffer holds ${data.length} bytes; the binary needs ${so.length}`);
  const missing = [];
  for (let off = 0; off < so.length; off += CHUNK) {
    const want = so.subarray(off, off + CHUNK);
    if (!want.equals(data.subarray(off, off + want.length))) missing.push(off);
  }
  return missing;
}

console.log(`RPC     ${rpc.split('?')[0]}`);
console.log(`Buffer  ${buffer.toBase58()}`);
console.log(`Binary  ${so.length} bytes in ${Math.ceil(so.length / CHUNK)} chunks`);
await ensureBuffer();

for (let round = 1; round <= 12; round++) {
  const missing = await missingChunks();
  console.log(`Round ${round}: ${missing.length} chunk(s) to write`);
  if (missing.length === 0) {
    console.log('Buffer matches the binary. Now run deploy-program.sh to finish.');
    process.exit(0);
  }
  let blockhash = null;
  for (const [i, off] of missing.entries()) {
    if (i % 40 === 0) blockhash = (await withBackoff('blockhash', () => conn.getLatestBlockhash('confirmed'))).blockhash;
    const tx = new Transaction({ feePayer: authority.publicKey, recentBlockhash: blockhash }).add(
      writeIx(off, so.subarray(off, off + CHUNK)),
    );
    tx.sign(authority);
    // Fire and move on; the next round's read shows what landed. No preflight: it would
    // double the requests, and a failed write is simply retried next round.
    await withBackoff(`chunk @${off}`, () => conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 }));
    await sleep(1000 / SENDS_PER_SECOND);
  }
  console.log('  waiting for writes to confirm…');
  await sleep(20_000);
}
console.error('Buffer still incomplete after 12 rounds; re-run to continue.');
process.exit(1);
