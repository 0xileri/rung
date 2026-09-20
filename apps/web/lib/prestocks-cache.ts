import { fetchPreStocks, fetchMintState, rpcFromUrl } from '../../../packages/sdk/src/prestocks.ts';
import type { PreStockAsset } from '../../../packages/sdk/src/valuation.ts';

/**
 * A small server-side cache in front of the PreStocks API.
 *
 * Two reasons, and the second is the important one.
 *
 * First, every page view would otherwise hit the upstream API once per render, and the asset
 * page and the market list both want the same payload.
 *
 * Second, the API rate-limits. Without this, a burst of traffic returns 429 and the page
 * shows an error — which, during a demo, would happen at exactly the wrong moment and look
 * like the product is broken rather than the upstream being busy. So a failed refresh falls
 * back to the last good payload and marks it stale, and the UI says how old it is. Valuations
 * that are a few minutes old and labelled as such are far more useful than an error.
 */

const TTL_MS = 60_000;
/** How long a stale payload may still be served when refreshes keep failing. */
const MAX_STALE_MS = 30 * 60_000;

type Entry = { assets: PreStockAsset[]; fetchedAt: number };

let cache: Entry | null = null;
let inflight: Promise<Entry> | null = null;

export type PreStocksResult = {
  assets: PreStockAsset[];
  fetchedAt: number;
  /** True when the upstream refresh failed and this is the last good payload. */
  stale: boolean;
};

async function refresh(): Promise<Entry> {
  const assets = await fetchPreStocks();
  cache = { assets, fetchedAt: Date.now() };
  return cache;
}

export async function getPreStocks(): Promise<PreStocksResult> {
  const fresh = cache && Date.now() - cache.fetchedAt < TTL_MS;
  if (fresh) return { ...cache!, stale: false };

  // Collapse concurrent misses into one upstream request; a page that renders three
  // components should not become three calls to an API that is already rate-limiting us.
  inflight ??= refresh().finally(() => {
    inflight = null;
  });

  try {
    const entry = await inflight;
    return { ...entry, stale: false };
  } catch (err) {
    if (cache && Date.now() - cache.fetchedAt < MAX_STALE_MS) {
      return { ...cache, stale: true };
    }
    throw err;
  }
}

export function findAsset(assets: PreStockAsset[], symbol: string): PreStockAsset | undefined {
  return assets.find((a) => a.symbol.toUpperCase() === symbol.toUpperCase());
}

/**
 * Mint state, cached separately and for longer.
 *
 * Extensions change on the order of epochs, not seconds, and each read costs two RPC calls
 * against a public endpoint that also rate-limits. The values that matter here -- the active
 * multiplier and the current fee slot -- are already resolved by the SDK.
 */
const MINT_TTL_MS = 5 * 60_000;
const mintCache = new Map<string, { value: Awaited<ReturnType<typeof fetchMintState>>; at: number }>();

export async function getMintState(mint: string) {
  const hit = mintCache.get(mint);
  if (hit && Date.now() - hit.at < MINT_TTL_MS) return hit.value;
  const rpc = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
  const value = await fetchMintState(mint, rpcFromUrl(rpc));
  mintCache.set(mint, { value, at: Date.now() });
  return value;
}
