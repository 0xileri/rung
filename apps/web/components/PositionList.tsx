'use client';

import { useCallback, useEffect, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { fetchPositions, CLUSTER } from '../lib/chain';
import { holdingsFor, isSettled, type Holding } from '../lib/holdings';
import { derivePositionAuthority } from '../lib/program';
import { PublicKey } from '@solana/web3.js';
import { rawToUi } from '../../../packages/sdk/src/token2022.ts';
import type { PnlBasis } from '../../../packages/sdk/src/pnl.ts';
import {
  pnlColor,
  pnlForPosition,
  readMintScales,
  totalPnl,
  type MintScale,
  type PositionPnlView,
} from '../lib/pnl';
import { usePriceBook } from '../lib/use-price-book';
import { dateTime, explorer, fromQuote, shortKey, signedUsd, timeUntil, usd, valuation } from '../lib/format';
import { PositionActions } from './PositionActions';

/**
 * A wallet's positions, on both sides of the trade.
 *
 * One row is one relationship: a slice someone took, or capital still on offer. A commitment
 * several holders took therefore appears once per holder, each with its own dates, collateral
 * and P&L, because that is what each of those agreements actually is.
 *
 * Everything shown is read from chain rather than from anything the interface remembers. The
 * escrowed figures in particular are the vault's real balances: under a transfer fee the
 * amount escrowed is always less than the amount sent, so a UI that echoed back the intended
 * number would quietly disagree with the chain.
 */

const STATUS_COLOR: Record<string, string> = {
  Open: 'var(--amber-ink)',
  PartiallyMatched: 'var(--amber-ink)',
  Matched: 'var(--teal-ink)',
  Exercised: 'var(--text-muted)',
  Expired: 'var(--text-muted)',
  Cancelled: 'var(--text-faint)',
};

export function PositionList() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const [positions, setPositions] = useState<Holding[] | null>(null);
  // Kept so an empty result can distinguish "you have none" from "none exist at all".
  const [totalOnChain, setTotalOnChain] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Per-mint scale and fee, read from chain. Wallets show the multiplier-scaled amount, so a
  // raw quantity here would disagree with them by that factor (1.486 for OpenAI, 5 for
  // SpaceX); the fee decides how many tokens actually leave a vault on settlement.
  const [mintScale, setMintScale] = useState<Record<string, MintScale>>({});

  useEffect(() => {
    if (!positions?.length) return;
    let live = true;
    readMintScales(
      connection,
      positions.map((p) => p.stockMint),
    )
      .then((out) => {
        if (live) setMintScale(out);
      })
      .catch(() => {
      // Nothing to recover: quantities render labelled "raw", and P&L as unavailable, until
      // a scale is known, so a failure here is visible rather than silently mis-scaled.
    });
    return () => {
      live = false;
    };
  }, [connection, positions]);

  // Market price per UI token, by symbol, from the same server cache the asset pages use.
  const prices = usePriceBook();

  const pnlFor = (p: Holding, side: 'maker' | 'holder') =>
    pnlForPosition(p, side, mintScale[p.stockMint], prices);

  const quantity = (mint: string, raw: bigint, digits: number) => {
    const s = mintScale[mint];
    return s ? rawToUi(raw, s.decimals, s.multiplier).toFixed(digits) : `${raw.toString()} raw`;
  };

  const load = useCallback(async () => {
    if (!publicKey) return;
    const result = await fetchPositions(connection);
    if (!result.ok) {
      setLoadError(result.detail);
      setPositions([]);
      return;
    }
    setLoadError(null);
    setTotalOnChain(result.positions.length);
    setPositions(holdingsFor(result.positions, result.fills, publicKey.toBase58()));
  }, [connection, publicKey]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!connected) {
    return (
      <div className="card" style={{ padding: '32px 28px', textAlign: 'center' }}>
        <p style={{ fontSize: 15, color: 'var(--text-muted)', margin: '0 0 16px' }}>
          Connect a wallet to see your positions.
        </p>
        <button type="button" className="btn" onClick={() => setVisible(true)}>
          Connect wallet
        </button>
      </div>
    );
  }

  if (positions === null) {
    return (
      <p className="card" style={{ padding: '20px 22px', fontSize: 14, color: 'var(--text-muted)' }}>
        Reading positions from chain&hellip;
      </p>
    );
  }

  if (loadError) {
    return (
      <p
        className="card"
        style={{ padding: '20px 22px', fontSize: 14, color: 'var(--caution)', borderColor: 'var(--caution)' }}
      >
        Could not read positions from chain: {loadError}
      </p>
    );
  }

  if (positions.length === 0) {
    // "No positions" is ambiguous when the cause is being on the wrong account, which is easy
    // to do with multiple wallets and invisible from the screen. Naming the connected address
    // and whether OTHER positions exist turns a dead end into a diagnosis.
    return (
      <div className="card" style={{ padding: '20px 22px' }}>
        <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0 }}>
          No positions for{' '}
          <span className="fig" style={{ color: 'var(--text)' }}>
            {shortKey(publicKey!.toBase58(), 6, 6)}
          </span>{' '}
          on {CLUSTER}.
        </p>
        {totalOnChain > 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-faint)', margin: '10px 0 0', lineHeight: 1.55 }}>
            There {totalOnChain === 1 ? 'is' : 'are'} <strong>{totalOnChain}</strong> position
            {totalOnChain === 1 ? '' : 's'} on this deployment held by other wallets. If you
            expected one of them here, you are probably connected as a different account than
            the one that signed it &mdash; switch accounts in your wallet.
          </p>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--text-faint)', margin: '10px 0 0', lineHeight: 1.55 }}>
            Commit at a valuation, or take the other side of someone else&rsquo;s commitment,
            and it will appear here.
          </p>
        )}
      </div>
    );
  }

  const total = totalPnl(positions.map((p) => pnlFor(p, p.side)));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {total.positions > 0 && (
        <section className="card" style={{ padding: '18px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
            <span className="label">Net P&amp;L</span>
            <span className="fig" style={{ fontSize: 26, color: pnlColor(total.empty ? null : total.usd) }}>
              {total.empty ? '—' : signedUsd(total.usd)}
            </span>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              across {total.positions} matched position{total.positions === 1 ? '' : 's'}
              {total.unpriced > 0 && `, ${total.unpriced} without a live price`}
            </span>
          </div>
          <p style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--text-faint)', margin: '8px 0 0' }}>
            Premiums count once a position is matched. Live positions are valued at what
            exercising would transfer at today&rsquo;s market price, and exercised ones mark the
            delivered tokens at that price. Transfer fees go to the token issuer and are not
            included.
          </p>
        </section>
      )}

      {positions.map((p) => {
        const isMaker = p.side === 'maker';
        const authority = derivePositionAuthority(new PublicKey(p.pubkey));
        const strike = fromQuote(p.strikeQuoteEscrowed || p.strikeQuoteAmount);
        const premium = fromQuote(p.premiumQuoteAmount);
        const settled = isSettled(p);
        const pastExpiry = !settled && Date.now() / 1000 >= p.expiryTs;

        // Every date is read off chain: a fill records its own match and settlement, and the
        // commitment records when it was created and when it expires.
        const timeline: { label: string; ts: number }[] = [{ label: 'Created', ts: p.createdAt }];
        if (p.matchedAt > 0) timeline.push({ label: 'Matched', ts: p.matchedAt });
        if (settled) {
          // An expiry is settled by whoever cranks it, some time after the deadline itself.
          if (p.status === 'Expired') timeline.push({ label: 'Expired', ts: p.expiryTs });
          if (p.settledAt > 0) {
            timeline.push({ label: p.status === 'Expired' ? 'Settled' : p.status, ts: p.settledAt });
          }
        } else {
          timeline.push({ label: pastExpiry ? 'Expired' : 'Expires', ts: p.expiryTs });
        }

        return (
          <article key={p.pubkey} className="card" style={{ padding: '22px 24px' }}>
            <header
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 14,
                flexWrap: 'wrap',
                marginBottom: 10,
              }}
            >
              <span className="label">{isMaker ? 'Valuation buyer' : 'Downside protection'}</span>
              <span
                className="fig"
                style={{ fontSize: 12, color: STATUS_COLOR[p.status] ?? 'var(--text-muted)' }}
              >
                {p.status}
              </span>
              <span style={{ flexGrow: 1 }} />
              {!settled && (
                <span style={{ fontSize: 12, color: pastExpiry ? 'var(--caution)' : 'var(--text-faint)' }}>
                  {pastExpiry ? 'Past expiry, ready to settle' : `${timeUntil(p.expiryTs)} to expiry`}
                </span>
              )}
            </header>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 22px', marginBottom: 18 }}>
              {timeline.map((t) => (
                <div key={t.label} style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{t.label}</span>
                  <time className="fig" dateTime={new Date(t.ts * 1000).toISOString()} style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {dateTime(t.ts)}
                  </time>
                </div>
              ))}
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: 16,
                marginBottom: 18,
              }}
            >
              <PnlField status={p.status} pnl={pnlFor(p, p.side)} />
              <Field label="Creation target" value={valuation(p.targetValuationUsd)} />
              <Field label="USDC strike" value={usd(strike)} />
              <Field
                label={isMaker ? (p.matchedAt > 0 ? 'Premium received' : 'Premium asked') : 'Premium paid'}
                value={usd(premium)}
                accent="var(--amber-ink)"
              />
              <Field
                label="PreStock quantity"
                value={quantity(p.stockMint, p.stockRawEscrowed || p.stockRawRequired, 8)}
              />
            </div>

            {/*
              Proof of collateral. Required vs escrowed are shown as separate numbers rather
              than one "amount", because under a transfer fee they genuinely differ and
              collapsing them would hide the thing most worth checking.
            */}
            <div
              style={{
                background: 'var(--paper)',
                borderRadius: 'var(--radius-sm)',
                padding: '14px 16px',
                marginBottom: 14,
              }}
            >
              <div className="label" style={{ marginBottom: 10 }}>
                Proof of collateral
              </div>
              <Line
                label="USDC escrowed"
                value={usd(fromQuote(p.strikeQuoteEscrowed))}
                ok={p.strikeQuoteEscrowed >= p.strikeQuoteAmount}
                settled={settled}
              />
              <Line
                label="PreStock escrowed"
                value={quantity(p.stockMint, p.stockRawEscrowed, 9)}
                ok={p.stockRawEscrowed >= p.stockRawRequired}
                settled={settled}
              />
              {p.status === 'Matched' && p.stockRawEscrowed > p.stockRawRequired && (
                <p style={{ fontSize: 11, color: 'var(--text-faint)', margin: '8px 0 0' }}>
                  Escrowed slightly exceeds the required quantity: the holder grossed up against
                  the mint&rsquo;s higher fee slot so the transfer would clear on either side of
                  an epoch rollover.
                </p>
              )}
            </div>

            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12 }}>
              <a href={explorer('address', p.pubkey, CLUSTER)} target="_blank" rel="noreferrer">
                Position account &#8599;
              </a>
              <a
                href={explorer('address', authority.toBase58(), CLUSTER)}
                target="_blank"
                rel="noreferrer"
              >
                Vault authority &#8599;
              </a>
              <span className="fig" style={{ color: 'var(--text-faint)' }}>
                {isMaker && p.taker ? `taker ${shortKey(p.taker)}` : ''}
                {isMaker && !p.fillPubkey && p.fillCount > 0
                  ? `${p.fillCount} holder${p.fillCount === 1 ? '' : 's'} took ${usd(fromQuote(p.filledQuote))}`
                  : ''}
                {!isMaker ? `maker ${shortKey(p.maker)}` : ''}
              </span>
            </div>

            <PositionActions position={p} onDone={load} />
          </article>
        );
      })}
    </div>
  );
}

const BASIS_NOTE: Record<PnlBasis, string> = {
  none: '',
  intrinsic: 'unrealized, exercise value',
  marked: 'exercised, tokens at',
  realized: 'final',
};

function PnlField({
  status,
  pnl,
}: {
  status: Holding['status'];
  pnl: PositionPnlView;
}) {
  let value: string;
  let note: string;
  if (pnl.basis === 'none') {
    value = '—';
    note = status === 'Open' ? 'none until matched' : 'nothing exchanged';
  } else if (pnl.usd === null) {
    value = 'Unavailable';
    note = 'no live price right now';
  } else {
    value = signedUsd(pnl.usd);
    const at = pnl.price !== null && pnl.symbol ? ` $${pnl.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}/${pnl.symbol}` : '';
    note = pnl.basis === 'marked' ? `${BASIS_NOTE.marked}${at}` : pnl.basis === 'intrinsic' ? `${BASIS_NOTE.intrinsic}${at ? ` at${at}` : ''}` : BASIS_NOTE.realized;
  }
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 4 }}>Your P&amp;L</div>
      <div className="fig" style={{ fontSize: 15, color: pnlColor(pnl.basis === 'none' ? null : pnl.usd) }}>
        {value}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 3 }}>{note}</div>
    </div>
  );
}

function Field({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 4 }}>{label}</div>
      <div className="fig" style={{ fontSize: 15, color: accent }}>
        {value}
      </div>
    </div>
  );
}

function Line({
  label,
  value,
  ok,
  settled,
}: {
  label: string;
  value: string;
  ok: boolean;
  settled: boolean;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="fig" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        {value}
        {!settled && (
          <span aria-label={ok ? 'covered' : 'short'} style={{ color: ok ? 'var(--teal-ink)' : 'var(--caution)' }}>
            {ok ? '✓' : '⚠'}
          </span>
        )}
      </span>
    </div>
  );
}
