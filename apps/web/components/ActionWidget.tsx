'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { Transaction } from '@solana/web3.js';
import { explainError } from '../lib/program';
import { explorer } from '../lib/format';
import { CLUSTER } from '../lib/chain';

/**
 * A Blink, drawn here: a minimal Solana Actions client for one of Rung's own actions.
 *
 * It reads the action's GET for its buttons, POSTs the connected wallet's address to the one
 * clicked, and signs and sends the transaction that comes back -- exactly what a Blink-aware
 * wallet or X extension does with the same endpoints. Rendering it here means the page works as
 * a Blink today without depending on a third-party viewer.
 */

type ActionButton = {
  type: string;
  label: string;
  href: string;
  parameters?: { name: string; label: string; min?: number; max?: number }[];
};
type ActionSpec = {
  title: string;
  description: string;
  disabled?: boolean;
  error?: { message: string };
  links?: { actions: ActionButton[] };
};
type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; note: string }
  | { kind: 'done'; title: string; detail: string; signature: string }
  | { kind: 'error'; message: string };

export function ActionWidget({ actionPath }: { actionPath: string }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const router = useRouter();
  const [spec, setSpec] = useState<ActionSpec | null>(null);
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  useEffect(() => {
    let live = true;
    fetch(actionPath)
      .then((r) => r.json())
      .then((s) => live && setSpec(s))
      .catch(() => live && setPhase({ kind: 'error', message: 'Could not load this action just now.' }));
    return () => {
      live = false;
    };
  }, [actionPath]);

  const run = useCallback(
    async (button: ActionButton, value?: string) => {
      if (!wallet.publicKey || !wallet.signTransaction) {
        setVisible(true);
        return;
      }
      try {
        setPhase({ kind: 'working', note: 'Building the transaction' });
        const href = value !== undefined ? button.href.replace('{amount}', encodeURIComponent(value)) : button.href;
        const res = await fetch(href, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ account: wallet.publicKey.toBase58() }),
        });
        const body = await res.json();
        if (!res.ok || !body.transaction) throw new Error(body.message ?? 'The action could not build a transaction.');

        const tx = Transaction.from(Buffer.from(body.transaction, 'base64'));
        setPhase({ kind: 'working', note: 'Waiting for your signature' });
        const signed = await wallet.signTransaction(tx);
        setPhase({ kind: 'working', note: 'Confirming on chain' });
        const signature = await connection.sendRawTransaction(signed.serialize());
        const { lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        const conf = await connection.confirmTransaction(
          { signature, blockhash: tx.recentBlockhash!, lastValidBlockHeight },
          'confirmed',
        );
        if (conf.value.err) throw new Error(`The transaction failed on chain: ${JSON.stringify(conf.value.err)}`);

        const next = body.links?.next?.action;
        setPhase({ kind: 'done', title: next?.title ?? body.message ?? 'Done', detail: next?.description ?? '', signature });
        router.refresh();
      } catch (err) {
        setPhase({ kind: 'error', message: err instanceof Error && !/0x|custom program error/i.test(err.message) ? err.message : explainError(err) });
      }
    },
    [wallet, connection, setVisible, router],
  );

  if (!spec) return <p style={{ fontSize: 13, color: 'var(--text-faint)', margin: 0 }}>Loading the action…</p>;
  if (spec.disabled) return <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>{spec.error?.message ?? 'This action is closed.'}</p>;

  const buttons = (spec.links?.actions ?? []).filter((b) => !b.parameters);
  const input = (spec.links?.actions ?? []).find((b) => b.parameters);
  const busy = phase.kind === 'working';

  if (phase.kind === 'done') {
    return (
      <div>
        <p style={{ fontSize: 15, fontWeight: 600, margin: '0 0 6px' }}>{phase.title}</p>
        {phase.detail && <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 10px' }}>{phase.detail}</p>}
        <a className="fig" style={{ fontSize: 12 }} href={explorer('tx', phase.signature, CLUSTER)} target="_blank" rel="noreferrer">
          Transaction {phase.signature.slice(0, 8)}… &#8599;
        </a>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {buttons.map((b) => (
          <button key={b.href} type="button" className="btn" disabled={busy} onClick={() => run(b)}>
            {b.label}
          </button>
        ))}
      </div>
      {input && (
        <form
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
          onSubmit={(e) => {
            e.preventDefault();
            run(input, amount);
          }}
        >
          <input
            type="number"
            inputMode="decimal"
            min={input.parameters![0].min}
            max={input.parameters![0].max}
            step="0.01"
            placeholder="Amount"
            aria-label={input.parameters![0].label}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={{ width: 130, padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--text)' }}
          />
          <button type="submit" className="btn btn-quiet" disabled={busy || !amount}>
            {input.label}
          </button>
          <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{input.parameters![0].label}</span>
        </form>
      )}
      {!wallet.connected && (
        <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '10px 0 0' }}>Connect a devnet wallet holding PreStocks to take a slice.</p>
      )}
      {busy && <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '10px 0 0' }}>{phase.note}…</p>}
      {phase.kind === 'error' && <p className="callout callout-caution" style={{ margin: '10px 0 0' }}>{phase.message}</p>}
    </div>
  );
}
