import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capitalSeries, capitalAt, type CapitalCommitment, type CapitalFill } from '../src/capital.ts';

const usd = (n: number) => BigInt(Math.round(n * 1e6));

const commitment = (over: Partial<CapitalCommitment> = {}): CapitalCommitment => ({
  position: 'P1',
  strikeQuoteEscrowed: usd(100),
  createdAt: 0,
  expiryTs: 100,
  withdrawnAt: 0,
  ...over,
});

const fill = (over: Partial<CapitalFill> = {}): CapitalFill => ({
  position: 'P1',
  strikeQuoteAmount: usd(40),
  premiumPaid: usd(2),
  matchedAt: 10,
  settledAt: 0,
  status: 'Matched',
  ...over,
});

/** The series as plain dollars, for readable comparisons. */
const dollars = (series: ReturnType<typeof capitalSeries>) =>
  series.map((p) => [p.t, Number(p.offered) / 1e6, Number(p.inForce) / 1e6, Number(p.matched) / 1e6]);

test('nothing on chain is an empty series', () => {
  assert.deepEqual(capitalSeries([], [], 1000), []);
});

test('a slice moves capital from offered to in force, and a withdrawal takes the rest off', () => {
  const series = capitalSeries(
    [commitment({ withdrawnAt: 20 })],
    [fill({ status: 'Exercised', settledAt: 30 })],
    200,
  );
  assert.deepEqual(dollars(series), [
    [0, 100, 0, 0],
    [10, 60, 40, 40],
    [20, 0, 40, 40], // the maker pulled the other 60
    [30, 0, 0, 40], // exercised: protection over, matched volume stays
    [200, 0, 0, 40],
  ]);
});

test('unclaimed capital leaves the book at the deadline, not when someone tidies up', () => {
  const series = capitalSeries([commitment({ expiryTs: 50 })], [fill({ strikeQuoteAmount: usd(30) })], 100);
  const atDeadline = capitalAt(series, 50);
  assert.equal(atDeadline.offered, 0n, 'nobody can take it after the deadline');
  assert.equal(atDeadline.inForce, 0n, 'an expired claim is not protection, settled or not');
  assert.equal(capitalAt(series, 49).offered, usd(70));
  assert.equal(capitalAt(series, 49).inForce, usd(30));
});

test('a withdrawal after the deadline does not take the capital off twice', () => {
  const series = capitalSeries([commitment({ expiryTs: 50, withdrawnAt: 80 })], [], 100);
  assert.deepEqual(dollars(series), [
    [0, 100, 0, 0],
    [50, 0, 0, 0],
    [100, 0, 0, 0],
  ]);
});

test('a deadline still ahead changes nothing yet', () => {
  const series = capitalSeries([commitment({ expiryTs: 500 })], [fill()], 100);
  const last = series[series.length - 1];
  assert.equal(last.t, 100, 'the line reaches the present');
  assert.equal(last.offered, usd(60));
  assert.equal(last.inForce, usd(40));
});

test('slices taken in the same second are one step', () => {
  const series = capitalSeries(
    [commitment(), commitment({ position: 'P2', createdAt: 5 })],
    [fill(), fill({ position: 'P2', matchedAt: 10, strikeQuoteAmount: usd(25) })],
    60,
  );
  assert.equal(series.filter((p) => p.t === 10).length, 1);
  assert.equal(capitalAt(series, 10).inForce, usd(65));
  assert.equal(capitalAt(series, 10).offered, usd(135));
});

test('matched volume and premium only ever accumulate', () => {
  const series = capitalSeries(
    [commitment({ expiryTs: 50 })],
    [fill({ premiumPaid: usd(2) }), fill({ matchedAt: 20, strikeQuoteAmount: usd(10), premiumPaid: usd(0.5) })],
    100,
  );
  for (let i = 1; i < series.length; i++) {
    assert.ok(series[i].matched >= series[i - 1].matched);
    assert.ok(series[i].premium >= series[i - 1].premium);
  }
  assert.equal(series[series.length - 1].matched, usd(50));
  assert.equal(series[series.length - 1].premium, usd(2.5));
});

test('every dollar escrowed is offered, in force, or gone — never double counted', () => {
  // Three commitments with every kind of ending, checked at every step.
  const commitments = [
    commitment({ position: 'A', expiryTs: 60 }),
    commitment({ position: 'B', createdAt: 5, withdrawnAt: 25, strikeQuoteEscrowed: usd(80) }),
    commitment({ position: 'C', createdAt: 12, expiryTs: 90, strikeQuoteEscrowed: usd(50) }),
  ];
  const fills = [
    fill({ position: 'A', matchedAt: 8, strikeQuoteAmount: usd(40), status: 'Exercised', settledAt: 40 }),
    fill({ position: 'B', matchedAt: 15, strikeQuoteAmount: usd(30) }),
    fill({ position: 'C', matchedAt: 20, strikeQuoteAmount: usd(50), status: 'Expired', settledAt: 95 }),
  ];
  const series = capitalSeries(commitments, fills, 120);
  for (const p of series) {
    const created = commitments.filter((c) => c.createdAt <= p.t).reduce((s, c) => s + c.strikeQuoteEscrowed, 0n);
    assert.ok(p.offered >= 0n && p.inForce >= 0n, `no negative capital at t=${p.t}`);
    assert.ok(p.offered + p.inForce <= created, `never more on the book than was put there at t=${p.t}`);
  }
  const end = series[series.length - 1];
  assert.equal(end.offered + end.inForce, 0n, 'by t=120 everything has ended one way or another');
  assert.equal(end.matched, usd(120));
});
