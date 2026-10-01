'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeQueueItem } = require('../bridge/client');

test('bridge client converts a queued Telegram item into Ledger transaction shape', () => {
  assert.deepEqual(normalizeQueueItem({
    id: 'e0df1395-dbe4-4bf3-a4b6-08d3f801df80', date: '2026-10-01', desc: 'Maxi groceries', amount: -82.45,
    currency: 'cad', account: 'Amex', category: 'Groceries', business: '', transfer: false,
  }, 'CAD'), {
    id: 'bridge:e0df1395-dbe4-4bf3-a4b6-08d3f801df80', date: '2026-10-01', desc: 'Maxi groceries', amount: -82.45,
    currency: 'CAD', account: 'Amex', category: 'Groceries', business: '', transfer: false, source: 'telegram',
  });
});

test('bridge client rejects malformed queue items before they reach the Ledger', () => {
  assert.throws(() => normalizeQueueItem({ id: 'x', date: 'nope', desc: '', amount: 0 }, 'CAD'), /invalid/i);
});
