/**
 * Keep one live, matched position on devnet: the deployer opens a small floor and a demo
 * holder takes the other side.
 *
 *   bash scripts/wsl/run.sh node scripts/seed-matched.ts
 *
 * Open floors alone only tell the maker's half of the story. A matched position is what
 * gives the landing page a live, unrealized P&L and shows that the protection side works,
 * without a judge having to take a floor first. The existing open floors are left alone so
 * a presenter can still take one live.
 *
 * Idempotent: if the demo holder already has a live matched position, nothing is sent.
 * The holder's keypair lives in ~/rung-demo, outside the repo, and only ever holds devnet mocks.
 * Uses public devnet unless SEED_RPC_URL is set; only the host is printed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotent, mintTo } from '@solana/spl-token';
import { fetchMintState, fetchPreStock, rpcFromUrl } from '../packages/sdk/src/prestocks.ts';
import { bandAnchor, defaultTarget, quoteStrike, valuationBands } from '../packages/sdk/src/valuation.ts';
import { grossUpForRequired, worstCaseTransferFee } from '../packages/sdk/src/token2022.ts';
import { rungFlows, usd } from './lib/rung-flows.ts';

const RPC = process.env.SEED_RPC_URL ?? 'https://api.devnet.solana.com';
const DIR = `${process.env.HOME}/rung-demo`;
const SIZE_USD = 50;
const PREMIUM_USD = 2;
const EXPIRY_DAYS = 30;

async function main() {
  mkdirSync(DIR, { recursive: true });
  const holderPath = `${DIR}/holder.json`;
  if (!existsSync(holderPath)) {
    writeFileSync(holderPath, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  }
  const holder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(holderPath, 'utf8'))));
  const deployer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8'))),
  );
  const conn = new Connection(RPC, 'confirmed');
  const deployment = JSON.parse(readFileSync('devnet.json', 'utf8'));
  const usdc = new PublicKey(deployment.quoteMint);
  const mint = new PublicKey(deployment.markets.OPENAI.mint);
  const idl = JSON.parse(readFileSync('packages/sdk/idl/rung.json', 'utf8')) as Idl;
  const program = new Program(idl, new AnchorProvider(conn, new Wallet(deployer), { commitment: 'confirmed' }));
  const rung = rungFlows(program, usdc, { maker: deployer, taker: holder, cranker: holder });

  console.log(`RPC      ${RPC.split('?')[0]}`);
  console.log(`Maker    ${deployer.publicKey.toBase58()} (deployer)`);
  console.log(`Holder   ${holder.publicKey.toBase58()} (demo)`);

  const live = (await program.account.position.all()).find((p) => {
    const a = p.account as { taker: PublicKey; status: object };
    return a.taker.equals(holder.publicKey) && Object.keys(a.status)[0]?.toLowerCase() === 'matched';
  });
  if (live) {
    console.log(`Already live: ${live.publicKey.toBase58()} -- nothing to do.`);
    return;
  }

  // Fund the holder: SOL for fees and rent, mock OPENAI to lock, mock USDC for the premium.
  const have = await conn.getBalance(holder.publicKey);
  if (have < 0.05 * LAMPORTS_PER_SOL) {
    await program.provider.sendAndConfirm!(
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: holder.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL - have }),
      ),
      [],
    );
  }
  const holderStock = await createAssociatedTokenAccountIdempotent(conn, deployer, mint, holder.publicKey, {}, TOKEN_2022_PROGRAM_ID);
  const holderUsdc = await createAssociatedTokenAccountIdempotent(conn, deployer, usdc, holder.publicKey, {}, TOKEN_PROGRAM_ID);
  await mintTo(conn, deployer, mint, holderStock, deployer, 1_000_000_000n, [], undefined, TOKEN_2022_PROGRAM_ID);
  await mintTo(conn, deployer, usdc, holderUsdc, deployer, 20_000_000n, [], undefined, TOKEN_PROGRAM_ID);

  const asset = await fetchPreStock('OPENAI');
  const state = await fetchMintState(mint.toBase58(), rpcFromUrl(RPC));
  // The same default the commit panel opens with.
  const target = defaultTarget(valuationBands(bandAnchor(asset), 6), bandAnchor(asset));
  const q = quoteStrike({ asset, targetValuation: target, strikeUsd: SIZE_USD, decimals: state.decimals, multiplier: state.multiplier, transferFee: state.transferFee });

  const h = await rung.create(mint, q.rawQuantity, usd(SIZE_USD), usd(PREMIUM_USD), EXPIRY_DAYS * 86400, target);
  await rung.accept(h, grossUpForRequired(q.rawQuantity, worstCaseTransferFee(state.transferFeeConfig)));

  console.log(`\nLive matched position ${h.position.toBase58()}`);
  console.log(`  $${SIZE_USD} floor at $${(target / 1e12).toFixed(2)}T, $${PREMIUM_USD} premium, ${EXPIRY_DAYS} days`);
  console.log(`  https://explorer.solana.com/address/${h.position.toBase58()}?cluster=devnet`);
}

main().catch((e) => {
  console.error('\nFAILED:', e instanceof Error ? e.message : e);
  if (e && typeof e === 'object' && 'logs' in e) console.error((e as { logs: string[] }).logs?.join('\n'));
  process.exit(1);
});
