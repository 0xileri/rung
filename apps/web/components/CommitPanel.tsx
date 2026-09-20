'use client';

import { useMemo, useState } from 'react';
import { quoteStrike, type PreStockAsset } from '../../../packages/sdk/src/valuation.ts';
import { band, pct, usd, valuation } from '../lib/format';

/**
 * Turn "I would own OpenAI around $1.0T" into fixed, escrowable terms.
 *
 * Every number shown here is derived through the SDK rather than recomputed locally, so the
 * figure the user reads is the same one the transaction carries. The two values that are
 * easy to get wrong — the active ScaledUiAmount multiplier and the current transfer-fee
 * slot — arrive already resolved from the server.
 */

const EXPIRIES = [
  { days: 7, label: '7 days' },
  { days: 14, label: '14 days' },
  { days: 30, label: '30 days' },
];

export function CommitPanel({
  symbol,
  markPrice,
  markValuation,
  impliedValuation,
  decimals,
  multiplier,
  feeBps,
  bands,
  disabled,
}: {
  symbol: string;
  markPrice: number;
  markValuation: number;
  impliedValuation: number;
  decimals: number;
  multiplier: number;
  feeBps: number;
  bands: number[];
  disabled?: boolean;
}) {
  // Default to the band nearest 80% of mark: far enough below market to be a real
  // commitment rather than a spot buy in disguise.
  const [target, setTarget] = useState(
    () => bands.reduce((best, b) => (Math.abs(b - markValuation * 0.8) < Math.abs(best - markValuation * 0.8) ? b : best), bands[0]),
  );
  const [size, setSize] = useState(100);
  const [expiryDays, setExpiryDays] = useState(30);
  const [premium, setPremium] = useState(4.6);
  const [understood, setUnderstood] = useState(false);

  const quote = useMemo(() => {
    const asset: PreStockAsset = {
      symbol,
      name: symbol,
      contract_address: '',
      tokenPrice: 0,
      impliedValuation,
      markPrice,
      markValuation,
      supply: 0,
    };
    try {
      return quoteStrike({
        asset,
        targetValuation: target,
        strikeUsd: size,
        decimals,
        multiplier,
        transferFee: {
          epoch: 0n,
          transferFeeBasisPoints: feeBps,
          maximumFee: 2n ** 64n - 1n,
        },
      });
    } catch {
      return null;
    }
  }, [symbol, target, size, decimals, multiplier, feeBps, impliedValuation, markPrice, markValuation]);

  const premiumPct = size > 0 ? premium / size : 0;
  const ready = !disabled && !!quote && understood && size > 0;

  const row = (label: string, value: string, accent?: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
      <span style={{ color: '#A8ABB2' }}>{label}</span>
      <span className="fig" style={{ color: accent ?? 'var(--paper)' }}>
        {value}
      </span>
    </div>
  );

  return (
    <section
      style={{ background: 'var(--ink)', borderRadius: 'var(--radius-lg)', padding: '24px 26px' }}
    >
      <h2 className="label" style={{ color: '#8B9099', marginBottom: 18 }}>
        Commit at a valuation
      </h2>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
        <label style={{ display: 'block' }}>
          <span style={{ display: 'block', fontSize: 12, color: '#A8ABB2', marginBottom: 6 }}>
            I would own around
          </span>
          <select
            value={target}
            onChange={(e) => setTarget(Number(e.target.value))}
            style={{ background: '#1A1F27', borderColor: '#262A32', color: 'var(--paper)' }}
          >
            {bands.map((b) => (
              <option key={b} value={b}>
                {band(b)} &nbsp;({pct((b - impliedValuation) / impliedValuation, 1)} vs market)
              </option>
            ))}
          </select>
        </label>

        <div style={{ display: 'flex', gap: 12 }}>
          <label style={{ flexGrow: 1 }}>
            <span style={{ display: 'block', fontSize: 12, color: '#A8ABB2', marginBottom: 6 }}>
              Position size (USDC)
            </span>
            <input
              type="number"
              min={1}
              step={1}
              value={size}
              onChange={(e) => setSize(Math.max(0, Number(e.target.value)))}
              style={{ background: '#1A1F27', borderColor: '#262A32', color: 'var(--paper)' }}
            />
          </label>
          <label style={{ flexGrow: 1 }}>
            <span style={{ display: 'block', fontSize: 12, color: '#A8ABB2', marginBottom: 6 }}>
              Premium asked
            </span>
            <input
              type="number"
              min={0}
              step={0.1}
              value={premium}
              onChange={(e) => setPremium(Math.max(0, Number(e.target.value)))}
              style={{ background: '#1A1F27', borderColor: '#262A32', color: 'var(--paper)' }}
            />
          </label>
        </div>

        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontSize: 12, color: '#A8ABB2', marginBottom: 6, padding: 0 }}>
            Expiry
          </legend>
          <div style={{ display: 'flex', gap: 8 }}>
            {EXPIRIES.map((e) => (
              <button
                key={e.days}
                type="button"
                onClick={() => setExpiryDays(e.days)}
                className="fig"
                style={{
                  flexGrow: 1,
                  minHeight: 44,
                  fontSize: 13,
                  cursor: 'pointer',
                  borderRadius: 'var(--radius-sm)',
                  border: `1px solid ${expiryDays === e.days ? 'var(--amber-fill)' : '#262A32'}`,
                  background: expiryDays === e.days ? 'rgba(201,138,60,0.14)' : 'transparent',
                  color: expiryDays === e.days ? 'var(--amber-fill)' : '#A8ABB2',
                }}
              >
                {e.label}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      {quote && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 9,
            paddingTop: 18,
            borderTop: '1px solid #262A32',
          }}
        >
          <div className="label" style={{ color: '#8B9099', marginBottom: 3 }}>
            Reality check
          </div>
          {row('Target valuation', valuation(target))}
          {row('vs market', pct(quote.discountToMarket))}
          {row('vs mark', pct(quote.discountToMark))}
          {row('Fixed strike', `$${quote.targetTokenPrice.toFixed(4)}`)}
          {row('PreStock if exercised', quote.uiQuantity.toFixed(8))}
          <div style={{ height: 1, background: '#262A32', margin: '3px 0' }} />
          {row('USDC locked', usd(size))}
          {row('Premium received', usd(premium), 'var(--amber-fill)')}
          {row('Premium / collateral', pct(premiumPct), 'var(--amber-fill)')}
          {row('Transfer fee, round trip', pct(quote.roundTripFeeFraction))}
        </div>
      )}

      <p
        style={{
          fontSize: 11,
          lineHeight: 1.5,
          color: '#8B9099',
          margin: '16px 0 14px',
        }}
      >
        The strike is fixed at creation. If {symbol}&rsquo;s valuation changes afterwards, this
        agreement does not change with it. The round-trip transfer fee is charged by the mint,
        not by Limit+, and is not refunded.
      </p>

      <label
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 9,
          fontSize: 12,
          color: '#A8ABB2',
          marginBottom: 14,
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={understood}
          onChange={(e) => setUnderstood(e.target.checked)}
          style={{ width: 16, height: 16, minHeight: 16, marginTop: 2, flexShrink: 0 }}
        />
        <span>
          I understand this is not a limit order. If a holder exercises, I receive {symbol} and
          they receive my USDC.
        </span>
      </label>

      <button type="button" className="btn" disabled={!ready} style={{ width: '100%' }}>
        {disabled ? 'Unavailable for this asset' : `Lock ${usd(size)} USDC`}
      </button>
    </section>
  );
}
