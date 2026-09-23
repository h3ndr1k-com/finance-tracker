'use strict';
/* Ledger sync: encrypted snapshot <-> the user's own Dropbox app folder.
   No backend. Dropbox only ever stores ciphertext it cannot read.
   Depends on index.html for: S, DB, SYNC_SCHEMA, schemaKeys, schemaEntry,
   getMeta, saveMeta, TOMB_TTL_MS, renderAll, toast. */

const SYNC_CFG_KEY = 'syncCfg';   // never synced: holds tokens + salt
const SYNC_PASS_KEY = 'syncPass';
const SYNC_BOOTSTRAP_URL = './sync-config.json';
const REMOTE_PATH = '/ledger.bin';
const PBKDF2_ITER = 600000;

let syncCfg = null;
let syncBootstrap = undefined;
let passphrase = null;
let syncTimer = null;
let inflight = null, pending = false;
let syncStatus = { state: 'off', detail: '', issue: null };
let deferredRender = false;
let syncFocusPassphrase = false;

async function getSyncBootstrap() {
  if (syncBootstrap !== undefined) return syncBootstrap;
  syncBootstrap = {};
  try {
    const r = await fetch(SYNC_BOOTSTRAP_URL, { cache: 'no-store' });
    if (!r.ok) return syncBootstrap;
    const j = await r.json();
    if (j && typeof j === 'object') syncBootstrap = j;
  } catch {
    // Optional helper file. Missing or invalid bootstrap is not an error.
  }
  return syncBootstrap;
}

async function getSyncCfg() {
  if (syncCfg) return syncCfg;
  syncCfg = await DB.kvGet(SYNC_CFG_KEY, { enabled: false, appKey: '', refreshToken: null, accessToken: null, expiresAt: 0, saltB64: null, rememberPass: false });
  const bootstrap = await getSyncBootstrap();
  if (bootstrap.appKey && !syncCfg.appKey) {
    syncCfg.appKey = String(bootstrap.appKey).trim();
    await saveSyncCfg();
  }
  return syncCfg;
}
async function saveSyncCfg() { await DB.kvSet(SYNC_CFG_KEY, syncCfg, false); }
function setStatus(state, detail = '', issue = null) {
  const inferred = issue || (typeof LedgerSyncIssues !== 'undefined'
    ? LedgerSyncIssues.inferSyncIssue(state, detail)
    : null);
  syncStatus = { state, detail, issue: inferred };
  document.dispatchEvent(new CustomEvent('syncstatus'));
}
function getStatus() { return syncStatus; }
function hasPassphrase() { return !!passphrase; }

async function getSyncDiagnostics() {
  const cfg = await getSyncCfg();
  const st = getStatus();
  const m = await getMeta();
  const appKeyConfigured = !!(cfg.appKey && String(cfg.appKey).trim());
  const dropboxConnected = !!(cfg.enabled && cfg.refreshToken);
  const sw = typeof getServiceWorkerDiagnostics === 'function'
    ? await getServiceWorkerDiagnostics()
    : null;
  return {
    appKeyConfigured,
    dropboxConnected,
    passphraseReady: hasPassphrase(),
    lastSync: m.lastSync || 0,
    remoteRev: m.remoteRev || null,
    status: { state: st.state, detail: st.detail, issue: st.issue },
    serviceWorker: sw,
    redirectUri: typeof redirectUri === 'function' ? redirectUri() : null,
  };
}
