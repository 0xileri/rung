'use client';

import { useCallback, useMemo, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { grossUpForRequired, rawToUi, type TransferFee } from '../../../packages/sdk/src/token2022.ts';
import { planSweep, type CommitmentTerms, type SweepLeg } from '../../../packages/sdk/src/fills.ts';
import { buildAcceptCommitment, explainError, getProgram, type ProtocolAccounts } from '../lib/program';
import type { Position } from '../lib/chain';
import { CLUSTER } from '../lib/chain';
import { band, explorer, fromQuote, shortKey, toQuote, usd } from '../lib/format';
import { signAndSendPacked } from '../lib/pack';

/**
 * Buy a whole band of protection in one go.
 *
 * A holder wanting $300 of floor should not have to work down a list of offers, taking $100
 * here and $80 there, signing each one. They name an amount; this fills it across the
 * cheapest floors available and asks the wallet to sign the resulting transactions together.
 *
 * Legs are packed into as few transactions as fit (lib/pack.ts): two floors go in one.
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; note: string }
  | { kind: 'done'; signatures: string[]; filledUsd: number; legs: number }
  | { kind: 'partial'; signatures: string[]; filledUsd: number; legs: number; message: string }
  | { kind: 'error'; message: string };

export function SweepPanel({
  symbol,
  positions,
  accounts,
  worstFee,
  decimals,
  multiplier,
  onDone,
}: {
  symbol: string;
  /** Commitments with capital still open, for this mint. */
  positions: Position[];
  accounts: ProtocolAccounts | null;
  worstFee: TransferFee;
  decimals: number;
  multiplier: number;
  onDone: () => void;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [target, setTarget] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const totalOpen = positions.reduce((sum, p) => sum + p.strikeQuoteOpen, 0n);

  const plan = useMemo(() => {
    const wanted = toQuote(Number(target));
    if (wanted <= 0n) return null;
    const terms = positions.map((p) => ({
      strikeQuoteEscrowed: p.strikeQuoteEscrowed,
      strikeQuoteOpen: p.strikeQuoteOpen,
      stockRawRequired: p.stockRawRequired,
      premiumQuoteAmount: p.premiumQuoteAmount,
      position: p,
    }));
    return planSweep(terms, wanted, {
      minFillQuote: accounts?.minFillQuote ?? 0n,
      feeBps: accounts?.feeBps ?? 0,
    });
  }, [target, positions, accounts]);

  const legs = plan?.legs ?? [];
  const premiumTotal = legs.reduce((sum, l) => sum + l.quote.premiumQuote, 0n);
  const lockTotal = legs.reduce((sum, l) => sum + grossUpForRequired(l.quote.stockRawRequired, worstFee), 0n);
  const ui = (raw: bigint) => rawToUi(raw, decimals, multiplier);

  /** Cheapest and dearest floor in the plan, which is what the holder is really choosing. */
  const valuations = legs.map((l) => (l.commitment as { position: Position }).position.targetValuationUsd);
  const lowest = valuations.length ? Math.min(...valuations) : 0;
  const highest = valuations.length ? Math.max(...valuations) : 0;

  const run = useCallback(async () => {
    if (!wallet.publicKey || !wallet.signAllTransactions || !accounts || !plan || legs.length === 0) return;
    try {
      setPhase({ kind: 'working', note: 'Building transactions' });
      const program = getProgram(connection, wallet as never);
      const taker = wallet.publicKey;

      const built: TransactionInstruction[] = [];
      for (const leg of legs as SweepLeg<CommitmentTerms & { position: Position }>[]) {
        const p = leg.commitment.position;
        built.push(
          await buildAcceptCommitment(program, {
            taker,
            position: new PublicKey(p.pubkey),
            maker: new PublicKey(p.maker),
            accounts,
            stockRawToSend: grossUpForRequired(leg.quote.stockRawRequired, worstFee),
            fillStrikeQuote: leg.quote.strikeQuote,
            fillIndex: p.fillsCreated,
          }),
        );
      }

      // Legs land in order, and a failure partway leaves the earlier ones standing, so the
      // amount filled is counted from what actually landed rather than from the plan.
      const result = await signAndSendPacked(connection, wallet, built, (note) =>
        setPhase({ kind: 'working', note }),
      );
      const filledUsd = fromQuote(
        legs.slice(0, result.landed).reduce((sum, l) => sum + l.quote.strikeQuote, 0n),
      );
      setPhase(
        result.failure
          ? { kind: 'partial', signatures: result.signatures, filledUsd, legs: result.landed, message: result.failure }
          : { kind: 'done', signatures: result.signatures, filledUsd, legs: result.landed },
      );
      setTarget('');
      onDone();
    } catch (err) {
      setPhase({ kind: 'error', message: explainError(err) });
    }
  }, [wallet, accounts, plan, legs, connection, worstFee, onDone]);

  if (positions.length < 2) return null;

  const busy = phase.kind === 'working';
  const canRun = !!wallet.publicKey && !!wallet.signAllTransactions && !!accounts && legs.length > 0 && !busy;

  return (
    <section className="card" style={{ padding: '20px 22px' }}>
      <div className="label" style={{ marginBottom: 10 }}>
        Take a whole band
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 14px', lineHeight: 1.55 }}>
        {usd(fromQuote(totalOpen))} of floor is open across {positions.length} commitments. Name an
        amount and it is filled from the cheapest premium upwards, in one signature.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <input
          className="fig"
          inputMode="decimal"
          placeholder="300"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          aria-label={`How much ${symbol} protection to buy, in USDC`}
          style={{
            width: 130,
            padding: '8px 12px',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--surface)',
            color: 'var(--text)',
            fontSize: 15,
          }}
        />
        <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>USDC of exercise value</span>
        <button
          type="button"
          className="btn btn-quiet"
          style={{ padding: '6px 12px', fontSize: 12 }}
          onClick={() => setTarget(fromQuote(totalOpen).toString())}
        >
          Everything open
        </button>
      </div>

      {plan && legs.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '12px 14px',
            background: 'var(--paper)',
            borderRadius: 'var(--radius-sm)',
            marginBottom: 14,
            fontSize: 13,
          }}
        >
          <SweepRow label="Floors used" value={`${legs.length} of ${positions.length}`} />
          <SweepRow
            label="Valuations"
            value={lowest === highest ? band(lowest) : `${band(lowest)} – ${band(highest)}`}
          />
          <SweepRow label="Exercise value bought" value={usd(fromQuote(plan.filled))} />
          <SweepRow label="Premium" value={usd(fromQuote(premiumTotal))} accent />
          <SweepRow label={`${symbol} you lock`} value={ui(lockTotal).toFixed(8)} />
          {plan.shortfall > 0n && (
            <SweepRow
              label="Not available"
              value={`${usd(fromQuote(plan.shortfall))} — no floor left to fill it`}
            />
          )}
        </div>
      )}

      {plan && legs.length === 0 && (
        <p className="callout callout-caution" style={{ margin: '0 0 14px' }}>
          Nothing here can be filled at that size. The open commitments are each too large to
          slice for it without leaving an untakeable remainder — try the amount of one floor, or
          take one whole from the list below.
        </p>
      )}

      {phase.kind === 'done' && (
        <p className="callout" style={{ margin: '0 0 14px', borderColor: 'var(--teal-ink)' }}>
          Protection active on {usd(phase.filledUsd)} across {phase.legs} floor
          {phase.legs === 1 ? '' : 's'}.{' '}
          {phase.signatures.map((sig, i) => (
            <a
              key={sig}
              className="fig"
              style={{ fontSize: 12, marginRight: 8 }}
              href={explorer('tx', sig, CLUSTER)}
              target="_blank"
              rel="noreferrer"
            >
              tx {i + 1} {shortKey(sig, 4, 4)} &#8599;
            </a>
          ))}
        </p>
      )}

      {phase.kind === 'partial' && (
        <p className="callout callout-caution" style={{ margin: '0 0 14px' }}>
          Filled {usd(phase.filledUsd)} across {phase.legs} floor{phase.legs === 1 ? '' : 's'}, then
          stopped: {phase.message} The legs that went through are live and are in My Positions.
        </p>
      )}

      {phase.kind === 'error' && (
        <p className="callout callout-caution" style={{ margin: '0 0 14px' }}>
          {phase.message}
        </p>
      )}

      <button type="button" className="btn" style={{ width: '100%' }} disabled={!canRun} onClick={run}>
        {busy
          ? `${phase.note}…`
          : legs.length > 0
            ? `Buy ${usd(fromQuote(plan!.filled))} of protection across ${legs.length} floor${legs.length === 1 ? '' : 's'}`
            : 'Enter an amount'}
      </button>
    </section>
  );
}

function SweepRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="fig" style={{ color: accent ? 'var(--amber-ink)' : 'var(--text)' }}>
        {value}
      </span>
    </div>
  );
}
