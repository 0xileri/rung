'use client';

import { useCallback, useEffect, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { fetchPositions, CLUSTER, type Position } from '../lib/chain';
import { derivePositionAuthority } from '../lib/program';
import { PublicKey } from '@solana/web3.js';
import { daysUntil, explorer, fromQuote, shortKey, usd, valuation } from '../lib/format';
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {positions.map((p) => {
        const isMaker = p.maker === publicKey?.toBase58();
        const authority = derivePositionAuthority(new PublicKey(p.pubkey));
        const strike = fromQuote(p.strikeQuoteEscrowed || p.strikeQuoteAmount);
        const premium = fromQuote(p.premiumQuoteAmount);
        const settled = p.status === 'Exercised' || p.status === 'Expired' || p.status === 'Cancelled';

        return (
          <article key={p.pubkey} className="card" style={{ padding: '22px 24px' }}>
            <header
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 14,
                flexWrap: 'wrap',
                marginBottom: 18,
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
                <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                  {daysUntil(p.expiryTs)}d to expiry
                </span>
              )}
            </header>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: 16,
                marginBottom: 18,
              }}
            >
              <Field label="Creation target" value={valuation(p.targetValuationUsd)} />
              <Field label="USDC strike" value={usd(strike)} />
              <Field
                label={isMaker ? 'Premium received' : 'Premium paid'}
                value={usd(premium)}
                accent="var(--amber-ink)"
              />
              <Field
                label="PreStock quantity"
                value={(Number(p.stockRawEscrowed || p.stockRawRequired) / 1e9).toFixed(8)}
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
                value={(Number(p.stockRawEscrowed) / 1e9).toFixed(9)}
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
