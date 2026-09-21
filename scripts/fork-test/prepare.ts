/**
 * Stage real mainnet state for a local fork test of Rung.
 *
 *   node scripts/fork-test/prepare.ts [SYMBOLS]      (default OPENAI,SPACEX)
 *
 * The devnet mock reproduces the transfer fee and multiplier, but the real PreStocks mints
 * also carry a transfer-hook slot, pausable, confidential-transfer and default-state
 * extensions the mock never had. The only faithful test is against the real mint accounts.
 *
 * Each mint (and USDC's) is copied byte for byte from mainnet with ONE change: its mint
 * authority is set to a local test key, so the fork can mint balances. Nothing else moves --
 * every extension, the issuer's permanent delegate, freeze and pause authorities, the fee
 * schedule -- and mint authority plays no part in how transfers behave. Token accounts are
 * then created on the fork through the real ATA program, so Token-2022 itself lays out the
 * account extensions these mints require rather than this script guessing at them.
 *
 * Everything is written under ~/rung-fork, outside the repo. The keypairs there are
 * throwaway and only ever hold anything on a local validator.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { USDC_MINT, fetchPreStocks } from '../../packages/sdk/src/prestocks.ts';

const DIR = `${process.env.HOME}/rung-fork`;
const SOURCE_RPC = process.env.FORK_SOURCE_RPC ?? 'https://api.mainnet-beta.solana.com';
const SYMBOLS = (process.argv[2] ?? 'OPENAI,SPACEX').split(',').map((s) => s.trim().toUpperCase());

function keypair(name: string): Keypair {
  const path = `${DIR}/${name}.json`;
  if (existsSync(path)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

/** Mint base layout: mint_authority is a COption<Pubkey> -- a u32 tag, then 32 bytes. */
function withMintAuthority(data: Buffer, authority: PublicKey): Buffer {
  const out = Buffer.from(data);
  out.writeUInt32LE(1, 0);
  authority.toBuffer().copy(out, 4);
  return out;
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  rmSync(`${DIR}/accounts`, { recursive: true, force: true });
  mkdirSync(`${DIR}/accounts`, { recursive: true });

  const wallets = Object.fromEntries(
    ['admin', 'maker', 'taker', 'cranker'].map((n) => [n, keypair(n)]),
  ) as Record<'admin' | 'maker' | 'taker' | 'cranker', Keypair>;

  const assets = await fetchPreStocks();
  const mints = SYMBOLS.map((symbol) => {
    const asset = assets.find((a) => a.symbol.toUpperCase() === symbol);
    if (!asset) throw new Error(`PreStocks API has no ${symbol}`);
    return new PublicKey(asset.contract_address);
  });

  const source = new Connection(SOURCE_RPC, 'confirmed');
  const all = [...mints, new PublicKey(USDC_MINT)];
  const infos = await source.getMultipleAccountsInfo(all);
  infos.forEach((info, i) => {
    if (!info) throw new Error(`${all[i].toBase58()} not found on mainnet`);
    const data = withMintAuthority(Buffer.from(info.data), wallets.admin.publicKey);
    writeFileSync(
      `${DIR}/accounts/${all[i].toBase58()}.json`,
      JSON.stringify({
        pubkey: all[i].toBase58(),
        account: {
          lamports: info.lamports,
          data: [data.toString('base64'), 'base64'],
          owner: info.owner.toBase58(),
          executable: false,
          rentEpoch: 0,
          space: data.length,
        },
      }),
    );
    const label = i < SYMBOLS.length ? SYMBOLS[i] : 'USDC';
    console.log(`${label.padEnd(10)} ${all[i].toBase58()}  ${data.length} bytes, owner ${info.owner.toBase58().slice(0, 8)}`);
  });

  writeFileSync(
    `${DIR}/fork.json`,
    JSON.stringify({ symbols: SYMBOLS, mints: mints.map((m) => m.toBase58()), usdc: USDC_MINT }, null, 2),
  );
  for (const [name, kp] of Object.entries(wallets)) console.log(`${name.padEnd(8)} ${kp.publicKey.toBase58()}`);
}

main().catch((e) => {
  console.error('prepare failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
