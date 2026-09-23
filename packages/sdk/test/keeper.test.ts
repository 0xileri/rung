import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueForSettlement, type KeeperCommitment, type KeeperFill } from '../src/keeper.ts';

const fill = (over: Partial<KeeperFill> = {}): KeeperFill => ({
  fill: 'F1',
  position: 'P1',
  status: 'Matched',
  strikeQuoteAmount: 100_000_000n,
  ...over,
});
const commitment = (over: Partial<KeeperCommitment> = {}): KeeperCommitment => ({
  position: 'P1',
  expiryTs: 1000,
  ...over,
});

test('a running claim past its deadline is due', () => {
  const due = dueForSettlement([fill()], [commitment()], 1060);
  assert.equal(due.length, 1);
  assert.equal(due[0].overdue, 60);
});

test('exactly at the deadline is not due, matching the program', () => {
  // The program's is_expired is `now > expiry_ts`; settling at equality would be refused
  // and the keeper would have paid a fee for nothing.
  assert.equal(dueForSettlement([fill()], [commitment()], 1000).length, 0);
  assert.equal(dueForSettlement([fill()], [commitment()], 1001).length, 1);
});

test('claims already exercised or expired are left alone', () => {
  const fills = [fill({ fill: 'A', status: 'Exercised' }), fill({ fill: 'B', status: 'Expired' })];
  assert.equal(dueForSettlement(fills, [commitment()], 5000).length, 0);
});

test('a claim whose commitment could not be read waits for the next cycle', () => {
  assert.equal(dueForSettlement([fill({ position: 'UNKNOWN' })], [commitment()], 5000).length, 0);
});

test('the longest-waiting collateral goes first, and a limit never starves it', () => {
  const commitments = [
    commitment({ position: 'OLD', expiryTs: 100 }),
    commitment({ position: 'MID', expiryTs: 500 }),
    commitment({ position: 'NEW', expiryTs: 900 }),
  ];
  const fills = [
    fill({ fill: 'n', position: 'NEW' }),
    fill({ fill: 'o', position: 'OLD' }),
    fill({ fill: 'm', position: 'MID' }),
  ];
  assert.deepEqual(
    dueForSettlement(fills, commitments, 1000).map((d) => d.fill),
    ['o', 'm', 'n'],
  );
  assert.deepEqual(
    dueForSettlement(fills, commitments, 1000, 2).map((d) => d.fill),
    ['o', 'm'],
  );
});

test('several claims on one commitment are all due together', () => {
  const fills = [fill({ fill: 'a' }), fill({ fill: 'b' }), fill({ fill: 'c', status: 'Exercised' })];
  assert.deepEqual(dueForSettlement(fills, [commitment()], 2000).map((d) => d.fill).sort(), ['a', 'b']);
});
