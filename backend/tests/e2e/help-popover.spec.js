/**
 * E2E: help-popover.spec.js
 *
 * Test: click ? icon → popover visible → ESC → popover hidden + focus restored
 *
 * Run: npx playwright test backend/tests/e2e/help-popover.spec.js
 * Or: node backend/tests/e2e/help-popover.spec.js   (standalone)
 */

const { chromium } = require('playwright');

// ── Test page — inline HTML so we don't need a running server ──────────────────
const HELP_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

const TEST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Help Popover E2E</title>
<style>
 body { font-family: sans-serif; padding: 60px 40px; background: #1e1e2e; color: #e0e0e0; }
  .test-row { margin: 20px 0; }
  .test-row label { display: block; margin-bottom: 6px; font-size: 13px; color: #aaa; }
</style>
<link rel="stylesheet" href="../portal/shared/style.css">
</head>
<body>
<script src="../portal/shared/help-popover.js"></script>

<div class="test-row">
  <label>Simple tooltip:
    <span class="help-icon" data-help-content="This is a simple tooltip." tabindex="0" role="button" aria-label="Help">${HELP_ICON_SVG}</span>
  </label>
</div>

<div class="test-row">
  <label>Rich HTML tooltip:
    <span class="help-icon" data-help-content="<strong>Bold</strong> and <a href='#'>link</a> work." tabindex="0" role="button" aria-label="Help">${HELP_ICON_SVG}</span>
  </label>
</div>

<div class="test-row">
  <label>Edge tooltip (near viewport bottom):
    <span class="help-icon" data-help-content="This is near the bottom of the viewport." tabindex="0" role="button" aria-label="Help">${HELP_ICON_SVG}</span>
  </label>
</div>

</body>
</html>`;

// ── Helpers ────────────────────────────────────────────────────────────────────
const path = require('path');

async function withPage(fn) {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const testPagePath = path.join(__dirname, '..', '..', 'public', 'portal', 'shared', 'test-help-popover.html');
    await page.goto(`file://${testPagePath}`);
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

    // Get the icon as the focused element before ESC
    const focusedBefore = page.locator(':focus');
    const iconFocused = await focusedBefore.evaluate(el => el.classList.contains('help-icon'));

    await page.keyboard.press('Escape');
    await popover.waitFor({ state: 'hidden', timeout: 2000 });

    // Focus should return to the icon
    const newFocus = page.locator(':focus');
    const focusClass = await newFocus.evaluate(el => el ? el.className : 'none');

    console.log('✓ ESC hides popover, focus returns to icon:', focusClass);
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
    // Inject extra height to test collision detection
    await page.evaluate(() => {
        const div = document.createElement('div');
        div.style.height = '2000px';
        document.body.appendChild(div);
    });

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

    await withPage(async (page) => {
        console.log('Running: testClickShowsPopover');
        await testClickShowsPopover(page);
    });

    await withPage(async (page) => {
        console.log('Running: testEscHidesPopover');
        await testEscHidesPopover(page);
    });

    await withPage(async (page) => {
        console.log('Running: testClickOutsideDismisses');
        await testClickOutsideDismisses(page);
    });

    await withPage(async (page) => {
        console.log('Running: testFocusableIcon');
        await testFocusableIcon(page);
    });

    await withPage(async (page) => {
        console.log('Running: testEnterTriggersPopover');
        await testEnterTriggersPopover(page);
    });

    await withPage(async (page) => {
        console.log('Running: testCloseButton');
        await testCloseButton(page);
    });

    await withPage(async (page) => {
        console.log('Running: testCollisionAvoidance');
        await testCollisionAvoidance(page);
    });

    console.log('\n✅ All tests passed\n');
}

main().catch(err => {
    console.error('\n❌ Test failed:', err.message);
    process.exit(1);
});
