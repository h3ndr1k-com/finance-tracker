'use strict';
const fs = require('fs');
const path = require('path');

function loadFixture(filePath) {
  const abs = path.resolve(filePath);
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  if (!data || !Array.isArray(data.transactions)) {
    throw new Error('Fixture must be { transactions: [...] } with fake merchants only');
  }
  for (const row of data.transactions) {
    const desc = String(row.description || '');
    if (/pk\.|sk_live|password|refresh_token/i.test(desc)) {
      throw new Error('Fixture looks like it contains secrets — refused');
    }
  }
  return data.transactions;
}

/** Deliberate mocked source: a bank-data provider *or* a statement drop. */
function fetchMockTransactions({ fixture }) {
  return {
    source: 'mock-statement-or-provider',
    fetchedAt: new Date().toISOString(),
    transactions: loadFixture(fixture),
  };
}

module.exports = { fetchMockTransactions, loadFixture };
