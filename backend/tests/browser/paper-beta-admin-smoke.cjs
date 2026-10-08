/* Synthetic component test only: no portal session or production connection. */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    try {
        const page = await browser.newPage();
        await page.route('http://paper-beta.local/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }));
        await page.goto('http://paper-beta.local/');
        await page.setContent('<main class="container"><section class="section-card" id="paperBetaFeedback"></section></main>');
        const adminHtml = fs.readFileSync(path.join(__dirname, '../../public/portal/admin.html'), 'utf8');
        await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../../public/portal/shared/style.css'), 'utf8') +
            (adminHtml.match(/<style>([\s\S]*?)<\/style>/) || [null, ''])[1] });
        await page.evaluate(() => {
            window.i18n = { t: key => key };
            window.synthetic = { value: { success: true, summary: { total: '1', averageRating: 4, continuation: { yes: '1', maybe: '0', no: '0' } },
                items: [{ receiptId: '1', rating: 4, continuation: 'yes', comment: '<img src=x onerror="window.xss=true">', version: 'synthetic', platform: 'Android', createdAt: '2040-01-01T00:00:00Z' }], nextCursor: null }, error: null, pending: null, calls: [], events: [] };
            window.telemetry = { trackAction: (...args) => synthetic.events.push(args), trackError: (...args) => synthetic.events.push(args) };
            window.apiCall = async (method, url) => {
                synthetic.calls.push({ method, url });
                if (synthetic.pending) { const promise = synthetic.pending; synthetic.pending = null; return promise; }
                if (synthetic.error) throw Object.assign(new Error('Synthetic error'), { status: synthetic.error });
                return JSON.parse(JSON.stringify(synthetic.value));
            };
        });
        await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../../public/portal/shared/paper-beta-admin.js'), 'utf8') + '\nwindow.testPanel=PaperBetaAdmin;' });
        await page.evaluate(() => testPanel.mount());
        await page.waitForSelector('#paperBetaFeedback tbody tr');
        assert.equal(await page.locator('#paperBetaFeedback tbody tr').count(), 1);
        assert.equal(await page.locator('#paperBetaFeedback img').count(), 0);
        assert.equal(await page.evaluate(() => window.xss), undefined);
        assert.match(await page.locator('#paperBetaFeedback').textContent(), /<img/);
        await page.locator('button').first().click();
        await page.waitForSelector('tbody tr');
        assert.equal(await page.locator('tbody tr').count(), 1, 'refresh replaces instead of duplicating');
        await page.evaluate(() => { synthetic.value.items[0].rating = 5; synthetic.value.summary.averageRating = 5; });
        await page.locator('button').first().click();
        await page.waitForFunction(() => document.querySelector('tbody').textContent.includes('5/5'));
        await page.evaluate(() => { synthetic.value.nextCursor = '1'; testPanel.mount(); });
        await page.waitForSelector('tbody tr');
        await page.locator('button').nth(1).click();
        await page.waitForSelector('tbody tr');
        assert.equal(await page.evaluate(() => synthetic.calls.at(-1).url), '/api/admin/paper-beta-feedback?before=1');
        await page.evaluate(() => {
            synthetic.pending = new Promise(resolve => { window.resolveOld = resolve; }); testPanel.mount();
            synthetic.value.items[0].version = 'newest-response'; testPanel.mount();
        });
        await page.waitForFunction(() => document.body.textContent.includes('newest-response'));
        await page.evaluate(() => resolveOld({ ...synthetic.value, items: [{ ...synthetic.value.items[0], version: 'stale-response' }] }));
        await page.waitForTimeout(50);
        assert.ok(!(await page.locator('#paperBetaFeedback').textContent()).includes('stale-response'));
        for (const status of [401, 403, 503]) {
            await page.evaluate(status => { synthetic.error = status; testPanel.mount(); }, status);
            await page.waitForFunction(() => !document.querySelector('tbody'));
            assert.ok(!(await page.locator('#paperBetaFeedback').textContent()).includes('newest-response'));
            assert.match(await page.locator('#paperBetaFeedback').textContent(), status === 503 ? /paper_beta_unavailable/ : /paper_beta_denied/);
        }
        await page.evaluate(() => { synthetic.error = null; testPanel.mount(); });
        await page.waitForSelector('tbody tr');
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
        assert.equal(await page.locator('#paperBetaFeedback').textContent(), '');
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
        await page.waitForSelector('tbody tr');
        const events = await page.evaluate(() => JSON.stringify(synthetic.events));
        assert.match(events, /paper_beta_refresh/); assert.match(events, /paper_beta_read_failed/);
        assert.ok(!/comment|receiptId|newest-response|onerror/.test(events), 'telemetry never copies private feedback fields');
        // Real localization for review screenshots, after isolated behavior assertions.
        await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../../public/shared/i18n.js'), 'utf8') });
        await page.evaluate(() => { i18n.lang = 'zh'; testPanel.mount(); });
        await page.waitForSelector('tbody tr');
        for (const width of [390, 1280]) {
            await page.setViewportSize({ width, height: 900 });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'table stays inside its scrolling container');
            if (process.env.PAPER_BETA_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.PAPER_BETA_EVIDENCE_DIR, 'beta-component-' + width + '.png'), fullPage: true });
        }
        console.log('PASS: XSS text rendering, refresh/update, bounded cursor, stale response, 401/403/503 clearing, bfcache clearing/refetch; synthetic only');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
