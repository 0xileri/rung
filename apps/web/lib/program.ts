import { AnchorProvider, BN, Program, type Idl } from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PublicKey, SystemProgram, type Connection } from '@solana/web3.js';
import idl from '../../../packages/sdk/idl/rung.json';
import { PROGRAM_ID } from './chain';

/**
 * Building the create_commitment transaction.
 *
 * Nothing about the token setup is hardcoded. The quote mint, both token programs and the
 * stock mint are all read from the GlobalConfig and Market accounts the admin created,
 * because those accounts are the protocol's own allowlist: if this file guessed instead, a
 * transaction could be built against a mint the program will refuse, and the user would pay
 * a fee to learn that.
 */

export const CONFIG_SEED = Buffer.from('config');
export const MARKET_SEED = Buffer.from('market');
export const POSITION_SEED = Buffer.from('position');
export const POSITION_AUTHORITY_SEED = Buffer.from('position_authority');

export function deriveConfig(): PublicKey {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID)[0];
}

export function deriveMarket(stockMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([MARKET_SEED, stockMint.toBuffer()], PROGRAM_ID)[0];
}

/** Derived from maker + nonce rather than a global counter, so creates never contend. */
export function derivePosition(maker: PublicKey, nonce: bigint): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(nonce);
  return PublicKey.findProgramAddressSync([POSITION_SEED, maker.toBuffer(), buf], PROGRAM_ID)[0];
}

export function derivePositionAuthority(position: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [POSITION_AUTHORITY_SEED, position.toBuffer()],
    PROGRAM_ID,
  )[0];
}

/** A random u64. Collisions would only self-collide, since the PDA includes the maker. */
export function randomNonce(): bigint {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return new DataView(b.buffer).getBigUint64(0, true);
}

export function getProgram(connection: Connection, wallet: AnchorProvider['wallet']): Program {
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  return new Program(idl as Idl, provider);
}

export type ProtocolAccounts = {
  quoteMint: PublicKey;
  quoteTokenProgram: PublicKey;
  stockMint: PublicKey;
  stockTokenProgram: PublicKey;
  marketEnabled: boolean;
  paused: boolean;
};

/**
 * Why a market could not be loaded.
 *
 * Distinguishing these matters more than it looks. Collapsing them into a single null made
 * the UI report "this PreStock is not allowlisted" for a transient RPC error, for a program
 * that was not deployed, and for a load that simply had not finished yet -- three wrong
 * answers and one right one, all wearing the same words.
 */
export type ProtocolLoadResult =
  | { ok: true; accounts: ProtocolAccounts }
  | { ok: false; reason: 'no-program' | 'no-config' | 'no-market' | 'rpc'; detail: string };

const notFound = (e: unknown) =>
  /Account does not exist|could not find|AccountNotFound/i.test(
    e instanceof Error ? e.message : String(e),
  );

/**
 * Read the protocol's own view of a market.
 *
 * Also returns the two gate flags so the UI can explain *why* a commitment is unavailable
 * rather than letting the transaction fail with a program error the user has to decode.
 */
export async function loadProtocolAccounts(
  program: Program,
  stockMint: PublicKey,
): Promise<ProtocolLoadResult> {
  const conn = program.provider.connection;

  try {
    const prog = await conn.getAccountInfo(PROGRAM_ID);
    if (!prog?.executable) {
      return { ok: false, reason: 'no-program', detail: `Program ${PROGRAM_ID.toBase58()} is not deployed on this cluster.` };
    }
  } catch (e) {
    return { ok: false, reason: 'rpc', detail: e instanceof Error ? e.message : String(e) };
  }

  let config;
  try {
    config = (await (program.account as any).globalConfig.fetch(deriveConfig())) as {
      quoteMint: PublicKey;
      quoteTokenProgram: PublicKey;
      paused: boolean;
    };
  } catch (e) {
    return notFound(e)
      ? { ok: false, reason: 'no-config', detail: 'The protocol config has not been initialized on this cluster.' }
      : { ok: false, reason: 'rpc', detail: e instanceof Error ? e.message : String(e) };
  }

  let market;
  try {
    market = (await (program.account as any).market.fetch(deriveMarket(stockMint))) as {
      stockMint: PublicKey;
      tokenProgram: PublicKey;
      enabled: boolean;
    };
  } catch (e) {
    return notFound(e)
      ? { ok: false, reason: 'no-market', detail: `${stockMint.toBase58()} is not allowlisted on this deployment.` }
      : { ok: false, reason: 'rpc', detail: e instanceof Error ? e.message : String(e) };
  }

  return {
    ok: true,
    accounts: {
      quoteMint: config.quoteMint,
      quoteTokenProgram: config.quoteTokenProgram,
      stockMint: market.stockMint,
      stockTokenProgram: market.tokenProgram,
      marketEnabled: market.enabled,
      paused: config.paused,
    },
  };
}

export type CreateCommitmentArgs = {
  maker: PublicKey;
  accounts: ProtocolAccounts;
  /** Settlement quantity in raw base units — already multiplier-corrected by the SDK. */
  stockRawRequired: bigint;
  /** USDC strike in base units. */
  strikeQuoteAmount: bigint;
  premiumQuoteAmount: bigint;
  expiryTs: number;
  /** Metadata only; the program never consults it when settling. */
  targetValuationUsd: bigint;
};

export async function buildCreateCommitment(program: Program, args: CreateCommitmentArgs) {
  const nonce = randomNonce();
  const position = derivePosition(args.maker, nonce);
  const authority = derivePositionAuthority(position);
  const { quoteMint, quoteTokenProgram, stockMint, stockTokenProgram } = args.accounts;

  const instruction = await program.methods
    .createCommitment(
      new BN(nonce.toString()),
      new BN(args.stockRawRequired.toString()),
      new BN(args.strikeQuoteAmount.toString()),
      new BN(args.premiumQuoteAmount.toString()),
      new BN(args.expiryTs),
      new BN(args.targetValuationUsd.toString()),
    )
    .accounts({
      maker: args.maker,
      config: deriveConfig(),
      market: deriveMarket(stockMint),
      position,
      positionAuthority: authority,
      stockMint,
      quoteMint,
      makerQuoteAccount: getAssociatedTokenAddressSync(
        quoteMint,
        args.maker,
        false,
        quoteTokenProgram,
      ),
      // allowOwnerOffCurve, because the vault authority is a PDA.
      quoteVault: getAssociatedTokenAddressSync(quoteMint, authority, true, quoteTokenProgram),
      stockVault: getAssociatedTokenAddressSync(stockMint, authority, true, stockTokenProgram),
      stockTokenProgram,
      quoteTokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { instruction, position, nonce };
}

/**
 * Turn a program error into something a person can act on.
 *
 * Anchor surfaces custom errors as hex codes buried in simulation logs; showing that raw is
 * how a user ends up stuck. The named variants map to the reason the program refused.
 */
export function explainError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const named: Record<string, string> = {
    MarketDisabled: 'This market is not accepting new commitments right now.',
    GlobalPause: 'The protocol is paused for new commitments.',
    InvalidExpiry: 'That expiry is outside the allowed range.',
    InvalidAmount: 'Amount must be greater than zero.',
    InsufficientCollateral: 'Your USDC transfer did not cover the strike. Try re-quoting.',
    InvalidQuoteMint: 'That is not the settlement currency this protocol uses.',
    InvalidMarket: 'This PreStock is not allowlisted for new commitments.',
    MarketAcceptDisabled: 'This market is no longer accepting new matches.',
    InvalidState: 'This position has already been taken, settled or cancelled.',
    Unauthorized: 'Only the protection holder can exercise this position.',
    PositionExpired: 'This position has passed its expiry and can no longer be exercised.',
    PositionNotExpired: 'This position has not reached its expiry yet.',
    InvalidStockMint: 'The PreStock mint does not match this position.',
  };
  for (const [key, message] of Object.entries(named)) {
    if (text.includes(key)) return message;
  }
  if (/insufficient (lamports|funds)/i.test(text)) {
    return 'Not enough SOL, USDC or PreStock in your wallet to cover this.';
  }
  if (/could not find account|AccountNotInitialized/i.test(text)) {
    return 'A required token account does not exist yet in your wallet.';
  }
  if (/User rejected|rejected the request/i.test(text)) return 'You cancelled the transaction.';
  return text.split('\n')[0].slice(0, 200);
}

/* ------------------------------------------------------------------ taker side */

export type AcceptArgs = {
  taker: PublicKey;
  position: PublicKey;
  maker: PublicKey;
  accounts: ProtocolAccounts;
  /** What LEAVES the taker's account — grossed up so the vault clears the floor. */
  stockRawToSend: bigint;
};

/**
 * Take the other side: lock stock, pay the premium, start the protection term.
 *
 * `stockRawToSend` must be sized with `grossUpForRequired` against
 * `worstCaseTransferFee`, not against the live fee. The program checks what the vault
 * actually RECEIVED against the maker's floor, and sizing for the currently-active slot
 * fails the moment the mint's fee schedule steps at an epoch boundary.
 */
export async function buildAcceptCommitment(program: Program, args: AcceptArgs) {
  const authority = derivePositionAuthority(args.position);
  const { quoteMint, quoteTokenProgram, stockMint, stockTokenProgram } = args.accounts;

  return program.methods
    .acceptCommitment(new BN(args.stockRawToSend.toString()))
    .accounts({
      taker: args.taker,
      config: deriveConfig(),
      market: deriveMarket(stockMint),
      position: args.position,
      positionAuthority: authority,
      stockMint,
      quoteMint,
      takerStockAccount: getAssociatedTokenAddressSync(stockMint, args.taker, false, stockTokenProgram),
      takerQuoteAccount: getAssociatedTokenAddressSync(quoteMint, args.taker, false, quoteTokenProgram),
      makerQuoteAccount: getAssociatedTokenAddressSync(quoteMint, args.maker, false, quoteTokenProgram),
      stockVault: getAssociatedTokenAddressSync(stockMint, authority, true, stockTokenProgram),
      stockTokenProgram,
      quoteTokenProgram,
    })
    .instruction();
}

/** Exercise: swap the escrowed stock for the escrowed USDC. Taker only, before expiry. */
export async function buildExercisePosition(
  program: Program,
  args: { taker: PublicKey; position: PublicKey; maker: PublicKey; accounts: ProtocolAccounts },
) {
  const authority = derivePositionAuthority(args.position);
  const { quoteMint, quoteTokenProgram, stockMint, stockTokenProgram } = args.accounts;

  return program.methods
    .exercisePosition()
    .accounts({
      taker: args.taker,
      position: args.position,
      positionAuthority: authority,
      maker: args.maker,
      stockMint,
      quoteMint,
      quoteVault: getAssociatedTokenAddressSync(quoteMint, authority, true, quoteTokenProgram),
      stockVault: getAssociatedTokenAddressSync(stockMint, authority, true, stockTokenProgram),
      takerQuoteAccount: getAssociatedTokenAddressSync(quoteMint, args.taker, false, quoteTokenProgram),
      makerStockAccount: getAssociatedTokenAddressSync(stockMint, args.maker, false, stockTokenProgram),
      stockTokenProgram,
      quoteTokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** Withdraw an unmatched commitment. Maker only, Open only. */
export async function buildCancelCommitment(
  program: Program,
  args: { maker: PublicKey; position: PublicKey; accounts: ProtocolAccounts },
) {
  const authority = derivePositionAuthority(args.position);
  const { quoteMint, quoteTokenProgram } = args.accounts;

  return program.methods
    .cancelCommitment()
    .accounts({
      maker: args.maker,
      position: args.position,
      positionAuthority: authority,
      quoteMint,
      quoteVault: getAssociatedTokenAddressSync(quoteMint, authority, true, quoteTokenProgram),
      makerQuoteAccount: getAssociatedTokenAddressSync(quoteMint, args.maker, false, quoteTokenProgram),
      quoteTokenProgram,
    })
    .instruction();
}

/**
 * Return both collaterals after expiry. Permissionless, so anyone can crank it —
 * recovering your own collateral must not depend on a counterparty staying reachable.
 */
export async function buildExpirePosition(
  program: Program,
  args: { cranker: PublicKey; position: PublicKey; maker: PublicKey; taker: PublicKey; accounts: ProtocolAccounts },
) {
  const authority = derivePositionAuthority(args.position);
  const { quoteMint, quoteTokenProgram, stockMint, stockTokenProgram } = args.accounts;

  return program.methods
    .expirePosition()
    .accounts({
      cranker: args.cranker,
      position: args.position,
      maker: args.maker,
      taker: args.taker,
      positionAuthority: authority,
      stockMint,
      quoteMint,
      quoteVault: getAssociatedTokenAddressSync(quoteMint, authority, true, quoteTokenProgram),
      stockVault: getAssociatedTokenAddressSync(stockMint, authority, true, stockTokenProgram),
      makerQuoteAccount: getAssociatedTokenAddressSync(quoteMint, args.maker, false, quoteTokenProgram),
      takerStockAccount: getAssociatedTokenAddressSync(stockMint, args.taker, false, stockTokenProgram),
      stockTokenProgram,
      quoteTokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}
