#!/usr/bin/env node
'use strict';
/* global document, innerWidth, getComputedStyle, Image, location */
// Local browser rehearsal of the real Hub files. Every data answer is synthetic.
// No production browser, login, telemetry or non-GET request is used.
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const { chromium } = require('../../backend/node_modules/playwright');
const { PAGE_FILES } = require('../../backend/aihankapps-hub');
const ROOT = path.resolve(__dirname, '../..');
const OUT = path.resolve(process.argv[2] || '/tmp/stray-map-ui-evidence');
const NOW = Date.now(), DAY = 86400000;
const today = new Date(NOW + 8 * 3600000).toISOString().slice(0, 10);
const day = offset => new Date(Date.parse(today) + offset * DAY).toISOString().slice(0, 10);
let scenario = 'data';
function answer() {
  const empty = scenario === 'empty';
  const snapshot = { v: 1, source: 'stray-map', asOf: NOW, observedAt: NOW,
    native: { total: empty ? 0 : 8, notDeleted: empty ? 0 : 6, mapVisible: empty ? 0 : 6, deleted: empty ? 0 : 2, new7d: 0, new30d: empty ? 0 : 2 },
    types: empty ? [] : [['cat', 4], ['dog', 2]], statuses: empty ? [] : [['recently_seen', 4], ['adopted', 2]],
    days: Array.from({ length: 30 }, (_, i) => [day(i - 30), empty ? 0 : i === 15 ? 2 : 0]), external: null };
  return { success: true, generatedAt: NOW, today, apps: [{ id: 'stray-map', slug: 'stray-map', name: '浪浪地圖', category: '公益', mono: '浪浪',
    icon: '/AiHankApps/icons/store-stray-map-1b4433d42006.jpg',
    platforms: [{ id: 'android', label: 'Android', status: '正式版', public: true, url: 'https://example.invalid/download' }], links: {} }],
    daily: { start: day(-60), days: 61, series: {} }, latest: { facts: { 'stray-map': scenario === 'missing' ? {} : { smMapStats: snapshot } } },
    sources: { imports: { ok: scenario !== 'interrupted', collectors: { 'stray-map': { collectedAt: NOW } } } },
    services: [], infra: [], accounts: [], inbox: { feedback: [], notes: [], mutes: [], acks: [] } };
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const requests = [], errors = [], results = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = value => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/aihankapps/hub/data') return send(answer());
    if (url.pathname.startsWith('/api/')) return send({ success: true, services: [], catalog: [], series: {}, points: [] });
    const name = url.pathname.replace('/AiHankApps/hub/', '') || 'index.html';
    let file, type;
    if (PAGE_FILES[name]) { file = path.join(ROOT, 'backend/aihankapps-hub', name); type = PAGE_FILES[name]; }
    else if (url.pathname === '/AiHankApps/ops/ops-view.js') { file = path.join(ROOT, 'backend/public/AiHankApps/ops/ops-view.js'); type = 'text/javascript'; }
    else if (url.pathname === '/AiHankApps/icons/store-stray-map-1b4433d42006.jpg') { file = path.join(ROOT, 'backend/public', url.pathname); type = 'image/jpeg'; }
    else if (['/AiHankApps/brand/h-watermark-general-italic.png', '/AiHankApps/brand/h-watermark-game-italic.png'].includes(url.pathname)) { file = path.join(ROOT, 'backend/public', url.pathname); type = 'image/png'; }
    if (!file) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    const executablePath = [process.env.HUB_TEST_CHROME_BIN, chromium.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      .find(file => file && fs.existsSync(file));
    if (!executablePath) throw new Error('No existing Chromium browser is available for the rehearsal');
    browser = await chromium.launch({ headless: true, executablePath });
    for (const width of [320, 390, 1440]) {
      for (const state of ['data', 'empty', 'missing', 'interrupted']) {
        scenario = state;
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
        page.on('pageerror', error => errors.push(String(error)));
        await page.route('**/*', route => {
          const request = route.request();
          return request.url().startsWith(origin + '/') && request.method() === 'GET' ? route.continue() : route.abort();
        });
        await page.goto(origin + '/AiHankApps/hub/#app-stray-map');
        await page.locator('#sm-title').waitFor();
        assert.doesNotMatch(await page.locator('body').innerText(), /這款 APP 目前沒有任何數據來源/);
        const view = page.locator('#sm-insights');
        assert.ok(await page.locator('.ah img').evaluate(async img => { await img.decode(); return img.complete && img.naturalWidth > 0; }));
        const watermark = await page.locator('.ah .app-ico').evaluate(el => {
          const s = getComputedStyle(el, '::after'), r = el.getBoundingClientRect();
          return { image: s.backgroundImage, content: s.content, width: parseFloat(s.width), right: parseFloat(s.right), bottom: parseFloat(s.bottom), box: r.width };
        });
        assert.match(watermark.image, /h-watermark-general-italic\.png/);
        assert.equal(watermark.content, '""');
        assert.ok(watermark.width > 0 && watermark.width + watermark.right < watermark.box && watermark.width + watermark.bottom < watermark.box);
        assert.equal(await view.locator('td.num', { hasText: /^未接通$/ }).count(), 5);
        const text = await view.innerText();
        if (state === 'missing') assert.match(text, /尚未匯入通報統計/);
        else if (state === 'interrupted') assert.match(text, /統計來源讀取中斷/);
        else assert.match(text, /未刪除通報\s+\d/);
        const before = await view.locator('.sm-trend tbody tr').count();
        await view.locator('[data-sm-period]').selectOption('30');
        const after = await view.locator('.sm-trend tbody tr').count();
        if (state !== 'missing') { assert.equal(before, 7); assert.equal(after, 30); }
        const bounds = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth,
          sections: [...document.querySelectorAll('#sm-insights .sm-section')].map(el => ({ w: el.getBoundingClientRect().width, scroll: el.scrollWidth, client: el.clientWidth })) }));
        assert.ok(bounds.page <= bounds.viewport + 1, JSON.stringify(bounds));
        assert.ok(bounds.sections.every(s => s.scroll <= s.client + 1), JSON.stringify(bounds));
        await page.screenshot({ path: path.join(OUT, 'hub-' + width + '-' + state + '.synthetic.png'), fullPage: true });
        results.push({ width, state, before, after, overflow: false });
        await page.close();
      }
    }
    const iconPage = await browser.newPage({ viewport: { width: 900, height: 350 } });
    await iconPage.goto(origin + '/AiHankApps/hub/');
    await iconPage.setContent('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="' + origin + '/AiHankApps/hub/hub.css"><h1>Candidate icons · 32 / 48 / 64 px</h1>' +
      [32, 48, 64].map(size => '<div style="display:inline-block;margin:20px">' + size + 'px<br>' +
        '<img width="' + size + '" height="' + size + '" src="' + origin + '/AiHankApps/hub/eclaw-icon.png"> ' +
        '<span class="app-ico app-ico-h-general" style="display:inline-block;width:' + size + 'px;height:' + size + 'px;--h-size:13%;--h-right:5%;--h-bottom:4%"><img src="' + origin + '/AiHankApps/icons/store-stray-map-1b4433d42006.jpg"></span></div>').join(''));
    await iconPage.locator('img').evaluateAll(imgs => Promise.all(imgs.map(img => img.decode())));
    await iconPage.evaluate(async () => {
      const img = new Image(); img.src = new URL('/AiHankApps/brand/h-watermark-general-italic.png', location.href).href; await img.decode();
    });
    await iconPage.screenshot({ path: path.join(OUT, 'candidate-icons-32-48-64.png') });
    await iconPage.close();
    assert.deepEqual(errors, []);
    assert.ok(requests.every(r => r.method === 'GET'));
    const receipt = { kind: 'synthetic-local-hub-browser', checkedAt: new Date().toISOString(), results, pageErrors: errors,
      requests: requests.length, nonGetRequests: 0, productionRequests: 0, productionDataUsed: false };
    fs.writeFileSync(path.join(OUT, 'browser-result.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
