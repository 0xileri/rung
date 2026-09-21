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
  /** 0 until a holder takes the other side. */
  matchedAt: number;
  /** 0 until exercised, cancelled or expired. */
  settledAt: number;
  targetValuationUsd: number;
  status: Status;
};

const ZERO = '11111111111111111111111111111111';

function decodeStatus(raw: Record<string, unknown>): Status {
  // Anchor encodes a unit enum as { Open: {} } / { open: {} }.
  const key = Object.keys(raw)[0]?.toLowerCase();
  return (STATUS.find((s) => s.toLowerCase() === key) ?? 'Open') as Status;
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
  | { ok: true; positions: Position[]; staleSeconds?: number }
  | { ok: false; detail: string };

function mapDecoded(pubkey: PublicKey, p: Record<string, unknown>): Position {
  const takerPk = field<{ toBase58(): string }>(p, 'taker', 'taker');
  const taker = takerPk.toBase58();
  const maker = field<{ toBase58(): string }>(p, 'maker', 'maker');
  const stockMint = field<{ toBase58(): string }>(p, 'stock_mint', 'stockMint');
  return {
    pubkey: pubkey.toBase58(),
    maker: maker.toBase58(),
    taker: taker === ZERO ? null : taker,
    stockMint: stockMint.toBase58(),
    stockRawRequired: big(field(p, 'stock_raw_required', 'stockRawRequired')),
    stockRawEscrowed: big(field(p, 'stock_raw_escrowed', 'stockRawEscrowed')),
    strikeQuoteAmount: big(field(p, 'strike_quote_amount', 'strikeQuoteAmount')),
    strikeQuoteEscrowed: big(field(p, 'strike_quote_escrowed', 'strikeQuoteEscrowed')),
    premiumQuoteAmount: big(field(p, 'premium_quote_amount', 'premiumQuoteAmount')),
    expiryTs: num(field(p, 'expiry_ts', 'expiryTs')),
    createdAt: num(field(p, 'created_at', 'createdAt')),
    matchedAt: num(field(p, 'matched_at', 'matchedAt')),
    settledAt: num(field(p, 'settled_at', 'settledAt')),
    targetValuationUsd: num(field(p, 'target_valuation_usd', 'targetValuationUsd')),
    status: decodeStatus(field(p, 'status', 'status') as Record<string, unknown>),
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
  const entry = (idl as { accounts: { name: string; discriminator: number[] }[] }).accounts.find(
    (a) => a.name === 'Position',
  );
  if (!entry) return { ok: false, detail: 'The IDL has no Position account definition.' };

  const loaded = await getProgramAccountsWithFallback(conn);
  if (!loaded.ok) return loaded;

  const coder = new BorshAccountsCoder(idl as never);
  const disc = entry.discriminator;
  const positions: Position[] = [];

  for (const { pubkey, account } of loaded.accounts) {
    const data = account.data;
    if (data.length < 8) continue;
    let matches = true;
    for (let i = 0; i < 8; i++) if (data[i] !== disc[i]) { matches = false; break; }
    if (!matches) continue;

    try {
      const p = coder.decode('Position', data) as Record<string, unknown>;
      positions.push(mapDecoded(pubkey, p));
    } catch (e) {
      return {
        ok: false,
        detail: `Failed to decode position ${pubkey.toBase58().slice(0, 8)}…: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  return { ok: true, positions };
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
