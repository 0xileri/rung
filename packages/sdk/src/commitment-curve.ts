/**
 * The Commitment Curve: how much capital is actually committed at each valuation level.
 *
 * Read it as "where capital is currently willing to buy" and nothing more. It is a stronger
 * signal than a poll because expressing it costs something, but it is not an estimate of
 * what a company is worth: premium and expiry both affect willingness independently of
 * conviction, participants may be hedging exposure held elsewhere, and a single large wallet
 * can dominate a band. That last one is why concentration travels with every bucket here
 * rather than being computed separately and forgotten.
 */

/** One open commitment, as the indexer reads it back from chain. */
export type OpenCommitment = {
  position: string;
  maker: string;
  /** Target company valuation in whole USD, recorded at creation. */
  targetValuationUsd: number;
  /** USDC escrowed, in base units. */
  strikeQuoteEscrowed: bigint;
  premiumQuoteAmount: bigint;
  expiryTs: number;
};

export type CurveBucket = {
  valuationUsd: number;
  /** Total USDC committed in this band, in base units. */
  committed: bigint;
  openPositions: number;
  uniqueWallets: number;
  /** Share of this band's capital held by its single largest wallet, 0..1. */
  largestWalletShare: number;
  /** Share held by the top three wallets, 0..1. */
  topThreeShare: number;
  /** Premium as a fraction of capital committed, across the band. */
  avgPremiumPct: number;
  /** Median days to expiry, rounded. */
  medianExpiryDays: number;
};

/**
 * Snap a target valuation onto the nearest standardized band.
 *
 * Positions are created against predefined bands, so in practice this is an identity. It
 * exists to keep an off-band position (a hand-built transaction, or a band list that changed
 * since creation) from spawning a bucket of one and fragmenting the curve.
 */
export function snapToBand(valuationUsd: number, bands: number[]): number {
  if (bands.length === 0) return valuationUsd;
  return bands.reduce((best, b) =>
    Math.abs(b - valuationUsd) < Math.abs(best - valuationUsd) ? b : best,
  );
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Aggregate open commitments into one bucket per band, descending.
 *
 * Bands with no capital are still returned. An empty band is information: it says nobody is
 * willing to buy there, and dropping it would quietly reshape the curve.
 */
export function buildCurve(
  commitments: OpenCommitment[],
  bands: number[],
  nowSeconds = Date.now() / 1000,
): CurveBucket[] {
  const byBand = new Map<number, OpenCommitment[]>();
  for (const b of bands) byBand.set(b, []);

  for (const c of commitments) {
    const band = snapToBand(c.targetValuationUsd, bands);
    const bucket = byBand.get(band);
    if (bucket) bucket.push(c);
    else byBand.set(band, [c]);
  }

  return [...byBand.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([valuationUsd, items]) => {
      const committed = items.reduce((sum, c) => sum + c.strikeQuoteEscrowed, 0n);
      const premium = items.reduce((sum, c) => sum + c.premiumQuoteAmount, 0n);

      const perWallet = new Map<string, bigint>();
      for (const c of items) {
        perWallet.set(c.maker, (perWallet.get(c.maker) ?? 0n) + c.strikeQuoteEscrowed);
      }
      const walletTotals = [...perWallet.values()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
      const share = (n: number) =>
        committed === 0n
          ? 0
          : Number(walletTotals.slice(0, n).reduce((s, v) => s + v, 0n)) / Number(committed);

      return {
        valuationUsd,
        committed,
        openPositions: items.length,
        uniqueWallets: perWallet.size,
        largestWalletShare: share(1),
        topThreeShare: share(3),
        avgPremiumPct: committed === 0n ? 0 : Number(premium) / Number(committed),
        medianExpiryDays: Math.round(
          median(items.map((c) => Math.max(0, (c.expiryTs - nowSeconds) / 86400))),
        ),
      };
    });
}

/** Largest committed amount across buckets, for scaling bar widths. */
export function peakCommitted(buckets: CurveBucket[]): bigint {
  return buckets.reduce((max, b) => (b.committed > max ? b.committed : max), 0n);
}

/**
 * Whether a bucket is concentrated enough that the UI should say so.
 *
 * A band where one wallet holds most of the capital is one person's opinion wearing the
 * costume of a market, and the curve should not let that pass unlabelled.
 */
export function isConcentrated(bucket: CurveBucket): boolean {
  return bucket.uniqueWallets > 0 && bucket.largestWalletShare > 0.5;
}
