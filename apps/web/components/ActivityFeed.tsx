import Link from 'next/link';
import type { ActivityEvent } from '../../../packages/sdk/src/activity.ts';
import { band, fromQuote, usd } from '../lib/format';

/**
 * The latest things people did on the book, read from chain: commitments, ladders, slices,
 * sweeps, exercises, withdrawals and settlements, newest first. The dot marks what kind of thing
 * happened (amber for capital committed, teal for protection); the words carry the meaning, so
 * nothing depends on telling the colours apart.
 */

const DOT: Record<ActivityEvent['kind'], string> = {
  commit: 'var(--amber-fill)',
  take: 'var(--teal-fill)',
  exercise: 'var(--teal-ink)',
  withdraw: 'var(--line-strong)',
  settle: 'var(--line-strong)',
};

function ago(at: number, now: number): string {
  const s = Math.max(0, now - at);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const money = (q: bigint) => usd(fromQuote(q), fromQuote(q) % 1 === 0 ? 0 : 2);
const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');
/** ", $800B–$1.1T" for a spread, " at $800B" when every item was at one valuation. */
const span = (v: number[]) => (v.length === 1 ? ` at ${band(v[0])}` : `, ${band(v[0])}–${band(v[v.length - 1])}`);

function describe(e: ActivityEvent, name: string): string {
  const many = e.positions.length;
  switch (e.kind) {
    case 'commit':
      return many > 1
        ? `${money(e.quote)} laddered across ${many} valuations of ${name}${span(e.valuations)}`
        : `${money(e.quote)} committed to buy ${name} at ${band(e.valuations[0])}`;
    case 'take':
      return many > 1
        ? `${money(e.quote)} of protection swept across ${many} ${name} floors${span(e.valuations)}`
        : `${money(e.quote)} of protection taken on ${name} at ${band(e.valuations[0])}`;
    case 'exercise':
      return `Protection exercised: ${money(e.quote)} of ${name} at ${band(e.valuations[0])}`;
    case 'withdraw':
      return `${money(e.quote)} nobody took, withdrawn from ${article(name)} ${name} floor at ${band(e.valuations[0])}`;
    case 'settle':
      return many > 1
        ? `${many} expired ${name} claims settled, collateral home`
        : `An expired ${name} claim settled at ${band(e.valuations[0])}, collateral home`;
  }
}

export function ActivityFeed({
  events,
  names,
  now,
}: {
  events: ActivityEvent[];
  /** Symbol and display name for each stock mint. */
  names: Record<string, { symbol: string; name: string }>;
  now: number;
}) {
  if (events.length === 0) return null;
  return (
    <section className="wrap" style={{ paddingBottom: 56 }}>
      <h2 className="label" style={{ margin: '0 0 14px' }}>
        Latest on chain
      </h2>
      <ol className="card" style={{ listStyle: 'none', margin: 0, padding: '6px 20px' }}>
        {events.map((e, i) => {
          const asset = names[e.stockMint];
          const href = e.positions.length === 1 ? `/c/${e.positions[0]}` : asset ? `/asset/${asset.symbol}` : '/';
          return (
            <li
              key={`${e.kind}-${e.at}-${e.positions[0]}`}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 14,
                padding: '12px 0',
                borderTop: i === 0 ? 'none' : '1px solid var(--line-soft)',
                fontSize: 14,
              }}
            >
              <span className="fig" style={{ fontSize: 12, color: 'var(--text-faint)', minWidth: 64, flexShrink: 0 }}>
                {ago(e.at, now)}
              </span>
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: DOT[e.kind], flexShrink: 0, alignSelf: 'center' }} />
              <Link href={href} style={{ color: 'var(--text)', textDecoration: 'none' }}>
                {describe(e, asset?.name ?? 'a PreStock')}
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
