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
let syncStatus = { state: 'off', detail: '' };
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
function setStatus(state, detail = '') { syncStatus = { state, detail }; document.dispatchEvent(new CustomEvent('syncstatus')); }
function getStatus() { return syncStatus; }
function hasPassphrase() { return !!passphrase; }

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
    subscriptions: S.subscriptions, creditCards: S.creditCards,
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

async function applySnapshot(snap) {
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

  // Never yank an open form out from under whoever is typing in it.
  if (document.querySelector('.modal-backdrop.open')) { deferredRender = true; return true; }
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

/* ---------- Dropbox (PKCE, app-folder scoped) ---------- */
function redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); }
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}
async function startDropboxAuth() {
  const cfg = await getSyncCfg();
  if (!cfg.appKey) { toast('Enter your Dropbox app key first'); return; }
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
  if (!r.ok) throw new Error('Dropbox auth failed: ' + (await r.text()).slice(0, 120));
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
  if (!r.ok) { cfg.accessToken = null; if (r.status === 400) { cfg.refreshToken = null; await saveSyncCfg(); throw new Error('NEEDS_RECONNECT'); } throw new Error('Dropbox token refresh failed'); }
  const j = await r.json();
  cfg.accessToken = j.access_token; cfg.expiresAt = Date.now() + (j.expires_in || 14400) * 1000;
  await saveSyncCfg();
  return cfg.accessToken;
}
async function downloadRemote() {
  const tok = await accessToken();
  const r = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Dropbox-API-Arg': JSON.stringify({ path: REMOTE_PATH }) },
  });
  if (r.status === 409) return null;                      // path/not_found: no file yet, safe to create
  if (!r.ok) throw new Error('Dropbox download failed: ' + r.status);
  const meta = JSON.parse(r.headers.get('dropbox-api-result') || '{}');
  const snap = await decryptSnapshot(await r.arrayBuffer());   // throws -> fatal, never falls through to create
  return { snap, rev: meta.rev };
}
async function uploadRemote(snap, rev) {
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

/* ---------- orchestration ---------- */
async function doSync() {
  const cfg = await getSyncCfg();
  if (!cfg.enabled || !cfg.refreshToken) { setStatus('off'); return; }
  if (!passphrase) { setStatus('needs-pass', 'Passphrase needed'); return; }
  if (!navigator.onLine) { setStatus('offline'); return; }
  setStatus('syncing');
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const remote = await downloadRemote();
      const local = await buildSnapshot();
      const merged = remote ? mergeSnapshots(local, remote.snap) : local;
      await applySnapshot(merged);
      try {
        const rev = await uploadRemote(merged, remote ? remote.rev : null);
        const m = await getMeta(); m.remoteRev = rev; m.lastSync = Date.now(); await saveMeta();
        setStatus('ok');
        return;
      } catch (e) {
        if (e.code === 'CONFLICT') { await new Promise(r => setTimeout(r, 300 * Math.pow(2, attempt) + Math.random() * 200)); continue; }
        if (e.code === 'RATE_LIMIT') { await new Promise(r => setTimeout(r, e.retryAfter * 1000)); continue; }
        throw e;
      }
    }
    setStatus('error', 'Too many conflicts, will retry');
  } catch (e) {
    console.error('sync failed', e);
    if (e.message === 'WRONG_PASSPHRASE') setStatus('error', 'Passphrase does not match the data in Dropbox');
    else if (e.message === 'NOT_LEDGER_FILE') setStatus('error', 'That Dropbox file is not a Ledger snapshot');
    else if (e.message === 'NEEDS_RECONNECT') setStatus('needs-auth', 'Reconnect Dropbox');
    else if (!navigator.onLine || e instanceof TypeError) setStatus('offline');
    else setStatus('error', e.message.slice(0, 80));
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
  syncCfg = { enabled: false, appKey: syncCfg?.appKey || '', refreshToken: null, accessToken: null, expiresAt: 0, saltB64: null, rememberPass: false };
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
    catch (e) { toast(e.message); history.replaceState({}, '', redirectUri()); }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(syncTimer);
      if (syncCfg?.enabled && syncCfg.refreshToken && passphrase) syncNow();
    } else scheduleSync(500);
  });
  window.addEventListener('online', () => scheduleSync(500));
  window.addEventListener('pagehide', () => {
    clearTimeout(syncTimer);
    if (syncCfg?.enabled && syncCfg.refreshToken && passphrase) syncNow();
  });
  if (syncCfg.enabled && syncCfg.refreshToken) {
    setStatus(passphrase ? 'idle' : 'needs-pass', passphrase ? '' : 'Enter the shared passphrase to sync');
    if (passphrase) syncNow();
    else if (connectedThisVisit && typeof showSettings === 'function') {
      syncFocusPassphrase = true;
      showSettings();
    }
  } else setStatus('off');
}
