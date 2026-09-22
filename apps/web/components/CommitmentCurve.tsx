import type { CurveBucket } from '../../../packages/sdk/src/commitment-curve.ts';
import { isConcentrated, peakCommitted } from '../../../packages/sdk/src/commitment-curve.ts';
import { band, fromQuote, pct, usd } from '../lib/format';

/**
 * Horizontal bars of capital committed at each valuation band.
 *
 * Amber marks the bands carrying the most capital; the rest stay muted so the shape of
 * demand reads at a glance. Concentration is shown inline rather than buried in a tooltip:
 * a band where one wallet holds most of the capital is one person's opinion wearing the
 * costume of a market, and hiding that would make the curve dishonest.
 */
export function CommitmentCurve({
  buckets,
  marketValuationUsd,
}: {
  buckets: CurveBucket[];
  marketValuationUsd: number;
}) {
  const peak = peakCommitted(buckets);
  const anyCapital = peak > 0n;

  return (
    <section className="card" style={{ padding: '26px 28px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 20,
          flexWrap: 'wrap',
        }}
      >
        <h2 className="label" style={{ fontFamily: 'var(--font-mono)' }}>
          Capital committed to buy
        </h2>
        <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
          Market trades at {band(marketValuationUsd)}
        </span>
      </div>

      {!anyCapital && (
        <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: '0 0 20px' }}>
          No open commitments yet. The first commitment at any level starts the curve.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        {buckets.map((b, i) => {
          const amount = fromQuote(b.committed);
          const width = anyCapital ? (Number(b.committed) / Number(peak)) * 100 : 0;
          // Only the top two bands by capital get the accent; a curve where every bar is
          // amber tells you nothing about where demand actually sits.
          const isPeak = b.committed > 0n && Number(b.committed) >= Number(peak) * 0.7;
          const crowded = isConcentrated(b);

          return (
            <div key={b.valuationUsd} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div
                className="fig"
                style={{
                  width: 66,
                  fontSize: 13,
                  textAlign: 'right',
                  color: isPeak ? 'var(--text)' : 'var(--text-muted)',
                  fontWeight: isPeak ? 500 : 400,
                  flexShrink: 0,
                }}
              >
                {band(b.valuationUsd)}
              </div>

              <div
                style={{
                  flexGrow: 1,
                  height: 26,
                  background: 'var(--line-soft)',
                  borderRadius: 5,
                  overflow: 'hidden',
                  minWidth: 60,
                }}
              >
                <div
                  className={isPeak ? 'curve-bar is-peak' : 'curve-bar'}
                  style={{
                    width: `${width}%`,
                    height: '100%',
                    background: isPeak
                      ? 'linear-gradient(90deg, var(--amber-fill), var(--gold))'
                      : 'var(--amber-soft)',
                    borderRadius: 5,
                    transition: 'width 320ms var(--ease-out)',
                    animationDelay: `${Math.min(i, 12) * 45}ms`,
                  }}
                />
              </div>

              <div
                className="fig"
                style={{ width: 84, fontSize: 13, textAlign: 'right', flexShrink: 0 }}
              >
                {b.committed > 0n ? usd(amount, amount >= 1000 ? 0 : 2) : '—'}
              </div>

              <div
                style={{
                  width: 118,
                  fontSize: 11,
                  color: crowded ? 'var(--caution)' : 'var(--text-faint)',
                  flexShrink: 0,
                }}
              >
                {b.openPositions === 0
                  ? ''
                  : crowded
                    ? `1 wallet holds ${pct(b.largestWalletShare, 0).replace('+', '')}`
                    : `${b.uniqueWallets} wallet${b.uniqueWallets === 1 ? '' : 's'}`}
              </div>
            </div>
          );
        })}
      </div>

      <p
        style={{
          margin: '20px 0 0',
          paddingTop: 16,
          borderTop: '1px solid var(--line-soft)',
          fontSize: 12,
          lineHeight: 1.5,
          color: 'var(--text-faint)',
        }}
      >
        Capital committed at each level &mdash; not an estimate of what the company is worth.
        Premium and expiry both affect willingness independently of conviction, and a single
        wallet can dominate a band, so concentration is shown rather than hidden.
      </p>
    </section>
  );
}
