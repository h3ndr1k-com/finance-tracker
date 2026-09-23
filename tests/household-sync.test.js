'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { handleHouseholdSync, isLed1, revOf, isMissingBlobError } = require('../api/household-sync');

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
