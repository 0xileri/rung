import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROUP_WINDOW_SECONDS, recentActivity, type ActivityFill, type ActivityPosition } from '../src/activity.ts';

const usd = (n: number) => BigInt(Math.round(n * 1e6));
const T = 1_800_000_000;
const MINT = 'OPENAI';

let n = 0;
const position = (over: Partial<ActivityPosition> = {}): ActivityPosition => ({
  pubkey: `P${++n}`,
  maker: 'maker-a',
  stockMint: MINT,
  strikeQuoteEscrowed: usd(100),
  strikeQuoteOpen: usd(100),
  targetValuationUsd: 1e12,
  createdAt: T,
  withdrawnAt: 0,
  ...over,
});
const fill = (p: ActivityPosition, over: Partial<ActivityFill> = {}): ActivityFill => ({
  position: p.pubkey,
  taker: 'holder-a',
  strikeQuoteAmount: usd(40),
  matchedAt: T + 100,
  settledAt: 0,
  status: 'Matched',
  ...over,
});

test('a single commitment is one event', () => {
  const p = position();
  const [e] = recentActivity([p], []);
  assert.equal(e.kind, 'commit');
  assert.equal(e.actor, 'maker-a');
  assert.deepEqual(e.positions, [p.pubkey]);
  assert.equal(e.quote, usd(100));
});

test("a ladder's rungs are told as one commitment, valuations lowest first", () => {
  const rungs = [1.1e12, 1.0e12, 0.9e12, 0.8e12].map((v, i) => position({ targetValuationUsd: v, strikeQuoteEscrowed: usd(75), createdAt: T + i * 2 }));
  const events = recentActivity(rungs, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].positions.length, 4);
  assert.equal(events[0].quote, usd(300));
  assert.deepEqual(events[0].valuations, [0.8e12, 0.9e12, 1.0e12, 1.1e12]);
  assert.equal(events[0].at, T + 6, 'dated by its most recent rung');
});

test('a sweep across makers is one take, even though each floor belongs to someone else', () => {
  const a = position({ maker: 'maker-a', createdAt: T - 1000 });
  const b = position({ maker: 'maker-b', createdAt: T - 900 });
  const events = recentActivity([a, b], [fill(a, { strikeQuoteAmount: usd(120), matchedAt: T }), fill(b, { strikeQuoteAmount: usd(180), matchedAt: T + 1 })]);
  assert.equal(events[0].kind, 'take');
  assert.equal(events[0].quote, usd(300));
  assert.deepEqual(new Set(events[0].positions), new Set([a.pubkey, b.pubkey]));
});

test('different makers, different assets or a gap longer than the window stay separate', () => {
  const events = recentActivity(
    [
      position({ maker: 'maker-a', createdAt: T }),
      position({ maker: 'maker-b', createdAt: T + 1 }),
      position({ maker: 'maker-a', stockMint: 'SPACEX', createdAt: T + 2 }),
      position({ maker: 'maker-a', createdAt: T + 3 + GROUP_WINDOW_SECONDS + 5 }),
    ],
    [],
  );
  assert.equal(events.length, 4);
});

test('a group is a span of time, not a chain: rungs spread past the window split', () => {
  const rungs = [0, 60, 120, 180].map((dt) => position({ createdAt: T + dt }));
  const events = recentActivity(rungs, []);
  assert.ok(events.length >= 2, 'four rungs across three minutes are not one action');
  for (const e of events) assert.ok(e.positions.length <= 2);
});

test('a keeper pass settling several claims reads as one settlement, with no actor', () => {
  const ps = [position({ createdAt: T - 5000 }), position({ createdAt: T - 4000 }), position({ createdAt: T - 3000 })];
  const fs = ps.map((p, i) => fill(p, { matchedAt: T - 2000 + i, status: 'Expired', settledAt: T + i }));
  const [e] = recentActivity(ps, fs);
  assert.equal(e.kind, 'settle');
  assert.equal(e.actor, '');
  assert.equal(e.positions.length, 3);
});

test('exercises are never grouped: each is its own decision', () => {
  const ps = [position({ createdAt: T - 5000 }), position({ createdAt: T - 4000 })];
  const fs = ps.map((p, i) => fill(p, { matchedAt: T - 2000, status: 'Exercised', settledAt: T + i }));
  const exercises = recentActivity(ps, fs).filter((e) => e.kind === 'exercise');
  assert.equal(exercises.length, 2);
});

test('a withdrawal is what was escrowed, less what holders took, less what is still offered', () => {
  const p = position({ strikeQuoteEscrowed: usd(100), strikeQuoteOpen: 0n, withdrawnAt: T + 500 });
  const [e] = recentActivity([p], [fill(p, { strikeQuoteAmount: usd(40) })]);
  assert.equal(e.kind, 'withdraw');
  assert.equal(e.quote, usd(60));
});

test('newest first, and no more than the limit', () => {
  const ps = Array.from({ length: 12 }, (_, i) => position({ maker: `maker-${i}`, createdAt: T + i * 1000 }));
  const events = recentActivity(ps, [], 5);
  assert.equal(events.length, 5);
  for (let i = 1; i < events.length; i++) assert.ok(events[i - 1].at >= events[i].at);
  assert.equal(events[0].actor, 'maker-11');
});
