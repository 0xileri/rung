/**
 * Create and stock the devnet faucet wallet behind the site's "Get test tokens" button.
 *
 *   bash scripts/wsl/run.sh node scripts/setup-faucet.ts
 *
 * The faucet hands out mock tokens by TRANSFERRING from its own balance, never by minting.
 * That keeps the deployer key -- which is also the program's upgrade authority -- off the
 * web server entirely: the only key the server holds is this one, which owns nothing but
 * devnet SOL and devnet mocks. Its secret is written to ~/rung-demo/faucet.json and must be
 * set on the server as FAUCET_SECRET_KEY (the JSON array, verbatim).
 *
 * Re-running tops the faucet back up; it never replaces an existing faucet key.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotent, getAccount, mintTo } from '@solana/spl-token';

const RPC = process.env.SEED_RPC_URL ?? 'https://api.devnet.solana.com';
const DIR = `${process.env.HOME}/rung-demo`;
const SOL_TARGET = 1.5;
const USDC_TARGET = 1_000_000n * 10n ** 6n;
const STOCK_TARGET = 2_000n * 10n ** 9n; // raw; ~2,972 OPENAI as a wallet displays it

async function main() {
  mkdirSync(DIR, { recursive: true });
  const path = `${DIR}/faucet.json`;
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  const faucet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
  const deployer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8'))),
  );
  const conn = new Connection(RPC, 'confirmed');
  const deployment = JSON.parse(readFileSync('devnet.json', 'utf8'));
  const usdc = new PublicKey(deployment.quoteMint);
  const stock = new PublicKey(deployment.markets.OPENAI.mint);

  console.log(`Faucet   ${faucet.publicKey.toBase58()}`);

  const sol = await conn.getBalance(faucet.publicKey);
  if (sol < SOL_TARGET * LAMPORTS_PER_SOL) {
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: faucet.publicKey, lamports: SOL_TARGET * LAMPORTS_PER_SOL - sol }),
      ),
      [deployer],
    );
  }

  const usdcAta = await createAssociatedTokenAccountIdempotent(conn, deployer, usdc, faucet.publicKey, {}, TOKEN_PROGRAM_ID);
  const stockAta = await createAssociatedTokenAccountIdempotent(conn, deployer, stock, faucet.publicKey, {}, TOKEN_2022_PROGRAM_ID);
  const usdcHave = (await getAccount(conn, usdcAta, 'confirmed', TOKEN_PROGRAM_ID)).amount;
  const stockHave = (await getAccount(conn, stockAta, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount;
  if (usdcHave < USDC_TARGET) await mintTo(conn, deployer, usdc, usdcAta, deployer, USDC_TARGET - usdcHave, [], undefined, TOKEN_PROGRAM_ID);
  if (stockHave < STOCK_TARGET) await mintTo(conn, deployer, stock, stockAta, deployer, STOCK_TARGET - stockHave, [], undefined, TOKEN_2022_PROGRAM_ID);

  console.log(`SOL      ${(await conn.getBalance(faucet.publicKey)) / LAMPORTS_PER_SOL}`);
  console.log(`USDC     ${Number((await getAccount(conn, usdcAta, 'confirmed', TOKEN_PROGRAM_ID)).amount) / 1e6}`);
  console.log(`OPENAI   ${(await getAccount(conn, stockAta, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount} raw`);
  console.log(`\nSet FAUCET_SECRET_KEY on the server to the contents of ${path}.`);
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
