'use client';

import { useCallback, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction } from '@solana/web3.js';
import {
  buildCancelCommitment,
  buildExercisePosition,
  buildExpirePosition,
  explainError,
  getProgram,
  loadProtocolAccounts,
} from '../lib/program';
import { CLUSTER } from '../lib/chain';
import type { Holding } from '../lib/holdings';
import { explorer, shortKey } from '../lib/format';

/**
 * The actions available on a position, and only the ones the program would actually accept.
 *
 * The button set is derived from the same rules the program enforces, so the UI never offers
 * something that will be refused on chain: a maker withdraws only what no taker has claimed;
 * only the taker of a slice exercises it, and only before expiry; expiry is permissionless once the
 * deadline has passed, which is why anyone sees that button rather than just the two
 * counterparties.
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; note: string }
  | { kind: 'done'; signature: string; what: string }
  | { kind: 'error'; message: string };

type Action = 'cancel' | 'exercise' | 'expire';

export function PositionActions({ position, onDone }: { position: Holding; onDone: () => void }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [confirming, setConfirming] = useState<Action | null>(null);

  const me = wallet.publicKey?.toBase58();
  const isMaker = me === position.maker;
  const isTaker = me === position.taker;
  const expired = position.expiryTs < Date.now() / 1000;

  // The open row is the only one a maker can withdraw: a fill's collateral is spoken for.
  const canCancel =
    isMaker && !position.fillPubkey && (position.status === 'Open' || position.status === 'PartiallyMatched');
  const canExercise = isTaker && position.status === 'Matched' && !expired;
  const canExpire = position.status === 'Matched' && expired;

  const run = useCallback(
    async (action: Action) => {
      if (!wallet.publicKey || !wallet.signTransaction) return;
      try {
        setPhase({ kind: 'working', note: 'Building transaction' });
        const program = getProgram(connection, wallet as never);
        const loaded = await loadProtocolAccounts(program, new PublicKey(position.stockMint));
        if (!loaded.ok) {
          setPhase({ kind: 'error', message: loaded.detail });
          return;
        }
        const accounts = loaded.accounts;

        const pos = new PublicKey(position.pubkey);
        const ix =
          action === 'cancel'
            ? await buildCancelCommitment(program, { maker: wallet.publicKey, position: pos, accounts })
            : action === 'exercise'
              ? await buildExercisePosition(program, {
                  taker: wallet.publicKey,
                  position: pos,
                  fill: new PublicKey(position.fillPubkey!),
                  maker: new PublicKey(position.maker),
                  accounts,
                })
              : await buildExpirePosition(program, {
                  cranker: wallet.publicKey,
                  position: pos,
                  fill: new PublicKey(position.fillPubkey!),
                  maker: new PublicKey(position.maker),
                  taker: new PublicKey(position.taker!),
                  accounts,
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

        setPhase({
          kind: 'done',
          signature,
          what:
            action === 'cancel'
              ? 'Withdrawn — the unclaimed USDC is back in your wallet'
              : action === 'exercise'
                ? 'Exercised — both legs swapped'
                : 'Expired — both collaterals returned',
        });
        setConfirming(null);
        onDone();
      } catch (err) {
        setPhase({ kind: 'error', message: explainError(err) });
        setConfirming(null);
      }
    },
    [wallet, connection, position, onDone],
  );

  if (phase.kind === 'done') {
    return (
      <div style={{ fontSize: 12, color: 'var(--teal-ink)', display: 'flex', gap: 10, alignItems: 'center' }}>
        <span>{phase.what}</span>
        <a
          className="fig"
          href={explorer('tx', phase.signature, CLUSTER)}
          target="_blank"
          rel="noreferrer"
        >
          {shortKey(phase.signature)} &#8599;
        </a>
      </div>
    );
  }

  if (!canCancel && !canExercise && !canExpire) return null;

  const busy = phase.kind === 'working';

  // Exercise is irreversible and hands over the tokens, so it gets a second step. Cancel and
  // expire only return collateral to its owner, so they do not need one.
  if (confirming === 'exercise') {
    return (
      <div
        style={{
          background: 'var(--paper)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius-sm)',
          padding: '14px 16px',
          marginTop: 4,
        }}
      >
        <p style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-muted)', margin: '0 0 12px' }}>
          Exercising transfers your escrowed {position.stockMint.slice(0, 4)}&hellip; to the
          counterparty and pays you the USDC strike. <strong>This cannot be undone</strong>, and
          the premium you paid is not returned.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn" disabled={busy} onClick={() => run('exercise')}>
            {busy ? `${phase.note}…` : 'Exercise now'}
          </button>
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setConfirming(null)}>
            Keep holding
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
      {canExercise && (
        <button type="button" className="btn" disabled={busy} onClick={() => setConfirming('exercise')}>
          Exercise protection
        </button>
      )}
      {canCancel && (
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => run('cancel')}>
          {busy ? `${phase.note}…` : 'Cancel & withdraw'}
        </button>
      )}
      {canExpire && (
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => run('expire')}>
          {busy ? `${phase.note}…` : 'Settle expiry'}
        </button>
      )}
      {canExpire && (
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          Permissionless &mdash; anyone can crank this.
        </span>
      )}
      {phase.kind === 'error' && (
        <span style={{ fontSize: 12, color: 'var(--caution)' }}>{phase.message}</span>
      )}
    </div>
  );
}
