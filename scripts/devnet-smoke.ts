/**
 * End-to-end smoke test of the LIVE devnet deployment: every instruction, and every launch
 * guardrail, against the deployed program and the mock mint judges will actually use.
 *
 *   bash scripts/wsl/run.sh node scripts/devnet-smoke.ts
 *
 * The deployer (~/.config/solana/id.json) is the maker and, as the mocks' mint authority,
 * funds a throwaway taker and cranker kept in ~/rung-smoke. Every position it opens is
 * settled or cancelled before it finishes, so nothing is left on the Commitment Curve; the
 * cost is a few thousandths of devnet SOL in rent.
 *
 * Uses public devnet unless SMOKE_RPC_URL is set; only the host is printed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAccount,
  createAssociatedTokenAccountIdempotent,
  mintTo,
} from '@solana/spl-token';
import { fetchMintState, fetchPreStock, rpcFromUrl } from '../packages/sdk/src/prestocks.ts';
import { quoteStrike, valuationBands } from '../packages/sdk/src/valuation.ts';
import { amountReceived, grossUpForRequired, worstCaseTransferFee } from '../packages/sdk/src/token2022.ts';
import { checker, rungFlows, usd } from './lib/rung-flows.ts';

const RPC = process.env.SMOKE_RPC_URL ?? 'https://api.devnet.solana.com';
const DIR = `${process.env.HOME}/rung-smoke`;

function keypair(name: string): Keypair {
  const path = `${DIR}/${name}.json`;
  if (existsSync(path)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const conn = new Connection(RPC, 'confirmed');
  const deployer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8'))),
  );
  const taker = keypair('taker');
  const cranker = keypair('cranker');
  const deployment = JSON.parse(readFileSync('devnet.json', 'utf8'));
  const usdc = new PublicKey(deployment.quoteMint);
  const mint = new PublicKey(deployment.markets.OPENAI.mint);
  const idl = JSON.parse(readFileSync('packages/sdk/idl/rung.json', 'utf8')) as Idl;
  const program = new Program(idl, new AnchorProvider(conn, new Wallet(deployer), { commitment: 'confirmed' }));
  const rung = rungFlows(program, usdc, { maker: deployer, taker, cranker });
  const { check, expectError, failures } = checker();

  console.log(`RPC      ${RPC.split('?')[0]}`);
  console.log(`Program  ${program.programId.toBase58()}`);
  console.log(`Maker    ${deployer.publicKey.toBase58()} (deployer)`);
  console.log(`Taker    ${taker.publicKey.toBase58()}`);

  // Fund the throwaway wallets. Transfers, not airdrops: the devnet faucet is rate-limited.
  const topUp = new Transaction();
  for (const kp of [taker, cranker]) {
    const have = await conn.getBalance(kp.publicKey);
    if (have < 0.03 * LAMPORTS_PER_SOL) {
      topUp.add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: kp.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL - have }));
    }
  }
  if (topUp.instructions.length) await program.provider.sendAndConfirm!(topUp, []);
  const takerStock = await createAssociatedTokenAccountIdempotent(conn, deployer, mint, taker.publicKey, {}, TOKEN_2022_PROGRAM_ID);
  const takerUsdc = await createAssociatedTokenAccountIdempotent(conn, deployer, usdc, taker.publicKey, {}, TOKEN_PROGRAM_ID);
  await mintTo(conn, deployer, mint, takerStock, deployer, 1_000_000_000n, [], undefined, TOKEN_2022_PROGRAM_ID);
  await mintTo(conn, deployer, usdc, takerUsdc, deployer, 50_000_000n, [], undefined, TOKEN_PROGRAM_ID);

  const state = await fetchMintState(mint.toBase58(), rpcFromUrl(RPC));
  const asset = await fetchPreStock('OPENAI');
  console.log(`Mock     multiplier ${state.multiplier}, fee ${state.transferFee.transferFeeBasisPoints}bps`);
  const target = valuationBands(asset.markValuation, 6).find((v) => v < asset.markValuation)!;
  const q = quoteStrike({ asset, targetValuation: target, strikeUsd: 10, decimals: state.decimals, multiplier: state.multiplier, transferFee: state.transferFee });
  const send = grossUpForRequired(q.rawQuantity, worstCaseTransferFee(state.transferFeeConfig));

  console.log('\nCreate -> accept -> exercise');
  const h = await rung.create(mint, q.rawQuantity, usd(10), usd(0.5), 3600, target);
  check((await rung.balance(h.quoteVault, TOKEN_PROGRAM_ID)) === 10_000_000n, 'create escrows exactly $10 of mock USDC');
  const makerUsdc0 = await rung.balance(rung.usdcOf(deployer.publicKey), TOKEN_PROGRAM_ID);
  await rung.accept(h, send);
  const escrowed = BigInt((await program.account.position.fetch(h.position)).stockRawEscrowed.toString());
  check(escrowed === (await rung.balance(h.stockVault, TOKEN_2022_PROGRAM_ID)), 'accept records the vault\'s real balance');
  check(escrowed >= q.rawQuantity, 'escrow clears the required quantity after the mock fee');
  check(escrowed === amountReceived(send, state.transferFee), "escrow matches the SDK's fee math");
  check((await rung.balance(rung.usdcOf(deployer.publicKey), TOKEN_PROGRAM_ID)) - makerUsdc0 === 500_000n, 'maker is paid the premium on match');
  const takerUsdc0 = await rung.balance(takerUsdc, TOKEN_PROGRAM_ID);
  const makerStock0 = await rung.balance(rung.stockOf(mint, deployer.publicKey), TOKEN_2022_PROGRAM_ID);
  await rung.exercise(h);
  check((await rung.balance(takerUsdc, TOKEN_PROGRAM_ID)) - takerUsdc0 === 10_000_000n, 'exercise pays the holder the full $10');
  check(
    (await rung.balance(rung.stockOf(mint, deployer.publicKey), TOKEN_2022_PROGRAM_ID)) - makerStock0 === amountReceived(escrowed, state.transferFee),
    'exercise delivers the stock net of the exit fee',
  );

  console.log('\nGuardrails on the deployed program');
  await expectError('a $1,000.000001 strike', 'StrikeAboveCap', () => rung.create(mint, 1_000_000n, usd(1_000).addn(1), usd(1), 3600, target));
  const own = await rung.create(mint, 1_000_000n, usd(1), usd(0.1), 3600, target);
  // A second USDC account the deployer owns: reusing its ATA would trip Anchor's duplicate
  // account check first, which is not the guard under test.
  const secondPath = `${DIR}/deployer-second-usdc.json`;
  const secondKp = existsSync(secondPath)
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(secondPath, 'utf8'))))
    : (() => {
        const kp = Keypair.generate();
        writeFileSync(secondPath, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
        return kp;
      })();
  if (!(await conn.getAccountInfo(secondKp.publicKey))) {
    await createAccount(conn, deployer, usdc, deployer.publicKey, secondKp, undefined, TOKEN_PROGRAM_ID);
  }
  await createAssociatedTokenAccountIdempotent(conn, deployer, mint, deployer.publicKey, {}, TOKEN_2022_PROGRAM_ID);
  await expectError('the maker taking their own commitment', 'SelfMatch', () =>
    rung.accept(own, 2_000_000n, { signer: deployer, quoteAccount: secondKp.publicKey }),
  );

  console.log('\nCreate -> cancel');
  const makerUsdcC = await rung.balance(rung.usdcOf(deployer.publicKey), TOKEN_PROGRAM_ID);
  await rung.cancel(own);
  check((await rung.balance(rung.usdcOf(deployer.publicKey), TOKEN_PROGRAM_ID)) - makerUsdcC === 1_000_000n, 'cancel returns the maker every unit');

  console.log('\nCreate -> accept -> expire, cranked by an uninvolved wallet');
  const e = await rung.create(mint, q.rawQuantity, usd(10), usd(0.5), 62, target);
  await rung.accept(e, send);
  const eEscrowed = BigInt((await program.account.position.fetch(e.position)).stockRawEscrowed.toString());
  const takerStock0 = await rung.balance(takerStock, TOKEN_2022_PROGRAM_ID);
  const makerUsdcE = await rung.balance(rung.usdcOf(deployer.publicKey), TOKEN_PROGRAM_ID);
  console.log('  waiting for the 62s expiry on the cluster clock…');
  await rung.expireWhenDue(e);
  check((await rung.balance(takerStock, TOKEN_2022_PROGRAM_ID)) - takerStock0 === amountReceived(eEscrowed, state.transferFee), 'expire returns the holder their stock, net of the exit fee');
  check((await rung.balance(rung.usdcOf(deployer.publicKey), TOKEN_PROGRAM_ID)) - makerUsdcE === 10_000_000n, 'expire returns the maker their $10');

  console.log(failures() === 0 ? '\nDEVNET SMOKE TEST PASSED' : `\nDEVNET SMOKE TEST FAILED: ${failures()} check(s)`);
  process.exit(failures() === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nDEVNET SMOKE TEST ERROR:', e instanceof Error ? e.message : e);
  if (e && typeof e === 'object' && 'logs' in e) console.error((e as { logs: string[] }).logs?.join('\n'));
  process.exit(1);
});
