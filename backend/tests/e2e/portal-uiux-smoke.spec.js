'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const PORTAL_DIR = path.join(ROOT, 'public', 'portal');
const BASE_URL = process.env.PORTAL_BASE || 'http://127.0.0.1:3100';
const ARTIFACT_DIR = process.env.UIUX_ARTIFACT_DIR || path.join(os.tmpdir(), 'eclaw-portal-uiux-smoke');
const CHROMIUM_EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

const PAGES = fs.readdirSync(PORTAL_DIR)
    .filter(file => file.endsWith('.html'))
    .sort();

const VIEWPORTS = [
    { name: 'desktop', width: 1366, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
];

function installMockApi() {
    const ok = body => new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });

    const emptyDashboard = {
        summary: { todo: 0, in_progress: 0, review: 0, done: 0, blocked: 0 },
        cards: [],
        notes: [],
        rules: [],
        skills: [],
    };

    const route = rawUrl => {
        const url = new URL(rawUrl, window.location.href);
        const pathName = url.pathname;

        if (pathName === '/api/auth/me') {
            return ok({
                authenticated: true,
                user: { id: 'qa-user', email: 'qa@example.test', isAdmin: true },
                deviceId: 'qa-device',
                deviceSecret: 'qa-secret',
            });
        }
        if (pathName === '/api/entities') {
            return ok({
                success: true,
                entities: [{
                    id: 0,
                    entityId: 0,
                    name: 'QA Bot',
                    character: 'LOBSTER',
                    publicCode: 'qa0000',
                    state: 'IDLE',
                    level: 1,
                    xp: 0,
                }],
            });
        }
        if (pathName === '/api/status') {
            return ok({ success: true, status: 'online', state: 'IDLE' });
        }
        if (pathName === '/api/chat/history') {
            return ok({ success: true, messages: [] });
        }
        if (pathName === '/api/mission/dashboard') {
            return ok({ success: true, dashboard: emptyDashboard });
        }
        if (pathName === '/api/mission/cards') {
            return ok({ success: true, cards: [] });
        }
        if (pathName === '/api/mission/notes') {
            return ok({ success: true, notes: [] });
        }
        if (pathName === '/api/mission/rules') {
            return ok({ success: true, rules: [] });
        }
        if (pathName === '/api/mission/skills') {
            return ok({ success: true, skills: [] });
        }
        if (pathName === '/api/device/files') {
            return ok({ success: true, files: [] });
        }
        if (pathName === '/api/device-vars') {
            return ok({ success: true, vars: [] });
        }
        if (pathName === '/api/contacts') {
            return ok({ success: true, contacts: [] });
        }
        if (pathName === '/api/feedback') {
            return ok({ success: true, feedback: [] });
        }
        if (pathName === '/api/rental/marketplace') {
            return ok({ success: true, listings: [], bots: [] });
        }
        if (pathName === '/api/rental/my-rentals') {
            return ok({ success: true, rentals: [] });
        }
        if (pathName === '/api/wallet/balance') {
            return ok({
                success: true,
                wallet: {
                    balance_ecoin: 0,
                    held_ecoin: 0,
                    lifetime_earned_mli: 0,
                    lifetime_spent_mli: 0,
                },
                transactions: [],
            });
        }
        if (pathName === '/api/wallet/topup/tiers') {
            return ok({ success: true, tiers: [] });
        }
        if (pathName === '/api/device-preferences') {
            return ok({ success: true, preferences: {} });
        }
        if (pathName === '/api/entity/cross-device-settings') {
            return ok({ success: true, settings: {} });
        }
        if (pathName === '/api/subscription/status') {
            return ok({ success: true, plan: 'free', status: 'active' });
        }
        if (pathName.includes('templates')) {
            return ok({ success: true, templates: [] });
        }

        return ok({ success: true, items: [], data: [], cards: [], entities: [] });
    };

    try {
        localStorage.setItem('deviceId', 'qa-device');
        localStorage.setItem('deviceSecret', 'qa-secret');
        localStorage.setItem('entityId', '0');
    } catch {
        // Sandboxed/third-party frames can deny localStorage. The top-level page still gets seeded.
    }

    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
        const rawUrl = typeof input === 'string' ? input : input.url;
        const url = new URL(rawUrl, window.location.href);
        if (url.pathname.startsWith('/api/')) return Promise.resolve(route(url.href, init));
        return nativeFetch(input, init);
    };
}

function visibleControlAudit() {
    const isVisible = el => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden'
            && style.display !== 'none'
            && style.opacity !== '0'
            && style.pointerEvents !== 'none'
            && rect.width > 0
            && rect.height > 0;
    };
    const labelFor = el => {
        const parts = [
            el.getAttribute('aria-label'),
            el.getAttribute('title'),
            el.getAttribute('placeholder'),
            el.getAttribute('alt'),
            el.value,
            el.textContent,
        ];
        if (el.id) {
            const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (label) parts.push(label.textContent);
        }
        const img = el.querySelector && el.querySelector('img[alt]');
        if (img) parts.push(img.getAttribute('alt'));
        return parts.map(v => (v || '').trim()).find(Boolean) || '';
    };

    const controls = Array.from(document.querySelectorAll(
        'button, [role="button"], input:not([type="hidden"]), textarea, select, a[href]'
    )).filter(isVisible);

    const unlabeled = [];
    const tinyTargets = [];
    for (const el of controls) {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        const label = labelFor(el);
        const rect = el.getBoundingClientRect();
        if (!label && !(tag === 'input' && ['checkbox', 'radio', 'file', 'color'].includes(type))) {
            unlabeled.push(`${tag}${el.id ? '#' + el.id : ''}${el.className ? '.' + String(el.className).trim().split(/\s+/).slice(0, 2).join('.') : ''}`);
        }
        if ((tag === 'button' || el.getAttribute('role') === 'button' || tag === 'a') && (rect.width < 28 || rect.height < 28)) {
            tinyTargets.push(`${tag}${el.id ? '#' + el.id : ''}:${Math.round(rect.width)}x${Math.round(rect.height)}`);
        }
    }

    return {
        controlCount: controls.length,
        unlabeled: unlabeled.slice(0, 20),
        tinyTargets: tinyTargets.slice(0, 20),
        scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        clientWidth: document.documentElement.clientWidth,
        bodyTextLength: document.body.innerText.trim().length,
    };
}

async function run() {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

    const browser = await chromium.launch({
        headless: true,
        executablePath: CHROMIUM_EXECUTABLE,
    });

    const failures = [];
    const summaries = [];

    for (const viewport of VIEWPORTS) {
        const context = await browser.newContext({ viewport });
        await context.addInitScript(installMockApi);

        const page = await context.newPage();

        for (const pageName of PAGES) {
            console.log(`[${viewport.name}] ${pageName}`);
            const pageFailures = [];
            const consoleErrors = [];
            const pageErrors = [];
            const badResponses = [];

            const onConsole = msg => {
                if (msg.type() === 'error') consoleErrors.push(msg.text());
            };
            const onPageError = err => pageErrors.push(err.message);
            const onResponse = res => {
                const status = res.status();
                const url = res.url();
                const pathName = new URL(url).pathname;
                const ignored = pathName === '/socket.io/socket.io.js';
                if (status >= 400 && !ignored && !pathName.startsWith('/api/')) {
                    badResponses.push(`${status} ${url}`);
                }
            };

            page.on('console', onConsole);
            page.on('pageerror', onPageError);
            page.on('response', onResponse);

            const url = `${BASE_URL}/portal/${pageName}`;
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
                await page.waitForTimeout(600);
            } catch (err) {
                pageFailures.push(`navigation failed: ${err.message}`);
            }

            const audit = await page.evaluate(visibleControlAudit).catch(err => ({
                controlCount: 0,
                unlabeled: [],
                tinyTargets: [],
                scrollWidth: 0,
                clientWidth: 0,
                bodyTextLength: 0,
                evaluateError: err.message,
            }));

            if (audit.evaluateError) pageFailures.push(`DOM audit failed: ${audit.evaluateError}`);
            if (audit.bodyTextLength < 10) pageFailures.push(`blank-looking page: body text length ${audit.bodyTextLength}`);
            if (audit.scrollWidth > audit.clientWidth + 6) {
                pageFailures.push(`horizontal overflow: scrollWidth=${audit.scrollWidth}, clientWidth=${audit.clientWidth}`);
            }
            if (audit.unlabeled.length > 0) {
                pageFailures.push(`unlabeled visible controls: ${audit.unlabeled.join(', ')}`);
            }
            const actionableConsoleErrors = consoleErrors.filter(text =>
                !/Failed to load resource|net::ERR|socket\.io|Authentication failed|Permissions policy violation/i.test(text)
            );
            if (actionableConsoleErrors.length > 0) {
                pageFailures.push(`console errors: ${actionableConsoleErrors.slice(0, 5).join(' | ')}`);
            }
            if (pageErrors.length > 0) pageFailures.push(`page errors: ${pageErrors.slice(0, 5).join(' | ')}`);
            if (badResponses.length > 0) pageFailures.push(`bad non-api responses: ${badResponses.slice(0, 5).join(' | ')}`);

            const clickTargets = page.locator([
                'button:not([disabled]):not(.ai-chat-fab):not(.scroll-to-bottom-btn)',
                '[role="button"]:not([aria-disabled="true"]):not(.ai-chat-fab):not(.scroll-to-bottom-btn)',
                'a[href]',
            ].join(', ')).filter({ visible: true });
            const clickTargetCount = await clickTargets.count().catch(() => 0);
            const blockedTargets = [];
            for (let i = 0; i < Math.min(clickTargetCount, 120); i += 1) {
                const target = clickTargets.nth(i);
                try {
                    await target.click({ trial: true, timeout: 3000 });
                } catch (err) {
                    const label = await target.evaluate(el => (
                        el.getAttribute('aria-label') ||
                        el.getAttribute('title') ||
                        el.textContent ||
                        el.getAttribute('href') ||
                        el.tagName
                    ).trim().replace(/\s+/g, ' ').slice(0, 80)).catch(() => `target#${i}`);
                    blockedTargets.push(`${label}: ${err.message.split('\n')[0]}`);
                }
            }
            if (blockedTargets.length > 0) {
                pageFailures.push(`blocked click targets: ${blockedTargets.slice(0, 8).join(' | ')}`);
            }

            const helpIcons = page.locator('.help-icon').filter({ visible: true });
            const helpIconCount = await helpIcons.count().catch(() => 0);
            if (helpIconCount > 0) {
                try {
                    await helpIcons.first().click();
                    await page.waitForTimeout(800);
                    const visible = await page.locator('.help-popover').first().isVisible();
                    if (!visible) pageFailures.push('first help-icon popover did not remain visible after 800ms');
                    await page.keyboard.press('Escape').catch(() => {});
                } catch (err) {
                    pageFailures.push(`help-icon click failed: ${err.message}`);
                }
            }

            summaries.push({
                page: pageName,
                viewport: viewport.name,
                controls: audit.controlCount,
                consoleErrors: consoleErrors.length,
                tinyTargets: audit.tinyTargets.length,
                failures: pageFailures,
            });

            if (pageFailures.length > 0) {
                const shotName = `${viewport.name}-${pageName.replace(/[^a-z0-9.-]/gi, '_')}.png`;
                await page.screenshot({ path: path.join(ARTIFACT_DIR, shotName), fullPage: true }).catch(() => {});
                failures.push({ page: pageName, viewport: viewport.name, failures: pageFailures, screenshot: shotName });
            }

            page.removeListener('console', onConsole);
            page.removeListener('pageerror', onPageError);
            page.removeListener('response', onResponse);
        }

        await page.close();
        await context.close();
    }

    await browser.close();

    const reportPath = path.join(ARTIFACT_DIR, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify({ baseUrl: BASE_URL, summaries, failures }, null, 2));

    console.log(`Portal UIUX smoke checked ${PAGES.length} pages x ${VIEWPORTS.length} viewports`);
    console.log(`Report: ${reportPath}`);
    if (failures.length > 0) {
        for (const failure of failures) {
            console.log(`FAIL ${failure.viewport} ${failure.page}:`);
            for (const item of failure.failures) console.log(`  - ${item}`);
            console.log(`  screenshot: ${failure.screenshot}`);
        }
        process.exit(1);
    }
    console.log('Portal UIUX smoke passed');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
