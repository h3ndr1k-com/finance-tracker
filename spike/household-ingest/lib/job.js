'use strict';
const { fetchMockTransactions } = require('./mock-provider');
const { normalizeProviderTx } = require('./normalize');
const { enqueueNew } = require('./queue');

function runJob({ store, fixture }) {
  const batch = fetchMockTransactions({ fixture });
  const proposals = [];
  for (const raw of batch.transactions) {
    const row = normalizeProviderTx(raw, batch.fetchedAt);
    if (row) proposals.push(row);
  }
  const result = enqueueNew(store, proposals);
  return {
    source: batch.source,
    fetchedAt: batch.fetchedAt,
    seen: proposals.length,
    added: result.added,
    skipped: result.skipped,
    pending: store.loadQueue().items.filter((i) => i.status === 'pending').length,
  };
}

function runSchedule({ store, fixture, intervalMs, ticks = Infinity, onTick }) {
  let n = 0;
  const tick = () => {
    n += 1;
    const summary = runJob({ store, fixture });
    if (onTick) onTick(summary, n);
    return summary;
  };
  tick();
  if (ticks <= 1) return { stop() {} };
  const timer = setInterval(() => {
    if (n >= ticks) { clearInterval(timer); return; }
    tick();
  }, intervalMs);
  return { stop() { clearInterval(timer); } };
}

module.exports = { runJob, runSchedule };
