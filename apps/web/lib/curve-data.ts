/**
 * The Commitment Curve as data: what /api/curve serves, and what the asset page's signal reads.
 *
 * Everything comes from the same chain read and SDK arithmetic as the pages, so the API can never
 * disagree with the site. Figures are in whole USD (the program's raw USDC units divided out) so
 * a consumer never has to know about decimals.
 */
import { getPositionsCached } from './positions-cache';
import { CLUSTER, PROGRAM_ID, toOpenCommitments } from './chain';
import { getPreStocks, findAsset } from './prestocks-cache';
import { escrowTargetFor } from './deployment';
import { buildCurve, curveSignal } from '../../../packages/sdk/src/commitment-curve.ts';
import { bandAnchor, relativeTo, valuationBands } from '../../../packages/sdk/src/valuation.ts';

const dollars = (raw: bigint) => Number(raw) / 1e6;

export async function curveData(symbol: string) {
  const { assets } = await getPreStocks();
  const asset = findAsset(assets, symbol);
  if (!asset) return null;
  const escrow = escrowTargetFor(asset.symbol, asset.contract_address);
  const fetched = await getPositionsCached();
  if (!fetched.ok) return { error: 'The chain could not be read just now.' } as const;
  const open = toOpenCommitments(fetched.positions, escrow.mint);
  const signal = curveSignal(open);
  const bands = buildCurve(open, valuationBands(bandAnchor(asset), 6));
  return {
    symbol: asset.symbol,
    name: asset.name.replace(/ PreStocks$/i, ''),
    cluster: CLUSTER,
    program: PROGRAM_ID.toBase58(),
    updatedAt: new Date().toISOString(),
    ...(fetched.staleSeconds ? { staleSeconds: fetched.staleSeconds } : {}),
    marketValuationUsd: asset.impliedValuation,
    markValuationUsd: asset.markValuation,
    signal: {
      medianFloorUsd: signal.medianFloorUsd,
      medianFloorVsMarket: signal.medianFloorUsd ? relativeTo(signal.medianFloorUsd, asset.impliedValuation) : null,
      committedUsd: dollars(signal.committed),
      commitments: signal.commitments,
      wallets: signal.wallets,
      highestFloorUsd: signal.highestFloorUsd,
      lowestFloorUsd: signal.lowestFloorUsd,
    },
    bands: bands.map((b) => ({
      valuationUsd: b.valuationUsd,
      committedUsd: dollars(b.committed),
      openCommitments: b.openPositions,
      uniqueWallets: b.uniqueWallets,
      largestWalletShare: b.largestWalletShare,
      avgPremiumPct: b.avgPremiumPct,
      medianExpiryDays: b.medianExpiryDays,
    })),
  };
}

export const API_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
  'Content-Type': 'application/json',
};
