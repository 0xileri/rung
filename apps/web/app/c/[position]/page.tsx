import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { commitmentCard, siteOrigin } from '../../../lib/og';
import { CLUSTER } from '../../../lib/chain';
import { band, dateTime, explorer, shortKey, timeUntil, usd } from '../../../lib/format';
import { ShareLinks } from '../../../components/ShareLinks';

/**
 * A commitment's public page: the link a maker shares after committing. It says what they would
 * own and at which valuation, shows what is still there to take, and sends a reader straight to
 * the other side of it. Its card (opengraph-image.tsx beside this file) is what the link unfolds
 * into on X and elsewhere.
 */

export const revalidate = 60;

const PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function generateMetadata({ params }: { params: Promise<{ position: string }> }): Promise<Metadata> {
  const { position } = await params;
  const card = PUBKEY.test(position) ? await commitmentCard(position).catch(() => null) : null;
  if (!card) return { title: 'Commitment · Rung' };
  const p = card.position;
  const title = `I'd own ${card.name} at ${band(p.targetValuationUsd)} · Rung`;
  const description = `${usd(Number(p.strikeQuoteEscrowed) / 1e6)} USDC escrowed on Solana at a ${band(p.targetValuationUsd)} valuation. PreStocks holders can take any slice of it as a floor.`;
  return { title, description, openGraph: { title, description }, twitter: { card: 'summary_large_image', title, description } };
}

export default async function CommitmentPage({ params }: { params: Promise<{ position: string }> }) {
  const { position } = await params;
  if (!PUBKEY.test(position)) notFound();
  const [card, origin] = await Promise.all([commitmentCard(position), siteOrigin()]);
  if (!card) notFound();

  const p = card.position;
  const escrowed = Number(p.strikeQuoteEscrowed) / 1e6;
  const open = Number(p.strikeQuoteOpen) / 1e6;
  const premium = Number(p.premiumQuoteAmount) / 1e6;
  const expired = Date.now() / 1000 > p.expiryTs;
  const takeable = !expired && open > 0 && p.status !== 'Cancelled' && p.status !== 'Settled';
  const symbol = card.symbol ?? 'OPENAI';
  const shareText = `I'd own ${card.name} at ${band(p.targetValuationUsd)}, so there's ${usd(escrowed)} USDC behind it. Take the other side:`;

  const figure = (label: string, value: string, sub?: string, accent?: boolean) => (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 6 }}>{label}</div>
      <div className="fig" style={{ fontSize: 22, color: accent ? 'var(--amber-ink)' : 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{sub}</div>}
    </div>
  );

  return (
    <section className="wrap" style={{ paddingTop: 48, paddingBottom: 88, maxWidth: 820 }}>
      <p className="label" style={{ color: 'var(--amber-ink)', marginBottom: 14 }}>
        {symbol} · Commitment
      </p>
      <h1 style={{ fontSize: 'clamp(40px, 6vw, 60px)', marginBottom: 16 }}>
        I&rsquo;d own {card.name} at {band(p.targetValuationUsd)}.
      </h1>
      <p style={{ fontSize: 17, lineHeight: 1.55, color: 'var(--text-muted)', margin: '0 0 28px', maxWidth: 620 }}>
        {usd(escrowed)} USDC is escrowed in a program vault at this valuation. A PreStocks holder can take any
        slice of it as a floor: they lock tokens and pay the premium, and may swap those tokens for this USDC
        before the deadline. No oracle decides anything.
      </p>

      <div className="card" style={{ padding: '22px 24px', marginBottom: 22 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: 18 }}>
          {figure('Committed', usd(escrowed), `at ${band(p.targetValuationUsd)}`)}
          {figure(takeable ? 'Open to take' : 'Still open', usd(open), takeable ? 'any slice from the minimum' : undefined, takeable)}
          {figure('Taken by holders', usd(card.takenUsd), card.slices ? `${card.slices} slice${card.slices === 1 ? '' : 's'}` : 'none yet')}
          {figure('Premium', usd(premium), `${((premium / escrowed) * 100).toFixed(1)}% of the capital`)}
          {figure(expired ? 'Deadline passed' : 'Deadline', expired ? 'Closed' : timeUntil(p.expiryTs), dateTime(p.expiryTs))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 26 }}>
        {takeable && (
          <Link href={`/protect/${symbol}`} className="btn" style={{ textDecoration: 'none' }}>
            Take the other side
          </Link>
        )}
        <Link href={`/asset/${symbol}`} className="btn btn-quiet" style={{ textDecoration: 'none' }}>
          See {card.name}&rsquo;s curve
        </Link>
        <ShareLinks path={`/c/${p.pubkey}`} text={shareText} />
      </div>

      {takeable && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 14px' }}>
          Or take it without opening Rung: this commitment is a Solana Action.{' '}
          <a
            href={`https://dial.to/?action=${encodeURIComponent(`solana-action:${origin}/api/actions/take/${p.pubkey}`)}&cluster=${CLUSTER}`}
            target="_blank"
            rel="noreferrer"
          >
            Open it as a Blink &#8599;
          </a>
        </p>
      )}

      <p style={{ fontSize: 13, color: 'var(--text-faint)', margin: 0 }}>
        Maker {shortKey(p.maker)} ·{' '}
        <a href={explorer('address', p.pubkey, CLUSTER)} target="_blank" rel="noreferrer">
          Position {shortKey(p.pubkey, 6, 6)} &#8599;
        </a>{' '}
        · Solana {CLUSTER}
      </p>
    </section>
  );
}
