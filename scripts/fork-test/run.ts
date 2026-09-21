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
import { AnchorProvider, BN, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from '@solana/spl-token';
import { fetchMintState, fetchPreStocks, rpcFromUrl, type MintState } from '../../packages/sdk/src/prestocks.ts';
import { quoteStrike, valuationBands } from '../../packages/sdk/src/valuation.ts';
import { amountReceived, grossUpForRequired, worstCaseTransferFee } from '../../packages/sdk/src/token2022.ts';

const RPC = 'http://127.0.0.1:8899';
const DIR = `${process.env.HOME}/rung-fork`;
const fork = JSON.parse(readFileSync(`${DIR}/fork.json`, 'utf8')) as { symbols: string[]; mints: string[]; usdc: string };
const load = (name: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${DIR}/${name}.json`, 'utf8'))));

const admin = load('admin');
const maker = load('maker');
const taker = load('taker');
const cranker = load('cranker');
const conn = new Connection(RPC, 'confirmed');
const idl = JSON.parse(readFileSync('packages/sdk/idl/rung.json', 'utf8')) as Idl;
const program = new Program(idl, new AnchorProvider(conn, new Wallet(admin), { commitment: 'confirmed' }));
const usdc = new PublicKey(fork.usdc);
const usd = (n: number) => new BN(Math.round(n * 1e6));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(ok: boolean, label: string) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
}
async function expectError(label: string, name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(false, `${label} (was accepted)`);
  } catch (e) {
    const ok = String(e).includes(name);
    check(ok, `${label} -> ${name}`);
    if (!ok) console.log(`       ${String(e).slice(0, 400)}`);
  }
}

const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
const configPda = pda([Buffer.from('config')]);
const marketPda = (mint: PublicKey) => pda([Buffer.from('market'), mint.toBuffer()]);
const ata = (mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
const balance = async (address: PublicKey, tokenProgram: PublicKey) =>
  (await getAccount(conn, address, 'confirmed', tokenProgram)).amount;

let nonceCounter = BigInt(Date.now());
type Handle = { mint: PublicKey; position: PublicKey; authority: PublicKey; quoteVault: PublicKey; stockVault: PublicKey };

async function create(mint: PublicKey, stockRaw: bigint, strike: BN, premium: BN, expiryOffsetSecs: number): Promise<Handle> {
  const nonce = new BN((++nonceCounter).toString());
  const position = pda([Buffer.from('position'), maker.publicKey.toBuffer(), nonce.toArrayLike(Buffer, 'le', 8)]);
  const authority = pda([Buffer.from('position_authority'), position.toBuffer()]);
  const h = {
    mint,
    position,
    authority,
    quoteVault: ata(usdc, authority, TOKEN_PROGRAM_ID),
    stockVault: ata(mint, authority, TOKEN_2022_PROGRAM_ID),
  };
  await program.methods
    .createCommitment(nonce, new BN(stockRaw.toString()), strike, premium, new BN(Math.floor(Date.now() / 1000) + expiryOffsetSecs), new BN(1))
    .accounts({
      maker: maker.publicKey,
      config: configPda,
      market: marketPda(mint),
      position,
      positionAuthority: authority,
      stockMint: mint,
      quoteMint: usdc,
      makerQuoteAccount: ata(usdc, maker.publicKey, TOKEN_PROGRAM_ID),
      quoteVault: h.quoteVault,
      stockVault: h.stockVault,
      stockTokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([maker])
    .rpc();
  return h;
}

const accept = (h: Handle, send: bigint) =>
  program.methods
    .acceptCommitment(new BN(send.toString()))
    .accounts({
      taker: taker.publicKey,
      config: configPda,
      market: marketPda(h.mint),
      position: h.position,
      positionAuthority: h.authority,
      stockMint: h.mint,
      quoteMint: usdc,
      takerStockAccount: ata(h.mint, taker.publicKey, TOKEN_2022_PROGRAM_ID),
      takerQuoteAccount: ata(usdc, taker.publicKey, TOKEN_PROGRAM_ID),
      makerQuoteAccount: ata(usdc, maker.publicKey, TOKEN_PROGRAM_ID),
      stockVault: h.stockVault,
      stockTokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([taker])
    .rpc();

const exercise = (h: Handle) =>
  program.methods
    .exercisePosition()
    .accounts({
      taker: taker.publicKey,
      position: h.position,
      positionAuthority: h.authority,
      maker: maker.publicKey,
      stockMint: h.mint,
      quoteMint: usdc,
      quoteVault: h.quoteVault,
      stockVault: h.stockVault,
      takerQuoteAccount: ata(usdc, taker.publicKey, TOKEN_PROGRAM_ID),
      makerStockAccount: ata(h.mint, maker.publicKey, TOKEN_2022_PROGRAM_ID),
      stockTokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([taker])
    .rpc();

const cancel = (h: Handle) =>
  program.methods
    .cancelCommitment()
    .accounts({
      maker: maker.publicKey,
      position: h.position,
      positionAuthority: h.authority,
      quoteMint: usdc,
      quoteVault: h.quoteVault,
      makerQuoteAccount: ata(usdc, maker.publicKey, TOKEN_PROGRAM_ID),
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([maker])
    .rpc();

const expire = (h: Handle) =>
  program.methods
    .expirePosition()
    .accounts({
      cranker: cranker.publicKey,
      position: h.position,
      maker: maker.publicKey,
      taker: taker.publicKey,
      positionAuthority: h.authority,
      stockMint: h.mint,
      quoteMint: usdc,
      quoteVault: h.quoteVault,
      stockVault: h.stockVault,
      makerQuoteAccount: ata(usdc, maker.publicKey, TOKEN_PROGRAM_ID),
      takerStockAccount: ata(h.mint, taker.publicKey, TOKEN_2022_PROGRAM_ID),
      stockTokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([cranker])
    .rpc();

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
    .accounts({ admin: admin.publicKey, config: configPda, quoteMint: usdc, quoteTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .rpc();

  const assets = await fetchPreStocks();
  const mints: Record<string, { mint: PublicKey; state: MintState }> = {};

  for (const [i, symbol] of fork.symbols.entries()) {
    console.log(`\n${symbol}`);
    const mint = new PublicKey(fork.mints[i]);
    await program.methods
      .addMarket(symbol)
      .accounts({ admin: admin.publicKey, config: configPda, market: marketPda(mint), stockMint: mint, stockTokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId })
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

    const h = await create(mint, q.rawQuantity, usd(100), usd(3), 3600);
    check((await balance(h.quoteVault, TOKEN_PROGRAM_ID)) === 100_000_000n, 'create escrows exactly $100 USDC');

    const send = grossUpForRequired(q.rawQuantity, worstCaseTransferFee(state.transferFeeConfig));
    const makerUsdc0 = await balance(ata(usdc, maker.publicKey, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID);
    await accept(h, send);
    const escrowed = BigInt((await program.account.position.fetch(h.position)).stockRawEscrowed.toString());
    const vault = await balance(h.stockVault, TOKEN_2022_PROGRAM_ID);
    check(escrowed === vault, `accept records the vault's real balance (${vault})`);
    check(escrowed >= q.rawQuantity, 'escrow clears the required quantity after the real fee');
    check(escrowed === amountReceived(send, state.transferFee), "escrow matches the SDK's fee math");
    const makerUsdc1 = await balance(ata(usdc, maker.publicKey, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID);
    check(makerUsdc1 - makerUsdc0 === 3_000_000n, 'maker receives the $3 premium on match');

    const takerUsdc0 = await balance(ata(usdc, taker.publicKey, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID);
    await exercise(h);
    const takerUsdc1 = await balance(ata(usdc, taker.publicKey, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID);
    const makerStock = await balance(ata(mint, maker.publicKey, TOKEN_2022_PROGRAM_ID), TOKEN_2022_PROGRAM_ID);
    check(takerUsdc1 - takerUsdc0 === 100_000_000n, 'exercise pays the holder the full $100');
    check(makerStock === amountReceived(escrowed, state.transferFee), 'exercise delivers the stock net of the exit fee');
    check((await balance(h.stockVault, TOKEN_2022_PROGRAM_ID)) === 0n && (await balance(h.quoteVault, TOKEN_PROGRAM_ID)) === 0n, 'both vaults end empty');
  }

  const first = fork.symbols[0];
  const { mint, state } = mints[first];
  console.log(`\n${first} guardrails and the other exits`);

  const makerUsdcA = await balance(ata(usdc, maker.publicKey, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID);
  const c = await create(mint, 1_000_000n, usd(50), usd(1), 3600);
  await cancel(c);
  check((await balance(ata(usdc, maker.publicKey, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID)) === makerUsdcA, 'cancel returns the maker every unit');

  await expectError('a $1,000.000001 strike', 'StrikeAboveCap', () => create(mint, 1_000_000n, usd(1_000).addn(1), usd(1), 3600));
  const atCap = await create(mint, 1_000_000n, usd(1_000), usd(1), 3600);
  check((await balance(atCap.quoteVault, TOKEN_PROGRAM_ID)) === 1_000_000_000n, 'a strike exactly at the $1,000 cap is accepted');
  await cancel(atCap);

  const e = await create(mint, 1_000_000n, usd(10), usd(1), 62);
  const eSend = grossUpForRequired(1_000_000n, worstCaseTransferFee(state.transferFeeConfig));
  await accept(e, eSend);
  const eEscrowed = BigInt((await program.account.position.fetch(e.position)).stockRawEscrowed.toString());
  const takerStock0 = await balance(ata(mint, taker.publicKey, TOKEN_2022_PROGRAM_ID), TOKEN_2022_PROGRAM_ID);
  const makerUsdcE = await balance(ata(usdc, maker.publicKey, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID);
  console.log('  waiting for the 62s expiry on the validator clock…');
  await sleep(64_000);
  for (let attempt = 1; ; attempt++) {
    try {
      await expire(e);
      break;
    } catch (err) {
      if (attempt >= 6 || !String(err).includes('PositionNotExpired')) throw err;
      await sleep(5_000);
    }
  }
  const takerStock1 = await balance(ata(mint, taker.publicKey, TOKEN_2022_PROGRAM_ID), TOKEN_2022_PROGRAM_ID);
  check(takerStock1 - takerStock0 === amountReceived(eEscrowed, state.transferFee), 'expire returns the holder their stock, net of the exit fee');
  check((await balance(ata(usdc, maker.publicKey, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID)) - makerUsdcE === 10_000_000n, 'expire returns the maker their $10, cranked by an uninvolved wallet');

  console.log(failures === 0 ? '\nFORK TEST PASSED' : `\nFORK TEST FAILED: ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nFORK TEST ERROR:', e instanceof Error ? e.message : e);
  if (e && typeof e === 'object' && 'logs' in e) console.error((e as { logs: string[] }).logs?.join('\n'));
  process.exit(1);
});
