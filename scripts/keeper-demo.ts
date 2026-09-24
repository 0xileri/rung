/**
 * Put one claim on devnet that runs out in a few minutes, then watch the keeper settle it.
 *
 *   bash scripts/wsl/run.sh node scripts/keeper-demo.ts <maker.json> <taker.json> [--minutes N] [--watch]
 *
 * The keeper runs every ten minutes, and on an ordinary book it has nothing to do for weeks:
 * claims last a month. This makes one that is due now, so settlement can be seen happening
 * without either party lifting a finger:
 *
 *   the maker commits $20 at a $1.00T target on OPENAI, for a $0.50 premium;
 *   the taker takes all of it;
 *   the deadline passes, the book shows the claim waiting to settle;
 *   the keeper's next pass settles it: USDC back to the maker, tokens back to the taker.
 *
 * By default the deadline lands two minutes before a keeper pass (they run at :00, :10, ...
 * UTC), and never sooner than three minutes out, so there is time to open the book before it
 * and to see the claim sit past its deadline after it. --minutes N sets it directly.
 *
 * --watch keeps polling the claim and reports who settled it and when. It should be the
 * keeper's wallet, not either party's.
 *
 * Both keypairs must hold devnet SOL, mock USDC and mock OPENAI (the site's "Get test
 * tokens" button, or scripts/fund-tester.ts). Refuses any cluster that is not devnet. Uses
 * public devnet unless --rpc or DEVNET_RPC_URL says otherwise; only the host is printed.
 */
import { readFileSync } from 'node:fs';
import { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { fetchMintState, fetchPreStock, rpcFromUrl } from '../packages/sdk/src/prestocks.ts';
import { quoteStrike } from '../packages/sdk/src/valuation.ts';
import { grossUpForRequired, worstCaseTransferFee } from '../packages/sdk/src/token2022.ts';
import { rungFlows, sleep, usd } from './lib/rung-flows.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const VALUED = new Set(['--minutes', '--rpc']);
const [makerPath, takerPath] = args.filter((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1]));
if (!makerPath || !takerPath) {
  console.error('usage: node scripts/keeper-demo.ts <maker.json> <taker.json> [--minutes N] [--watch]');
  process.exit(1);
}

const RPC = flag('rpc') ?? process.env.DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const SIZE_USD = 20;
const PREMIUM_USD = 0.5;
const TARGET_VALUATION = 1e12;
const KEEPER_PERIOD_MS = 10 * 60_000;

/** Minutes until two minutes before a keeper pass, at least three minutes from now. */
function minutesToNextSlot(now = Date.now()): number {
  let pass = Math.ceil(now / KEEPER_PERIOD_MS) * KEEPER_PERIOD_MS;
  while (pass - 2 * 60_000 - now < 3 * 60_000) pass += KEEPER_PERIOD_MS;
  return (pass - 2 * 60_000 - now) / 60_000;
}

const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
const clock = (unix: number) => new Date(unix * 1000).toISOString().slice(11, 19) + ' UTC';
const explorer = (kind: 'address' | 'tx', id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  if ((await conn.getGenesisHash()) !== DEVNET_GENESIS) {
    throw new Error(`${new URL(RPC).host} is not devnet; this script only makes demo claims on devnet`);
  }
  const maker = load(makerPath);
  const taker = load(takerPath);
  const deployment = JSON.parse(readFileSync(process.env.DEPLOYMENT_FILE ?? 'devnet.json', 'utf8'));
  const usdc = new PublicKey(deployment.quoteMint);
  const mint = new PublicKey(deployment.markets.OPENAI.mint);
  const idl = JSON.parse(readFileSync('packages/sdk/idl/rung.json', 'utf8')) as Idl & { address: string };
  if (idl.address !== deployment.programId) {
    throw new Error(`the IDL is for ${idl.address} but the deployment file names ${deployment.programId}`);
  }
  const program = new Program(idl, new AnchorProvider(conn, new Wallet(maker), { commitment: 'confirmed' }));
  const rung = rungFlows(program, usdc, { maker, taker, cranker: taker });

  const minutes = flag('minutes') ? Number(flag('minutes')) : minutesToNextSlot();
  const offsetSecs = Math.round(minutes * 60);
  if (!(offsetSecs >= 90)) throw new Error('--minutes must be at least 1.5: the program refuses deadlines under a minute away');

  console.log(`RPC     ${new URL(RPC).host}`);
  console.log(`Program ${idl.address}`);
  console.log(`Maker   ${maker.publicKey.toBase58()}`);
  console.log(`Taker   ${taker.publicKey.toBase58()}\n`);

  // Sized exactly as the commit panel would size it, against the live mark and the mint's
  // own multiplier; the taker sends enough to clear the worse of the two fee slots.
  const asset = await fetchPreStock('OPENAI');
  const state = await fetchMintState(mint.toBase58(), rpcFromUrl(RPC));
  const q = quoteStrike({
    asset,
    targetValuation: TARGET_VALUATION,
    strikeUsd: SIZE_USD,
    decimals: state.decimals,
    multiplier: state.multiplier,
    transferFee: state.transferFee,
  });

  const h = await rung.create(mint, q.rawQuantity, usd(SIZE_USD), usd(PREMIUM_USD), offsetSecs, TARGET_VALUATION);
  console.log(`Committed  $${SIZE_USD} at $1.00T, $${PREMIUM_USD.toFixed(2)} premium   ${explorer('address', h.position.toBase58())}`);
  const fill = await rung.accept(h, grossUpForRequired(q.rawQuantity, worstCaseTransferFee(state.transferFeeConfig)));
  console.log(`Taken      all of it                              ${explorer('address', fill.toBase58())}`);
  const passAfter = Math.ceil((h.expiryTs * 1000) / KEEPER_PERIOD_MS) * KEEPER_PERIOD_MS;
  console.log(`\nDeadline   ${clock(h.expiryTs)}`);
  console.log(`Keeper     next pass after it at ${clock(passAfter / 1000)}`);

  if (!args.includes('--watch')) return;

  // Poll until the claim is no longer running, then find the transaction that settled it.
  console.log('\nWatching the claim ...');
  let reportedDue = false;
  for (;;) {
    const f = (await (program.account as any).fill.fetch(fill)) as { status: object };
    const status = Object.keys(f.status)[0].toLowerCase();
    if (status !== 'matched') {
      const [latest] = await conn.getSignaturesForAddress(fill, { limit: 1 });
      const tx = await conn.getTransaction(latest.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      const payer = tx?.transaction.message.staticAccountKeys[0].toBase58() ?? 'unknown';
      const who = payer === maker.publicKey.toBase58() ? 'the maker' : payer === taker.publicKey.toBase58() ? 'the taker' : 'neither party';
      const at = latest.blockTime ?? 0;
      console.log(`\n${status === 'expired' ? 'Settled' : 'Ended'} (${status}) at ${clock(at)}, ${Math.max(0, at - h.expiryTs)}s after the deadline`);
      console.log(`  by ${payer} (${who})`);
      console.log(`  ${explorer('tx', latest.signature)}`);
      return;
    }
    const now = await rung.clusterNow();
    if (now > h.expiryTs && !reportedDue) {
      console.log(`${clock(now)}  past its deadline, waiting for anyone to settle it`);
      reportedDue = true;
    }
    await sleep(15_000);
  }
}

main().catch((e) => {
  console.error(`\nFAILED: ${e instanceof Error ? e.message : String(e)}`);
  if (e && typeof e === 'object' && 'logs' in e) console.error((e as { logs?: string[] }).logs?.join('\n'));
  process.exit(1);
});
