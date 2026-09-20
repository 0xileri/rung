import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCurve, snapToBand, peakCommitted, isConcentrated,
  type OpenCommitment,
} from '../src/commitment-curve.ts';

const BANDS = [1.3e12, 1.2e12, 1.1e12, 1.0e12, 9e11, 8e11];
const NOW = 1_800_000_000;

const commit = (
  maker: string, valuation: number, usdc: number, premium = 0, days = 30,
): OpenCommitment => ({
  position: `pos-${maker}-${valuation}-${usdc}`,
  maker,
  targetValuationUsd: valuation,
  strikeQuoteEscrowed: BigInt(Math.round(usdc * 1e6)),
  premiumQuoteAmount: BigInt(Math.round(premium * 1e6)),
  expiryTs: NOW + days * 86400,
});

test('snaps an off-band valuation to the nearest band', () => {
  assert.equal(snapToBand(1.02e12, BANDS), 1.0e12);
  assert.equal(snapToBand(9.4e11, BANDS), 9e11);
  // Exactly on a band stays put.
  assert.equal(snapToBand(1.1e12, BANDS), 1.1e12);
  // No bands configured: pass through rather than inventing one.
  assert.equal(snapToBand(1.02e12, []), 1.02e12);
});

test('empty bands are kept, because an empty band is information', () => {
  const curve = buildCurve([commit('alice', 1.0e12, 100)], BANDS, NOW);
  assert.equal(curve.length, BANDS.length);
  assert.equal(curve.filter((b) => b.committed === 0n).length, BANDS.length - 1);
});

test('buckets descend by valuation', () => {
  const curve = buildCurve([], BANDS, NOW);
  const vals = curve.map((b) => b.valuationUsd);
  assert.deepEqual(vals, [...vals].sort((a, b) => b - a));
});

test('sums capital and counts wallets per band', () => {
  const curve = buildCurve(
    [
      commit('alice', 9e11, 200),
      commit('bob', 9e11, 100),
      commit('alice', 9e11, 50), // same wallet twice: two positions, one wallet
      commit('carol', 1.0e12, 75),
    ],
    BANDS,
    NOW,
  );
  const b900 = curve.find((b) => b.valuationUsd === 9e11)!;
  assert.equal(b900.committed, 350_000_000n);
  assert.equal(b900.openPositions, 3);
  assert.equal(b900.uniqueWallets, 2, 'alice counts once');

  const b1t = curve.find((b) => b.valuationUsd === 1.0e12)!;
  assert.equal(b1t.committed, 75_000_000n);
  assert.equal(b1t.uniqueWallets, 1);
});

test('concentration is measured per wallet, not per position', () => {
  // Alice splits 250 across two positions; Bob holds 250 in one. Neither dominates.
  const even = buildCurve(
    [commit('alice', 9e11, 125), commit('alice', 9e11, 125), commit('bob', 9e11, 250)],
    BANDS,
    NOW,
  ).find((b) => b.valuationUsd === 9e11)!;
  assert.ok(Math.abs(even.largestWalletShare - 0.5) < 1e-9);
  assert.equal(isConcentrated(even), false, '50% exactly is not yet flagged');

  // One whale against two minnows.
  const whale = buildCurve(
    [commit('whale', 9e11, 900), commit('a', 9e11, 50), commit('b', 9e11, 50)],
    BANDS,
    NOW,
  ).find((b) => b.valuationUsd === 9e11)!;
  assert.ok(Math.abs(whale.largestWalletShare - 0.9) < 1e-9);
  assert.equal(isConcentrated(whale), true);
  assert.ok(Math.abs(whale.topThreeShare - 1.0) < 1e-9);
});

test('a single-wallet band is fully concentrated', () => {
  const solo = buildCurve([commit('alice', 9e11, 100)], BANDS, NOW).find(
    (b) => b.valuationUsd === 9e11,
  )!;
  assert.equal(solo.largestWalletShare, 1);
  assert.equal(isConcentrated(solo), true);
});

test('an empty band reports zero concentration rather than NaN', () => {
  const empty = buildCurve([], BANDS, NOW).find((b) => b.valuationUsd === 9e11)!;
  assert.equal(empty.largestWalletShare, 0);
  assert.equal(empty.topThreeShare, 0);
  assert.equal(empty.avgPremiumPct, 0);
  assert.equal(empty.medianExpiryDays, 0);
  assert.equal(isConcentrated(empty), false);
});

test('average premium is capital-weighted across the band', () => {
  // 100 USDC at 5 premium, 900 at 45: both 5%, so the band is 5%.
  const curve = buildCurve(
    [commit('a', 9e11, 100, 5), commit('b', 9e11, 900, 45)],
    BANDS,
    NOW,
  ).find((b) => b.valuationUsd === 9e11)!;
  assert.ok(Math.abs(curve.avgPremiumPct - 0.05) < 1e-9);
});

test('median expiry, not mean, so one long-dated position cannot skew a band', () => {
  const curve = buildCurve(
    [
      commit('a', 9e11, 100, 0, 7),
      commit('b', 9e11, 100, 0, 14),
      commit('c', 9e11, 100, 0, 365),
    ],
    BANDS,
    NOW,
  ).find((b) => b.valuationUsd === 9e11)!;
  assert.equal(curve.medianExpiryDays, 14);
});

test('peak scales the bars', () => {
  const curve = buildCurve(
    [commit('a', 9e11, 365), commit('b', 1.0e12, 279)],
    BANDS,
    NOW,
  );
  assert.equal(peakCommitted(curve), 365_000_000n);
  assert.equal(peakCommitted([]), 0n);
});

test('an off-band position joins its nearest band instead of fragmenting the curve', () => {
  const curve = buildCurve([commit('a', 1.02e12, 100)], BANDS, NOW);
  assert.equal(curve.length, BANDS.length, 'no extra bucket created');
  assert.equal(curve.find((b) => b.valuationUsd === 1.0e12)!.committed, 100_000_000n);
});
