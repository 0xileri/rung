import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionPnl, type PnlStatus, type PositionPnlInput } from '../src/pnl.ts';

/** $100 strike, $4.60 premium, 0.1239 OPENAI leaving the vault. */
const base: Omit<PositionPnlInput, 'side' | 'status'> = {
  strikeUsd: 100,
  premiumUsd: 4.6,
  stockOutUi: 0.1239,
  tokenPrice: 1000, // tokens worth $123.90: well above the strike, so no one exercises
};
const close = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('nothing exchanged means no P&L on either side', () => {
  for (const status of ['Open', 'Cancelled'] as const) {
    for (const side of ['maker', 'holder'] as const) {
      const r = positionPnl({ ...base, side, status });
      assert.equal(r.usd, 0);
      assert.equal(r.basis, 'none');
    }
  }
});

test('a live floor out of the money is worth only its premium', () => {
  close(positionPnl({ ...base, side: 'maker', status: 'Matched' }).usd, 4.6);
  close(positionPnl({ ...base, side: 'holder', status: 'Matched' }).usd, -4.6);
});

test('a live floor in the money transfers its exercise value', () => {
  // Tokens now worth $61.95 against a $100 strike: exercising pays the holder $38.05.
  const inTheMoney = { ...base, tokenPrice: 500 };
  close(positionPnl({ ...inTheMoney, side: 'holder', status: 'Matched' }).usd, 38.05 - 4.6);
  close(positionPnl({ ...inTheMoney, side: 'maker', status: 'Matched' }).usd, 4.6 - 38.05);
});

test('an exercised position counts the swap even when it went against the holder', () => {
  // Exercised with tokens worth $123.90: the holder swapped them for $100.
  close(positionPnl({ ...base, side: 'holder', status: 'Exercised' }).usd, -23.9 - 4.6);
  close(positionPnl({ ...base, side: 'maker', status: 'Exercised' }).usd, 4.6 + 23.9);
  assert.equal(positionPnl({ ...base, side: 'maker', status: 'Exercised' }).basis, 'marked');
});

test('an expired position is final: only the premium moved', () => {
  const r = positionPnl({ ...base, side: 'maker', status: 'Expired', tokenPrice: null });
  close(r.usd, 4.6);
  assert.equal(r.basis, 'realized');
});

test('the two sides are always exact opposites', () => {
  const statuses: PnlStatus[] = ['Open', 'Matched', 'Exercised', 'Expired', 'Cancelled'];
  for (const status of statuses) {
    for (const tokenPrice of [100, 500, 807.15, 1000, 5000]) {
      const maker = positionPnl({ ...base, tokenPrice, side: 'maker', status }).usd!;
      const holder = positionPnl({ ...base, tokenPrice, side: 'holder', status }).usd!;
      close(maker + holder, 0);
    }
  }
});

test('without a price, positions that need one report no figure rather than a guess', () => {
  for (const status of ['Matched', 'Exercised'] as const) {
    assert.equal(positionPnl({ ...base, side: 'maker', status, tokenPrice: null }).usd, null);
    assert.equal(positionPnl({ ...base, side: 'maker', status, tokenPrice: 0 }).usd, null);
  }
});
