/**
 * Laddering a commitment across valuations.
 *
 * A maker rarely has one number in mind. "I'd own OpenAI at a trillion, and more of it the
 * cheaper it gets" is a curve, and expressing it one commitment at a time is exactly the
 * friction that keeps a book thin. A ladder splits one amount across a range of valuations
 * in one go, each rung an ordinary commitment on chain.
 *
 * The split is in whole cents, sums to the requested total exactly, and respects the two
 * limits every commitment already lives under: nothing below a usable minimum, nothing above
 * the per-position cap.
 */

export type LadderShape = 'even' | 'lower-heavy';

export type LadderRung = {
  /** Target company valuation, in whole USD. */
  valuationUsd: number;
  /** USDC for this rung, in base units (6 decimals). */
  strikeQuote: bigint;
};

export type LadderResult =
  | { ok: true; rungs: LadderRung[] }
  | { ok: false; reason: 'no-bands' | 'below-minimum' | 'above-cap' | 'too-many-rungs'; detail: string };

const CENT = 10_000n; // base units per cent, at 6 decimals

/**
 * Split `totalQuote` across every band from `lowUsd` to `highUsd` inclusive, lowest first.
 *
 * `even` gives each rung the same; `lower-heavy` weights them n, n-1, … 1 from the lowest
 * valuation up, which is how "more of it the cheaper it gets" reads as a curve. Any cents
 * left over by rounding go to the heaviest rung, so the total is never short.
 */
export function planLadder(opts: {
  bands: number[];
  lowUsd: number;
  highUsd: number;
  totalQuote: bigint;
  shape: LadderShape;
  minRungQuote: bigint;
  maxRungQuote: bigint;
  /** Transactions carry a few rungs each; this bounds how many a wallet is asked to sign. */
  maxRungs?: number;
}): LadderResult {
  const lo = Math.min(opts.lowUsd, opts.highUsd);
  const hi = Math.max(opts.lowUsd, opts.highUsd);
  const bands = [...new Set(opts.bands)].filter((b) => b >= lo && b <= hi).sort((a, b) => a - b);
  if (bands.length === 0) return { ok: false, reason: 'no-bands', detail: 'No valuation bands fall in that range.' };
  if (opts.maxRungs !== undefined && bands.length > opts.maxRungs) {
    return { ok: false, reason: 'too-many-rungs', detail: `A ladder is at most ${opts.maxRungs} rungs.` };
  }

  const n = bands.length;
  const weights = bands.map((_, i) => BigInt(opts.shape === 'even' ? 1 : n - i));
  const totalWeight = weights.reduce((a, b) => a + b, 0n);
  const totalCents = opts.totalQuote / CENT;

  const cents = weights.map((w) => (totalCents * w) / totalWeight);
  const heaviest = weights.indexOf(weights.reduce((a, b) => (b > a ? b : a)));
  cents[heaviest] += totalCents - cents.reduce((a, b) => a + b, 0n);
  // Sub-cent dust in the requested total (a typed $100.005) rides on the heaviest rung too,
  // so the ladder always escrows exactly what was asked for.
  const rungs = bands.map((valuationUsd, i) => ({
    valuationUsd,
    strikeQuote: cents[i] * CENT + (i === heaviest ? opts.totalQuote % CENT : 0n),
  }));

  const smallest = rungs.reduce((a, r) => (r.strikeQuote < a ? r.strikeQuote : a), rungs[0].strikeQuote);
  const largest = rungs.reduce((a, r) => (r.strikeQuote > a ? r.strikeQuote : a), rungs[0].strikeQuote);
  if (smallest < opts.minRungQuote) {
    return {
      ok: false,
      reason: 'below-minimum',
      detail: `That leaves a rung with less than the ${Number(opts.minRungQuote) / 1e6} USDC minimum. Commit more, or ladder across fewer valuations.`,
    };
  }
  if (largest > opts.maxRungQuote) {
    return {
      ok: false,
      reason: 'above-cap',
      detail: `A rung would exceed the ${Number(opts.maxRungQuote) / 1e6} USDC per-position cap. Commit less, or ladder across more valuations.`,
    };
  }
  return { ok: true, rungs };
}
