import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  targetTokenPrice, impliedShareCount, isFeedConsistent,
  quoteStrike, relativeTo, valuationBands, type PreStockAsset,
} from '../src/valuation.ts';

/** Live PreStocks figures for OPENAI, captured 2026-09-20. */
const OPENAI: PreStockAsset = {
  symbol: 'OPENAI',
  name: 'OpenAI PreStocks',
  contract_address: 'PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF',
  tokenPrice: 1150.1437151905366,
  impliedValuation: 1424947895628,
  markPrice: 993.0016147123137,
  markValuation: 1230259786278,
  supply: 2826.460944574126,
};
const MULT = 1.4861347;
const DECIMALS = 9;
const FEE_50 = { epoch: 1032n, transferFeeBasisPoints: 50, maximumFee: 2n ** 64n - 1n };
const FEE_100 = { epoch: 1039n, transferFeeBasisPoints: 100, maximumFee: 2n ** 64n - 1n };

test('mark and implied agree on one share count', () => {
  const a = impliedShareCount(OPENAI.impliedValuation, OPENAI.tokenPrice);
  const b = impliedShareCount(OPENAI.markValuation, OPENAI.markPrice);
  assert.ok(Math.abs(a - b) / b < 0.001, `${a} vs ${b}`);
  assert.ok(isFeedConsistent(OPENAI));
});

test('an inconsistent feed is rejected', () => {
  assert.equal(isFeedConsistent({ ...OPENAI, markPrice: OPENAI.markPrice * 2 }), false);
});

test('target valuation maps proportionally to token price', () => {
  // Halve the company, halve the token.
  const half = targetTokenPrice(OPENAI.markPrice, OPENAI.markValuation, OPENAI.markValuation / 2);
  assert.ok(Math.abs(half - OPENAI.markPrice / 2) < 1e-9);
  // Targeting the mark itself returns the mark price unchanged.
  const same = targetTokenPrice(OPENAI.markPrice, OPENAI.markValuation, OPENAI.markValuation);
  assert.ok(Math.abs(same - OPENAI.markPrice) < 1e-9);
});

test('non-positive inputs are rejected rather than producing a nonsense strike', () => {
  assert.throws(() => targetTokenPrice(0, 1e12, 1e12), RangeError);
  assert.throws(() => targetTokenPrice(100, 0, 1e12), RangeError);
  assert.throws(() => targetTokenPrice(100, 1e12, 0), RangeError);
});

test('the spec §12 example resolves to the multiplier-correct raw quantity', () => {
  const q = quoteStrike({
    asset: OPENAI, targetValuation: 1.0e12, strikeUsd: 100,
    decimals: DECIMALS, multiplier: MULT, transferFee: FEE_50,
  });
  assert.ok(Math.abs(q.targetTokenPrice - 807.1479) < 0.001);
  assert.ok(Math.abs(q.uiQuantity - 0.12389303) < 1e-7);
  // The settlement quantity. Naive `ui * 10^9` would give 123893030 — 48.6% too much.
  assert.equal(q.rawQuantity, 83365949n);
  assert.notEqual(q.rawQuantity, 123893030n);
  assert.equal(q.strikeQuoteAmount, 100_000_000n);
  // $1.00T against a $1.2303T mark and a $1.4249T market.
  assert.ok(Math.abs(q.discountToMark - -0.18716) < 0.0001);
  assert.ok(Math.abs(q.discountToMarket - -0.29822) < 0.0001);
});

test('round-trip fee drag tracks the epoch schedule', () => {
  const base = {
    asset: OPENAI, targetValuation: 1.0e12, strikeUsd: 100,
    decimals: DECIMALS, multiplier: MULT,
  };
  const at50 = quoteStrike({ ...base, transferFee: FEE_50 });
  const at100 = quoteStrike({ ...base, transferFee: FEE_100 });
  assert.ok(Math.abs(at50.roundTripFeeFraction - 0.01) < 0.0005);
  assert.ok(Math.abs(at100.roundTripFeeFraction - 0.0199) < 0.0005);
  // The vault never holds what was sent — this is why the program records the delta.
  assert.ok(at50.rawReceivedByVault < at50.rawQuantity);
  assert.equal(at50.rawQuantity - at50.entryFee, at50.rawReceivedByVault);
});

test('a strike too small to represent on-chain is rejected', () => {
  assert.throws(() => quoteStrike({
    asset: OPENAI, targetValuation: 1.0e12, strikeUsd: 1e-12,
    decimals: DECIMALS, multiplier: MULT, transferFee: FEE_50,
  }), RangeError);
});

test('relativeTo reports signed distance', () => {
  assert.ok(Math.abs(relativeTo(90, 100) - -0.1) < 1e-12);
  assert.ok(Math.abs(relativeTo(110, 100) - 0.1) < 1e-12);
});

test('valuation bands are round numbers descending from the mark', () => {
  const bands = valuationBands(OPENAI.markValuation);
  assert.ok(bands.length > 0);
  assert.ok(bands.every((b, i) => i === 0 || b < bands[i - 1]), 'must descend');
  assert.ok(bands.every((b) => b > 0));
});
