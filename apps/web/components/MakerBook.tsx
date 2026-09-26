'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  buildBook,
  summarizeBook,
  type BookFill,
  type BookLine,
} from '../../../packages/sdk/src/book.ts';
import { fetchPositions, CLUSTER, type Fill, type Position } from '../lib/chain';
import {
  buildCancelCommitment,
  buildExpirePosition,
  explainError,
  getProgram,
  loadProtocolAccounts,
  type ProtocolAccounts,
} from '../lib/program';
import { matchedRowFor } from '../lib/holdings';
import { pnlColor, pnlForPosition, readMintScales, totalPnl, type MintScale } from '../lib/pnl';
import { usePriceBook } from '../lib/use-price-book';
import { symbolForMint } from '../lib/deployment';
import { signAndSendPacked } from '../lib/pack';
import { capitalPointsUsd } from '../lib/capital-view';
import { CapitalCharts } from './CapitalCharts';
import { band, dateTime, explorer, fromQuote, shortKey, signedUsd, timeUntil, usd } from '../lib/format';

/**
 * A maker's book: every commitment, what holders took from it, and what it earned.
 *
 * My Positions answers "what do I hold". This answers the question a maker actually runs a
 * book by: of the capital I put up, how much found a counterparty, how much is still waiting,
 * and what did it pay? The figures come from the SDK's book arithmetic over chain accounts,
 * so this page and the tests that pin that arithmetic cannot disagree.
 *
 * Two actions live here because they are a maker's to take: pulling capital nobody has taken,
 * and settling claims that have run past their deadline so the USDC comes home. The second is
 * permissionless on chain — anyone may settle — but the maker is the one who wants it done.
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; key: string; note: string }
  | { kind: 'done'; key: string; message: string; signatures: string[] }
  | { kind: 'error'; key: string; message: string };

export function MakerBook() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { publicKey, connected } = wallet;
  const { setVisible } = useWalletModal();
  const prices = usePriceBook();

  const [chain, setChain] = useState<{ positions: Position[]; fills: Fill[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scales, setScales] = useState<Record<string, MintScale>>({});
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const me = publicKey?.toBase58() ?? null;

  const load = useCallback(async () => {
    if (!me) return;
    const result = await fetchPositions(connection);
    if (!result.ok) {
      setLoadError(result.detail);
      setChain({ positions: [], fills: [] });
      return;
    }
    setLoadError(null);
    const positions = result.positions.filter((p) => p.maker === me);
    const mine = new Set(positions.map((p) => p.pubkey));
    setChain({ positions, fills: result.fills.filter((f) => mine.has(f.position)) });
  }, [connection, me]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!chain?.positions.length) return;
    let live = true;
    readMintScales(connection, chain.positions.map((p) => p.stockMint))
      .then((s) => live && setScales(s))
      .catch(() => {
        // P&L renders as unavailable until a scale is known; nothing here is mis-scaled.
      });
    return () => {
      live = false;
    };
  }, [connection, chain]);

  const now = Math.floor(Date.now() / 1000);
  const lines = useMemo(() => {
    if (!chain) return [];
    return buildBook(
      chain.positions.map((p) => ({
        position: p.pubkey,
        stockMint: p.stockMint,
        targetValuationUsd: p.targetValuationUsd,
        strikeQuoteEscrowed: p.strikeQuoteEscrowed,
        strikeQuoteOpen: p.strikeQuoteOpen,
        premiumQuoteAmount: p.premiumQuoteAmount,
        expiryTs: p.expiryTs,
        createdAt: p.createdAt,
      })),
      chain.fills.map((f) => ({
        fill: f.pubkey,
        position: f.position,
        taker: f.taker,
        index: f.index,
        strikeQuoteAmount: f.strikeQuoteAmount,
        premiumPaid: f.premiumPaid,
        feePaid: f.feePaid,
        matchedAt: f.matchedAt,
        settledAt: f.settledAt,
        status: f.status,
      })),
      now,
    );
    // `now` moves every render; the book only needs recomputing when chain state does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain]);
  const summary = useMemo(() => summarizeBook(lines), [lines]);
  const capital = useMemo(
    () => (chain ? capitalPointsUsd(chain.positions, chain.fills, Math.floor(Date.now() / 1000)) : []),
    [chain],
  );

  /** Maker P&L on one commitment: the sum over its fills, each priced as My Positions does. */
  const pnlOf = useCallback(
    (line: BookLine) => {
      if (!chain) return totalPnl([]);
      const p = chain.positions.find((x) => x.pubkey === line.commitment.position)!;
      return totalPnl(
        chain.fills
          .filter((f) => f.position === p.pubkey)
          .map((f) => pnlForPosition(matchedRowFor(p, f, 'maker'), 'maker', scales[p.stockMint], prices)),
      );
    },
    [chain, scales, prices],
  );
  const bookPnl = useMemo(() => {
    if (!chain) return totalPnl([]);
    const byKey = new Map(chain.positions.map((p) => [p.pubkey, p]));
    return totalPnl(
      chain.fills.flatMap((f) => {
        const p = byKey.get(f.position);
        return p ? [pnlForPosition(matchedRowFor(p, f, 'maker'), 'maker', scales[p.stockMint], prices)] : [];
      }),
    );
  }, [chain, scales, prices]);

  /** Protocol accounts per mint, loaded on demand for the actions. */
  const protocolFor = useCallback(
    async (mint: string): Promise<ProtocolAccounts> => {
      const program = getProgram(connection, wallet as never);
      const loaded = await loadProtocolAccounts(program, new PublicKey(mint));
      if (!loaded.ok) throw new Error(loaded.detail);
      return loaded.accounts;
    },
    [connection, wallet],
  );

  const settleIxs = useCallback(
    async (targets: { line: BookLine; fill: BookFill }[]) => {
      const program = getProgram(connection, wallet as never);
      const ixs: TransactionInstruction[] = [];
      const accountsByMint = new Map<string, ProtocolAccounts>();
      for (const { line, fill } of targets) {
        const mint = line.commitment.stockMint;
        if (!accountsByMint.has(mint)) accountsByMint.set(mint, await protocolFor(mint));
        ixs.push(
          await buildExpirePosition(program, {
            cranker: wallet.publicKey!,
            position: new PublicKey(line.commitment.position),
            fill: new PublicKey(fill.fill),
            maker: wallet.publicKey!,
            taker: new PublicKey(fill.taker),
            accounts: accountsByMint.get(mint)!,
          }),
        );
      }
      return ixs;
    },
    [connection, wallet, protocolFor],
  );

  const settle = useCallback(
    async (key: string, targets: { line: BookLine; fill: BookFill }[]) => {
      try {
        setPhase({ kind: 'working', key, note: 'Building transactions' });
        const ixs = await settleIxs(targets);
        const result = await signAndSendPacked(connection, wallet, ixs, (note) =>
          setPhase({ kind: 'working', key, note }),
        );
        const returned = targets
          .slice(0, result.landed)
          .reduce((sum, t) => sum + t.fill.strikeQuoteAmount, 0n);
        setPhase(
          result.failure
            ? {
                kind: 'error',
                key,
                message: `Settled ${result.landed} of ${targets.length}, then stopped: ${result.failure}`,
              }
            : {
                kind: 'done',
                key,
                message: `Settled ${result.landed} expired claim${result.landed === 1 ? '' : 's'}. ${usd(fromQuote(returned))} is back in your wallet, and each holder has their tokens back.`,
                signatures: result.signatures,
              },
        );
        void load();
      } catch (err) {
        setPhase({ kind: 'error', key, message: explainError(err) });
      }
    },
    [settleIxs, connection, wallet, load],
  );

  const withdraw = useCallback(
    async (line: BookLine) => {
      const key = line.commitment.position;
      try {
        setPhase({ kind: 'working', key, note: 'Building transaction' });
        const program = getProgram(connection, wallet as never);
        const ix = await buildCancelCommitment(program, {
          maker: wallet.publicKey!,
          position: new PublicKey(key),
          accounts: await protocolFor(line.commitment.stockMint),
        });
        const result = await signAndSendPacked(connection, wallet, [ix], (note) =>
          setPhase({ kind: 'working', key, note }),
        );
        setPhase(
          result.failure
            ? { kind: 'error', key, message: result.failure }
            : {
                kind: 'done',
                key,
                message: `Withdrew ${usd(fromQuote(line.open))}. What holders already took stays locked until each of those claims settles.`,
                signatures: result.signatures,
              },
        );
        void load();
      } catch (err) {
        setPhase({ kind: 'error', key, message: explainError(err) });
      }
    },
    [connection, wallet, protocolFor, load],
  );

  if (!connected) {
    return (
      <div className="card" style={{ padding: '32px 28px', textAlign: 'center' }}>
        <p style={{ fontSize: 15, color: 'var(--text-muted)', margin: '0 0 16px' }}>
          Connect a wallet to see the commitments you have made.
        </p>
        <button type="button" className="btn" onClick={() => setVisible(true)}>
          Connect wallet
        </button>
      </div>
    );
  }

  if (chain === null) {
    return (
      <p className="card" style={{ padding: '20px 22px', fontSize: 14, color: 'var(--text-muted)' }}>
        Reading your book from chain&hellip;
      </p>
    );
  }

  if (loadError) {
    return (
      <p className="callout callout-caution" style={{ margin: 0 }}>
        Could not read your commitments from chain: {loadError}
      </p>
    );
  }

  if (lines.length === 0) {
    return (
      <div className="card" style={{ padding: '24px 26px' }}>
        <p style={{ fontSize: 15, color: 'var(--text)', margin: '0 0 8px' }}>
          No commitments from{' '}
          <span className="fig">{shortKey(me!, 6, 6)}</span> on {CLUSTER} yet.
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 16px', lineHeight: 1.55 }}>
          A commitment is capital at the valuation you would buy at. Holders who take it pay you a
          premium for the right to sell to you there, and it all shows up here.
        </p>
        <Link href="/asset/OPENAI" className="btn">
          Commit at a valuation
        </Link>
      </div>
    );
  }

  const allSettleable = lines.flatMap((line) => line.settleable.map((fill) => ({ line, fill })));
  const busy = phase.kind === 'working';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
          gap: 12,
        }}
      >
        <Tile
          label="On the book"
          value={usd(fromQuote(summary.onBook))}
          note={`${usd(fromQuote(summary.live))} taken and running · ${usd(fromQuote(summary.open))} still on offer${summary.due > 0n ? ` · ${usd(fromQuote(summary.due))} past deadline, waiting to settle` : ''}`}
        />
        <Tile
          label="Taken by holders"
          value={usd(fromQuote(summary.taken))}
          note={`${summary.takers} holder${summary.takers === 1 ? '' : 's'} across ${summary.commitments} commitment${summary.commitments === 1 ? '' : 's'}`}
        />
        <Tile
          label="Premium earned"
          value={usd(fromQuote(summary.premiumNet))}
          accent="var(--amber-ink)"
          note={
            summary.premiumYield === null
              ? 'Nothing matched yet'
              : `${(summary.premiumYield * 100).toFixed(2)}% of capital matched${summary.avgTermDays !== null ? `, over ${summary.avgTermDays >= 1 ? `~${Math.round(summary.avgTermDays)}-day terms` : 'terms under a day'}` : ''}${summary.feePaid > 0n ? ` · ${usd(fromQuote(summary.feePaid))} protocol fee` : ''}`
          }
        />
        <Tile
          label="Book P&L"
          value={bookPnl.empty ? '—' : signedUsd(bookPnl.usd)}
          accent={pnlColor(bookPnl.empty ? null : bookPnl.usd)}
          note={
            bookPnl.positions === 0
              ? 'None until a holder takes a slice'
              : `Premium received less what exercising would cost you at today's price${bookPnl.unpriced ? `, ${bookPnl.unpriced} without a price` : ''}`
          }
        />
        <Tile
          label="Next deadline"
          value={summary.nextExpiry ? timeUntil(summary.nextExpiry) : '—'}
          note={summary.nextExpiry ? dateTime(summary.nextExpiry) : 'Nothing running'}
        />
      </section>

      {capital.length > 1 && <CapitalCharts points={capital} scope="Your book" />}

      {allSettleable.length > 0 && (
        <section className="callout" style={{ margin: 0, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 320px', fontSize: 13, lineHeight: 1.55 }}>
            <strong>
              {allSettleable.length} expired claim{allSettleable.length === 1 ? ' is' : 's are'} waiting to be settled.
            </strong>{' '}
            Settling returns your USDC and each holder&rsquo;s tokens. Anyone may do it, so it never
            depends on a holder coming back.
          </span>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => settle('all', allSettleable)}
          >
            {phase.kind === 'working' && phase.key === 'all' ? `${phase.note}…` : 'Settle all'}
          </button>
        </section>
      )}
      {phase.kind !== 'idle' && phase.kind !== 'working' && phase.key === 'all' && <Outcome phase={phase} />}

      {lines.map((line) => {
        const c = line.commitment;
        const symbol = symbolForMint(c.stockMint, prices?.assets ?? []) ?? shortKey(c.stockMint);
        const pnl = pnlOf(line);
        const key = c.position;
        const mine = phase.kind !== 'idle' && phase.key === key ? phase : null;
        const settledTaken = line.taken - line.live - line.due;

        return (
          <article key={key} className={`card ${line.active ? 'tint-amber' : ''}`} style={{ padding: '20px 22px' }}>
            <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
              <span className="label">{symbol}</span>
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                Floor at{' '}
                <span className="fig" style={{ fontSize: 20, color: 'var(--text)' }}>
                  {band(c.targetValuationUsd)}
                </span>
              </span>
              <span style={{ fontSize: 12, color: line.active ? 'var(--amber-ink)' : 'var(--text-faint)' }}>
                {statusOf(line)}
              </span>
              <span style={{ flexGrow: 1 }} />
              <span style={{ fontSize: 12, color: line.active && !line.expired ? 'var(--text-muted)' : 'var(--text-faint)' }}>
                {line.expired
                  ? `Expired ${dateTime(c.expiryTs)}`
                  : line.active
                    ? `${timeUntil(c.expiryTs)} to expiry`
                    : 'Closed'}
              </span>
            </header>

            <BookBar
              segments={[
                { amount: settledTaken, color: 'var(--teal-ink)', opacity: 0.45, label: 'taken, settled' },
                { amount: line.live, color: 'var(--teal-fill)', label: 'taken, running' },
                { amount: line.due, color: 'var(--caution)', label: 'taken, waiting to settle' },
                { amount: line.open, color: 'var(--amber-fill)', label: 'on offer' },
                { amount: line.withdrawn, color: 'var(--line-strong)', label: 'withdrawn' },
              ]}
              total={c.strikeQuoteEscrowed}
            />

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                gap: 12,
                margin: '14px 0 4px',
              }}
            >
              <Figure label="Committed" value={usd(fromQuote(c.strikeQuoteEscrowed))} />
              <Figure
                label="Taken"
                value={usd(fromQuote(line.taken))}
                note={line.fills.length ? `${line.fills.length} slice${line.fills.length === 1 ? '' : 's'}` : undefined}
              />
              <Figure label="On offer" value={usd(fromQuote(line.open))} />
              <Figure
                label="Premium earned"
                value={usd(fromQuote(line.premiumNet))}
                accent="var(--amber-ink)"
                note={line.feePaid > 0n ? `after ${usd(fromQuote(line.feePaid))} fee` : undefined}
              />
              <Figure
                label="P&L"
                value={pnl.positions === 0 ? '—' : pnl.empty ? 'Unavailable' : signedUsd(pnl.usd)}
                accent={pnlColor(pnl.empty ? null : pnl.usd)}
              />
            </div>

            {line.fills.length > 0 && (
              <div style={{ marginTop: 12, borderTop: '1px solid var(--line-soft)', paddingTop: 12 }}>
                {line.fills.map((f) => (
                  <div
                    key={f.fill}
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      columnGap: 18,
                      rowGap: 2,
                      fontSize: 13,
                      padding: '6px 0',
                      alignItems: 'baseline',
                    }}
                  >
                    <a
                      className="fig"
                      href={explorer('address', f.taker, CLUSTER)}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: 'var(--text-muted)', minWidth: 88 }}
                    >
                      {shortKey(f.taker)}
                    </a>
                    <span className="fig" style={{ minWidth: 72 }}>
                      {usd(fromQuote(f.strikeQuoteAmount))}
                    </span>
                    <span className="fig" style={{ color: 'var(--amber-ink)', minWidth: 64 }}>
                      +{usd(fromQuote(f.premiumPaid - f.feePaid))}
                    </span>
                    <span style={{ color: 'var(--text-muted)', flex: '1 1 220px' }}>{fillState(f, line.expired)}</span>
                  </div>
                ))}
              </div>
            )}

            {(line.open > 0n || line.settleable.length > 0) && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14, alignItems: 'center' }}>
                {line.open > 0n && (
                  <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => withdraw(line)}>
                    Withdraw {usd(fromQuote(line.open))} on offer
                  </button>
                )}
                {line.settleable.length > 0 && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => settle(key, line.settleable.map((fill) => ({ line, fill })))}
                  >
                    Settle {line.settleable.length} expired
                  </button>
                )}
                {line.expired && line.open > 0n && (
                  <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                    Past its deadline, so no one can take what is left.
                  </span>
                )}
                {mine?.kind === 'working' && (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{mine.note}…</span>
                )}
              </div>
            )}
            {mine && mine.kind !== 'working' && <Outcome phase={mine} />}
          </article>
        );
      })}
    </div>
  );
}

function statusOf(line: BookLine): string {
  if (!line.active) return line.taken > 0n ? 'Settled' : 'Withdrawn';
  if (line.expired) return line.settleable.length ? 'Expired · waiting to settle' : 'Expired';
  if (line.taken === 0n) return 'Open';
  return line.open > 0n ? 'Partly taken' : 'Fully taken';
}

function fillState(f: BookFill, expired: boolean): string {
  if (f.status === 'Exercised') return `Exercised ${dateTime(f.settledAt)} · you received the tokens`;
  if (f.status === 'Expired') return `Expired · your USDC came back`;
  return expired ? 'Expired · waiting to settle' : `Running since ${dateTime(f.matchedAt)}`;
}

function Tile({ label, value, note, accent }: { label: string; value: string; note?: string; accent?: string }) {
  return (
    <div className="card" style={{ padding: '16px 18px' }}>
      <div className="label" style={{ marginBottom: 6 }}>
        {label}
      </div>
      <div className="fig" style={{ fontSize: 24, color: accent ?? 'var(--text)' }}>
        {value}
      </div>
      {note && (
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 6, lineHeight: 1.45 }}>{note}</div>
      )}
    </div>
  );
}

function Figure({ label, value, note, accent }: { label: string; value: string; note?: string; accent?: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 3 }}>{label}</div>
      <div className="fig" style={{ fontSize: 17, color: accent ?? 'var(--text)' }}>
        {value}
      </div>
      {note && <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>{note}</div>}
    </div>
  );
}

/**
 * Where a commitment's capital went, as one bar: taken (settled, running, or past its deadline
 * and waiting to settle), still on offer, and withdrawn. Every segment is a share of what was escrowed, so the bar always
 * accounts for the whole commitment and nothing else.
 */
function BookBar({
  segments,
  total,
}: {
  segments: { amount: bigint; color: string; label: string; opacity?: number }[];
  total: bigint;
}) {
  const shown = segments.filter((s) => s.amount > 0n);
  const t = Number(total) || 1;
  return (
    <div>
      <div
        role="img"
        aria-label={shown.map((s) => `${usd(fromQuote(s.amount))} ${s.label}`).join(', ')}
        style={{
          display: 'flex',
          height: 10,
          borderRadius: 999,
          overflow: 'hidden',
          background: 'var(--paper)',
          border: '1px solid var(--line-soft)',
        }}
      >
        {shown.map((s) => (
          <div
            key={s.label}
            style={{ width: `${(Number(s.amount) / t) * 100}%`, background: s.color, opacity: s.opacity ?? 1 }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6 }}>
        {shown.map((s) => (
          <span key={s.label} style={{ fontSize: 11, color: 'var(--text-faint)', display: 'inline-flex', gap: 5, alignItems: 'center' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, opacity: s.opacity ?? 1 }} />
            {usd(fromQuote(s.amount))} {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function Outcome({ phase }: { phase: Extract<Phase, { kind: 'done' | 'error' }> }) {
  return (
    <p
      className={phase.kind === 'error' ? 'callout callout-caution' : 'callout'}
      style={{ margin: '12px 0 0', fontSize: 13 }}
    >
      {phase.message}{' '}
      {phase.kind === 'done' &&
        phase.signatures.map((sig) => (
          <a
            key={sig}
            className="fig"
            style={{ fontSize: 12, marginRight: 8 }}
            href={explorer('tx', sig, CLUSTER)}
            target="_blank"
            rel="noreferrer"
          >
            {shortKey(sig, 4, 4)} &#8599;
          </a>
        ))}
    </p>
  );
}
