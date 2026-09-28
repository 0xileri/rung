/**
 * GET /api/curve/<SYMBOL>: one asset's Commitment Curve and its signal, as JSON, for anyone.
 */
import { API_HEADERS, curveData } from '../../../../lib/curve-data';

export const dynamic = 'force-dynamic';

export function OPTIONS() {
  return new Response(null, { status: 204, headers: API_HEADERS });
}

export async function GET(_req: Request, ctx: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await ctx.params;
  const data = await curveData(symbol).catch(() => ({ error: 'Could not build the curve just now.' }) as const);
  if (!data) return new Response(JSON.stringify({ error: `No PreStock called ${symbol}.` }), { status: 404, headers: API_HEADERS });
  if (data.error !== undefined) return new Response(JSON.stringify(data), { status: 503, headers: API_HEADERS });
  return new Response(JSON.stringify(data, null, 1), { headers: API_HEADERS });
}
