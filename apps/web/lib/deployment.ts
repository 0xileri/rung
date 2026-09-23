import devnet from '../../../devnet.json';
import local from '../../../local.json';
import { CLUSTER } from './chain';

/**
 * Which token the protocol actually escrows on this cluster.
 *
 * PreStocks exist only on mainnet. On devnet the allowlisted mint is a mock that reproduces
 * the real one's transfer fee and scaled-amount extensions, so the asset page must escrow
 * against THAT rather than against the mainnet address it is showing valuations for — the
 * mainnet mint is not allowlisted on devnet and the transaction would be refused.
 *
 * Valuation data stays live from the real mainnet API in every environment. Only the
 * escrowed token changes, and `mock` is true whenever it has, so the UI can say so rather
 * than quietly presenting a synthetic asset as the real one.
 */

type DevnetMarket = {
  mint: string;
  market: string;
  decimals: number;
  multiplier: number;
  feeBps: number;
  mock: boolean;
};

// A local validator gets its own file: the devnet addresses belong to the deployment the
// live site reads, and a local run must not be able to overwrite them.
const deployment = CLUSTER === 'localnet' ? local : devnet;
const MARKETS = (deployment as { markets?: Record<string, DevnetMarket> }).markets ?? {};

export type EscrowTarget = {
  /** The mint the program will actually accept. */
  mint: string;
  /** True when this is a stand-in rather than the real PreStock. */
  mock: boolean;
  /**
   * Whether this deployment lists the asset at all. Known up front on devnet, where only
   * the markets in devnet.json exist, so the page can say so before anyone fills in a form.
   * On mainnet every PreStock is listed; the program's own allowlist is still read before
   * signing either way.
   */
  listed: boolean;
  /** Present only for a mock, where we know the extension values we created it with. */
  decimals?: number;
  multiplier?: number;
  feeBps?: number;
};

export function escrowTargetFor(symbol: string, mainnetMint: string): EscrowTarget {
  if (CLUSTER === 'mainnet-beta') return { mint: mainnetMint, mock: false, listed: true };

  const m = MARKETS[symbol.toUpperCase()];
  if (!m) return { mint: mainnetMint, mock: false, listed: false };

  return {
    mint: m.mint,
    mock: m.mock,
    listed: true,
    decimals: m.decimals,
    multiplier: m.multiplier,
    feeBps: m.feeBps,
  };
}

export type MintedAsset = { symbol: string; contract_address: string };

/**
 * Which PreStock a stock mint stands for. On devnet the mock maps to the asset it mimics,
 * so it can be valued at that asset's live price; on mainnet the mint is the asset's own.
 */
export function symbolForMint(mint: string, assets: MintedAsset[]): string | null {
  if (CLUSTER !== 'mainnet-beta') {
    for (const [symbol, m] of Object.entries(MARKETS)) if (m.mint === mint) return symbol;
  }
  return assets.find((a) => a.contract_address === mint)?.symbol ?? null;
}

/** Symbols tradable on this deployment, for pointing people at them. */
export const LISTED_SYMBOLS: string[] = CLUSTER === 'mainnet-beta' ? [] : Object.keys(MARKETS);

export const DEPLOYMENT = {
  cluster: (devnet as { cluster?: string }).cluster ?? CLUSTER,
  programId: (devnet as { programId?: string }).programId,
  quoteMint: (devnet as { quoteMint?: string }).quoteMint,
};
