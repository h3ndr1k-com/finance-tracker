'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { handleHouseholdSync, isLed1, revOf, isMissingBlobError, pickHouseholdBlob, fileStore, createStore, BLOB_PATH } = require('../api/household-sync');

function fakeLed1(fill = 7) {
  const buf = Buffer.alloc(48);
  buf.write('LED1', 0);
  buf[4] = 1;
  buf.fill(fill, 5);
  return buf;
}

function mockRes() {
  return {
    status: 0,
    headers: {},
    body: null,
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = { ...this.headers, ...(headers || {}) };
    },
    setHeader(k, v) { this.headers[k] = v; },
    end(body) {
      this.headersSent = true;
      this.body = body == null ? null : body;
    },
  };
}

async function call(method, opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-sync-'));
  const req = {
    method,
    headers: { ...(opts.headers || {}) },
    body: opts.body,
    on() {},
  };
  const res = mockRes();
  await handleHouseholdSync(req, res, { token: opts.token || 'secret-token', dataDir: dir, store: opts.store });
  return { res, dir };
}

test('LED1 detector accepts a real header and rejects plaintext', () => {
  assert.equal(isLed1(fakeLed1()), true);
  assert.equal(isLed1(Buffer.from('{"txs":[]}')), false);
});

test('missing or wrong bearer is 401 and does not create a file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-sync-'));
  const missing = await call('GET', { dir, headers: {} });
  assert.equal(missing.res.status, 401);
  const wrong = await call('GET', { dir, headers: { authorization: 'Bearer nope' } });
  assert.equal(wrong.res.status, 401);
  assert.equal(fs.existsSync(path.join(dir, 'ledger.bin')), false);
});

test('GET is 404 until a LED1 snapshot is PUT, then returns the same bytes and rev', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-sync-'));
  const empty = await call('GET', { dir, headers: { authorization: 'Bearer secret-token' } });
  assert.equal(empty.res.status, 404);

  const bytes = fakeLed1(9);
  const put = await call('PUT', { dir, headers: { authorization: 'Bearer secret-token' }, body: bytes });
  assert.equal(put.res.status, 200);
  assert.equal(put.res.headers['X-Ledger-Rev'], revOf(bytes));

  const got = await call('GET', { dir, headers: { authorization: 'Bearer secret-token' } });
  assert.equal(got.res.status, 200);
  assert.ok(Buffer.isBuffer(got.res.body));
  assert.equal(Buffer.compare(got.res.body, bytes), 0);
  assert.equal(got.res.headers['X-Ledger-Rev'], revOf(bytes));
});

test('stale If-Match is 409; matching rev overwrites', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-sync-'));
  const first = fakeLed1(1);
  await call('PUT', { dir, headers: { authorization: 'Bearer secret-token' }, body: first });

  const stale = await call('PUT', {
    dir,
    headers: { authorization: 'Bearer secret-token', 'if-match': 'deadbeef' },
    body: fakeLed1(2),
  });
  assert.equal(stale.res.status, 409);

  const second = fakeLed1(3);
  const ok = await call('PUT', {
    dir,
    headers: { authorization: 'Bearer secret-token', 'if-match': revOf(first) },
    body: second,
  });
  assert.equal(ok.res.status, 200);
  const got = await call('GET', { dir, headers: { authorization: 'Bearer secret-token' } });
  assert.equal(Buffer.compare(got.res.body, second), 0);
});

test('plaintext PUT is rejected so the host cannot be used as a dump', async () => {
  const put = await call('PUT', {
    headers: { authorization: 'Bearer secret-token' },
    body: Buffer.from(JSON.stringify({ transactions: [] })),
  });
  assert.equal(put.res.status, 400);
});

test('household blob picker prefers the largest LED1 so an empty phone PUT cannot hide data', () => {
  const picked = pickHouseholdBlob([
    { pathname: 'household/ledger-aaaa.bin', size: 80, uploadedAt: '2026-09-23T19:38:41Z' },
    { pathname: 'household/ledger.bin', size: 4200, uploadedAt: '2026-09-23T19:34:23Z' },
    { pathname: 'other/file.bin', size: 99999, uploadedAt: '2026-09-23T20:00:00Z' },
  ]);
  assert.equal(picked.pathname, 'household/ledger.bin');
  assert.equal(pickHouseholdBlob([]), null);
});

test('empty Vercel blob (does not exist) is 404, not 500', async () => {
  const missing = Object.assign(new Error('The requested blob does not exist'), { name: 'BlobNotFoundError' });
  assert.equal(isMissingBlobError(missing), true);
  assert.equal(isMissingBlobError(new Error('something else exploded')), false);
  const store = {
    async read() { throw missing; },
    async write() { throw new Error('write should not run'); },
  };
  const got = await call('GET', { store, headers: { authorization: 'Bearer secret-token' } });
  assert.equal(got.res.status, 404);
  const body = JSON.parse(String(got.res.body));
  assert.equal(body.error, 'NOT_FOUND');
});

test('unconfigured server is 503 without leaking the expected token', async () => {
  const req = { method: 'GET', headers: { authorization: 'Bearer anything' }, body: null, on() {} };
  const res = mockRes();
  await handleHouseholdSync(req, res, { token: '', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-sync-')) });
  assert.equal(res.status, 503);
  assert.doesNotMatch(String(res.body), /ledger_/);
});

test('simultaneous If-Match writes on the file store: one wins and the other conflicts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-sync-'));
  const store = fileStore(dir, 'ledger.bin', { pauseMs: 40 });
  const first = fakeLed1(1);
  const seeded = await call('PUT', { dir, store, headers: { authorization: 'Bearer secret-token' }, body: first });
  assert.equal(seeded.res.status, 200);

  const headers = { authorization: 'Bearer secret-token', 'if-match': revOf(first) };
  const [left, right] = await Promise.all([
    call('PUT', { dir, store, headers, body: fakeLed1(2) }),
    call('PUT', { dir, store, headers, body: fakeLed1(3) }),
  ]);
  const statuses = [left.res.status, right.res.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const winner = left.res.status === 200 ? fakeLed1(2) : fakeLed1(3);
  const got = await call('GET', { dir, store, headers: { authorization: 'Bearer secret-token' } });
  assert.equal(Buffer.compare(got.res.body, winner), 0);
});

test('simultaneous blob writes use etag compare-and-swap', async () => {
  let current = null;
  const puts = [];
  const blobApi = {
    async get() {
      if (!current) {
        const missing = new Error('The requested blob does not exist');
        missing.name = 'BlobNotFoundError';
        throw missing;
      }
      return { stream: current.buf, blob: { etag: current.etag, pathname: 'household/ledger.bin' } };
    },
    async list() { return { blobs: [] }; },
    async put(_pathname, buf, opts) {
      puts.push(opts);
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (opts.allowOverwrite === false && current) {
        const err = new Error('already exists');
        err.statusCode = 409;
        throw err;
      }
      if (opts.ifMatch && (!current || opts.ifMatch !== current.etag)) {
        const err = new Error('precondition failed');
        err.name = 'BlobPreconditionFailedError';
        err.statusCode = 412;
        throw err;
      }
      current = { buf: Buffer.from(buf), etag: `etag-${buf[5]}` };
    },
  };
  const store = createStore({ blobToken: 'blob-token', blobApi, blobPath: BLOB_PATH });
  const first = fakeLed1(4);
  const seeded = await call('PUT', { store, headers: { authorization: 'Bearer secret-token' }, body: first });
  assert.equal(seeded.res.status, 200);
  assert.equal(puts[0].allowOverwrite, false);

  const headers = { authorization: 'Bearer secret-token', 'if-match': revOf(first) };
  const [left, right] = await Promise.all([
    call('PUT', { store, headers, body: fakeLed1(5) }),
    call('PUT', { store, headers, body: fakeLed1(6) }),
  ]);
  assert.deepEqual([left.res.status, right.res.status].sort(), [200, 409]);
  assert.equal(puts.filter((opts) => opts.ifMatch === 'etag-4').length, 2);
  const winner = left.res.status === 200 ? fakeLed1(5) : fakeLed1(6);
  const got = await call('GET', { store, headers: { authorization: 'Bearer secret-token' } });
  assert.equal(Buffer.compare(got.res.body, winner), 0);
});
