import { BorshAccountsCoder } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import type { OpenCommitment } from '../../../packages/sdk/src/commitment-curve.ts';
import idl from '../../../target/idl/limit_plus.json';

/**
 * Reading Limit+ positions off-chain.
 *
 * The Commitment Curve is built from chain state alone rather than from an indexer's own
 * record of what each position meant, which is why `target_valuation_usd` rides on the
 * Position account. Anyone can recompute this curve from the chain and get the same answer.
 */

export const PROGRAM_ID = new PublicKey((idl as { address: string }).address);

export const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? 'devnet';
export const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ??
  (CLUSTER === 'localnet' ? 'http://127.0.0.1:8899' : `https://api.${CLUSTER}.solana.com`);

/** Mirrors PositionStatus in the program. */
export const STATUS = ['Open', 'Matched', 'Exercised', 'Expired', 'Cancelled'] as const;
export type Status = (typeof STATUS)[number];

export type Position = {
  pubkey: string;
  maker: string;
  taker: string | null;
  stockMint: string;
  stockRawRequired: bigint;
  stockRawEscrowed: bigint;
  strikeQuoteAmount: bigint;
  strikeQuoteEscrowed: bigint;
  premiumQuoteAmount: bigint;
  expiryTs: number;
  createdAt: number;
  targetValuationUsd: number;
  status: Status;
};

const ZERO = '11111111111111111111111111111111';

function decodeStatus(raw: Record<string, unknown>): Status {
  // Anchor encodes a unit enum as { open: {} } etc.
  const key = Object.keys(raw)[0]?.toLowerCase();
  return (STATUS.find((s) => s.toLowerCase() === key) ?? 'Open') as Status;
}

export function connection(): Connection {
  return new Connection(RPC_URL, 'confirmed');
}

/**
 * Fetch every Position the program owns.
 *
 * Returns an empty list rather than throwing when the program is not deployed on the
 * configured cluster: an empty curve is a truthful answer, and a page that renders nothing
 * is worse than one that says no commitments exist yet.
 */
export async function fetchPositions(conn = connection()): Promise<Position[]> {
  let accounts;
  try {
    const coder = new BorshAccountsCoder(idl as never);
    // Anchor 0.30+ ships each account's discriminator in the IDL rather than deriving it
    // from the name, so read it from there instead of recomputing a hash that might not
    // match what the program actually writes.
    const entry = (idl as { accounts: { name: string; discriminator: number[] }[] }).accounts.find(
      (a) => a.name === 'Position',
    );
    if (!entry) return [];
    accounts = await conn.getProgramAccounts(PROGRAM_ID, {
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: Buffer.from(entry.discriminator).toString('base64'),
            encoding: 'base64',
          },
        },
      ],
    });

    return accounts.map(({ pubkey, account }) => {
      const p = coder.decode('Position', account.data) as Record<string, any>;
      const taker = p.taker.toBase58();
      return {
        pubkey: pubkey.toBase58(),
        maker: p.maker.toBase58(),
        taker: taker === ZERO ? null : taker,
        stockMint: p.stockMint.toBase58(),
        stockRawRequired: BigInt(p.stockRawRequired.toString()),
        stockRawEscrowed: BigInt(p.stockRawEscrowed.toString()),
        strikeQuoteAmount: BigInt(p.strikeQuoteAmount.toString()),
        strikeQuoteEscrowed: BigInt(p.strikeQuoteEscrowed.toString()),
        premiumQuoteAmount: BigInt(p.premiumQuoteAmount.toString()),
        expiryTs: Number(p.expiryTs),
        createdAt: Number(p.createdAt),
        targetValuationUsd: Number(p.targetValuationUsd),
        status: decodeStatus(p.status),
      };
    });
  } catch {
    return [];
  }
}

/** Only Open positions feed the curve: matched capital is no longer bidding. */
export function toOpenCommitments(positions: Position[], stockMint?: string): OpenCommitment[] {
  return positions
    .filter((p) => p.status === 'Open' && (!stockMint || p.stockMint === stockMint))
    .map((p) => ({
      position: p.pubkey,
      maker: p.maker,
      targetValuationUsd: p.targetValuationUsd,
      strikeQuoteEscrowed: p.strikeQuoteEscrowed,
      premiumQuoteAmount: p.premiumQuoteAmount,
      expiryTs: p.expiryTs,
    }));
}
