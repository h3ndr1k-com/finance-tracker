'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const root = path.join(__dirname, '..');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.gz': 'application/gzip',
};

function startStaticServer(preferredPort = 4173) {
  const handler = (req, res, port) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    let filePath = path.join(root, decodeURIComponent(url.pathname));
    if (url.pathname.endsWith('/')) filePath = path.join(root, 'index.html');
    if (!filePath.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  };
  const tryPort = (port) => new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => handler(req, res, port));
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && port < preferredPort + 8) resolve(tryPort(port + 1));
      else reject(err);
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, port }));
  });
  return tryPort(preferredPort);
}

module.exports = { startStaticServer, root };
