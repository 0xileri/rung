'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey, Transaction } from '@solana/web3.js';
import {
  grossUpForRequired,
  worstCaseTransferFee,
  amountReceived,
  type TransferFee,
} from '../../../packages/sdk/src/token2022.ts';
import {
  buildAcceptCommitment,
  explainError,
  getProgram,
  loadProtocolAccounts,
  type ProtocolAccounts,
} from '../lib/program';
import { fetchPositions, toOpenCommitments, CLUSTER, type Position } from '../lib/chain';
import { band, daysUntil, explorer, fromQuote, shortKey, usd } from '../lib/format';

/**
 * The holder's side: buy a floor from someone who has committed capital at it.
 *
 * The number that matters here is not the one the maker asked for. Under a transfer fee the
 * vault receives less than the holder sends, so the amount to send is grossed up — and
 * deliberately sized against the WORSE of the mint's two fee slots, so the transfer still
 * clears if an epoch rollover flips the rate between loading this page and signing. Both
 * figures are shown, because a holder about to lock tokens should see the difference rather
 * than discover it in their wallet.
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; note: string }
  | { kind: 'done'; signature: string }
  | { kind: 'error'; message: string };

export function ProtectMarket({
  symbol,
  stockMint,
  decimals,
  feeSlots,
}: {
  symbol: string;
  stockMint: string;
  decimals: number;
  feeSlots: { older: number; newer: number; newerEpoch: string };
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();

  const [positions, setPositions] = useState<Position[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [protocol, setProtocol] = useState<ProtocolAccounts | null | 'loading'>('loading');

  const worstFee: TransferFee = useMemo(
    () =>
      worstCaseTransferFee({
        olderTransferFee: { epoch: 0n, transferFeeBasisPoints: feeSlots.older, maximumFee: 2n ** 64n - 1n },
        newerTransferFee: {
          epoch: BigInt(feeSlots.newerEpoch),
          transferFeeBasisPoints: feeSlots.newer,
          maximumFee: 2n ** 64n - 1n,
        },
      }),
    [feeSlots],
  );

  const load = useCallback(async () => {
    const all = await fetchPositions(connection);
    setPositions(all.filter((p) => p.status === 'Open' && p.stockMint === stockMint));
  }, [connection, stockMint]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let live = true;
    if (!wallet.publicKey) return;
    (async () => {
      const program = getProgram(connection, wallet as never);
      const accounts = await loadProtocolAccounts(program, new PublicKey(stockMint));
      if (live) setProtocol(accounts);
    })();
    return () => {
      live = false;
    };
  }, [connection, wallet.publicKey, stockMint]);

  const accept = useCallback(
    async (p: Position) => {
      if (!wallet.publicKey || !wallet.signTransaction) return;
      if (!protocol || protocol === 'loading') {
        setPhase({ kind: 'error', message: 'The program is not deployed on this cluster yet.' });
        return;
      }
      try {
        setPhase({ kind: 'working', note: 'Building transaction' });
        const program = getProgram(connection, wallet as never);
        const toSend = grossUpForRequired(p.stockRawRequired, worstFee);
        const ix = await buildAcceptCommitment(program, {
          taker: wallet.publicKey,
          position: new PublicKey(p.pubkey),
          maker: new PublicKey(p.maker),
          accounts: protocol,
          stockRawToSend: toSend,
        });

        const tx = new Transaction().add(ix);
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;

        setPhase({ kind: 'working', note: 'Waiting for your signature' });
        const signed = await wallet.signTransaction(tx);

        setPhase({ kind: 'working', note: 'Confirming on chain' });
        const signature = await connection.sendRawTransaction(signed.serialize());
        await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');

        setPhase({ kind: 'done', signature });
        void load();
      } catch (err) {
        setPhase({ kind: 'error', message: explainError(err) });
      }
    },
    [wallet, protocol, connection, worstFee, load],
  );

  const ui = (raw: bigint) => Number(raw) / 10 ** decimals;

  if (positions === null) {
    return (
      <p className="card" style={{ padding: '20px 22px', fontSize: 14, color: 'var(--text-muted)' }}>
        Reading open commitments from chain&hellip;
      </p>
    );
  }

  if (positions.length === 0) {
    return (
      <p className="card" style={{ padding: '20px 22px', fontSize: 14, color: 'var(--text-muted)' }}>
        No floors available for {symbol} yet. A floor appears here as soon as someone commits
        capital at a valuation &mdash; you would then be selling them that exposure in exchange
        for a premium and a guaranteed exit amount.
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {phase.kind === 'done' && (
        <div
          className="card"
          style={{ padding: '16px 18px', borderColor: 'var(--teal-ink)', background: 'var(--surface)' }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--teal-ink)', marginBottom: 6 }}>
            Protection active
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 8px', lineHeight: 1.5 }}>
            Your {symbol} is escrowed and the premium has been paid to the counterparty. You may
            exercise at any time before expiry from{' '}
            <a href="/positions">My Positions</a>.
          </p>
          <a
            className="fig"
            style={{ fontSize: 12 }}
            href={explorer('tx', phase.signature, CLUSTER)}
            target="_blank"
            rel="noreferrer"
          >
            Transaction {shortKey(phase.signature, 6, 6)} &#8599;
          </a>
        </div>
      )}

      {phase.kind === 'error' && (
        <p
          className="card"
          style={{
            padding: '12px 16px',
            fontSize: 13,
            color: 'var(--caution)',
            borderColor: 'var(--caution)',
            margin: 0,
          }}
        >
          {phase.message}
        </p>
      )}

      {positions
        .slice()
        .sort((a, b) => b.targetValuationUsd - a.targetValuationUsd)
        .map((p) => {
          const isOpen = selected === p.pubkey;
          const required = p.stockRawRequired;
          const toSend = grossUpForRequired(required, worstFee);
          const arrives = amountReceived(toSend, worstFee);
          const overhead = ui(toSend) - ui(required);
          const busy = phase.kind === 'working';
          const ownCommitment = wallet.publicKey?.toBase58() === p.maker;

          return (
            <article key={p.pubkey} className="card" style={{ padding: '20px 22px' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 18,
                  flexWrap: 'wrap',
                  marginBottom: isOpen ? 18 : 0,
                }}
              >
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 3 }}>Floor at</div>
                  <div className="fig" style={{ fontSize: 20 }}>
                    {band(p.targetValuationUsd)}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 3 }}>
                    You receive if you exercise
                  </div>
                  <div className="fig" style={{ fontSize: 20 }}>
                    {usd(fromQuote(p.strikeQuoteEscrowed))}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 3 }}>Premium you pay</div>
                  <div className="fig" style={{ fontSize: 20, color: 'var(--amber-ink)' }}>
                    {usd(fromQuote(p.premiumQuoteAmount))}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 3 }}>Deadline</div>
                  <div className="fig" style={{ fontSize: 20 }}>
                    {daysUntil(p.expiryTs)}d
                  </div>
                </div>
                <div style={{ flexGrow: 1 }} />
                <button
                  type="button"
                  className={isOpen ? 'btn btn-quiet' : 'btn'}
                  onClick={() => setSelected(isOpen ? null : p.pubkey)}
                >
                  {isOpen ? 'Close' : 'Review'}
                </button>
              </div>

              {isOpen && (
                <div style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 18 }}>
                  <div className="label" style={{ marginBottom: 12 }}>
                    Protection check
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
                    <Row label={`You lock`} value={`${ui(toSend).toFixed(8)} ${symbol}`} />
                    <Row label="Reaches the vault" value={`${ui(arrives).toFixed(8)} ${symbol}`} />
                    <Row label="You pay" value={`${usd(fromQuote(p.premiumQuoteAmount))} premium`} accent />
                    <Row label="Your exercise value" value={usd(fromQuote(p.strikeQuoteEscrowed))} />
                    <Row
                      label="Exercise deadline"
                      value={new Date(p.expiryTs * 1000).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    />
                  </div>

                  <p
                    style={{
                      fontSize: 12,
                      lineHeight: 1.6,
                      color: 'var(--text-muted)',
                      background: 'var(--paper)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '12px 14px',
                      margin: '0 0 12px',
                    }}
                  >
                    <strong>If you exercise:</strong> you deliver your {symbol} and receive{' '}
                    {usd(fromQuote(p.strikeQuoteEscrowed))}.
                    <br />
                    <strong>If you do not exercise:</strong> your {symbol} returns to you after
                    expiry.
                    <br />
                    <strong>The premium is not refundable</strong> either way.
                  </p>

                  <p style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-faint)', margin: '0 0 14px' }}>
                    You send {overhead.toFixed(8)} {symbol} more than the position requires. That
                    difference is the mint&rsquo;s transfer fee, charged by PreStocks rather than by
                    Rung, and it is sized against the higher of the mint&rsquo;s two fee slots so the
                    transfer still clears if the rate steps up before you sign.
                  </p>

                  {!wallet.connected ? (
                    <button type="button" className="btn" style={{ width: '100%' }} onClick={() => setVisible(true)}>
                      Connect wallet to buy protection
                    </button>
                  ) : ownCommitment ? (
                    <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: 0 }}>
                      This is your own commitment. You cannot take both sides of a position.
                    </p>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      style={{ width: '100%' }}
                      disabled={busy}
                      onClick={() => accept(p)}
                    >
                      {busy ? `${phase.note}…` : `Buy protection — pay ${usd(fromQuote(p.premiumQuoteAmount))}`}
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
    </div>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="fig" style={{ color: accent ? 'var(--amber-ink)' : 'var(--text)' }}>
        {value}
      </span>
    </div>
  );
}
