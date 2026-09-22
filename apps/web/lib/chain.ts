import { BorshAccountsCoder } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import type { OpenCommitment } from '../../../packages/sdk/src/commitment-curve.ts';
import idl from '../../../packages/sdk/idl/rung.json';

/**
 * Reading Rung positions off-chain.
 *
 * The Commitment Curve is built from chain state alone rather than from an indexer's own
 * record of what each position meant, which is why `target_valuation_usd` rides on the
 * Position account. Anyone can recompute this curve from the chain and get the same answer.
 */

export const PROGRAM_ID = new PublicKey((idl as { address: string }).address);

export const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? 'devnet';

const PUBLIC_DEVNET = 'https://api.devnet.solana.com';

export const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ??
  (CLUSTER === 'localnet' ? 'http://127.0.0.1:8899' : `https://api.${CLUSTER}.solana.com`);

/**
 * The endpoint server-rendered pages read through. SOLANA_SERVER_RPC_URL is deliberately
 * not NEXT_PUBLIC_: Next inlines only NEXT_PUBLIC_ variables into browser bundles, so a paid
 * endpoint's key can live here without shipping to every visitor. Unset, the server uses the
 * same public endpoint as the browser.
 */
const SERVER_RPC_URL = typeof window === 'undefined' ? process.env.SOLANA_SERVER_RPC_URL : undefined;

/** Mirrors PositionStatus in the program. */
export const STATUS = ['Open', 'PartiallyMatched', 'Matched', 'Settled', 'Cancelled'] as const;
export type Status = (typeof STATUS)[number];

/** Mirrors FillStatus. A settled fill's account is closed, so only Matched is ever read. */
export const FILL_STATUS = ['Matched', 'Exercised', 'Expired'] as const;
export type FillStatus = (typeof FILL_STATUS)[number];

/** A maker's offer of capital at a valuation, and the owner of both vaults. */
export type Position = {
  pubkey: string;
  maker: string;
  stockMint: string;
  stockRawRequired: bigint;
  stockRawEscrowed: bigint;
  strikeQuoteAmount: bigint;
  strikeQuoteEscrowed: bigint;
  /** The part of the escrow no taker has claimed yet. */
  strikeQuoteOpen: bigint;
  premiumQuoteAmount: bigint;
  expiryTs: number;
  createdAt: number;
  /** 0 until the first holder takes a slice. */
  firstMatchedAt: number;
  /** 0 until something settles; the most recent settlement after that. */
  settledAt: number;
  targetValuationUsd: number;
  fillsCreated: number;
  fillsOpen: number;
  status: Status;
};

/** One taker's claim on part of a commitment. */
export type Fill = {
  pubkey: string;
  position: string;
  taker: string;
  index: number;
  strikeQuoteAmount: bigint;
  stockRawRequired: bigint;
  stockRawEscrowed: bigint;
  premiumPaid: bigint;
  feePaid: bigint;
  matchedAt: number;
  settledAt: number;
  status: FillStatus;
};

function decodeStatus(raw: Record<string, unknown>): Status {
  // Anchor encodes a unit enum as { Open: {} } / { open: {} }.
  const key = Object.keys(raw)[0]?.toLowerCase();
  return (STATUS.find((s) => s.toLowerCase() === key) ?? 'Open') as Status;
}

function decodeFillStatus(raw: Record<string, unknown>): FillStatus {
  const key = Object.keys(raw)[0]?.toLowerCase();
  return (FILL_STATUS.find((s) => s.toLowerCase() === key) ?? 'Matched') as FillStatus;
}

export function connection(endpoint = SERVER_RPC_URL ?? RPC_URL): Connection {
  return new Connection(endpoint, 'confirmed');
}

/** Anchor decodes u64/i64 as BN. `Number(bn)` is NaN, which silently poisons every figure. */
function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v !== null && 'toNumber' in v && typeof (v as { toNumber: () => number }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  return Number(String(v));
}

function big(v: unknown): bigint {
  if (v == null) return 0n;
  return BigInt(String(v));
}

/**
 * Anchor 0.30+ IDL field names are snake_case on decode. Older assumptions (and some
 * codegen paths) used camelCase. Read whichever is present.
 */
function field<T = unknown>(p: Record<string, unknown>, snake: string, camel: string): T {
  return (p[snake] ?? p[camel]) as T;
}

export type PositionsResult =
  /** `staleSeconds` is set when a server cache served an older read because a fresh one failed. */
  | { ok: true; positions: Position[]; fills: Fill[]; staleSeconds?: number }
  | { ok: false; detail: string };

function mapDecoded(pubkey: PublicKey, p: Record<string, unknown>): Position {
  const maker = field<{ toBase58(): string }>(p, 'maker', 'maker');
  const stockMint = field<{ toBase58(): string }>(p, 'stock_mint', 'stockMint');
  return {
    pubkey: pubkey.toBase58(),
    maker: maker.toBase58(),
    stockMint: stockMint.toBase58(),
    stockRawRequired: big(field(p, 'stock_raw_required', 'stockRawRequired')),
    stockRawEscrowed: big(field(p, 'stock_raw_escrowed', 'stockRawEscrowed')),
    strikeQuoteAmount: big(field(p, 'strike_quote_amount', 'strikeQuoteAmount')),
    strikeQuoteEscrowed: big(field(p, 'strike_quote_escrowed', 'strikeQuoteEscrowed')),
    strikeQuoteOpen: big(field(p, 'strike_quote_open', 'strikeQuoteOpen')),
    premiumQuoteAmount: big(field(p, 'premium_quote_amount', 'premiumQuoteAmount')),
    expiryTs: num(field(p, 'expiry_ts', 'expiryTs')),
    createdAt: num(field(p, 'created_at', 'createdAt')),
    firstMatchedAt: num(field(p, 'first_matched_at', 'firstMatchedAt')),
    settledAt: num(field(p, 'settled_at', 'settledAt')),
    targetValuationUsd: num(field(p, 'target_valuation_usd', 'targetValuationUsd')),
    fillsCreated: num(field(p, 'fills_created', 'fillsCreated')),
    fillsOpen: num(field(p, 'fills_open', 'fillsOpen')),
    status: decodeStatus(field(p, 'status', 'status') as Record<string, unknown>),
  };
}

function mapFill(pubkey: PublicKey, f: Record<string, unknown>): Fill {
  const position = field<{ toBase58(): string }>(f, 'position', 'position');
  const taker = field<{ toBase58(): string }>(f, 'taker', 'taker');
  return {
    pubkey: pubkey.toBase58(),
    position: position.toBase58(),
    taker: taker.toBase58(),
    index: num(field(f, 'index', 'index')),
    strikeQuoteAmount: big(field(f, 'strike_quote_amount', 'strikeQuoteAmount')),
    stockRawRequired: big(field(f, 'stock_raw_required', 'stockRawRequired')),
    stockRawEscrowed: big(field(f, 'stock_raw_escrowed', 'stockRawEscrowed')),
    premiumPaid: big(field(f, 'premium_paid', 'premiumPaid')),
    feePaid: big(field(f, 'fee_paid', 'feePaid')),
    matchedAt: num(field(f, 'matched_at', 'matchedAt')),
    settledAt: num(field(f, 'settled_at', 'settledAt')),
    status: decodeFillStatus(field(f, 'status', 'status') as Record<string, unknown>),
  };
}

async function getProgramAccountsWithFallback(primary: Connection): Promise<
  | { ok: true; accounts: Awaited<ReturnType<Connection['getProgramAccounts']>>; endpoint: string }
  | { ok: false; detail: string }
> {
  const tryConn = async (conn: Connection, label: string) => {
    try {
      const accounts = await conn.getProgramAccounts(PROGRAM_ID);
      return { ok: true as const, accounts, endpoint: label };
    } catch (e) {
      return {
        ok: false as const,
        detail: `${label}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  };

  const first = await tryConn(primary, primary.rpcEndpoint);
  if (first.ok) return first;

  // Helius (and other paid) endpoints 429 under demo traffic. Public devnet is good enough
  // to read a handful of Position accounts for the curve.
  if (CLUSTER === 'devnet' && !primary.rpcEndpoint.includes('api.devnet.solana.com')) {
    const fallback = await tryConn(connection(PUBLIC_DEVNET), PUBLIC_DEVNET);
    if (fallback.ok) return fallback;
    return {
      ok: false,
      detail: `Could not read program accounts (${first.detail}; fallback ${fallback.detail})`,
    };
  }

  return { ok: false, detail: `Could not read program accounts: ${first.detail}` };
}

/**
 * Fetch every Position the program owns.
 *
 * Deliberately does NOT use a memcmp filter. Passing the discriminator as base64 works under
 * Node but depends on how the browser's Buffer polyfill renders it, and a filter that quietly
 * matches nothing is indistinguishable from having no positions. At this scale the program
 * owns a handful of accounts, so fetching them and comparing the first eight bytes locally is
 * both cheaper to reason about and impossible to get subtly wrong.
 *
 * Errors are RETURNED, not swallowed. A previous version caught everything and returned an
 * empty array, so a decode failure looked exactly like "you have no positions" — which sent
 * two people hunting the wrong problem.
 */
export async function fetchPositions(conn = connection()): Promise<PositionsResult> {
  const accountsIdl = (idl as { accounts: { name: string; discriminator: number[] }[] }).accounts;
  const positionEntry = accountsIdl.find((a) => a.name === 'Position');
  const fillEntry = accountsIdl.find((a) => a.name === 'Fill');
  if (!positionEntry) return { ok: false, detail: 'The IDL has no Position account definition.' };
  if (!fillEntry) return { ok: false, detail: 'The IDL has no Fill account definition.' };

  const loaded = await getProgramAccountsWithFallback(conn);
  if (!loaded.ok) return loaded;

  const coder = new BorshAccountsCoder(idl as never);
  const positions: Position[] = [];
  const fills: Fill[] = [];
  const startsWith = (data: Buffer | Uint8Array, disc: number[]) => {
    if (data.length < 8) return false;
    for (let i = 0; i < 8; i++) if (data[i] !== disc[i]) return false;
    return true;
  };

  // One pass over the program's accounts: a taker's claims and the commitments they belong
  // to arrive in the same read, so the two can never be a block apart.
  for (const { pubkey, account } of loaded.accounts) {
    const data = account.data;
    try {
      if (startsWith(data, positionEntry.discriminator)) {
        positions.push(mapDecoded(pubkey, coder.decode('Position', data) as Record<string, unknown>));
      } else if (startsWith(data, fillEntry.discriminator)) {
        fills.push(mapFill(pubkey, coder.decode('Fill', data) as Record<string, unknown>));
      }
    } catch (e) {
      return {
        ok: false,
        detail: `Failed to decode account ${pubkey.toBase58().slice(0, 8)}…: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  return { ok: true, positions, fills };
}

/**
 * What is still bidding, for the curve.
 *
 * Only the part of each commitment no taker has claimed: capital behind a fill has found its
 * counterparty and is no longer an offer. A partially matched commitment therefore appears at
 * the size still available, which is also the size a holder can actually take.
 *
 * The premium is scaled to match, rounded the way the program rounds it, so a band's
 * premium-to-capital ratio still means what it says once half of a commitment has gone.
 */
export function toOpenCommitments(positions: Position[], stockMint?: string): OpenCommitment[] {
  return positions
    .filter((p) => p.strikeQuoteOpen > 0n && (!stockMint || p.stockMint === stockMint))
    .map((p) => ({
      position: p.pubkey,
      maker: p.maker,
      targetValuationUsd: p.targetValuationUsd,
      strikeQuoteEscrowed: p.strikeQuoteOpen,
      premiumQuoteAmount:
        p.strikeQuoteEscrowed > 0n
          ? (p.premiumQuoteAmount * p.strikeQuoteOpen + p.strikeQuoteEscrowed - 1n) / p.strikeQuoteEscrowed
          : p.premiumQuoteAmount,
      expiryTs: p.expiryTs,
    }));
}

/** Fills belonging to one commitment, oldest first. */
export function fillsFor(fills: Fill[], position: string): Fill[] {
  return fills.filter((f) => f.position === position).sort((a, b) => a.index - b.index);
}
