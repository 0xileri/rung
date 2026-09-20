import { NextResponse } from 'next/server';
import {
  fetchPreStocks,
  fetchMintState,
  rpcFromUrl,
  custodyCaveats,
} from '../../../../../packages/sdk/src/prestocks.ts';
import { isFeedConsistent } from '../../../../../packages/sdk/src/valuation.ts';

/**
 * Server-side because two things have to happen before the browser sees this data.
 *
 * The PreStocks API sends no CORS headers, so a browser cannot read it directly. More
 * importantly, the mint's live state has to be folded in here: which ScaledUiAmount
 * multiplier is active and which transfer-fee slot the current epoch selects. Resolving
 * those once, server-side, means no client code can accidentally read the stale field.
 */

export const revalidate = 30;

const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get('symbol');

  try {
    const assets = await fetchPreStocks();
    const wanted = symbol
      ? assets.filter((a) => a.symbol.toUpperCase() === symbol.toUpperCase())
      : assets;

    if (symbol && wanted.length === 0) {
      return NextResponse.json({ error: `No PreStock named ${symbol}` }, { status: 404 });
    }

    // Only resolve mint state when a single asset is asked for: it is two RPC calls per
    // mint, and the discover list does not need it.
    if (symbol) {
      const asset = wanted[0];
      const mint = await fetchMintState(asset.contract_address, rpcFromUrl(RPC));
      return NextResponse.json({
        asset,
        mint: { ...mint, transferFee: { ...mint.transferFee, epoch: mint.transferFee.epoch.toString(), maximumFee: mint.transferFee.maximumFee.toString() } },
        caveats: custodyCaveats(mint),
        // Surfaced rather than silently trusted: if mark and implied stop agreeing on the
        // share count, the proportional valuation mapping no longer holds.
        feedConsistent: isFeedConsistent(asset),
        fetchedAt: Date.now(),
      });
    }

    return NextResponse.json({
      assets: wanted.map((a) => ({ ...a, feedConsistent: isFeedConsistent(a) })),
      fetchedAt: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to reach PreStocks' },
      { status: 502 },
    );
  }
}
