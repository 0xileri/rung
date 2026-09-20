import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeTransferFee, calculateFee, amountReceived,
  activeMultiplier, rawToUi, uiToRaw,
} from '../src/token2022.ts';

/**
 * Fixtures captured from the live OpenAI PreStock mint
 * (PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF) on 2026-09-20. These pin the two
 * extension behaviours that are easy to read backwards.
 */
const OPENAI_FEE_CONFIG = {
  olderTransferFee: { epoch: 1032n, transferFeeBasisPoints: 50, maximumFee: 18446744073709551615n },
  newerTransferFee: { epoch: 1039n, transferFeeBasisPoints: 100, maximumFee: 18446744073709551615n },
};
const OPENAI_SCALE_CONFIG = {
  multiplier: 1,
  newMultiplier: 1.4861347,
  newMultiplierEffectiveTimestamp: 1784305800, // 2026-07-17T16:30:00Z
};
const OPENAI_DECIMALS = 9;

test('transfer fee schedule flips at the newer epoch, not before', () => {
  // Epoch 1038 was live on 2026-09-20; the step to 100bps lands at 1039.
  assert.equal(activeTransferFee(OPENAI_FEE_CONFIG, 1038n).transferFeeBasisPoints, 50);
  assert.equal(activeTransferFee(OPENAI_FEE_CONFIG, 1039n).transferFeeBasisPoints, 100);
  assert.equal(activeTransferFee(OPENAI_FEE_CONFIG, 1040n).transferFeeBasisPoints, 100);
  // Before the older fee's own epoch the older slot still applies — there is no third state.
  assert.equal(activeTransferFee(OPENAI_FEE_CONFIG, 1000n).transferFeeBasisPoints, 50);
});

test('fee rounds up, never down', () => {
  const fee = { epoch: 0n, transferFeeBasisPoints: 100, maximumFee: 2n ** 64n - 1n };
  // 1 * 100 / 10000 = 0.01 -> must round to 1, or dust transfers pay nothing.
  assert.equal(calculateFee(1n, fee), 1n);
  assert.equal(calculateFee(100n, fee), 1n);
  assert.equal(calculateFee(101n, fee), 2n);
  assert.equal(calculateFee(0n, fee), 0n);
});

test('fee is capped at maximumFee', () => {
  const capped = { epoch: 0n, transferFeeBasisPoints: 100, maximumFee: 5n };
  assert.equal(calculateFee(1_000_000n, capped), 5n);
});

test('zero-bps fee is a no-op', () => {
  const free = { epoch: 0n, transferFeeBasisPoints: 0, maximumFee: 0n };
  assert.equal(calculateFee(1_000_000n, free), 0n);
  assert.equal(amountReceived(1_000_000n, free), 1_000_000n);
});

test('active multiplier is newMultiplier once its timestamp has passed', () => {
  const before = OPENAI_SCALE_CONFIG.newMultiplierEffectiveTimestamp - 1;
  const after = OPENAI_SCALE_CONFIG.newMultiplierEffectiveTimestamp;
  assert.equal(activeMultiplier(OPENAI_SCALE_CONFIG, before), 1);
  assert.equal(activeMultiplier(OPENAI_SCALE_CONFIG, after), 1.4861347);
  // The date is already in the past, so "now" must resolve to the new multiplier.
  assert.equal(activeMultiplier(OPENAI_SCALE_CONFIG, Math.floor(Date.now() / 1000)), 1.4861347);
});

test('scaled supply reconciles with the PreStocks API', () => {
  // Ground truth: raw supply on-chain, and the `supply` field the API reports.
  const rawSupply = 1901887456483n;
  const apiSupply = 2826.460944574126;
  const mult = activeMultiplier(OPENAI_SCALE_CONFIG, Math.floor(Date.now() / 1000));
  const computed = rawToUi(rawSupply, OPENAI_DECIMALS, mult);
  // Agreement here proves the API quotes scaled UI units AND that we picked the right multiplier.
  assert.ok(Math.abs(computed - apiSupply) < 1e-6, `${computed} != ${apiSupply}`);
  // Reading the stale `multiplier` field instead would be off by ~48.6%.
  const wrong = rawToUi(rawSupply, OPENAI_DECIMALS, OPENAI_SCALE_CONFIG.multiplier);
  assert.ok(Math.abs(wrong - apiSupply) / apiSupply > 0.3);
});

test('uiToRaw and rawToUi round-trip', () => {
  const mult = 1.4861347;
  for (const ui of [0.123893, 1, 1000.5, 0.000001]) {
    const raw = uiToRaw(ui, OPENAI_DECIMALS, mult);
    assert.ok(Math.abs(rawToUi(raw, OPENAI_DECIMALS, mult) - ui) < 1e-9);
  }
});
