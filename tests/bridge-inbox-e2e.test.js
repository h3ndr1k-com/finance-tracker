'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { handleBridgeInboxSync, revOf } = require('../api/household-sync');
const { encryptJson, decryptJson } = require('../lib/led1-node');
const {
  emptyInbox,
  mergeQueueIntoInbox,
  applyInboxToSnapshot,
  removeQueueIdsFromInbox,
} = require('../lib/bridge-inbox-payload');
const { createBridgeStore } = require('../bridge/ledger-bridge');
const { runInboxPush } = require('../bridge/inbox-push');

const TOKEN = 'household-test-token';
const PASS = 'test-passphrase-ledger';

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

async function callInbox(method, dir, opts = {}) {
  const req = {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) },
    body: opts.body,
    on() {},
  };
  const res = mockRes();
  await handleBridgeInboxSync(req, res, { token: TOKEN, dataDir: dir, fileName: 'bridge-inbox.bin' });
  return res;
}

function minimalSnapshot() {
  return {
    v: 2,
    settings: { base: 'CAD' },
    rates: {},
    budgets: {},
    rules: {},
    mappings: {},
    accounts: { Cash: { currency: 'CAD' } },
    jars: [{ id: 'nec', name: 'Necessities', pct: 55, ord: 0 }],
    catJar: {},
    jarMoves: [],
    jarAdjustments: [],
    subscriptions: [],
    creditCards: [],
    businesses: [],
    transactions: [],
    meta: { txTomb: {}, kv: {} },
  };
}

test('bridge inbox e2e: queue → encrypt push → pull → merge once → ack', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-inbox-e2e-'));
  const bridgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-bridge-e2e-'));
  const salt = Buffer.alloc(16, 9);

  const snap = await callInbox('PUT', dir, {
    body: encryptJson(PASS, salt, emptyInbox()),
  });
  assert.equal(snap.status, 200);

  const store = createBridgeStore(bridgeDir);
  const queued = store.enqueue({
    date: '2026-10-24',
    desc: 'Puppet show',
    amount: -10,
    currency: 'CAD',
    account: 'Cash',
    category: 'Entertainment',
    source: 'grokbot',
  });

  fs.writeFileSync(path.join(bridgeDir, 'household-token'), `${TOKEN}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(bridgeDir, 'sync-passphrase'), `${PASS}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(bridgeDir, 'sync-salt.b64'), `${salt.toString('base64')}\n`, { mode: 0o600 });

  let serverPort;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/bridge-inbox') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const mockReq = {
        method: req.method,
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v])),
        body: body.length ? body : undefined,
        on() {},
      };
      const mock = mockRes();
      await handleBridgeInboxSync(mockReq, mock, { token: TOKEN, dataDir: dir, fileName: 'bridge-inbox.bin' });
      res.writeHead(mock.status, mock.headers);
      res.end(mock.body);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverPort = server.address().port;
  t.after(() => server.close());

  const origin = `http://127.0.0.1:${serverPort}`;
  fs.writeFileSync(path.join(bridgeDir, 'inbox-push.json'), JSON.stringify({
    syncOrigin: origin,
    inboxUrl: `${origin}/api/bridge-inbox`,
    snapshotUrl: `${origin}/api/sync`,
  }, null, 2) + '\n', { mode: 0o600 });

  const push = await runInboxPush({
    dir: bridgeDir,
    householdToken: TOKEN,
    passphrase: PASS,
    salt,
  });
  assert.equal(push.pushed, 1);
  assert.deepEqual(push.queueIds, [queued.id]);
  assert.equal(store.pending().length, 0);

  const downloaded = await callInbox('GET', dir);
  assert.equal(downloaded.status, 200);
  const { json: inboxDoc } = decryptJson(PASS, downloaded.body);
  assert.equal(inboxDoc.items.length, 1);
  assert.equal(inboxDoc.items[0].queueId, queued.id);
  assert.equal(inboxDoc.items[0].source, 'grokbot');

  let ledgerSnap = minimalSnapshot();
  const firstApply = applyInboxToSnapshot(ledgerSnap, inboxDoc, { baseCurrency: 'CAD' });
  assert.equal(firstApply.appliedQueueIds.length, 1);
  assert.equal(firstApply.snap.transactions[0].id, `bridge:${queued.id}`);
  assert.equal(firstApply.snap.transactions[0].desc, 'Puppet show');
  ledgerSnap = firstApply.snap;

  const secondApply = applyInboxToSnapshot(ledgerSnap, inboxDoc, { baseCurrency: 'CAD' });
  assert.equal(secondApply.appliedQueueIds.length, 0);
  assert.equal(secondApply.skippedQueueIds.length, 1);

  const ackedInbox = removeQueueIdsFromInbox(inboxDoc, [...firstApply.appliedQueueIds, ...secondApply.skippedQueueIds]);
  assert.equal(ackedInbox.items.length, 0);

  const rev = revOf(downloaded.body);
  const putAck = await callInbox('PUT', dir, {
    headers: { 'if-match': rev },
    body: encryptJson(PASS, salt, ackedInbox),
  });
  assert.equal(putAck.status, 200);

  const afterAck = await callInbox('GET', dir);
  const { json: emptyDoc } = decryptJson(PASS, afterAck.body);
  assert.equal(emptyDoc.items.length, 0);
});

test('mergeQueueIntoInbox is idempotent for the same queue id', () => {
  const inbox = emptyInbox();
  const item = { id: 'abc', date: '2026-10-01', desc: 'Coffee', amount: -3, currency: 'CAD', account: 'Cash', category: 'Dining' };
  const first = mergeQueueIntoInbox(inbox, [item]);
  assert.deepEqual(first.addedQueueIds, ['abc']);
  const second = mergeQueueIntoInbox(first.inbox, [item]);
  assert.deepEqual(second.addedQueueIds, []);
});
