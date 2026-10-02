import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const release = resolve(args[args.indexOf('--release') + 1] || join(root, 'reports'));
const out = resolve(args.includes('--output') ? args[args.indexOf('--output') + 1] : join(root, 'design/verification'));
const { chromium } = createRequire('/Users/hank/Desktop/Project/EClaw-ai-hank-apps-route/backend/package.json')('playwright');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const isReport = pathname.startsWith('/reports/');
    const base = isReport ? release : join(root, 'public');
    const file = resolve(base, '.' + (isReport ? pathname.slice('/reports'.length) : pathname) + (pathname.endsWith('/') ? 'index.html' : ''));
    if (!file.startsWith(base + sep)) throw new Error('Invalid path');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [], checks = {};
try {
  await mkdir(out, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1536, height: 1024 }, deviceScaleFactor: 1 });
  await page.route('**/*', route => route.request().method() === 'GET' ? route.continue() : route.abort());
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/reports/`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  await page.locator('#review-coverage').filter({ hasText: /已讀/ }).waitFor();
  const geometry = await page.evaluate(() => Object.fromEntries(['.topbar', '.page-heading', '.metrics', '.chart-card', '.reviews-panel'].map(selector => {
    const element = document.querySelector(selector); if (!element) return [selector, null];
    const { x, y, width, height } = element.getBoundingClientRect(); return [selector, { x, y, width, height }];
  })));
  const point = await page.locator('.series-line[data-app-id="stray-map"]').last().evaluate(element => {
    if (!element.getAttribute('d')) return null;
    const p = element.getPointAtLength(element.getTotalLength());
    const screen = new DOMPoint(p.x, p.y).matrixTransform(element.getScreenCTM());
    return { x: screen.x, y: screen.y };
  }).catch(() => null);
  if (point) {
    await page.mouse.move(point.x, point.y);
    checks.hoverTooltip = await page.locator('#trend-tooltip').isVisible();
    checks.hoverAppName = await page.locator('#trend-tooltip').textContent();
    await page.mouse.click(point.x, point.y);
    await page.mouse.move(1500, 1000);
    checks.clickPinsTooltip = await page.locator('#trend-tooltip').isVisible();
  }
  await page.screenshot({ path: join(out, 'app-trends-desktop.png'), animations: 'disabled' });
  await page.locator('#trend-chart').focus(); await page.keyboard.press('Escape');
  checks.escapeClosesTooltip = !(await page.locator('#trend-tooltip').isVisible());
  await page.keyboard.press('ArrowRight');
  const keyboardBefore = await page.locator('#trend-tooltip .tooltip-title strong').textContent();
  await page.keyboard.press('ArrowDown');
  checks.keyboardAppSwitch = keyboardBefore !== await page.locator('#trend-tooltip .tooltip-title strong').textContent();
  await page.keyboard.press('Enter'); await page.mouse.move(1500, 1000);
  checks.keyboardPinsTooltip = await page.locator('#trend-tooltip').isVisible();
  await page.keyboard.press('Escape');
  const initial = await page.locator('#range-display').textContent();
  await page.mouse.move(900, 450); await page.mouse.wheel(0, -500); await page.waitForTimeout(100);
  checks.wheelChangesRange = initial !== await page.locator('#range-display').textContent();
  const beforePan = await page.locator('#range-display').textContent();
  await page.mouse.move(800, 470); await page.mouse.down(); await page.mouse.move(950, 470, { steps: 5 }); await page.mouse.up();
  checks.dragPansRange = beforePan !== await page.locator('#range-display').textContent();
  await page.locator('#zoom-reset').click();
  checks.fullHistoryAccessible = await page.locator('#range-start').getAttribute('min') === '0';
  await page.locator('[data-chart-mode="daily"]').click();
  checks.dailyMode = await page.locator('[data-chart-mode="daily"]').getAttribute('aria-pressed');
  await page.locator('[data-chart-mode="cumulative"]').click();
  await page.locator('#metric-select').selectOption('crashRate');
  checks.ratesCannotAccumulate = await page.locator('[data-chart-mode="cumulative"]').isDisabled();
  checks.stabilityNotMoney = !/\$/.test(await page.locator('#crashRate-value').textContent());
  await page.locator('#metric-select').selectOption('combinedAcquisition');
  await page.locator('[data-chart-mode="cumulative"]').click();
  await page.locator('#app-picker > summary').click();
  checks.allAppsInPicker = await page.locator('#app-options .legend-button').count() === await page.evaluate(() => window.AIHANK_REPORT.apps.length);
  await page.locator('#clear-apps').click();
  checks.clearAppsRemovesLines = await page.locator('.series-line').count() === 0;
  await page.locator('#select-all-apps').click();
  checks.selectAllRestoresLines = await page.locator('.series-line').count() === await page.evaluate(() => window.AIHANK_REPORT.apps.length);
  await page.locator('#app-picker > summary').click();
  await page.locator('#apps > summary').click();
  checks.allTableFieldsSortable = true;
  for (const key of ['name', 'category', 'googleInstalls', 'appleDownloads', 'admobRevenue', 'rating', 'crashRate', 'anrRate']) {
    await page.locator(`[data-sort="${key}"]`).click();
    if (await page.locator('#sort-field').inputValue() !== key || !['ascending', 'descending'].includes(await page.locator(`[data-sort="${key}"]`).locator('..').getAttribute('aria-sort'))) checks.allTableFieldsSortable = false;
  }
  await page.locator('#apps > summary').click();
  // A single featured line is insufficient evidence for the entire catalog.
  // Exercise each real path with ordinary pointer input at multiple positions.
  await page.locator('#zoom-reset').click();
  const catalogApps = await page.evaluate(() => window.AIHANK_REPORT.apps.map(app => ({ id: app.id, name: app.name })));
  checks.allAppSeries = [];
  for (const app of catalogApps) {
    await page.locator('#trend-chart').focus(); await page.keyboard.press('Escape');
    if (!await page.locator('#app-picker').evaluate(element => element.open)) await page.locator('#app-picker > summary').click();
    await page.locator('#clear-apps').click();
    const options = await page.locator('#app-options .legend-button').evaluateAll(elements => elements.map((element, index) => ({ index, id: element.dataset.appId, title: element.title, text: element.textContent?.trim() })));
    const option = options.find(item => item.id === app.id || item.title === app.name || item.text === app.name);
    if (!option) { checks.allAppSeries.push({ ...app, error: 'No exact APP picker match' }); continue; }
    await page.locator('#app-options .legend-button').nth(option.index).click();
    await page.locator('#app-picker > summary').click();
    const line = page.locator(`.series-line[data-app-id="${app.id}"]`);
    const count = await line.count();
    if (count !== 1) { checks.allAppSeries.push({ ...app, error: `Expected one selected path node, got ${count}` }); continue; }
    const path = await line.getAttribute('d');
    const strokeLength = await line.evaluate(element => element.getTotalLength());
    const dotCount = await page.locator(`.series-dot[data-app-id="${app.id}"]`).count();
    if (!path) { checks.allAppSeries.push({ ...app, status: 'no plotted data', pathNodeCount: count, noSyntheticLine: dotCount === 0 }); continue; }
    const samples = [];
    for (const fraction of [.1, .5, .9]) {
      await page.locator('#trend-chart').focus(); await page.keyboard.press('Escape');
      const position = await line.evaluate((element, fraction) => {
        const point = element.getPointAtLength(element.getTotalLength() * fraction);
        const screen = new DOMPoint(point.x, point.y).matrixTransform(element.getScreenCTM());
        return { x: screen.x, y: screen.y };
      }, fraction);
      await page.mouse.move(1500, 1000); await page.mouse.move(position.x, position.y);
      await page.waitForTimeout(50);
      const visible = await page.locator('#trend-tooltip').isVisible();
      const name = visible ? await page.locator('#trend-tooltip .tooltip-title strong').textContent() : null;
      await page.mouse.click(position.x, position.y); await page.mouse.move(1500, 1000);
      samples.push({ fraction, position, hoverMatches: visible && name === app.name, tooltipName: name, clickPins: await page.locator('#trend-tooltip').isVisible() });
      if (app.id === 'weesh' && fraction === .5 && visible) {
        await page.locator('#trend-chart').focus(); await page.keyboard.press('Escape');
        await page.mouse.move(position.x, position.y); await page.waitForTimeout(50);
        await page.locator('#trend-tooltip .pin-control').click();
        await page.mouse.move(1500, 1000);
        checks.tooltipBoundaryPinControl = await page.locator('#trend-tooltip').isVisible() && await page.locator('#trend-tooltip .pin-control').textContent() === '取消固定';
      }
    }
    checks.allAppSeries.push({ ...app, status: 'plotted', strokeLength, dotCount, rendered: strokeLength > 0 || dotCount > 0, samples });
  }
  checks.allAppsHitTestingPassed = checks.allAppSeries.length === catalogApps.length && checks.allAppSeries.every(result => !result.error && (result.status === 'no plotted data' || result.samples.every(sample => sample.hoverMatches && sample.clickPins)));
  checks.allAppSeriesVisible = checks.allAppSeries.length === catalogApps.length && checks.allAppSeries.every(result => !result.error && (result.status === 'no plotted data' ? result.noSyntheticLine : result.rendered));
  await page.locator('#trend-chart').focus(); await page.keyboard.press('Escape');
  if (!await page.locator('#app-picker').evaluate(element => element.open)) await page.locator('#app-picker > summary').click();
  await page.locator('#select-all-apps').click(); await page.locator('#app-picker > summary').click();
  await page.locator('#review-search').fill('no-matching-review-20261001');
  checks.reviewFilter = await page.locator('#review-grid').textContent();
  await page.locator('#review-search').fill('');
  const authorMetadata = await page.locator('.review-author').evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect(), card = element.closest('.review-card').getBoundingClientRect();
    const style = getComputedStyle(element);
    return { text: element.textContent, visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0, insideCard: rect.x >= card.x && rect.y >= card.y && rect.right <= card.right && rect.bottom <= card.bottom, fits: element.scrollWidth <= element.clientWidth };
  }));
  checks.reviewAuthorMetadata = authorMetadata;
  checks.reviewMetadataReadable = authorMetadata.every(item => item.visible && item.insideCard && item.fits && item.text?.trim());
  checks.reviewExpandControlsPassed = true;
  const reviewButtons = await page.locator('.review-expand').count();
  checks.reviewExpandButtonCount = reviewButtons;
  for (let index = 0; index < reviewButtons; index++) {
    const button = page.locator('.review-expand').nth(index);
    await button.click();
    if (await button.getAttribute('aria-expanded') !== 'true') checks.reviewExpandControlsPassed = false;
    await button.click();
    if (await button.getAttribute('aria-expanded') !== 'false') checks.reviewExpandControlsPassed = false;
  }
  const community = await page.locator('#review-coverage').textContent();
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await mobile.route('**/*', route => route.request().method() === 'GET' ? route.continue() : route.abort());
  mobile.on('pageerror', error => errors.push(error.message));
  await mobile.goto(`http://127.0.0.1:${server.address().port}/reports/`, { waitUntil: 'networkidle', timeout: 60000 });
  await mobile.evaluate(() => document.fonts.ready);
  checks.mobileOverflow = await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  await mobile.screenshot({ path: join(out, 'app-trends-mobile.png'), fullPage: true, animations: 'disabled' });
  checks.mobileComponents = [];
  for (const width of [320, 390, 768]) {
    await mobile.setViewportSize({ width, height: 844 });
    await mobile.waitForTimeout(100);
    const audit = await mobile.evaluate(() => {
      const navigation = [...document.querySelectorAll('.topnav a')].filter(element => getComputedStyle(element).display !== 'none').map(element => {
        const range = document.createRange(); range.selectNodeContents(element);
        return { label: element.textContent.trim(), fragments: [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).length };
      });
      const values = [...document.querySelectorAll('.metric-value')].map(element => {
        const rect = element.getBoundingClientRect(), card = element.closest('.metric').getBoundingClientRect();
        return { value: element.textContent, fits: rect.left >= card.left && rect.right <= card.right && rect.top >= card.top && rect.bottom <= card.bottom };
      });
      const labels = [...document.querySelectorAll('#trend-chart text')].map(element => {
        const matrix = element.getScreenCTM(), font = parseFloat(getComputedStyle(element).fontSize);
        return { text: element.textContent, xFont: font * Math.abs(matrix.a), yFont: font * Math.abs(matrix.d), ratio: Math.abs(matrix.a / matrix.d) };
      });
      return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, navigation, values, labels };
    });
    checks.mobileComponents.push(audit);
  }
  checks.mobileNavigationSingleLine = checks.mobileComponents.every(audit => audit.navigation.length === 4 && ['APP 趨勢', '總覽', '歷史趨勢', '評論中心'].every(label => audit.navigation.some(item => item.label === label)) && audit.navigation.every(item => item.fragments === 1));
  checks.mobileMetricValuesFit = checks.mobileComponents.every(audit => audit.values.length >= 2 && audit.values.every(item => item.fits));
  checks.mobileChartLabelsReadable = checks.mobileComponents.every(audit => audit.labels.length > 0 && audit.labels.every(item => item.xFont >= 9 && item.yFont >= 9 && item.ratio >= .75 && item.ratio <= 1.5));
  checks.mobileOverflow ||= checks.mobileComponents.some(audit => audit.overflow);
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.locator('#trend-chart').scrollIntoViewIfNeeded();
  const tapPoint = await mobile.locator('.series-line[data-app-id="stray-map"]').evaluate(element => {
    const point = element.getPointAtLength(element.getTotalLength());
    const screen = new DOMPoint(point.x, point.y).matrixTransform(element.getScreenCTM());
    return { x: screen.x, y: screen.y };
  });
  await mobile.touchscreen.tap(tapPoint.x, tapPoint.y);
  checks.mobileTapPinsTooltip = await mobile.locator('#trend-tooltip').isVisible() && await mobile.locator('#trend-tooltip .pin-control').textContent() === '取消固定';
  await writeFile(join(out, 'mobile-component-audit.json'), JSON.stringify(checks.mobileComponents, null, 2) + '\n');
  const files = {};
  for (const file of ['index.html', 'report-view.js', 'data.js']) files[file] = createHash('sha256').update(await readFile(join(release, file))).digest('hex');
  const htmlHash = files['index.html'];
  await writeFile(join(out, 'capture.json'), JSON.stringify({ viewport: { width: 1536, height: 1024, scale: 1 }, capturedAt: new Date().toISOString(), files, htmlHash, geometry, checks, errors, community }, null, 2) + '\n');
  console.log(JSON.stringify({ out, geometry, checks, errors, community }));
  if (errors.length || checks.mobileOverflow || Object.entries(checks).some(([key, value]) => key !== 'mobileOverflow' && value === false)) process.exitCode = 1;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
