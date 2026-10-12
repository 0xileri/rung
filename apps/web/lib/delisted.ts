import type { PreStockAsset } from '../../../packages/sdk/src/valuation.ts';

/**
 * PreStocks the feed has stopped listing while a devnet market still holds capital against them.
 *
 * Every page reads an asset's name and valuations from the live PreStocks feed, so when the feed
 * drops a company its pages 404 and the capital escrowed on it disappears from the site, though
 * it is still on chain and can still be taken, exercised, settled and withdrawn. These are the
 * last figures Rung read from the feed for each one. They are served in its place, and every
 * page that shows them says they are not live.
 */
export type LastKnown = PreStockAsset & { pricesAsOf: string };

const LAST_KNOWN: Record<string, LastKnown> = {
  // Dropped from the feed between September 28 and October 12, 2026.
  SPACEX: {
    symbol: 'SPACEX',
    name: 'SpaceX PreStocks',
    contract_address: 'PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh',
    tokenPrice: 117.6145,
    impliedValuation: 1.5421e12,
    markPrice: 152.2097,
    markValuation: 1.9956e12,
    supply: 0,
    pricesAsOf: '2026-09-20',
  },
};

/** The feed, plus the last-known record of any listed market the feed no longer carries. */
export function withLastKnown(feed: PreStockAsset[], listed: string[]): PreStockAsset[] {
  const present = new Set(feed.map((a) => a.symbol.toUpperCase()));
  const missing = listed.filter((s) => !present.has(s.toUpperCase()) && LAST_KNOWN[s.toUpperCase()]);
  return [...feed, ...missing.map((s) => LAST_KNOWN[s.toUpperCase()])];
}

/** When the prices shown for this asset were last live, or null when they are live now. */
export function pricesAsOf(asset: PreStockAsset): string | null {
  return (asset as Partial<LastKnown>).pricesAsOf ?? null;
}

export function asOfLabel(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
