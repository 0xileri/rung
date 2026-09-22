/**
 * Fund a wallet so it can exercise the whole flow on devnet.
 *
 *   node scripts/fund-tester.ts <address>
 *
 * SOL alone is not enough to test Rung. Creating a commitment needs the quote token, and
 * taking the other side needs the stock token, and on devnet both are mocks this project
 * minted — so nobody can obtain them except from here. The deployer holds mint authority
 * over both, which is what makes this possible at all.
 *
 * Tops the wallet up to 0.1 devnet SOL from the deployer too, since a fresh wallet has none
 * and the devnet faucet is rate-limited.
 *
 * Deliberately funds BOTH sides: a tester who can only make commitments can never see a
 * match, an exercise, or a position on the protection side, which is most of the product.
 */
import { readFileSync, existsSync } from 'node:fs';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  mintTo,
  getAccount,
} from '@solana/spl-token';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/fund-tester.ts <address>');
  process.exit(1);
}

let recipient: PublicKey;
try {
  recipient = new PublicKey(target);
} catch {
  console.error(`Not a valid Solana address: ${target}`);
  process.exit(1);
}

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  if (existsSync('.env.local')) {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  }
  return out;
}

const cfg = env();
// FUND_RPC_URL overrides; otherwise public devnet. DEVNET_RPC_URL is not used here: it is
// the deploy key's endpoint, and an exhausted quota there should not block funding a tester.
const rpc = process.env.FUND_RPC_URL ?? cfg.FUND_RPC_URL ?? 'https://api.devnet.solana.com';
const connection = new Connection(rpc, 'confirmed');
/** Enough devnet SOL for a tester's fees and account rent across a full demo. */
const SOL_FLOOR = 0.1;
const deployment = JSON.parse(readFileSync('devnet.json', 'utf8'));
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8'))),
);

const USDC_AMOUNT = 5_000;
/** Whole raw tokens of each mock; a wallet shows this times the mock's multiplier. */
const STOCK_AMOUNT = 50;

type Market = { mint: string; decimals: number; multiplier: number };

async function retry<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i === attempts) break;
      console.log(`  ${label} retry ${i}`);
      await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  throw last;
}

async function main() {
  const quoteMint = new PublicKey(deployment.quoteMint);

  const sol = (await connection.getBalance(recipient)) / 1e9;
  console.log(`Recipient ${recipient.toBase58()}`);
  console.log(`  SOL balance: ${sol}`);
  // A fresh wallet has no SOL, and the devnet faucet is rate-limited; top it up from the
  // deployer so the tester can pay fees and the rent for their position's accounts.
  if (sol < SOL_FLOOR) {
    const lamports = Math.round((SOL_FLOOR - sol) * LAMPORTS_PER_SOL);
    await retry('top up SOL', () =>
      sendAndConfirmTransaction(
        connection,
        new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports })),
        [payer],
      ),
    );
    console.log(`  Topped up to ${SOL_FLOOR} SOL`);
  }
  console.log('');

  console.log('Creating token accounts and minting…');
  const quoteAta = await retry('quote ata', () =>
    createAssociatedTokenAccountIdempotent(connection, payer, quoteMint, recipient, {}, TOKEN_PROGRAM_ID),
  );
  await retry('mint usdc', () =>
    mintTo(connection, payer, quoteMint, quoteAta, payer,
      BigInt(USDC_AMOUNT) * 10n ** BigInt(deployment.quoteDecimals), [], undefined, TOKEN_PROGRAM_ID),
  );
  const q = await getAccount(connection, quoteAta, undefined, TOKEN_PROGRAM_ID);

  console.log('');
  console.log('Funded:');
  console.log(`  mock USDC     ${Number(q.amount) / 10 ** deployment.quoteDecimals}`);

  // Every listed market's mock, so the tester can try each one.
  for (const [symbol, m] of Object.entries(deployment.markets as Record<string, Market>)) {
    const mint = new PublicKey(m.mint);
    const ata = await retry(`${symbol} ata`, () =>
      createAssociatedTokenAccountIdempotent(connection, payer, mint, recipient, {}, TOKEN_2022_PROGRAM_ID),
    );
    await retry(`mint ${symbol}`, () =>
      mintTo(connection, payer, mint, ata, payer,
        BigInt(STOCK_AMOUNT) * 10n ** BigInt(m.decimals), [], undefined, TOKEN_2022_PROGRAM_ID),
    );
    const s = await getAccount(connection, ata, undefined, TOKEN_2022_PROGRAM_ID);
    // Displayed in scaled UI units, which is what a wallet shows and what PreStocks quotes.
    console.log(`  mock ${symbol.padEnd(8)} ${(Number(s.amount) / 10 ** m.decimals) * m.multiplier} (UI) · ${s.amount} raw`);
  }
  console.log('');
  console.log('All are MOCK tokens this project minted. Each PreStock mock carries its real');
  console.log("counterpart's multiplier and a transfer fee, so balances drop slightly on every");
  console.log('transfer. That is the mint, not a bug.');
}

main().catch((e) => {
  console.error('\nFAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
