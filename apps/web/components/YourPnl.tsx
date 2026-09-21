'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { fetchPositions, type Position } from '../lib/chain';
import { signedUsd } from '../lib/format';
import { pnlColor, pnlForPosition, readMintScales, totalPnl, type MintScale } from '../lib/pnl';
import { usePriceBook } from '../lib/use-price-book';

/**
 * The connected wallet's net P&L, computed exactly as My Positions computes it. Renders
 * nothing without a wallet: the protocol figures beside it already speak for everyone else.
 */
export function YourPnl() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const prices = usePriceBook();
  const [mine, setMine] = useState<Position[] | null>(null);
  const [scales, setScales] = useState<Record<string, MintScale>>({});
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!publicKey) return;
    let live = true;
    (async () => {
      const result = await fetchPositions(connection);
      if (!live) return;
      if (!result.ok) {
        setFailed(true);
        return;
      }
      const me = publicKey.toBase58();
      const ours = result.positions.filter((p) => p.maker === me || p.taker === me);
      setMine(ours);
      const s = await readMintScales(
        connection,
        ours.filter((p) => p.matchedAt > 0).map((p) => p.stockMint),
      );
      if (live) setScales(s);
    })().catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [connection, publicKey]);

  if (!publicKey) return null;
  if (failed) return <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Your P&amp;L: chain unavailable</span>;
  if (mine === null) return <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Your P&amp;L: reading…</span>;

  const me = publicKey.toBase58();
  const total = totalPnl(mine.map((p) => pnlForPosition(p, p.maker === me ? 'maker' : 'holder', scales[p.stockMint], prices)));

  return (
    <Link href="/positions" style={{ fontSize: 13, textDecoration: 'none', color: 'var(--text-muted)' }}>
      Your P&amp;L{' '}
      <span className="fig" style={{ color: pnlColor(total.empty ? null : total.usd), fontWeight: 500 }}>
        {total.empty ? '—' : signedUsd(total.usd)}
      </span>{' '}
      across {total.positions} matched position{total.positions === 1 ? '' : 's'} &rarr;
    </Link>
  );
}
