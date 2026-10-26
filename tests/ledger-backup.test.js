'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { validateLedgerBackup } = require('../lib/ledger-backup');

test('backup validation rejects a transaction without an id before any replace', () => {
  assert.throws(() => validateLedgerBackup({
    transactions: [{ id: 'ok', date: '2026-10-01', amount: -1 }, { date: '2026-10-02', amount: -2 }],
  }), /missing an id/);
  assert.throws(() => validateLedgerBackup({ transactions: [{ id: 'a' }, { id: 'a' }] }), /duplicate/i);
  assert.throws(() => validateLedgerBackup({ transactions: [], jars: {} }), /jars must be an array/);
  assert.deepEqual(validateLedgerBackup({ transactions: [{ id: 'ok' }] }).transactions[0].id, 'ok');
});

test('import validates before replace, and wipe does not publish deletion tombstones', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const importStart = source.indexOf('async function importJsonBackup');
  const importEnd = source.indexOf('/* ---------- boot ----------');
  const body = source.slice(importStart, importEnd);
  assert.match(body, /validateLedgerBackup\(payload\)/);
  assert.match(body, /replaceImported\(/);
  assert.doesNotMatch(body, /DB\.wipe\(/);
  const validateAt = body.indexOf('validateLedgerBackup(payload)');
  const replaceAt = body.indexOf('replaceImported(');
  assert.ok(validateAt >= 0 && validateAt < replaceAt);

  const wipeStart = source.indexOf('async wipe()');
  const wipeEnd = source.indexOf('async replaceImported');
  const wipe = source.slice(wipeStart, wipeEnd);
  assert.doesNotMatch(wipe, /txTomb/);
  assert.doesNotMatch(wipe, /nudgeSync/);
});
