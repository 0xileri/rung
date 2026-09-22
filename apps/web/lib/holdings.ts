import type { Fill, Position } from './chain';

/**
 * What a wallet actually holds, as rows a person can act on.
 *
 * Chain state has two shapes — a maker's commitment and a taker's claim on part of it — and
 * a commitment can carry several claims at once. Showing raw commitments would make a maker's
 * row mean two different things at once ("$40 matched to someone, $60 still on offer"), and
 * P&L would have nowhere to live. So each row here is exactly one relationship:
 *
 *   - a matched slice: one fill, seen from whichever side the wallet is on;
 *   - an open offer: the part of a maker's commitment nobody has claimed.
 *
 * A maker with two takers therefore sees two matched rows plus, if anything is left, one open
 * row. Every figure on a row belongs to that row alone, which is what lets the P&L add up.
 */

export type HoldingStatus =
  | 'Open'
  | 'PartiallyMatched'
  | 'Matched'
  | 'Exercised'
  | 'Expired'
  | 'Cancelled';

export type Holding = {
  /** Unique per row: the fill, or the commitment for an open row. */
  key: string;
  /** The commitment this row belongs to; every action needs it. */
  pubkey: string;
  fillPubkey: string | null;
  fillIndex: number | null;
  side: 'maker' | 'holder';
  maker: string;
  taker: string | null;
  stockMint: string;
  /** This row's share of the terms, not the whole commitment's. */
  stockRawRequired: bigint;
  stockRawEscrowed: bigint;
  strikeQuoteAmount: bigint;
  strikeQuoteEscrowed: bigint;
  premiumQuoteAmount: bigint;
  feePaid: bigint;
  expiryTs: number;
  createdAt: number;
  matchedAt: number;
  settledAt: number;
  targetValuationUsd: number;
  status: HoldingStatus;
  /** On an open row: how much of the commitment other takers have already claimed. */
  filledQuote: bigint;
  /** On an open row: how many takers are in it. */
  fillCount: number;
};

/** One matched slice, seen from either side. Exported so protocol-wide figures use the same row. */
export function matchedRowFor(p: Position, f: Fill, side: 'maker' | 'holder' = 'maker'): Holding {
  return {
    key: f.pubkey,
    pubkey: p.pubkey,
    fillPubkey: f.pubkey,
    fillIndex: f.index,
    side,
    maker: p.maker,
    taker: f.taker,
    stockMint: p.stockMint,
    stockRawRequired: f.stockRawRequired,
    stockRawEscrowed: f.stockRawEscrowed,
    strikeQuoteAmount: f.strikeQuoteAmount,
    strikeQuoteEscrowed: f.strikeQuoteAmount,
    premiumQuoteAmount: f.premiumPaid,
    feePaid: f.feePaid,
    expiryTs: p.expiryTs,
    createdAt: p.createdAt,
    matchedAt: f.matchedAt,
    settledAt: f.settledAt,
    targetValuationUsd: p.targetValuationUsd,
    status: f.status,
    filledQuote: 0n,
    fillCount: 0,
  };
}

function openRow(p: Position, fills: Fill[]): Holding {
  const claimed = fills.reduce((sum, f) => sum + f.strikeQuoteAmount, 0n);
  // The open part is priced pro rata, the way the program prices a fill against it.
  const premium =
    p.strikeQuoteEscrowed > 0n
      ? (p.premiumQuoteAmount * p.strikeQuoteOpen + p.strikeQuoteEscrowed - 1n) / p.strikeQuoteEscrowed
      : p.premiumQuoteAmount;
  const stock =
    p.strikeQuoteEscrowed > 0n
      ? (p.stockRawRequired * p.strikeQuoteOpen + p.strikeQuoteEscrowed - 1n) / p.strikeQuoteEscrowed
      : p.stockRawRequired;
  return {
    key: p.pubkey,
    pubkey: p.pubkey,
    fillPubkey: null,
    fillIndex: null,
    side: 'maker',
    maker: p.maker,
    taker: null,
    stockMint: p.stockMint,
    stockRawRequired: stock,
    stockRawEscrowed: 0n,
    strikeQuoteAmount: p.strikeQuoteOpen,
    strikeQuoteEscrowed: p.strikeQuoteOpen,
    premiumQuoteAmount: premium,
    feePaid: 0n,
    expiryTs: p.expiryTs,
    createdAt: p.createdAt,
    matchedAt: 0,
    settledAt: p.status === 'Cancelled' ? p.settledAt : 0,
    targetValuationUsd: p.targetValuationUsd,
    status: p.status === 'Cancelled' ? 'Cancelled' : fills.length > 0 ? 'PartiallyMatched' : 'Open',
    filledQuote: claimed,
    fillCount: fills.length,
  };
}

/**
 * Every row belonging to one wallet, newest first.
 *
 * A maker sees each slice someone took from them, plus whatever is still on offer. A holder
 * sees the slices they took. A wallet that is both sees both, and the two never share a row.
 */
export function holdingsFor(positions: Position[], fills: Fill[], wallet: string): Holding[] {
  const byPosition = new Map<string, Position>(positions.map((p) => [p.pubkey, p]));
  const rows: Holding[] = [];

  for (const f of fills) {
    const p = byPosition.get(f.position);
    if (!p) continue;
    if (f.taker === wallet) rows.push(matchedRowFor(p, f, 'holder'));
    if (p.maker === wallet) rows.push(matchedRowFor(p, f, 'maker'));
  }

  for (const p of positions) {
    if (p.maker !== wallet) continue;
    const mine = fills.filter((f) => f.position === p.pubkey);
    // An open row exists while capital is still on offer, and once more after a cancel, so a
    // maker can see that their commitment ended rather than having it silently vanish.
    if (p.strikeQuoteOpen > 0n || p.status === 'Cancelled') rows.push(openRow(p, mine));
  }

  return rows.sort((a, b) => b.createdAt - a.createdAt || (b.fillIndex ?? -1) - (a.fillIndex ?? -1));
}

/** A row is settled when nothing more can happen to it. */
export const isSettled = (h: Holding) =>
  h.status === 'Exercised' || h.status === 'Expired' || h.status === 'Cancelled';
