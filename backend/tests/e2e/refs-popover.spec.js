/**
 * E2E: refs-popover.spec.js
 *
 * Tests the portal `?` icon → bidirectional references popover.
 * Inline-HTML pattern (no running server): a stub `fetch` returns canned
 * `/api/refs` payloads so the popover render + click-nav can be asserted
 * deterministically.
 *
 * Run: npx playwright test backend/tests/e2e/refs-popover.spec.js
 * Or:  node backend/tests/e2e/refs-popover.spec.js   (standalone)
 *
 * Spec: docs/specs/portal-bidirectional-refs.md (#3124 + #3131).
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const HELP_POPOVER_JS = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'help-popover.js'), 'utf8');
const REFS_POPOVER_JS = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'refs-popover.js'), 'utf8');
const REFS_POPOVER_CSS = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'refs-popover.css'), 'utf8');
const CHROMIUM_EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

const CARD_ID = 'card_aa15ed2618c9246d11a0f6b1';

const REFS_PAYLOAD = {
    success: true,
    from: { kind: 'card', id: CARD_ID, label: 'Research card' },
    refs: [
        { kind: 'spec', id: 'docs/specs/portal-bidirectional-refs.md', label: 'portal ? icon refs', direction: 'out' },
        { kind: 'card', id: 'card_7579f205c0a8276240736c7d', label: 'mobile-use integration', direction: 'out' },
        { kind: 'pr', id: '3123', label: 'docs(research): EClaw vs minitap', direction: 'in' },
    ],
};

const buildHtml = (extraStyle = '') => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Refs Popover E2E</title>
<style>
${REFS_POPOVER_CSS}
body { font-family: sans-serif; background: #1e1e2e; color: #e0e0e0; padding: 40px; }
.help-popover { position: absolute; background: #2b2b3d; border: 1px solid #444; border-radius: 8px; padding: 12px; box-shadow: 0 6px 20px rgba(0,0,0,0.4); }
.help-popover-close { position: absolute; top: 4px; right: 4px; background: transparent; color: inherit; border: 0; cursor: pointer; }
.kb-card-title { font-weight: 600; }
${extraStyle}
</style>
</head>
<body>
<script>
  // Stub creds + fetch — match kanban portal convention (window.currentUser).
  window.currentUser = { deviceId: 'dev-test', deviceSecret: 'sec-test', entityId: '2' };
  window.__capturedFetches = [];
  window.__fetchResolver = null;
  function normalizeHeaders(init) {
    const headers = init && init.headers ? init.headers : {};
    if (headers instanceof Headers) return Object.fromEntries(headers.entries());
    if (Array.isArray(headers)) return Object.fromEntries(headers);
    return { ...headers };
  }
  window.fetch = (url, init = {}) => {
    window.__capturedFetches.push({ url: String(url), headers: normalizeHeaders(init) });
    return Promise.resolve({
      ok: true,
      json: async () => (${JSON.stringify(REFS_PAYLOAD)}),
    });
  };
  window.i18n = { t: (k) => ({
    "refs.popover_title": "References",
    "refs.section_out":   "This cites",
    "refs.section_in":    "Cited by",
    "refs.empty":         "No related items yet.",
    "refs.error":         "Could not load related items.",
    "refs.close":         "Close references",
  }[k] || k) };
</script>

<div class="kb-card" data-card-id="${CARD_ID}">
  <div class="kb-card-title">
    Card title here
    <button type="button" class="eclaw-refs-icon" data-refs-from="${CARD_ID}"
            aria-label="Show related cards, specs, and PRs"
            title="References">ⓘ</button>
  </div>
</div>

<script>${HELP_POPOVER_JS}</script>
<script>${REFS_POPOVER_JS}</script>
</body>
</html>`;

const SUITE = [];
function test(name, fn) { SUITE.push({ name, fn }); }
function assert(cond, msg) {
    if (!cond) throw new Error('assertion failed: ' + msg);
}

async function withPage(opts, fn) {
    const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_EXECUTABLE });
    const ctx = await browser.newContext(opts.viewport ? { viewport: opts.viewport } : {});
    const page = await ctx.newPage();
    if (process.env.DEBUG_REFS_E2E) {
        page.on('console', m => console.log('[page]', m.type(), m.text()));
        page.on('pageerror', e => console.log('[page-err]', e.message));
    }
    await page.setContent(opts.html || buildHtml(opts.extraStyle));
    await page.waitForLoadState('domcontentloaded');
    try {
        await fn(page);
    } finally {
        await browser.close();
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('desktop: ? icon click → popover renders Outgoing + Incoming', async () => {
    await withPage({ viewport: { width: 1280, height: 800 } }, async (page) => {
        await page.click('.eclaw-refs-icon');
        const popover = await page.waitForSelector('.help-popover', { timeout: 2000 });
        assert(popover, 'popover element exists');

        // Header renders
        const title = await page.textContent('.eclaw-refs-icon-title');
        assert(title?.trim() === 'References', `title was "${title}"`);

        // Outgoing section has 2 rows; Incoming has 1
        const out = await page.$$('.eclaw-refs-icon-section >> nth=0 >> .eclaw-refs-icon-row');
        const inn = await page.$$('.eclaw-refs-icon-section >> nth=1 >> .eclaw-refs-icon-row');
        assert(out.length === 2, `outgoing rows=${out.length}, expected 2`);
        assert(inn.length === 1, `incoming rows=${inn.length}, expected 1`);

        // fetch was called with correct URL shape — using window.currentUser
        // convention (deviceSecret, not botSecret)
        const calls = await page.evaluate(() => window.__capturedFetches);
        assert(calls.length === 1, `fetches=${calls.length}`);
        const call = calls[0];
        const deviceSecretHeader = Object.entries(call.headers || {})
            .find(([k]) => k.toLowerCase() === 'x-device-secret')?.[1];
        const botSecretHeader = Object.entries(call.headers || {})
            .find(([k]) => k.toLowerCase() === 'x-bot-secret')?.[1];
        assert(call.url.includes('/api/refs?from=card_aa15ed26'), 'fetch URL: ' + call.url);
        assert(call.url.includes('deviceId=dev-test'), 'fetch creds: ' + call.url);
        assert(call.url.includes('entityId=2'), 'entityId: ' + call.url);
        assert(deviceSecretHeader === 'sec-test', 'expected X-Device-Secret header: ' + JSON.stringify(call));
        assert(!botSecretHeader, 'should NOT send X-Bot-Secret when deviceSecret present: ' + JSON.stringify(call));
        assert(!call.url.includes('deviceSecret='), 'should NOT include deviceSecret in URL: ' + call.url);
        assert(!call.url.includes('botSecret='), 'should NOT include botSecret in URL: ' + call.url);
    });
});

test('auth: botSecret fallback when deviceSecret absent (bot-authed caller)', async () => {
    const html = buildHtml().replace(
        "window.currentUser = { deviceId: 'dev-test', deviceSecret: 'sec-test', entityId: '2' };",
        "window.currentUser = { deviceId: 'dev-test', botSecret: 'bot-test', entityId: 2 };"
    );
    await withPage({ viewport: { width: 1280, height: 800 }, html }, async (page) => {
        await page.click('.eclaw-refs-icon');
        await page.waitForSelector('.eclaw-refs-icon-title');
        const calls = await page.evaluate(() => window.__capturedFetches);
        assert(calls.length === 1, `fetches=${calls.length}`);
        const call = calls[0];
        const botSecretHeader = Object.entries(call.headers || {})
            .find(([k]) => k.toLowerCase() === 'x-bot-secret')?.[1];
        const deviceSecretHeader = Object.entries(call.headers || {})
            .find(([k]) => k.toLowerCase() === 'x-device-secret')?.[1];
        assert(botSecretHeader === 'bot-test', 'expected X-Bot-Secret header: ' + JSON.stringify(call));
        assert(call.url.includes('entityId=2'), 'expected entityId in URL: ' + call.url);
        assert(!deviceSecretHeader, 'should NOT send X-Device-Secret: ' + JSON.stringify(call));
        assert(!call.url.includes('botSecret='), 'should NOT include botSecret in URL: ' + call.url);
        assert(!call.url.includes('deviceSecret='), 'should NOT include deviceSecret in URL: ' + call.url);
    });
});

test('desktop: chip link href points to portal/kanban for cards and github for spec/PR', async () => {
    await withPage({ viewport: { width: 1280, height: 800 } }, async (page) => {
        await page.click('.eclaw-refs-icon');
        await page.waitForSelector('.eclaw-refs-icon-link');
        const links = await page.$$eval('.eclaw-refs-icon-link', els => els.map(el => ({
            href: el.getAttribute('href'),
            kind: el.dataset.refKind,
            id: el.dataset.refId,
            target: el.getAttribute('target'),
        })));
        const spec = links.find(l => l.kind === 'spec');
        const card = links.find(l => l.kind === 'card');
        const pr = links.find(l => l.kind === 'pr');
        assert(spec && spec.href.includes('github.com') && spec.target === '_blank',
            'spec link: ' + JSON.stringify(spec));
        assert(card && card.href.includes('/portal/kanban.html#card_7579f205'),
            'card link: ' + JSON.stringify(card));
        assert(pr && pr.href.includes('github.com/HankHuang0516/EClaw/pull/3123') && pr.target === '_blank',
            'pr link: ' + JSON.stringify(pr));
    });
});

test('desktop: ESC closes popover and restores focus to ? icon', async () => {
    await withPage({ viewport: { width: 1280, height: 800 } }, async (page) => {
        await page.click('.eclaw-refs-icon');
        await page.waitForSelector('.help-popover');
        await page.keyboard.press('Escape');
        // After ESC the popover fades out (setTimeout 200ms); allow time
        await page.waitForTimeout(300);
        const stillThere = await page.$('.help-popover-visible');
        assert(!stillThere, 'popover should be hidden after ESC');
        const focused = await page.evaluate(() => document.activeElement?.className || '');
        assert(focused.includes('eclaw-refs-icon'),
            'focus restored, was: ' + focused);
    });
});

test('mobile: 390x844 popover renders bottom-sheet variant', async () => {
    await withPage({ viewport: { width: 390, height: 844 } }, async (page) => {
        await page.click('.eclaw-refs-icon');
        await page.waitForSelector('.help-popover');
        const isSheet = await page.evaluate(() => {
            const pop = document.querySelector('.help-popover');
            return pop && pop.classList.contains('help-popover--sheet');
        });
        assert(isSheet, 'help-popover--sheet class should be applied on mobile');
    });
});

test('error path: fetch fails → error message renders', async () => {
    const errStyle = '';
    const html = buildHtml(errStyle).replace(
        'window.fetch = (url, init = {}) => {',
        'window.fetch = (url, init = {}) => { window.__capturedFetches.push({ url: String(url), headers: normalizeHeaders(init) }); return Promise.resolve({ ok: false, status: 500, json: async () => ({}) }); };\nwindow.__unused = () => {'
    );
    await withPage({ viewport: { width: 1280, height: 800 }, html }, async (page) => {
        await page.click('.eclaw-refs-icon');
        await page.waitForSelector('.eclaw-refs-icon-error');
        const txt = await page.textContent('.eclaw-refs-icon-error');
        assert(txt && txt.length > 0, 'error message rendered: ' + txt);
    });
});

// ── Runner ─────────────────────────────────────────────────────────────────
(async () => {
    let pass = 0, fail = 0;
    for (const t of SUITE) {
        try {
            await t.fn();
            console.log(`  ✓ ${t.name}`);
            pass++;
        } catch (e) {
            console.error(`  ✗ ${t.name} — ${e.message}`);
            fail++;
        }
    }
    console.log(`\nrefs-popover.spec.js: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
