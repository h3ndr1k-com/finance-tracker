'use strict';

(function bridgeClient(global) {
  const DEFAULT_URL = 'http://127.0.0.1:8788';

  function normalizeQueueItem(item, baseCurrency) {
    const id = String(item?.id || '');
    const date = String(item?.date || '');
    const desc = String(item?.desc || '').trim();
    const amount = Number(item?.amount);
    const currency = String(item?.currency || baseCurrency || 'CAD').trim().toUpperCase();
    const account = String(item?.account || 'Unassigned').trim();
    const category = String(item?.category || 'Other').trim();
    if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !desc || !Number.isFinite(amount) || amount === 0 || !/^[A-Z]{3}$/.test(currency) || !account) {
      throw new Error('Invalid bridge transaction');
    }
    return {
      id: `bridge:${id}`, date, desc, amount: Math.round(amount * 100) / 100, currency, account, category: category || 'Other',
      business: String(item?.business || '').trim(), transfer: Boolean(item?.transfer), source: 'telegram',
    };
  }

  async function bridgeFetch(path, options = {}) {
    const settings = S?.settings || {};
    const base = String(settings.bridgeUrl || DEFAULT_URL).replace(/\/+$/, '');
    const token = String(settings.bridgeToken || '');
    if (!token) throw new Error('Bridge key has not been set');
    const response = await fetch(base + path, {
      ...options,
      headers: { 'x-ledger-bridge-key': token, ...(options.headers || {}) },
    });
    if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`);
    return response;
  }

  async function pullLedgerBridge() {
    if (!S?.settings?.bridgeToken || !DB) return { applied: 0, skipped: 0 };
    const response = await bridgeFetch('/v1/transactions');
    const payload = await response.json();
    const items = Array.isArray(payload.items) ? payload.items : [];
    const acknowledged = []; let applied = 0; let skipped = 0;
    for (const item of items) {
      let transaction;
      try { transaction = normalizeQueueItem(item, S.settings.base); }
      catch (error) { console.warn('Skipping invalid bridge item', error); continue; }
      if (S.txIds.has(transaction.id)) { acknowledged.push(item.id); skipped++; continue; }
      await DB.putTx([transaction]);
      S.tx.push(transaction); S.txIds.add(transaction.id);
      if (!(transaction.account in S.accounts)) {
        S.accounts[transaction.account] = { currency: transaction.currency };
        await DB.kvSet('accounts', S.accounts);
      }
      acknowledged.push(item.id); applied++;
    }
    if (acknowledged.length) {
      await bridgeFetch('/v1/ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: acknowledged }) });
      renderAll();
    }
    return { applied, skipped };
  }

  async function pairLedgerBridge() {
    const base = String(S?.settings?.bridgeUrl || DEFAULT_URL).replace(/\/+$/, '');
    const response = await fetch(base + '/v1/pair', { method: 'POST' });
    if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload?.token) throw new Error('Bridge pairing failed');
    S.settings.bridgeToken = payload.token;
    await DB.kvSet('settings', S.settings);
    return pullLedgerBridge();
  }

  async function testLedgerBridge() {
    await bridgeFetch('/v1/health');
    return pullLedgerBridge();
  }

  global.initLedgerBridge = function initLedgerBridge() {
    (S?.settings?.bridgeToken ? pullLedgerBridge() : pairLedgerBridge()).catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pullLedgerBridge().catch(() => {}); });
  };
  global.pullLedgerBridge = pullLedgerBridge;
  global.testLedgerBridge = testLedgerBridge;
  global.pairLedgerBridge = pairLedgerBridge;
  if (typeof module !== 'undefined' && module.exports) module.exports = { normalizeQueueItem };
})(globalThis);
