import { AnchorProvider, BN, Program, type Idl } from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PublicKey, SystemProgram, type Connection } from '@solana/web3.js';
import idl from '../../../target/idl/limit_plus.json';
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
 * Read the protocol's own view of a market.
 *
 * Also returns the two gate flags so the UI can explain *why* a commitment is unavailable
 * rather than letting the transaction fail with a program error the user has to decode.
 */
export async function loadProtocolAccounts(
  program: Program,
  stockMint: PublicKey,
): Promise<ProtocolAccounts | null> {
  try {
    const config = (await (program.account as any).globalConfig.fetch(deriveConfig())) as {
      quoteMint: PublicKey;
      quoteTokenProgram: PublicKey;
      paused: boolean;
    };
    const market = (await (program.account as any).market.fetch(deriveMarket(stockMint))) as {
      stockMint: PublicKey;
      tokenProgram: PublicKey;
      enabled: boolean;
    };
    return {
      quoteMint: config.quoteMint,
      quoteTokenProgram: config.quoteTokenProgram,
      stockMint: market.stockMint,
      stockTokenProgram: market.tokenProgram,
      marketEnabled: market.enabled,
      paused: config.paused,
    };
  } catch {
    // Program not deployed on this cluster, or this mint is not allowlisted.
    return null;
  }
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
  };
  for (const [key, message] of Object.entries(named)) {
    if (text.includes(key)) return message;
  }
  if (/insufficient (lamports|funds)/i.test(text)) {
    return 'Not enough SOL or USDC in your wallet to cover this commitment.';
  }
  if (/User rejected|rejected the request/i.test(text)) return 'You cancelled the transaction.';
  return text.split('\n')[0].slice(0, 200);
}
