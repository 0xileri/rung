import Link from 'next/link';
import { MeshWash } from '../components/Fragments';
import { HeroShowcase, type HeroData } from '../components/HeroShowcase';
import { fromQuote, pct, valuation } from '../lib/format';
import {
  relativeTo,
  isFeedConsistent,
  targetTokenPrice,
  valuationBands,
} from '../../../packages/sdk/src/valuation.ts';
import type { PreStockAsset } from '../../../packages/sdk/src/valuation.ts';
import { buildCurve } from '../../../packages/sdk/src/commitment-curve.ts';
import { getPreStocks } from '../lib/prestocks-cache';
import { CLUSTER, connection, toOpenCommitments, type PositionsResult } from '../lib/chain';
import { getPositionsCached } from '../lib/positions-cache';
import { pnlForPosition, priceBook, readMintScales, totalPnl, type MintScale } from '../lib/pnl';
import { ActivityBand, type Activity } from '../components/ActivityBand';
import { escrowTargetFor, LISTED_SYMBOLS } from '../lib/deployment';

export const dynamic = 'force-dynamic';

// Calls the cache directly rather than fetching this app's own API route over HTTP: a
// server component self-fetching needs a correct base URL in every environment, and it
// doubles the work for data already in memory.
async function loadMarkets(): Promise<{ assets: PreStockAsset[]; stale: boolean }> {
  try {
    const { assets, stale } = await getPreStocks();
    return { assets, stale };
  } catch {
    return { assets: [], stale: false };
  }
}

/**
 * The hero's curve and quote, computed exactly as the asset page computes them: open
 * positions read from chain for the mint this cluster escrows, bucketed into the same bands,
 * and a strike from the live mark. A chain read failure yields `curve: null`, which the hero
 * states, rather than an empty curve that would read as "nobody has committed".
 */
async function loadHero(featured: PreStockAsset | undefined, fetched: PositionsResult): Promise<HeroData | null> {
  if (!featured) return null;
  const escrow = escrowTargetFor(featured.symbol, featured.contract_address);
  const bands = valuationBands(featured.markValuation, 6);
  const curve = fetched.ok
    ? buildCurve(toOpenCommitments(fetched.positions, escrow.mint), bands).map((b) => ({
        valuationUsd: b.valuationUsd,
        committedUsd: fromQuote(b.committed),
        largestWalletShare: b.largestWalletShare,
      }))
    : null;

  // The commit panel's opening values: the band nearest 80% of the mark, $100, $4.60.
  const target = bands.reduce(
    (best, b) =>
      Math.abs(b - featured.markValuation * 0.8) < Math.abs(best - featured.markValuation * 0.8) ? b : best,
    bands[0],
  );
  return {
    symbol: featured.symbol,
    cluster: CLUSTER,
    marketValuation: featured.impliedValuation,
    curve,
    quote: {
      target,
      sizeUsd: 100,
      premiumUsd: 4.6,
      vsMarket: relativeTo(target, featured.impliedValuation),
      strikePerToken: targetTokenPrice(featured.markPrice, featured.markValuation, target),
    },
  };
}

/**
 * Protocol-wide figures, every one computed from Position accounts on chain. P&L uses the
 * same function as My Positions; since each position's two sides are exact opposites, the
 * makers' total is the holders' total negated.
 */
async function loadActivity(assets: PreStockAsset[], fetched: PositionsResult): Promise<Activity | null> {
  if (!fetched.ok) return null;
  const positions = fetched.positions;
  const open = positions.filter((p) => p.status === 'Open');
  const matched = positions.filter((p) => p.matchedAt > 0);
  const scales = await readMintScales(connection(), matched.map((p) => p.stockMint)).catch(
    () => ({}) as Record<string, MintScale>,
  );
  const prices = priceBook(assets);
  return {
    committedUsd: open.reduce((s, p) => s + fromQuote(p.strikeQuoteEscrowed), 0),
    openCount: open.length,
    matchedCount: matched.length,
    liveCount: matched.filter((p) => p.status === 'Matched').length,
    premiumsUsd: matched.reduce((s, p) => s + fromQuote(p.premiumQuoteAmount), 0),
    makers: totalPnl(matched.map((p) => pnlForPosition(p, 'maker', scales[p.stockMint], prices))),
    staleSeconds: fetched.staleSeconds,
  };
}

export default async function Home() {
  const { assets, stale } = await loadMarkets();
  const featured = assets.find((a) => a.symbol === 'OPENAI') ?? assets[0];
  // One chain read shared by the hero curve and the activity band.
  const fetched = await getPositionsCached();
  const hero = await loadHero(featured, fetched);
  const activity = await loadActivity(assets, fetched);

  return (
    <>
      <section className="hero-shell" style={{ overflow: 'hidden' }}>
        <MeshWash />
        <div
          className="wrap"
          style={{ position: 'relative', zIndex: 1, paddingTop: 72, paddingBottom: 80 }}
        >
          <div
            className="hero-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 520px)',
              gap: 48,
              alignItems: 'center',
            }}
          >
            <div className="enter">
              <p
                className="label enter enter-delay-1"
                style={{ marginBottom: 18, color: 'var(--amber-ink)' }}
              >
                Capital-backed valuations
              </p>
              <h1
                className="enter enter-delay-1"
                style={{
                  fontSize: 'clamp(40px, 5.5vw, 64px)',
                  fontWeight: 650,
                  letterSpacing: '-0.04em',
                  lineHeight: 1.05,
                  marginBottom: 20,
                  maxWidth: 560,
                }}
              >
                Name your valuation.
                <br />
                Put capital behind it.
              </h1>
              <p
                className="enter enter-delay-2"
                style={{
                  fontSize: 18,
                  lineHeight: 1.55,
                  color: 'var(--text-muted)',
                  margin: '0 0 12px',
                  maxWidth: 480,
                }}
              >
                Lock USDC at the private-company valuation where you would actually own exposure.
                Get paid a premium when a PreStocks holder takes the other side.
              </p>
              <p
                className="enter enter-delay-2"
                style={{
                  fontSize: 15,
                  lineHeight: 1.55,
                  color: 'var(--text-faint)',
                  margin: '0 0 32px',
                  maxWidth: 480,
                }}
              >
                Your commitment joins a live, capital-backed demand curve — what people will pay
                at each valuation, not what they say in a poll.
              </p>
              <div
                className="enter enter-delay-3"
                style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 36 }}
              >
                {featured && (
                  <Link
                    href={`/asset/${featured.symbol}`}
                    className="btn"
                    style={{ textDecoration: 'none' }}
                  >
                    Explore {featured.name.replace(/ PreStocks$/i, '')}
                  </Link>
                )}
                <Link
                  href="/limitations"
                  className="btn btn-quiet"
                  style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                >
                  How it works
                </Link>
              </div>
              <ul
                className="enter enter-delay-4"
                style={{
                  display: 'flex',
                  gap: 20,
                  listStyle: 'none',
                  padding: 0,
                  margin: 0,
                  flexWrap: 'wrap',
                  fontSize: 13,
                  color: 'var(--text-faint)',
                }}
              >
                <li>Collateral in program vaults</li>
                <li>PreStocks-native</li>
                <li>Fractional</li>
                <li>No oracle in settlement</li>
              </ul>
            </div>

            <div className="enter enter-delay-2" style={{ justifySelf: 'end', width: '100%' }}>
              {hero && <HeroShowcase data={hero} />}
            </div>
          </div>
        </div>
      </section>

      <ActivityBand activity={activity} cluster={CLUSTER} />

      <section className="wrap enter enter-delay-3" style={{ paddingBottom: 88 }}>
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
          <h2 style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.03em' }}>
            PreStocks markets
          </h2>
          {stale && (
            <span className="callout callout-caution" style={{ padding: '6px 12px', fontSize: 12 }}>
              Cached — upstream busy
            </span>
          )}
        </div>

        {assets.length === 0 ? (
          <p className="card" style={{ padding: '18px 20px', fontSize: 14, color: 'var(--text-muted)' }}>
            Could not reach the PreStocks API just now. Valuation data is live in every environment
            — try again shortly.
          </p>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: 14,
            }}
          >
            {assets.map((a, i) => {
              const delta = relativeTo(a.impliedValuation, a.markValuation);
              const name = a.name.replace(/ PreStocks$/i, '');
              return (
                <Link
                  key={a.symbol}
                  href={`/asset/${a.symbol}`}
                  className="card card-lift"
                  style={{
                    padding: '20px 22px',
                    textDecoration: 'none',
                    color: 'inherit',
                    display: 'block',
                    animationDelay: `${Math.min(i, 8) * 40}ms`,
                    opacity: isFeedConsistent(a) ? 1 : 0.75,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      gap: 10,
                      marginBottom: 16,
                    }}
                  >
                    <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.02em' }}>
                      {name}
                      {LISTED_SYMBOLS.includes(a.symbol) && (
                        <span
                          style={{
                            marginLeft: 8,
                            fontSize: 11,
                            fontWeight: 500,
                            letterSpacing: 0,
                            color: 'var(--teal-ink)',
                            verticalAlign: 'middle',
                          }}
                        >
                          Tradable on {CLUSTER}
                        </span>
                      )}
                    </span>
                    <span
                      className="fig"
                      style={{
                        fontSize: 12,
                        fontWeight: 500,
                        color: delta >= 0 ? 'var(--amber-ink)' : 'var(--teal-ink)',
                      }}
                    >
                      {pct(delta, 1)}
                    </span>
                  </div>
                  <dl style={{ margin: 0, display: 'flex', gap: 24 }}>
                    <div>
                      <dt style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 4 }}>
                        Market
                      </dt>
                      <dd className="fig" style={{ fontSize: 15, margin: 0, fontWeight: 500 }}>
                        {valuation(a.impliedValuation)}
                      </dd>
                    </div>
                    <div>
                      <dt style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 4 }}>
                        Mark
                      </dt>
                      <dd className="fig" style={{ fontSize: 15, margin: 0, fontWeight: 500 }}>
                        {valuation(a.markValuation)}
                      </dd>
                    </div>
                  </dl>
                </Link>
              );
            })}
          </div>
        )}
        <p style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 16 }}>
          Percentage is the market&rsquo;s premium or discount to the PreStocks reference mark. A
          mark is a reference, not a fair value.
        </p>
      </section>

      <section className="wrap" style={{ paddingBottom: 96 }}>
        <h2
          style={{
            fontSize: 28,
            fontWeight: 600,
            letterSpacing: '-0.03em',
            marginBottom: 8,
            maxWidth: 520,
          }}
        >
          Infrastructure for honest private valuations
        </h2>
        <p
          style={{
            fontSize: 16,
            color: 'var(--text-muted)',
            margin: '0 0 28px',
            maxWidth: 520,
            lineHeight: 1.55,
          }}
        >
          Commit capital, surface a demand curve, and let holders buy a floor — without an oracle
          in the settlement path.
        </p>
        <div className="bento">
          <div className="card bento-wide" style={{ padding: '28px 28px 24px' }}>
            <div className="label" style={{ marginBottom: 10, color: 'var(--amber-ink)' }}>
              Commitment Curve
            </div>
            <h3 style={{ fontSize: 22, fontWeight: 600, marginBottom: 10, letterSpacing: '-0.02em' }}>
              Capital that actually shows up
            </h3>
            <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0, lineHeight: 1.55, maxWidth: 420 }}>
              Horizontal bars of USDC locked at each valuation band. Peak bands use amber;
              concentration is shown inline so one wallet cannot dress up as a market.
            </p>
          </div>
          <div className="card" style={{ padding: '28px 24px' }}>
            <div className="label" style={{ marginBottom: 10 }}>Protect</div>
            <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8, letterSpacing: '-0.02em' }}>
              Sell upside, keep a floor
            </h3>
            <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0, lineHeight: 1.55 }}>
              Holders lock PreStocks, collect premium, and may exchange for the committed USDC
              before expiry.
            </p>
          </div>
          <div className="card" style={{ padding: '28px 24px' }}>
            <div className="label" style={{ marginBottom: 10 }}>Settlement</div>
            <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8, letterSpacing: '-0.02em' }}>
              No oracle required
            </h3>
            <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0, lineHeight: 1.55 }}>
              Strike is fixed at creation. Exercise is the holder&rsquo;s choice — Rung never asks
              a feed whether it is rational.
            </p>
          </div>
          <div className="card" style={{ padding: '28px 24px' }}>
            <div className="label" style={{ marginBottom: 10 }}>Custody</div>
            <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8, letterSpacing: '-0.02em' }}>
              Vaults, stated plainly
            </h3>
            <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0, lineHeight: 1.55 }}>
              Collateral sits in program vaults. Issuer mint powers still apply —{' '}
              <Link href="/limitations">read the limitations</Link>.
            </p>
          </div>
        </div>
      </section>

      <style>{`
        @media (max-width: 960px) {
          .hero-grid {
            grid-template-columns: 1fr !important;
          }
          .hero-grid > div:last-child {
            justify-self: stretch !important;
            max-width: 520px;
            margin: 0 auto;
          }
        }
      `}</style>
    </>
  );
}
