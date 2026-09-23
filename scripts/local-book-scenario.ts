/**
 * Put a maker's book into every state the book page has to show, on the local stack.
 *
 *   bash scripts/wsl/run.sh node scripts/local-book-scenario.ts <maker.json> <taker.json>
 *
 * Both keypairs must already be funded (scripts/fund-tester.ts). Creates, as the maker:
 *
 *   $100 at $1.30T   untouched                         → Open
 *   $120 at $1.25T   $50 taken                         → Partly taken
 *   $60  at $1.05T   $30 taken, the other $30 withdrawn → Fully taken, some withdrawn
 *   $80  at $1.15T   all taken, expires in ~70 seconds  → Expired, waiting to settle
 *
 * Sizes follow the same valuation-to-strike proportion the seed script gets from the live
 * PreStocks API ($100 at $1.00T locks 83,365,949 raw), so P&L on the book page is priced
 * against figures of the right order rather than invented ones.
 *
 * Local only: it refuses any RPC that is not localhost, because it spends real test
 * balances and leaves positions behind that nobody asked for.
 */
import { readFileSync } from 'node:fs';
import { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { rungFlows, usd } from './lib/rung-flows.ts';

const RPC = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8899';
if (!/127\.0\.0\.1|localhost/.test(RPC)) {
  console.error(`Refusing to run against ${new URL(RPC).host}: this script is for the local stack only.`);
  process.exit(1);
}

const [makerPath, takerPath] = process.argv.slice(2);
if (!makerPath || !takerPath) {
  console.error('usage: node scripts/local-book-scenario.ts <maker.json> <taker.json>');
  process.exit(1);
}
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));

/** Raw stock for a strike at a valuation, on the $100-at-$1.00T reference. */
const rawFor = (strikeUsd: number, valuationT: number) =>
  BigInt(Math.round(83_365_949 * (strikeUsd / 100) * (1 / valuationT)));

/** What to send so the vault clears `required` under the mock's 50bps fee, with margin. */
const grossUp = (required: bigint) => (required * 10_000n) / 9_950n + 2n;

async function main() {
  const maker = load(makerPath);
  const taker = load(takerPath);
  const deployment = JSON.parse(readFileSync('local.json', 'utf8'));
  const mint = new PublicKey(deployment.markets.OPENAI.mint);
  const usdc = new PublicKey(deployment.quoteMint);
  const idl = JSON.parse(readFileSync('packages/sdk/idl/rung.json', 'utf8')) as Idl;
  const connection = new Connection(RPC, 'confirmed');
  const program = new Program(idl, new AnchorProvider(connection, new Wallet(maker), { commitment: 'confirmed' }));
  const rung = rungFlows(program, usdc, { maker, taker, cranker: taker });
  const as = { signer: taker, quoteAccount: rung.usdcOf(taker.publicKey) };

  console.log(`maker ${maker.publicKey.toBase58()}`);
  console.log(`taker ${taker.publicKey.toBase58()}\n`);

  const untouched = await rung.create(mint, rawFor(100, 1.3), usd(100), usd(3), 30 * 86_400, 1.3e12);
  console.log(`Open            $100 at $1.30T   ${untouched.position.toBase58()}`);

  const partial = await rung.create(mint, rawFor(120, 1.25), usd(120), usd(4.8), 30 * 86_400, 1.25e12);
  await rung.accept(partial, grossUp(rawFor(50, 1.25)), { ...as, fillStrike: usd(50) });
  console.log(`Partly taken    $50 of $120 at $1.25T   ${partial.position.toBase58()}`);

  const pulled = await rung.create(mint, rawFor(60, 1.05), usd(60), usd(1.8), 30 * 86_400, 1.05e12);
  await rung.accept(pulled, grossUp(rawFor(30, 1.05)), { ...as, fillStrike: usd(30) });
  await rung.cancel(pulled);
  console.log(`Some withdrawn  $30 taken, $30 withdrawn at $1.05T   ${pulled.position.toBase58()}`);

  const expiring = await rung.create(mint, rawFor(80, 1.15), usd(80), usd(2.4), 70, 1.15e12);
  await rung.accept(expiring, grossUp(rawFor(80, 1.15)), as);
  console.log(`Expiring        $80 at $1.15T, all taken, deadline in ~70s   ${expiring.position.toBase58()}`);
  console.log(`\nIn ~70 seconds the last one is expired and waiting to settle.`);
}

main().catch((e) => {
  console.error(`\nFAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
