const { chromium, firefox, webkit } = require('playwright');
const fs = require('fs');
const path = require('path');

const baseURL = process.env.LEDGER_QA_URL || 'http://127.0.0.1:4173';
const browserName = process.env.LEDGER_QA_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
const outputDir = path.join(__dirname, '..', 'design-assets', 'mockups');
fs.mkdirSync(outputDir, { recursive: true });
assert(browserType, `Unsupported browser: ${browserName}`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function stable(before, after, label) {
  const drift = Math.max(
    Math.abs(before.x - after.x),
    Math.abs(before.y - after.y),
    Math.abs(before.width - after.width),
    Math.abs(before.height - after.height)
  );
  assert(drift < 0.25, `${label} moved ${drift.toFixed(2)}px on hover`);
}

(async () => {
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  const errors = [];
  const notFoundUrls = [];
  let navigations = 0;
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => { if (response.status() === 404) notFoundUrls.push(response.url()); });
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });
  page.on('dialog', (dialog) => dialog.accept());

  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const rows = [
      { id: 'qa-tx-1', date: '2026-05-01', desc: 'Payroll - QA Corp', amount: 4200, currency: 'CAD', account: 'Chequing', source: 'qa', category: 'Income' },
      { id: 'qa-tx-2', date: '2026-05-03', desc: 'Loblaws Market', amount: -142.18, currency: 'CAD', account: 'Amex', source: 'qa', category: 'Groceries' },
      { id: 'qa-tx-3', date: '2026-06-03', desc: 'Loblaws Market', amount: -96.4, currency: 'CAD', account: 'Amex', source: 'qa', category: 'Groceries' },
      { id: 'qa-tx-4', date: '2026-07-03', desc: 'Loblaws Market', amount: -178.55, currency: 'CAD', account: 'Amex', source: 'qa', category: 'Groceries' },
      { id: 'qa-tx-5', date: '2026-07-06', desc: 'Netflix', amount: -18.99, currency: 'CAD', account: 'Amex', source: 'qa', category: 'Subscriptions' },
      { id: 'qa-tx-6', date: '2026-06-06', desc: 'Netflix', amount: -16.49, currency: 'CAD', account: 'Amex', source: 'qa', category: 'Subscriptions' },
    ];
    for (let i = 7; i <= 30; i++) rows.push({ id: 'qa-tx-' + i, date: '2026-0' + (1 + (i % 7)) + '-1' + (i % 9), desc: 'Merchant ' + i, amount: -(i * 7.5), currency: 'CAD', account: i % 2 ? 'Amex' : 'Chequing', source: 'qa', category: 'Groceries' });
    S.accounts = { Chequing: { currency: 'CAD' }, Amex: { currency: 'CAD' } };
    S.subscriptions = [{ id: 'qa-sub-1', name: 'Rent', amount: 1800, currency: 'CAD', period: 'monthly', date: '2026-08-01', category: 'Housing', business: '', account: 'Chequing', jar: '', source: 'manual' }];
    S.creditCards = [{ id: 'qa-cc-1', name: 'Amex Gold', balance: 4200, apr: 19.99, payment: 250, currency: 'CAD', account: 'Amex' }];
    await DB.putTx(rows);
    S.tx = rows; S.txIds = new Set(rows.map(t => t.id));
    await DB.kvSet('accounts', S.accounts);
    await DB.kvSet('subscriptions', S.subscriptions);
    await DB.kvSet('creditCards', S.creditCards);
    renderAll();
  });
  await page.waitForTimeout(900);
  assert(await page.locator('#view-overview .hero .big').isVisible(), 'Populated overview did not render');

  const navBeforeHover = navigations;
  for (const target of ['.hero', '.kpi-row .card', 'nav.topnav button:nth-child(2)', '#overviewScanBtn']) {
    const item = page.locator(target).first();
    const before = await item.boundingBox();
    await item.hover();
    await page.waitForTimeout(260);
    const after = await item.boundingBox();
    stable(before, after, target);
  }
  assert(navigations === navBeforeHover, 'Hover triggered a document navigation');
  await page.waitForFunction(() => !document.querySelector('#toast').classList.contains('show'));

  await page.screenshot({ path: path.join(outputDir, 'overview-dark-desktop.png') });
  await page.getByRole('button', { name: 'Use light theme' }).click();
  await page.waitForTimeout(260);
  await page.screenshot({ path: path.join(outputDir, 'overview-light-desktop.png') });

  await page.getByRole('button', { name: 'Transactions', exact: true }).click();
  await page.waitForTimeout(700);
  assert(await page.locator('#txTable .list-row').count() > 20, 'Transaction listing did not render');
  const row = page.locator('#txTable .list-row').first();
  const rowBefore = await row.boundingBox();
  await row.hover();
  await page.waitForTimeout(220);
  stable(rowBefore, await row.boundingBox(), 'transaction row');
  await page.screenshot({ path: path.join(outputDir, 'transactions-light-desktop.png') });

  await page.getByRole('button', { name: 'Recurring', exact: true }).click();
  await page.waitForTimeout(400);
  assert(await page.locator('#subsSplitWrap .split-view').isVisible(), 'Recurring split view did not render');
  assert(await page.locator('#subsSplitWrap .list-row').count() >= 1, 'Recurring list rows did not render');
  await page.locator('#subsSplitWrap .list-row').first().click();
  await page.waitForTimeout(200);
  assert(await page.locator('#subsDetail').isVisible(), 'Recurring detail panel did not open');
  assert(await page.locator('#subsDetail .serif, #subsDetail #recEditManual').count() >= 1, 'Recurring detail content missing');

  await page.getByRole('button', { name: 'Credit cards', exact: true }).click();
  await page.waitForTimeout(400);
  assert(await page.locator('#creditCardsList .split-view').isVisible(), 'Credit cards split view did not render');
  assert(await page.locator('#creditCardsList .list-row').count() >= 1, 'Credit card list rows did not render');
  assert(await page.locator('#creditDetail .credit-plan').isVisible(), 'Credit card detail planner did not render');

  const beforeRefresh = await page.locator('#txTable .list-row').count();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Transactions', exact: true }).click();
  const afterRefresh = await page.locator('#txTable .list-row').count();
  assert(afterRefresh === beforeRefresh, 'Refresh changed or cleared persisted transactions');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Overview', exact: true }).last().click();
  await page.waitForTimeout(180);
  assert(await page.locator('nav.tabbar').isVisible(), 'Mobile tab bar is not visible');
  assert(!(await page.locator('nav.topnav').isVisible()), 'Desktop navigation is visible on mobile');
  await page.screenshot({ path: path.join(outputDir, 'overview-light-mobile.png') });

  for (const width of [320, 375, 414, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width < 760 ? 844 : 1000 });
    await page.waitForTimeout(80);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 1, `${width}px viewport has ${overflow}px horizontal overflow`);
    assert(
      await page.locator(width < 760 ? 'nav.tabbar' : 'nav.topnav').isVisible(),
      `${width}px viewport shows the wrong primary navigation`
    );
  }

  await page.locator('#privacyBtn').click();
  assert(await page.locator('#detailModal').getAttribute('class') === 'modal-backdrop open', 'Privacy dialog did not open');
  await page.keyboard.press('Escape');
  assert(!(await page.locator('#detailModal').getAttribute('class')).includes('open'), 'Escape did not close the dialog');
  const swReady = await page.evaluate(() => Promise.race([
    navigator.serviceWorker.ready.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 4000)),
  ]));
  if (swReady) {
    await page.reload({ waitUntil: 'networkidle' });
    assert(await page.evaluate(() => !!navigator.serviceWorker.controller), 'Service worker did not control the refreshed page');
  }

  const unexpected404 = notFoundUrls.filter((u) => !/sync-config\.json/.test(u));
  assert(unexpected404.length === 0, `Unexpected 404s: ${unexpected404.join(' | ')}`);
  assert(errors.length === 0, `Console errors: ${errors.join(' | ')}`);
  await browser.close();
  console.log(`${browserName} UI QA passed: stable hover, no hover navigation, persisted refresh, responsive navigation, zero console errors.`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
