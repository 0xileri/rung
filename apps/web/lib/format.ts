/**
 * Display formatting.
 *
 * Kept apart from the settlement math in @rung/sdk on purpose: everything here is
 * lossy by design (rounding, abbreviating, choosing significant digits), and none of it may
 * ever feed back into an amount the program stores.
 */

/** $1.4249T, $36.5B, $27.9k — the scale private-market valuations actually live at. */
export function valuation(usd: number): string {
  if (usd >= 1e12) return `$${(usd / 1e12).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}T`;
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(1)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(1)}M`;
  if (usd >= 1e3) return `$${(usd / 1e3).toFixed(1)}k`;
  return `$${usd.toFixed(0)}`;
}

/** Short form for a valuation band label: $1.20T, $900B. */
export function band(usd: number): string {
  if (usd >= 1e12) return `$${(usd / 1e12).toFixed(2).replace(/0$/, '')}T`;
  return `$${Math.round(usd / 1e9)}B`;
}

export function usd(amount: number, dp = 2): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

/** A dollar gain or loss: +$4.60, −$8.23. */
export function signedUsd(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${usd(Math.abs(n))}`;
}

/** Signed, because the whole point is how far a target sits from the market. */
export function pct(fraction: number, dp = 2): string {
  const sign = fraction > 0 ? '+' : fraction < 0 ? '−' : '';
  return `${sign}${Math.abs(fraction * 100).toFixed(dp)}%`;
}

/** USDC base units to a readable dollar figure. */
export function fromQuote(raw: bigint | number, decimals = 6): number {
  return Number(raw) / 10 ** decimals;
}

/**
 * A dollar figure back to USDC base units.
 *
 * Rounds rather than truncates, and treats anything unparseable as zero: a typed amount of
 * "12.3456789" must land on a whole base unit, and a half-typed one must not become NaN and
 * propagate into an instruction.
 */
export function toQuote(amount: number, decimals = 6): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  return BigInt(Math.round(amount * 10 ** decimals));
}

export function shortKey(key: string, lead = 4, tail = 4): string {
  return key.length <= lead + tail + 1 ? key : `${key.slice(0, lead)}…${key.slice(-tail)}`;
}

/** "Sep 20, 2026, 7:06 PM" in the viewer's own timezone. */
export function dateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Time left until a deadline, in the largest unit it fills: "30d", "5h", "4m". Rounded up, so
 * a deadline still to come never reads as zero; whole days alone would call five minutes "1d".
 */
export function timeUntil(unixSeconds: number): string {
  const secs = Math.max(0, unixSeconds - Date.now() / 1000);
  if (secs >= 86_400) return `${Math.ceil(secs / 86_400)}d`;
  if (secs >= 3_600) return `${Math.ceil(secs / 3_600)}h`;
  return `${Math.ceil(secs / 60)}m`;
}

export function explorer(kind: 'address' | 'tx', id: string, cluster: string): string {
  const suffix = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
  return `https://explorer.solana.com/${kind}/${id}${suffix}`;
}
