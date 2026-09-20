/**
 * Token-2022 extension arithmetic, ported to match the on-chain semantics exactly.
 *
 * PreStocks mints carry both a TransferFee and a ScaledUiAmount config. Getting either
 * one subtly wrong silently corrupts every position, so these helpers mirror the
 * reference implementation in spl-token-2022 rather than approximating it.
 */

export const ONE_IN_BASIS_POINTS = 10_000n;

export type TransferFee = {
  /** First epoch this fee applies to. */
  epoch: bigint;
  transferFeeBasisPoints: number;
  maximumFee: bigint;
};

/**
 * Token-2022 keeps a two-slot schedule so a fee change can be announced an epoch ahead.
 * Both slots are live data: which one applies depends on the *current* epoch.
 */
export type TransferFeeConfig = {
  olderTransferFee: TransferFee;
  newerTransferFee: TransferFee;
};

/**
 * Pick the fee in force for `currentEpoch`.
 *
 * The newer fee only takes over once the chain reaches its epoch; until then the older
 * one is still the live fee. The OpenAI PreStock is mid-schedule right now (older 50bps,
 * newer 100bps at epoch 1039), so a hardcoded rate is wrong on one side of the rollover.
 */
export function activeTransferFee(
  config: TransferFeeConfig,
  currentEpoch: bigint,
): TransferFee {
  return currentEpoch >= config.newerTransferFee.epoch
    ? config.newerTransferFee
    : config.olderTransferFee;
}

/**
 * Fee withheld from a transfer of `preFeeAmount`.
 *
 * Mirrors `TransferFee::calculate_fee`: the basis-point division rounds *up*, then the
 * result is capped at `maximumFee`. Rounding down here would under-report the fee and
 * leave the vault short of what the program expects.
 */
export function calculateFee(preFeeAmount: bigint, fee: TransferFee): bigint {
  const bps = BigInt(fee.transferFeeBasisPoints);
  if (bps === 0n || preFeeAmount === 0n) return 0n;
  const ceilDiv = (preFeeAmount * bps + ONE_IN_BASIS_POINTS - 1n) / ONE_IN_BASIS_POINTS;
  return ceilDiv < fee.maximumFee ? ceilDiv : fee.maximumFee;
}

/** Raw units that actually land in the destination account when `sent` is transferred. */
export function amountReceived(sent: bigint, fee: TransferFee): bigint {
  return sent - calculateFee(sent, fee);
}

export type ScaledUiAmountConfig = {
  multiplier: number;
  newMultiplier: number;
  newMultiplierEffectiveTimestamp: number;
};

/**
 * The multiplier actually in force at `nowTs`.
 *
 * `multiplier` is the *outgoing* value. Once `newMultiplierEffectiveTimestamp` passes,
 * `newMultiplier` is live and `multiplier` becomes stale history. For the OpenAI PreStock
 * that timestamp passed on 2026-07-17, so reading `multiplier` yields 1 when the real
 * figure is 1.4861347 — a 48.6% error in every quantity derived from it.
 */
export function activeMultiplier(config: ScaledUiAmountConfig, nowTs: number): number {
  return nowTs >= config.newMultiplierEffectiveTimestamp
    ? config.newMultiplier
    : config.multiplier;
}

/**
 * Raw base units -> the UI amount a wallet displays (and the unit PreStocks quotes prices in).
 */
export function rawToUi(raw: bigint, decimals: number, multiplier: number): number {
  return (Number(raw) / 10 ** decimals) * multiplier;
}

/**
 * UI amount -> raw base units, the only quantity the program should ever store.
 *
 * Rounds to nearest; callers settling real collateral should treat the result as final and
 * re-derive the UI figure from it for display, so the two can never drift apart.
 */
export function uiToRaw(ui: number, decimals: number, multiplier: number): bigint {
  return BigInt(Math.round((ui / multiplier) * 10 ** decimals));
}
