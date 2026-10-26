'use strict';
/* Vercel serverless entry for encrypted bridge inbox (LED1 ciphertext only). */

const { handleBridgeInboxSync } = require('./household-sync');

module.exports = async (req, res) => {
  try {
    await handleBridgeInboxSync(req, res);
  } catch (e) {
    console.error('bridge inbox sync failed', e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'SYNC_ERROR' }));
    }
  }
};
