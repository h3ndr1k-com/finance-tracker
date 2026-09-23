'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const issues = require('../sync-issues.js');

test('named failure states have a next action and never mention secrets', () => {
  const named = [
    'missing-app-key', 'redirect-mismatch', 'auth-failure', 'reconnect-required',
    'offline', 'wrong-passphrase-or-missing', 'wrong-passphrase',
    'dropbox-conflict', 'dropbox-rate-limit', 'invalid-remote-file', 'sync-error',
  ];
  for (const issue of named) {
    const action = issues.syncIssueAction(issue, { appKeyConfigured: true, dropboxConnected: true, passphraseReady: true });
    assert.ok(action.length > 20, issue + ' needs a user-actionable next step');
    assert.doesNotMatch(action, /pk\.[a-z0-9]/i);
    assert.doesNotMatch(action, /sl\.[a-z0-9]/i);
    assert.doesNotMatch(action.toLowerCase(), /refresh token|access token|passphrase is /);
  }
});

test('inferSyncIssue maps UI states to precise codes', () => {
  assert.equal(issues.inferSyncIssue('needs-pass'), 'wrong-passphrase-or-missing');
  assert.equal(issues.inferSyncIssue('needs-auth'), 'reconnect-required');
  assert.equal(issues.inferSyncIssue('offline'), 'offline');
  assert.equal(issues.inferSyncIssue('redirect-mismatch'), 'redirect-mismatch');
  assert.equal(issues.inferSyncIssue('auth-failure'), 'auth-failure');
  assert.equal(issues.inferSyncIssue('conflict'), 'dropbox-conflict');
  assert.equal(issues.inferSyncIssue('rate-limit'), 'dropbox-rate-limit');
  assert.equal(issues.inferSyncIssue('error', 'Passphrase does not match'), 'wrong-passphrase');
  assert.equal(issues.inferSyncIssue('error', 'That Dropbox file is not a Ledger snapshot'), 'invalid-remote-file');
  assert.equal(issues.inferSyncIssue('ok'), null);
});

test('classifySyncFailure covers OAuth, reconnect, offline, conflict, and rate limit', () => {
  assert.equal(issues.classifySyncFailure({ message: 'REDIRECT_MISMATCH' }, true).issue, 'redirect-mismatch');
  assert.equal(issues.classifySyncFailure({ message: 'AUTH_FAILED' }, true).issue, 'auth-failure');
  assert.equal(issues.classifySyncFailure({ message: 'NEEDS_RECONNECT' }, true).issue, 'reconnect-required');
  assert.equal(issues.classifySyncFailure({ message: 'WRONG_PASSPHRASE' }, true).issue, 'wrong-passphrase');
  assert.equal(issues.classifySyncFailure({ message: 'RATE_LIMIT', code: 'RATE_LIMIT' }, true).issue, 'dropbox-rate-limit');
  assert.equal(issues.classifySyncFailure({ message: 'CONFLICT', code: 'CONFLICT' }, true).issue, 'dropbox-conflict');
  assert.equal(issues.classifySyncFailure({ message: 'failed', name: 'TypeError' }, true).issue, 'offline');
  assert.equal(issues.classifySyncFailure({ message: 'failed' }, false).issue, 'offline');
});

test('classifyHttpStatus distinguishes redirect mismatch from generic auth failure', () => {
  assert.equal(issues.classifyHttpStatus(400, '{"error":"invalid_redirect"}').message, 'REDIRECT_MISMATCH');
  assert.equal(issues.classifyHttpStatus(401, 'unauthorized').code, 'AUTH_FAILED');
  assert.equal(issues.classifyHttpStatus(429, '').code, 'RATE_LIMIT');
  assert.equal(issues.classifyHttpStatus(409, '').code, 'CONFLICT');
});

test('ready and missing-key fallbacks do not expose an app key', () => {
  const missing = issues.syncIssueAction(null, { appKeyConfigured: false, dropboxConnected: false, passphraseReady: false });
  assert.match(missing, /App key/i);
  assert.doesNotMatch(missing, /pk\./);
  const ready = issues.syncIssueAction(null, { appKeyConfigured: true, dropboxConnected: true, passphraseReady: true });
  assert.match(ready, /Sync is ready/);
});
