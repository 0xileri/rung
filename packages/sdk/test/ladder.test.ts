import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLadder } from '../src/ladder.ts';

const usd = (n: number) => BigInt(Math.round(n * 1e6));
const T = 1e12;
const BANDS = [1.0 * T, 1.1 * T, 1.2 * T, 1.3 * T, 1.4 * T, 1.5 * T];
const base = { bands: BANDS, minRungQuote: usd(10), maxRungQuote: usd(1000) };

test('an even ladder splits the total across every band in range, lowest first', () => {
  const r = planLadder({ ...base, lowUsd: 1.0 * T, highUsd: 1.3 * T, totalQuote: usd(400), shape: 'even' });
  assert.ok(r.ok);
  assert.deepEqual(r.rungs.map((x) => x.valuationUsd), [1.0 * T, 1.1 * T, 1.2 * T, 1.3 * T]);
  assert.deepEqual(r.rungs.map((x) => x.strikeQuote), [usd(100), usd(100), usd(100), usd(100)]);
});

test('lower-heavy puts the most capital at the lowest valuation', () => {
  const r = planLadder({ ...base, lowUsd: 1.0 * T, highUsd: 1.3 * T, totalQuote: usd(1000), shape: 'lower-heavy' });
  assert.ok(r.ok);
  // weights 4,3,2,1 over 10
  assert.deepEqual(r.rungs.map((x) => x.strikeQuote), [usd(400), usd(300), usd(200), usd(100)]);
});

test('the rungs always sum to exactly what was asked for', () => {
  for (const total of [usd(100), usd(333.33), usd(999.99), usd(100.005), usd(250.01)]) {
    for (const shape of ['even', 'lower-heavy'] as const) {
      const r = planLadder({ ...base, lowUsd: 1.0 * T, highUsd: 1.2 * T, totalQuote: total, shape });
      assert.ok(r.ok, `${total} ${shape}`);
      assert.equal(r.rungs.reduce((s, x) => s + x.strikeQuote, 0n), total, `${total} ${shape}`);
    }
  }
});

test('rounding leftovers go to the heaviest rung, in whole cents', () => {
  const r = planLadder({ ...base, lowUsd: 1.0 * T, highUsd: 1.2 * T, totalQuote: usd(100), shape: 'even' });
  assert.ok(r.ok);
  // 100 / 3 = 33.33 each, with the odd cent on the first (all equal weight, first is heaviest)
  assert.deepEqual(r.rungs.map((x) => x.strikeQuote), [usd(33.34), usd(33.33), usd(33.33)]);
});

test('a range given high-to-low is the same range', () => {
  const a = planLadder({ ...base, lowUsd: 1.3 * T, highUsd: 1.1 * T, totalQuote: usd(300), shape: 'even' });
  const b = planLadder({ ...base, lowUsd: 1.1 * T, highUsd: 1.3 * T, totalQuote: usd(300), shape: 'even' });
  assert.deepEqual(a, b);
});

test('a single band is a ladder of one', () => {
  const r = planLadder({ ...base, lowUsd: 1.2 * T, highUsd: 1.2 * T, totalQuote: usd(150), shape: 'lower-heavy' });
  assert.ok(r.ok);
  assert.deepEqual(r.rungs, [{ valuationUsd: 1.2 * T, strikeQuote: usd(150) }]);
});

test('refuses a ladder that would leave a rung below the minimum', () => {
  const r = planLadder({ ...base, lowUsd: 1.0 * T, highUsd: 1.5 * T, totalQuote: usd(30), shape: 'even' });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'below-minimum');
});

test('refuses a ladder whose heaviest rung would break the per-position cap', () => {
  const r = planLadder({ ...base, lowUsd: 1.0 * T, highUsd: 1.1 * T, totalQuote: usd(2500), shape: 'lower-heavy' });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'above-cap');
});

test('refuses an empty range, and more rungs than a wallet should be asked to sign', () => {
  const none = planLadder({ ...base, lowUsd: 2 * T, highUsd: 3 * T, totalQuote: usd(100), shape: 'even' });
  assert.equal(!none.ok && none.reason, 'no-bands');
  const many = planLadder({ ...base, lowUsd: 1.0 * T, highUsd: 1.5 * T, totalQuote: usd(600), shape: 'even', maxRungs: 4 });
  assert.equal(!many.ok && many.reason, 'too-many-rungs');
});
