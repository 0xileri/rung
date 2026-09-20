/**
 * Valuation <-> strike conversion.
 *
 * Rung is priced in company valuations because that is how private-market investors
 * think, but a valuation is a moving reference and must never be the settlement term.
 * Everything here runs once, at creation time, to derive the *fixed* raw quantity the
 * program escrows. After that the contract is immutable and these numbers are only
 * explanatory metadata (see docs/economics.md).
 */

import { uiToRaw, type TransferFee, calculateFee, amountReceived } from './token2022.ts';

export type PreStockAsset = {
  symbol: string;
  name: string;
  contract_address: string;
  tokenPrice: number;
  impliedValuation: number;
  markPrice: number;
  markValuation: number;
  supply: number;
};

/**
 * Shares implied by a (valuation, price) pair.
 *
 * PreStocks derives both its mark and implied valuations from one fixed share count, so
 * `impliedValuation/tokenPrice` and `markValuation/markPrice` agree. Checking that they do
 * is a cheap guard that the feed is internally consistent before we price anything off it.
 */
export function impliedShareCount(valuation: number, price: number): number {
  return valuation / price;
}

/** True when mark and implied agree on the share count, within `tolerancePct`. */
export function isFeedConsistent(asset: PreStockAsset, tolerancePct = 0.001): boolean {
  const fromImplied = impliedShareCount(asset.impliedValuation, asset.tokenPrice);
  const fromMark = impliedShareCount(asset.markValuation, asset.markPrice);
  return Math.abs(fromImplied - fromMark) / fromMark <= tolerancePct;
}

/**
 * Token price corresponding to `targetValuation`, using the mark as the reference basis.
 *
 * Proportional because the share count is constant: a company worth half as much has
 * tokens worth half as much.
 */
export function targetTokenPrice(
  markPrice: number,
  markValuation: number,
  targetValuation: number,
): number {
  if (markPrice <= 0) throw new RangeError('markPrice must be positive');
  if (markValuation <= 0) throw new RangeError('markValuation must be positive');
  if (targetValuation <= 0) throw new RangeError('targetValuation must be positive');
  return markPrice * (targetValuation / markValuation);
}

/** Signed fraction by which `target` sits above (+) or below (-) `reference`. */
export function relativeTo(target: number, reference: number): number {
  return (target - reference) / reference;
}

export type StrikeQuoteInput = {
  asset: PreStockAsset;
  /** Company valuation the buyer is willing to own at. */
  targetValuation: number;
  /** USDC the buyer locks, in whole dollars. */
  strikeUsd: number;
  decimals: number;
  /** Must be the *active* multiplier — see `activeMultiplier`. */
  multiplier: number;
  /** Must be the *active* fee — see `activeTransferFee`. */
  transferFee: TransferFee;
  usdcDecimals?: number;
};

export type StrikeQuote = {
  targetTokenPrice: number;
  /** Quantity in the units PreStocks quotes and wallets display. */
  uiQuantity: number;
  /** The settlement quantity. This is what the program stores. */
  rawQuantity: bigint;
  /** USDC strike in base units. */
  strikeQuoteAmount: bigint;
  discountToMark: number;
  discountToMarket: number;
  /** Raw units withheld when the holder funds the vault. */
  entryFee: bigint;
  /** What the vault actually ends up holding if the holder sends `rawQuantity`. */
  rawReceivedByVault: bigint;
  /** Raw units withheld again when the vault pays out. */
  exitFee: bigint;
  /** Fraction of the position consumed by a full round trip through the vault. */
  roundTripFeeFraction: number;
};

/**
 * Turn "I would own OpenAI around $1.0T with $100" into fixed, escrowable terms.
 *
 * The fee figures are advisory: they tell the user what a round trip costs, but the
 * protocol deliberately does not gross them up. The fee can change at an epoch boundary
 * between quoting and signing, so the program records what actually arrives in the vault
 * rather than asserting an amount computed here.
 */
export function quoteStrike(input: StrikeQuoteInput): StrikeQuote {
  const { asset, targetValuation, strikeUsd, decimals, multiplier, transferFee } = input;
  const usdcDecimals = input.usdcDecimals ?? 6;

  if (strikeUsd <= 0) throw new RangeError('strikeUsd must be positive');
  if (multiplier <= 0) throw new RangeError('multiplier must be positive');

  const price = targetTokenPrice(asset.markPrice, asset.markValuation, targetValuation);
  const uiQuantity = strikeUsd / price;
  const rawQuantity = uiToRaw(uiQuantity, decimals, multiplier);
  if (rawQuantity <= 0n) throw new RangeError('strike is too small to represent on-chain');

  const entryFee = calculateFee(rawQuantity, transferFee);
  const rawReceivedByVault = amountReceived(rawQuantity, transferFee);
  const exitFee = calculateFee(rawReceivedByVault, transferFee);
  const delivered = rawReceivedByVault - exitFee;

  return {
    targetTokenPrice: price,
    uiQuantity,
    rawQuantity,
    strikeQuoteAmount: BigInt(Math.round(strikeUsd * 10 ** usdcDecimals)),
    discountToMark: relativeTo(targetValuation, asset.markValuation),
    discountToMarket: relativeTo(targetValuation, asset.impliedValuation),
    entryFee,
    rawReceivedByVault,
    exitFee,
    roundTripFeeFraction: Number(rawQuantity - delivered) / Number(rawQuantity),
  };
}

/** Standardized bands from §32 — keeps liquidity from fragmenting across arbitrary strikes. */
export function valuationBands(markValuation: number, count = 6): number[] {
  const magnitude = 10 ** Math.floor(Math.log10(markValuation) - 1);
  const top = Math.round(markValuation / magnitude) * magnitude;
  return Array.from({ length: count }, (_, i) => top - i * magnitude).filter((v) => v > 0);
}
