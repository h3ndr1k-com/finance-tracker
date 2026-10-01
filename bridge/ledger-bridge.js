'use strict';

/*
 * Local-only handoff between Hermes and Ledger's browser IndexedDB.
 * Hermes appends validated transactions to this queue. Ledger fetches them from
 * loopback, writes its own IndexedDB, then acknowledges each successful item.
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const DEFAULT_DIR = process.env.LEDGER_BRIDGE_DIR || path.join(os.homedir(), '.hermes', 'finance-bridge');
const DEFAULT_ORIGINS = ['https://ledger-tracker-psi.vercel.app'];
const MAX_BODY_BYTES = 64 * 1024;

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)); }
function normalizeTransaction(raw) {
  const date = String(raw?.date || '');
  const desc = String(raw?.desc || '').trim().slice(0, 120);
  const amount = Number(raw?.amount);
  const currency = String(raw?.currency || 'CAD').trim().toUpperCase();
  const account = String(raw?.account || 'Unassigned').trim().slice(0, 80);
  const category = String(raw?.category || 'Other').trim().slice(0, 80);
  const business = String(raw?.business || '').trim().slice(0, 80);
  if (!validDate(date)) throw new Error('A real YYYY-MM-DD date is required');
  if (!desc) throw new Error('A description is required');
  if (!Number.isFinite(amount) || amount === 0) throw new Error('A non-zero amount is required');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Currency must be a three-letter code');
  if (!account) throw new Error('An account is required');
  return { date, desc, amount: Math.round(amount * 100) / 100, currency, account, category: category || 'Other', business, transfer: Boolean(raw?.transfer) };
}

function createBridgeStore(dir = DEFAULT_DIR) {
  const queueFile = path.join(dir, 'queue.json');
  const load = () => readJson(queueFile, { version: 1, items: [] });
  const save = (doc) => writeJson(queueFile, doc);
  return {
    dir,
    queueFile,
    enqueue(raw) {
      const transaction = normalizeTransaction(raw);
      const doc = load();
      const item = { id: crypto.randomUUID(), ...transaction, source: 'telegram', createdAt: new Date().toISOString() };
      doc.items.push(item);
      save(doc);
      return item;
    },
    pending() { return load().items.filter((item) => !item.acknowledgedAt); },
    acknowledge(ids) {
      const wanted = new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string'));
      if (!wanted.size) return [];
      const doc = load(); const now = new Date().toISOString(); const done = [];
      for (const item of doc.items) {
        if (wanted.has(item.id) && !item.acknowledgedAt) { item.acknowledgedAt = now; done.push(item.id); }
      }
      save(doc);
      return done;
    },
  };
}

function loadOrCreateConfig(dir = DEFAULT_DIR) {
  const file = path.join(dir, 'config.json');
  const current = readJson(file, null);
  if (current?.token && Array.isArray(current.origins)) return current;
  const config = { token: crypto.randomBytes(32).toString('base64url'), origins: DEFAULT_ORIGINS };
  writeJson(file, config);
  return config;
}
function isAllowedOrigin(origin, configuredOrigins) {
  if (!origin) return false;
  if ((configuredOrigins || []).includes(origin)) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  } catch { return false; }
}
function send(res, status, body, origin) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (origin) { headers['access-control-allow-origin'] = origin; headers.vary = 'Origin'; }
  res.writeHead(status, headers); res.end(JSON.stringify(body));
}
async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new Error('Invalid JSON'); }
}
function createBridgeServer({ dir = DEFAULT_DIR, token, origins = DEFAULT_ORIGINS } = {}) {
  const store = createBridgeStore(dir);
  const expectedToken = token || loadOrCreateConfig(dir).token;
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin, origins)) return send(res, 403, { error: 'Origin not allowed' });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-ledger-bridge-key', 'access-control-max-age': '600' });
      return res.end();
    }
    if (req.headers['x-ledger-bridge-key'] !== expectedToken) return send(res, 401, { error: 'Invalid bridge key' }, origin);
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && pathname === '/v1/health') return send(res, 200, { ok: true }, origin);
    if (req.method === 'GET' && pathname === '/v1/transactions') return send(res, 200, { items: store.pending() }, origin);
    if (req.method === 'POST' && pathname === '/v1/ack') {
      try { return send(res, 200, { acknowledged: store.acknowledge((await readBody(req)).ids) }, origin); }
      catch (error) { return send(res, 400, { error: error.message }, origin); }
    }
    return send(res, 404, { error: 'Not found' }, origin);
  });
}
function parseArgs(args) {
  const out = {}; for (let i = 0; i < args.length; i += 2) if (args[i].startsWith('--')) out[args[i].slice(2)] = args[i + 1]; return out;
}
async function main() {
  const [command, ...args] = process.argv.slice(2); const opts = parseArgs(args); const dir = opts.dir || DEFAULT_DIR;
  if (command === 'serve') {
    const config = loadOrCreateConfig(dir); const port = Number(opts.port || 8788);
    const server = createBridgeServer({ dir, token: config.token, origins: config.origins });
    server.listen(port, '127.0.0.1', () => console.log(`Ledger bridge listening on 127.0.0.1:${port}`));
    return;
  }
  if (command === 'enqueue') {
    const item = createBridgeStore(dir).enqueue({ date: opts.date, desc: opts.desc, amount: opts.amount, currency: opts.currency, account: opts.account, category: opts.category, business: opts.business, transfer: opts.transfer === 'true' });
    console.log(JSON.stringify({ queued: item.id, desc: item.desc, amount: item.amount, currency: item.currency }));
    return;
  }
  console.error('Usage: ledger-bridge.js serve [--port 8788] | enqueue --date YYYY-MM-DD --desc TEXT --amount SIGNED --currency CAD --account NAME --category NAME');
  process.exitCode = 2;
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { createBridgeStore, createBridgeServer, loadOrCreateConfig, normalizeTransaction };
