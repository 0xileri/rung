import devnet from '../../../devnet.json';
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

const MARKETS = (devnet as { markets?: Record<string, DevnetMarket> }).markets ?? {};

export type EscrowTarget = {
  /** The mint the program will actually accept. */
  mint: string;
  /** True when this is a stand-in rather than the real PreStock. */
  mock: boolean;
  /** Present only for a mock, where we know the extension values we created it with. */
  decimals?: number;
  multiplier?: number;
  feeBps?: number;
};

export function escrowTargetFor(symbol: string, mainnetMint: string): EscrowTarget {
  if (CLUSTER === 'mainnet-beta') return { mint: mainnetMint, mock: false };

  const m = MARKETS[symbol.toUpperCase()];
  if (!m) return { mint: mainnetMint, mock: false };

  return {
    mint: m.mint,
    mock: m.mock,
    decimals: m.decimals,
    multiplier: m.multiplier,
    feeBps: m.feeBps,
  };
}

export const DEPLOYMENT = {
  cluster: (devnet as { cluster?: string }).cluster ?? CLUSTER,
  programId: (devnet as { programId?: string }).programId,
  quoteMint: (devnet as { quoteMint?: string }).quoteMint,
};
