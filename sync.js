'use strict';
/* Ledger sync: encrypted LED1 snapshot <-> first-party /api/sync.
   The host stores ciphertext only. No OAuth — household bearer token.
   Dropbox remains as a dormant rollback if a device still has a refresh token.
   Depends on index.html for: S, DB, SYNC_SCHEMA, schemaKeys, schemaEntry,
   getMeta, saveMeta, TOMB_TTL_MS, renderAll, toast. */

const SYNC_CFG_KEY = 'syncCfg';   // never synced: holds tokens + salt
const SYNC_PASS_KEY = 'syncPass';
const SYNC_BOOTSTRAP_URL = './sync-config.json';
const HOUSEHOLD_SYNC_URL = './api/sync';
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
  syncCfg = await DB.kvGet(SYNC_CFG_KEY, { enabled: false, provider: null, householdToken: '', appKey: '', refreshToken: null, accessToken: null, expiresAt: 0, saltB64: null, rememberPass: false });
  if (!syncCfg.householdToken) syncCfg.householdToken = '';
  const bootstrap = await getSyncBootstrap();
  if (bootstrap.appKey && !syncCfg.appKey) {
    syncCfg.appKey = String(bootstrap.appKey).trim();
    await saveSyncCfg();
  }
  return syncCfg;
}
function isHouseholdLinked(cfg) { return !!(cfg && cfg.enabled && cfg.householdToken); }
function isDropboxLinked(cfg) { return !!(cfg && cfg.enabled && cfg.refreshToken && !cfg.householdToken); }
function isSyncLinked(cfg) { return isHouseholdLinked(cfg) || isDropboxLinked(cfg); }
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
  const householdConfigured = !!(cfg.householdToken && String(cfg.householdToken).trim());
  const appKeyConfigured = !!(cfg.appKey && String(cfg.appKey).trim());
  const householdConnected = isHouseholdLinked(cfg);
  const dropboxConnected = isDropboxLinked(cfg);
  const sw = typeof getServiceWorkerDiagnostics === 'function'
    ? await getServiceWorkerDiagnostics()
    : null;
  return {
    householdConfigured,
    householdConnected,
    appKeyConfigured,
    dropboxConnected,
    bus: householdConnected ? 'household' : dropboxConnected ? 'dropbox' : 'none',
    passphraseReady: hasPassphrase(),
    lastSync: m.lastSync || 0,
    remoteRev: m.remoteRev || null,
    status: { state: st.state, detail: st.detail, issue: st.issue },
    serviceWorker: sw,
    redirectUri: typeof redirectUri === 'function' ? redirectUri() : null,
  };
}

/* ---------- snapshot ---------- */
function gcTombstones(m) {
  const cutoff = Date.now() - TOMB_TTL_MS;
  for (const id of Object.keys(m.txTomb)) if (m.txTomb[id] < cutoff) delete m.txTomb[id];
  for (const key of Object.keys(m.kv)) {
    const e = m.kv[key]; if (!e || !e.tomb) continue;
    for (const nk of Object.keys(e.tomb)) if (e.tomb[nk] < cutoff) delete e.tomb[nk];
  }
}
async function buildSnapshot() {
  const m = await getMeta();
  gcTombstones(m);
  await saveMeta();
  return {
    v: 2,
    settings: { base: S.settings.base },        // theme is device-local, never leaves
    rates: S.rates, budgets: S.budgets, rules: S.rules, mappings: S.mappings,
    accounts: S.accounts, jars: S.jars, catJar: S.catJar, jarMoves: S.jarMoves, jarAdjustments: S.jarAdjustments,
    subscriptions: S.subscriptions, creditCards: S.creditCards, businesses: S.businesses,
    transactions: S.tx,
    meta: { txTomb: { ...m.txTomb }, kv: JSON.parse(JSON.stringify(m.kv)) },
  };
}

/* ---------- merge ----------
   Last-write-wins per record with tombstones. Output must be a pure function of
   the two inputs regardless of argument order: merge(a,b) deep-equals merge(b,a).
   That is why nothing here stamps a time or a deviceId, and why ties break on a
   deterministic JSON compare rather than on which side was passed first. */
function newerOf(x, y, tx, ty) {
  if (tx !== ty) return tx > ty ? x : y;
  return JSON.stringify(x) <= JSON.stringify(y) ? x : y;
}
function mergeSnapshots(a, b) {
  const out = { v: 2, meta: { txTomb: {}, kv: {} } };

  /* transactions */
  const txTomb = {};
  for (const src of [a, b]) for (const [id, ts] of Object.entries(src.meta?.txTomb || {})) txTomb[id] = Math.max(txTomb[id] || 0, ts);
  const txMap = new Map();
  for (const t of (a.transactions || [])) txMap.set(t.id, t);
  for (const t of (b.transactions || [])) {
    const cur = txMap.get(t.id);
    txMap.set(t.id, cur ? newerOf(cur, t, cur.updatedAt || 0, t.updatedAt || 0) : t);
  }
  const txs = [];
  for (const [id, t] of txMap) {
    if ((txTomb[id] || 0) > (t.updatedAt || 0)) continue;   // tombstone newer: stays deleted
    txs.push(t);
    delete txTomb[id];                                       // record newer: edit/re-import beats delete
  }
  txs.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : (x.id < y.id ? -1 : 1)));
  out.transactions = txs;
  out.meta.txTomb = txTomb;

  /* kv blobs, resolved per sub-key so two devices editing different budgets both survive */
  for (const key of Object.keys(SYNC_SCHEMA)) {
    const sch = SYNC_SCHEMA[key];
    const aTs = a.meta?.kv?.[key]?.ts || {}, bTs = b.meta?.kv?.[key]?.ts || {};
    const aTomb = a.meta?.kv?.[key]?.tomb || {}, bTomb = b.meta?.kv?.[key]?.tomb || {};
    const ts = {}, tomb = {};
    for (const k of new Set([...Object.keys(aTs), ...Object.keys(bTs)])) ts[k] = Math.max(aTs[k] || 0, bTs[k] || 0);
    for (const k of new Set([...Object.keys(aTomb), ...Object.keys(bTomb)])) tomb[k] = Math.max(aTomb[k] || 0, bTomb[k] || 0);

    const allKeys = new Set([...schemaKeys(key, a[key]), ...schemaKeys(key, b[key])]);
    const chosen = {};
    for (const nk of allKeys) {
      const ea = schemaEntry(key, a[key], nk), eb = schemaEntry(key, b[key], nk);
      let entry;
      if (ea === undefined) entry = eb;
      else if (eb === undefined) entry = ea;
      else entry = newerOf(ea, eb, aTs[nk] || 0, bTs[nk] || 0);
      if ((tomb[nk] || 0) > (ts[nk] || 0)) continue;         // deleted more recently than touched
      chosen[nk] = entry;
      delete tomb[nk];
    }
    const nks = Object.keys(chosen).sort();
    if (sch.kind === 'map') {
      const obj = {}; for (const nk of nks) obj[nk] = chosen[nk]; out[key] = obj;
    } else {
      const arr = nks.map(nk => chosen[nk]);
      if (key === 'jars') arr.sort((x, y) => (x.ord ?? 999) - (y.ord ?? 999) || (x.id < y.id ? -1 : 1));
      if (key === 'jarMoves') arr.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : (x.id < y.id ? -1 : 1)));
      out[key] = arr;
    }
    out.meta.kv[key] = { ts, tomb };
  }
  return out;
}

async function applySnapshot(snap, opts = {}) {
  const comparable = (source) => {
    const out = {};
    for (const key of Object.keys(SYNC_SCHEMA)) {
      if (key === 'settings') out.settings = { base: source.settings?.base };
      else out[key] = source[key];
    }
    out.transactions = [...(source.transactions || [])].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return JSON.stringify(out);
  };
  const current = { ...S, settings: { base: S.settings.base }, transactions: S.tx };
  const contentChanged = comparable(current) !== comparable(snap);
  if (!contentChanged) {
    const m = await getMeta();
    m.txTomb = snap.meta.txTomb; m.kv = snap.meta.kv;
    await saveMeta();
    return false;
  }
  const nextIds = new Set(snap.transactions.map(t => t.id));
  const toDelete = S.tx.map(t => t.id).filter(id => !nextIds.has(id));
  if (toDelete.length) await DB.deleteTx(toDelete, false);
  if (snap.transactions.length) await DB.putTx(snap.transactions, false);
  S.tx = snap.transactions; S.txIds = nextIds;

  for (const key of Object.keys(SYNC_SCHEMA)) {
    if (key === 'settings') {
      if (snap.settings && snap.settings.base) S.settings.base = snap.settings.base;
      await DB.kvSet('settings', S.settings, false);
      continue;
    }
    S[key] = snap[key];
    await DB.kvSet(key, snap[key], false);
  }
  const m = await getMeta();
  m.txTomb = snap.meta.txTomb; m.kv = snap.meta.kv;
  await saveMeta();

  // Sync must paint Overview even if Settings is still open. Other forms
  // can still defer so we don't yank a transaction editor mid-type.
  const settingsOpen = document.getElementById('settingsModal')?.classList.contains('open');
  if (!opts.forceRender && !settingsOpen && document.querySelector('.modal-backdrop.open')) {
    deferredRender = true;
    return true;
  }
  renderAll();
  return true;
}

/* ---------- crypto ----------
   File: "LED1" | ver(1) | salt(16) | iv(12) | ciphertext+tag
   Salt is stable per ledger (minted once, then always adopted from the file) so the
   600k-iteration key derivation happens once per session instead of once per sync.
   The IV is fresh on every single encryption - GCM IV reuse under one key is fatal. */
function b64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function unb64(s) { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
function b64url(bytes) { return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

let _keyCache = null;
async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function keyFor(salt) {
  const sb = b64(salt);
  if (_keyCache && _keyCache.saltB64 === sb) return _keyCache.key;
  const key = await deriveKey(passphrase, salt);
  _keyCache = { saltB64: sb, key };
  return key;
}
async function currentSalt() {
  const cfg = await getSyncCfg();
  if (cfg.saltB64) return unb64(cfg.saltB64);
  const s = crypto.getRandomValues(new Uint8Array(16));
  cfg.saltB64 = b64(s); await saveSyncCfg();
  return s;
}
async function encryptSnapshot(obj) {
  const salt = await currentSalt();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(4 + 1 + 16 + 12 + ct.length);
  out.set([0x4C, 0x45, 0x44, 0x31], 0); out[4] = 1;
  out.set(salt, 5); out.set(iv, 21); out.set(ct, 33);
  return out;
}
async function decryptSnapshot(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.length < 34 || String.fromCharCode(...u8.slice(0, 4)) !== 'LED1') throw new Error('NOT_LEDGER_FILE');
  const salt = u8.slice(5, 21);
  const key = await keyFor(salt);
  let pt;
  try { pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.slice(21, 33) }, key, u8.slice(33)); }
  catch (e) { throw new Error('WRONG_PASSPHRASE'); }
  const cfg = await getSyncCfg();
  const sb = b64(salt);
  if (cfg.saltB64 !== sb) { cfg.saltB64 = sb; await saveSyncCfg(); }   // the file is the source of truth
  return JSON.parse(new TextDecoder().decode(pt));
}

/* ---------- Household (same-origin /api/sync, no OAuth) ---------- */
function householdHeaders(token, extra) {
  return { Authorization: 'Bearer ' + token, ...(extra || {}) };
}
function householdRev(r) {
  return (r.headers.get('x-ledger-rev') || r.headers.get('etag') || '').replace(/"/g, '').trim() || null;
}
async function connectHousehold(token) {
  const r = await fetch(HOUSEHOLD_SYNC_URL, {
    method: 'GET',
    headers: householdHeaders(token, { Accept: 'application/octet-stream' }),
    cache: 'no-store',
  });
  if (r.status === 401 || r.status === 403) throw new Error('AUTH_FAILED');
  if (r.status === 503) throw new Error('SYNC_SERVER_UNAVAILABLE');
  if (r.status !== 200 && r.status !== 404 && r.status !== 204) throw new Error('AUTH_FAILED');
  const cfg = await getSyncCfg();
  cfg.householdToken = token;
  cfg.provider = 'household';
  cfg.enabled = true;
  cfg.refreshToken = null;
  cfg.accessToken = null;
  cfg.expiresAt = 0;
  await saveSyncCfg();
}
async function downloadHousehold() {
  const cfg = await getSyncCfg();
  const r = await fetch(HOUSEHOLD_SYNC_URL, {
    method: 'GET',
    headers: householdHeaders(cfg.householdToken, { Accept: 'application/octet-stream' }),
    cache: 'no-store',
  });
  if (r.status === 404 || r.status === 204) return null;
  if (r.status === 401 || r.status === 403) throw new Error('NEEDS_RECONNECT');
  if (r.status === 503) throw new Error('SYNC_SERVER_UNAVAILABLE');
  if (r.status === 429) { const e = new Error('RATE_LIMIT'); e.code = 'RATE_LIMIT'; e.retryAfter = +(r.headers.get('Retry-After') || 5); throw e; }
  if (!r.ok) throw new Error('Household download failed: ' + r.status);
  const snap = await decryptSnapshot(await r.arrayBuffer());
  return { snap, rev: householdRev(r) };
}
async function uploadHousehold(snap, rev) {
  const cfg = await getSyncCfg();
  const bytes = await encryptSnapshot(snap);
  const headers = householdHeaders(cfg.householdToken, { 'Content-Type': 'application/octet-stream' });
  if (rev) headers['If-Match'] = rev;
  const r = await fetch(HOUSEHOLD_SYNC_URL, { method: 'PUT', headers, body: bytes, cache: 'no-store' });
  if (r.status === 409 || r.status === 412) { const e = new Error('CONFLICT'); e.code = 'CONFLICT'; throw e; }
  if (r.status === 401 || r.status === 403) throw new Error('NEEDS_RECONNECT');
  if (r.status === 503) throw new Error('SYNC_SERVER_UNAVAILABLE');
  if (r.status === 429) { const e = new Error('RATE_LIMIT'); e.code = 'RATE_LIMIT'; e.retryAfter = +(r.headers.get('Retry-After') || 5); throw e; }
  if (!r.ok) throw new Error('Household upload failed: ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return householdRev(r) || (await r.json().catch(() => ({}))).rev;
}

/* ---------- Dropbox (PKCE rollback; not used by the Settings connect form) ---------- */
function redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); }
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}
async function startDropboxAuth() {
  const cfg = await getSyncCfg();
  if (!cfg.appKey) {
    setStatus('missing-app-key', 'Add your Dropbox app key, then connect', 'missing-app-key');
    toast('Enter your Dropbox app key first');
    return;
  }
  const { verifier, challenge } = await pkce();
  sessionStorage.setItem('ledger.pkce', verifier);
  const u = new URL('https://www.dropbox.com/oauth2/authorize');
  u.searchParams.set('client_id', cfg.appKey);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('token_access_type', 'offline');   // without this: 4h token, no refresh
  u.searchParams.set('redirect_uri', redirectUri());
  location.href = u.toString();
}
async function finishDropboxAuth(code) {
  const cfg = await getSyncCfg();
  const verifier = sessionStorage.getItem('ledger.pkce');
  if (!verifier) throw new Error('Auth session expired, connect again');
  const body = new URLSearchParams({ code, grant_type: 'authorization_code', client_id: cfg.appKey, code_verifier: verifier, redirect_uri: redirectUri() });
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) {
    const text = await r.text();
    const classified = typeof LedgerSyncIssues !== 'undefined'
      ? LedgerSyncIssues.classifyHttpStatus(r.status, text)
      : null;
    if (classified?.message === 'REDIRECT_MISMATCH') throw new Error('REDIRECT_MISMATCH');
    throw new Error('AUTH_FAILED');
  }
  const j = await r.json();
  cfg.refreshToken = j.refresh_token; cfg.accessToken = j.access_token;
  cfg.expiresAt = Date.now() + (j.expires_in || 14400) * 1000; cfg.enabled = true;
  sessionStorage.removeItem('ledger.pkce');
  await saveSyncCfg();
}
async function accessToken() {
  const cfg = await getSyncCfg();
  if (cfg.accessToken && Date.now() < cfg.expiresAt - 60000) return cfg.accessToken;
  if (!cfg.refreshToken) throw new Error('NOT_CONNECTED');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.refreshToken, client_id: cfg.appKey });
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) {
    cfg.accessToken = null;
    if (r.status === 400) { cfg.refreshToken = null; await saveSyncCfg(); throw new Error('NEEDS_RECONNECT'); }
    const text = await r.text();
    const classified = typeof LedgerSyncIssues !== 'undefined'
      ? LedgerSyncIssues.classifyHttpStatus(r.status, text)
      : null;
    if (classified?.code === 'RATE_LIMIT') {
      const e = new Error('RATE_LIMIT'); e.code = 'RATE_LIMIT'; throw e;
    }
    throw new Error('AUTH_FAILED');
  }
  const j = await r.json();
  cfg.accessToken = j.access_token; cfg.expiresAt = Date.now() + (j.expires_in || 14400) * 1000;
  await saveSyncCfg();
  return cfg.accessToken;
}
async function downloadDropbox() {
  const tok = await accessToken();
  const r = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Dropbox-API-Arg': JSON.stringify({ path: REMOTE_PATH }) },
  });
  if (r.status === 409) return null;                      // path/not_found: no file yet, safe to create
  if (r.status === 429 || r.status === 503) {
    const e = new Error('RATE_LIMIT');
    e.code = 'RATE_LIMIT';
    e.retryAfter = +(r.headers.get('Retry-After') || 5);
    throw e;
  }
  if (!r.ok) throw new Error('Dropbox download failed: ' + r.status);
  const meta = JSON.parse(r.headers.get('dropbox-api-result') || '{}');
  const snap = await decryptSnapshot(await r.arrayBuffer());   // throws -> fatal, never falls through to create
  return { snap, rev: meta.rev };
}
async function uploadDropbox(snap, rev) {
  const tok = await accessToken();
  const bytes = await encryptSnapshot(snap);
  const mode = rev ? { '.tag': 'update', update: rev } : 'add';   // never "overwrite": the rev check IS the safety
  const r = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + tok,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path: REMOTE_PATH, mode, mute: true, autorename: false }),
    },
    body: bytes,
  });
  if (r.status === 409) { const e = new Error('CONFLICT'); e.code = 'CONFLICT'; throw e; }
  if (r.status === 429 || r.status === 503) { const e = new Error('RATE_LIMIT'); e.code = 'RATE_LIMIT'; e.retryAfter = +(r.headers.get('Retry-After') || 5); throw e; }
  if (!r.ok) throw new Error('Dropbox upload failed: ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return (await r.json()).rev;
}
async function downloadRemote() {
  const cfg = await getSyncCfg();
  if (isHouseholdLinked(cfg)) return downloadHousehold();
  return downloadDropbox();
}
async function uploadRemote(snap, rev) {
  const cfg = await getSyncCfg();
  if (isHouseholdLinked(cfg)) return uploadHousehold(snap, rev);
  return uploadDropbox(snap, rev);
}

/* ---------- orchestration ---------- */
async function doSync() {
  const cfg = await getSyncCfg();
  if (!isSyncLinked(cfg)) { setStatus('off'); return; }
  if (!passphrase) { setStatus('needs-pass', 'Passphrase needed'); return; }
  if (!navigator.onLine) { setStatus('offline'); return; }
  setStatus('syncing');
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const remote = await downloadRemote();
      const local = await buildSnapshot();
      const merged = remote ? mergeSnapshots(local, remote.snap) : local;
      await applySnapshot(merged, { forceRender: true });
      const mayUpload = typeof LedgerSyncIssues === 'undefined'
        ? !!(merged && merged.transactions && merged.transactions.length)
        : LedgerSyncIssues.shouldUploadHouseholdSnapshot(merged);
      if (!mayUpload) {
        const m = await getMeta(); m.lastSync = Date.now(); await saveMeta();
        setStatus('ok', remote
          ? ''
          : 'Household is empty — tap Sync now on the computer that has the transactions');
        if (typeof renderAll === 'function') renderAll();
        return;
      }
      try {
        const rev = await uploadRemote(merged, remote ? remote.rev : null);
        const m = await getMeta(); m.remoteRev = rev; m.lastSync = Date.now(); await saveMeta();
        setStatus('ok');
        if (typeof renderAll === 'function') renderAll();
        return;
      } catch (e) {
        if (e.code === 'CONFLICT') { await new Promise(r => setTimeout(r, 300 * Math.pow(2, attempt) + Math.random() * 200)); continue; }
        if (e.code === 'RATE_LIMIT') { await new Promise(r => setTimeout(r, e.retryAfter * 1000)); continue; }
        throw e;
      }
    }
    setStatus('conflict', 'Edits collided — retrying on the next change or Sync now', 'dropbox-conflict');
  } catch (e) {
    console.error('sync failed', e);
    const classified = typeof LedgerSyncIssues !== 'undefined'
      ? LedgerSyncIssues.classifySyncFailure(e, typeof navigator === 'undefined' ? true : navigator.onLine)
      : null;
    if (classified) setStatus(classified.state, classified.detail, classified.issue);
    else if (e.message === 'WRONG_PASSPHRASE') setStatus('error', 'Passphrase does not match the encrypted household snapshot', 'wrong-passphrase');
    else if (e.message === 'NOT_LEDGER_FILE') setStatus('error', 'That remote file is not a Ledger snapshot', 'invalid-remote-file');
    else if (e.message === 'NEEDS_RECONNECT') setStatus('needs-auth', 'Reconnect household sync', 'reconnect-required');
    else if (!navigator.onLine || e instanceof TypeError) setStatus('offline', 'No network — changes stay on this device until you are back online', 'offline');
    else setStatus('error', e.message.slice(0, 80), 'sync-error');
  }
}
/* Mutex with a re-run flag: a mutation landing mid-sync must not be dropped. */
function syncNow() {
  if (inflight) { pending = true; return inflight; }
  inflight = doSync().finally(() => { inflight = null; if (pending) { pending = false; syncNow(); } });
  return inflight;
}
function scheduleSync(ms = 5000) {
  if (!syncCfg || !syncCfg.enabled || !passphrase) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, ms);
}
function flushDeferredRender() { if (deferredRender) { deferredRender = false; renderAll(); } }

async function setPassphrase(p, remember) {
  passphrase = p; _keyCache = null;
  const cfg = await getSyncCfg();
  cfg.rememberPass = !!remember;
  await saveSyncCfg();
  if (remember) await DB.kvSet(SYNC_PASS_KEY, p, false);
  else await DB.kvSet(SYNC_PASS_KEY, null, false);
}
async function disconnectSync() {
  syncCfg = { enabled: false, provider: null, householdToken: '', appKey: syncCfg?.appKey || '', refreshToken: null, accessToken: null, expiresAt: 0, saltB64: syncCfg?.saltB64 || null, rememberPass: false };
  await saveSyncCfg();
  await DB.kvSet(SYNC_PASS_KEY, null, false);
  passphrase = null; _keyCache = null;
  setStatus('off');
}

async function initSync() {
  const cfg = await getSyncCfg();
  if (cfg.rememberPass) passphrase = await DB.kvGet(SYNC_PASS_KEY, null);

  const params = new URLSearchParams(location.search);
  let connectedThisVisit = false;
  if (params.get('code')) {
    try {
      await finishDropboxAuth(params.get('code'));
      connectedThisVisit = true;
      history.replaceState({}, '', redirectUri());
      toast('Dropbox connected. Enter the shared passphrase to start syncing.');
    }
    catch (e) {
      const classified = typeof LedgerSyncIssues !== 'undefined'
        ? LedgerSyncIssues.classifySyncFailure(e, typeof navigator === 'undefined' ? true : navigator.onLine)
        : null;
      if (classified && classified.issue !== 'sync-error') {
        setStatus(classified.state, classified.detail, classified.issue);
        toast(classified.issue === 'redirect-mismatch'
          ? 'Redirect URI mismatch — check Dropbox app settings'
          : classified.issue === 'auth-failure'
            ? 'Dropbox sign-in failed'
            : classified.detail);
      } else {
        setStatus('error', e.message.slice(0, 80), 'sync-error');
        toast(e.message);
      }
      history.replaceState({}, '', redirectUri());
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(syncTimer);
      if (isSyncLinked(syncCfg) && passphrase) syncNow();
    } else scheduleSync(500);
  });
  window.addEventListener('online', () => scheduleSync(500));
  window.addEventListener('pagehide', () => {
    clearTimeout(syncTimer);
    if (isSyncLinked(syncCfg) && passphrase) syncNow();
  });
  if (isSyncLinked(syncCfg)) {
    setStatus(passphrase ? 'idle' : 'needs-pass', passphrase ? '' : 'Enter the shared passphrase to sync');
    if (passphrase) syncNow();
    else if (connectedThisVisit && typeof showSettings === 'function') {
      syncFocusPassphrase = true;
      showSettings();
    }
  } else setStatus('off');
}

/* ---------- Settings diagnostics UI ----------
   Defined here so the panel ships even when index.html cannot be rewritten
   (large static file). This file loads after the app script and replaces
   the Settings sync renderer. Secrets are never interpolated into the DOM. */
function ensureSyncDiagStyles() {
  if (typeof document === 'undefined' || document.getElementById('sync-diag-css')) return;
  const style = document.createElement('style');
  style.id = 'sync-diag-css';
  style.textContent = [
    '.sync-diagnostics { margin: 14px 0 4px; padding: 12px 14px; border: 1px solid var(--hairline); border-radius: 11px; background: color-mix(in srgb, var(--card) 92%, var(--bg)); }',
    '.sync-diagnostics h3 { font-size: 13px; font-weight: 600; margin: 0 0 8px; letter-spacing: .02em; }',
    '.sync-diagnostics dl { margin: 0; display: grid; grid-template-columns: minmax(120px, 38%) 1fr; gap: 6px 10px; font-size: 13px; }',
    '.sync-diagnostics dt { color: var(--muted); margin: 0; }',
    '.sync-diagnostics dd { margin: 0; color: var(--ink); line-height: 1.4; }',
    '.sync-diagnostics .sync-next { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--hairline); font-size: 13px; }',
    '.sync-diagnostics .sync-next strong { color: var(--ink); }',
  ].join('\n');
  document.head.appendChild(style);
}

async function getServiceWorkerDiagnostics() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return { supported: false, controller: false, cacheVersion: null, update: 'unsupported' };
  }
  let cacheVersion = null;
  try {
    const r = await fetch('./sw.js', { cache: 'no-store' });
    const text = await r.text();
    const m = text.match(/const CACHE = '([^']+)'/);
    cacheVersion = m ? m[1] : 'unknown';
  } catch {
    cacheVersion = 'unavailable';
  }
  const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
  const controller = !!navigator.serviceWorker.controller;
  let update = 'none';
  if (reg?.waiting) update = 'waiting';
  else if (reg?.installing) update = 'installing';
  else if (reg?.active && !controller) update = 'pending-control';
  return {
    supported: true,
    controller,
    cacheVersion,
    activeState: reg?.active?.state || (controller ? 'activated' : 'none'),
    update,
    scope: reg?.scope || null,
  };
}

function relTime(ms) {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

async function probeHouseholdApi(token) {
  if (!token) return 'Not checked (no token on this device yet)';
  try {
    const r = await fetch(HOUSEHOLD_SYNC_URL, {
      method: 'GET',
      headers: householdHeaders(token, { Accept: 'application/octet-stream' }),
      cache: 'no-store',
    });
    if (r.status === 200) {
      const len = r.headers.get('content-length');
      return len === '0' || !len
        ? 'Reachable · household snapshot is empty — run Sync now on the device that has your data first'
        : 'Reachable · encrypted snapshot is on the server';
    }
    if (r.status === 404 || r.status === 204) {
      return 'Reachable · no snapshot yet — on your computer, Connect household, set passphrase, tap Sync now, then Sync now here';
    }
    if (r.status === 503) return 'Host missing HOUSEHOLD_SYNC_TOKEN or blob store — fix Vercel env and redeploy';
    if (r.status === 401 || r.status === 403) return 'Token rejected — paste the same household token as on your other devices';
    return `Unexpected response ${r.status} from /api/sync`;
  } catch {
    return 'Cannot reach /api/sync — use the same https production URL on phone and desktop (not a local file or preview URL unless that deploy is configured)';
  }
}

async function renderSyncPanel() {
  const el = typeof $ === 'function' ? $('#syncPanel') : null;
  if (!el) return;
  ensureSyncDiagStyles();
  if (typeof getSyncCfg !== 'function') { el.textContent = 'Sync module not loaded.'; return; }
  const cfg = await getSyncCfg();
  const st = getStatus();
  const m = await getMeta();
  const diag = await getSyncDiagnostics();
  const apiProbe = await probeHouseholdApi(cfg.householdToken);
  const connected = isSyncLinked(cfg);
  const household = isHouseholdLinked(cfg);
  const needsPassphrase = connected && !hasPassphrase();
  const labels = (typeof LedgerSyncIssues !== 'undefined' && LedgerSyncIssues.SYNC_LABEL) || {
    off: 'Not connected', idle: 'Connected', syncing: 'Syncing…', ok: 'Synced',
    offline: 'Offline', error: 'Sync problem', 'needs-pass': 'Passphrase required', 'needs-auth': 'Reconnect',
    'missing-app-key': 'Household token required', 'redirect-mismatch': 'Redirect URI mismatch',
    'auth-failure': 'Sign-in failed', conflict: 'Sync conflict', 'rate-limit': 'Sync rate limit',
  };
  const issue = st.issue || (!diag.householdConfigured && !diag.dropboxConnected ? 'missing-household-token' : null);
  const nextAction = typeof LedgerSyncIssues !== 'undefined'
    ? LedgerSyncIssues.syncIssueAction(issue, diag)
    : (st.detail || 'Paste the household token, connect, then set the shared passphrase on each device.');
  const sw = diag.serviceWorker;
  const swLine = !sw ? 'Unavailable' : !sw.supported ? 'Not supported in this browser'
    : `${sw.controller ? 'Controlling this tab' : 'Not controlling yet'} · cache ${esc(sw.cacheVersion || '?')}${sw.update !== 'none' ? ` · update ${esc(sw.update)}` : ''}`;
  const problemStates = ['error', 'needs-auth', 'redirect-mismatch', 'auth-failure', 'missing-app-key', 'missing-household-token', 'conflict', 'rate-limit'];
  const busLabel = household ? 'Household API (this site)' : connected ? 'Dropbox (legacy)' : 'Not connected';
  el.innerHTML = `
    <div class="formrow" style="margin-top:10px"><label>Status</label>
      <span class="pill ${problemStates.includes(st.state) ? 'grey' : ''}">${esc(labels[st.state] || st.state)}</span>
      ${connected ? `<span class="sub num">last sync ${esc(relTime(m.lastSync))}</span>` : ''}
      ${st.detail ? `<span class="sub">${esc(st.detail)}</span>` : ''}</div>
    <section class="sync-diagnostics" aria-labelledby="syncDiagHeading">
      <h3 id="syncDiagHeading">Sync diagnostics</h3>
      <dl>
        <dt>Service worker</dt><dd>${swLine}</dd>
        <dt>Household token</dt><dd>${diag.householdConfigured ? 'Configured (hidden)' : 'Not set — paste token below'}</dd>
        <dt>Sync bus</dt><dd>${esc(busLabel)}</dd>
        <dt>Passphrase</dt><dd>${hasPassphrase() ? 'Ready on this device' : 'Not entered on this device'}</dd>
        <dt>Last successful sync</dt><dd class="num">${esc(m.lastSync ? new Date(m.lastSync).toLocaleString() : 'Never')}</dd>
        <dt>Household API</dt><dd>${esc(apiProbe)}</dd>
        <dt>This URL</dt><dd class="num">${esc(typeof location !== 'undefined' ? location.origin + location.pathname : '')}</dd>
      </dl>
      <div class="sync-next"><strong>Next step:</strong> ${esc(nextAction)}</div>
    </section>
    ${!connected ? `
      <div class="formrow"><label>Household token</label><input id="syHouseholdToken" type="password" value="" autocomplete="off" placeholder="shared with every device"></div>
      <div class="sub">Same token on Hendrik’s phone, desktop, and the other phone. It stays on this device. There is no Dropbox or Google sign-in — Connect never leaves this app.</div>
      <div class="formrow" style="justify-content:flex-end"><button class="primary sm" id="syConnect">Connect household</button></div>`
    : `
      ${needsPassphrase ? `<div class="sync-recovery" role="status"><strong>This device is linked — one more step.</strong><p>Enter the same encryption passphrase used on the other devices. The server only stores ciphertext, so the token alone cannot start syncing.</p></div>` : ''}
      <div class="formrow"><label for="syPass">Passphrase</label><input type="password" id="syPass" autocomplete="current-password" placeholder="${hasPassphrase() ? 'set on this device' : 'same as the other devices'}">
        <label style="min-width:auto"><input type="checkbox" id="syRemember" style="flex:none" ${cfg.rememberPass ? 'checked' : ''}> remember on this device</label>
        <button class="ghost sm" id="sySetPass">${needsPassphrase ? 'Unlock & sync' : 'Update'}</button></div>
      <div class="sub">The passphrase is needed after a reconnect unless you choose to remember it on this device. If you both forget it, the household copy is unrecoverable — keep a JSON export.</div>
      <div class="formrow" style="justify-content:flex-end; margin-top:10px">
        <button class="ghost sm danger" id="syDisconnect">Disconnect</button>
        <button class="primary sm" id="sySync" ${hasPassphrase() ? '' : 'disabled'}>Sync now</button></div>`}`;

  if (!connected) {
    $('#syConnect').onclick = async () => {
      const typed = $('#syHouseholdToken').value.trim();
      if (!typed) { toast('Paste the household token first'); return; }
      try {
        await connectHousehold(typed);
        toast('Household linked. Enter the shared passphrase to start syncing.');
        syncFocusPassphrase = true;
        setStatus('needs-pass', 'Enter the shared passphrase to sync');
        renderSyncPanel();
      } catch (e) {
        const classified = typeof LedgerSyncIssues !== 'undefined'
          ? LedgerSyncIssues.classifySyncFailure(e, navigator.onLine)
          : null;
        if (classified && classified.issue !== 'sync-error') {
          setStatus(classified.state, classified.detail, classified.issue);
          toast(classified.detail);
        } else {
          setStatus('error', e.message.slice(0, 80), 'sync-error');
          toast(e.message);
        }
      }
    };
  } else {
    $('#sySetPass').onclick = async () => {
      const p = $('#syPass').value;
      if (p.length < 8) { toast('Use at least 8 characters'); return; }
      await setPassphrase(p, $('#syRemember').checked);
      toast('Passphrase set — syncing now'); renderSyncPanel(); syncNow();
    };
    $('#sySync').onclick = () => syncNow();
    $('#syDisconnect').onclick = async () => {
      if (!confirm('Disconnect this device from household sync? Local data stays; the other devices and the household copy are untouched.')) return;
      await disconnectSync(); renderSyncPanel();
    };
    if (needsPassphrase && syncFocusPassphrase) {
      syncFocusPassphrase = false;
      requestAnimationFrame(() => $('#syPass')?.focus());
    }
  }
}
