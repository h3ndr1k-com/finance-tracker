'use strict';
/* Shared Dropbox/sync issue codes and next-step copy.
   Loaded in the browser (before sync.js) and required by Node tests.
   Never include secrets — only public state labels. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LedgerSyncIssues = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SYNC_LABEL = {
    off: 'Not connected',
    idle: 'Connected',
    syncing: 'Syncing…',
    ok: 'Synced',
    offline: 'Offline',
    error: 'Sync problem',
    'needs-pass': 'Passphrase required',
    'needs-auth': 'Reconnect Dropbox',
    'missing-app-key': 'App key required',
    'redirect-mismatch': 'Redirect URI mismatch',
    'auth-failure': 'Sign-in failed',
    conflict: 'Dropbox conflict',
    'rate-limit': 'Dropbox rate limit',
  };

  const SYNC_NEXT_ACTION = {
    'missing-app-key': 'Paste the App key from dropbox.com/developers (it stays hidden after save). Add the redirect URI shown under Sync in Dropbox → Settings → OAuth 2, then Connect.',
    'redirect-mismatch': 'In Dropbox Developer Console → your app → Settings → OAuth 2 → Redirect URIs, add the exact URL shown under Sync (including trailing slash). Save there, reload this page, then Connect again.',
    'auth-failure': 'Tap Connect Dropbox again. If it keeps failing, disconnect Ledger in Dropbox account settings for this app and reconnect.',
    'reconnect-required': 'Tap Disconnect, then Connect Dropbox and approve access again. The encrypted file in Dropbox is unchanged.',
    offline: 'Reconnect to the internet, then open Ledger or tap Sync now. Nothing is lost on this device.',
    'wrong-passphrase-or-missing': 'Enter the same passphrase used on your other device, then tap Unlock & sync.',
    'wrong-passphrase': 'Use the passphrase from your other device. If you cannot recover it, restore from a JSON export instead of guessing.',
    'dropbox-conflict': 'Wait a few seconds, then tap Sync now so both devices merge the latest edits.',
    'dropbox-rate-limit': 'Dropbox asked Ledger to slow down. Wait about a minute, then tap Sync now.',
    'invalid-remote-file': 'The file at /Apps/Ledger/ledger.bin is not from Ledger. Remove it in Dropbox or use a fresh app folder, then sync again.',
    'sync-error': 'Use the status line above, fix that issue, then tap Sync now. Secrets are never shown here.',
  };

  function inferSyncIssue(state, detail) {
    if (!state || state === 'off' || state === 'ok' || state === 'idle' || state === 'syncing') return null;
    if (state === 'needs-pass') return 'wrong-passphrase-or-missing';
    if (state === 'needs-auth') return 'reconnect-required';
    if (state === 'offline') return 'offline';
    if (state === 'missing-app-key') return 'missing-app-key';
    if (state === 'redirect-mismatch') return 'redirect-mismatch';
    if (state === 'auth-failure') return 'auth-failure';
    if (state === 'conflict') return 'dropbox-conflict';
    if (state === 'rate-limit') return 'dropbox-rate-limit';
    if (state === 'error') {
      const d = String(detail || '').toLowerCase();
      if (d.includes('passphrase')) return 'wrong-passphrase';
      if (d.includes('not a ledger')) return 'invalid-remote-file';
      return 'sync-error';
    }
    return null;
  }

  function syncIssueAction(issue, diag) {
    if (issue && SYNC_NEXT_ACTION[issue]) return SYNC_NEXT_ACTION[issue];
    if (diag && !diag.appKeyConfigured) return SYNC_NEXT_ACTION['missing-app-key'];
    if (diag && !diag.dropboxConnected) {
      return 'Connect Dropbox and approve access, then set the shared passphrase on both devices.';
    }
    if (diag && diag.dropboxConnected && !diag.passphraseReady) {
      return SYNC_NEXT_ACTION['wrong-passphrase-or-missing'];
    }
    return 'Sync is ready. Edits upload automatically; use Sync now after reconnecting or if another device just changed data.';
  }

  function classifySyncFailure(error, online) {
    const msg = error && error.message != null ? String(error.message) : '';
    const code = error && error.code ? String(error.code) : '';
    if (msg === 'WRONG_PASSPHRASE') {
      return { state: 'error', detail: 'Passphrase does not match the encrypted file in Dropbox', issue: 'wrong-passphrase' };
    }
    if (msg === 'NOT_LEDGER_FILE') {
      return { state: 'error', detail: 'That Dropbox file is not a Ledger snapshot', issue: 'invalid-remote-file' };
    }
    if (msg === 'NEEDS_RECONNECT') {
      return { state: 'needs-auth', detail: 'Dropbox session expired — connect again', issue: 'reconnect-required' };
    }
    if (msg === 'REDIRECT_MISMATCH' || /redirect_uri|invalid_redirect/i.test(msg)) {
      return { state: 'redirect-mismatch', detail: 'Redirect URI in Dropbox must match this page exactly', issue: 'redirect-mismatch' };
    }
    if (msg.startsWith('AUTH_FAILED') || code === 'AUTH_FAILED') {
      return { state: 'auth-failure', detail: 'Dropbox rejected the sign-in — try Connect again', issue: 'auth-failure' };
    }
    if (code === 'RATE_LIMIT' || msg === 'RATE_LIMIT') {
      return { state: 'rate-limit', detail: 'Dropbox is busy — wait a moment, then Sync now', issue: 'dropbox-rate-limit' };
    }
    if (code === 'CONFLICT' || msg === 'CONFLICT') {
      return { state: 'conflict', detail: 'Another device wrote at the same time — Sync now to merge', issue: 'dropbox-conflict' };
    }
    if (online === false || msg === 'TypeError' || (error && error.name === 'TypeError')) {
      return { state: 'offline', detail: 'No network — changes stay on this device until you are back online', issue: 'offline' };
    }
    return { state: 'error', detail: msg.slice(0, 80) || 'Sync problem', issue: 'sync-error' };
  }

  function classifyHttpStatus(status, body) {
    const text = String(body || '');
    if (status === 429 || status === 503) {
      return { code: 'RATE_LIMIT', message: 'RATE_LIMIT' };
    }
    if (status === 409) {
      return { code: 'CONFLICT', message: 'CONFLICT' };
    }
    if (/redirect_uri|invalid_redirect/i.test(text)) {
      return { code: 'REDIRECT_MISMATCH', message: 'REDIRECT_MISMATCH' };
    }
    if (status === 400 || status === 401 || /invalid_grant|invalid_client|unauthorized/i.test(text)) {
      return { code: 'AUTH_FAILED', message: 'AUTH_FAILED' };
    }
    return null;
  }

  return {
    SYNC_LABEL,
    SYNC_NEXT_ACTION,
    inferSyncIssue,
    syncIssueAction,
    classifySyncFailure,
    classifyHttpStatus,
  };
});
