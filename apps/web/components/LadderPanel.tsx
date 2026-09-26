'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { quoteStrike, type PreStockAsset } from '../../../packages/sdk/src/valuation.ts';
import { planLadder, type LadderShape } from '../../../packages/sdk/src/ladder.ts';
import {
  buildCreateCommitment,
  explainError,
  getProgram,
  loadProtocolAccounts,
  MAX_STRIKE_USD,
  type ProtocolLoadResult,
} from '../lib/program';
import { signAndSendPacked } from '../lib/pack';
import { CLUSTER } from '../lib/chain';
import { band, explorer, fromQuote, shortKey, toQuote, usd } from '../lib/format';

/**
 * Commit across a range of valuations in one go.
 *
 * A maker rarely has one number in mind — "I'd own OpenAI at a trillion, and more of it the
 * cheaper it gets" is a curve. This splits one amount across every band in a range, each rung
 * an ordinary commitment with the same premium rate and deadline, and asks the wallet to sign
 * them together. On chain they are independent: a holder can take any rung, or a slice of it,
 * and the maker can withdraw any rung, without touching the rest.
 *
 * The split is the SDK's planLadder (whole cents, exact total, within the per-position cap),
 * and each rung is priced by the same quoteStrike the single commitment uses, so a ladder
 * rung and a hand-made commitment at the same valuation are indistinguishable on chain.
 */

const EXPIRIES = [7, 14, 30];
const MIN_RUNG_USD = 10;
const MAX_RUNGS = 6;

type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; note: string }
  | { kind: 'done'; signatures: string[]; rungs: number; totalUsd: number }
  | { kind: 'partial'; signatures: string[]; rungs: number; of: number; message: string }
  | { kind: 'error'; message: string };

export function LadderPanel({
  symbol,
  stockMint,
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
  stockMint: string;
  markPrice: number;
  markValuation: number;
  impliedValuation: number;
  decimals: number;
  multiplier: number;
  feeBps: number;
  bands: number[];
  disabled?: boolean;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();

  const sorted = useMemo(() => [...bands].sort((a, b) => a - b), [bands]);
  const [low, setLow] = useState(() => sorted[0] ?? 0);
  const [high, setHigh] = useState(() => sorted[Math.min(3, sorted.length - 1)] ?? 0);
  const [total, setTotal] = useState('400');
  const [shape, setShape] = useState<LadderShape>('lower-heavy');
  const [ratePct, setRatePct] = useState('4');
  const [expiryDays, setExpiryDays] = useState(30);
  const [understood, setUnderstood] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [protocol, setProtocol] = useState<ProtocolLoadResult | 'loading'>('loading');

  useEffect(() => {
    let live = true;
    if (!wallet.publicKey) return;
    (async () => {
      const result = await loadProtocolAccounts(getProgram(connection, wallet as never), new PublicKey(stockMint));
      if (live) setProtocol(result);
    })();
    return () => {
      live = false;
    };
  }, [connection, wallet.publicKey, stockMint]);

  const rate = Math.max(0, Number(ratePct) || 0) / 100;

  /** The split, then each rung priced exactly as a single commitment would be. */
  const plan = useMemo(() => {
    const totalQuote = toQuote(Number(total));
    if (totalQuote <= 0n) return { error: 'Enter how much to commit across the range.' } as const;
    const ladder = planLadder({
      bands: sorted,
      lowUsd: low,
      highUsd: high,
      totalQuote,
      shape,
      minRungQuote: toQuote(MIN_RUNG_USD),
      maxRungQuote: Number.isFinite(MAX_STRIKE_USD) ? toQuote(MAX_STRIKE_USD) : 2n ** 63n,
      maxRungs: MAX_RUNGS,
    });
    if (!ladder.ok) return { error: ladder.detail } as const;

    const asset: PreStockAsset = {
      symbol,
      name: symbol,
      contract_address: stockMint,
      tokenPrice: 0,
      impliedValuation,
      markPrice,
      markValuation,
      supply: 0,
    };
    try {
      const rungs = ladder.rungs.map((r) => {
        const strikeUsd = fromQuote(r.strikeQuote);
        const quote = quoteStrike({
          asset,
          targetValuation: r.valuationUsd,
          strikeUsd,
          decimals,
          multiplier,
          transferFee: { epoch: 0n, transferFeeBasisPoints: feeBps, maximumFee: 2n ** 64n - 1n },
        });
        return { ...r, quote, premiumQuote: toQuote(strikeUsd * rate) };
      });
      return { rungs, totalQuote } as const;
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) } as const;
    }
  }, [total, sorted, low, high, shape, rate, symbol, stockMint, impliedValuation, markPrice, markValuation, decimals, multiplier, feeBps]);

  // TypeScript widens the two shapes plan can take into one with optional fields, so read
  // them as optional rather than narrowing with 'in'.
  const rungs = plan.rungs ?? [];
  const planError = plan.error ?? null;
  // What the rungs will actually escrow, from their own quotes: the figure on the button is
  // the figure the chain will hold, whatever rounding happened on the way.
  const planTotal = rungs.reduce((s, r) => s + r.quote.strikeQuoteAmount, 0n);
  const premiumTotal = rungs.reduce((s, r) => s + r.premiumQuote, 0n);
  const busy = phase.kind === 'working';

  const submit = useCallback(async () => {
    if (!wallet.publicKey || rungs.length === 0) return;
    if (protocol === 'loading' || !protocol.ok) {
      setPhase({ kind: 'error', message: protocol === 'loading' ? 'Still checking the market on chain.' : protocol.detail });
      return;
    }
    if (protocol.accounts.paused || !protocol.accounts.marketEnabled) {
      setPhase({ kind: 'error', message: 'This market is not accepting new commitments right now.' });
      return;
    }
    try {
      setPhase({ kind: 'working', note: 'Building transactions' });
      const program = getProgram(connection, wallet as never);
      const expiryTs = Math.floor(Date.now() / 1000) + expiryDays * 86_400;
      const ixs: TransactionInstruction[] = [];
      for (const r of rungs) {
        const { instruction } = await buildCreateCommitment(program, {
          maker: wallet.publicKey,
          accounts: protocol.accounts,
          stockRawRequired: r.quote.rawQuantity,
          strikeQuoteAmount: r.quote.strikeQuoteAmount,
          premiumQuoteAmount: r.premiumQuote,
          expiryTs,
          targetValuationUsd: BigInt(Math.round(r.valuationUsd)),
        });
        ixs.push(instruction);
      }
      const result = await signAndSendPacked(connection, wallet, ixs, (note) => setPhase({ kind: 'working', note }));
      if (result.failure) {
        setPhase({ kind: 'partial', signatures: result.signatures, rungs: result.landed, of: rungs.length, message: result.failure });
      } else {
        const landedQuote = rungs.slice(0, result.landed).reduce((s, r) => s + r.quote.strikeQuoteAmount, 0n);
        setPhase({ kind: 'done', signatures: result.signatures, rungs: result.landed, totalUsd: fromQuote(landedQuote) });
        // Clearing the acknowledgment disables the button, so a second click cannot quietly
        // commit the same ladder twice; locking another is a fresh, deliberate decision.
        setUnderstood(false);
      }
    } catch (err) {
      setPhase({ kind: 'error', message: explainError(err) });
    }
  }, [wallet, rungs, protocol, connection, expiryDays]);

  const ready = !disabled && rungs.length > 0 && understood && !busy;

  return (
    <section className="card" style={{ padding: '22px 24px' }}>
      <h2 className="label" style={{ marginBottom: 6 }}>
        Commit across a range
      </h2>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 16px', lineHeight: 1.55 }}>
        Put up a curve rather than a point: one amount, split across every valuation in a range,
        each rung its own commitment. Holders can take any rung or a slice of it.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
        <label style={field}>
          <span style={fieldLabel}>From</span>
          <select value={low} onChange={(e) => setLow(Number(e.target.value))}>
            {sorted.map((b) => (
              <option key={b} value={b}>
                {band(b)}
              </option>
            ))}
          </select>
        </label>
        <label style={field}>
          <span style={fieldLabel}>To</span>
          <select value={high} onChange={(e) => setHigh(Number(e.target.value))}>
            {sorted.map((b) => (
              <option key={b} value={b}>
                {band(b)}
              </option>
            ))}
          </select>
        </label>
        <label style={field}>
          <span style={fieldLabel}>Total USDC</span>
          <input inputMode="decimal" className="fig" value={total} onChange={(e) => setTotal(e.target.value)} />
        </label>
        <label style={field}>
          <span style={fieldLabel}>Premium, % of each rung</span>
          <input inputMode="decimal" className="fig" value={ratePct} onChange={(e) => setRatePct(e.target.value)} />
        </label>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }} role="radiogroup" aria-label="How to split it">
        {([
          ['lower-heavy', 'More at lower valuations'],
          ['even', 'Evenly'],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={shape === value}
            onClick={() => setShape(value)}
            style={chip(shape === value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }} role="radiogroup" aria-label="Deadline">
        {EXPIRIES.map((d) => (
          <button key={d} type="button" role="radio" aria-checked={expiryDays === d} onClick={() => setExpiryDays(d)} style={chip(expiryDays === d)}>
            {d} days
          </button>
        ))}
      </div>

      {planError ? (
        <p className="callout callout-caution" style={{ margin: '0 0 14px' }}>
          {planError}
        </p>
      ) : (
        <div style={{ background: 'var(--paper)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', marginBottom: 14 }}>
          {rungs
            .slice()
            .reverse()
            .map((r) => (
              <div key={r.valuationUsd} style={{ display: 'flex', gap: 10, fontSize: 13, padding: '3px 0', alignItems: 'baseline' }}>
                <span className="fig" style={{ width: 62 }}>
                  {band(r.valuationUsd)}
                </span>
                <span className="fig" style={{ flex: 1 }}>
                  {usd(fromQuote(r.quote.strikeQuoteAmount))}
                </span>
                <span className="fig" style={{ color: 'var(--text-muted)' }}>
                  {usd(r.quote.targetTokenPrice)}/token
                </span>
              </div>
            ))}
          <div style={{ borderTop: '1px solid var(--line)', marginTop: 6, paddingTop: 6, display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span style={{ color: 'var(--text-muted)' }}>Premium if every rung is taken</span>
            <span className="fig" style={{ color: 'var(--amber-ink)' }}>
              {usd(fromQuote(premiumTotal))}
            </span>
          </div>
        </div>
      )}

      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, color: 'var(--text-muted)', marginBottom: 14, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={understood}
          onChange={(e) => setUnderstood(e.target.checked)}
          style={{ width: 16, height: 16, minHeight: 16, marginTop: 2, flexShrink: 0 }}
        />
        <span>
          I understand these are not limit orders. If a holder exercises any rung, I receive {symbol}{' '}
          and they receive that rung&rsquo;s USDC.
        </span>
      </label>

      {phase.kind === 'done' && (
        <p className="callout" style={{ margin: '0 0 12px' }}>
          {usd(phase.totalUsd)} committed across {phase.rungs} valuation{phase.rungs === 1 ? '' : 's'}.{' '}
          <Links signatures={phase.signatures} />
        </p>
      )}
      {phase.kind === 'partial' && (
        <p className="callout callout-caution" style={{ margin: '0 0 12px' }}>
          {phase.rungs} of {phase.of} rungs committed, then stopped: {phase.message} The rungs that went through are
          live on the curve. <Links signatures={phase.signatures} />
        </p>
      )}
      {phase.kind === 'error' && (
        <p className="callout callout-caution" style={{ margin: '0 0 12px' }}>
          {phase.message}
        </p>
      )}

      {!wallet.publicKey ? (
        <button type="button" className="btn" style={{ width: '100%' }} onClick={() => setVisible(true)}>
          Connect wallet
        </button>
      ) : (
        <button type="button" className="btn" style={{ width: '100%' }} disabled={!ready} onClick={submit}>
          {busy
            ? `${phase.note}…`
            : rungs.length
              ? `Lock ${usd(fromQuote(planTotal))} across ${rungs.length} valuation${rungs.length === 1 ? '' : 's'}`
              : 'Lock the ladder'}
        </button>
      )}
    </section>
  );
}

function Links({ signatures }: { signatures: string[] }) {
  return (
    <>
      {signatures.map((sig, i) => (
        <a key={sig} className="fig" style={{ fontSize: 12, marginRight: 8 }} href={explorer('tx', sig, CLUSTER)} target="_blank" rel="noreferrer">
          tx {i + 1} {shortKey(sig, 4, 4)} &#8599;
        </a>
      ))}
    </>
  );
}

const field = { display: 'flex', flexDirection: 'column', gap: 4 } as const;
const fieldLabel = { fontSize: 11, color: 'var(--text-faint)' } as const;
const chip = (active: boolean) =>
  ({
    padding: '6px 12px',
    fontSize: 12,
    borderRadius: 999,
    cursor: 'pointer',
    border: `1px solid ${active ? 'var(--amber-fill)' : 'var(--line)'}`,
    background: active ? 'var(--amber-wash)' : 'transparent',
    color: active ? 'var(--amber-ink)' : 'var(--text-muted)',
    fontWeight: 500,
  }) as const;
