/**
 * Sizing a partial take.
 *
 * A commitment can be taken in slices, and the program prices each slice pro rata against
 * the USDC the maker actually escrowed. These helpers mirror that arithmetic exactly,
 * including which way it rounds, so a client can show a holder what a slice will cost before
 * they sign rather than discovering it from a simulation.
 *
 * Every figure here is in raw base units. The program never reads UI amounts, and neither
 * does this: a ScaledUiAmount multiplier changes what a raw figure *means* to a human, never
 * what it is worth in the vault.
 */

/** The maker's terms, as recorded on the Position account. */
export type CommitmentTerms = {
  /** USDC measured into the vault at creation. Every slice is priced against this. */
  strikeQuoteEscrowed: bigint;
  /** Still unclaimed, and therefore the largest slice available. */
  strikeQuoteOpen: bigint;
  /** Stock the vault must hold if the commitment is taken in full. */
  stockRawRequired: bigint;
  /** Premium for the full size. */
  premiumQuoteAmount: bigint;
};

export type FillQuote = {
  /** USDC of the maker's escrow this slice claims. */
  strikeQuote: bigint;
  /** Stock the vault must receive, which is what the program checks. */
  stockRawRequired: bigint;
  /** Premium the taker pays, before the protocol's cut is split out of it. */
  premiumQuote: bigint;
  /** The protocol's cut, taken out of the premium rather than added to it. */
  feeQuote: bigint;
  /** What actually reaches the maker. */
  premiumToMaker: bigint;
  /** What would be left open on the commitment afterwards. */
  remainingOpen: bigint;
};

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** `ceil(value × numerator / denominator)`, matching the program's `mul_div_ceil`. */
export function proRataCeil(value: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('denominator must be positive');
  return ceilDiv(value * numerator, denominator);
}

/**
 * Price one slice of a commitment.
 *
 * Stock and premium round **up**, exactly as the program does. That is the direction a taker
 * cannot farm: the sum over any partition of a commitment is at least the whole, so slicing
 * can never buy the same claim more cheaply. The protocol fee rounds down, so rounding can
 * never invent a fee the premium cannot cover.
 */
export function quoteFill(
  terms: CommitmentTerms,
  strikeQuote: bigint,
  feeBps: number | bigint = 0,
): FillQuote {
  if (strikeQuote <= 0n) throw new Error('a fill must claim something');
  if (strikeQuote > terms.strikeQuoteOpen) throw new Error('a fill cannot exceed the open amount');

  const stockRawRequired = proRataCeil(terms.stockRawRequired, strikeQuote, terms.strikeQuoteEscrowed);
  const premiumQuote = proRataCeil(terms.premiumQuoteAmount, strikeQuote, terms.strikeQuoteEscrowed);
  const feeQuote = (premiumQuote * BigInt(feeBps)) / 10_000n;

  return {
    strikeQuote,
    stockRawRequired,
    premiumQuote,
    feeQuote,
    premiumToMaker: premiumQuote - feeQuote,
    remainingOpen: terms.strikeQuoteOpen - strikeQuote,
  };
}

/**
 * Why a slice is not allowed, or `null` if it is.
 *
 * The two dust rules exist so that every commitment shown on the curve is actually takeable:
 * a slice must be worth settling, and what it leaves behind must be worth settling too. The
 * exception is the one that matters in practice — taking the whole remainder is always
 * allowed, however small it has become.
 */
export function fillRejection(
  terms: CommitmentTerms,
  strikeQuote: bigint,
  minFillQuote: bigint,
): 'below-minimum' | 'leaves-dust' | 'exceeds-open' | 'empty' | null {
  if (strikeQuote <= 0n) return 'empty';
  if (strikeQuote > terms.strikeQuoteOpen) return 'exceeds-open';
  const remainder = terms.strikeQuoteOpen - strikeQuote;
  if (strikeQuote < minFillQuote && remainder !== 0n) return 'below-minimum';
  if (remainder !== 0n && remainder < minFillQuote) return 'leaves-dust';
  return null;
}

/** One commitment a sweep would take a slice of. */
export type SweepLeg<T extends CommitmentTerms = CommitmentTerms> = {
  commitment: T;
  quote: FillQuote;
};

/**
 * Fill a target amount of USDC across several commitments, cheapest premium first.
 *
 * This is what makes a band on the curve usable as one line of protection rather than a list
 * of offers to work through by hand. Legs come back in the order they should be signed, and
 * the caller packs them into one transaction.
 *
 * `premiumRate` orders the book: premium per unit of strike, so a holder pays the least for
 * the same floor. A commitment that cannot legally be sliced for what is left of the target
 * is taken whole if it fits, and otherwise skipped rather than half-taken.
 */
export function planSweep<T extends CommitmentTerms>(
  commitments: T[],
  targetQuote: bigint,
  opts: { minFillQuote?: bigint; feeBps?: number } = {},
): { legs: SweepLeg<T>[]; filled: bigint; shortfall: bigint } {
  const minFill = opts.minFillQuote ?? 0n;
  const feeBps = opts.feeBps ?? 0;
  const rate = (c: CommitmentTerms) =>
    Number(c.premiumQuoteAmount) / Math.max(1, Number(c.strikeQuoteEscrowed));

  const book = [...commitments]
    .filter((c) => c.strikeQuoteOpen > 0n)
    .sort((a, b) => rate(a) - rate(b));

  const legs: SweepLeg<T>[] = [];
  let remaining = targetQuote;

  for (const commitment of book) {
    if (remaining <= 0n) break;
    let take = remaining < commitment.strikeQuoteOpen ? remaining : commitment.strikeQuoteOpen;
    if (fillRejection(commitment, take, minFill) !== null) {
      // A slice this size is not allowed here. Taking the commitment whole is, whenever the
      // sweep still has room for it; otherwise leave it alone rather than overshooting.
      take = commitment.strikeQuoteOpen;
      if (take > remaining || fillRejection(commitment, take, minFill) !== null) continue;
    }
    legs.push({ commitment, quote: quoteFill(commitment, take, feeBps) });
    remaining -= take;
  }

  return { legs, filled: targetQuote - remaining, shortfall: remaining };
}
