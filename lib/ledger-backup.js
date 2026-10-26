'use strict';
/* Validate a JSON backup before any local data is touched. */

(function ledgerBackup(global) {
  const ARRAY_KEYS = ['rates', 'jars', 'jarMoves', 'jarAdjustments', 'subscriptions', 'creditCards'];
  const OBJECT_KEYS = ['settings', 'budgets', 'rules', 'mappings', 'accounts', 'catJar', 'businesses'];

  function validateLedgerBackup(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Not a Ledger export file');
    }
    if (!Array.isArray(payload.transactions)) throw new Error('Not a Ledger export file');
    const ids = new Set();
    payload.transactions.forEach((transaction, index) => {
      const label = `Transaction ${index + 1}`;
      if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) {
        throw new Error(`${label} is not an object`);
      }
      if (typeof transaction.id !== 'string' || !transaction.id.trim()) {
        throw new Error(`${label} is missing an id`);
      }
      if (ids.has(transaction.id)) throw new Error(`Duplicate transaction id ${transaction.id}`);
      ids.add(transaction.id);
    });
    for (const key of ARRAY_KEYS) {
      if (payload[key] != null && !Array.isArray(payload[key])) throw new Error(`${key} must be an array`);
    }
    for (const key of OBJECT_KEYS) {
      if (payload[key] != null && (typeof payload[key] !== 'object' || Array.isArray(payload[key]))) {
        throw new Error(`${key} must be an object`);
      }
    }
    return payload;
  }

  global.validateLedgerBackup = validateLedgerBackup;
  if (typeof module !== 'undefined' && module.exports) module.exports = { validateLedgerBackup };
})(typeof globalThis !== 'undefined' ? globalThis : window);
