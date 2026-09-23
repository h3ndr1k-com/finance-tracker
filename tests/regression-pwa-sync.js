const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

const root = path.join(__dirname, '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function startStaticServer(preferredPort = 4173) {
  const mime = {
    '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
    '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.css': 'text/css',
    '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.gz': 'application/gzip',
  };
  const handler = (req, res, port) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    let filePath = path.join(root, decodeURIComponent(url.pathname));
    if (url.pathname.endsWith('/')) filePath = path.join(root, 'index.html');
    if (!filePath.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      res.end(data);
    });
  };
  const tryPort = (port) => new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => handler(req, res, port));
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && port < preferredPort + 6) resolve(tryPort(port + 1));
      else reject(err);
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, port }));
  });
  return tryPort(preferredPort);
}

(async () => {
  assert(fs.existsSync(path.join(root, 'sw.js')), 'sw.js missing');
  const swSource = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert(/const CACHE = 'ledger-v\d+'/.test(swSource), 'service worker cache version missing');
  // Node syntax check (importScripts is fine in SW runtime only).
  assert(!/\n\}\s*\n\s*\}/.test(swSource.slice(0, 4000)), 'sw.js may have a stray brace near the fetch handler');

  let server = null;
  let baseURL = process.env.LEDGER_QA_URL;
  if (!baseURL) {
    const started = await startStaticServer(Number(process.env.LEDGER_QA_PORT || 4173));
    server = started.server;
    baseURL = `http://127.0.0.1:${started.port}/`;
  } else if (!baseURL.endsWith('/')) baseURL += '/';

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(baseURL, { waitUntil: 'networkidle' });

  const swEval = await page.evaluate(async () => {
    const r = await fetch('./sw.js', { cache: 'no-store' });
    const text = await r.text();
    try {
      const body = text.replace(/^importScripts\([^)]+\);\s*/m, '');
      // eslint-disable-next-line no-new-func
      new Function(body);
      return { ok: true, cache: (text.match(/const CACHE = '([^']+)'/) || [])[1] || null };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  assert(swEval.ok, `sw.js failed in-page parse: ${swEval.error}`);
  assert(swEval.cache, 'Could not read CACHE from sw.js');

  const regInfo = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.register('./sw.js');
    await reg.update().catch(() => {});
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, rej) => setTimeout(() => rej(new Error('SW ready timeout')), 8000)),
    ]);
    return {
      controller: !!navigator.serviceWorker.controller,
      waiting: !!reg.waiting,
      active: reg.active?.scriptURL || null,
    };
  });
  assert(regInfo.active, 'Service worker did not activate');

  await page.reload({ waitUntil: 'networkidle' });
  assert(await page.evaluate(() => !!navigator.serviceWorker.controller), 'Refreshed page has no SW controller');

  await page.evaluate(async () => {
    if (typeof getServiceWorkerDiagnostics !== 'function') throw new Error('getServiceWorkerDiagnostics missing');
    const d = await getServiceWorkerDiagnostics();
    if (!d.supported || !d.cacheVersion) throw new Error('SW diagnostics incomplete');
  });

  assert(await page.locator('nav.tabbar').isVisible(), 'Mobile tab bar not visible');
  const tabbarBefore = await page.locator('nav.tabbar').boundingBox();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(200);
  const tabbarAfterScroll = await page.locator('nav.tabbar').boundingBox();
  assert(tabbarBefore && tabbarAfterScroll, 'Tab bar bounding box missing');
  assert(Math.abs(tabbarBefore.y - tabbarAfterScroll.y) < 0.5, 'Tab bar moved while scrolling');

  await page.locator('#fSearch').focus();
  await page.waitForTimeout(250);
  const tabbarAfterKeyboard = await page.locator('nav.tabbar').boundingBox();
  assert(tabbarAfterKeyboard && Math.abs(tabbarBefore.y - tabbarAfterKeyboard.y) < 2, 'Tab bar shifted after keyboard focus');

  await page.locator('#settingsBtn').click();
  await page.waitForTimeout(300);
  assert(await page.locator('#syncDiagHeading').isVisible(), 'Sync diagnostics section missing');
  const diagText = await page.locator('.sync-diagnostics').innerText();
  assert(/App key/i.test(diagText) && /Configured|Not set/i.test(diagText), 'App key diagnostic line missing');
  assert(!/pk\.[a-z0-9_-]{10,}/i.test(diagText), 'Diagnostics must not show an app key value');

  assert(errors.length === 0, `Page errors: ${errors.join(' | ')}`);

  await browser.close();
  if (server) server.close();
  console.log(`PWA/sync regression passed (SW ${swEval.cache}, mobile tab bar stable, sync diagnostics visible).`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
