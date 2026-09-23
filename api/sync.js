'use strict';
/* Vercel serverless entry for household snapshot sync. */

const { handleHouseholdSync } = require('./household-sync');

module.exports = async (req, res) => {
  try {
    await handleHouseholdSync(req, res);
  } catch (e) {
    console.error('household sync failed', e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'SYNC_ERROR' }));
    }
  }
};
