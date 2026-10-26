'use strict';
/* Plaintext bridge inbox document (always stored inside LED1 ciphertext). */

(function bridgeInboxPayload(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LedgerBridgeInbox = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function inboxFactory() {
  const INBOX_VERSION = 1;

  function emptyInbox() {
    return { v: INBOX_VERSION, items: [] };
  }

  function normalizeInbox(doc) {
    if (!doc || typeof doc !== 'object') return emptyInbox();
    const items = Array.isArray(doc.items) ? doc.items.slice() : [];
    return { v: INBOX_VERSION, items };
  }

  function queueItemToInboxEntry(item) {
    const queueId = String(item?.id || '');
    if (!queueId) throw new Error('Queue item id required');
    return {
      queueId,
      createdAt: String(item.createdAt || new Date().toISOString()),
      source: String(item.source || 'telegram'),
      tx: {
        date: String(item.date),
        desc: String(item.desc),
        amount: Number(item.amount),
        currency: String(item.currency),
        account: String(item.account),
        category: String(item.category || 'Other'),
        business: String(item.business || ''),
        transfer: Boolean(item.transfer),
      },
    };
  }

  function bridgeTxId(queueId) {
    return `bridge:${queueId}`;
  }

  function inboxEntryToLedgerTx(entry, baseCurrency) {
    const queueId = String(entry?.queueId || '');
    const tx = entry?.tx || {};
    const id = bridgeTxId(queueId);
    const date = String(tx.date || '');
    const desc = String(tx.desc || '').trim();
    const amount = Number(tx.amount);
    const currency = String(tx.currency || baseCurrency || 'CAD').trim().toUpperCase();
    const account = String(tx.account || 'Unassigned').trim();
    const category = String(tx.category || 'Other').trim();
    if (!queueId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !desc || !Number.isFinite(amount) || amount === 0 || !/^[A-Z]{3}$/.test(currency) || !account) {
      throw new Error('Invalid bridge inbox transaction');
    }
    return {
      id,
      date,
      desc,
      amount: Math.round(amount * 100) / 100,
      currency,
      account,
      category: category || 'Other',
      business: String(tx.business || '').trim(),
      transfer: Boolean(tx.transfer),
      source: String(entry.source || 'telegram'),
    };
  }

  function mergeQueueIntoInbox(inboxDoc, queueItems) {
    const inbox = normalizeInbox(inboxDoc);
    const seen = new Set(inbox.items.map((item) => item.queueId));
    const added = [];
    for (const raw of queueItems || []) {
      if (raw?.acknowledgedAt) continue;
      const entry = queueItemToInboxEntry(raw);
      if (seen.has(entry.queueId)) continue;
      inbox.items.push(entry);
      seen.add(entry.queueId);
      added.push(entry.queueId);
    }
    inbox.items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : (a.queueId < b.queueId ? -1 : 1)));
    return { inbox, addedQueueIds: added };
  }

  /**
   * Apply inbox entries to a Ledger snapshot (v2). Returns { snap, appliedQueueIds, skippedQueueIds }.
   * Does not change jar allocation rules — only appends transactions like the loopback bridge client.
   */
  function applyInboxToSnapshot(snap, inboxDoc, opts = {}) {
    const baseCurrency = opts.baseCurrency || snap?.settings?.base || 'CAD';
    const inbox = normalizeInbox(inboxDoc);
    const txIds = new Set((snap?.transactions || []).map((t) => t.id));
    const appliedQueueIds = [];
    const skippedQueueIds = [];
    const now = Date.now();
    const transactions = [...(snap.transactions || [])];
    const accounts = { ...(snap.accounts || {}) };

    for (const entry of inbox.items) {
      let tx;
      try { tx = inboxEntryToLedgerTx(entry, baseCurrency); }
      catch { continue; }
      if (txIds.has(tx.id)) {
        skippedQueueIds.push(entry.queueId);
        continue;
      }
      tx.updatedAt = now;
      transactions.push(tx);
      txIds.add(tx.id);
      if (!(tx.account in accounts)) accounts[tx.account] = { currency: tx.currency };
      appliedQueueIds.push(entry.queueId);
    }

    transactions.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : (x.id < y.id ? -1 : 1)));
    const out = { ...snap, transactions, accounts };
    return { snap: out, appliedQueueIds, skippedQueueIds };
  }

  function removeQueueIdsFromInbox(inboxDoc, queueIds) {
    const wanted = new Set(Array.isArray(queueIds) ? queueIds : []);
    const inbox = normalizeInbox(inboxDoc);
    inbox.items = inbox.items.filter((item) => !wanted.has(item.queueId));
    return inbox;
  }

  return {
    INBOX_VERSION,
    emptyInbox,
    normalizeInbox,
    queueItemToInboxEntry,
    bridgeTxId,
    inboxEntryToLedgerTx,
    mergeQueueIntoInbox,
    applyInboxToSnapshot,
    removeQueueIdsFromInbox,
  };
}));
