'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey, Transaction } from '@solana/web3.js';
import { quoteStrike, type PreStockAsset } from '../../../packages/sdk/src/valuation.ts';
import {
  buildCreateCommitment,
  explainError,
  getProgram,
  loadProtocolAccounts,
  type ProtocolAccounts,
} from '../lib/program';
import { CLUSTER } from '../lib/chain';
import { band, explorer, pct, shortKey, usd, valuation } from '../lib/format';

/**
 * Turn "I would own OpenAI around $1.0T" into fixed, escrowable terms, then into a signed
 * transaction.
 *
 * Every number shown is derived through the SDK rather than recomputed locally, so the
 * figure the user reads before signing is exactly the one the transaction carries. The two
 * values that are easy to get wrong — the active ScaledUiAmount multiplier and the current
 * transfer-fee slot — arrive already resolved from the server.
 */

const EXPIRIES = [
  { days: 7, label: '7 days' },
  { days: 14, label: '14 days' },
  { days: 30, label: '30 days' },
];

type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; note: string }
  | { kind: 'done'; signature: string; position: string }
  | { kind: 'error'; message: string };

export function CommitPanel({
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

  const [target, setTarget] = useState(() =>
    bands.reduce(
      (best, b) =>
        Math.abs(b - markValuation * 0.8) < Math.abs(best - markValuation * 0.8) ? b : best,
      bands[0],
    ),
  );
  const [size, setSize] = useState(100);
  const [expiryDays, setExpiryDays] = useState(30);
  const [premium, setPremium] = useState(4.6);
  const [understood, setUnderstood] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [protocol, setProtocol] = useState<ProtocolAccounts | null | 'loading'>('loading');

  // Read the protocol's own allowlist rather than trusting the page's props: if the program
  // is not deployed here, or this mint was never allowlisted, say so before anyone signs.
  useEffect(() => {
    let live = true;
    if (!wallet.publicKey) {
      setProtocol('loading');
      return;
    }
    (async () => {
      const program = getProgram(connection, wallet as never);
      const accounts = await loadProtocolAccounts(program, new PublicKey(stockMint));
      if (live) setProtocol(accounts);
    })();
    return () => {
      live = false;
    };
  }, [connection, wallet.publicKey, stockMint]);

  const quote = useMemo(() => {
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
      return quoteStrike({
        asset,
        targetValuation: target,
        strikeUsd: size,
        decimals,
        multiplier,
        transferFee: { epoch: 0n, transferFeeBasisPoints: feeBps, maximumFee: 2n ** 64n - 1n },
      });
    } catch {
      return null;
    }
  }, [symbol, stockMint, target, size, decimals, multiplier, feeBps, impliedValuation, markPrice, markValuation]);

  const premiumPct = size > 0 ? premium / size : 0;
  const busy = phase.kind === 'working';

  const submit = useCallback(async () => {
    if (!quote || !wallet.publicKey || !wallet.signTransaction) return;
    if (!protocol || protocol === 'loading') {
      setPhase({
        kind: 'error',
        message: 'This PreStock is not allowlisted on the deployed program yet.',
      });
      return;
    }
    if (protocol.paused) {
      setPhase({ kind: 'error', message: 'The protocol is paused for new commitments.' });
      return;
    }
    if (!protocol.marketEnabled) {
      setPhase({
        kind: 'error',
        message: 'This market is not accepting new commitments right now.',
      });
      return;
    }

    try {
      setPhase({ kind: 'working', note: 'Building transaction' });
      const program = getProgram(connection, wallet as never);
      const { instruction, position } = await buildCreateCommitment(program, {
        maker: wallet.publicKey,
        accounts: protocol,
        stockRawRequired: quote.rawQuantity,
        strikeQuoteAmount: quote.strikeQuoteAmount,
        premiumQuoteAmount: BigInt(Math.round(premium * 1e6)),
        expiryTs: Math.floor(Date.now() / 1000) + expiryDays * 86400,
        targetValuationUsd: BigInt(Math.round(target)),
      });

      const tx = new Transaction().add(instruction);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;

      setPhase({ kind: 'working', note: 'Waiting for your signature' });
      const signed = await wallet.signTransaction(tx);

      setPhase({ kind: 'working', note: 'Confirming on chain' });
      const signature = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      );

      setPhase({ kind: 'done', signature, position: position.toBase58() });
    } catch (err) {
      setPhase({ kind: 'error', message: explainError(err) });
    }
  }, [quote, wallet, protocol, connection, premium, expiryDays, target]);

  const row = (label: string, value: string, accent?: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
      <span style={{ color: '#A8ABB2' }}>{label}</span>
      <span className="fig" style={{ color: accent ?? 'var(--paper)' }}>
        {value}
      </span>
    </div>
  );

  const darkField = { background: '#1A1F27', borderColor: '#262A32', color: 'var(--paper)' };

  if (phase.kind === 'done') {
    return (
      <section
        style={{ background: 'var(--ink)', borderRadius: 'var(--radius-lg)', padding: '24px 26px' }}
      >
        <h2 className="label" style={{ color: 'var(--amber-fill)', marginBottom: 12 }}>
          Commitment open
        </h2>
        <p style={{ fontSize: 14, lineHeight: 1.55, color: '#A8ABB2', margin: '0 0 16px' }}>
          {usd(size)} USDC is escrowed in a program-controlled vault at {band(target)}. You
          receive the {usd(premium)} premium the moment a holder takes the other side.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
          <a
            className="fig"
            style={{ fontSize: 12, color: 'var(--amber-fill)' }}
            href={explorer('tx', phase.signature, CLUSTER)}
            target="_blank"
            rel="noreferrer"
          >
            Transaction {shortKey(phase.signature, 6, 6)} &#8599;
          </a>
          <a
            className="fig"
            style={{ fontSize: 12, color: 'var(--amber-fill)' }}
            href={explorer('address', phase.position, CLUSTER)}
            target="_blank"
            rel="noreferrer"
          >
            Position {shortKey(phase.position, 6, 6)} &#8599;
          </a>
        </div>
        <button
          type="button"
          className="btn btn-quiet"
          style={{ width: '100%', color: 'var(--paper)', borderColor: '#2A2F38' }}
          onClick={() => {
            setPhase({ kind: 'idle' });
            setUnderstood(false);
          }}
        >
          Make another commitment
        </button>
      </section>
    );
  }

  const ready = !disabled && !!quote && understood && size > 0 && !busy;

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
          <select value={target} onChange={(e) => setTarget(Number(e.target.value))} style={darkField}>
            {bands.map((b) => (
              <option key={b} value={b}>
                {band(b)} ({pct((b - impliedValuation) / impliedValuation, 1)} vs market)
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
              style={darkField}
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
              style={darkField}
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

      <p style={{ fontSize: 11, lineHeight: 1.5, color: '#8B9099', margin: '16px 0 14px' }}>
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

      {phase.kind === 'error' && (
        <p
          style={{
            fontSize: 12,
            lineHeight: 1.5,
            color: '#E8927C',
            background: 'rgba(176,68,46,0.14)',
            borderRadius: 'var(--radius-sm)',
            padding: '10px 12px',
            margin: '0 0 12px',
          }}
        >
          {phase.message}
        </p>
      )}

      {!wallet.connected ? (
        <button type="button" className="btn" style={{ width: '100%' }} onClick={() => setVisible(true)}>
          Connect wallet to commit
        </button>
      ) : (
        <button
          type="button"
          className="btn"
          style={{ width: '100%' }}
          disabled={!ready}
          onClick={submit}
        >
          {busy ? `${phase.note}…` : disabled ? 'Unavailable for this asset' : `Lock ${usd(size)} USDC`}
        </button>
      )}

      {wallet.connected && protocol === null && (
        <p style={{ fontSize: 11, color: '#8B9099', margin: '10px 0 0', lineHeight: 1.5 }}>
          The program is not deployed on {CLUSTER}, or this mint is not allowlisted. The quote
          above is still live and correct; only signing is unavailable.
        </p>
      )}
    </section>
  );
}
