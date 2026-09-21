'use client';

import { useEffect, useState } from 'react';
import type { MintedAsset } from './deployment';
import { priceBook, type PriceBook } from './pnl';

/**
 * Live market prices for client components, from the same server cache the asset pages
 * read. `null` until loaded or if the fetch fails, and P&L that needs a price then says it
 * is unavailable rather than being guessed.
 */
export function usePriceBook(): PriceBook | null {
  const [prices, setPrices] = useState<PriceBook | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/prestocks')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: { assets: (MintedAsset & { tokenPrice: number })[] }) => {
        if (live) setPrices(priceBook(body.assets));
      })
      .catch(() => {
        /* see above: callers render "unavailable" */
      });
    return () => {
      live = false;
    };
  }, []);
  return prices;
}
