'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { pct, valuation } from '../lib/format';

export type SwitcherOption = {
  symbol: string;
  name: string;
  marketValuation: number;
  /** Market relative to the PreStocks mark. */
  vsMark: number;
};

/**
 * The page's asset name, as a menu of every PreStock tradable on this deployment.
 *
 * Switching keeps the reader on the same kind of page: from a commit page to another commit
 * page, from Protect to Protect. Only tradable markets are offered, so the menu never leads
 * to a page whose form is disabled.
 */
export function AssetSwitcher({
  current,
  options,
  page,
  prefix = '',
}: {
  current: SwitcherOption;
  options: SwitcherOption[];
  page: 'asset' | 'protect';
  prefix?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className="label"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: 'none',
          border: '1px solid var(--line)',
          borderRadius: 999,
          padding: '4px 10px 4px 12px',
          cursor: 'pointer',
          color: 'inherit',
        }}
      >
        {prefix}
        {current.name}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden style={{ transform: open ? 'rotate(180deg)' : undefined }}>
          <path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          className="card"
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            zIndex: 40,
            minWidth: 280,
            padding: 6,
            boxShadow: 'var(--shadow-soft)',
          }}
        >
          {options.map((o) => {
            const active = o.symbol === current.symbol;
            return (
              <Link
                key={o.symbol}
                role="menuitem"
                href={`/${page}/${o.symbol}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => setOpen(false)}
                className="switcher-row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto auto',
                  alignItems: 'baseline',
                  gap: 14,
                  padding: '9px 10px',
                  borderRadius: 'var(--radius-sm)',
                  textDecoration: 'none',
                  color: 'var(--text)',
                  background: active ? 'var(--surface-muted)' : undefined,
                }}
              >
                <span style={{ fontSize: 14, fontWeight: active ? 600 : 500 }}>
                  {o.name}
                  <span className="fig" style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-faint)' }}>
                    {o.symbol}
                  </span>
                </span>
                <span className="fig" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {valuation(o.marketValuation)}
                </span>
                <span
                  className="fig"
                  style={{ fontSize: 11, width: 52, textAlign: 'right', color: o.vsMark >= 0 ? 'var(--amber-ink)' : 'var(--teal-ink)' }}
                >
                  {pct(o.vsMark, 1)}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
