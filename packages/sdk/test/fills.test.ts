import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quoteFill, fillRejection, planSweep, proRataCeil,
  type CommitmentTerms,
} from '../src/fills.ts';

const usd = (n: number) => BigInt(Math.round(n * 1e6));

/** A 100 USDC commitment for 0.09 OPENAI, at a 5 USDC premium. */
const terms = (over: Partial<CommitmentTerms> = {}): CommitmentTerms => ({
  strikeQuoteEscrowed: usd(100),
  strikeQuoteOpen: usd(100),
  stockRawRequired: 90_000_000n,
  premiumQuoteAmount: usd(5),
  ...over,
});

test('a slice costs its share of the stock and the premium', () => {
  const q = quoteFill(terms(), usd(40));
  assert.equal(q.stockRawRequired, 36_000_000n);
  assert.equal(q.premiumQuote, usd(2));
  assert.equal(q.remainingOpen, usd(60));
});

test('taking the whole thing matches the maker terms exactly', () => {
  const q = quoteFill(terms(), usd(100));
  assert.equal(q.stockRawRequired, 90_000_000n);
  assert.equal(q.premiumQuote, usd(5));
  assert.equal(q.remainingOpen, 0n);
});

test('splitting never buys the same claim for less than taking it whole', () => {
  // Deliberately awkward: an odd size, an odd premium, and slices that do not divide it.
  const t = terms({ strikeQuoteEscrowed: usd(99.99), strikeQuoteOpen: usd(99.99), stockRawRequired: 83_365_949n, premiumQuoteAmount: usd(4.61) });
  const whole = quoteFill(t, t.strikeQuoteOpen);

  for (const parts of [2, 3, 7, 13]) {
    const slice = t.strikeQuoteOpen / BigInt(parts);
    let stock = 0n;
    let premium = 0n;
    let open = t.strikeQuoteOpen;
    for (let i = 0; i < parts; i++) {
      const amount = i === parts - 1 ? open : slice;
      const q = quoteFill({ ...t, strikeQuoteOpen: open }, amount);
      stock += q.stockRawRequired;
      premium += q.premiumQuote;
      open -= amount;
    }
    assert.ok(stock >= whole.stockRawRequired, `${parts} slices must not cost less stock`);
    assert.ok(premium >= whole.premiumQuote, `${parts} slices must not cost less premium`);
    assert.equal(open, 0n);
  }
});

test('rounding goes up for the taker and down for the protocol', () => {
  // One base unit of strike against a 100 USDC commitment: both figures round up off zero.
  const q = quoteFill(terms(), 1n, 100);
  assert.equal(q.stockRawRequired, 1n);
  assert.equal(q.premiumQuote, 1n);
  // 100 bps of one base unit is 0.01, which must not become a whole unit of fee.
  assert.equal(q.feeQuote, 0n);
  assert.equal(q.premiumToMaker, 1n);
});

test('the fee comes out of the premium, not on top of it', () => {
  const q = quoteFill(terms(), usd(100), 100);
  assert.equal(q.premiumQuote, usd(5));
  assert.equal(q.feeQuote, usd(0.05));
  assert.equal(q.premiumToMaker, usd(4.95));
});

test('proRataCeil refuses a zero denominator rather than dividing by it', () => {
  assert.throws(() => proRataCeil(1n, 1n, 0n), /denominator/);
});

test('a slice must be takeable, and must leave something takeable', () => {
  const min = usd(10);
  assert.equal(fillRejection(terms(), usd(40), min), null);
  assert.equal(fillRejection(terms(), usd(5), min), 'below-minimum');
  assert.equal(fillRejection(terms(), usd(95), min), 'leaves-dust');
  assert.equal(fillRejection(terms(), usd(101), min), 'exceeds-open');
  assert.equal(fillRejection(terms(), 0n, min), 'empty');
});

test('clearing the whole remainder is always allowed, however small', () => {
  const t = terms({ strikeQuoteOpen: usd(0.25) });
  assert.equal(fillRejection(t, usd(0.25), usd(10)), null);
  // ...but leaving a crumb behind is not. Too-small is reported first, matching the order
  // the program checks them in, so a client shows the same reason the chain would give.
  assert.equal(fillRejection(t, usd(0.2), usd(10)), 'below-minimum');
});

test('a sweep fills a band cheapest premium first', () => {
  const cheap = terms({ premiumQuoteAmount: usd(3) });
  const dear = terms({ premiumQuoteAmount: usd(8) });
  const middling = terms({ premiumQuoteAmount: usd(5) });

  const { legs, filled, shortfall } = planSweep([dear, cheap, middling], usd(150), { minFillQuote: usd(10) });
  assert.equal(filled, usd(150));
  assert.equal(shortfall, 0n);
  assert.equal(legs.length, 2);
  assert.equal(legs[0].commitment, cheap);
  assert.equal(legs[0].quote.strikeQuote, usd(100));
  assert.equal(legs[1].commitment, middling);
  assert.equal(legs[1].quote.strikeQuote, usd(50));
});

test('a sweep reports what it could not fill rather than overshooting', () => {
  const { filled, shortfall, legs } = planSweep([terms()], usd(250), { minFillQuote: usd(10) });
  assert.equal(filled, usd(100));
  assert.equal(shortfall, usd(150));
  assert.equal(legs.length, 1);
});

test('a sweep skips a commitment it can only take illegally', () => {
  // 8 USDC left of the target, and a minimum fill of 10: slicing is not allowed, and taking
  // this one whole would overshoot, so it is left alone.
  const small = terms({ strikeQuoteOpen: usd(100) });
  const { legs, filled, shortfall } = planSweep([small], usd(8), { minFillQuote: usd(10) });
  assert.equal(legs.length, 0);
  assert.equal(filled, 0n);
  assert.equal(shortfall, usd(8));
});

test('a sweep takes a commitment whole when a slice of it would leave dust', () => {
  // The target wants 95 of this 100, which would leave 5 behind under a 10 minimum. Taking
  // all 100 is legal and does not overshoot a 120 target, so that is what it does.
  const only = terms();
  const { legs, filled } = planSweep([only], usd(120), { minFillQuote: usd(10) });
  assert.equal(legs.length, 1);
  assert.equal(legs[0].quote.strikeQuote, usd(100));
  assert.equal(filled, usd(100));
});

test('a sweep ignores commitments with nothing open', () => {
  const empty = terms({ strikeQuoteOpen: 0n });
  const { legs } = planSweep([empty, terms()], usd(50), { minFillQuote: usd(10) });
  assert.equal(legs.length, 1);
  assert.notEqual(legs[0].commitment, empty);
});
