'use strict';
/* First-party household snapshot store.
   GET/PUT one LED1 ciphertext. The server never sees the passphrase or plaintext. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 8 * 1024 * 1024;
const BLOB_PATH = 'household/ledger.bin';
const DEFAULT_INBOX_BLOB_PATH = 'household/bridge-inbox.bin';

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

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/* mkdir is atomic on the same filesystem, so the read/compare/write stays one
   critical section even when two Node processes hit the file together. */
async function withDirLock(dir, fn) {
  await fs.promises.mkdir(dir, { recursive: true });
  const lockDir = path.join(dir, '.ledger-sync.lock');
  const started = Date.now();
  for (;;) {
    try {
      await fs.promises.mkdir(lockDir);
      break;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const st = await fs.promises.stat(lockDir);
        stale = Date.now() - st.mtimeMs > 10000;
      } catch (err) {
        if (err && err.code === 'ENOENT') continue;
        throw err;
      }
      if (stale) {
        await fs.promises.rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > 8000) {
        throw Object.assign(new Error('Snapshot lock timed out'), { code: 'LOCK_TIMEOUT' });
      }
      await delay(10);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.promises.rm(lockDir, { recursive: true, force: true });
  }
}

function fileStore(dir, filename = 'ledger.bin', opts = {}) {
  const file = path.join(dir, filename);
  async function read() {
    try { return await fs.promises.readFile(file); }
    catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
  }
  async function write(buf) {
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, file);
  }
  return {
    read,
    write,
    /* expectedRev is the caller's If-Match (content hash). Empty means the
       snapshot must still be absent. The lock covers the gap a parallel PUT
       would otherwise use to overwrite a revision it never read. */
    async compareAndSwap(expectedRev, buf) {
      return withDirLock(dir, async () => {
        const current = await read();
        if (opts.pauseMs) await delay(opts.pauseMs);
        if (current) {
          const currentRev = revOf(current);
          if (!expectedRev || expectedRev !== currentRev) return { ok: false, rev: currentRev };
        }
        await write(buf);
        return { ok: true, rev: revOf(buf) };
      });
    },
  };
}

function isConditionalConflict(error) {
  if (!error) return false;
  const name = String(error.name || '');
  if (name === 'BlobPreconditionFailedError' || name === 'BlobAlreadyExistsError') return true;
  const status = error.status || error.statusCode;
  if (status === 412) return true;
  if (status === 409 && /exist|precondition|conflict/i.test(String(error.message || ''))) return true;
  return /precondition failed|already exists/i.test(String(error.message || ''));
}

function isMissingBlobError(e) {
  if (!e) return false;
  if (e.status === 404 || e.statusCode === 404 || e.code === 'ENOENT') return true;
  const name = String(e.name || '');
  if (name === 'BlobNotFoundError' || /notfound/i.test(name)) return true;
  const msg = String(e.message || e);
  // Vercel Blob throws BlobNotFoundError: "The requested blob does not exist"
  // — that does not match /not found/i, so first Connect used to 500.
  return /not found|does not exist|no such (blob|file|key|object)/i.test(msg);
}

function pickHouseholdBlob(blobs, blobPath = BLOB_PATH) {
  const base = String(blobPath || BLOB_PATH);
  const legacyLedger = /^household\/ledger(\.|-)/;
  const rows = (blobs || []).filter((b) => {
    const p = String(b && b.pathname || '');
    if (p === base) return true;
    if (base === BLOB_PATH && legacyLedger.test(p)) return true;
    if (base !== BLOB_PATH && /^household\/bridge-inbox(\.|-)/.test(p)) return true;
    return false;
  });
  if (!rows.length) return null;
  rows.sort((a, b) => {
    const size = (Number(b.size) || 0) - (Number(a.size) || 0);
    if (size) return size;
    return new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0);
  });
  return rows[0];
}

async function streamToBuffer(stream) {
  if (!stream) return null;
  if (Buffer.isBuffer(stream)) return stream;
  if (typeof stream.arrayBuffer === 'function') return Buffer.from(await stream.arrayBuffer());
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

async function readSnapshot(store) {
  try {
    return await store.read();
  } catch (e) {
    if (isMissingBlobError(e)) return null;
    throw e;
  }
}

function blobStore(token, blobPath = BLOB_PATH, blobApi) {
  const pathname = String(blobPath || BLOB_PATH);
  const listPrefix = pathname.startsWith('household/') ? 'household/' : pathname.replace(/\/[^/]+$/, '/') || 'household/';
  const api = () => blobApi || require('@vercel/blob');
  const readOpts = () => ({ token, access: 'private', useCache: false });

  async function readEntry(urlOrPath) {
    const blob = api();
    if (typeof blob.get !== 'function') return null;
    try {
      const direct = await blob.get(urlOrPath, readOpts());
      if (direct && direct.stream) {
        const buf = await streamToBuffer(direct.stream);
        if (buf && buf.length) {
          const info = direct.blob || {};
          return {
            buf,
            etag: info.etag || null,
            pathname: info.pathname || (typeof urlOrPath === 'string' ? urlOrPath : pathname),
          };
        }
      }
    } catch (e) {
      if (!isMissingBlobError(e)) throw e;
    }
    return null;
  }

  async function readMeta() {
    const blob = api();
    const direct = await readEntry(pathname);
    if (direct) return direct;
    // put() may still add a random suffix; head(pathname) then 404s even
    // after PUT 200. list() sees household/ledger-*.bin — pick the largest
    // so an empty phone upload cannot hide a populated snapshot.
    const listed = await blob.list({ prefix: listPrefix, token });
    const chosen = pickHouseholdBlob(listed && listed.blobs, pathname);
    if (!chosen) return null;
    const via = await readEntry(chosen.url || chosen.pathname);
    if (via) {
      return {
        buf: via.buf,
        etag: via.etag || chosen.etag || null,
        pathname: via.pathname || chosen.pathname || pathname,
      };
    }
    try {
      const meta = await blob.head(chosen.url || chosen.pathname, { token });
      const r = await fetch(meta.url);
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) return null;
      return {
        buf,
        etag: meta.etag || chosen.etag || null,
        pathname: meta.pathname || chosen.pathname || pathname,
      };
    } catch (e) {
      if (isMissingBlobError(e)) return null;
      throw e;
    }
  }

  return {
    async read() {
      const meta = await readMeta();
      return meta ? meta.buf : null;
    },
    /* Blob ifMatch is the store's etag, not our content hash. The handler
       still speaks If-Match as revOf(body). This method checks that hash,
       then commits with the etag so a second writer loses with 412 instead
       of overwriting. */
    async compareAndSwap(expectedRev, buf) {
      const current = await readMeta();
      const blob = api();
      if (current) {
        const currentRev = revOf(current.buf);
        if (!expectedRev || expectedRev !== currentRev) return { ok: false, rev: currentRev };
        if (!current.etag) throw Object.assign(new Error('Snapshot etag missing'), { code: 'ETAG_REQUIRED' });
        try {
          await blob.put(current.pathname || pathname, buf, {
            access: 'private',
            addRandomSuffix: false,
            allowOverwrite: true,
            ifMatch: current.etag,
            token,
            contentType: 'application/octet-stream',
          });
        } catch (e) {
          if (!isConditionalConflict(e)) throw e;
          const again = await readMeta();
          return { ok: false, rev: again ? revOf(again.buf) : null };
        }
        return { ok: true, rev: revOf(buf) };
      }
      try {
        await blob.put(pathname, buf, {
          access: 'private',
          addRandomSuffix: false,
          allowOverwrite: false,
          token,
          contentType: 'application/octet-stream',
        });
      } catch (e) {
        if (!isConditionalConflict(e)) throw e;
        const again = await readMeta();
        return { ok: false, rev: again ? revOf(again.buf) : null };
      }
      return { ok: true, rev: revOf(buf) };
    },
  };
}

function createStore(opts = {}) {
  const blobPath = opts.blobPath || BLOB_PATH;
  const inboxName = blobPath === DEFAULT_INBOX_BLOB_PATH ? 'bridge-inbox.bin' : 'ledger.bin';
  if (opts.dataDir) return fileStore(opts.dataDir, opts.fileName || inboxName);
  if (opts.blobApi || opts.blobToken || process.env.BLOB_READ_WRITE_TOKEN) {
    return blobStore(opts.blobToken || process.env.BLOB_READ_WRITE_TOKEN || '', blobPath, opts.blobApi);
  }
  if (process.env.LEDGER_SYNC_DATA_DIR) {
    return fileStore(process.env.LEDGER_SYNC_DATA_DIR, opts.fileName || inboxName);
  }
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

async function handleHouseholdBlobSync(req, res, opts = {}) {
  const expected = opts.token != null ? opts.token : process.env.HOUSEHOLD_SYNC_TOKEN;
  if (!expected) {
    send(res, 503, { error: 'SYNC_SERVER_UNAVAILABLE', message: 'HOUSEHOLD_SYNC_TOKEN is not set' });
    return;
  }
  if (!safeEqual(bearerToken(req), expected)) {
    send(res, 401, { error: 'AUTH_FAILED' });
    return;
  }

  const store = opts.store || createStore({ ...opts, blobPath: opts.blobPath || BLOB_PATH });
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
    const current = await readSnapshot(store);
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
    if (typeof store.compareAndSwap !== 'function') {
      send(res, 503, { error: 'SYNC_SERVER_UNAVAILABLE', message: 'Snapshot store cannot compare and swap' });
      return;
    }
    const ifMatch = String(req.headers['if-match'] || '').replace(/"/g, '').trim();
    let result;
    try {
      result = await store.compareAndSwap(ifMatch, body);
    } catch (e) {
      if (e && (e.code === 'LOCK_TIMEOUT' || e.code === 'ETAG_REQUIRED')) {
        send(res, 503, { error: 'SYNC_SERVER_UNAVAILABLE', message: 'Snapshot could not be updated safely' });
        return;
      }
      throw e;
    }
    if (!result || !result.ok) {
      const rev = result && result.rev;
      send(res, 409, { error: 'CONFLICT' }, rev ? { 'X-Ledger-Rev': rev, ETag: `"${rev}"` } : {});
      return;
    }
    send(res, 200, { ok: true, rev: result.rev }, { 'X-Ledger-Rev': result.rev, ETag: `"${result.rev}"` });
    return;
  }

  send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
}

async function handleHouseholdSync(req, res, opts = {}) {
  return handleHouseholdBlobSync(req, res, { ...opts, blobPath: opts.blobPath || BLOB_PATH });
}

async function handleBridgeInboxSync(req, res, opts = {}) {
  return handleHouseholdBlobSync(req, res, {
    ...opts,
    blobPath: opts.blobPath || DEFAULT_INBOX_BLOB_PATH,
    fileName: opts.fileName || 'bridge-inbox.bin',
  });
}

module.exports = {
  handleHouseholdSync,
  handleHouseholdBlobSync,
  handleBridgeInboxSync,
  createStore,
  fileStore,
  isLed1,
  revOf,
  isMissingBlobError,
  pickHouseholdBlob,
  BLOB_PATH,
  DEFAULT_INBOX_BLOB_PATH,
};
