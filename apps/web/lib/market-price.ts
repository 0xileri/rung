import type { PreStockAsset } from '../../../packages/sdk/src/valuation.ts';

/**
 * PreStocks publishes two prices per asset: the market (`tokenPrice`, and the valuation implied
 * by it) and its own mark. The market side can come back null -- on October 12, 2026 it did for
 * every asset at once, with the mark still published -- and every page formats, divides or
 * compares by it. So a missing market price is filled in here, once for the whole site, with
 * the mark, and the asset records that it was, so the pages that show it can say so.
 */
export type MarketFromMark = PreStockAsset & { marketFromMark: true };

const usable = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

export function fillMarketFromMark(feed: PreStockAsset[]): PreStockAsset[] {
  return feed.flatMap((a): PreStockAsset[] => {
    if (usable(a.tokenPrice) && usable(a.impliedValuation)) return [a];
    // Without either price there is nothing to value it by; leaving it out beats a page that crashes.
    if (!usable(a.markPrice) || !usable(a.markValuation)) return [];
    const filled: MarketFromMark = { ...a, tokenPrice: a.markPrice, impliedValuation: a.markValuation, marketFromMark: true };
    return [filled];
  });
}

/** True when this asset's market price is the mark standing in for a market price PreStocks did not publish. */
export function marketFromMark(asset: PreStockAsset): boolean {
  return (asset as Partial<MarketFromMark>).marketFromMark === true;
}
