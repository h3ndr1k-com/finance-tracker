'use strict';
/* First-party household snapshot store.
   GET/PUT one LED1 ciphertext. The server never sees the passphrase or plaintext. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 8 * 1024 * 1024;
const BLOB_PATH = 'household/ledger.bin';

function isLed1(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 34
    && buf[0] === 0x4C && buf[1] === 0x45 && buf[2] === 0x44 && buf[3] === 0x31;
}

function revOf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function bearerToken(req) {
  const raw = req.headers.authorization || req.headers.Authorization || '';
  const m = String(raw).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function send(res, status, body, headers = {}) {
  const extra = {
    'Cache-Control': 'no-store',
    ...headers,
  };
  if (Buffer.isBuffer(body)) {
    extra['Content-Type'] = extra['Content-Type'] || 'application/octet-stream';
    extra['Content-Length'] = String(body.length);
    res.writeHead(status, extra);
    res.end(body);
    return;
  }
  extra['Content-Type'] = extra['Content-Type'] || 'application/json; charset=utf-8';
  const payload = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, extra);
  res.end(payload);
}

function fileStore(dir) {
  const file = path.join(dir, 'ledger.bin');
  return {
    async read() {
      try { return await fs.promises.readFile(file); }
      catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
    },
    async write(buf) {
      await fs.promises.mkdir(dir, { recursive: true });
      const tmp = file + '.tmp';
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, file);
    },
  };
}

function blobStore(token) {
  return {
    async read() {
      const blob = require('@vercel/blob');
      try {
        const meta = await blob.head(BLOB_PATH, { token });
        const r = await fetch(meta.url);
        if (!r.ok) return null;
        return Buffer.from(await r.arrayBuffer());
      } catch (e) {
        const msg = String(e && e.message || e);
        if (e && (e.status === 404 || e.statusCode === 404 || /not found/i.test(msg))) return null;
        throw e;
      }
    },
    async write(buf) {
      const blob = require('@vercel/blob');
      await blob.put(BLOB_PATH, buf, {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
        token,
        contentType: 'application/octet-stream',
      });
    },
  };
}

function createStore(opts = {}) {
  if (opts.dataDir) return fileStore(opts.dataDir);
  if (opts.blobToken || process.env.BLOB_READ_WRITE_TOKEN) {
    return blobStore(opts.blobToken || process.env.BLOB_READ_WRITE_TOKEN);
  }
  if (process.env.LEDGER_SYNC_DATA_DIR) return fileStore(process.env.LEDGER_SYNC_DATA_DIR);
  return null;
}

function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body));
  if (req.body && req.body.type === 'Buffer' && Array.isArray(req.body.data)) {
    return Promise.resolve(Buffer.from(req.body.data));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        reject(Object.assign(new Error('TOO_LARGE'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleHouseholdSync(req, res, opts = {}) {
  const expected = opts.token != null ? opts.token : process.env.HOUSEHOLD_SYNC_TOKEN;
  if (!expected) {
    send(res, 503, { error: 'SYNC_SERVER_UNAVAILABLE', message: 'HOUSEHOLD_SYNC_TOKEN is not set' });
    return;
  }
  if (!safeEqual(bearerToken(req), expected)) {
    send(res, 401, { error: 'AUTH_FAILED' });
    return;
  }

  const store = opts.store || createStore(opts);
  if (!store) {
    send(res, 503, { error: 'SYNC_SERVER_UNAVAILABLE', message: 'No snapshot store configured' });
    return;
  }

  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    send(res, 204, null);
    return;
  }

  if (method === 'GET' || method === 'HEAD') {
    const current = await store.read();
    if (!current) {
      send(res, 404, method === 'HEAD' ? null : { error: 'NOT_FOUND' });
      return;
    }
    const rev = revOf(current);
    const headers = { 'X-Ledger-Rev': rev, ETag: `"${rev}"` };
    send(res, 200, method === 'HEAD' ? null : current, headers);
    return;
  }

  if (method === 'PUT') {
    let body;
    try { body = await readRawBody(req); }
    catch (e) {
      if (e && e.code === 'TOO_LARGE') { send(res, 413, { error: 'TOO_LARGE' }); return; }
      throw e;
    }
    if (!isLed1(body)) {
      send(res, 400, { error: 'NOT_LEDGER_FILE' });
      return;
    }
    const current = await store.read();
    const ifMatch = String(req.headers['if-match'] || '').replace(/"/g, '').trim();
    if (current) {
      const currentRev = revOf(current);
      if (!ifMatch || ifMatch !== currentRev) {
        send(res, 409, { error: 'CONFLICT' }, { 'X-Ledger-Rev': currentRev, ETag: `"${currentRev}"` });
        return;
      }
    }
    await store.write(body);
    const rev = revOf(body);
    send(res, 200, { ok: true, rev }, { 'X-Ledger-Rev': rev, ETag: `"${rev}"` });
    return;
  }

  send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
}

module.exports = {
  handleHouseholdSync,
  createStore,
  fileStore,
  isLed1,
  revOf,
  BLOB_PATH,
};
