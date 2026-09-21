/**
 * Send-and-confirm helpers for every Rung instruction, shared by the mainnet-fork test and
 * the devnet smoke test so both drive the program through identical account lists.
 *
 * Account lists mirror apps/web/lib/program.ts. The web builders cannot be imported here
 * directly (they rely on the bundler for JSON and extensionless imports), so if an
 * instruction's accounts change, both places change together.
 */
import { BN, type Program } from '@coral-xyz/anchor';
import { type Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

export type Parties = { maker: Keypair; taker: Keypair; cranker: Keypair };
export type Handle = {
  mint: PublicKey;
  position: PublicKey;
  authority: PublicKey;
  quoteVault: PublicKey;
  stockVault: PublicKey;
  /** In the cluster's clock, which is what the program compares against. */
  expiryTs: number;
};

export const usd = (n: number) => new BN(Math.round(n * 1e6));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function rungFlows(program: Program, usdc: PublicKey, { maker, taker, cranker }: Parties) {
  const conn = program.provider.connection;
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const configPda = pda([Buffer.from('config')]);
  const marketPda = (mint: PublicKey) => pda([Buffer.from('market'), mint.toBuffer()]);
  const ata = (mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
  const balance = async (address: PublicKey, tokenProgram: PublicKey) => {
    try {
      return (await getAccount(conn, address, 'confirmed', tokenProgram)).amount;
    } catch (e) {
      // An account that does not exist yet holds nothing; anything else is a real failure.
      if (e instanceof Error && e.name === 'TokenAccountNotFoundError') return 0n;
      throw e;
    }
  };
  const usdcOf = (owner: PublicKey) => ata(usdc, owner, TOKEN_PROGRAM_ID);
  const stockOf = (mint: PublicKey, owner: PublicKey) => ata(mint, owner, TOKEN_2022_PROGRAM_ID);

  /**
   * The cluster's own unix time, from the Clock sysvar. The program measures expiry against
   * this, not against whatever the local machine thinks, and devnet's clock drifts from wall
   * time by seconds -- enough to turn a 62-second expiry into one under the 60-second minimum.
   */
  async function clusterNow(): Promise<number> {
    const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
    if (!info) throw new Error('Clock sysvar unavailable');
    // Clock: slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64.
    return Number(info.data.readBigInt64LE(32));
  }

  /** Wait until the cluster's clock has passed `ts`. */
  async function waitForClusterTime(ts: number) {
    for (;;) {
      const now = await clusterNow();
      if (now > ts) return;
      await sleep(Math.min(10_000, (ts - now + 1) * 1000));
    }
  }

  let nonceCounter = BigInt(Date.now());

  async function create(
    mint: PublicKey,
    stockRaw: bigint,
    strike: BN,
    premium: BN,
    expiryOffsetSecs: number,
    targetValuationUsd = 1,
  ): Promise<Handle> {
    const nonce = new BN((++nonceCounter).toString());
    const position = pda([Buffer.from('position'), maker.publicKey.toBuffer(), nonce.toArrayLike(Buffer, 'le', 8)]);
    const authority = pda([Buffer.from('position_authority'), position.toBuffer()]);
    const expiryTs = (await clusterNow()) + expiryOffsetSecs;
    const h = {
      mint,
      position,
      authority,
      quoteVault: ata(usdc, authority, TOKEN_PROGRAM_ID),
      stockVault: ata(mint, authority, TOKEN_2022_PROGRAM_ID),
      expiryTs,
    };
    await program.methods
      .createCommitment(
        nonce,
        new BN(stockRaw.toString()),
        strike,
        premium,
        new BN(expiryTs),
        new BN(Math.round(targetValuationUsd).toString()),
      )
      .accounts({
        maker: maker.publicKey,
        config: configPda,
        market: marketPda(mint),
        position,
        positionAuthority: authority,
        stockMint: mint,
        quoteMint: usdc,
        makerQuoteAccount: usdcOf(maker.publicKey),
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

  /** `as` overrides who takes the position, and with which USDC account, for refusal tests. */
  const accept = (h: Handle, send: bigint, as?: { signer: Keypair; quoteAccount: PublicKey }) =>
    program.methods
      .acceptCommitment(new BN(send.toString()))
      .accounts({
        taker: (as?.signer ?? taker).publicKey,
        config: configPda,
        market: marketPda(h.mint),
        position: h.position,
        positionAuthority: h.authority,
        stockMint: h.mint,
        quoteMint: usdc,
        takerStockAccount: stockOf(h.mint, (as?.signer ?? taker).publicKey),
        takerQuoteAccount: as?.quoteAccount ?? usdcOf(taker.publicKey),
        makerQuoteAccount: usdcOf(maker.publicKey),
        stockVault: h.stockVault,
        stockTokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([as?.signer ?? taker])
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
        takerQuoteAccount: usdcOf(taker.publicKey),
        makerStockAccount: stockOf(h.mint, maker.publicKey),
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
        makerQuoteAccount: usdcOf(maker.publicKey),
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
        makerQuoteAccount: usdcOf(maker.publicKey),
        takerStockAccount: stockOf(h.mint, taker.publicKey),
        stockTokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([cranker])
      .rpc();

  /** Wait for the cluster's clock to pass the position's expiry, then crank it. */
  async function expireWhenDue(h: Handle) {
    await waitForClusterTime(h.expiryTs);
    return expire(h);
  }

  return { configPda, marketPda, balance, usdcOf, stockOf, clusterNow, create, accept, exercise, cancel, expire, expireWhenDue };
}

export function checker() {
  let failures = 0;
  const check = (ok: boolean, label: string) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) failures++;
  };
  const expectError = async (label: string, name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      check(false, `${label} (was accepted)`);
    } catch (e) {
      const ok = String(e).includes(name);
      check(ok, `${label} -> ${name}`);
      if (!ok) console.log(`       ${String(e).slice(0, 400)}`);
    }
  };
  return { check, expectError, failures: () => failures };
}
