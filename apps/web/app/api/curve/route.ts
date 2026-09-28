/**
 * GET /api/curve: every listed asset's signal in one call, with a link to each full curve.
 */
import { API_HEADERS, curveData } from '../../../lib/curve-data';
import { LISTED_SYMBOLS } from '../../../lib/deployment';
import { CLUSTER } from '../../../lib/chain';

export const dynamic = 'force-dynamic';

export function OPTIONS() {
  return new Response(null, { status: 204, headers: API_HEADERS });
}

export async function GET() {
  const all = await Promise.all(LISTED_SYMBOLS.map((s) => curveData(s).catch(() => null)));
  const assets = all.flatMap((d) =>
    !d || d.error !== undefined
      ? []
      : [{ symbol: d.symbol, name: d.name, marketValuationUsd: d.marketValuationUsd, ...d.signal, curve: `/api/curve/${d.symbol}` }],
  );
  return new Response(JSON.stringify({ cluster: CLUSTER, updatedAt: new Date().toISOString(), assets }, null, 1), { headers: API_HEADERS });
}
