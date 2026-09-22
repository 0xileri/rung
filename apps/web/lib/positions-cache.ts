import { fetchPositions, type PositionsResult } from './chain';

/**
 * Server-side cache of every Position, so a rate-limited RPC does not empty the curve.
 *
 * Public RPCs answer bursts with 429s, and every server render reads the whole program. A
 * short fresh window absorbs bursts; beyond it, a failed read falls back to the last good
 * one for up to half an hour, flagged with its age so the page can say so. Past that the
 * failure is returned as-is: showing positions from hours ago as current would be worse
 * than saying the chain is unreachable.
 */

const FRESH_MS = 10_000;
const STALE_MAX_MS = 30 * 60_000;

type Ok = Extract<PositionsResult, { ok: true }>;
let last: { positions: Ok['positions']; fills: Ok['fills']; at: number } | null = null;
let inflight: Promise<PositionsResult> | null = null;

export async function getPositionsCached(): Promise<PositionsResult> {
  if (last && Date.now() - last.at < FRESH_MS) {
    return { ok: true, positions: last.positions, fills: last.fills };
  }

  // Concurrent renders share one read instead of each hitting the RPC.
  inflight ??= fetchPositions().finally(() => {
    inflight = null;
  });
  const result = await inflight;

  if (result.ok) {
    last = { positions: result.positions, fills: result.fills, at: Date.now() };
    return result;
  }
  if (last && Date.now() - last.at < STALE_MAX_MS) {
    return {
      ok: true,
      positions: last.positions,
      fills: last.fills,
      staleSeconds: Math.round((Date.now() - last.at) / 1000),
    };
  }
  return result;
}
