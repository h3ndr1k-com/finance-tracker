const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { startStaticServer, root } = require('./static-server');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  assert(fs.existsSync(path.join(root, 'sw.js')), 'sw.js missing');
  const swSource = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert(/const CACHE = 'ledger-v\d+'/.test(swSource), 'service worker cache version missing');
  assert(!swSource.includes('127.0.0.1:7453'), 'sw.js must not call localhost ingest');
  assert(!/Unexpected token/.test(swSource), 'sw.js source looks broken');

  const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert(!indexSource.includes('127.0.0.1:7453'), 'index.html must not call localhost ingest');
  const appFeelJs = fs.existsSync(path.join(root, 'app-feel.js'))
    ? fs.readFileSync(path.join(root, 'app-feel.js'), 'utf8') : '';
  const appFeelCss = fs.existsSync(path.join(root, 'app-feel.css'))
    ? fs.readFileSync(path.join(root, 'app-feel.css'), 'utf8') : '';
  const viewportLocked = (/maximum-scale=1/.test(indexSource) && /user-scalable=no/.test(indexSource))
    || (/maximum-scale=1/.test(swSource) && /user-scalable=no/.test(swSource))
    || (/maximum-scale=1/.test(appFeelJs) && /user-scalable=no/.test(appFeelJs));
  assert(viewportLocked, 'viewport must lock pinch-zoom in HTML, SW rewrite, or app-feel.js');
  assert(/viewport-fit=cover/.test(indexSource) || /viewport-fit=cover/.test(swSource) || /viewport-fit=cover/.test(appFeelJs), 'viewport must include safe-area cover');
  assert(/gesturestart/.test(indexSource) || /gesturestart/.test(appFeelJs), 'iOS pinch gesture must be cancelled');
  assert(/overflow-x:\s*hidden/.test(indexSource) || /overflow-x:\s*hidden/.test(appFeelCss), 'horizontal overflow must be clipped');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  assert(manifest.display === 'standalone', 'PWA must install as standalone');
  assert(!fs.readFileSync(path.join(root, 'sync.js'), 'utf8').includes('127.0.0.1:7453'), 'sync.js must not call localhost ingest');

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

  const viewportMeta = await page.locator('meta[name="viewport"]').getAttribute('content');
  assert(/maximum-scale=1/.test(viewportMeta || '') && /user-scalable=no/.test(viewportMeta || ''), 'Live viewport still allows pinch-zoom');
  const layoutBleed = await page.evaluate(() => {
    const root = document.scrollingElement || document.documentElement;
    return {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      overflowX: getComputedStyle(document.documentElement).overflowX,
    };
  });
  assert(layoutBleed.scrollWidth <= layoutBleed.clientWidth + 1, `Horizontal overflow ${layoutBleed.scrollWidth} > ${layoutBleed.clientWidth}`);
  assert(layoutBleed.overflowX === 'hidden', 'html overflow-x must be hidden');

  assert(await page.locator('nav.tabbar').isVisible(), 'Mobile tab bar not visible');
  const tabbarBefore = await page.locator('nav.tabbar').boundingBox();
  await page.evaluate(() => {
    const rootEl = document.getElementById('scroll-root');
    if (rootEl) rootEl.scrollTop = rootEl.scrollHeight;
    else window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitForTimeout(200);
  const tabbarAfterScroll = await page.locator('nav.tabbar').boundingBox();
  assert(tabbarBefore && tabbarAfterScroll, 'Tab bar bounding box missing');
  assert(Math.abs(tabbarBefore.y - tabbarAfterScroll.y) < 0.5, 'Tab bar moved while scrolling');

  await page.setViewportSize({ width: 390, height: 540 });
  await page.locator('#fSearch').focus();
  await page.waitForTimeout(250);
  const tabbarAfterKeyboard = await page.locator('nav.tabbar').boundingBox();
  const shellBox = await page.locator('#app-shell').boundingBox();
  assert(tabbarAfterKeyboard && shellBox, 'Keyboard viewport boxes missing');
  assert(tabbarAfterKeyboard.y + tabbarAfterKeyboard.height <= shellBox.y + shellBox.height + 1, 'Tab bar escaped the app shell after keyboard shrink');
  assert(Math.abs((tabbarAfterKeyboard.y + tabbarAfterKeyboard.height) - (shellBox.y + shellBox.height)) < 8, 'Tab bar not at the bottom of the shell after keyboard shrink');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#settingsBtn').click();
  await page.waitForTimeout(300);
  assert(await page.locator('#syncDiagHeading').isVisible(), 'Sync diagnostics section missing');
  const diagText = await page.locator('.sync-diagnostics').innerText();
  assert(/Household token/i.test(diagText) && /Configured|Not set/i.test(diagText), 'Household token diagnostic line missing');
  assert(/Sync bus/i.test(diagText), 'Sync bus diagnostic line missing');
  assert(!/pk\.[a-z0-9_-]{10,}/i.test(diagText), 'Diagnostics must not show an app key value');
  assert(!/ledger_[a-f0-9]{16,}/i.test(diagText), 'Diagnostics must not show a household token');
  assert(/Next step/i.test(diagText), 'Diagnostics must show a next step');
  assert(await page.locator('#syHouseholdToken').getAttribute('value') === '', 'Household token input must not echo a saved token');
  assert(await page.locator('#syConnect').innerText().then((t) => /household/i.test(t)), 'Connect household button missing');

  const apiNoAuth = await page.evaluate(async () => {
    const r = await fetch('./api/sync', { cache: 'no-store' });
    return r.status;
  });
  assert(apiNoAuth === 401, `Household API without token should be 401, got ${apiNoAuth}`);

  assert(errors.length === 0, `Page errors: ${errors.join(' | ')}`);

  await browser.close();
  if (server) server.close();
  console.log(`PWA/sync regression passed (SW ${swEval.cache}, mobile tab bar stable, sync diagnostics visible).`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
