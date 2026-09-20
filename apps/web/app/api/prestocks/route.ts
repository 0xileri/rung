import { NextResponse } from 'next/server';
import { custodyCaveats } from '../../../../../packages/sdk/src/prestocks.ts';
import { isFeedConsistent } from '../../../../../packages/sdk/src/valuation.ts';
import { getPreStocks, findAsset, getMintState } from '../../../lib/prestocks-cache';

/**
 * Server-side because two things must happen before the browser sees this data.
 *
 * The PreStocks API sends no CORS headers, so a browser cannot read it directly. More
 * importantly, the mint's live state is folded in here: which ScaledUiAmount multiplier is
 * active and which transfer-fee slot the current epoch selects. Resolving those once,
 * server-side, means no client code can accidentally read the stale field.
 */

export const dynamic = 'force-dynamic';


export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get('symbol');

  try {
    const { assets, fetchedAt, stale } = await getPreStocks();

    if (!symbol) {
      return NextResponse.json({
        assets: assets.map((a) => ({ ...a, feedConsistent: isFeedConsistent(a) })),
        fetchedAt,
        stale,
      });
    }

    const asset = findAsset(assets, symbol);
    if (!asset) {
      return NextResponse.json({ error: `No PreStock named ${symbol}` }, { status: 404 });
    }

    const mint = await getMintState(asset.contract_address);
    return NextResponse.json({
      asset,
      mint: {
        ...mint,
        // BigInt is not JSON-serializable; the client only displays these.
        transferFee: {
          ...mint.transferFee,
          epoch: mint.transferFee.epoch.toString(),
          maximumFee: mint.transferFee.maximumFee.toString(),
        },
      },
      caveats: custodyCaveats(mint),
      // Surfaced rather than silently trusted: if mark and implied stop agreeing on the
      // share count, the proportional valuation mapping no longer holds.
      feedConsistent: isFeedConsistent(asset),
      fetchedAt,
      stale,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to reach PreStocks' },
      { status: 502 },
    );
  }
}
