import { capitalSeries } from '../../../packages/sdk/src/capital.ts';
import type { CapitalPointUsd } from '../components/CapitalCharts';
import type { Fill, Position } from './chain';
import { fromQuote } from './format';

/**
 * Chain accounts to chart points, for any slice of the book: one asset, one maker, or all.
 *
 * Fills are matched to their commitment rather than filtered separately, so a slice can never
 * include a claim on a commitment it left out, or the reverse.
 */
export function capitalPointsUsd(
  positions: Position[],
  fills: Fill[],
  now: number,
  include: (p: Position) => boolean = () => true,
): CapitalPointUsd[] {
  const chosen = positions.filter(include);
  const keys = new Set(chosen.map((p) => p.pubkey));
  return capitalSeries(
    chosen.map((p) => ({
      position: p.pubkey,
      strikeQuoteEscrowed: p.strikeQuoteEscrowed,
      createdAt: p.createdAt,
      expiryTs: p.expiryTs,
      withdrawnAt: p.withdrawnAt,
    })),
    fills.filter((f) => keys.has(f.position)),
    now,
  ).map((pt) => ({
    t: pt.t,
    offered: fromQuote(pt.offered),
    inForce: fromQuote(pt.inForce),
    matched: fromQuote(pt.matched),
    premium: fromQuote(pt.premium),
  }));
}
