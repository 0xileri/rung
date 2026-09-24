import * as anchor from '@coral-xyz/anchor';
import { Program, BN } from '@coral-xyz/anchor';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createAssociatedTokenAccountIdempotent,
  getAssociatedTokenAddressSync,
  getAccount,
  mintTo,
} from '@solana/spl-token';
import { assert } from 'chai';
import { Rung } from '../target/types/rung';
import { getShared, fund } from './fixture.ts';

/**
 * Invariants under a random sequence of real transactions.
 *
 * The targeted tests check that each instruction does what it should. This checks that no
 * ORDER of them can break the accounting: a seeded random walk of takes (legal and illegal
 * sizes), exercises, withdrawals, rent reclaims and, at the end, expiries — and after every
 * step, for every commitment:
 *
 *   quote vault  == open remainder + every running slice's claim        (exactly)
 *   stock vault  == every running slice's escrowed stock                 (exactly)
 *   position.stock_raw_escrowed == that same sum
 *   fills_open / fills_created   == what the fill accounts say
 *   status       == what the amounts imply
 *   taken + open + withdrawn     == what was escrowed at creation
 *
 * Equality, not "at least": every leg that leaves a vault leaves by exactly the amount a fill
 * recorded, so any drift at all is a bug. The seed is printed; FUZZ_SEED=<n> replays a run.
 */

const STOCK_DECIMALS = 9;
const FEE_BPS = 50;
const STEPS = Number(process.env.FUZZ_STEPS ?? 70);
const SEED = Number(process.env.FUZZ_SEED ?? Math.floor(Math.random() * 1e9));

/** mulberry32: small, fast, and the same sequence for the same seed everywhere. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const usd = (n: number) => BigInt(Math.round(n * 1e6));
const grossUp = (required: bigint) => (required * 10000n) / BigInt(10000 - FEE_BPS) + 2n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

describe(`rung: invariants under a random walk (FUZZ_SEED=${SEED})`, () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Rung as Program<Rung>;
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const maker = Keypair.generate();
  const takers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  const treasury = Keypair.generate();
  const MIN_FILL = usd(5);
  const random = rng(SEED);
  const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)];

  let quoteMint: PublicKey;
  let stockMint: PublicKey;
  let configPda: PublicKey;
  let marketPda: PublicKey;
  const quoteOf = (k: PublicKey) => getAssociatedTokenAddressSync(quoteMint, k, false, TOKEN_PROGRAM_ID);
  const stockOf = (k: PublicKey) => getAssociatedTokenAddressSync(stockMint, k, false, TOKEN_2022_PROGRAM_ID);

  type Commitment = {
    position: PublicKey;
    authority: PublicKey;
    quoteVault: PublicKey;
    stockVault: PublicKey;
    escrowed: bigint;
    stockRequired: bigint;
    shortLived: boolean;
    fill: (i: number) => PublicKey;
  };
  const book: Commitment[] = [];
  const takerOf = new Map<string, Keypair>();
  let nonce = 0;
  const tally = { takes: 0, refused: 0, exercises: 0, withdrawals: 0, reclaims: 0, expiries: 0 };

  async function commit(strike: bigint, premium: bigint, expirySecs: number, stockRequired: bigint) {
    const n = new BN(++nonce);
    const [position] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), maker.publicKey.toBuffer(), n.toArrayLike(Buffer, 'le', 8)],
      program.programId,
    );
    const [authority] = PublicKey.findProgramAddressSync([Buffer.from('position_authority'), position.toBuffer()], program.programId);
    const c: Commitment = {
      position,
      authority,
      quoteVault: getAssociatedTokenAddressSync(quoteMint, authority, true, TOKEN_PROGRAM_ID),
      stockVault: getAssociatedTokenAddressSync(stockMint, authority, true, TOKEN_2022_PROGRAM_ID),
      escrowed: strike,
      stockRequired,
      shortLived: expirySecs < 300,
      fill: (i) =>
        PublicKey.findProgramAddressSync(
          [Buffer.from('fill'), position.toBuffer(), new BN(i).toArrayLike(Buffer, 'le', 4)],
          program.programId,
        )[0],
    };
    const clock = await connection.getAccountInfo(anchor.web3.SYSVAR_CLOCK_PUBKEY);
    const now = Number(clock!.data.readBigInt64LE(32));
    await program.methods
      .createCommitment(n, new BN(stockRequired.toString()), new BN(strike.toString()), new BN(premium.toString()), new BN(now + expirySecs), new BN(1e12))
      .accounts({
        maker: maker.publicKey,
        config: configPda,
        market: marketPda,
        position,
        positionAuthority: authority,
        stockMint,
        quoteMint,
        makerQuoteAccount: quoteOf(maker.publicKey),
        quoteVault: c.quoteVault,
        stockVault: c.stockVault,
        stockTokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as never)
      .signers([maker])
      .rpc();
    book.push(c);
    return c;
  }

  async function take(c: Commitment, who: Keypair, strike: bigint) {
    const p = await program.account.position.fetch(c.position);
    const index = p.fillsCreated;
    const required = ceilDiv(c.stockRequired * strike, c.escrowed);
    await program.methods
      .acceptCommitment(new BN(grossUp(required).toString()), new BN(strike.toString()))
      .accounts({
        taker: who.publicKey,
        config: configPda,
        market: marketPda,
        position: c.position,
        fill: c.fill(index),
        positionAuthority: c.authority,
        stockMint,
        quoteMint,
        takerStockAccount: stockOf(who.publicKey),
        takerQuoteAccount: quoteOf(who.publicKey),
        makerQuoteAccount: quoteOf(maker.publicKey),
        feeTreasuryAccount: quoteOf(treasury.publicKey),
        feeTreasury: treasury.publicKey,
        stockVault: c.stockVault,
        stockTokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as never)
      .signers([who])
      .rpc();
    takerOf.set(c.fill(index).toBase58(), who);
  }

  async function settle(c: Commitment, fill: PublicKey, kind: 'exercise' | 'expire') {
    const who = takerOf.get(fill.toBase58())!;
    const accounts = {
      position: c.position,
      fill,
      positionAuthority: c.authority,
      maker: maker.publicKey,
      stockMint,
      quoteMint,
      quoteVault: c.quoteVault,
      stockVault: c.stockVault,
      stockTokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
    if (kind === 'exercise') {
      await program.methods
        .exerciseFill()
        .accounts({ ...accounts, taker: who.publicKey, takerQuoteAccount: quoteOf(who.publicKey), makerStockAccount: stockOf(maker.publicKey) } as never)
        .signers([who])
        .rpc();
    } else {
      // Cranked by the admin, who is neither side: expiry must not need a counterparty.
      await program.methods
        .expireFill()
        .accounts({ ...accounts, cranker: admin.publicKey, taker: who.publicKey, makerQuoteAccount: quoteOf(maker.publicKey), takerStockAccount: stockOf(who.publicKey) } as never)
        .rpc();
    }
  }

  /** A size the program accepts: the whole remainder, or a slice that leaves at least the minimum. */
  function legalSize(open: bigint) {
    if (random() < 0.3 || open < MIN_FILL * 2n) return open;
    return MIN_FILL + BigInt(Math.floor(random() * Number(open - MIN_FILL * 2n + 1n)));
  }

  /** A size the program must refuse, with the error it must refuse it with. */
  function illegalSize(open: bigint): { size: bigint; error: string } {
    const options: { size: bigint; error: string }[] = [{ size: open + 1n, error: 'FillExceedsOpen' }];
    if (open >= MIN_FILL) {
      // Below the minimum, and not the whole remainder.
      options.push({ size: MIN_FILL - 1n, error: 'FillTooSmall' });
      // Would leave a crumb nobody could take.
      const crumb = open - (MIN_FILL - 1n);
      if (crumb > 0n) options.push({ size: crumb, error: crumb >= MIN_FILL ? 'FillRemainderTooSmall' : 'FillTooSmall' });
    }
    return pick(options);
  }

  /**
   * Every invariant, for every commitment, read straight from chain — at the same commitment
   * level the provider confirms transactions at, so a vault created a moment ago is visible.
   */
  async function checkAll(step: string) {
    for (const c of book) {
      const p = await program.account.position.fetch(c.position);
      let running = 0n;
      let runningStock = 0n;
      let taken = 0n;
      let matchedCount = 0;
      for (let i = 0; i < p.fillsCreated; i++) {
        if (!(await connection.getAccountInfo(c.fill(i)))) continue; // rent reclaimed after settling
        const f = await program.account.fill.fetch(c.fill(i));
        taken += BigInt(f.strikeQuoteAmount.toString());
        if ('matched' in (f.status as object)) {
          running += BigInt(f.strikeQuoteAmount.toString());
          runningStock += BigInt(f.stockRawEscrowed.toString());
          matchedCount++;
        }
      }
      const open = BigInt(p.strikeQuoteOpen.toString());
      const quoteVault = (await getAccount(connection, c.quoteVault, undefined, TOKEN_PROGRAM_ID)).amount;
      const stockVault = (await getAccount(connection, c.stockVault, undefined, TOKEN_2022_PROGRAM_ID)).amount;
      const where = `${step} · ${c.position.toBase58().slice(0, 6)} · FUZZ_SEED=${SEED}`;

      assert.equal(quoteVault.toString(), (open + running).toString(), `quote vault vs open + running claims (${where})`);
      assert.equal(stockVault.toString(), runningStock.toString(), `stock vault vs running slices' stock (${where})`);
      assert.equal(p.stockRawEscrowed.toString(), runningStock.toString(), `position.stock_raw_escrowed (${where})`);
      assert.equal(p.fillsOpen, matchedCount, `fills_open (${where})`);
      // chai's ordering assertions do not take bigints, so these compare directly.
      assert.ok(taken + open <= c.escrowed, `taken + open (${taken + open}) exceeds what was escrowed (${c.escrowed}) (${where})`);
      // With nothing withdrawn and every fill record still present, every dollar escrowed is
      // either still open or was taken: the equality is exact, not just a bound.
      if (p.withdrawnAt.toNumber() === 0 && (await countLive(c, p.fillsCreated)) === p.fillsCreated) {
        assert.equal((taken + open).toString(), c.escrowed.toString(), `taken + open == escrowed (${where})`);
      }

      const expected =
        open === 0n && p.fillsOpen === 0 ? (p.fillsCreated === 0 ? 'cancelled' : 'settled')
        : open === 0n ? 'matched'
        : p.fillsCreated === 0 ? 'open'
        : 'partiallyMatched';
      assert.deepEqual(p.status, { [expected]: {} } as never, `status (${where})`);
    }
  }

  async function countLive(c: Commitment, created: number) {
    let n = 0;
    for (let i = 0; i < created; i++) if (await connection.getAccountInfo(c.fill(i))) n++;
    return n;
  }

  before(async () => {
    const shared = await getShared();
    ({ quoteMint, configPda } = shared);
    for (const who of [maker, ...takers]) await fund(shared, who.publicKey, 1);

    const stockKp = Keypair.generate();
    stockMint = stockKp.publicKey;
    const len = getMintLen([ExtensionType.TransferFeeConfig]);
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: admin.publicKey,
          newAccountPubkey: stockMint,
          space: len,
          lamports: await connection.getMinimumBalanceForRentExemption(len),
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeTransferFeeConfigInstruction(stockMint, admin.publicKey, admin.publicKey, FEE_BPS, BigInt('18446744073709551615'), TOKEN_2022_PROGRAM_ID),
        createInitializeMintInstruction(stockMint, STOCK_DECIMALS, admin.publicKey, null, TOKEN_2022_PROGRAM_ID),
      ),
      [stockKp],
    );
    [marketPda] = PublicKey.findProgramAddressSync([Buffer.from('market'), stockMint.toBuffer()], program.programId);
    await program.methods
      .addMarket('FUZZ')
      .accounts({ admin: admin.publicKey, config: configPda, market: marketPda, stockMint, stockTokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId } as never)
      .rpc();

    for (const who of [maker, ...takers, treasury]) {
      const q = await createAssociatedTokenAccountIdempotent(connection, admin, quoteMint, who.publicKey, {}, TOKEN_PROGRAM_ID);
      await mintTo(connection, admin, quoteMint, q, admin, 1_000_000_000_000n, [], undefined, TOKEN_PROGRAM_ID);
      const s = await createAssociatedTokenAccountIdempotent(connection, admin, stockMint, who.publicKey, {}, TOKEN_2022_PROGRAM_ID);
      await mintTo(connection, admin, stockMint, s, admin, 1_000_000_000_000_000n, [], undefined, TOKEN_2022_PROGRAM_ID);
    }

    await program.methods.setFee(100).accounts({ admin: admin.publicKey, config: configPda, feeTreasury: treasury.publicKey } as never).rpc();
    await program.methods.setMinFill(new BN(MIN_FILL.toString())).accounts({ admin: admin.publicKey, config: configPda } as never).rpc();
  });

  after(async () => {
    await program.methods.setFee(0).accounts({ admin: admin.publicKey, config: configPda, feeTreasury: treasury.publicKey } as never).rpc();
    await program.methods.setMinFill(new BN(0)).accounts({ admin: admin.publicKey, config: configPda } as never).rpc();
    console.log(`      seed ${SEED}:`, JSON.stringify(tally));
  });

  it(`keeps every vault exactly balanced through ${STEPS} random steps and the expiries after`, async function () {
    this.timeout(15 * 60_000);

    // Odd sizes on purpose, so pro-rata rounding is exercised on every slice. Two are short
    // lived, so the walk ends with real expiries rather than only exercises.
    const oddStrike = () => usd(20 + Math.floor(random() * 380) + Math.floor(random() * 100) / 100);
    for (let i = 0; i < 5; i++) {
      const strike = oddStrike();
      const premium = (strike * BigInt(200 + Math.floor(random() * 600))) / 10_000n + 1n;
      const stock = BigInt(10_000_000 + Math.floor(random() * 900_000_000));
      await commit(strike, premium, i < 2 ? 75 : 3600, stock);
    }
    await checkAll('after creation');

    // A running claim on each short-lived commitment, never exercised during the walk, so the
    // walk always ends in real expiries rather than only when the dice allow.
    for (const c of book.filter((x) => x.shortLived)) {
      await take(c, pick(takers), legalSize(c.escrowed));
      tally.takes++;
    }
    await checkAll('after the short-lived takes');

    for (let step = 1; step <= STEPS; step++) {
      const c = pick(book);
      const p = await program.account.position.fetch(c.position);
      const open = BigInt(p.strikeQuoteOpen.toString());
      const clock = Number((await connection.getAccountInfo(anchor.web3.SYSVAR_CLOCK_PUBKEY))!.data.readBigInt64LE(32));
      const expired = clock > p.expiryTs.toNumber();
      const roll = random();

      if (roll < 0.55 && open > 0n && !expired) {
        // Often first try a size the program must refuse. The invariants checked after this
        // step then also prove the refusal moved nothing.
        const who = pick(takers);
        if (random() < 0.4) {
          const bad = illegalSize(open);
          try {
            await take(c, who, bad.size);
            assert.fail(`a ${bad.size} slice of ${open} open should have been refused (FUZZ_SEED=${SEED})`);
          } catch (e: any) {
            assert.include(e.toString(), bad.error, `step ${step}: ${bad.size} of ${open} (FUZZ_SEED=${SEED})`);
            tally.refused++;
          }
        }
        await take(c, who, legalSize(open));
        tally.takes++;
      } else if (roll < 0.8 && !expired && !c.shortLived) {
        // Short-lived commitments are left to run out, so the walk always ends with expiries.
        // Exercise a running slice, if this commitment has one.
        for (let i = 0; i < p.fillsCreated; i++) {
          if (!(await connection.getAccountInfo(c.fill(i)))) continue;
          const f = await program.account.fill.fetch(c.fill(i));
          if ('matched' in (f.status as object)) {
            await settle(c, c.fill(i), 'exercise');
            tally.exercises++;
            break;
          }
        }
      } else if (roll < 0.9 && open > 0n) {
        await program.methods
          .cancelCommitment()
          .accounts({ maker: maker.publicKey, position: c.position, positionAuthority: c.authority, quoteMint, quoteVault: c.quoteVault, makerQuoteAccount: quoteOf(maker.publicKey), quoteTokenProgram: TOKEN_PROGRAM_ID } as never)
          .signers([maker])
          .rpc();
        tally.withdrawals++;
      } else {
        // Reclaim rent on a settled slice: the record goes, the accounting must not care.
        for (let i = 0; i < p.fillsCreated; i++) {
          if (!(await connection.getAccountInfo(c.fill(i)))) continue;
          const f = await program.account.fill.fetch(c.fill(i));
          if (!('matched' in (f.status as object))) {
            const who = takerOf.get(c.fill(i).toBase58())!;
            await program.methods.closeFill().accounts({ taker: who.publicKey, position: c.position, fill: c.fill(i) } as never).signers([who]).rpc();
            tally.reclaims++;
            break;
          }
        }
      }
      await checkAll(`step ${step}`);
    }

    // Let the short-lived commitments run out, then settle whatever is still running on them.
    const deadline = Math.max(...(await Promise.all(book.filter((c) => c.shortLived).map(async (c) => (await program.account.position.fetch(c.position)).expiryTs.toNumber()))));
    for (;;) {
      const now = Number((await connection.getAccountInfo(anchor.web3.SYSVAR_CLOCK_PUBKEY))!.data.readBigInt64LE(32));
      if (now > deadline) break;
      await new Promise((r) => setTimeout(r, Math.min(5000, (deadline - now + 1) * 1000)));
    }
    for (const c of book.filter((x) => x.shortLived)) {
      const p = await program.account.position.fetch(c.position);
      for (let i = 0; i < p.fillsCreated; i++) {
        if (!(await connection.getAccountInfo(c.fill(i)))) continue;
        const f = await program.account.fill.fetch(c.fill(i));
        if ('matched' in (f.status as object)) {
          await settle(c, c.fill(i), 'expire');
          tally.expiries++;
          await checkAll(`expiry of ${c.fill(i).toBase58().slice(0, 6)}`);
        }
      }
    }

    assert.isAbove(tally.takes, 5, `the walk actually took slices (FUZZ_SEED=${SEED})`);
    assert.isAbove(tally.refused, 0, `the walk tried sizes the program must refuse (FUZZ_SEED=${SEED})`);
    assert.isAbove(tally.expiries, 0, `the walk ended with real expiries (FUZZ_SEED=${SEED})`);
  });
});
