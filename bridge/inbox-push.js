'use strict';
/*
 * Mac-side bridge inbox pusher: reads ~/.hermes/finance-bridge/queue.json,
 * merges pending items into the encrypted /api/bridge-inbox blob, acknowledges
 * the local queue on success. Passphrase never logged.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createBridgeStore } = require('./ledger-bridge');
const { encryptJson, decryptJson, saltFromLed1, isLed1Buffer } = require('../lib/led1-node');
const {
  emptyInbox,
  normalizeInbox,
  mergeQueueIntoInbox,
} = require('../lib/bridge-inbox-payload');

const DEFAULT_DIR = process.env.LEDGER_BRIDGE_DIR || path.join(os.homedir(), '.hermes', 'finance-bridge');
const DEFAULT_SYNC_ORIGIN = process.env.LEDGER_SYNC_ORIGIN || 'https://ledger-tracker-psi.vercel.app';

function expandHome(p) {
  const s = String(p || '').trim();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

function readSecretFile(filePath) {
  const p = expandHome(filePath);
  if (!p || !fs.existsSync(p)) throw new Error(`Secret file not found: ${p}`);
  const raw = fs.readFileSync(p, 'utf8').replace(/\r/g, '');
  const line = raw.split('\n').find((row) => row.trim() && !row.trim().startsWith('#'));
  if (!line) throw new Error(`Secret file is empty: ${p}`);
  return line.trim();
}

function readJsonFile(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(expandHome(filePath), 'utf8')); }
  catch { return fallback; }
}

function loadPushConfig(dir = DEFAULT_DIR) {
  const file = path.join(dir, 'inbox-push.json');
  const fromFile = readJsonFile(file, null);
  const origin = String(process.env.LEDGER_SYNC_ORIGIN || fromFile?.syncOrigin || DEFAULT_SYNC_ORIGIN).replace(/\/+$/, '');
  return {
    dir,
    syncOrigin: origin,
    inboxUrl: String(process.env.LEDGER_BRIDGE_INBOX_URL || fromFile?.inboxUrl || `${origin}/api/bridge-inbox`),
    snapshotUrl: String(process.env.LEDGER_SYNC_URL || fromFile?.snapshotUrl || `${origin}/api/sync`),
    householdTokenFile: process.env.LEDGER_HOUSEHOLD_TOKEN_FILE || fromFile?.householdTokenFile || path.join(dir, 'household-token'),
    passphraseFile: process.env.LEDGER_SYNC_PASSPHRASE_FILE || fromFile?.passphraseFile || path.join(dir, 'sync-passphrase'),
    saltB64File: process.env.LEDGER_SYNC_SALT_FILE || fromFile?.saltB64File || path.join(dir, 'sync-salt.b64'),
  };
}

function householdHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...(extra || {}) };
}

function revFromResponse(r) {
  return (r.headers.get('x-ledger-rev') || r.headers.get('etag') || '').replace(/"/g, '').trim() || null;
}

async function fetchLed1(url, token, method = 'GET', body = null, rev = null) {
  const headers = householdHeaders(token, { Accept: 'application/octet-stream' });
  if (body) headers['Content-Type'] = 'application/octet-stream';
  if (rev) headers['If-Match'] = rev;
  const r = await fetch(url, { method, headers, body: body || undefined, cache: 'no-store' });
  return r;
}

async function resolveSalt(cfg, token, passphrase) {
  for (const url of [cfg.inboxUrl, cfg.snapshotUrl]) {
    const r = await fetchLed1(url, token, 'GET');
    if (r.status === 404 || r.status === 204) continue;
    if (!r.ok) throw new Error(`Could not read LED1 salt from ${url}: HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (!isLed1Buffer(buf)) throw new Error(`Remote file at ${url} is not LED1`);
    return saltFromLed1(buf);
  }
  const saltFile = expandHome(cfg.saltB64File);
  if (fs.existsSync(saltFile)) {
    const sb = readSecretFile(saltFile);
    return Buffer.from(sb, 'base64');
  }
  const salt = crypto.randomBytes(16);
  fs.writeFileSync(saltFile, `${salt.toString('base64')}\n`, { mode: 0o600 });
  return salt;
}

async function downloadInbox(cfg, token, passphrase) {
  const r = await fetchLed1(cfg.inboxUrl, token, 'GET');
  if (r.status === 404 || r.status === 204) return { doc: emptyInbox(), rev: null, saltB64: null };
  if (!r.ok) throw new Error(`Inbox download failed: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const { json, saltB64 } = decryptJson(passphrase, buf);
  return { doc: normalizeInbox(json), rev: revFromResponse(r), saltB64 };
}

async function pushPendingToInbox(cfg, token, passphrase, salt, queueItems) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { doc, rev } = await downloadInbox(cfg, token, passphrase);
    const { inbox, addedQueueIds } = mergeQueueIntoInbox(doc, queueItems);
    if (!addedQueueIds.length) return { addedQueueIds: [], rev };
    const bytes = encryptJson(passphrase, salt, inbox);
    const r = await fetchLed1(cfg.inboxUrl, token, 'PUT', bytes, rev);
    if (r.status === 409 || r.status === 412) {
      await new Promise((res) => setTimeout(res, 200 * (attempt + 1) + Math.random() * 100));
      continue;
    }
    if (!r.ok) throw new Error(`Inbox upload failed: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    return { addedQueueIds, rev: revFromResponse(r) };
  }
  throw new Error('Inbox upload conflict after retries');
}

async function runInboxPush(opts = {}) {
  const cfg = loadPushConfig(opts.dir || DEFAULT_DIR);
  const store = createBridgeStore(cfg.dir);
  const pending = store.pending();
  if (!pending.length) return { pushed: 0, pending: 0 };

  const token = opts.householdToken || readSecretFile(cfg.householdTokenFile);
  const passphrase = opts.passphrase || readSecretFile(cfg.passphraseFile);

  const salt = opts.salt || await resolveSalt(cfg, token, passphrase);
  const { addedQueueIds } = await pushPendingToInbox(cfg, token, passphrase, salt, pending);
  if (!addedQueueIds.length) return { pushed: 0, pending: pending.length, skipped: pending.length };

  store.acknowledge(addedQueueIds);
  return { pushed: addedQueueIds.length, pending: store.pending().length, queueIds: addedQueueIds };
}

async function main() {
  const result = await runInboxPush();
  if (result.pushed) {
    console.log(JSON.stringify({ ok: true, pushed: result.pushed, queueIds: result.queueIds }));
  } else {
    console.log(JSON.stringify({ ok: true, pushed: 0, pending: result.pending || 0 }));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || 'inbox push failed');
    process.exitCode = 1;
  });
}

module.exports = { runInboxPush, loadPushConfig, readSecretFile };
