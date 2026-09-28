/**
 * What has happened on the book, most recent first, from chain accounts alone.
 *
 * Every event is a timestamp already stored on a Position or a Fill: a commitment's creation,
 * a slice being taken, exercised or settled, a maker withdrawing what nobody took. Actions that
 * land as several accounts are told as one: a ladder is one commitment per rung, a sweep one
 * fill per floor, a keeper pass one settlement per claim. Those are grouped when the same actor
 * did the same thing on the same asset within a short window, so the feed reads as what people
 * did rather than as how the program stores it.
 */

export type ActivityPosition = {
  pubkey: string;
  maker: string;
  stockMint: string;
  strikeQuoteEscrowed: bigint;
  strikeQuoteOpen: bigint;
  targetValuationUsd: number;
  createdAt: number;
  /** When the maker withdrew the open remainder, or 0. */
  withdrawnAt: number;
};

export type ActivityFill = {
  position: string;
  taker: string;
  strikeQuoteAmount: bigint;
  matchedAt: number;
  settledAt: number;
  status: 'Matched' | 'Exercised' | 'Expired';
};

export type ActivityKind = 'commit' | 'take' | 'exercise' | 'settle' | 'withdraw';

export type ActivityEvent = {
  kind: ActivityKind;
  /** Unix seconds of the most recent item in the group. */
  at: number;
  /** The maker or taker; empty for settlements, which anyone may send. */
  actor: string;
  stockMint: string;
  /** Every position involved, newest first. One entry unless the event is a group. */
  positions: string[];
  /** USDC involved, summed across the group, in raw units. */
  quote: bigint;
  /** Valuations involved, lowest first, without repeats. */
  valuations: number[];
};

/**
 * Items this close together, by the same actor on the same asset, are one action. One approval's
 * transactions are sent one after another and land within a few seconds; two separate decisions
 * by the same person almost never do. A wider window merged a slice and a sweep made twelve
 * seconds apart into one "sweep". A long keeper pass may split into a few lines, which is the
 * honest side to err on.
 */
export const GROUP_WINDOW_SECONDS = 10;

type Item = { kind: ActivityKind; at: number; actor: string; stockMint: string; position: string; quote: bigint; valuation: number };

export function recentActivity(
  positions: ActivityPosition[],
  fills: ActivityFill[],
  limit = 10,
): ActivityEvent[] {
  const byPubkey = new Map(positions.map((p) => [p.pubkey, p]));
  const items: Item[] = [];

  for (const p of positions) {
    if (p.createdAt > 0) {
      items.push({ kind: 'commit', at: p.createdAt, actor: p.maker, stockMint: p.stockMint, position: p.pubkey, quote: p.strikeQuoteEscrowed, valuation: p.targetValuationUsd });
    }
  }
  const takenBy = new Map<string, bigint>();
  for (const f of fills) {
    const p = byPubkey.get(f.position);
    if (!p) continue;
    takenBy.set(f.position, (takenBy.get(f.position) ?? 0n) + f.strikeQuoteAmount);
    const base = { stockMint: p.stockMint, position: p.pubkey, quote: f.strikeQuoteAmount, valuation: p.targetValuationUsd };
    if (f.matchedAt > 0) items.push({ kind: 'take', at: f.matchedAt, actor: f.taker, ...base });
    if (f.status === 'Exercised' && f.settledAt > 0) items.push({ kind: 'exercise', at: f.settledAt, actor: f.taker, ...base });
    if (f.status === 'Expired' && f.settledAt > 0) items.push({ kind: 'settle', at: f.settledAt, actor: '', ...base });
  }
  for (const p of positions) {
    if (p.withdrawnAt <= 0) continue;
    // Escrowed, less what holders took, less what is still offered, is what the maker pulled back.
    const withdrawn = p.strikeQuoteEscrowed - (takenBy.get(p.pubkey) ?? 0n) - p.strikeQuoteOpen;
    if (withdrawn > 0n) {
      items.push({ kind: 'withdraw', at: p.withdrawnAt, actor: p.maker, stockMint: p.stockMint, position: p.pubkey, quote: withdrawn, valuation: p.targetValuationUsd });
    }
  }

  items.sort((a, b) => b.at - a.at);

  const events: ActivityEvent[] = [];
  for (const it of items) {
    const last = events[events.length - 1];
    const joins =
      last &&
      last.kind === it.kind &&
      last.actor === it.actor &&
      last.stockMint === it.stockMint &&
      it.kind !== 'exercise' &&
      // Measured from the group's newest member: a group is one span of time, not a chain of
      // neighbours that could stretch a slow trickle of commitments into one "action".
      last.at - it.at <= GROUP_WINDOW_SECONDS;
    if (joins) {
      if (!last.positions.includes(it.position)) last.positions.push(it.position);
      last.quote += it.quote;
      if (!last.valuations.includes(it.valuation)) last.valuations.push(it.valuation);
      continue;
    }
    if (events.length === limit) break;
    const ev: ActivityEvent = { kind: it.kind, at: it.at, actor: it.actor, stockMint: it.stockMint, positions: [it.position], quote: it.quote, valuations: [it.valuation] };
    events.push(ev);
  }
  for (const e of events) e.valuations.sort((a, b) => a - b);
  return events;
}

