/**
 * Give the devnet book depth: several makers, every listed market, floors across the bands
 * the curve draws, and a few slices already taken.
 *
 *   bash scripts/wsl/run.sh node scripts/seed-depth.ts [--dry-run]
 *
 * One maker's three floors on one market show that the mechanism works. They cannot show a
 * sweep crossing floors from different makers, a ladder landing among other people's capital,
 * or a curve whose concentration note has anything to say. This lays down a book shaped like
 * demand:
 *
 *   - every listed market gets floors on the bands the curve draws, strictly below where the
 *     asset trades, with OpenAI deepest because it is the one every demo opens on;
 *   - each band is shared by up to three makers -- the deployer and four demo wallets -- so no
 *     band is one wallet dressed up as a market;
 *   - size peaks in the middle bands, and premium falls with depth, because protection further
 *     below the mark is less likely to be used; a little jitter keeps it from looking printed;
 *   - terms run 21 to 60 days;
 *   - a few commitments have a slice already taken by one of two demo holders, so the book has
 *     capital in force, the maker's book has fills, and P&L has something to price.
 *
 * Everything is sized the way the app sizes it: strikes by quoteStrike against the live
 * PreStocks marks and each mint's live multiplier, slices by quoteFill, transfers against the
 * worse of the two fee slots. A market whose feed is inconsistent is skipped, and if the API is
 * down the script stops; nothing is priced from an invented mark.
 *
 * The demo wallets live in ~/rung-demo (makers/maker-1..4.json, holder.json, holder-2.json),
 * outside the repository, and are created on first run. They only ever hold devnet SOL and
 * mocks, which the deployer tops up: SOL for rent and mock USDC or PreStocks by minting, since
 * it holds every mock's mint authority. Transaction fees are the deployer's.
 *
 * Deterministic: the plan comes from a fixed seed, and a commitment is skipped when its maker
 * already has an active one at that valuation on that market, so a re-run only fills gaps.
 * Refuses any cluster that is not devnet. Uses public devnet unless SEED_RPC_URL is set.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { AnchorProvider, BN, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  getAccount,
  mintTo,
} from '@solana/spl-token';
import { fetchMintState, fetchPreStocks, rpcFromUrl, type MintState } from '../packages/sdk/src/prestocks.ts';
import { bandAnchor, isFeedConsistent, quoteStrike, valuationBands, type PreStockAsset } from '../packages/sdk/src/valuation.ts';
import { grossUpForRequired, worstCaseTransferFee } from '../packages/sdk/src/token2022.ts';
import { fillRejection, quoteFill } from '../packages/sdk/src/fills.ts';
import { rungFlows, sleep, type Handle } from './lib/rung-flows.ts';

const RPC = process.env.SEED_RPC_URL ?? 'https://api.devnet.solana.com';
const DRY_RUN = process.argv.includes('--dry-run');
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const DIR = `${process.env.HOME}/rung-demo`;
const SEED = 0x52554e47; // "RUNG"

/** Rent a maker pays per commitment (position + two vaults), and a taker per slice, measured on devnet. */
const RENT_PER_COMMITMENT = 0.0052 * LAMPORTS_PER_SOL;
const RENT_PER_SLICE = 0.0014 * LAMPORTS_PER_SOL;

/**
 * How deep each market's book is. `makers[i]` is how many makers share the i-th band below
 * the anchor; `scale` is a typical commitment at the busiest band, in USDC; `slices` is how
 * many of the new commitments get a slice taken.
 */
const BOOKS: { symbol: string; scale: number; makers: number[]; slices: number }[] = [
  { symbol: 'OPENAI', scale: 400, makers: [2, 2, 3, 2, 2, 1], slices: 4 },
  { symbol: 'SPACEX', scale: 320, makers: [1, 2, 2, 2, 1, 1], slices: 2 },
  { symbol: 'ANTHROPIC', scale: 260, makers: [1, 1, 2, 2, 1, 1], slices: 2 },
  { symbol: 'ANDURIL', scale: 160, makers: [0, 1, 1, 1, 1, 0], slices: 0 },
  { symbol: 'KALSHI', scale: 140, makers: [0, 1, 1, 1, 1, 0], slices: 1 },
  { symbol: 'NEURALINK', scale: 140, makers: [0, 1, 1, 1, 1, 0], slices: 0 },
  { symbol: 'POLYMARKET', scale: 150, makers: [0, 1, 1, 1, 1, 0], slices: 1 },
  { symbol: 'FIGUREAI', scale: 120, makers: [0, 1, 1, 1, 1, 0], slices: 0 },
];
/** Share of `scale` at each band, nearest first: demand peaks a little below the market. */
const SHAPE = [0.55, 0.8, 1, 0.85, 0.6, 0.4];
/** Premium as a share of strike at each band, nearest first. */
const RATE = [0.05, 0.04, 0.032, 0.025, 0.02, 0.016];
const TERMS_DAYS = [21, 30, 30, 45, 60];

/** mulberry32, as in tests/invariants.ts: the same plan for the same seed, every run. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const between = (lo: number, hi: number) => lo + (hi - lo) * rand();
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const usd6 = (n: number) => BigInt(Math.round(n * 1e6));
const label = (v: number) => (v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : `$${Math.round(v / 1e9)}B`);
const sol = (lamports: number) => (lamports / LAMPORTS_PER_SOL).toFixed(4);

/**
 * Public devnet rate-limits and drops requests under a burst of this size, so retry -- but only
 * what is safe to repeat. Funding re-reads balances before it sends, so any transient failure
 * may be retried. A create or a slice is retried only on errors that prove nothing landed: a
 * rejected request, or a simulation against a blockhash the node had not seen. A timeout after
 * sending is ambiguous, and repeating it could put the same commitment on the book twice.
 */
const TRANSIENT = /429|rate limit|Blockhash not found|block height exceeded|fetch failed|timed? ?out|ECONNRESET|socket hang up/i;
const NOT_LANDED = /429|rate limit|Blockhash not found/i;
async function retry<T>(fn: () => Promise<T>, safe: RegExp): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === 6 || !safe.test(err instanceof Error ? err.message : String(err))) throw err;
      await sleep(2_000 * attempt);
    }
  }
}

function wallet(path: string): Keypair {
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

type Planned = {
  symbol: string;
  maker: number;
  target: number;
  sizeUsd: number;
  premiumUsd: number;
  days: number;
  slice: number | null;
  taker: number;
};

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  if ((await conn.getGenesisHash()) !== DEVNET_GENESIS) throw new Error(`${new URL(RPC).host} is not devnet`);

  mkdirSync(`${DIR}/makers`, { recursive: true });
  const deployer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8'))),
  );
  const makers = [deployer, ...[1, 2, 3, 4].map((i) => wallet(`${DIR}/makers/maker-${i}.json`))];
  const takers = [wallet(`${DIR}/holder.json`), wallet(`${DIR}/holder-2.json`)];

  const deployment = JSON.parse(readFileSync(process.env.DEPLOYMENT_FILE ?? 'devnet.json', 'utf8'));
  const idl = JSON.parse(readFileSync('packages/sdk/idl/rung.json', 'utf8')) as Idl & { address: string };
  if (idl.address !== deployment.programId) throw new Error(`IDL is for ${idl.address}, deployment is ${deployment.programId}`);
  const usdc = new PublicKey(deployment.quoteMint);
  const program = new Program(idl, new AnchorProvider(conn, new Wallet(deployer), { commitment: 'confirmed' }));
  const flowsFor = (maker: Keypair) => rungFlows(program, usdc, { maker, taker: takers[0], cranker: deployer });
  const config = (await (program.account as any).globalConfig.fetch(flowsFor(deployer).configPda)) as {
    feeBps: number;
    minFillQuote: BN;
  };
  const minFill = BigInt(config.minFillQuote.toString());

  console.log(`RPC      ${new URL(RPC).host}`);
  console.log(`Program  ${idl.address}`);
  makers.forEach((m, i) => console.log(`Maker ${i}  ${m.publicKey.toBase58()}${i === 0 ? ' (deployer)' : ''}`));
  takers.forEach((t, i) => console.log(`Taker ${i}  ${t.publicKey.toBase58()}`));

  // --- the plan, from the fixed seed -------------------------------------------------------
  const assets = new Map((await fetchPreStocks()).map((a) => [a.symbol.toUpperCase(), a]));
  const plan: Planned[] = [];
  const priced = new Map<string, PreStockAsset>();
  for (const book of BOOKS) {
    const asset = assets.get(book.symbol);
    // Draw the book's random numbers even for a skipped market, so one market's feed going
    // bad does not reshuffle every other market's plan.
    const anchor = asset ? bandAnchor(asset) : 0;
    const floors = asset ? valuationBands(anchor, 6).filter((v) => v < anchor) : [];
    const entries: Planned[] = [];
    book.makers.forEach((count, i) => {
      const who = [0, 1, 2, 3, 4].sort(() => rand() - 0.5).slice(0, count);
      for (const maker of who) {
        const sizeUsd = Math.min(900, Math.max(25, Math.round((book.scale * SHAPE[i] * between(0.6, 1.25)) / 5) * 5));
        const premiumUsd = Math.round(sizeUsd * RATE[i] * between(0.85, 1.15) * 100) / 100;
        const days = pick(TERMS_DAYS);
        if (floors[i] !== undefined) entries.push({ symbol: book.symbol, maker, target: floors[i], sizeUsd, premiumUsd, days, slice: null, taker: 0 });
      }
    });
    const sliced = entries.slice().sort(() => rand() - 0.5).slice(0, book.slices);
    for (const e of sliced) {
      e.slice = Math.max(10, Math.round((e.sizeUsd * between(0.3, 0.7)) / 5) * 5);
      e.taker = rand() < 0.5 ? 0 : 1;
    }
    if (!asset) {
      console.log(`\nSkip     ${book.symbol}: not in the PreStocks feed`);
      continue;
    }
    if (!isFeedConsistent(asset)) {
      console.log(`\nSkip     ${book.symbol}: mark and implied valuation disagree on share count`);
      continue;
    }
    priced.set(book.symbol, asset);
    plan.push(...entries);
  }

  // Skip what each maker already has: an active commitment at the same valuation on the same market.
  const active = new Set<string>();
  for (const p of (await (program.account as any).position.all()) as { account: any }[]) {
    const status = Object.keys(p.account.status)[0].toLowerCase();
    if (status !== 'open' && status !== 'partiallymatched' && status !== 'matched') continue;
    active.add(`${p.account.maker.toBase58()}|${p.account.stockMint.toBase58()}|${p.account.targetValuationUsd.toString()}`);
  }
  const todo = plan.filter(
    (e) => !active.has(`${makers[e.maker].publicKey.toBase58()}|${deployment.markets[e.symbol].mint}|${Math.round(e.target)}`),
  );

  console.log('');
  for (const book of BOOKS) {
    const rows = todo.filter((e) => e.symbol === book.symbol);
    if (!rows.length) continue;
    const anchor = bandAnchor(priced.get(book.symbol)!);
    console.log(`${book.symbol.padEnd(11)} anchor ${label(anchor)}`);
    for (const e of rows.sort((a, b) => b.target - a.target)) {
      const rate = ((e.premiumUsd / e.sizeUsd) * 100).toFixed(1);
      const slice = e.slice ? `  slice $${e.slice} to taker ${e.taker}` : '';
      console.log(`  ${label(e.target).padStart(7)}  maker ${e.maker}  $${String(e.sizeUsd).padStart(3)}  ${rate}%  ${e.days}d${slice}`);
    }
  }
  const skipped = plan.length - todo.length;
  const slices = todo.filter((e) => e.slice);
  const capital = todo.reduce((s, e) => s + e.sizeUsd, 0);
  const rent = todo.length * RENT_PER_COMMITMENT + slices.length * RENT_PER_SLICE;
  console.log(
    `\n${todo.length} commitments ($${capital.toLocaleString()} USDC) and ${slices.length} slices` +
      `${skipped ? `; ${skipped} already on the book` : ''}. About ${sol(rent)} SOL of rent.`,
  );
  const deployerBefore = await conn.getBalance(deployer.publicKey);
  console.log(`Deployer ${sol(deployerBefore)} SOL`);
  if (DRY_RUN || todo.length === 0) return;
  if (deployerBefore - rent < 0.1 * LAMPORTS_PER_SOL) throw new Error('that would leave the deployer under 0.1 SOL');

  // --- funding: SOL for rent, mock USDC and PreStocks by minting ----------------------------
  const topUpSol = (to: Keypair, lamports: number) => retry(async () => {
    const have = await conn.getBalance(to.publicKey);
    if (have >= lamports || to.publicKey.equals(deployer.publicKey)) return;
    await program.provider.sendAndConfirm!(
      new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: to.publicKey, lamports: lamports - have })),
      [],
    );
  }, TRANSIENT);
  const mintUpTo = (mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey, want: bigint) => retry(async () => {
    const ata = await createAssociatedTokenAccountIdempotent(conn, deployer, mint, owner, {}, tokenProgram);
    const have = (await getAccount(conn, ata, 'confirmed', tokenProgram)).amount;
    if (have < want) await mintTo(conn, deployer, mint, ata, deployer, want - have, [], undefined, tokenProgram);
  }, TRANSIENT);

  console.log('\nFunding');
  for (const [i, m] of makers.entries()) {
    const mine = todo.filter((e) => e.maker === i);
    if (!mine.length || i === 0) continue;
    await topUpSol(m, mine.length * RENT_PER_COMMITMENT + 0.01 * LAMPORTS_PER_SOL);
    await mintUpTo(usdc, m.publicKey, TOKEN_PROGRAM_ID, usd6(mine.reduce((s, e) => s + e.sizeUsd, 0) + 50));
    console.log(`  maker ${i}  ${mine.length} commitments`);
  }
  const states = new Map<string, MintState>();
  for (const symbol of priced.keys()) {
    states.set(symbol, await retry(() => fetchMintState(deployment.markets[symbol].mint, rpcFromUrl(RPC)), TRANSIENT));
    await sleep(500);
  }
  for (const [i, t] of takers.entries()) {
    const mine = slices.filter((e) => e.taker === i);
    if (!mine.length) continue;
    await topUpSol(t, mine.length * RENT_PER_SLICE + 0.01 * LAMPORTS_PER_SOL);
    await mintUpTo(usdc, t.publicKey, TOKEN_PROGRAM_ID, usd6(200));
    // Generously more stock than any slice needs: 1,000 whole tokens' worth of raw units.
    for (const symbol of new Set(mine.map((e) => e.symbol))) {
      const state = states.get(symbol)!;
      await mintUpTo(new PublicKey(state.mint), t.publicKey, TOKEN_2022_PROGRAM_ID, 1_000n * 10n ** BigInt(state.decimals));
    }
    console.log(`  taker ${i}  ${mine.length} slices`);
  }

  // --- the book ------------------------------------------------------------------------------
  console.log('\nCommitments');
  let made = 0;
  let taken = 0;
  for (const e of todo) {
    const asset = priced.get(e.symbol)!;
    const state = states.get(e.symbol)!;
    const mint = new PublicKey(state.mint);
    const maker = makers[e.maker];
    const q = quoteStrike({
      asset,
      targetValuation: e.target,
      strikeUsd: e.sizeUsd,
      decimals: state.decimals,
      multiplier: state.multiplier,
      transferFee: state.transferFee,
    });
    const rung = flowsFor(maker);
    let h: Handle;
    try {
      h = await retry(
        () => rung.create(mint, q.rawQuantity, new BN(usd6(e.sizeUsd).toString()), new BN(usd6(e.premiumUsd).toString()), e.days * 86_400, e.target),
        NOT_LANDED,
      );
    } catch (err) {
      console.log(`  FAILED   ${e.symbol} ${label(e.target)} maker ${e.maker}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    made += 1;
    let note = '';
    if (e.slice) {
      const p = await retry(() => (program.account as any).position.fetch(h.position), TRANSIENT);
      const terms = {
        strikeQuoteEscrowed: BigInt(p.strikeQuoteEscrowed.toString()),
        strikeQuoteOpen: BigInt(p.strikeQuoteOpen.toString()),
        stockRawRequired: BigInt(p.stockRawRequired.toString()),
        premiumQuoteAmount: BigInt(p.premiumQuoteAmount.toString()),
      };
      const want = usd6(e.slice);
      const refused = fillRejection(terms, want, minFill);
      if (refused) {
        note = `  (slice refused: ${refused})`;
      } else {
        const fq = quoteFill(terms, want, config.feeBps);
        const taker = takers[e.taker];
        try {
          await retry(
            () =>
              rung.accept(h, grossUpForRequired(fq.stockRawRequired, worstCaseTransferFee(state.transferFeeConfig)), {
                signer: taker,
                quoteAccount: rung.usdcOf(taker.publicKey),
                fillStrike: new BN(want.toString()),
              }),
            NOT_LANDED,
          );
          taken += 1;
          note = `  $${e.slice} taken`;
        } catch (err) {
          note = `  (slice FAILED: ${err instanceof Error ? err.message : err})`;
        }
      }
    }
    console.log(`  ${e.symbol.padEnd(11)}${label(e.target).padStart(7)}  maker ${e.maker}  $${e.sizeUsd}${note}`);
    await sleep(300);
  }

  const deployerAfter = await conn.getBalance(deployer.publicKey);
  console.log(`\n${made} of ${todo.length} commitments made, ${taken} of ${slices.length} slices taken.`);
  console.log(`Deployer ${sol(deployerBefore)} -> ${sol(deployerAfter)} SOL (${sol(deployerBefore - deployerAfter)} spent, rent and top-ups included)`);
}

main().catch((e) => {
  console.error(`\nFAILED: ${e instanceof Error ? e.message : String(e)}`);
  if (e && typeof e === 'object' && 'logs' in e) console.error((e as { logs?: string[] }).logs?.join('\n'));
  process.exit(1);
});
