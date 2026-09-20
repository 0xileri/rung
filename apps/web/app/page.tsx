import Link from 'next/link';
import { pct, valuation } from '../lib/format';
import { relativeTo } from '../../../packages/sdk/src/valuation.ts';

export const dynamic = 'force-dynamic';

type Asset = {
  symbol: string;
  name: string;
  markValuation: number;
  impliedValuation: number;
  markPrice: number;
  feedConsistent: boolean;
};

async function getAssets(): Promise<Asset[]> {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://127.0.0.1:3000';
  try {
    const res = await fetch(`${base}/api/prestocks`, { cache: 'no-store' });
    if (!res.ok) return [];
    return ((await res.json()) as { assets: Asset[] }).assets ?? [];
  } catch {
    return [];
  }
}

export default async function Home() {
  const assets = await getAssets();
  const featured = assets.find((a) => a.symbol === 'OPENAI') ?? assets[0];

  return (
    <div className="wrap" style={{ paddingTop: 56, paddingBottom: 56 }}>
      <section style={{ maxWidth: 720, marginBottom: 48 }}>
        <h1 style={{ fontSize: 58, marginBottom: 20 }}>
          Name your valuation.
          <br />
          Put capital behind it.
        </h1>
        <p style={{ fontSize: 18, lineHeight: 1.55, color: 'var(--text-muted)', margin: '0 0 12px' }}>
          Lock USDC at the private-company valuation where you would actually be willing to own
          exposure. Get paid a premium when a PreStocks holder takes the other side.
        </p>
        <p style={{ fontSize: 15, lineHeight: 1.55, color: 'var(--text-faint)', margin: '0 0 28px' }}>
          Your commitment joins a live, capital-backed demand curve showing what people will
          actually pay at each valuation &mdash; not what they say in a poll.
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {featured && (
            <Link href={`/asset/${featured.symbol}`} className="btn" style={{ textDecoration: 'none' }}>
              Explore {featured.name.replace(' PreStocks', '')}
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
          style={{
            display: 'flex',
            gap: 22,
            listStyle: 'none',
            padding: 0,
            margin: '32px 0 0',
            flexWrap: 'wrap',
            fontSize: 12,
            color: 'var(--text-faint)',
          }}
        >
          <li>Collateral in program vaults</li>
          <li>PreStocks-native</li>
          <li>Fractional</li>
          <li>No oracle in the settlement path</li>
        </ul>
      </section>

      <section>
        <h2 className="label" style={{ marginBottom: 16 }}>
          PreStocks markets
        </h2>

        {assets.length === 0 ? (
          <p className="card" style={{ padding: '18px 20px', fontSize: 14, color: 'var(--text-muted)' }}>
            Could not reach the PreStocks API just now. Valuation data is live in every
            environment, so nothing here is cached or synthetic &mdash; try again shortly.
          </p>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(268px, 1fr))',
              gap: 14,
            }}
          >
            {assets.map((a) => {
              const delta = relativeTo(a.impliedValuation, a.markValuation);
              const name = a.name.replace(' PreStocks', '');
              return (
                <Link
                  key={a.symbol}
                  href={`/asset/${a.symbol}`}
                  className="card"
                  style={{
                    padding: '18px 20px',
                    textDecoration: 'none',
                    color: 'inherit',
                    display: 'block',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      gap: 10,
                      marginBottom: 14,
                    }}
                  >
                    <span style={{ fontSize: 16, fontWeight: 600 }}>{name}</span>
                    <span
                      className="fig"
                      style={{
                        fontSize: 12,
                        color: delta >= 0 ? 'var(--amber-ink)' : 'var(--teal-ink)',
                      }}
                    >
                      {pct(delta, 1)}
                    </span>
                  </div>
                  <dl style={{ margin: 0, display: 'flex', gap: 20 }}>
                    <div>
                      <dt style={{ fontSize: 11, color: 'var(--text-faint)' }}>Market</dt>
                      <dd className="fig" style={{ fontSize: 15, margin: '3px 0 0' }}>
                        {valuation(a.impliedValuation)}
                      </dd>
                    </div>
                    <div>
                      <dt style={{ fontSize: 11, color: 'var(--text-faint)' }}>Mark</dt>
                      <dd className="fig" style={{ fontSize: 15, margin: '3px 0 0' }}>
                        {valuation(a.markValuation)}
                      </dd>
                    </div>
                  </dl>
                </Link>
              );
            })}
          </div>
        )}
        <p style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 14 }}>
          Percentage is the market&rsquo;s premium or discount to the PreStocks reference mark.
          A mark is a reference, not a fair value.
        </p>
      </section>
    </div>
  );
}
