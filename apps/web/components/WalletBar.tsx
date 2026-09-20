'use client';

import { useMemo } from 'react';
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
} from '@solana/wallet-adapter-react';
import { WalletModalProvider, useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { RPC_URL } from '../lib/chain';
import { shortKey } from '../lib/format';

import '@solana/wallet-adapter-react-ui/styles.css';

/**
 * Wallet context for the whole app.
 *
 * Phantom and Solflare only: both implement the wallet standard and both handle Token-2022,
 * which matters here because a wallet that cannot display a transfer-fee mint will show the
 * user a confusing approval screen for the very asset they are escrowing.
 */
export function WalletRoot({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

/**
 * Connect control for the header.
 *
 * Deliberately not the adapter's own styled button: it ships its own font and purple accent,
 * which would be the one element on the page ignoring the design system.
 */
export function WalletBar() {
  const { publicKey, connected, disconnect, connecting } = useWallet();
  const { setVisible } = useWalletModal();

  if (connected && publicKey) {
    return (
      <button
        type="button"
        onClick={() => disconnect()}
        className="fig"
        title="Click to disconnect"
        style={{
          fontSize: 12,
          color: '#A8ABB2',
          background: 'transparent',
          border: '1px solid #2A2F38',
          borderRadius: 7,
          padding: '7px 11px',
          minHeight: 34,
          cursor: 'pointer',
        }}
      >
        {shortKey(publicKey.toBase58())}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setVisible(true)}
      disabled={connecting}
      style={{
        fontFamily: 'var(--font-sans)',
        fontSize: 13,
        fontWeight: 500,
        color: 'var(--ink)',
        background: 'var(--amber-fill)',
        border: 'none',
        borderRadius: 7,
        padding: '8px 14px',
        minHeight: 34,
        cursor: connecting ? 'wait' : 'pointer',
      }}
    >
      {connecting ? 'Connecting…' : 'Connect wallet'}
    </button>
  );
}
