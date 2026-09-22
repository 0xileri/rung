'use client';

import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { explorer } from '../lib/format';
import { CLUSTER } from '../lib/chain';

type Phase =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; signatures: string[]; sol: number; usdc: number; stocks: { symbol: string; ui: number }[] }
  | { kind: 'error'; message: string };

/** One click to devnet SOL, mock USDC and mock OPENAI, via /api/faucet. */
export function FaucetButton() {
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  if (!publicKey) {
    return (
      <button type="button" className="btn" onClick={() => setVisible(true)}>
        Connect a devnet wallet
      </button>
    );
  }

  const claim = async () => {
    setPhase({ kind: 'working' });
    try {
      const res = await fetch('/api/faucet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: publicKey.toBase58() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setPhase({ kind: 'done', ...body });
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
      <button type="button" className="btn" disabled={phase.kind === 'working'} onClick={claim}>
        {phase.kind === 'working' ? 'Sending test tokens…' : 'Get test tokens'}
      </button>
      {phase.kind === 'done' && (
        <p style={{ fontSize: 12, color: 'var(--teal-ink)', margin: 0 }}>
          Sent {phase.usdc.toLocaleString()} mock USDC,{' '}
          {phase.stocks.map((s) => `${s.ui.toFixed(2)} mock ${s.symbol}`).join(', ')}
          {phase.sol > 0 ? `, plus ${phase.sol} SOL for fees` : ''}.{' '}
          {phase.signatures.map((sig, i) => (
            <span key={sig}>
              {i > 0 && ' · '}
              <a href={explorer('tx', sig, CLUSTER)} target="_blank" rel="noreferrer">
                {phase.signatures.length > 1 ? `Transaction ${i + 1}` : 'Transaction'} &#8599;
              </a>
            </span>
          ))}
        </p>
      )}
      {phase.kind === 'error' && (
        <p style={{ fontSize: 12, color: 'var(--danger)', margin: 0 }}>{phase.message}</p>
      )}
    </div>
  );
}
