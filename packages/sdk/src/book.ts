/**
 * A maker's book: every commitment they have made, what has happened to it, and what it
 * has earned.
 *
 * Each figure is derived from chain accounts alone, and each one answers a question a maker
 * actually has. Of what I committed, how much did holders take? How much is still offered,
 * and how much did I pull back? What did the premium pay me, after the protocol's cut? Which
 * of my positions have expired and are waiting for someone to settle them, so my USDC comes
 * home?
 *
 * Nothing here prices anything. The premium yield is premium received over capital matched —
 * arithmetic on what already changed hands, not a model of what an option is worth.
 */

export type BookCommitment = {
  position: string;
  stockMint: string;
  targetValuationUsd: number;
  /** USDC measured into the vault at creation. */
  strikeQuoteEscrowed: bigint;
  /** The part no taker has claimed and the maker has not withdrawn. */
  strikeQuoteOpen: bigint;
  premiumQuoteAmount: bigint;
  expiryTs: number;
  createdAt: number;
};

export type BookFillStatus = 'Matched' | 'Exercised' | 'Expired';

export type BookFill = {
  fill: string;
  position: string;
  taker: string;
  index: number;
  strikeQuoteAmount: bigint;
  premiumPaid: bigint;
  feePaid: bigint;
  matchedAt: number;
  settledAt: number;
  status: BookFillStatus;
};

export type BookLine = {
  commitment: BookCommitment;
  /** Oldest first. */
  fills: BookFill[];
  /** Everything holders have ever claimed from this commitment. */
  taken: bigint;
  /** Claimed and still running: capital at risk until the deadline. */
  live: bigint;
  /**
   * Claimed, past the deadline and not yet settled. No longer at risk -- the holder can no
   * longer exercise -- just waiting for anyone to send it home.
   */
  due: bigint;
  /** Still on offer. */
  open: bigint;
  /** Offered once, then withdrawn by the maker. */
  withdrawn: bigint;
  /** Premium that reached the maker, after the protocol's cut. */
  premiumNet: bigint;
  feePaid: bigint;
  /** USDC paid out to holders who exercised: the maker bought tokens with it. */
  exercisedQuote: bigint;
  /** Past its deadline. */
  expired: boolean;
  /** Expired fills nobody has settled yet. Anyone may settle them, the maker included. */
  settleable: BookFill[];
  /** Something can still happen here: capital on offer, or a claim still running. */
  active: boolean;
};

export type BookSummary = {
  commitments: number;
  active: number;
  /** Capital in escrow right now: still offered, still at risk, or waiting to come home. */
  onBook: bigint;
  live: bigint;
  due: bigint;
  open: bigint;
  taken: bigint;
  premiumNet: bigint;
  feePaid: bigint;
  /** Net premium over capital ever matched, or null before the first match. */
  premiumYield: number | null;
  /** Strike-weighted average term from match to expiry, in days, or null. */
  avgTermDays: number | null;
  takers: number;
  /** The soonest deadline among active commitments, or null. */
  nextExpiry: number | null;
  settleable: number;
};

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

export function bookLine(commitment: BookCommitment, fills: BookFill[], now: number): BookLine {
  const mine = fills
    .filter((f) => f.position === commitment.position)
    .sort((a, b) => a.index - b.index);
  const taken = sum(mine.map((f) => f.strikeQuoteAmount));
  const unsettled = mine.filter((f) => f.status === 'Matched');
  const unsettledQuote = sum(unsettled.map((f) => f.strikeQuoteAmount));
  const open = commitment.strikeQuoteOpen;
  // What was escrowed and is neither claimed nor still offered can only have been withdrawn.
  const withdrawn = commitment.strikeQuoteEscrowed - taken - open;
  // The program refuses an exercise after the deadline, so an unsettled claim past it is no
  // longer running: it is owed back, and anyone may settle it.
  const expired = now > commitment.expiryTs;
  const settleable = expired ? unsettled : [];

  return {
    commitment,
    fills: mine,
    taken,
    live: expired ? 0n : unsettledQuote,
    due: expired ? unsettledQuote : 0n,
    open,
    withdrawn: withdrawn > 0n ? withdrawn : 0n,
    premiumNet: sum(mine.map((f) => f.premiumPaid - f.feePaid)),
    feePaid: sum(mine.map((f) => f.feePaid)),
    exercisedQuote: sum(mine.filter((f) => f.status === 'Exercised').map((f) => f.strikeQuoteAmount)),
    expired,
    settleable,
    active: open > 0n || unsettledQuote > 0n,
  };
}

/**
 * Every commitment a maker has, active ones first and soonest deadline first within them,
 * then the finished ones newest first.
 */
export function buildBook(commitments: BookCommitment[], fills: BookFill[], now: number): BookLine[] {
  return commitments
    .map((c) => bookLine(c, fills, now))
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.active
        ? a.commitment.expiryTs - b.commitment.expiryTs
        : b.commitment.createdAt - a.commitment.createdAt;
    });
}

export function summarizeBook(lines: BookLine[]): BookSummary {
  const all = lines.flatMap((l) => l.fills);
  const taken = sum(lines.map((l) => l.taken));
  const premiumNet = sum(lines.map((l) => l.premiumNet));
  const live = sum(lines.map((l) => l.live));
  const due = sum(lines.map((l) => l.due));
  const open = sum(lines.map((l) => l.open));

  // Each fill's term runs from its own match to the commitment's deadline, weighted by how
  // much capital it tied up, so one small late fill does not pull the average around.
  const expiryOf = new Map(lines.map((l) => [l.commitment.position, l.commitment.expiryTs]));
  let weighted = 0;
  let weight = 0;
  for (const f of all) {
    const expiry = expiryOf.get(f.position);
    if (expiry === undefined || f.matchedAt <= 0) continue;
    const w = Number(f.strikeQuoteAmount);
    weighted += w * Math.max(0, expiry - f.matchedAt);
    weight += w;
  }

  // Past deadlines are not "next": an expired line with capital still on it is waiting to be
  // withdrawn or settled, which `settleable` and `open` already say.
  const activeExpiries = lines.filter((l) => l.active && !l.expired).map((l) => l.commitment.expiryTs);

  return {
    commitments: lines.length,
    active: lines.filter((l) => l.active).length,
    onBook: live + due + open,
    live,
    due,
    open,
    taken,
    premiumNet,
    feePaid: sum(lines.map((l) => l.feePaid)),
    premiumYield: taken > 0n ? Number(premiumNet) / Number(taken) : null,
    avgTermDays: weight > 0 ? weighted / weight / 86_400 : null,
    takers: new Set(all.map((f) => f.taker)).size,
    nextExpiry: activeExpiries.length ? Math.min(...activeExpiries) : null,
    settleable: lines.reduce((n, l) => n + l.settleable.length, 0),
  };
}
