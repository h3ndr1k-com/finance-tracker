'use strict';
const fs = require('fs');
const path = require('path');

function defaultPaths(dir) {
  return {
    queue: path.join(dir, 'review-queue.json'),
    ledger: path.join(dir, 'ledger-index.json'),
  };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function openStore(dir) {
  const paths = defaultPaths(dir);
  return {
    paths,
    loadQueue() { return readJson(paths.queue, { items: [] }); },
    saveQueue(doc) { writeJson(paths.queue, doc); },
    loadLedger() { return readJson(paths.ledger, { fingerprints: [], providerIds: [] }); },
    saveLedger(doc) { writeJson(paths.ledger, doc); },
  };
}

function seenKeys(store) {
  const queue = store.loadQueue();
  const ledger = store.loadLedger();
  const ids = new Set(ledger.providerIds || []);
  const fps = new Set(ledger.fingerprints || []);
  for (const item of queue.items) {
    if (item.providerTxId) ids.add(`${item.provider}:${item.providerTxId}`);
    if (item.fingerprint) fps.add(item.fingerprint);
    if (item.id) ids.add(item.id);
  }
  return { ids, fps };
}

function enqueueNew(store, proposals) {
  const queue = store.loadQueue();
  const ledger = store.loadLedger();
  const seen = seenKeys(store);
  const result = { added: 0, skipped: 0, items: [] };
  for (const p of proposals) {
    const providerKey = p.providerTxId ? `${p.provider}:${p.providerTxId}` : null;
    const already = (providerKey && seen.ids.has(providerKey))
      || seen.ids.has(p.id)
      || seen.fps.has(p.fingerprint)
      || (ledger.fingerprints || []).includes(p.fingerprint);
    if (already) { result.skipped++; continue; }
    const item = { ...p, status: 'pending', queuedAt: new Date().toISOString() };
    queue.items.push(item);
    seen.ids.add(p.id);
    if (providerKey) seen.ids.add(providerKey);
    seen.fps.add(p.fingerprint);
    result.added++;
    result.items.push(item);
  }
  store.saveQueue(queue);
  return result;
}

function pendingItems(store) {
  return store.loadQueue().items.filter((i) => i.status === 'pending');
}

module.exports = { openStore, enqueueNew, pendingItems, seenKeys };
