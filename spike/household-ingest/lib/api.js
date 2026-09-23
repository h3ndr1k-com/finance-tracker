'use strict';
const http = require('http');
const { pendingItems } = require('./queue');

function unauthorized(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

function createReviewServer({ store, token, host = '127.0.0.1', port = 8787 }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${token}`) return unauthorized(res);
    if (req.method === 'GET' && url.pathname === '/review') {
      const items = pendingItems(store);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items, count: items.length }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  return {
    listen() {
      return new Promise((resolve) => server.listen(port, host, () => resolve({ host, port })));
    },
    close() { return new Promise((resolve) => server.close(resolve)); },
    server,
  };
}

module.exports = { createReviewServer };
