import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookLine, buildBook, summarizeBook, type BookCommitment, type BookFill } from '../src/book.ts';

const usd = (n: number) => BigInt(Math.round(n * 1e6));
const DAY = 86_400;
const NOW = 1_800_000_000;

const commitment = (over: Partial<BookCommitment> = {}): BookCommitment => ({
  position: 'P1',
  stockMint: 'OPENAI',
  targetValuationUsd: 1e12,
  strikeQuoteEscrowed: usd(100),
  strikeQuoteOpen: usd(100),
  premiumQuoteAmount: usd(5),
  expiryTs: NOW + 30 * DAY,
  createdAt: NOW - DAY,
  ...over,
});

let n = 0;
const fill = (over: Partial<BookFill> = {}): BookFill => ({
  fill: `F${++n}`,
  position: 'P1',
  taker: 'alice',
  index: n,
  strikeQuoteAmount: usd(40),
  premiumPaid: usd(2),
  feePaid: usd(0.02),
  matchedAt: NOW,
  settledAt: 0,
  status: 'Matched',
  ...over,
});

test('an untouched commitment is all open', () => {
  const line = bookLine(commitment(), [], NOW);
  assert.equal(line.open, usd(100));
  assert.equal(line.taken, 0n);
  assert.equal(line.withdrawn, 0n);
  assert.equal(line.active, true);
});

test('taken, open and withdrawn account for every dollar escrowed', () => {
  // 100 escrowed: 40 taken by Alice, 25 by Bob, then the maker pulled 15, leaving 20 open.
  const c = commitment({ strikeQuoteOpen: usd(20) });
  const fills = [fill(), fill({ taker: 'bob', strikeQuoteAmount: usd(25), premiumPaid: usd(1.25), feePaid: usd(0.0125) })];
  const line = bookLine(c, fills, NOW);
  assert.equal(line.taken, usd(65));
  assert.equal(line.open, usd(20));
  assert.equal(line.withdrawn, usd(15));
  assert.equal(line.taken + line.open + line.withdrawn, c.strikeQuoteEscrowed);
});

test('premium counts what reached the maker, after the protocol cut', () => {
  const line = bookLine(commitment({ strikeQuoteOpen: usd(60) }), [fill()], NOW);
  assert.equal(line.premiumNet, usd(1.98));
  assert.equal(line.feePaid, usd(0.02));
});

test('only unsettled claims count as live, and only exercises as paid out', () => {
  const fills = [
    fill({ status: 'Exercised', settledAt: NOW }),
    fill({ status: 'Expired', settledAt: NOW }),
    fill({ status: 'Matched', strikeQuoteAmount: usd(20) }),
  ];
  const line = bookLine(commitment({ strikeQuoteOpen: 0n }), fills, NOW);
  assert.equal(line.live, usd(20));
  assert.equal(line.exercisedQuote, usd(40));
  assert.equal(line.active, true, 'a running claim keeps the line active');
});

test('a line with nothing open and nothing running is finished', () => {
  const line = bookLine(commitment({ strikeQuoteOpen: 0n }), [fill({ status: 'Expired', strikeQuoteAmount: usd(100) })], NOW);
  assert.equal(line.active, false);
});

test('expired claims nobody has settled are listed for settling', () => {
  const late = NOW + 31 * DAY;
  const fills = [fill(), fill({ status: 'Exercised' })];
  const line = bookLine(commitment({ strikeQuoteOpen: usd(20) }), fills, late);
  assert.equal(line.expired, true);
  assert.equal(line.settleable.length, 1, 'only the one still Matched');
  assert.equal(bookLine(commitment(), fills, NOW).settleable.length, 0, 'nothing is settleable before the deadline');
});

test('a book lists active lines first, soonest deadline first', () => {
  const soon = commitment({ position: 'SOON', expiryTs: NOW + 3 * DAY });
  const later = commitment({ position: 'LATER', expiryTs: NOW + 20 * DAY });
  const done = commitment({ position: 'DONE', strikeQuoteOpen: 0n, createdAt: NOW });
  const book = buildBook([done, later, soon], [], NOW);
  assert.deepEqual(book.map((l) => l.commitment.position), ['SOON', 'LATER', 'DONE']);
});

test('the summary adds up, and yield is premium over capital matched', () => {
  const a = commitment({ position: 'A', strikeQuoteOpen: usd(60) });
  const b = commitment({ position: 'B', strikeQuoteOpen: usd(100), expiryTs: NOW + 10 * DAY });
  const fills = [
    fill({ position: 'A', taker: 'alice' }),
    fill({ position: 'A', taker: 'bob', status: 'Exercised' }),
  ];
  // A: 100 escrowed, 80 taken, 60 open would over-count, so give it a realistic 20 open.
  const book = buildBook([{ ...a, strikeQuoteOpen: usd(20) }, b], fills, NOW);
  const s = summarizeBook(book);
  assert.equal(s.commitments, 2);
  assert.equal(s.taken, usd(80));
  assert.equal(s.live, usd(40), 'the exercised claim is no longer at risk');
  assert.equal(s.open, usd(120));
  assert.equal(s.onBook, usd(160));
  assert.equal(s.premiumNet, usd(3.96));
  assert.equal(s.takers, 2);
  assert.ok(Math.abs((s.premiumYield ?? 0) - 3.96 / 80) < 1e-12);
  assert.equal(s.nextExpiry, NOW + 10 * DAY);
});

test('the average term is weighted by capital, from each match to its deadline', () => {
  const c = commitment({ strikeQuoteOpen: 0n, expiryTs: NOW + 30 * DAY });
  const fills = [
    fill({ strikeQuoteAmount: usd(90), matchedAt: NOW }), // 30 days
    fill({ strikeQuoteAmount: usd(10), matchedAt: NOW + 20 * DAY }), // 10 days
  ];
  const s = summarizeBook(buildBook([c], fills, NOW));
  assert.ok(Math.abs((s.avgTermDays ?? 0) - 28) < 1e-9, 'a small late fill barely moves it');
});

test('before any match there is no yield and no term to report', () => {
  const s = summarizeBook(buildBook([commitment()], [], NOW));
  assert.equal(s.premiumYield, null);
  assert.equal(s.avgTermDays, null);
});

test('a deadline already passed is not the next one', () => {
  const past = commitment({ position: 'PAST', expiryTs: NOW - DAY });
  const future = commitment({ position: 'FUTURE', expiryTs: NOW + 5 * DAY });
  const s = summarizeBook(buildBook([past, future], [], NOW));
  assert.equal(s.nextExpiry, NOW + 5 * DAY);
});
