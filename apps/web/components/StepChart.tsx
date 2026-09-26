'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { dateTime, usd } from '../lib/format';

/**
 * A step chart for quantities that only change at discrete moments.
 *
 * Capital on Rung moves when someone signs something or a deadline passes, and holds still in
 * between; a sloped line would draw values that never existed. Each line is drawn step-after:
 * a value holds until the next change.
 *
 * Built to the dataviz method rather than by eye:
 *  - 2px lines, an end dot with a 2px surface ring, hairline solid grid, one axis;
 *  - a legend whenever there are two or more series, plus direct labels at the line ends
 *    when they do not collide (they are dropped, not nudged, when they would);
 *  - text in text tokens, never in a series colour;
 *  - a crosshair that snaps to the nearest moment something changed, reading out every
 *    series at once, with the same readout on keyboard focus (arrow keys step through);
 *  - a table view, so no value is only reachable by hovering. It is required here as well as
 *    good practice: the amber series sits at 2.71:1 on white, under the 3:1 mark contrast.
 */

export type StepSeries = { id: string; label: string; color: string; values: number[] };

type Props = {
  /** Unix seconds, ascending, one per point. */
  times: number[];
  series: StepSeries[];
  /** Short name for the chart, used for its accessible label and table caption. */
  title: string;
  height?: number;
  /** Wash the area under a single series. Ignored when there are several. */
  area?: boolean;
};

const PAD_TOP = 12;
const PAD_BOTTOM = 26;
const PAD_LEFT = 58;

/** A clean upper bound and step: 0 / 250 / 500 / 750 / 1,000 rather than 0 / 243 / 486. */
function niceScale(max: number, ticks = 4): { top: number; step: number } {
  if (!(max > 0)) return { top: 1, step: 0.25 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  return { top: Math.ceil(max / step) * step, step };
}

function timeTick(t: number, span: number): string {
  const d = new Date(t * 1000);
  if (span <= 36 * 3600) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (span <= 120 * 86_400) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

export function StepChart({ times, series, title, height = 220, area = false }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const liveId = useId();

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(260, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = times.length;
  const narrow = width < 440;
  const multi = series.length > 1;

  const geometry = useMemo(() => {
    const max = Math.max(0, ...series.flatMap((s) => s.values));
    const { top, step } = niceScale(max);
    const t0 = times[0] ?? 0;
    const t1 = times[n - 1] ?? 1;
    const span = Math.max(1, t1 - t0);

    // End labels need room on the right; they are the first thing to go on a narrow screen,
    // where the legend and the readout carry identity instead.
    const endY = (s: StepSeries) => s.values[n - 1] ?? 0;
    const plotH = height - PAD_TOP - PAD_BOTTOM;
    const yOf = (v: number) => PAD_TOP + plotH - (v / top) * plotH;
    const ends = series.map((s) => yOf(endY(s))).sort((a, b) => a - b);
    const collide = ends.some((y, i) => i > 0 && y - ends[i - 1] < 16);
    const labelEnds = !narrow && !collide;
    const padRight = labelEnds ? 112 : 14;
    const plotW = Math.max(40, width - PAD_LEFT - padRight);
    const xOf = (t: number) => PAD_LEFT + ((t - t0) / span) * plotW;

    const paths = series.map((s) => {
      let d = '';
      s.values.forEach((v, i) => {
        const x = xOf(times[i]);
        const y = yOf(v);
        d += i === 0 ? `M${x},${y}` : `H${x}V${y}`;
      });
      return d;
    });

    const yTicks: number[] = [];
    for (let v = 0; v <= top + step / 2; v += step) yTicks.push(v);
    const xTickCount = narrow ? 3 : 5;
    const xTicks = Array.from({ length: xTickCount }, (_, i) => t0 + (span * i) / (xTickCount - 1));

    return { top, yTicks, xTicks, span, xOf, yOf, paths, plotW, plotH, labelEnds, t0 };
  }, [series, times, n, width, height, narrow]);

  // The outer element is always mounted, so the width it reports survives switching to the
  // table and back, and a chart whose data arrives after an empty first render still sizes.
  if (n < 2) {
    return (
      <div ref={wrapRef}>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
          Nothing to chart yet: this fills in as commitments are made and taken.
        </p>
      </div>
    );
  }

  const { yTicks, xTicks, span, xOf, yOf, paths, plotW, plotH, labelEnds } = geometry;
  const baseY = PAD_TOP + plotH;

  /** The change nearest the pointer: readers aim at a date, never at a 2px line. */
  const nearest = (clientX: number, rect: DOMRect) => {
    const x = clientX - rect.left;
    let best = 0;
    let bestDist = Infinity;
    times.forEach((t, i) => {
      const dist = Math.abs(xOf(t) - x);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    return best;
  };

  const onPointerMove = (e: PointerEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    setActive(nearest(e.clientX, svg.getBoundingClientRect()));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = active ?? n - 1;
    const next =
      e.key === 'ArrowLeft' ? Math.max(0, cur - 1)
      : e.key === 'ArrowRight' ? Math.min(n - 1, cur + 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? n - 1
      : null;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
  };

  const readout =
    active === null
      ? ''
      : `${dateTime(times[active])}: ${series.map((s) => `${s.label} ${usd(s.values[active])}`).join(', ')}`;

  const tipX = active === null ? 0 : xOf(times[active]);
  const tipLeft = tipX > PAD_LEFT + plotW * 0.6;

  return (
    <div ref={wrapRef}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
        {multi &&
          series.map((s) => (
            <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--text-muted)' }}>
              <svg width="16" height="8" aria-hidden="true">
                <line x1="1" y1="4" x2="15" y2="4" stroke={s.color} strokeWidth="2" strokeLinecap="round" />
              </svg>
              {s.label}
            </span>
          ))}
        <span style={{ flexGrow: 1 }} />
        <button
          type="button"
          className="btn btn-quiet"
          style={{ padding: '4px 10px', minHeight: 0, fontSize: 12 }}
          aria-pressed={asTable}
          onClick={() => setAsTable((v) => !v)}
        >
          {asTable ? 'Chart' : 'Table'}
        </button>
      </div>

      {asTable ? (
        <div style={{ maxHeight: height + 40, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <caption style={{ textAlign: 'left', fontSize: 12, color: 'var(--text-faint)', padding: '0 0 6px' }}>
              {title}: each row is a moment something changed, newest first; values held from then until the row above.
            </caption>
            <thead>
              <tr>
                <th style={th}>When</th>
                {series.map((s) => (
                  <th key={s.id} style={{ ...th, textAlign: 'right' }}>
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Newest first: the current state is what a reader looks up most, and the list only grows. */}
              {times.map((t, i) => ({ t, i })).reverse().map(({ t, i }) => (
                <tr key={`${t}-${i}`}>
                  <td style={td}>{dateTime(t)}</td>
                  {series.map((s) => (
                    <td key={s.id} className="fig" style={{ ...td, textAlign: 'right' }}>
                      {usd(s.values[i])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          role="group"
          aria-label={`${title}. Use the left and right arrow keys to step through changes.`}
          aria-describedby={liveId}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={() => setActive((a) => a ?? n - 1)}
          onBlur={() => setActive(null)}
          style={{ position: 'relative', outlineOffset: 4 }}
        >
          <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }} aria-hidden="true">
            {yTicks.map((v) => (
              <g key={v}>
                <line x1={PAD_LEFT} x2={PAD_LEFT + plotW} y1={yOf(v)} y2={yOf(v)} stroke="var(--line-soft)" strokeWidth="1" />
                <text x={PAD_LEFT - 8} y={yOf(v)} dy="0.32em" textAnchor="end" style={axisText}>
                  {usd(v, 0)}
                </text>
              </g>
            ))}
            <line x1={PAD_LEFT} x2={PAD_LEFT + plotW} y1={baseY} y2={baseY} stroke="var(--line)" strokeWidth="1" />
            {xTicks.map((t, i) => (
              <text
                key={t}
                x={xOf(t)}
                y={baseY + 17}
                textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
                style={axisText}
              >
                {timeTick(t, span)}
              </text>
            ))}

            {area && !multi && (
              <path d={`${paths[0]}V${baseY}H${PAD_LEFT}Z`} fill={series[0].color} opacity="0.1" />
            )}
            {paths.map((d, i) => (
              <path key={series[i].id} d={d} fill="none" stroke={series[i].color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            ))}

            {series.map((s) => {
              const x = xOf(times[n - 1]);
              const y = yOf(s.values[n - 1]);
              return (
                <g key={s.id}>
                  <circle cx={x} cy={y} r="4" fill={s.color} stroke="var(--surface)" strokeWidth="2" />
                  {labelEnds && (
                    <text x={x + 10} y={y} dy="0.32em" style={{ fontSize: 12, fill: 'var(--text)', fontFamily: 'var(--font-mono)' }}>
                      {usd(s.values[n - 1], 0)}
                      <tspan style={{ fill: 'var(--text-faint)', fontFamily: 'var(--font-sans)' }}> {multi ? s.label.toLowerCase() : ''}</tspan>
                    </text>
                  )}
                </g>
              );
            })}

            {active !== null && (
              <g>
                <line x1={tipX} x2={tipX} y1={PAD_TOP} y2={baseY} stroke="var(--line-strong)" strokeWidth="1" />
                {series.map((s) => (
                  <circle key={s.id} cx={tipX} cy={yOf(s.values[active])} r="4" fill={s.color} stroke="var(--surface)" strokeWidth="2" />
                ))}
              </g>
            )}

            {/* The whole plot is the hit target: readers aim at a date, never at a 2px line. */}
            <rect
              x={PAD_LEFT}
              y={PAD_TOP}
              width={plotW}
              height={plotH}
              fill="transparent"
              onPointerMove={onPointerMove}
              onPointerLeave={() => setActive(null)}
            />
          </svg>

          {active !== null && (
            <div
              style={{
                position: 'absolute',
                top: 4,
                left: tipLeft ? undefined : Math.min(tipX + 12, width - 190),
                right: tipLeft ? Math.max(0, width - tipX + 12) : undefined,
                pointerEvents: 'none',
                background: 'var(--surface)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-sm)',
                boxShadow: 'var(--shadow-soft)',
                padding: '8px 10px',
                minWidth: 170,
                fontSize: 12,
              }}
            >
              <div style={{ color: 'var(--text-faint)', marginBottom: 4 }}>{dateTime(times[active])}</div>
              {series.map((s) => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, lineHeight: 1.7 }}>
                  <svg width="12" height="6" aria-hidden="true">
                    <line x1="1" y1="3" x2="11" y2="3" stroke={s.color} strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  <strong className="fig" style={{ color: 'var(--text)', fontWeight: 600 }}>
                    {usd(s.values[active])}
                  </strong>
                  <span style={{ color: 'var(--text-muted)' }}>{s.label}</span>
                </div>
              ))}
            </div>
          )}
          <span
            id={liveId}
            aria-live="polite"
            style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}
          >
            {readout}
          </span>
        </div>
      )}
    </div>
  );
}

const axisText = { fontSize: 11, fill: 'var(--text-faint)', fontFamily: 'var(--font-mono)' } as const;
const th = {
  textAlign: 'left',
  fontWeight: 500,
  color: 'var(--text-faint)',
  padding: '6px 8px',
  borderBottom: '1px solid var(--line)',
  position: 'sticky',
  top: 0,
  background: 'var(--surface)',
} as const;
const td = { padding: '5px 8px', borderBottom: '1px solid var(--line-soft)', color: 'var(--text)' } as const;
