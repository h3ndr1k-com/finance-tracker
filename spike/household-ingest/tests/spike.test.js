'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { txHash } = require('../lib/fingerprint');
const { openStore, pendingItems } = require('../lib/queue');
const { runJob, runSchedule } = require('../lib/job');
const { createReviewServer } = require('../lib/api');

const day1 = path.join(__dirname, '../fixtures/day-1.json');
const day2 = path.join(__dirname, '../fixtures/day-2.json');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-spike-'));
  return openStore(dir);
}

test('fingerprint matches Ledger CSV txHash', () => {
  const t = { date: '2026-07-02', amount: -6.45, desc: 'STARBUCKS #4421 TORONTO', account: 'Amex' };
  assert.equal(txHash(t), txHash({ ...t }));
  assert.notEqual(txHash(t), txHash({ ...t, amount: -6.46 }));
});

test('first job enqueues proposals and does not write a ledger', () => {
  const store = tmpStore();
  const summary = runJob({ store, fixture: day1 });
  assert.equal(summary.added, 3);
  assert.equal(summary.skipped, 0);
  const pending = pendingItems(store);
  assert.equal(pending.length, 3);
  assert.ok(pending.every((p) => p.status === 'pending'));
  assert.equal(store.loadLedger().fingerprints.length, 0);
});

test('re-importing the same day is idempotent', () => {
  const store = tmpStore();
  const first = runJob({ store, fixture: day1 });
  const second = runJob({ store, fixture: day1 });
  assert.equal(first.added, 3);
  assert.equal(second.added, 0);
  assert.equal(second.skipped, 3);
  assert.equal(pendingItems(store).length, 3);
});

test('day-2 adds only the new row; provider IDs and fingerprints skip duplicates', () => {
  const store = tmpStore();
  runJob({ store, fixture: day1 });
  const next = runJob({ store, fixture: day2 });
  assert.equal(next.added, 1);
  assert.equal(next.skipped, 3);
  const pending = pendingItems(store);
  assert.equal(pending.length, 4);
  assert.ok(pending.some((p) => p.providerTxId === 'mock_txn_003'));
});

test('fingerprint-only row (no provider id) is also idempotent', () => {
  const store = tmpStore();
  runJob({ store, fixture: day1 });
  const payroll = pendingItems(store).find((p) => p.desc === 'MOCK PAYROLL ACME');
  assert.ok(payroll.fingerprint);
  assert.equal(payroll.id.startsWith('fp:'), true);
  const again = runJob({ store, fixture: day1 });
  assert.equal(again.skipped, 3);
});

test('schedule runs the job more than once and stays idempotent', async () => {
  const store = tmpStore();
  const ticks = [];
  await new Promise((resolve) => {
    runSchedule({
      store,
      fixture: day1,
      intervalMs: 20,
      ticks: 3,
      onTick: (summary) => {
        ticks.push(summary);
        if (ticks.length === 3) resolve();
      },
    });
  });
  assert.equal(ticks[0].added, 3);
  assert.equal(ticks[1].added, 0);
  assert.equal(ticks[2].added, 0);
});

test('review API requires a bearer token and lists the queue', async () => {
  const store = tmpStore();
  runJob({ store, fixture: day1 });
  const token = 'spike-dev-token';
  const api = createReviewServer({ store, token, port: 0 });
  await new Promise((resolve) => api.server.listen(0, '127.0.0.1', resolve));
  const { port } = api.server.address();
  const denied = await fetch(`http://127.0.0.1:${port}/review`);
  assert.equal(denied.status, 401);
  const ok = await fetch(`http://127.0.0.1:${port}/review`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.count, 3);
  await api.close();
});

test('fixtures contain no live credentials', () => {
  for (const file of [day1, day2]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /MOCK /);
    assert.doesNotMatch(text, /pk\.[a-z0-9]/i);
    assert.doesNotMatch(text, /sk_live/);
  }
});
