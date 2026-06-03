/**
 * E2E: hover-click-dom.spec.js
 *
 * Test: DOM hover/click selection -> toolbar -> mutation diff, including
 * desktop dismissal/focus, mobile long-press bottom sheet, and portal import.
 *
 * Run: node backend/tests/e2e/hover-click-dom.spec.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const TOOLBAR_CSS = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'hover-click-toolbar.css'), 'utf8');
const DOM_SELECT_JS = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'dom-select.js'), 'utf8');
const TOOLBAR_JS = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'hover-click-toolbar.js'), 'utf8');
const CONTENT_IMPORT_JS = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'content-import.js'), 'utf8');
const DIFF_FORMAT_JS = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'diff-format.js'), 'utf8');
const CHROMIUM_EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

function scriptTag(src) {
    return `<script>${src.replace(/<\/script/gi, '<\\/script')}</script>`;
}

function harnessHtml(extra = '') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hover Click DOM E2E</title>
<style>
${TOOLBAR_CSS}
* { box-sizing: border-box; }
body { font-family: Arial, sans-serif; margin: 0; padding: 20px; color: #18181b; background: #f4f4f5; }
#outside { width: 140px; height: 36px; margin-bottom: 18px; background: #e4e4e7; border: 1px solid #d4d4d8; }
.demo-scene { background: white; border: 1px solid rgba(0,0,0,0.12); border-radius: 12px; padding: 24px; max-width: 720px; }
.demo-card { border: 1px solid rgba(0,0,0,0.12); border-radius: 10px; padding: 14px; margin-top: 12px; background: #fafafa; }
.demo-button { background: #6366f1; color: #fff; border: 0; border-radius: 8px; padding: 8px 16px; cursor: pointer; font-size: 14px; }
.demo-button.secondary { background: #fff; color: #18181b; border: 1px solid rgba(0,0,0,0.12); }
.status-bar { margin-top: 16px; padding: 12px; background: #eef2ff; border-radius: 8px; max-width: 720px; }
.mutation-log { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
#importMount { margin-top: 18px; }
</style>
</head>
<body>
<div id="outside" tabindex="0">Outside</div>
<main class="demo-scene" id="scene">
  <h1>Hover-click scene</h1>
  <section class="demo-card" id="primaryCard">
    <p>Pick this card or one of its buttons.</p>
    <button id="primaryAction" class="demo-button" type="button" data-testid="primary-cta">Primary action</button>
    <button id="secondaryAction" class="demo-button secondary" type="button" data-testid="secondary-cta">Secondary</button>
  </section>
  <section class="demo-card" id="secondCard">
    <p>Second card for duplicate/delete actions.</p>
    <button id="anotherAction" class="demo-button" type="button">Another</button>
  </section>
</main>
<div id="importMount"></div>
<div class="status-bar">
  <strong>Last diff summary:</strong> <span id="summary">-</span>
  <pre class="mutation-log" id="log"></pre>
</div>
${scriptTag(DOM_SELECT_JS)}
${scriptTag(TOOLBAR_JS)}
${scriptTag(CONTENT_IMPORT_JS)}
${scriptTag(DIFF_FORMAT_JS)}
<script>
window.i18n = { t: (key) => ({
  'hover_click.toolbar_label': 'Element actions',
  'hover_click.chip_move': 'Move',
  'hover_click.chip_resize': 'Resize',
  'hover_click.chip_style': 'Style',
  'hover_click.chip_duplicate': 'Duplicate',
  'hover_click.chip_delete': 'Delete',
  'hover_click.chip_inspect': 'Inspect',
  'hover_click.chip_info': 'Info',
  'hover_click.chip_close_aria': 'Close toolbar',
  'hover_click.aria_selected': 'Selected',
  'hover_click.aria_long_press_selected': 'Long press selected',
  'hover_click.style_prompt_color': 'Set color',
  'hover_click.delete_ghost_label': 'Deleted - undo?',
  'hover_click.delete_ghost_undo': 'Undo',
}[key] || key) };

(function () {
  const scene = document.getElementById('scene');
  const summaryEl = document.getElementById('summary');
  const logEl = document.getElementById('log');
  const state = { events: [], sourceContext: { kind: 'portal', url: window.location.href } };

  function refreshDiff() {
    const result = window.EClawDiffFormat.produce(state.toolbar.getMutations(), state.sourceContext);
    state.lastDiff = result;
    summaryEl.textContent = result.summary;
    logEl.textContent = result.unified;
  }

  state.toolbar = window.EClawHoverClickToolbar.createHoverClickToolbar({
    onMutation: refreshDiff,
    onClose: () => state.events.push('toolbar:close'),
  });
  state.dom = window.EClawDomSelect.createDomSelect({
    scope: scene,
    onPreview: (el) => state.events.push('preview:' + (el.id || el.className || el.tagName)),
    onSelect: (el) => {
      state.events.push('select:' + (el.id || el.className || el.tagName));
      state.toolbar.open(el);
    },
    onDismiss: () => {
      state.events.push('dom:dismiss');
      state.toolbar.close();
    },
  });

  window.__hoverClickE2E = state;
})();
</script>
${extra}
</body>
</html>`;
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function withPage(opts, fn) {
    const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_EXECUTABLE });
    const page = await browser.newPage({ viewport: opts.viewport || { width: 1280, height: 800 } });
    try {
        if (opts.route) await opts.route(page);
        if (opts.url) {
            await page.goto(opts.url);
        } else {
            await page.setContent(harnessHtml(opts.extraHtml || ''));
        }
        await page.waitForLoadState('domcontentloaded');
        await fn(page);
    } finally {
        await browser.close();
    }
}

async function expectToolbarVisible(page) {
    const toolbar = page.locator('.eclaw-hover-click-toolbar:not([hidden])');
    await toolbar.waitFor({ state: 'visible', timeout: 2000 });
    await page.waitForFunction(() => document.activeElement && document.activeElement.dataset.chip === 'move');
    return toolbar;
}

async function testDesktopDomSelectDismissAndFocus(page) {
    const cta = page.locator('#primaryAction');
    await cta.hover();
    assert(await cta.evaluate(el => el.classList.contains('eclaw-dom-select__ring-preview')), 'hover should add preview ring');

    await cta.click();
    await expectToolbarVisible(page);
    assert(await cta.evaluate(el => el.classList.contains('eclaw-dom-select__ring-selected')), 'click should commit selected ring');

    const liveText = await page.locator('[aria-live="polite"]').textContent();
    assert(liveText.includes('Selected: button#primaryAction'), `expected aria-live selection, got ${liveText}`);

    await cta.click({ modifiers: ['Alt'] });
    const selectedId = await page.evaluate(() => window.__hoverClickE2E.dom.getSelected().id);
    assert(selectedId === 'primaryCard', `Alt+Click should walk to parent, got ${selectedId}`);

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.eclaw-hover-click-toolbar:not([hidden])'));
    assert(await page.locator('#primaryCard').evaluate(el => !el.classList.contains('eclaw-dom-select__ring-selected')), 'Esc should clear selected ring');
    assert(await page.evaluate(() => document.activeElement && document.activeElement.id === 'primaryCard'), 'Esc should restore focus to selected element');

    await cta.click();
    await expectToolbarVisible(page);
    await page.mouse.click(6, 6);
    await page.waitForFunction(() => !document.querySelector('.eclaw-hover-click-toolbar:not([hidden])'));
    assert(await cta.evaluate(el => !el.classList.contains('eclaw-dom-select__ring-selected')), 'outside click should clear selected ring');

    console.log('ok Desktop DOM select hover/click, Alt+Click, Esc focus, outside dismiss');
}

async function testToolbarStyleDuplicateDelete(page) {
    const cta = page.locator('#primaryAction');
    await cta.click();
    await expectToolbarVisible(page);

    page.once('dialog', dialog => dialog.accept('rebeccapurple'));
    await page.locator('[data-chip="style"]').click();
    await page.waitForFunction(() => document.getElementById('summary').textContent.includes('button#primaryAction (color)'));
    const color = await cta.evaluate(el => getComputedStyle(el).color);
    assert(color === 'rgb(102, 51, 153)', `Style chip should apply rebeccapurple, got ${color}`);
    assert((await page.locator('#log').textContent()).includes('rebeccapurple'), 'style mutation should render unified diff text');

    await page.locator('[data-chip="duplicate"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#primaryCard #primaryAction').length === 2);
    await page.waitForFunction(() => document.getElementById('summary').textContent.includes('duplicate'));

    await page.locator('#secondaryAction').click();
    await expectToolbarVisible(page);
    await page.locator('[data-chip="delete"]').click();
    const ghost = page.locator('.eclaw-hover-click-toolbar__ghost-delete');
    await ghost.waitFor({ state: 'visible', timeout: 2000 });
    await page.locator('.eclaw-hover-click-toolbar__ghost-undo').click();
    await page.waitForSelector('#secondaryAction');
    assert(await page.locator('#secondaryAction').isVisible(), 'Undo should restore deleted target');

    console.log('ok Toolbar style, duplicate, and delete undo flows');
}

async function testMobileLongPressBottomSheet(page) {
    const cta = page.locator('#primaryAction');
    await cta.dispatchEvent('touchstart');
    await page.waitForTimeout(550);
    await cta.dispatchEvent('touchend');

    const toolbar = await expectToolbarVisible(page);
    await page.waitForTimeout(250);
    const box = await toolbar.boundingBox();
    assert(box.width >= 380, `mobile toolbar should span viewport, got width ${box.width}`);
    assert(box.y > 430, `mobile toolbar should render as bottom sheet, got y ${box.y}`);
    assert(await cta.evaluate(el => el.classList.contains('eclaw-dom-select__ring-selected')), 'long press should commit selected ring');

    const liveText = await page.locator('[aria-live="polite"]').textContent();
    assert(liveText.includes('Long press selected: button#primaryAction'), `expected long-press aria-live, got ${liveText}`);

    console.log('ok Mobile long-press opens bottom-sheet toolbar');
}

async function testPortalImportDomSelectFlow(page) {
    await page.evaluate(async () => {
        const imported = await window.EClawContentImport.importContent({
            kind: 'portal',
            path: '/portal/import-fixture.html',
        });
        document.getElementById('importMount').appendChild(imported.rootEl);

        const state = { sourceContext: imported.sourceContext };
        state.toolbar = window.EClawHoverClickToolbar.createHoverClickToolbar({
            onMutation: () => {
                state.lastDiff = window.EClawDiffFormat.produce(
                    state.toolbar.getMutations(),
                    state.sourceContext,
                    imported.sourceMap
                );
                document.getElementById('summary').textContent = state.lastDiff.summary;
                document.getElementById('log').textContent = state.lastDiff.unified;
            },
        });
        state.dom = window.EClawDomSelect.createDomSelect({
            scope: imported.rootEl,
            onSelect: (el) => state.toolbar.open(el),
            onDismiss: () => state.toolbar.close(),
        });
        window.__importE2E = state;
    });

    const importedButton = page.locator('#importedAction');
    await importedButton.click();
    await expectToolbarVisible(page);

    page.once('dialog', dialog => dialog.accept('#123456'));
    await page.locator('.eclaw-hover-click-toolbar').last().locator('[data-chip="style"]').click();
    await page.waitForFunction(() => window.__importE2E.lastDiff && window.__importE2E.lastDiff.unified.includes('/portal/import-fixture.html'));
    assert(await importedButton.evaluate(el => getComputedStyle(el).color === 'rgb(18, 52, 86)'), 'imported DOM target should accept toolbar style mutation');

    console.log('ok Portal import root supports DOM select + toolbar diff flow');
}

async function main() {
    console.log('\n=== Hover-click DOM E2E Tests ===\n');

    await withPage({}, testDesktopDomSelectDismissAndFocus);
    await withPage({}, testToolbarStyleDuplicateDelete);
    await withPage({ viewport: { width: 390, height: 844 } }, testMobileLongPressBottomSheet);
    await withPage({
        url: 'http://eclaw.test/harness',
        route: async (page) => {
            await page.route('http://eclaw.test/harness', route => route.fulfill({
                status: 200,
                contentType: 'text/html',
                body: harnessHtml(),
            }));
            await page.route('http://eclaw.test/portal/import-fixture.html', route => route.fulfill({
                status: 200,
                contentType: 'text/html',
                body: '<!DOCTYPE html><html><body><section id="importedScene"><button id="importedAction" class="demo-button" type="button">Imported CTA</button></section></body></html>',
            }));
        },
    }, testPortalImportDomSelectFlow);

    console.log('\nAll hover-click DOM E2E tests passed\n');
}

main().catch(err => {
    console.error('\nTest failed:', err.message);
    process.exit(1);
});
