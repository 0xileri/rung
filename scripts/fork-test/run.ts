/**
 * Drive every Rung instruction against the REAL PreStocks mint accounts on a local fork.
 *
 *   bash scripts/wsl/fork-test.sh            (starts the fork, then runs this)
 *
 * Quantities come from the SDK exactly as the web app computes them -- live PreStocks marks,
 * the mint's resolved multiplier and live fee, gross-up against the worse fee slot -- so a
 * pass means the numbers users will see are the numbers the program accepts, on mints with
 * every extension the real ones carry.
 */
import { readFileSync } from 'node:fs';
import { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotent, mintTo } from '@solana/spl-token';
import { fetchMintState, fetchPreStocks, rpcFromUrl, type MintState } from '../../packages/sdk/src/prestocks.ts';
import { quoteStrike, valuationBands } from '../../packages/sdk/src/valuation.ts';
import { amountReceived, grossUpForRequired, worstCaseTransferFee } from '../../packages/sdk/src/token2022.ts';
import { proRataCeil } from '../../packages/sdk/src/fills.ts';
import { checker, rungFlows, usd } from '../lib/rung-flows.ts';

const RPC = 'http://127.0.0.1:8899';
const DIR = `${process.env.HOME}/rung-fork`;
const fork = JSON.parse(readFileSync(`${DIR}/fork.json`, 'utf8')) as { symbols: string[]; mints: string[]; usdc: string };
const load = (name: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${DIR}/${name}.json`, 'utf8'))));

const [admin, maker, taker, cranker] = ['admin', 'maker', 'taker', 'cranker'].map(load);
const conn = new Connection(RPC, 'confirmed');
const idl = JSON.parse(readFileSync('packages/sdk/idl/rung.json', 'utf8')) as Idl;
const program = new Program(idl, new AnchorProvider(conn, new Wallet(admin), { commitment: 'confirmed' }));
const usdc = new PublicKey(fork.usdc);
const rung = rungFlows(program, usdc, { maker, taker, cranker });
const { check, expectError, failures } = checker();

async function main() {
  for (const kp of [admin, maker, taker, cranker]) {
    await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL), 'confirmed');
  }
  const { epoch } = await conn.getEpochInfo();
  console.log(`fork epoch ${epoch}`);
  check(epoch >= 1039, 'fork is past epoch 1039, so the live 100bps fee slot applies');

  // Balances. The ATA program asks Token-2022 which account extensions each real mint
  // requires, so these accounts have exactly the layout a real holder's would.
  for (const who of [maker, taker]) {
    const account = await createAssociatedTokenAccountIdempotent(conn, admin, usdc, who.publicKey, {}, TOKEN_PROGRAM_ID);
    await mintTo(conn, admin, usdc, account, admin, 20_000_000_000n, [], undefined, TOKEN_PROGRAM_ID);
  }
  for (const m of fork.mints) {
    const mint = new PublicKey(m);
    const account = await createAssociatedTokenAccountIdempotent(conn, admin, mint, taker.publicKey, {}, TOKEN_2022_PROGRAM_ID);
    await mintTo(conn, admin, mint, account, admin, 50_000_000_000n, [], undefined, TOKEN_2022_PROGRAM_ID);
  }

  await program.methods
    .initializeConfig()
    .accounts({ admin: admin.publicKey, config: rung.configPda, quoteMint: usdc, quoteTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .rpc();

  const assets = await fetchPreStocks();
  const mints: Record<string, { mint: PublicKey; state: MintState }> = {};

  for (const [i, symbol] of fork.symbols.entries()) {
    console.log(`\n${symbol}`);
    const mint = new PublicKey(fork.mints[i]);
    await program.methods
      .addMarket(symbol)
      .accounts({ admin: admin.publicKey, config: rung.configPda, market: rung.marketPda(mint), stockMint: mint, stockTokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .rpc();
    check(true, 'add_market accepts the real mint (empty hook slot passes the guard)');

    const state = await fetchMintState(mint.toBase58(), rpcFromUrl(RPC));
    mints[symbol] = { mint, state };
    const asset = assets.find((a) => a.symbol === symbol)!;
    console.log(`  multiplier ${state.multiplier}, fee ${state.transferFee.transferFeeBasisPoints}bps, hook ${state.transferHookProgramId ?? 'none'}`);
    check(state.transferFee.transferFeeBasisPoints === 100, 'SDK resolves the live 1% fee from the forked epoch');

    const target = valuationBands(asset.markValuation, 6).find((v) => v < asset.markValuation)!;
    const q = quoteStrike({ asset, targetValuation: target, strikeUsd: 100, decimals: state.decimals, multiplier: state.multiplier, transferFee: state.transferFee });
    console.log(`  $100 at $${(target / 1e12).toFixed(2)}T -> ${q.rawQuantity} raw`);

    const h = await rung.create(mint, q.rawQuantity, usd(100), usd(3), 3600);
    check((await rung.balance(h.quoteVault, TOKEN_PROGRAM_ID)) === 100_000_000n, 'create escrows exactly $100 USDC');

    const send = grossUpForRequired(q.rawQuantity, worstCaseTransferFee(state.transferFeeConfig));
    const makerUsdc0 = await rung.balance(rung.usdcOf(maker.publicKey), TOKEN_PROGRAM_ID);
    const fill = await rung.accept(h, send);
    const escrowed = BigInt((await program.account.position.fetch(h.position)).stockRawEscrowed.toString());
    const vault = await rung.balance(h.stockVault, TOKEN_2022_PROGRAM_ID);
    check(escrowed === vault, `accept records the vault's real balance (${vault})`);
    check(escrowed >= q.rawQuantity, 'escrow clears the required quantity after the real fee');
    check(escrowed === amountReceived(send, state.transferFee), "escrow matches the SDK's fee math");
    const makerUsdc1 = await rung.balance(rung.usdcOf(maker.publicKey), TOKEN_PROGRAM_ID);
    check(makerUsdc1 - makerUsdc0 === 3_000_000n, 'maker receives the $3 premium on match');

    const takerUsdc0 = await rung.balance(rung.usdcOf(taker.publicKey), TOKEN_PROGRAM_ID);
    await rung.exercise(h, fill);
    const takerUsdc1 = await rung.balance(rung.usdcOf(taker.publicKey), TOKEN_PROGRAM_ID);
    const makerStock = await rung.balance(rung.stockOf(mint, maker.publicKey), TOKEN_2022_PROGRAM_ID);
    check(takerUsdc1 - takerUsdc0 === 100_000_000n, 'exercise pays the holder the full $100');
    check(makerStock === amountReceived(escrowed, state.transferFee), 'exercise delivers the stock net of the exit fee');
    check(
      (await rung.balance(h.stockVault, TOKEN_2022_PROGRAM_ID)) === 0n && (await rung.balance(h.quoteVault, TOKEN_PROGRAM_ID)) === 0n,
      'both vaults end empty',
    );
  }

  const first = fork.symbols[0];
  const { mint, state } = mints[first];
  console.log(`\n${first} guardrails and the other exits`);

  const makerUsdcA = await rung.balance(rung.usdcOf(maker.publicKey), TOKEN_PROGRAM_ID);
  const c = await rung.create(mint, 1_000_000n, usd(50), usd(1), 3600);
  await rung.cancel(c);
  check((await rung.balance(rung.usdcOf(maker.publicKey), TOKEN_PROGRAM_ID)) === makerUsdcA, 'cancel returns the maker every unit');

  await expectError('a $1,000.000001 strike', 'StrikeAboveCap', () => rung.create(mint, 1_000_000n, usd(1_000).addn(1), usd(1), 3600));
  const atCap = await rung.create(mint, 1_000_000n, usd(1_000), usd(1), 3600);
  check((await rung.balance(atCap.quoteVault, TOKEN_PROGRAM_ID)) === 1_000_000_000n, 'a strike exactly at the $1,000 cap is accepted');
  await rung.cancel(atCap);

  // Partial fills and the protocol fee, on the real mint at its live 1% fee. Every figure a
  // slice owes is pro rata against what was escrowed; the check is that the real mint's
  // transfer fee and rounding never let the vault fall short of what the slices claim.
  console.log(`\n${first} partial fills, with a protocol fee`);
  const treasury = Keypair.generate();
  await program.methods
    .setFee(100)
    .accounts({ admin: admin.publicKey, config: rung.configPda, feeTreasury: treasury.publicKey })
    .rpc();
  const worst = worstCaseTransferFee(state.transferFeeConfig);
  const fullRaw = 90_000_000n;
  const slice = (strike: bigint) => proRataCeil(fullRaw, strike, 100_000_000n);
  const pf = await rung.create(mint, fullRaw, usd(100), usd(5), 3600);
  const makerUsdcP = await rung.balance(rung.usdcOf(maker.publicKey), TOKEN_PROGRAM_ID);
  const asTaker = { signer: taker, quoteAccount: rung.usdcOf(taker.publicKey) };
  const first40 = await rung.accept(pf, grossUpForRequired(slice(40_000_000n), worst), { ...asTaker, fillStrike: usd(40) });
  const then60 = await rung.accept(pf, grossUpForRequired(slice(60_000_000n), worst), { ...asTaker, fillStrike: usd(60) });
  const f40 = await program.account.fill.fetch(first40);
  const f60 = await program.account.fill.fetch(then60);
  const stockVault = await rung.balance(pf.stockVault, TOKEN_2022_PROGRAM_ID);
  check(
    BigInt(f40.stockRawEscrowed.toString()) + BigInt(f60.stockRawEscrowed.toString()) === stockVault,
    `two slices' recorded stock adds up to the vault's real balance (${stockVault})`,
  );
  check(
    BigInt(f40.stockRawEscrowed.toString()) >= slice(40_000_000n) && BigInt(f60.stockRawEscrowed.toString()) >= slice(60_000_000n),
    'each slice clears its own pro-rata requirement after the real fee',
  );
  check(
    (await rung.balance(rung.usdcOf(maker.publicKey), TOKEN_PROGRAM_ID)) - makerUsdcP === 4_950_000n,
    'the maker receives the $5 premium less the 1% protocol fee',
  );
  check((await rung.balance(rung.usdcOf(treasury.publicKey), TOKEN_PROGRAM_ID)) === 50_000n, 'the treasury receives exactly the fee');

  const takerUsdcP = await rung.balance(rung.usdcOf(taker.publicKey), TOKEN_PROGRAM_ID);
  await rung.exercise(pf, first40);
  check((await rung.balance(rung.usdcOf(taker.publicKey), TOKEN_PROGRAM_ID)) - takerUsdcP === 40_000_000n, 'exercising the $40 slice pays $40, not the whole strike');
  check((await rung.balance(pf.quoteVault, TOKEN_PROGRAM_ID)) === 60_000_000n, 'the other slice is still fully funded');
  await rung.exercise(pf, then60);
  check(
    (await rung.balance(pf.quoteVault, TOKEN_PROGRAM_ID)) === 0n && (await rung.balance(pf.stockVault, TOKEN_2022_PROGRAM_ID)) === 0n,
    'settling both slices empties both vaults exactly',
  );
  await program.methods
    .setFee(0)
    .accounts({ admin: admin.publicKey, config: rung.configPda, feeTreasury: admin.publicKey })
    .rpc();

  const e = await rung.create(mint, 1_000_000n, usd(10), usd(1), 62);
  const expiringFill = await rung.accept(e, grossUpForRequired(1_000_000n, worstCaseTransferFee(state.transferFeeConfig)));
  const eEscrowed = BigInt((await program.account.position.fetch(e.position)).stockRawEscrowed.toString());
  const takerStock0 = await rung.balance(rung.stockOf(mint, taker.publicKey), TOKEN_2022_PROGRAM_ID);
  const makerUsdcE = await rung.balance(rung.usdcOf(maker.publicKey), TOKEN_PROGRAM_ID);
  console.log('  waiting for the 62s expiry on the cluster clock…');
  await rung.expireWhenDue(e, expiringFill);
  const takerStock1 = await rung.balance(rung.stockOf(mint, taker.publicKey), TOKEN_2022_PROGRAM_ID);
  check(takerStock1 - takerStock0 === amountReceived(eEscrowed, state.transferFee), 'expire returns the holder their stock, net of the exit fee');
  check(
    (await rung.balance(rung.usdcOf(maker.publicKey), TOKEN_PROGRAM_ID)) - makerUsdcE === 10_000_000n,
    'expire returns the maker their $10, cranked by an uninvolved wallet',
  );

  console.log(failures() === 0 ? '\nFORK TEST PASSED' : `\nFORK TEST FAILED: ${failures()} check(s)`);
  process.exit(failures() === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nFORK TEST ERROR:', e instanceof Error ? e.message : e);
  if (e && typeof e === 'object' && 'logs' in e) console.error((e as { logs: string[] }).logs?.join('\n'));
  process.exit(1);
});
