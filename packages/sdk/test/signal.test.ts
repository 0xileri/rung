import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curveSignal, type OpenCommitment } from '../src/commitment-curve.ts';

const usd = (n: number) => BigInt(Math.round(n * 1e6));
const NOW = 1_800_000_000;
let n = 0;
const c = (valuationT: number, amount: number, over: Partial<OpenCommitment> = {}): OpenCommitment => ({
  position: `P${++n}`,
  maker: `maker-${n}`,
  targetValuationUsd: valuationT * 1e12,
  strikeQuoteEscrowed: usd(amount),
  premiumQuoteAmount: usd(amount * 0.03),
  expiryTs: NOW + 30 * 86_400,
  ...over,
});

test('the median floor is weighted by capital, not by count', () => {
  // Three small commitments high up, one large one lower down: the large one carries the median.
  const s = curveSignal([c(1.2, 50), c(1.1, 50), c(1.0, 50), c(0.9, 500)], NOW);
  assert.equal(s.medianFloorUsd, 0.9e12);
  assert.equal(s.committed, usd(650));
});

test('with equal capital the median floor is the middle valuation', () => {
  assert.equal(curveSignal([c(1.2, 100), c(1.0, 100), c(0.8, 100)], NOW).medianFloorUsd, 1.0e12);
});

test('capital past its deadline is no longer demand', () => {
  const s = curveSignal([c(1.2, 100), c(0.5, 1000, { expiryTs: NOW - 1 })], NOW);
  assert.equal(s.medianFloorUsd, 1.2e12);
  assert.equal(s.commitments, 1);
  assert.equal(s.lowestFloorUsd, 1.2e12);
});

test('wallets are counted once however many commitments they hold', () => {
  const s = curveSignal([c(1.0, 100, { maker: 'a' }), c(0.9, 100, { maker: 'a' }), c(0.8, 100, { maker: 'b' })], NOW);
  assert.equal(s.wallets, 2);
  assert.equal(s.highestFloorUsd, 1.0e12);
  assert.equal(s.lowestFloorUsd, 0.8e12);
});

test('nothing committed means no signal rather than a zero', () => {
  const s = curveSignal([], NOW);
  assert.equal(s.medianFloorUsd, null);
  assert.equal(s.committed, 0n);
});
