/**
 * Capital over time, rebuilt from chain accounts alone.
 *
 * Every figure here is a step function, because capital only ever moves at a moment someone
 * signs something (or a deadline passes): a commitment lands, a slice is taken, a claim is
 * exercised, the maker withdraws. Between those moments nothing changes, and a smooth line
 * would invent values that never existed.
 *
 * Two things are measured, and they are deliberately different questions:
 *
 *   offered   — capital a holder could take right now. It arrives when a commitment is
 *               created, and leaves when a slice is taken, when the maker withdraws the rest,
 *               or when the deadline passes, whichever comes first. Capital left in a vault
 *               after its deadline is not on offer: nobody can take it.
 *   inForce   — protection that is running. A slice enters when it is taken and ends when it
 *               is exercised, or at the deadline. A claim expired but not yet settled is no
 *               longer protection, even though its collateral is still waiting in the vault.
 *
 * Plus two running totals: capital ever matched, and premium ever paid by holders.
 *
 * No indexer and no event history are involved, which is the point: anyone can recompute
 * this from the same accounts and get the same line. That depends on the program recording
 * each transition's time — it is why Position carries `withdrawn_at`.
 */

export type CapitalCommitment = {
  position: string;
  /** USDC measured into the vault at creation. */
  strikeQuoteEscrowed: bigint;
  createdAt: number;
  expiryTs: number;
  /** When the maker withdrew the open remainder, or 0 if never. */
  withdrawnAt: number;
};

export type CapitalFill = {
  position: string;
  strikeQuoteAmount: bigint;
  premiumPaid: bigint;
  matchedAt: number;
  settledAt: number;
  status: 'Matched' | 'Exercised' | 'Expired';
};

export type CapitalPoint = {
  /** Unix seconds. The values hold from here until the next point. */
  t: number;
  offered: bigint;
  inForce: bigint;
  /** Capital matched to date. */
  matched: bigint;
  /** Premium paid by holders to date, before the protocol's cut. */
  premium: bigint;
};

type Delta = { offered?: bigint; inForce?: bigint; matched?: bigint; premium?: bigint };

/**
 * The series, one point per moment something changed, then a closing point at `now` so the
 * line reaches the present. Empty when there is nothing to show.
 */
export function capitalSeries(
  commitments: CapitalCommitment[],
  fills: CapitalFill[],
  now: number,
): CapitalPoint[] {
  const events: { t: number; d: Delta }[] = [];
  const at = (t: number, d: Delta) => {
    // Future events have not happened. Only deadlines can be in the future here, and a
    // deadline that has not passed changes nothing yet.
    if (t <= now) events.push({ t, d });
  };

  const fillsOf = new Map<string, CapitalFill[]>();
  for (const f of fills) {
    const list = fillsOf.get(f.position) ?? [];
    list.push(f);
    fillsOf.set(f.position, list);
  }

  for (const c of commitments) {
    at(c.createdAt, { offered: c.strikeQuoteEscrowed });
    const mine = fillsOf.get(c.position) ?? [];
    let taken = 0n;
    for (const f of mine) {
      taken += f.strikeQuoteAmount;
      at(f.matchedAt, {
        offered: -f.strikeQuoteAmount,
        inForce: f.strikeQuoteAmount,
        matched: f.strikeQuoteAmount,
        premium: f.premiumPaid,
      });
      // Exercise ends protection early; otherwise it runs to the deadline, whenever (or
      // whether) anyone gets round to settling the collateral afterwards.
      const endsAt = f.status === 'Exercised' && f.settledAt > 0 ? f.settledAt : c.expiryTs;
      at(endsAt, { inForce: -f.strikeQuoteAmount });
    }
    // Whatever nobody took leaves the book at the withdrawal or the deadline, whichever came
    // first. After either, no one can take it, and there is nothing else it can do.
    const residual = c.strikeQuoteEscrowed - taken;
    if (residual > 0n) {
      const leaves = c.withdrawnAt > 0 ? Math.min(c.withdrawnAt, c.expiryTs) : c.expiryTs;
      at(leaves, { offered: -residual });
    }
  }

  if (events.length === 0) return [];
  events.sort((a, b) => a.t - b.t);

  const points: CapitalPoint[] = [];
  let offered = 0n;
  let inForce = 0n;
  let matched = 0n;
  let premium = 0n;
  for (const { t, d } of events) {
    offered += d.offered ?? 0n;
    inForce += d.inForce ?? 0n;
    matched += d.matched ?? 0n;
    premium += d.premium ?? 0n;
    const point = { t, offered, inForce, matched, premium };
    // Several things in one second (a sweep takes several slices at once) are one step.
    if (points.length && points[points.length - 1].t === t) points[points.length - 1] = point;
    else points.push(point);
  }
  const last = points[points.length - 1];
  if (last.t < now) points.push({ ...last, t: now });
  return points;
}

/** The value in force at `t`: the last point at or before it, or zero before the first. */
export function capitalAt(series: CapitalPoint[], t: number): CapitalPoint {
  let found: CapitalPoint | null = null;
  for (const p of series) {
    if (p.t > t) break;
    found = p;
  }
  return found ?? { t, offered: 0n, inForce: 0n, matched: 0n, premium: 0n };
}
