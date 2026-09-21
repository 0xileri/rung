'use client';

import { useCallback, useEffect, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { fetchPositions, CLUSTER, type Position } from '../lib/chain';
import { derivePositionAuthority } from '../lib/program';
import { PublicKey, type ParsedAccountData } from '@solana/web3.js';
import {
  activeMultiplier,
  activeTransferFee,
  amountReceived,
  rawToUi,
  type TransferFee,
} from '../../../packages/sdk/src/token2022.ts';
import { positionPnl, type PnlBasis } from '../../../packages/sdk/src/pnl.ts';
import { symbolForMint, type MintedAsset } from '../lib/deployment';

type MintScale = { decimals: number; multiplier: number; fee: TransferFee | null };
import { dateTime, daysUntil, explorer, fromQuote, shortKey, usd, valuation } from '../lib/format';
import { PositionActions } from './PositionActions';

/**
 * A wallet's positions, on both sides of the trade.
 *
 * Everything shown is read from chain rather than from anything the interface remembers. The
 * escrowed figures in particular are the vault's real balances: under a transfer fee the
 * amount escrowed is always less than the amount sent, so a UI that echoed back the intended
 * number would quietly disagree with the chain.
 */

const STATUS_COLOR: Record<string, string> = {
  Open: 'var(--amber-ink)',
  Matched: 'var(--teal-ink)',
  Exercised: 'var(--text-muted)',
  Expired: 'var(--text-muted)',
  Cancelled: 'var(--text-faint)',
};

export function PositionList() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const [positions, setPositions] = useState<Position[] | null>(null);
  // Kept so an empty result can distinguish "you have none" from "none exist at all".
  const [totalOnChain, setTotalOnChain] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Per-mint scale and fee, read from chain. Wallets show the multiplier-scaled amount, so a
  // raw quantity here would disagree with them by that factor (1.486 for OpenAI, 5 for
  // SpaceX); the fee decides how many tokens actually leave a vault on settlement.
  const [mintScale, setMintScale] = useState<Record<string, MintScale>>({});

  useEffect(() => {
    if (!positions?.length) return;
    const mints = [...new Set(positions.map((p) => p.stockMint))];
    let live = true;
    (async () => {
      const [infos, { epoch }] = await Promise.all([
        connection.getMultipleParsedAccounts(mints.map((m) => new PublicKey(m))),
        connection.getEpochInfo(),
      ]);
      const now = Math.floor(Date.now() / 1000);
      const out: Record<string, MintScale> = {};
      infos.value.forEach((acc, i) => {
        const info = (acc?.data as ParsedAccountData | undefined)?.parsed?.info;
        if (!info) return;
        const exts = (info.extensions ?? []) as { extension: string; state: Record<string, any> }[];
        const scale = exts.find((e) => e.extension === 'scaledUiAmountConfig')?.state;
        const fees = exts.find((e) => e.extension === 'transferFeeConfig')?.state;
        const toFee = (f: { epoch: number; transferFeeBasisPoints: number; maximumFee: number }): TransferFee => ({
          epoch: BigInt(f.epoch),
          transferFeeBasisPoints: Number(f.transferFeeBasisPoints),
          maximumFee: BigInt(f.maximumFee),
        });
        out[mints[i]] = {
          decimals: Number(info.decimals),
          multiplier: scale
            ? activeMultiplier(
                {
                  multiplier: Number(scale.multiplier),
                  newMultiplier: Number(scale.newMultiplier),
                  newMultiplierEffectiveTimestamp: Number(scale.newMultiplierEffectiveTimestamp),
                },
                now,
              )
            : 1,
          fee: fees
            ? activeTransferFee(
                { olderTransferFee: toFee(fees.olderTransferFee), newerTransferFee: toFee(fees.newerTransferFee) },
                BigInt(epoch),
              )
            : null,
        };
      });
      if (live) setMintScale(out);
    })().catch(() => {
      // Nothing to recover: quantities render labelled "raw", and P&L as unavailable, until
      // a scale is known, so a failure here is visible rather than silently mis-scaled.
    });
    return () => {
      live = false;
    };
  }, [connection, positions]);

  // Market price per UI token, by symbol, from the same server cache the asset pages use.
  const [prices, setPrices] = useState<{ bySymbol: Record<string, number>; assets: MintedAsset[] } | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/prestocks')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: { assets: (MintedAsset & { tokenPrice: number })[] }) => {
        if (!live) return;
        setPrices({
          bySymbol: Object.fromEntries(body.assets.map((a) => [a.symbol, a.tokenPrice])),
          assets: body.assets,
        });
      })
      .catch(() => {
        // P&L that needs a price then reads "unavailable" rather than being guessed.
      });
    return () => {
      live = false;
    };
  }, []);

  const pnlFor = (p: Position, side: 'maker' | 'holder') => {
    const s = mintScale[p.stockMint];
    const symbol = prices ? symbolForMint(p.stockMint, prices.assets) : null;
    const price = symbol && prices ? prices.bySymbol[symbol] ?? null : null;
    // Exercise and expiry zero the escrow fields once the vaults are empty. The required
    // quantity stands in after that: the escrow was sized to land on it at the worse fee
    // slot, so it matches what was delivered to within the slots' spread, and never exceeds it.
    const escrowedRaw = p.stockRawEscrowed > 0n ? p.stockRawEscrowed : p.stockRawRequired;
    const outRaw = s?.fee ? amountReceived(escrowedRaw, s.fee) : escrowedRaw;
    return {
      symbol,
      price,
      ...positionPnl({
        side,
        status: p.status,
        strikeUsd: fromQuote(p.strikeQuoteEscrowed || p.strikeQuoteAmount),
        premiumUsd: fromQuote(p.premiumQuoteAmount),
        stockOutUi: s ? rawToUi(outRaw, s.decimals, s.multiplier) : 0,
        // Without the mint's scale the token count is unknown, so no price can be applied.
        tokenPrice: s ? price : null,
      }),
    };
  };

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
    const mine = result.positions.filter(
      (p) => p.maker === publicKey.toBase58() || p.taker === publicKey.toBase58(),
    );
    setPositions(mine.sort((a, b) => b.createdAt - a.createdAt));
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

  const pnls = positions.map((p) => pnlFor(p, p.maker === publicKey?.toBase58() ? 'maker' : 'holder'));
  const counted = pnls.filter((x) => x.basis !== 'none');
  const unpriced = counted.filter((x) => x.usd === null).length;
  const total = counted.reduce((sum, x) => sum + (x.usd ?? 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {counted.length > 0 && (
        <section className="card" style={{ padding: '18px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
            <span className="label">Net P&amp;L</span>
            <span className="fig" style={{ fontSize: 26, color: pnlColor(unpriced === counted.length ? null : total) }}>
              {unpriced === counted.length ? '—' : signedUsd(total)}
            </span>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              across {counted.length} matched position{counted.length === 1 ? '' : 's'}
              {unpriced > 0 && `, ${unpriced} without a live price`}
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
        const isMaker = p.maker === publicKey?.toBase58();
        const authority = derivePositionAuthority(new PublicKey(p.pubkey));
        const strike = fromQuote(p.strikeQuoteEscrowed || p.strikeQuoteAmount);
        const premium = fromQuote(p.premiumQuoteAmount);
        const settled = p.status === 'Exercised' || p.status === 'Expired' || p.status === 'Cancelled';
        const pastExpiry = !settled && Date.now() / 1000 >= p.expiryTs;

        // Every date is read off the Position account, which records each transition.
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
                  {pastExpiry ? 'Past expiry, ready to settle' : `${daysUntil(p.expiryTs)}d to expiry`}
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
              <PnlField status={p.status} pnl={pnlFor(p, isMaker ? 'maker' : 'holder')} />
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

const signedUsd = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${usd(Math.abs(n))}`;
const pnlColor = (n: number | null) =>
  n === null || Math.abs(n) < 0.005 ? 'var(--text-muted)' : n > 0 ? 'var(--teal-ink)' : 'var(--danger)';

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
  status: Position['status'];
  pnl: { usd: number | null; basis: PnlBasis; price: number | null; symbol: string | null };
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
