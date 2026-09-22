import * as anchor from '@coral-xyz/anchor';
import { Program, BN } from '@coral-xyz/anchor';
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
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
  createMint,
} from '@solana/spl-token';
import { assert } from 'chai';
import { Rung } from '../target/types/rung';
import { getShared } from './fixture.ts';

/**
 * Partial fills: several holders taking slices of one commitment.
 *
 * What these tests are really guarding is that a shared vault stays honest. Each fill is a
 * claim on part of it, and the money must add up whatever order the claims are settled in.
 */
const STOCK_DECIMALS = 9;
const QUOTE_DECIMALS = 6;
const FEE_BPS = 50;

const usd = (n: number) => new BN(Math.round(n * 10 ** QUOTE_DECIMALS));
const grossUp = (required: bigint, bps = FEE_BPS) =>
  (required * 10000n) / BigInt(10000 - bps) + 2n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

describe('rung: partial fills', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Rung as Program<Rung>;
  const connection = provider.connection;

  const admin = (provider.wallet as anchor.Wallet).payer;
  const maker = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const feeTreasury = Keypair.generate();

  let quoteMint: PublicKey;
  let stockMint: PublicKey;
  let configPda: PublicKey;
  let marketPda: PublicKey;
  let makerQuote: PublicKey;
  const quoteOf = new Map<string, PublicKey>();
  const stockOf = new Map<string, PublicKey>();

  const MIN_FILL = usd(10);

  const pdas = (nonce: BN) => {
    const [position] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), maker.publicKey.toBuffer(), nonce.toArrayLike(Buffer, 'le', 8)],
      program.programId,
    );
    const [authority] = PublicKey.findProgramAddressSync(
      [Buffer.from('position_authority'), position.toBuffer()],
      program.programId,
    );
    return {
      position,
      authority,
      quoteVault: getAssociatedTokenAddressSync(quoteMint, authority, true, TOKEN_PROGRAM_ID),
      stockVault: getAssociatedTokenAddressSync(stockMint, authority, true, TOKEN_2022_PROGRAM_ID),
      fill: (index: number) =>
        PublicKey.findProgramAddressSync(
          [Buffer.from('fill'), position.toBuffer(), new BN(index).toArrayLike(Buffer, 'le', 4)],
          program.programId,
        )[0],
    };
  };

  let nonceCounter = 0;
  async function createCommitment(opts: {
    stockRequired: bigint;
    strike: BN;
    premium: BN;
    expiryOffsetSecs?: number;
  }) {
    const nonce = new BN(++nonceCounter);
    const p = pdas(nonce);
    await program.methods
      .createCommitment(
        nonce,
        new BN(opts.stockRequired.toString()),
        opts.strike,
        opts.premium,
        new BN(Math.floor(Date.now() / 1000) + (opts.expiryOffsetSecs ?? 3600)),
        new BN(1_000_000_000_000),
      )
      .accounts({
        maker: maker.publicKey,
        config: configPda,
        market: marketPda,
        position: p.position,
        positionAuthority: p.authority,
        stockMint,
        quoteMint,
        makerQuoteAccount: makerQuote,
        quoteVault: p.quoteVault,
        stockVault: p.stockVault,
        stockTokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([maker])
      .rpc();
    return { ...p, nonce };
  }

  async function take(p: ReturnType<typeof pdas>, who: Keypair, fillStrike: BN, send: bigint) {
    const position = await program.account.position.fetch(p.position);
    const fill = p.fill(position.fillsCreated);
    await program.methods
      .acceptCommitment(new BN(send.toString()), fillStrike)
      .accounts({
        taker: who.publicKey,
        config: configPda,
        market: marketPda,
        position: p.position,
        fill,
        positionAuthority: p.authority,
        stockMint,
        quoteMint,
        takerStockAccount: stockOf.get(who.publicKey.toBase58())!,
        takerQuoteAccount: quoteOf.get(who.publicKey.toBase58())!,
        makerQuoteAccount: makerQuote,
        feeTreasuryAccount: getAssociatedTokenAddressSync(quoteMint, feeTreasury.publicKey, false, TOKEN_PROGRAM_ID),
        feeTreasury: feeTreasury.publicKey,
        stockVault: p.stockVault,
        stockTokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([who])
      .rpc();
    return fill;
  }

  async function exercise(p: ReturnType<typeof pdas>, fill: PublicKey, who: Keypair) {
    return program.methods
      .exerciseFill()
      .accounts({
        taker: who.publicKey,
        position: p.position,
        fill,
        positionAuthority: p.authority,
        maker: maker.publicKey,
        stockMint,
        quoteMint,
        quoteVault: p.quoteVault,
        stockVault: p.stockVault,
        takerQuoteAccount: quoteOf.get(who.publicKey.toBase58())!,
        makerStockAccount: getAssociatedTokenAddressSync(stockMint, maker.publicKey, false, TOKEN_2022_PROGRAM_ID),
        stockTokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([who])
      .rpc();
  }

  async function cancel(p: ReturnType<typeof pdas>) {
    return program.methods
      .cancelCommitment()
      .accounts({
        maker: maker.publicKey,
        position: p.position,
        positionAuthority: p.authority,
        quoteMint,
        quoteVault: p.quoteVault,
        makerQuoteAccount: makerQuote,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();
  }

  /** What the vault owes: the open remainder plus every unsettled fill's claim. */
  async function owed(p: ReturnType<typeof pdas>) {
    const position = await program.account.position.fetch(p.position);
    let total = BigInt(position.strikeQuoteOpen.toString());
    for (let i = 0; i < position.fillsCreated; i++) {
      const info = await connection.getAccountInfo(p.fill(i));
      if (!info) continue; // settled, and closed
      const fill = await program.account.fill.fetch(p.fill(i));
      total += BigInt(fill.strikeQuoteAmount.toString());
    }
    return total;
  }

  async function fund(to: PublicKey, sol: number) {
    const lamports = Math.round(sol * LAMPORTS_PER_SOL);
    try {
      const sig = await connection.requestAirdrop(to, lamports);
      await connection.confirmTransaction(sig, 'confirmed');
      return;
    } catch {
      // Devnet's faucet is rate-limited; pay from the provider wallet instead.
    }
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: to, lamports }),
      ),
      [],
    );
  }

  before(async () => {
    await fund(maker.publicKey, 1.0);
    await fund(alice.publicKey, 0.5);
    await fund(bob.publicKey, 0.5);

    ({ quoteMint, configPda } = await getShared());

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
        createInitializeTransferFeeConfigInstruction(
          stockMint,
          admin.publicKey,
          admin.publicKey,
          FEE_BPS,
          BigInt('18446744073709551615'),
          TOKEN_2022_PROGRAM_ID,
        ),
        createInitializeMintInstruction(stockMint, STOCK_DECIMALS, admin.publicKey, null, TOKEN_2022_PROGRAM_ID),
      ),
      [stockKp],
    );

    makerQuote = await createAssociatedTokenAccountIdempotent(connection, admin, quoteMint, maker.publicKey, {}, TOKEN_PROGRAM_ID);
    await mintTo(connection, admin, quoteMint, makerQuote, admin, 1_000_000 * 10 ** QUOTE_DECIMALS, [], undefined, TOKEN_PROGRAM_ID);

    for (const who of [alice, bob]) {
      const q = await createAssociatedTokenAccountIdempotent(connection, admin, quoteMint, who.publicKey, {}, TOKEN_PROGRAM_ID);
      const s = await createAssociatedTokenAccountIdempotent(connection, admin, stockMint, who.publicKey, {}, TOKEN_2022_PROGRAM_ID);
      quoteOf.set(who.publicKey.toBase58(), q);
      stockOf.set(who.publicKey.toBase58(), s);
      await mintTo(connection, admin, quoteMint, q, admin, 100_000 * 10 ** QUOTE_DECIMALS, [], undefined, TOKEN_PROGRAM_ID);
      await mintTo(connection, admin, stockMint, s, admin, 1_000 * 10 ** STOCK_DECIMALS, [], undefined, TOKEN_2022_PROGRAM_ID);
    }

    [marketPda] = PublicKey.findProgramAddressSync([Buffer.from('market'), stockMint.toBuffer()], program.programId);
    await program.methods
      .setFee(100)
      .accounts({ admin: admin.publicKey, config: configPda, feeTreasury: feeTreasury.publicKey })
      .rpc();
    await program.methods
      .setMinFill(MIN_FILL)
      .accounts({ admin: admin.publicKey, config: configPda })
      .rpc();

    await program.methods
      .addMarket('MOCKFILL')
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        market: marketPda,
        stockMint,
        stockTokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  after(async () => {
    // Leave the shared config as the other suite expects to find it.
    await program.methods
      .setFee(0)
      .accounts({ admin: admin.publicKey, config: configPda, feeTreasury: feeTreasury.publicKey })
      .rpc();
    await program.methods
      .setMinFill(new BN(0))
      .accounts({ admin: admin.publicKey, config: configPda })
      .rpc();
  });

  it('takes a slice and leaves the rest open', async () => {
    const required = 90_000_000n;
    const p = await createCommitment({ stockRequired: required, strike: usd(100), premium: usd(5) });

    const fillStrike = usd(40);
    const expectedStock = ceilDiv(required * 40n, 100n);
    await take(p, alice, fillStrike, grossUp(expectedStock));

    const position = await program.account.position.fetch(p.position);
    assert.deepEqual(position.status, { partiallyMatched: {} });
    assert.equal(position.strikeQuoteOpen.toString(), usd(60).toString(), '60 USDC is still on offer');
    assert.equal(position.fillsCreated, 1);
    assert.equal(position.fillsOpen, 1);

    const fill = await program.account.fill.fetch(p.fill(0));
    assert.equal(fill.taker.toBase58(), alice.publicKey.toBase58());
    assert.equal(fill.strikeQuoteAmount.toString(), fillStrike.toString());
    assert.equal(fill.stockRawRequired.toString(), expectedStock.toString(), 'stock is pro rata, rounded up');
    assert.equal(fill.premiumPaid.toString(), usd(2).toString(), '40% of a 5 USDC premium');

    // The vault still holds every dollar it owes: the open remainder and Alice's claim.
    const vault = (await getAccount(connection, p.quoteVault, undefined, TOKEN_PROGRAM_ID)).amount;
    assert.equal(vault.toString(), (await owed(p)).toString());
  });

  it('lets a second holder take the remainder, and settles the two independently', async () => {
    const required = 90_000_000n;
    const p = await createCommitment({ stockRequired: required, strike: usd(100), premium: usd(5) });

    const aliceFill = await take(p, alice, usd(40), grossUp(ceilDiv(required * 40n, 100n)));
    const bobFill = await take(p, bob, usd(60), grossUp(ceilDiv(required * 60n, 100n)));

    let position = await program.account.position.fetch(p.position);
    assert.deepEqual(position.status, { matched: {} }, 'nothing open, two fills outstanding');
    assert.equal(position.fillsOpen, 2);

    const aliceQuoteBefore = (await getAccount(connection, quoteOf.get(alice.publicKey.toBase58())!, undefined, TOKEN_PROGRAM_ID)).amount;
    await exercise(p, aliceFill, alice);
    const aliceQuoteAfter = (await getAccount(connection, quoteOf.get(alice.publicKey.toBase58())!, undefined, TOKEN_PROGRAM_ID)).amount;
    assert.equal((aliceQuoteAfter - aliceQuoteBefore).toString(), usd(40).toString(), 'Alice is paid her slice, not the whole strike');

    // Bob's collateral is untouched by Alice's exercise, and still fully covered.
    position = await program.account.position.fetch(p.position);
    assert.deepEqual(position.status, { matched: {} }, 'Bob is still outstanding');
    assert.equal(position.fillsOpen, 1);
    const vault = (await getAccount(connection, p.quoteVault, undefined, TOKEN_PROGRAM_ID)).amount;
    assert.equal(vault.toString(), (await owed(p)).toString());
    assert.equal(vault.toString(), usd(60).toString());

    await exercise(p, bobFill, bob);
    position = await program.account.position.fetch(p.position);
    assert.deepEqual(position.status, { settled: {} });
    assert.equal(position.fillsOpen, 0);
    assert.equal((await getAccount(connection, p.quoteVault, undefined, TOKEN_PROGRAM_ID)).amount.toString(), '0');
    assert.equal((await getAccount(connection, p.stockVault, undefined, TOKEN_2022_PROGRAM_ID)).amount.toString(), '0');
  });

  it('never lets a partition of a commitment cost less than taking it whole', async () => {
    // An odd size and an odd premium, so every slice has something to round.
    const required = 83_365_949n;
    const strike = usd(99.99);
    const premium = usd(4.61);
    const whole = await createCommitment({ stockRequired: required, strike, premium });
    const split = await createCommitment({ stockRequired: required, strike, premium });

    await take(whole, alice, strike, grossUp(required));
    const wholeFill = await program.account.fill.fetch(whole.fill(0));

    // The same commitment taken in three uneven slices.
    const slices = [usd(33.33), usd(33.33), usd(33.33)];
    const total = BigInt(strike.toString());
    let stockSum = 0n;
    let premiumSum = 0n;
    for (const [i, slice] of slices.entries()) {
      const amount = i === slices.length - 1
        ? BigInt((await program.account.position.fetch(split.position)).strikeQuoteOpen.toString())
        : BigInt(slice.toString());
      const need = ceilDiv(BigInt(required) * amount, total);
      await take(split, i % 2 === 0 ? alice : bob, new BN(amount.toString()), grossUp(need));
      const fill = await program.account.fill.fetch(split.fill(i));
      stockSum += BigInt(fill.stockRawRequired.toString());
      premiumSum += BigInt(fill.premiumPaid.toString());
    }

    assert.isAtLeast(
      Number(stockSum - BigInt(wholeFill.stockRawRequired.toString())),
      0,
      'splitting must never buy the same claim for less stock',
    );
    assert.isAtLeast(
      Number(premiumSum - BigInt(wholeFill.premiumPaid.toString())),
      0,
      'splitting must never buy the same claim for a smaller premium',
    );
  });

  it('takes the protocol fee out of the premium, never out of collateral', async () => {
    const required = 50_000_000n;
    const p = await createCommitment({ stockRequired: required, strike: usd(50), premium: usd(4) });

    const treasuryAta = getAssociatedTokenAddressSync(quoteMint, feeTreasury.publicKey, false, TOKEN_PROGRAM_ID);
    const before = (await connection.getAccountInfo(treasuryAta))
      ? (await getAccount(connection, treasuryAta, undefined, TOKEN_PROGRAM_ID)).amount
      : 0n;
    const makerBefore = (await getAccount(connection, makerQuote, undefined, TOKEN_PROGRAM_ID)).amount;

    await take(p, alice, usd(50), grossUp(required));

    const after = (await getAccount(connection, treasuryAta, undefined, TOKEN_PROGRAM_ID)).amount;
    const makerAfter = (await getAccount(connection, makerQuote, undefined, TOKEN_PROGRAM_ID)).amount;
    // 100 bps of a 4 USDC premium.
    assert.equal((after - before).toString(), usd(0.04).toString());
    assert.equal((makerAfter - makerBefore).toString(), usd(3.96).toString(), 'maker receives the premium less the fee');

    // Collateral is untouched by the fee: the strike is all still there.
    assert.equal(
      (await getAccount(connection, p.quoteVault, undefined, TOKEN_PROGRAM_ID)).amount.toString(),
      usd(50).toString(),
    );
  });

  it('refuses a fee above the cap', async () => {
    try {
      await program.methods
        .setFee(501)
        .accounts({ admin: admin.publicKey, config: configPda, feeTreasury: feeTreasury.publicKey })
        .rpc();
      assert.fail('should have rejected');
    } catch (e: any) {
      assert.include(e.toString(), 'FeeTooHigh');
    }
  });

  describe('dust', () => {
    it('refuses a fill below the minimum', async () => {
      const p = await createCommitment({ stockRequired: 90_000_000n, strike: usd(100), premium: usd(5) });
      try {
        await take(p, alice, usd(5), grossUp(5_000_000n));
        assert.fail('should have rejected');
      } catch (e: any) {
        assert.include(e.toString(), 'FillTooSmall');
      }
    });

    it('refuses a fill that would leave an untakeable remainder', async () => {
      const p = await createCommitment({ stockRequired: 90_000_000n, strike: usd(100), premium: usd(5) });
      try {
        await take(p, alice, usd(95), grossUp(ceilDiv(90_000_000n * 95n, 100n)));
        assert.fail('should have rejected');
      } catch (e: any) {
        assert.include(e.toString(), 'FillRemainderTooSmall');
      }
    });

    it('always allows clearing the whole remainder, however small', async () => {
      const p = await createCommitment({ stockRequired: 90_000_000n, strike: usd(100), premium: usd(5) });
      await take(p, alice, usd(90), grossUp(ceilDiv(90_000_000n * 90n, 100n)));
      // 10 USDC left, exactly the minimum; take it down to nothing.
      await take(p, bob, usd(10), grossUp(ceilDiv(90_000_000n * 10n, 100n)));
      const position = await program.account.position.fetch(p.position);
      assert.equal(position.strikeQuoteOpen.toString(), '0');
      assert.deepEqual(position.status, { matched: {} });
    });
  });

  it('lets the maker withdraw the open remainder while a fill runs its term', async () => {
    const required = 90_000_000n;
    const p = await createCommitment({ stockRequired: required, strike: usd(100), premium: usd(5) });
    const fill = await take(p, alice, usd(40), grossUp(ceilDiv(required * 40n, 100n)));

    const makerBefore = (await getAccount(connection, makerQuote, undefined, TOKEN_PROGRAM_ID)).amount;
    await cancel(p);
    const makerAfter = (await getAccount(connection, makerQuote, undefined, TOKEN_PROGRAM_ID)).amount;
    assert.equal((makerAfter - makerBefore).toString(), usd(60).toString(), 'only the unclaimed 60 comes back');

    const position = await program.account.position.fetch(p.position);
    assert.deepEqual(position.status, { matched: {} }, 'nothing open, Alice still outstanding');

    // Alice's claim survived the cancel untouched, and is still fully funded.
    const vault = (await getAccount(connection, p.quoteVault, undefined, TOKEN_PROGRAM_ID)).amount;
    assert.equal(vault.toString(), usd(40).toString());
    await exercise(p, fill, alice);
    assert.equal((await getAccount(connection, p.quoteVault, undefined, TOKEN_PROGRAM_ID)).amount.toString(), '0');
  });

  it('refuses a second withdrawal once nothing is open', async () => {
    const p = await createCommitment({ stockRequired: 1_000_000n, strike: usd(20), premium: usd(1) });
    await cancel(p);
    try {
      await cancel(p);
      assert.fail('should have rejected');
    } catch (e: any) {
      assert.include(e.toString(), 'NothingOpen');
    }
  });
});
