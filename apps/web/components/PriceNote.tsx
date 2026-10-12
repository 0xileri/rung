import type { PreStockAsset } from '../../../packages/sdk/src/valuation.ts';
import { asOfLabel, pricesAsOf } from '../lib/delisted';
import { marketFromMark } from '../lib/market-price';

/** Says, wherever an asset's prices appear, when they are not PreStocks' live market price. */
export function PriceNote({ asset, name }: { asset: PreStockAsset; name: string }) {
  const asOf = pricesAsOf(asset);
  if (asOf) {
    return (
      <p className="callout callout-caution" style={{ marginBottom: 20 }}>
        <strong>No longer listed on PreStocks.</strong> PreStocks has stopped publishing {name}, so
        the valuations here are the last Rung read from it, on {asOfLabel(asOf)}, not live. Its
        devnet market stays open so the capital already on it can still be taken, exercised,
        settled and withdrawn.
      </p>
    );
  }
  if (marketFromMark(asset)) {
    return (
      <p className="callout" style={{ marginBottom: 20 }}>
        <strong>Market price unavailable.</strong> PreStocks is not publishing a market price for{' '}
        {name} right now, so its live mark stands in for it here, and market and mark read the same.
      </p>
    );
  }
  return null;
}
