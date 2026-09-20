import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CommitmentCurve } from '../../../components/CommitmentCurve';
import { CommitPanel } from '../../../components/CommitPanel';
import { fetchPositions, toOpenCommitments, CLUSTER } from '../../../lib/chain';
import { buildCurve } from '../../../../../packages/sdk/src/commitment-curve.ts';
import { valuationBands, relativeTo } from '../../../../../packages/sdk/src/valuation.ts';
import { band, daysUntil, explorer, pct, shortKey, usd, fromQuote, valuation } from '../../../lib/format';

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
    transferFee: { transferFeeBasisPoints: number; epoch: string; maximumFee: string };
  };
  caveats: string[];
  feedConsistent: boolean;
};

async function getAsset(symbol: string): Promise<AssetResponse | null> {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://127.0.0.1:3000';
  const res = await fetch(`${base}/api/prestocks?symbol=${encodeURIComponent(symbol)}`, {
    cache: 'no-store',
  });
  return res.ok ? ((await res.json()) as AssetResponse) : null;
}

export default async function AssetPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const data = await getAsset(symbol);
  if (!data) notFound();

  const { asset, mint, caveats, feedConsistent } = data;
  const bands = valuationBands(asset.markValuation, 6);

  const positions = await fetchPositions();
  const open = toOpenCommitments(positions, asset.contract_address);
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
            <h2 className="label" style={{ marginBottom: 16 }}>
              Open commitments
            </h2>
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
            markPrice={asset.markPrice}
            markValuation={asset.markValuation}
            impliedValuation={asset.impliedValuation}
            decimals={mint.decimals}
            multiplier={mint.multiplier}
            feeBps={mint.transferFee.transferFeeBasisPoints}
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
            Mint {shortKey(asset.contract_address, 6, 6)} &nearr;
          </a>
        </div>
      </div>
    </div>
  );
}
