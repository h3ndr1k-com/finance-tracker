'use strict';
const { txHash } = require('./fingerprint');

function normalizeProviderTx(raw, fetchedAt) {
  const amount = Number(raw.amount);
  if (!raw.date || !raw.description || !Number.isFinite(amount) || !raw.account) {
    return null;
  }
  const proposal = {
    date: String(raw.date),
    desc: String(raw.description).trim(),
    amount,
    currency: raw.currency || 'CAD',
    account: String(raw.account),
    source: 'review-queue',
    category: null,
    provider: raw.provider || 'mock',
    providerTxId: raw.providerTxId ? String(raw.providerTxId) : null,
    fetchedAt: fetchedAt || new Date().toISOString(),
  };
  proposal.fingerprint = txHash({
    date: proposal.date,
    amount: proposal.amount,
    desc: proposal.desc,
    account: proposal.account,
  });
  proposal.id = proposal.providerTxId
    ? `prov:${proposal.provider}:${proposal.providerTxId}`
    : `fp:${proposal.fingerprint}`;
  return proposal;
}

module.exports = { normalizeProviderTx };
