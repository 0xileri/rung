/**
 * Solana Actions (Blinks): the plumbing shared by every action endpoint.
 *
 * An action is two HTTP calls. GET describes it (title, image, buttons) so a Blink client --
 * X with a wallet extension, dial.to, a wallet's own browser -- can draw it; POST receives the
 * clicking wallet's address and answers with an unsigned transaction for that wallet to sign.
 * Clients are strict about CORS and the version headers, so every response carries them.
 *
 * Spec: https://solana.com/docs/advanced/actions
 */
import { AnchorProvider, type Program } from '@coral-xyz/anchor';
import { PublicKey, type Transaction, type VersionedTransaction } from '@solana/web3.js';
import { CLUSTER, connection } from './chain';
import { getProgram } from './program';

/** CAIP-2 ids: which chain an action's transactions are for. */
const CHAIN_IDS: Record<string, string> = {
  devnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  testnet: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
};

export const ACTION_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids',
  'Access-Control-Expose-Headers': 'X-Action-Version, X-Blockchain-Ids',
  'X-Action-Version': '2.4',
  ...(CHAIN_IDS[CLUSTER] ? { 'X-Blockchain-Ids': CHAIN_IDS[CLUSTER] } : {}),
  'Content-Type': 'application/json',
};

export const actionJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: ACTION_HEADERS });

/** The error shape Blink clients show the person: a plain sentence. */
export const actionError = (message: string, status = 400) => actionJson({ message }, status);

export const preflight = () => new Response(null, { status: 204, headers: ACTION_HEADERS });

/** A read-only program handle: the server never signs, it only builds instructions. */
export function readOnlyProgram(): Program {
  const wallet = {
    publicKey: PublicKey.default,
    signTransaction: async <T extends Transaction | VersionedTransaction>(t: T) => t,
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(t: T[]) => t,
  } as unknown as AnchorProvider['wallet'];
  return getProgram(connection(), wallet);
}

export type LivePosition = {
  pubkey: PublicKey;
  maker: PublicKey;
  stockMint: PublicKey;
  strikeQuoteEscrowed: bigint;
  strikeQuoteOpen: bigint;
  stockRawRequired: bigint;
  premiumQuoteAmount: bigint;
  expiryTs: number;
  fillsCreated: number;
  targetValuationUsd: number;
  status: string;
};

/**
 * One commitment, read fresh from chain rather than from the page cache: a transaction built
 * on a ten-second-old fill counter would point at a fill account that already exists.
 */
export async function readPosition(program: Program, pubkey: PublicKey): Promise<LivePosition | null> {
  let raw: Record<string, unknown>;
  try {
    raw = (await (program.account as any).position.fetch(pubkey)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const f = (snake: string, camel: string) => raw[snake] ?? raw[camel];
  const big = (v: unknown) => BigInt(String(v ?? 0));
  const num = (v: unknown) => Number(String(v ?? 0));
  return {
    pubkey,
    maker: f('maker', 'maker') as PublicKey,
    stockMint: f('stock_mint', 'stockMint') as PublicKey,
    strikeQuoteEscrowed: big(f('strike_quote_escrowed', 'strikeQuoteEscrowed')),
    strikeQuoteOpen: big(f('strike_quote_open', 'strikeQuoteOpen')),
    stockRawRequired: big(f('stock_raw_required', 'stockRawRequired')),
    premiumQuoteAmount: big(f('premium_quote_amount', 'premiumQuoteAmount')),
    expiryTs: num(f('expiry_ts', 'expiryTs')),
    fillsCreated: num(f('fills_created', 'fillsCreated')),
    targetValuationUsd: num(f('target_valuation_usd', 'targetValuationUsd')),
    status: Object.keys((f('status', 'status') as object) ?? {})[0]?.toLowerCase() ?? 'open',
  };
}

export const isTakeable = (p: LivePosition, now = Date.now() / 1000) =>
  now <= p.expiryTs && p.strikeQuoteOpen > 0n && (p.status === 'open' || p.status === 'partiallymatched');
