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
  createInitializeTransferHookInstruction,
  createUpdateTransferHookInstruction,
  createAssociatedTokenAccountIdempotent,
  createAccount,
  getAssociatedTokenAddressSync,
  getAccount,
  mintTo,
  createMint,
} from '@solana/spl-token';
import { assert } from 'chai';
import { Rung } from '../target/types/rung';

/**
 * The mock PreStock carries a transfer fee, because that is the extension the *program*
 * has to cope with: an amount sent is never the amount that arrives.
 *
 * It deliberately does NOT carry ScaledUiAmount. That extension only ever affects how a raw
 * amount is displayed and priced, which is client-side work covered by the SDK unit tests
 * against real mainnet values. The program stores raw amounts and never reads a multiplier,
 * so adding it here would test nothing the program does.
 */
const STOCK_DECIMALS = 9;
const QUOTE_DECIMALS = 6;
const FEE_BPS = 50;

const usd = (n: number) => new BN(Math.round(n * 10 ** QUOTE_DECIMALS));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What lands in the destination after Token-2022 withholds its fee (ceiling-rounded). */
const afterFee = (amount: bigint, bps = FEE_BPS) =>
  amount - (amount * BigInt(bps) + 9999n) / 10000n;

/** Enough to clear a required amount whatever the fee does. */
const grossUp = (required: bigint, bps = FEE_BPS) =>
  (required * 10000n) / BigInt(10000 - bps) + 2n;

describe('rung', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Rung as Program<Rung>;
  const connection = provider.connection;

  const admin = (provider.wallet as anchor.Wallet).payer;
  const maker = Keypair.generate();
  const taker = Keypair.generate();

  let quoteMint: PublicKey;
  let stockMint: PublicKey;
  let configPda: PublicKey;
  let marketPda: PublicKey;

  let makerQuote: PublicKey;
  let takerQuote: PublicKey;
  let takerStock: PublicKey;

  const pdas = (makerKey: PublicKey, nonce: BN) => {
    const [position] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), makerKey.toBuffer(), nonce.toArrayLike(Buffer, 'le', 8)],
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
    };
  };

  let nonceCounter = 0;
  const nextNonce = () => new BN(++nonceCounter);

  /** Create an Open commitment and return everything needed to act on it. */
  async function createCommitment(opts: {
    stockRequired: bigint;
    strike: BN;
    premium: BN;
    expiryOffsetSecs: number;
    targetValuationUsd?: BN;
  }) {
    const nonce = nextNonce();
    const p = pdas(maker.publicKey, nonce);
    const expiry = new BN(Math.floor(Date.now() / 1000) + opts.expiryOffsetSecs);

    await program.methods
      .createCommitment(
        nonce,
        new BN(opts.stockRequired.toString()),
        opts.strike,
        opts.premium,
        expiry,
        opts.targetValuationUsd ?? new BN(1_000_000_000_000),
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

    return { ...p, nonce, expiry };
  }

  async function accept(p: { position: PublicKey; authority: PublicKey; stockVault: PublicKey }, send: bigint) {
    return program.methods
      .acceptCommitment(new BN(send.toString()))
      .accounts({
        taker: taker.publicKey,
        config: configPda,
        market: marketPda,
        position: p.position,
        positionAuthority: p.authority,
        stockMint,
        quoteMint,
        takerStockAccount: takerStock,
        takerQuoteAccount: takerQuote,
        makerQuoteAccount: makerQuote,
        stockVault: p.stockVault,
        stockTokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([taker])
      .rpc();
  }

  /**
   * Fund a test keypair, working on either a local validator or devnet.
   *
   * A local validator airdrops instantly and without limit, which is the fast path. Devnet's
   * faucet is capped per request and rate-limited across them, so there the airdrop fails
   * and we pay out of the provider wallet instead — which is funded once, out of band.
   * Trying both means the suite does not care which cluster it is pointed at.
   */
  async function fund(to: PublicKey, sol: number) {
    const lamports = Math.round(sol * LAMPORTS_PER_SOL);
    try {
      const sig = await connection.requestAirdrop(to, lamports);
      await connection.confirmTransaction(sig, 'confirmed');
      return;
    } catch {
      // Expected on devnet; fall through to paying from the provider wallet.
    }
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: to, lamports }),
    );
    await provider.sendAndConfirm(tx, []);
  }

  before(async () => {
    // Enough for account rent across the suite: each position costs roughly 0.007 SOL in
    // rent for its Position account and two vaults, and the maker creates all of them.
    await fund(maker.publicKey, 1.0);
    await fund(taker.publicKey, 0.3);

    // USDC stand-in: legacy SPL Token, no extensions, exactly like the real thing.
    quoteMint = await createMint(connection, admin, admin.publicKey, null, QUOTE_DECIMALS, undefined, undefined, TOKEN_PROGRAM_ID);

    // Mock PreStock: Token-2022 with a transfer fee.
    const stockKp = Keypair.generate();
    stockMint = stockKp.publicKey;
    const len = getMintLen([ExtensionType.TransferFeeConfig]);
    const lamports = await connection.getMinimumBalanceForRentExemption(len);
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: stockMint,
        space: len,
        lamports,
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
    );
    await provider.sendAndConfirm(tx, [stockKp]);

    makerQuote = await createAssociatedTokenAccountIdempotent(connection, admin, quoteMint, maker.publicKey, {}, TOKEN_PROGRAM_ID);
    takerQuote = await createAssociatedTokenAccountIdempotent(connection, admin, quoteMint, taker.publicKey, {}, TOKEN_PROGRAM_ID);
    takerStock = await createAssociatedTokenAccountIdempotent(connection, admin, stockMint, taker.publicKey, {}, TOKEN_2022_PROGRAM_ID);

    await mintTo(connection, admin, quoteMint, makerQuote, admin, 1_000_000 * 10 ** QUOTE_DECIMALS, [], undefined, TOKEN_PROGRAM_ID);
    await mintTo(connection, admin, quoteMint, takerQuote, admin, 1_000_000 * 10 ** QUOTE_DECIMALS, [], undefined, TOKEN_PROGRAM_ID);
    await mintTo(connection, admin, stockMint, takerStock, admin, 1_000 * 10 ** STOCK_DECIMALS, [], undefined, TOKEN_2022_PROGRAM_ID);

    [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId);
    [marketPda] = PublicKey.findProgramAddressSync([Buffer.from('market'), stockMint.toBuffer()], program.programId);

    await program.methods
      .initializeConfig()
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        quoteMint,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .addMarket('MOCKAI')
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

  describe('creation', () => {
    it('escrows the strike and opens the position', async () => {
      const strike = usd(100);
      const p = await createCommitment({
        stockRequired: 83_365_949n,
        strike,
        premium: usd(4.6),
        expiryOffsetSecs: 3600,
      });

      const pos = await program.account.position.fetch(p.position);
      assert.deepEqual(pos.status, { open: {} });
      assert.equal(pos.strikeQuoteEscrowed.toString(), strike.toString());
      assert.equal(pos.stockRawEscrowed.toNumber(), 0, 'no stock until matched');
      assert.equal(pos.taker.toBase58(), PublicKey.default.toBase58());
      assert.equal(pos.targetValuationUsd.toString(), '1000000000000');

      const vault = await getAccount(connection, p.quoteVault, undefined, TOKEN_PROGRAM_ID);
      assert.equal(vault.amount.toString(), strike.toString(), 'USDC has no fee, so escrow is exact');
    });

    it('rejects a zero quantity', async () => {
      try {
        await createCommitment({ stockRequired: 0n, strike: usd(100), premium: usd(1), expiryOffsetSecs: 3600 });
        assert.fail('should have rejected');
      } catch (e: any) {
        assert.include(e.toString(), 'InvalidAmount');
      }
    });

    it('rejects an expiry in the past', async () => {
      try {
        await createCommitment({ stockRequired: 1000n, strike: usd(100), premium: usd(1), expiryOffsetSecs: -60 });
        assert.fail('should have rejected');
      } catch (e: any) {
        assert.include(e.toString(), 'InvalidExpiry');
      }
    });

    it('rejects an expiry beyond the maximum horizon', async () => {
      try {
        await createCommitment({ stockRequired: 1000n, strike: usd(100), premium: usd(1), expiryOffsetSecs: 400 * 24 * 3600 });
        assert.fail('should have rejected');
      } catch (e: any) {
        assert.include(e.toString(), 'InvalidExpiry');
      }
    });

    it('accepts a strike exactly at the per-position cap', async () => {
      const p = await createCommitment({ stockRequired: 1000n, strike: usd(1_000), premium: usd(1), expiryOffsetSecs: 3600 });
      const pos = await program.account.position.fetch(p.position);
      assert.equal(pos.strikeQuoteEscrowed.toString(), usd(1_000).toString());
    });

    it('rejects a strike one base unit above the cap', async () => {
      try {
        await createCommitment({ stockRequired: 1000n, strike: usd(1_000).addn(1), premium: usd(1), expiryOffsetSecs: 3600 });
        assert.fail('should have rejected');
      } catch (e: any) {
        assert.include(e.toString(), 'StrikeAboveCap');
      }
    });
  });

  describe('cancellation', () => {
    it('returns the maker their collateral', async () => {
      const p = await createCommitment({ stockRequired: 1000n, strike: usd(50), premium: usd(1), expiryOffsetSecs: 3600 });
      const before = (await getAccount(connection, makerQuote, undefined, TOKEN_PROGRAM_ID)).amount;

      await program.methods
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

      const after = (await getAccount(connection, makerQuote, undefined, TOKEN_PROGRAM_ID)).amount;
      assert.equal((after - before).toString(), usd(50).toString());
      const pos = await program.account.position.fetch(p.position);
      assert.deepEqual(pos.status, { cancelled: {} });
    });

    it('refuses a non-maker', async () => {
      const p = await createCommitment({ stockRequired: 1000n, strike: usd(50), premium: usd(1), expiryOffsetSecs: 3600 });
      try {
        await program.methods
          .cancelCommitment()
          .accounts({
            maker: taker.publicKey,
            position: p.position,
            positionAuthority: p.authority,
            quoteMint,
            quoteVault: p.quoteVault,
            makerQuoteAccount: takerQuote,
            quoteTokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([taker])
          .rpc();
        assert.fail('should have rejected');
      } catch (e: any) {
        assert.match(e.toString(), /Unauthorized|ConstraintSeeds|has_one/);
      }
    });
  });

  describe('matching', () => {
    it('records what the vault actually received, not what was sent', async () => {
      const required = 83_365_949n;
      const p = await createCommitment({ stockRequired: required, strike: usd(100), premium: usd(4.6), expiryOffsetSecs: 3600 });

      const send = grossUp(required);
      const makerBefore = (await getAccount(connection, makerQuote, undefined, TOKEN_PROGRAM_ID)).amount;
      await accept(p, send);

      const pos = await program.account.position.fetch(p.position);
      const vault = await getAccount(connection, p.stockVault, undefined, TOKEN_2022_PROGRAM_ID);

      assert.deepEqual(pos.status, { matched: {} });
      // The headline property: less arrived than was sent, and the program knows it.
      assert.isBelow(Number(vault.amount), Number(send), 'fee must have been withheld');
      assert.equal(pos.stockRawEscrowed.toString(), vault.amount.toString(), 'escrowed == actual vault balance');
      assert.equal(vault.amount.toString(), afterFee(send).toString(), 'matches Token-2022 fee math');
      assert.isAtLeast(Number(pos.stockRawEscrowed), Number(required), 'must still clear the required floor');

      // Premium is paid on match, straight to the maker.
      const makerAfter = (await getAccount(connection, makerQuote, undefined, TOKEN_PROGRAM_ID)).amount;
      assert.equal((makerAfter - makerBefore).toString(), usd(4.6).toString());
    });

    it('rejects an amount that does not clear the required floor after fees', async () => {
      const required = 83_365_949n;
      const p = await createCommitment({ stockRequired: required, strike: usd(100), premium: usd(1), expiryOffsetSecs: 3600 });
      try {
        // Sending exactly the required amount is the classic mistake: the fee eats into it.
        await accept(p, required);
        assert.fail('should have rejected');
      } catch (e: any) {
        assert.include(e.toString(), 'InsufficientCollateral');
      }
    });

    it('refuses a maker taking their own commitment', async () => {
      const p = await createCommitment({ stockRequired: 1_000_000n, strike: usd(10), premium: usd(1), expiryOffsetSecs: 3600 });
      const makerStock = await createAssociatedTokenAccountIdempotent(connection, admin, stockMint, maker.publicKey, {}, TOKEN_2022_PROGRAM_ID);
      // A second USDC account the maker owns. Reusing the ATA would trip Anchor's
      // duplicate-mutable-account check first; this is the route that check does not cover.
      const makerSecondQuote = await createAccount(connection, admin, quoteMint, maker.publicKey, Keypair.generate(), undefined, TOKEN_PROGRAM_ID);
      try {
        await program.methods
          .acceptCommitment(new BN(grossUp(1_000_000n).toString()))
          .accounts({
            taker: maker.publicKey,
            config: configPda,
            market: marketPda,
            position: p.position,
            positionAuthority: p.authority,
            stockMint,
            quoteMint,
            takerStockAccount: makerStock,
            takerQuoteAccount: makerSecondQuote,
            makerQuoteAccount: makerQuote,
            stockVault: p.stockVault,
            stockTokenProgram: TOKEN_2022_PROGRAM_ID,
            quoteTokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([maker])
          .rpc();
        assert.fail('should have rejected');
      } catch (e: any) {
        assert.include(e.toString(), 'SelfMatch');
      }
    });

    it('refuses a second accept', async () => {
      const required = 1_000_000n;
      const p = await createCommitment({ stockRequired: required, strike: usd(10), premium: usd(1), expiryOffsetSecs: 3600 });
      await accept(p, grossUp(required));
      try {
        await accept(p, grossUp(required));
        assert.fail('should have rejected');
      } catch (e: any) {
        assert.include(e.toString(), 'InvalidState');
      }
    });

    it('refuses to cancel once matched', async () => {
      const required = 1_000_000n;
      const p = await createCommitment({ stockRequired: required, strike: usd(10), premium: usd(1), expiryOffsetSecs: 3600 });
      await accept(p, grossUp(required));
      try {
        await program.methods
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
        assert.fail('a matched maker must not be able to walk away');
      } catch (e: any) {
        assert.include(e.toString(), 'InvalidState');
      }
    });
  });

  describe('exercise', () => {
    const makerStock = () => getAssociatedTokenAddressSync(stockMint, maker.publicKey, false, TOKEN_2022_PROGRAM_ID);

    async function exercise(p: { position: PublicKey; authority: PublicKey; quoteVault: PublicKey; stockVault: PublicKey }, signer = taker) {
      return program.methods
        .exercisePosition()
        .accounts({
          taker: signer.publicKey,
          position: p.position,
          positionAuthority: p.authority,
          maker: maker.publicKey,
          stockMint,
          quoteMint,
          quoteVault: p.quoteVault,
          stockVault: p.stockVault,
          takerQuoteAccount: takerQuote,
          makerStockAccount: makerStock(),
          stockTokenProgram: TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([signer])
        .rpc();
    }

    it('swaps both legs atomically', async () => {
      const required = 83_365_949n;
      const strike = usd(100);
      const p = await createCommitment({ stockRequired: required, strike, premium: usd(4.6), expiryOffsetSecs: 3600 });
      await accept(p, grossUp(required));

      const escrowed = BigInt((await program.account.position.fetch(p.position)).stockRawEscrowed.toString());
      const takerQuoteBefore = (await getAccount(connection, takerQuote, undefined, TOKEN_PROGRAM_ID)).amount;

      await exercise(p);

      const pos = await program.account.position.fetch(p.position);
      assert.deepEqual(pos.status, { exercised: {} });

      const takerQuoteAfter = (await getAccount(connection, takerQuote, undefined, TOKEN_PROGRAM_ID)).amount;
      assert.equal((takerQuoteAfter - takerQuoteBefore).toString(), strike.toString(), 'holder receives the full strike');

      // The maker's stock is fee-reduced once more on the way out; that drag is inherent to
      // the mint and is what the UI has to disclose rather than hide.
      const received = (await getAccount(connection, makerStock(), undefined, TOKEN_2022_PROGRAM_ID)).amount;
      assert.equal(received.toString(), afterFee(escrowed).toString());

      assert.equal((await getAccount(connection, p.quoteVault, undefined, TOKEN_PROGRAM_ID)).amount.toString(), '0');
      assert.equal((await getAccount(connection, p.stockVault, undefined, TOKEN_2022_PROGRAM_ID)).amount.toString(), '0');
    });

    it('refuses anyone but the taker', async () => {
      const required = 1_000_000n;
      const p = await createCommitment({ stockRequired: required, strike: usd(10), premium: usd(1), expiryOffsetSecs: 3600 });
      await accept(p, grossUp(required));
      try {
        await exercise(p, maker);
        assert.fail('the maker must not be able to force exercise');
      } catch (e: any) {
        assert.match(e.toString(), /Unauthorized|has_one|ConstraintHasOne/);
      }
    });

    it('refuses a second exercise', async () => {
      const required = 1_000_000n;
      const p = await createCommitment({ stockRequired: required, strike: usd(10), premium: usd(1), expiryOffsetSecs: 3600 });
      await accept(p, grossUp(required));
      await exercise(p);
      try {
        await exercise(p);
        assert.fail('should have rejected');
      } catch (e: any) {
        assert.include(e.toString(), 'InvalidState');
      }
    });

    it('refuses an unmatched position', async () => {
      const p = await createCommitment({ stockRequired: 1_000_000n, strike: usd(10), premium: usd(1), expiryOffsetSecs: 3600 });
      try {
        await exercise(p);
        assert.fail('should have rejected');
      } catch (e: any) {
        assert.match(e.toString(), /InvalidState|Unauthorized|has_one/);
      }
    });
  });

  describe('expiry', () => {
    async function expire(p: { position: PublicKey; authority: PublicKey; quoteVault: PublicKey; stockVault: PublicKey }, cranker: Keypair) {
      return program.methods
        .expirePosition()
        .accounts({
          cranker: cranker.publicKey,
          position: p.position,
          maker: maker.publicKey,
          taker: taker.publicKey,
          positionAuthority: p.authority,
          stockMint,
          quoteMint,
          quoteVault: p.quoteVault,
          stockVault: p.stockVault,
          makerQuoteAccount: makerQuote,
          takerStockAccount: takerStock,
          stockTokenProgram: TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([cranker])
        .rpc();
    }

    it('refuses before the deadline', async () => {
      const required = 1_000_000n;
      const p = await createCommitment({ stockRequired: required, strike: usd(10), premium: usd(1), expiryOffsetSecs: 3600 });
      await accept(p, grossUp(required));
      try {
        await expire(p, admin);
        assert.fail('should have rejected');
      } catch (e: any) {
        assert.include(e.toString(), 'PositionNotExpired');
      }
    });

    // Slow by necessity: the program reads the on-chain Clock, and the minimum expiry
    // horizon is 60s precisely so a position cannot lapse before an accept can land.
    it('returns both collaterals after the deadline, cranked by an uninvolved party', async function () {
      this.timeout(120_000);
      const required = 1_000_000n;
      const p = await createCommitment({ stockRequired: required, strike: usd(10), premium: usd(1), expiryOffsetSecs: 62 });
      await accept(p, grossUp(required));

      const escrowed = BigInt((await program.account.position.fetch(p.position)).stockRawEscrowed.toString());
      const makerBefore = (await getAccount(connection, makerQuote, undefined, TOKEN_PROGRAM_ID)).amount;
      const takerBefore = (await getAccount(connection, takerStock, undefined, TOKEN_2022_PROGRAM_ID)).amount;

      await sleep(65_000);

      // `admin` is neither maker nor taker: expiry must not depend on a counterparty.
      await expire(p, admin);

      const pos = await program.account.position.fetch(p.position);
      assert.deepEqual(pos.status, { expired: {} });

      const makerAfter = (await getAccount(connection, makerQuote, undefined, TOKEN_PROGRAM_ID)).amount;
      const takerAfter = (await getAccount(connection, takerStock, undefined, TOKEN_2022_PROGRAM_ID)).amount;
      assert.equal((makerAfter - makerBefore).toString(), usd(10).toString(), 'maker gets their USDC back');
      assert.equal((takerAfter - takerBefore).toString(), afterFee(escrowed).toString(), 'taker gets their stock back');
    });
  });

  describe('market administration', () => {
    it('blocks new commitments once disabled but still settles existing ones', async () => {
      const required = 1_000_000n;
      const live = await createCommitment({ stockRequired: required, strike: usd(10), premium: usd(1), expiryOffsetSecs: 3600 });
      await accept(live, grossUp(required));

      await program.methods
        .setMarketEnabled(false, false)
        .accounts({ admin: admin.publicKey, config: configPda, market: marketPda })
        .rpc();

      try {
        await createCommitment({ stockRequired: 1000n, strike: usd(10), premium: usd(1), expiryOffsetSecs: 3600 });
        assert.fail('disabled market must refuse new commitments');
      } catch (e: any) {
        assert.include(e.toString(), 'MarketDisabled');
      }

      // The point of §50: winding a market down must never strand escrowed collateral.
      await program.methods
        .exercisePosition()
        .accounts({
          taker: taker.publicKey,
          position: live.position,
          positionAuthority: live.authority,
          maker: maker.publicKey,
          stockMint,
          quoteMint,
          quoteVault: live.quoteVault,
          stockVault: live.stockVault,
          takerQuoteAccount: takerQuote,
          makerStockAccount: getAssociatedTokenAddressSync(stockMint, maker.publicKey, false, TOKEN_2022_PROGRAM_ID),
          stockTokenProgram: TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([taker])
        .rpc();

      const pos = await program.account.position.fetch(live.position);
      assert.deepEqual(pos.status, { exercised: {} }, 'a disabled market must not block settlement');

      await program.methods
        .setMarketEnabled(true, true)
        .accounts({ admin: admin.publicKey, config: configPda, market: marketPda })
        .rpc();
    });

    it('refuses a non-admin', async () => {
      try {
        await program.methods
          .setMarketEnabled(false, false)
          .accounts({ admin: maker.publicKey, config: configPda, market: marketPda })
          .signers([maker])
          .rpc();
        assert.fail('should have rejected');
      } catch (e: any) {
        assert.match(e.toString(), /Unauthorized|has_one|ConstraintHasOne/);
      }
    });
  });

  /**
   * Every real PreStocks mint carries the TransferHook extension with no program set, and the
   * issuer can set one at any time. These mints reproduce both states.
   */
  describe('transfer hook guard', () => {
    const SOME_HOOK_PROGRAM = Keypair.generate().publicKey;

    async function hookMint(hookProgram: PublicKey) {
      const kp = Keypair.generate();
      const len = getMintLen([ExtensionType.TransferHook]);
      const lamports = await connection.getMinimumBalanceForRentExemption(len);
      await provider.sendAndConfirm(
        new anchor.web3.Transaction().add(
          SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: kp.publicKey, space: len, lamports, programId: TOKEN_2022_PROGRAM_ID }),
          createInitializeTransferHookInstruction(kp.publicKey, admin.publicKey, hookProgram, TOKEN_2022_PROGRAM_ID),
          createInitializeMintInstruction(kp.publicKey, STOCK_DECIMALS, admin.publicKey, null, TOKEN_2022_PROGRAM_ID),
        ),
        [kp],
      );
      return kp.publicKey;
    }

    const marketFor = (mint: PublicKey) =>
      PublicKey.findProgramAddressSync([Buffer.from('market'), mint.toBuffer()], program.programId)[0];

    const addMarket = (mint: PublicKey) =>
      program.methods
        .addMarket('HOOKED')
        .accounts({
          admin: admin.publicKey,
          config: configPda,
          market: marketFor(mint),
          stockMint: mint,
          stockTokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

    it('lists a mint whose hook extension is empty, as every PreStock is today', async () => {
      const mint = await hookMint(PublicKey.default);
      await addMarket(mint);
      const market = await program.account.market.fetch(marketFor(mint));
      assert.isTrue(market.enabled);
    });

    it('refuses to list a mint with a hook program set', async () => {
      const mint = await hookMint(SOME_HOOK_PROGRAM);
      try {
        await addMarket(mint);
        assert.fail('should have rejected');
      } catch (e: any) {
        assert.include(e.toString(), 'TransferHookSet');
      }
    });

    it('refuses new commitments once the issuer sets a hook on a listed mint', async () => {
      const mint = await hookMint(PublicKey.default);
      await addMarket(mint);
      await provider.sendAndConfirm(
        new anchor.web3.Transaction().add(
          createUpdateTransferHookInstruction(mint, admin.publicKey, SOME_HOOK_PROGRAM, [], TOKEN_2022_PROGRAM_ID),
        ),
      );

      const nonce = nextNonce();
      const [position] = PublicKey.findProgramAddressSync(
        [Buffer.from('position'), maker.publicKey.toBuffer(), nonce.toArrayLike(Buffer, 'le', 8)],
        program.programId,
      );
      const [authority] = PublicKey.findProgramAddressSync(
        [Buffer.from('position_authority'), position.toBuffer()],
        program.programId,
      );
      try {
        await program.methods
          .createCommitment(nonce, new BN(1000), usd(10), usd(1), new BN(Math.floor(Date.now() / 1000) + 3600), new BN(1))
          .accounts({
            maker: maker.publicKey,
            config: configPda,
            market: marketFor(mint),
            position,
            positionAuthority: authority,
            stockMint: mint,
            quoteMint,
            makerQuoteAccount: makerQuote,
            quoteVault: getAssociatedTokenAddressSync(quoteMint, authority, true, TOKEN_PROGRAM_ID),
            stockVault: getAssociatedTokenAddressSync(mint, authority, true, TOKEN_2022_PROGRAM_ID),
            stockTokenProgram: TOKEN_2022_PROGRAM_ID,
            quoteTokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([maker])
          .rpc();
        assert.fail('should have rejected');
      } catch (e: any) {
        assert.include(e.toString(), 'TransferHookSet');
      }
    });
  });
});
