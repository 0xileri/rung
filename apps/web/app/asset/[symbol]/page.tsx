import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CommitmentCurve } from '../../../components/CommitmentCurve';
import { CommitPanel } from '../../../components/CommitPanel';
import { fetchPositions, toOpenCommitments, CLUSTER } from '../../../lib/chain';
import { buildCurve } from '../../../../../packages/sdk/src/commitment-curve.ts';
import { valuationBands, relativeTo } from '../../../../../packages/sdk/src/valuation.ts';
import { band, daysUntil, explorer, pct, shortKey, usd, fromQuote, valuation } from '../../../lib/format';
import { getPreStocks, findAsset, getMintState } from '../../../lib/prestocks-cache';
import { escrowTargetFor } from '../../../lib/deployment';
import { custodyCaveats } from '../../../../../packages/sdk/src/prestocks.ts';
import { isFeedConsistent } from '../../../../../packages/sdk/src/valuation.ts';

export const dynamic = 'force-dynamic';

type AssetResponse = {
  asset: {
    symbol: string;
    name: string;
    contract_address: string;
    tokenPrice: number;
    impliedValuation: number;
    markPrice: number;
    markValuation: number;
  };
  mint: {
    decimals: number;
    multiplier: number;
    transferFee: { transferFeeBasisPoints: number };
  };
  caveats: string[];
  feedConsistent: boolean;
};

// Reads the shared cache directly. A server component fetching its own API route needs a
// correct base URL in every environment and doubles work already done in memory.
//
// Mint state is fetched separately and is allowed to FAIL. It comes from a mainnet RPC that
// rate-limits, and it is not essential: the page's valuations come from the API, and the
// quantities are derived from the mint we actually escrow against, whose extension values
// are known. Treating an RPC hiccup as "asset not found" produced a 404 for a page that had
// everything it needed to render.
async function getAsset(symbol: string) {
  const { assets } = await getPreStocks();
  const asset = findAsset(assets, symbol);
  if (!asset) return null;

  let mint: Awaited<ReturnType<typeof getMintState>> | null = null;
  try {
    mint = await getMintState(asset.contract_address);
  } catch {
    // Live issuer powers are unavailable this render; the page says so rather than 404ing.
  }

  return {
    asset,
    mint,
    caveats: mint ? custodyCaveats(mint) : [],
    feedConsistent: isFeedConsistent(asset),
  };
}

export default async function AssetPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const data = await getAsset(symbol);
  if (!data) notFound();

  const { asset, mint, caveats, feedConsistent } = data;
  const escrow = escrowTargetFor(asset.symbol, asset.contract_address);
  // Prefer the escrow mint's own values: those describe the token actually being locked.
  const decimals = escrow.decimals ?? mint?.decimals ?? 9;
  const multiplier = escrow.multiplier ?? mint?.multiplier ?? 1;
  const feeBps = escrow.feeBps ?? mint?.transferFee.transferFeeBasisPoints ?? 0;
  const bands = valuationBands(asset.markValuation, 6);

  const positions = await fetchPositions();
  const open = toOpenCommitments(positions, escrow.mint);
  const curve = buildCurve(open, bands);
  const marketVsMark = relativeTo(asset.impliedValuation, asset.markValuation);

  return (
    <div className="wrap" style={{ paddingTop: 36, paddingBottom: 48 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 40,
          flexWrap: 'wrap',
          marginBottom: 28,
        }}
      >
        <div>
          <div className="label" style={{ marginBottom: 7 }}>
            {asset.name}
          </div>
          <h1 style={{ fontSize: 44 }}>Where would you own it?</h1>
        </div>
        <div style={{ flexGrow: 1 }} />
        <dl style={{ display: 'flex', gap: 34, margin: 0, flexWrap: 'wrap' }}>
          <div>
            <dt style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 5 }}>
              Market implied
            </dt>
            <dd className="fig" style={{ fontSize: 23, margin: 0 }}>
              {valuation(asset.impliedValuation)}
            </dd>
          </div>
          <div>
            <dt style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 5 }}>
              PreStocks mark
            </dt>
            <dd className="fig" style={{ fontSize: 23, margin: 0 }}>
              {valuation(asset.markValuation)}
            </dd>
          </div>
          <div>
            <dt style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 5 }}>
              Market vs mark
            </dt>
            <dd
              className="fig"
              style={{ fontSize: 23, margin: 0, color: 'var(--amber-ink)' }}
            >
              {pct(marketVsMark)}
            </dd>
          </div>
        </dl>
      </div>

      {!feedConsistent && (
        <p
          className="card"
          style={{
            padding: '12px 16px',
            marginBottom: 20,
            fontSize: 13,
            color: 'var(--caution)',
            borderColor: 'var(--caution)',
          }}
        >
          The mark and implied valuations disagree on this asset&rsquo;s share count, so the
          proportional valuation mapping does not currently hold. Commitment creation is
          disabled.
        </p>
      )}

      {escrow.mock && (
        <p
          className="card"
          style={{
            padding: '12px 16px',
            marginBottom: 20,
            fontSize: 13,
            lineHeight: 1.55,
            color: 'var(--text-muted)',
            borderColor: 'var(--amber-fill)',
          }}
        >
          <strong>Devnet demo.</strong> PreStocks exist only on mainnet, so the token escrowed
          here is a mock that reproduces the real mint&rsquo;s {escrow.feeBps ? escrow.feeBps / 100 : 0}%
          transfer fee and {escrow.multiplier} scaled-amount multiplier. The valuations above are
          live from the real PreStocks API.
        </p>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 372px',
          gap: 22,
          alignItems: 'start',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22, minWidth: 0 }}>
          <CommitmentCurve buckets={curve} marketValuationUsd={asset.impliedValuation} />

          <section className="card" style={{ padding: '26px 28px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 12,
                marginBottom: 16,
              }}
            >
              <h2 className="label">Open commitments</h2>
              <Link href={`/protect/${asset.symbol}`} style={{ fontSize: 12 }}>
                Hold {asset.symbol}? Take the other side &rarr;
              </Link>
            </div>
            {open.length === 0 ? (
              <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0 }}>
                Nothing open yet. A commitment appears here the moment it is created, and stays
                until a holder takes the other side or the maker cancels.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {open
                  .slice()
                  .sort((a, b) => b.targetValuationUsd - a.targetValuationUsd)
                  .map((c) => {
                    const strike = fromQuote(c.strikeQuoteEscrowed);
                    const premium = fromQuote(c.premiumQuoteAmount);
                    return (
                      <div
                        key={c.position}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 16,
                          padding: '12px 14px',
                          background: 'var(--paper)',
                          borderRadius: 'var(--radius-sm)',
                          flexWrap: 'wrap',
                        }}
                      >
                        <span className="fig" style={{ fontSize: 14, width: 66 }}>
                          {band(c.targetValuationUsd)}
                        </span>
                        <span className="fig" style={{ fontSize: 14, width: 80 }}>
                          {usd(strike)}
                        </span>
                        <span
                          className="fig"
                          style={{ fontSize: 13, width: 92, color: 'var(--amber-ink)' }}
                        >
                          {usd(premium)} premium
                        </span>
                        <span style={{ fontSize: 13, color: 'var(--text-muted)', flexGrow: 1 }}>
                          {daysUntil(c.expiryTs)}d to expiry
                        </span>
                        <a
                          className="fig"
                          style={{ fontSize: 12 }}
                          href={explorer('address', c.position, CLUSTER)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {shortKey(c.position)}
                        </a>
                      </div>
                    );
                  })}
              </div>
            )}
          </section>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <CommitPanel
            symbol={asset.symbol}
            stockMint={escrow.mint}
            markPrice={asset.markPrice}
            markValuation={asset.markValuation}
            impliedValuation={asset.impliedValuation}
            decimals={decimals}
            multiplier={multiplier}
            feeBps={feeBps}
            bands={bands}
            disabled={!feedConsistent}
          />

          <section className="card" style={{ padding: '20px 22px' }}>
            <h2
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--teal-ink)',
                margin: '0 0 10px',
              }}
            >
              Collateral, honestly
            </h2>
            {caveats.length > 0 ? (
              <ul
                style={{
                  margin: 0,
                  paddingLeft: 16,
                  fontSize: 12,
                  lineHeight: 1.55,
                  color: 'var(--text-muted)',
                }}
              >
                {caveats.map((c) => (
                  <li key={c} style={{ marginBottom: 6 }}>
                    {c}
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--text-muted)', margin: 0 }}>
                Live issuer permissions could not be read from the mint just now. They are
                documented in full on the limitations page &mdash; the issuer holds permanent
                delegate, freeze and pause authority over PreStocks mints.
              </p>
            )}
            <Link href="/limitations" style={{ fontSize: 12 }}>
              Read the limitations &rarr;
            </Link>
          </section>

          <a
            className="fig"
            style={{ fontSize: 12, color: 'var(--text-faint)' }}
            href={explorer('address', asset.contract_address, 'mainnet-beta')}
            target="_blank"
            rel="noreferrer"
          >
            Mint {shortKey(asset.contract_address, 6, 6)} &#8599;
          </a>
        </div>
      </div>
    </div>
  );
}
