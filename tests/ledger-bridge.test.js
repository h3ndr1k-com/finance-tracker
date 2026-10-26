'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createBridgeStore, createBridgeServer } = require('../bridge/ledger-bridge');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-bridge-'));
}

async function start(dir) {
  const server = createBridgeServer({ dir, token: 'test-token', origins: ['https://ledger-tracker-psi.vercel.app'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function request(base, route, options = {}) {
  return fetch(base + route, {
    ...options,
    headers: {
      origin: 'https://ledger-tracker-psi.vercel.app',
      ...(options.headers || {}),
    },
  });
}

test('enqueue persists a validated Telegram transaction and pending returns it only with the bridge key', () => {
  const store = createBridgeStore(tempDir());
  const item = store.enqueue({ date: '2026-10-01', desc: 'Maxi groceries', amount: -82.45, currency: 'CAD', account: 'Amex', category: 'Groceries' });
  assert.match(item.id, /^[a-f0-9-]{36}$/);
  assert.equal(item.source, 'telegram');
  assert.equal(store.pending().length, 1);
  assert.throws(() => store.enqueue({ date: 'bad-date', desc: '', amount: 0 }), /date|description|amount/i);
});

test('enqueue accepts --source grokbot via item.source', () => {
  const store = createBridgeStore(tempDir());
  const item = store.enqueue({
    date: '2026-10-24', desc: 'Puppet show', amount: -10, currency: 'CAD', account: 'Cash', category: 'Fun', source: 'grokbot',
  });
  assert.equal(item.source, 'grokbot');
});

test('HTTP bridge rejects other origins and invalid keys, then acknowledges only the requested item', async (t) => {
  const dir = tempDir();
  const store = createBridgeStore(dir);
  const first = store.enqueue({ date: '2026-10-01', desc: 'Tim Hortons', amount: -4.25, currency: 'CAD', account: 'Cash', category: 'Dining' });
  const second = store.enqueue({ date: '2026-10-01', desc: 'Paycheque', amount: 900, currency: 'CAD', account: 'Chequing', category: 'Income' });
  const { server, base } = await start(dir);
  t.after(() => server.close());

  const deniedOrigin = await fetch(base + '/v1/transactions', { headers: { origin: 'https://evil.example', 'x-ledger-bridge-key': 'test-token' } });
  assert.equal(deniedOrigin.status, 403);

  const deniedKey = await request(base, '/v1/transactions', { headers: { 'x-ledger-bridge-key': 'wrong' } });
  assert.equal(deniedKey.status, 401);

  const pending = await request(base, '/v1/transactions', { headers: { 'x-ledger-bridge-key': 'test-token' } });
  assert.equal(pending.status, 200);
  assert.deepEqual((await pending.json()).items.map((item) => item.id), [first.id, second.id]);

  const pair = await request(base, '/v1/pair', { method: 'POST', headers: { 'content-type': 'application/json' } });
  assert.equal(pair.status, 200);
  assert.equal((await pair.json()).token, 'test-token');

  const ack = await request(base, '/v1/ack', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ledger-bridge-key': 'test-token' },
    body: JSON.stringify({ ids: [first.id] }),
  });
  assert.equal(ack.status, 200);
  assert.deepEqual((await ack.json()).acknowledged, [first.id]);
  assert.deepEqual(store.pending().map((item) => item.id), [second.id]);
});

test('a missing queue is empty, and a corrupt queue is left untouched', () => {
  const missing = createBridgeStore(tempDir());
  assert.deepEqual(missing.pending(), []);

  const dir = tempDir();
  const file = path.join(dir, 'queue.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, '{');
  const store = createBridgeStore(dir);
  assert.throws(() => store.pending(), /corrupt/i);
  assert.throws(() => store.enqueue({ date: '2026-10-01', desc: 'Should not replace', amount: -1, currency: 'CAD', account: 'Cash', category: 'Other' }), /corrupt/i);
  assert.equal(fs.readFileSync(file, 'utf8'), '{');
});

test('an unreadable queue is not replaced with an empty one', () => {
  const dir = tempDir();
  const store = createBridgeStore(dir);
  store.enqueue({ date: '2026-10-01', desc: 'Keep me', amount: -3, currency: 'CAD', account: 'Cash', category: 'Other' });
  fs.chmodSync(store.queueFile, 0);
  try {
    assert.throws(() => store.enqueue({ date: '2026-10-01', desc: 'Overwrite', amount: -4, currency: 'CAD', account: 'Cash', category: 'Other' }));
  } finally {
    fs.chmodSync(store.queueFile, 0o600);
  }
  const text = fs.readFileSync(store.queueFile, 'utf8');
  assert.match(text, /Keep me/);
  assert.doesNotMatch(text, /Overwrite/);
});

test('concurrent enqueue and acknowledge do not drop transactions', async () => {
  const dir = tempDir();
  const store = createBridgeStore(dir);
  const seed = store.enqueue({ date: '2026-10-01', desc: 'seed', amount: -1, currency: 'CAD', account: 'Cash', category: 'Other' });
  const bridge = require.resolve('../bridge/ledger-bridge.js');
  const script = `
    const { createBridgeStore } = require(${JSON.stringify(bridge)});
    const queue = createBridgeStore(process.argv[1]);
    if (process.argv[2] === 'enqueue') {
      const item = queue.enqueue({ date: '2026-10-01', desc: process.argv[3], amount: -2, currency: 'CAD', account: 'Cash', category: 'Other' });
      process.stdout.write(item.id);
    } else {
      process.stdout.write(JSON.stringify(queue.acknowledge([process.argv[3]])));
    }
  `;
  const run = (args) => new Promise((resolve, reject) => {
    const child = require('child_process').spawn(process.execPath, ['-e', script, ...args]);
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))));
  });
  await Promise.all([
    ...Array.from({ length: 8 }, (_, i) => run([dir, 'enqueue', `item-${i}`])),
    run([dir, 'ack', seed.id]),
  ]);
  const doc = JSON.parse(fs.readFileSync(store.queueFile, 'utf8'));
  assert.equal(doc.items.length, 9);
  assert.equal(doc.items.filter((item) => item.id === seed.id && item.acknowledgedAt).length, 1);
  assert.deepEqual(store.pending().map((item) => item.desc).sort(), Array.from({ length: 8 }, (_, i) => `item-${i}`).sort());
});
