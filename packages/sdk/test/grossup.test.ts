import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  grossUpForRequired, worstCaseTransferFee, amountReceived, calculateFee,
  type TransferFee,
} from '../src/token2022.ts';

const UNCAPPED = 2n ** 64n - 1n;
const fee = (bps: number, maximumFee = UNCAPPED): TransferFee => ({
  epoch: 0n,
  transferFeeBasisPoints: bps,
  maximumFee,
});

/** The OpenAI mint's real two-slot schedule. */
const OPENAI_CONFIG = {
  olderTransferFee: fee(50),
  newerTransferFee: { ...fee(100), epoch: 1039n },
};

test('worst case picks the higher-bps slot regardless of which is newer', () => {
  assert.equal(worstCaseTransferFee(OPENAI_CONFIG).transferFeeBasisPoints, 100);
  // A schedule that steps DOWN must still return the higher one.
  assert.equal(
    worstCaseTransferFee({ olderTransferFee: fee(100), newerTransferFee: fee(25) })
      .transferFeeBasisPoints,
    100,
  );
});

test('the grossed-up amount always clears the requirement', () => {
  // The property that matters: whatever we send, at least `required` must arrive.
  for (const bps of [1, 25, 50, 100, 300, 1000, 9999]) {
    const f = fee(bps);
    for (const required of [1n, 2n, 99n, 100n, 101n, 83_365_949n, 1_000_000_000n, 10n ** 15n]) {
      const sent = grossUpForRequired(required, f);
      const got = amountReceived(sent, f);
      assert.ok(got >= required, `bps=${bps} required=${required} sent=${sent} got=${got}`);
    }
  }
});

test('it does not overshoot wastefully', () => {
  // Sending one unit less must fail, which proves the answer is minimal or near-minimal.
  for (const bps of [50, 100, 300]) {
    const f = fee(bps);
    for (const required of [100n, 83_365_949n, 1_000_000_000n]) {
      const sent = grossUpForRequired(required, f);
      assert.ok(
        amountReceived(sent - 1n, f) < required,
        `bps=${bps} required=${required}: sent=${sent} is more than needed`,
      );
    }
  }
});

test('a quote sized for the worse slot clears under BOTH of the mint schedule slots', () => {
  // The whole point: an epoch rollover between quoting and signing must not break it.
  const required = 83_365_949n;
  const sent = grossUpForRequired(required, worstCaseTransferFee(OPENAI_CONFIG));
  assert.ok(amountReceived(sent, OPENAI_CONFIG.olderTransferFee) >= required, 'fails at 50bps');
  assert.ok(amountReceived(sent, OPENAI_CONFIG.newerTransferFee) >= required, 'fails at 100bps');
});

test('sizing for the ACTIVE slot is what breaks across a rollover', () => {
  // Demonstrates why worstCaseTransferFee exists rather than using the live fee.
  const required = 83_365_949n;
  const naive = grossUpForRequired(required, OPENAI_CONFIG.olderTransferFee);
  assert.ok(amountReceived(naive, OPENAI_CONFIG.olderTransferFee) >= required, 'ok at 50bps');
  assert.ok(
    amountReceived(naive, OPENAI_CONFIG.newerTransferFee) < required,
    'sizing for the active slot must fail once the fee steps up',
  );
});

test('a zero-fee mint needs no gross-up', () => {
  assert.equal(grossUpForRequired(1000n, fee(0)), 1000n);
  assert.equal(grossUpForRequired(0n, fee(100)), 0n);
});

test('a capped fee is handled without overshooting', () => {
  // maximumFee caps the fee, so beyond the cap the gross-up is just required + cap.
  const capped = fee(100, 5n);
  const sent = grossUpForRequired(1_000_000n, capped);
  assert.ok(amountReceived(sent, capped) >= 1_000_000n);
  assert.equal(calculateFee(sent, capped), 5n, 'fee should be capped');
});

test('a 100% fee is rejected rather than looping forever', () => {
  assert.throws(() => grossUpForRequired(100n, fee(10_000)), RangeError);
});
