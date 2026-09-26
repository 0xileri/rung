/**
 * Profit and loss for one side of a Rung position, in USDC.
 *
 * A matched position is a put: the holder may hand over the tokens in the vault in exchange
 * for the maker's strike. Measured against simply letting it expire -- each side takes back
 * its own collateral -- only two things move value between the parties: the premium, and,
 * if the holder exercises, that swap. So the two sides' figures are opposites:
 *
 *   maker  = premium received - swap
 *   holder = swap - premium paid
 *
 * With no protocol fee those two premiums are the same number and the figures cancel
 * exactly. With one, the holder pays the whole premium and the maker receives it less the
 * fee, so callers pass each side its own figure and the two differ by precisely the fee.
 *
 * where `swap` is the strike less the market value of the tokens that would leave the vault
 * (after the mint's exit fee):
 *
 *   - Matched, still live: max(0, swap). The holder only exercises when it pays them, so this
 *     is intrinsic value. No time value is modelled, on purpose: Rung makes no claim about
 *     what an option is "worth", and a pricing model would be exactly that claim.
 *   - Exercised: swap, with the tokens valued at today's price, since that is what the maker
 *     now holds and what the holder gave up.
 *   - Expired: zero. Both collaterals went home; only the premium changed hands.
 *   - Open or cancelled: nothing has been exchanged, so there is no P&L.
 *
 * Transfer fees are left out of both figures. They are charged by the token issuer, not paid
 * to the counterparty, and the interface discloses them separately.
 */

export type PnlStatus = 'Open' | 'Matched' | 'Exercised' | 'Expired' | 'Cancelled';

/** How the figure was arrived at, so the interface can say so next to it. */
export type PnlBasis =
  /** Nothing exchanged yet, or ever. */
  | 'none'
  /** Live position at today's price, exercise value only. */
  | 'intrinsic'
  /** Settled by exercise; the delivered tokens are valued at today's price. */
  | 'marked'
  /** Settled by expiry; only the premium moved, so the figure is final. */
  | 'realized';

export type PositionPnlInput = {
  side: 'maker' | 'holder';
  status: PnlStatus;
  strikeUsd: number;
  premiumUsd: number;
  /** Tokens that leave the vault on settlement, in UI units, i.e. after the exit fee. */
  stockOutUi: number;
  /** Market price per UI token. Needed only for matched and exercised positions. */
  tokenPrice: number | null;
};

export type PositionPnl = {
  usd: number | null;
  basis: PnlBasis;
  /** Value the swap transfers to the holder (negative when exercising would cost them). */
  swapUsd: number | null;
};

export function positionPnl(input: PositionPnlInput): PositionPnl {
  const { side, status, strikeUsd, premiumUsd, stockOutUi, tokenPrice } = input;
  const sign = side === 'maker' ? 1 : -1;

  if (status === 'Open' || status === 'Cancelled') return { usd: 0, basis: 'none', swapUsd: 0 };
  if (status === 'Expired') return { usd: sign * premiumUsd, basis: 'realized', swapUsd: 0 };

  // Matched and Exercised both need a price; without one there is no honest number.
  if (tokenPrice === null || !Number.isFinite(tokenPrice) || tokenPrice <= 0) {
    return { usd: null, basis: status === 'Matched' ? 'intrinsic' : 'marked', swapUsd: null };
  }
  const swap = strikeUsd - stockOutUi * tokenPrice;
  const transferred = status === 'Matched' ? Math.max(0, swap) : swap;
  return {
    usd: sign * (premiumUsd - transferred),
    basis: status === 'Matched' ? 'intrinsic' : 'marked',
    swapUsd: swap,
  };
}
