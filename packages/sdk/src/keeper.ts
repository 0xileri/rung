/**
 * Which claims a keeper should settle, and in what order.
 *
 * Settlement after a deadline is permissionless on Rung: anyone may return both sides their
 * collateral, so nobody depends on a counterparty coming back. A keeper is simply someone
 * who does it on a schedule, for everyone. This decides what is due; the keeper script
 * builds and sends the transactions.
 *
 * "Due" mirrors the program's own check exactly — a fill still Matched whose commitment's
 * deadline is strictly in the past on the cluster's clock — so a keeper never spends a fee
 * on a settlement the program would refuse. Anything the keeper cannot place (a fill whose
 * commitment it could not read) is left for the next cycle rather than guessed at.
 */

export type KeeperFill = {
  fill: string;
  position: string;
  status: 'Matched' | 'Exercised' | 'Expired';
  strikeQuoteAmount: bigint;
};

export type KeeperCommitment = {
  position: string;
  expiryTs: number;
};

export type DueSettlement = {
  fill: string;
  position: string;
  /** How long past its deadline, in seconds. */
  overdue: number;
  strikeQuoteAmount: bigint;
};

/**
 * Fills due for settlement at `now`, most overdue first, at most `limit` of them.
 *
 * Most overdue first because those are the collateral people have waited longest for; a
 * cycle that cannot clear everything should never starve the oldest claims in favour of
 * newer ones.
 */
export function dueForSettlement(
  fills: KeeperFill[],
  commitments: KeeperCommitment[],
  now: number,
  limit = Infinity,
): DueSettlement[] {
  const expiryOf = new Map(commitments.map((c) => [c.position, c.expiryTs]));
  const due: DueSettlement[] = [];
  for (const f of fills) {
    if (f.status !== 'Matched') continue;
    const expiry = expiryOf.get(f.position);
    if (expiry === undefined) continue;
    // The program refuses at now == expiry: `is_expired` is strictly greater-than.
    if (now <= expiry) continue;
    due.push({ fill: f.fill, position: f.position, overdue: now - expiry, strikeQuoteAmount: f.strikeQuoteAmount });
  }
  return due
    .sort((a, b) => b.overdue - a.overdue || (a.fill < b.fill ? -1 : 1))
    .slice(0, Number.isFinite(limit) ? Math.max(0, limit) : undefined);
}
