'use client';

import { StepChart } from './StepChart';
import { usd } from '../lib/format';

/**
 * Capital over time: what was on offer, what was in force, and what has been matched.
 *
 * Two charts, not one with two axes. "On offer" and "in force" are the same kind of quantity
 * (capital on the book right now) and share a scale; "matched to date" only ever grows and
 * answers a different question, so it gets its own. Every point comes from the SDK's
 * `capitalSeries` over chain accounts, so this is recomputable by anyone.
 */

/** One point of the series, in dollars: plain numbers so a server page can pass it down. */
export type CapitalPointUsd = {
  t: number;
  offered: number;
  inForce: number;
  matched: number;
  premium: number;
};

const AMBER = 'var(--amber-fill)';
const TEAL = 'var(--teal-fill)';

export function CapitalCharts({
  points,
  scope,
}: {
  points: CapitalPointUsd[];
  /** Whose capital this is, for the headings: "OpenAI", "your book". */
  scope: string;
}) {
  const times = points.map((p) => p.t);
  const last = points[points.length - 1];

  return (
    <section className="card" style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div>
        <h2 className="label" style={{ marginBottom: 4 }}>
          Capital on the book
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 12px', lineHeight: 1.55 }}>
          {scope}, over time. <strong style={{ fontWeight: 600 }}>On offer</strong> is capital a holder
          could take right now; <strong style={{ fontWeight: 600 }}>in force</strong> is protection
          already bought and still running.
        </p>
        <StepChart
          title={`Capital on the book, ${scope}`}
          times={times}
          series={[
            { id: 'offered', label: 'On offer', color: AMBER, values: points.map((p) => p.offered) },
            { id: 'inForce', label: 'In force', color: TEAL, values: points.map((p) => p.inForce) },
          ]}
        />
      </div>

      <div>
        <h2 className="label" style={{ marginBottom: 4 }}>
          Matched to date
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 12px', lineHeight: 1.55 }}>
          Every dollar of capital a holder has taken, cumulatively
          {last && last.premium > 0 ? <>, for {usd(last.premium)} of premium paid</> : null}.
        </p>
        <StepChart
          title={`Capital matched to date, ${scope}`}
          times={times}
          area
          height={160}
          series={[{ id: 'matched', label: 'Matched to date', color: TEAL, values: points.map((p) => p.matched) }]}
        />
      </div>
    </section>
  );
}
