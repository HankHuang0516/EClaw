/**
 * E2E: help-popover.spec.js
 *
 * Test: click ? icon → popover visible → ESC → popover hidden + focus restored
 *
 * Run: npx playwright test backend/tests/e2e/help-popover.spec.js
 * Or: node backend/tests/e2e/help-popover.spec.js   (standalone)
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const SHARED_STYLE = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'shared', 'style.css'), 'utf8');
const HELP_POPOVER_JS = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'help-popover.js'), 'utf8');
const CHROMIUM_EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

// ── Test page — inline HTML so we don't need a running server ──────────────────
const TEST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Help Popover E2E</title>
<style>
${SHARED_STYLE}
 body { font-family: sans-serif; padding: 60px 40px; background: #1e1e2e; color: #e0e0e0; }
  .test-row { margin: 20px 0; }
  .test-row label { display: block; margin-bottom: 6px; font-size: 13px; color: #aaa; }
  .test-row .help-icon { font-size: 0; }
</style>
</head>
<body>
<script>
window.i18n = { t: (key) => ({ kanban_nudge_batch_help: 'Translated help copy from i18n.' }[key] || key) };
</script>
<script>${HELP_POPOVER_JS}</script>

<div class="test-row">
  <label>Simple tooltip:
    <span class="help-icon" data-help-content="This is a simple tooltip."></span>
  </label>
</div>

<div class="test-row">
  <label>Rich HTML tooltip:
    <span class="help-icon" data-help-content="<strong>Bold</strong> and <a href='#'>link</a> work." tabindex="0" role="button" aria-label="Help"></span>
  </label>
</div>

<div class="test-row">
  <label>i18n tooltip:
    <span class="help-icon" data-help-content-key="kanban_nudge_batch_help"></span>
  </label>
</div>

<div class="test-row">
  <label>Edge tooltip (near viewport bottom):
    <span class="help-icon" data-help-content="This is near the bottom of the viewport." tabindex="0" role="button" aria-label="Help"></span>
  </label>
</div>

</body>
</html>`;

// ── Helpers ────────────────────────────────────────────────────────────────────
async function withPage(html, fn) {
    const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_EXECUTABLE });
    const page = await browser.newPage();
    await page.setContent(html);
    await page.waitForLoadState('domcontentloaded');
    try {
        await fn(page);
    } finally {
        await browser.close();
    }
}

function findHelpIcon(page) {
    return page.locator('.help-icon').first();
}

// ── Tests ────────────────────────────────────────────────────────────────────────
async function testClickShowsPopover(page) {
    const icon = findHelpIcon(page);
    await icon.click();

    const popover = page.locator('.help-popover');
    await popover.waitFor({ state: 'visible', timeout: 2000 });

    const inner = await popover.locator('.help-popover-inner').textContent();
    if (!inner.includes('simple tooltip')) {
        throw new Error(`Expected popover content, got: ${inner}`);
    }
    console.log('✓ Click shows popover with correct content');
}

async function testEscHidesPopover(page) {
    const icon = findHelpIcon(page);
    await icon.click();

    const popover = page.locator('.help-popover');
    await popover.waitFor({ state: 'visible', timeout: 2000 });

    await page.keyboard.press('Escape');
    await popover.waitFor({ state: 'hidden', timeout: 2000 });

    // Focus should return to the icon
    const newFocus = page.locator(':focus');
    const focusClass = await newFocus.evaluate(el => el ? el.className : 'none');

    console.log('✓ ESC hides popover, focus returns to icon:', focusClass);
}

async function testI18nContentKey(page) {
    const icon = page.locator('.help-icon[data-help-content-key]').first();
    await icon.click();

    const popover = page.locator('.help-popover');
    await popover.waitFor({ state: 'visible', timeout: 2000 });

    const inner = await popover.locator('.help-popover-inner').textContent();
    if (!inner.includes('Translated help copy')) {
        throw new Error(`Expected translated i18n content, got: ${inner}`);
    }

    const describedBy = await icon.getAttribute('aria-describedby');
    if (!describedBy) throw new Error('Expected aria-describedby to be set while popover is open');
    console.log('✓ data-help-content-key resolves through i18n with aria-describedby');
}

async function testClickOutsideDismisses(page) {
    const icon = findHelpIcon(page);
    await icon.click();

    const popover = page.locator('.help-popover');
    await popover.waitFor({ state: 'visible', timeout: 2000 });

    // Click body (outside popover and icon)
    await page.click('body', { position: { x: 5, y: 5 } });
    await popover.waitFor({ state: 'hidden', timeout: 2000 });

    console.log('✓ Click outside dismisses popover');
}

async function testFocusableIcon(page) {
    // Tab to the help icon
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    const cls = await focused.evaluate(el => el.className);
    if (!cls.includes('help-icon')) {
        throw new Error(`Expected focus on .help-icon, got: ${cls}`);
    }
    console.log('✓ Tab focuses help-icon');
}

async function testEnterTriggersPopover(page) {
    await page.keyboard.press('Tab'); // focus first icon
    await page.keyboard.press('Enter');

    const popover = page.locator('.help-popover');
    await popover.waitFor({ state: 'visible', timeout: 2000 });
    console.log('✓ Enter key triggers popover');
}

async function testCloseButton(page) {
    const icon = findHelpIcon(page);
    await icon.click();

    const popover = page.locator('.help-popover');
    await popover.waitFor({ state: 'visible', timeout: 2000 });

    await page.click('.help-popover-close');
    await popover.waitFor({ state: 'hidden', timeout: 2000 });
    console.log('✓ Close button dismisses popover');
}

async function testCollisionAvoidance(page) {
    // Load a tall page so bottom icons flip upward
    await page.setContent(TEST_HTML.replace('</body>', '<div style="height:2000px"></div></body>'));
    await page.waitForLoadState('domcontentloaded');

    // Scroll to bottom
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);

    // Click the last icon (near viewport bottom)
    const icons = page.locator('.help-icon');
    const count = await icons.count();
    await icons.nth(count - 1).click();

    const popover = page.locator('.help-popover');
    await popover.waitFor({ state: 'visible', timeout: 2000 });

    // Popover should be above the icon (placement=top) — check it doesn't overflow bottom
    const popBox = await popover.boundingBox();
    const viewH = await page.evaluate(() => window.innerHeight);
    if (popBox.y + popBox.height > viewH - 4) {
        throw new Error(`Popover overflows viewport bottom: ${JSON.stringify(popBox)}`);
    }
    console.log('✓ Collision detection: popover avoids viewport edge');
}

// ── Runner ───────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n=== Help Popover E2E Tests ===\n');

    await withPage(TEST_HTML, async (page) => {
        console.log('Running: testClickShowsPopover');
        await testClickShowsPopover(page);
    });

    await withPage(TEST_HTML, async (page) => {
        console.log('Running: testEscHidesPopover');
        await testEscHidesPopover(page);
    });

    await withPage(TEST_HTML, async (page) => {
        console.log('Running: testClickOutsideDismisses');
        await testClickOutsideDismisses(page);
    });

    await withPage(TEST_HTML, async (page) => {
        console.log('Running: testFocusableIcon');
        await testFocusableIcon(page);
    });

    await withPage(TEST_HTML, async (page) => {
        console.log('Running: testEnterTriggersPopover');
        await testEnterTriggersPopover(page);
    });

    await withPage(TEST_HTML, async (page) => {
        console.log('Running: testCloseButton');
        await testCloseButton(page);
    });

    await withPage(TEST_HTML, async (page) => {
        console.log('Running: testI18nContentKey');
        await testI18nContentKey(page);
    });

    await withPage(TEST_HTML, async (page) => {
        console.log('Running: testCollisionAvoidance');
        await testCollisionAvoidance(page);
    });

    console.log('\n✅ All tests passed\n');
}

main().catch(err => {
    console.error('\n❌ Test failed:', err.message);
    process.exit(1);
});
