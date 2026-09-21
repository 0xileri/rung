import { PublicKey, type Connection, type ParsedAccountData } from '@solana/web3.js';
import {
  activeMultiplier,
  activeTransferFee,
  amountReceived,
  rawToUi,
  type TransferFee,
} from '../../../packages/sdk/src/token2022.ts';
import { positionPnl, type PnlBasis } from '../../../packages/sdk/src/pnl.ts';
import type { Position } from './chain';
import { fromQuote } from './format';
import { symbolForMint, type MintedAsset } from './deployment';

/**
 * Everything the P&L of a live position depends on besides the position itself, and the one
 * place that turns a Position account into a figure. Shared by My Positions, the landing
 * page's protocol totals and its "your P&L" line, so they cannot disagree.
 */

export type MintScale = { decimals: number; multiplier: number; fee: TransferFee | null };

/** Decimals, active multiplier and active transfer fee for each mint, read from chain. */
export async function readMintScales(connection: Connection, mints: string[]): Promise<Record<string, MintScale>> {
  const unique = [...new Set(mints)];
  if (unique.length === 0) return {};
  const [infos, { epoch }] = await Promise.all([
    connection.getMultipleParsedAccounts(unique.map((m) => new PublicKey(m))),
    connection.getEpochInfo(),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const out: Record<string, MintScale> = {};
  infos.value.forEach((acc, i) => {
    const info = (acc?.data as ParsedAccountData | undefined)?.parsed?.info;
    if (!info) return;
    const exts = (info.extensions ?? []) as { extension: string; state: Record<string, any> }[];
    const scale = exts.find((e) => e.extension === 'scaledUiAmountConfig')?.state;
    const fees = exts.find((e) => e.extension === 'transferFeeConfig')?.state;
    const toFee = (f: { epoch: number; transferFeeBasisPoints: number; maximumFee: number }): TransferFee => ({
      epoch: BigInt(f.epoch),
      transferFeeBasisPoints: Number(f.transferFeeBasisPoints),
      maximumFee: BigInt(f.maximumFee),
    });
    out[unique[i]] = {
      decimals: Number(info.decimals),
      multiplier: scale
        ? activeMultiplier(
            {
              multiplier: Number(scale.multiplier),
              newMultiplier: Number(scale.newMultiplier),
              newMultiplierEffectiveTimestamp: Number(scale.newMultiplierEffectiveTimestamp),
            },
            now,
          )
        : 1,
      fee: fees
        ? activeTransferFee(
            { olderTransferFee: toFee(fees.olderTransferFee), newerTransferFee: toFee(fees.newerTransferFee) },
            BigInt(epoch),
          )
        : null,
    };
  });
  return out;
}

export type PriceBook = { bySymbol: Record<string, number>; assets: MintedAsset[] };

export function priceBook(assets: (MintedAsset & { tokenPrice: number })[]): PriceBook {
  return { bySymbol: Object.fromEntries(assets.map((a) => [a.symbol, a.tokenPrice])), assets };
}

export type PositionPnlView = {
  usd: number | null;
  basis: PnlBasis;
  symbol: string | null;
  price: number | null;
};

export function pnlForPosition(
  p: Position,
  side: 'maker' | 'holder',
  scale: MintScale | undefined,
  prices: PriceBook | null,
): PositionPnlView {
  const symbol = prices ? symbolForMint(p.stockMint, prices.assets) : null;
  const price = symbol && prices ? (prices.bySymbol[symbol] ?? null) : null;
  // Exercise and expiry zero the escrow fields once the vaults are empty. The required
  // quantity stands in after that: the escrow was sized to land on it at the worse fee
  // slot, so it matches what was delivered to within the slots' spread, and never exceeds it.
  const escrowedRaw = p.stockRawEscrowed > 0n ? p.stockRawEscrowed : p.stockRawRequired;
  const outRaw = scale?.fee ? amountReceived(escrowedRaw, scale.fee) : escrowedRaw;
  const r = positionPnl({
    side,
    status: p.status,
    strikeUsd: fromQuote(p.strikeQuoteEscrowed || p.strikeQuoteAmount),
    premiumUsd: fromQuote(p.premiumQuoteAmount),
    stockOutUi: scale ? rawToUi(outRaw, scale.decimals, scale.multiplier) : 0,
    // Without the mint's scale the token count is unknown, so no price can be applied.
    tokenPrice: scale ? price : null,
  });
  return { usd: r.usd, basis: r.basis, symbol, price };
}

/** Green for a gain, red for a loss, muted for zero or unknown. */
export const pnlColor = (n: number | null) =>
  n === null || Math.abs(n) < 0.005 ? 'var(--text-muted)' : n > 0 ? 'var(--teal-ink)' : 'var(--danger)';

/** Sum a set of P&L figures, counting only positions where something changed hands. */
export function totalPnl(views: PositionPnlView[]) {
  const counted = views.filter((v) => v.basis !== 'none');
  const unpriced = counted.filter((v) => v.usd === null).length;
  return {
    usd: counted.reduce((sum, v) => sum + (v.usd ?? 0), 0),
    positions: counted.length,
    unpriced,
    /** True when no counted position could be valued, so the sum means nothing. */
    empty: counted.length === 0 || unpriced === counted.length,
  };
}
