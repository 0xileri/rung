import Link from 'next/link';
import { signedUsd, usd } from '../lib/format';
import { pnlColor, type totalPnl } from '../lib/pnl';
import { YourPnl } from './YourPnl';

/**
 * "On chain now": protocol-wide figures for the landing page, each computed from chain
 * accounts rather than kept by the interface. The P&L pair is two sums, not one number shown
 * twice: they are exact opposites until a protocol fee is on, and then they differ by exactly
 * the fees, which the holder paid and the maker never received.
 */

export type Activity = {
  committedUsd: number;
  openCount: number;
  matchedCount: number;
  liveCount: number;
  /** Premium that reached makers, after the protocol's cut. */
  premiumsUsd: number;
  /** The protocol's cut of those premiums. */
  feesUsd: number;
  makers: ReturnType<typeof totalPnl>;
  holders: ReturnType<typeof totalPnl>;
  /** Set when the chain read failed and a recent cached one is shown instead. */
  staleSeconds?: number;
};

export function ActivityBand({ activity, cluster }: { activity: Activity | null; cluster: string }) {
  return (
    <section className="wrap" style={{ paddingTop: 36, paddingBottom: 56 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <h2 className="label" style={{ margin: 0 }}>
          On chain now
        </h2>
        <span style={{ fontSize: 12, color: activity?.staleSeconds ? 'var(--caution)' : 'var(--text-faint)' }}>
          {activity?.staleSeconds
            ? `${cluster}, as of ${Math.max(1, Math.round(activity.staleSeconds / 60))} min ago (RPC busy)`
            : `${cluster}, read live from Position accounts`}
        </span>
        <span style={{ flexGrow: 1 }} />
        <YourPnl />
      </div>

      {activity === null ? (
        <p className="card" style={{ padding: '16px 20px', fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
          The chain could not be read just now. These figures come straight from Position
          accounts, so none are shown rather than stale ones.
        </p>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 14,
          }}
        >
          <Stat
            tint="amber"
            label="Capital committed"
            value={usd(activity.committedUsd, 0)}
            note={`${activity.openCount} open commitment${activity.openCount === 1 ? '' : 's'}`}
          />
          <Stat
            tint="teal"
            label="Positions matched"
            value={String(activity.matchedCount)}
            note={`${activity.liveCount} live, ${activity.matchedCount - activity.liveCount} settled`}
          />
          <Stat
            tint="amber"
            label="Premiums paid to makers"
            value={usd(activity.premiumsUsd)}
            note={
              activity.feesUsd > 0
                ? `on every matched position, after ${usd(activity.feesUsd)} protocol fee`
                : 'on every matched position'
            }
          />
          <Stat
            label="Makers vs holders, net P&L"
            value={activity.makers.empty ? '—' : `Makers ${signedUsd(activity.makers.usd)}`}
            valueColor={activity.makers.empty ? undefined : pnlColor(activity.makers.usd)}
            secondary={activity.holders.empty ? undefined : `Holders ${signedUsd(activity.holders.usd)}`}
            note={
              activity.makers.unpriced > 0
                ? `${activity.makers.unpriced} position(s) without a live price`
                : activity.feesUsd > 0
                  ? "at today's market price; they differ by the protocol fee"
                  : "at today's market price; one side's gain is the other's loss"
            }
          />
        </div>
      )}
      <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '10px 0 0' }}>
        How P&amp;L is measured: <Link href="/limitations#pnl">premium plus exercise value, fees excluded</Link>.
      </p>
    </section>
  );
}

function Stat({
  label,
  value,
  note,
  valueColor,
  secondary,
  tint,
}: {
  label: string;
  value: string;
  note: string;
  valueColor?: string;
  /** A second figure on its own line, so a pair of values never wraps mid-number. */
  secondary?: string;
  tint?: 'amber' | 'teal';
}) {
  return (
    <div className={tint ? `card tint-${tint}` : 'card'} style={{ padding: '16px 18px' }}>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 6 }}>{label}</div>
      <div className="fig" style={{ fontSize: secondary ? 18 : 22, fontWeight: 500, color: valueColor }}>
        {value}
      </div>
      {secondary && (
        <div className="fig" style={{ fontSize: 18, fontWeight: 500, color: 'var(--text-muted)' }}>
          {secondary}
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 4 }}>{note}</div>
    </div>
  );
}
