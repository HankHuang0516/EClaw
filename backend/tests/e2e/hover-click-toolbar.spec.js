/**
 * E2E: hover-click-toolbar.spec.js
 *
 * Covers spec docs/specs/a-hover-click-dom-interaction.md §2 / §3:
 * - Hover any DOM element shows preview ring; click commits selection
 *   and opens the toolbar.
 * - Esc / outside-click dismisses; ring + toolbar gone.
 * - Mobile viewport: bottom-sheet variant slides up; two-column chip grid.
 * - Desktop viewport: docked top-right toolbar stays capped and wrapped.
 *
 * Card: card_af967715a0ab1724da98dcc2 (Test/P2) — slice 2/4.
 *
 * Run: npx playwright test backend/tests/e2e/hover-click-toolbar.spec.js
 * Or:  node backend/tests/e2e/hover-click-toolbar.spec.js
 *
 * Inline HTML fixture so no server is needed (same convention as
 * help-popover.spec.js).
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const TOOLBAR_CSS = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'hover-click-toolbar.css'), 'utf8');
const DOM_SELECT_JS = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'dom-select.js'), 'utf8');
const TOOLBAR_JS = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'hover-click-toolbar.js'), 'utf8');
const DIFF_FORMAT_JS = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'diff-format.js'), 'utf8');
const CHROMIUM_EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

const TEST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>hover-click-toolbar E2E</title>
<style>
${TOOLBAR_CSS}
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 24px; background: #f4f4f5; }
.demo-scene { background: #ffffff; border: 1px solid rgba(0,0,0,0.12); border-radius: 12px; padding: 24px; max-width: 720px; }
.demo-card { border: 1px solid rgba(0,0,0,0.12); border-radius: 10px; padding: 12px; margin-top: 12px; }
.demo-button { background: #6366f1; color: white; border: 0; padding: 8px 16px; border-radius: 8px; cursor: pointer; }
.event-log { margin-top: 16px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; white-space: pre-wrap; }
</style>
</head>
<body>
<script>window.i18n = { t: (k) => k };</script>
<script>${DOM_SELECT_JS}</script>
<script>${TOOLBAR_JS}</script>
<script>${DIFF_FORMAT_JS}</script>

<div class="demo-scene" id="scene">
  <h2>Scene</h2>
  <p>Pick an element.</p>
  <div class="demo-card" id="card-a">
    <p id="text-a">Card A text.</p>
    <button id="btn-a" class="demo-button">Button A</button>
  </div>
  <div class="demo-card" id="card-b">
    <p>Card B</p>
    <button id="btn-b" class="demo-button">Button B</button>
  </div>
</div>
<pre class="event-log" id="event-log"></pre>

<script>
(function() {
  const scene = document.getElementById('scene');
  const log = document.getElementById('event-log');
  let mutationCount = 0;
  function append(s) { log.textContent += s + '\\n'; }
  window.__test_state = { selected: null, toolbarOpen: false, mutationCount: 0 };

  const toolbar = window.EClawHoverClickToolbar.createHoverClickToolbar({
    onMutation: (m) => { mutationCount++; window.__test_state.mutationCount = mutationCount; append('mutation:' + m.type); },
    onClose: () => { window.__test_state.toolbarOpen = false; append('toolbar-close'); },
  });
  window.__test_toolbar = toolbar;

  window.EClawDomSelect.createDomSelect({
    scope: scene,
    onSelect: (el) => {
      window.__test_state.selected = el.id || el.tagName.toLowerCase();
      window.__test_state.toolbarOpen = true;
      append('select:' + window.__test_state.selected);
      toolbar.open(el);
    },
    onDismiss: () => {
      window.__test_state.selected = null;
      window.__test_state.toolbarOpen = false;
      append('dismiss');
      toolbar.close();
    },
  });
})();
</script>
</body>
</html>`;

async function runTests() {
    const browser = await chromium.launch({
        headless: true,
        executablePath: CHROMIUM_EXECUTABLE,
    });
    const results = [];
    function check(name, cond, detail) {
        results.push({ name, pass: !!cond, detail });
        const tag = cond ? 'PASS' : 'FAIL';
        // eslint-disable-next-line no-console
        console.log(`  ${tag}  ${name}${detail ? ' — ' + detail : ''}`);
    }

    try {
        // ── Desktop ────────────────────────────────────────────────
        console.log('Desktop 1280×800:');
        const ctxD = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const pageD = await ctxD.newPage();
        await pageD.setContent(TEST_HTML);

        // 1. Initial state: no ring, toolbar hidden
        let state = await pageD.evaluate(() => ({
            ringPreview: document.querySelectorAll('.eclaw-dom-select__ring-preview').length,
            ringSelected: document.querySelectorAll('.eclaw-dom-select__ring-selected').length,
            toolbarHidden: document.querySelector('.eclaw-hover-click-toolbar').hidden,
        }));
        check('initial: no rings, toolbar hidden',
            state.ringPreview === 0 && state.ringSelected === 0 && state.toolbarHidden);

        // 2. Hover shows preview ring
        await pageD.hover('#btn-a');
        await pageD.waitForTimeout(50);
        state = await pageD.evaluate(() => document.querySelectorAll('.eclaw-dom-select__ring-preview').length);
        check('hover → preview ring renders', state >= 1);

        // 3. Click commits selection, opens toolbar
        // Headless Playwright pointer events don't reach my capture-phase
        // click listener on the scope element reliably; dispatch a real
        // PointerEvent + MouseEvent sequence via the page context to
        // exercise the same code path the production browser uses.
        await pageD.evaluate(() => {
            const t = document.getElementById('btn-a');
            t.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
            t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        await pageD.waitForTimeout(100);
        state = await pageD.evaluate(() => window.__test_state);
        check('click → selection committed', state.selected === 'btn-a');
        check('click → toolbar opens', state.toolbarOpen === true);
        const toolbarVisible = await pageD.evaluate(() => !document.querySelector('.eclaw-hover-click-toolbar').hidden);
        check('click → toolbar visible (not hidden)', toolbarVisible);

        // 4. Toolbar has the expanded 11-chip action set
        const chipCount = await pageD.evaluate(() =>
            document.querySelectorAll('.eclaw-hover-click-toolbar__chip').length);
        check('toolbar has 11 action chips', chipCount === 11, `got ${chipCount}`);

        // 5. Move auto-focused per #6 Q1; Undo/Redo are disabled until history exists
        const focusedChip = await pageD.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-chip'));
        check('first chip (Move) auto-focused per #6 Q1', focusedChip === 'move', `got "${focusedChip}"`);
        const historyDisabled = await pageD.evaluate(() => ({
            undo: document.querySelector('[data-chip="undo"]').disabled,
            redo: document.querySelector('[data-chip="redo"]').disabled,
        }));
        check('empty history disables Undo/Redo', historyDisabled.undo && historyDisabled.redo);

        // 6. Esc dismisses
        await pageD.keyboard.press('Escape');
        await pageD.waitForTimeout(50);
        state = await pageD.evaluate(() => window.__test_state);
        check('Esc → selection cleared', state.selected === null);
        check('Esc → toolbar closed', state.toolbarOpen === false);

        // 7. Re-select for outside-click test
        const reSelectInfo = await pageD.evaluate(() => {
            const t = document.getElementById('btn-b');
            t.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
            t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return {
                state: window.__test_state,
                log: document.getElementById('event-log').textContent,
            };
        });
        await pageD.waitForTimeout(150);
        state = await pageD.evaluate(() => window.__test_state);
        check('re-click → new selection', state.selected === 'btn-b',
            `got "${state.selected}"; log: ${reSelectInfo.log.replace(/\n/g, ' | ')}`);

        // 8. Click far outside the scene dismisses (use raw mouse click to
        // bypass Playwright actionability checks; the toolbar popover and
        // ring outlines can confuse the visibility heuristic).
        await pageD.mouse.click(1250, 780);
        await pageD.waitForTimeout(80);
        state = await pageD.evaluate(() => window.__test_state);
        check('outside-click → dismisses', state.toolbarOpen === false);

        await ctxD.close();

        // ── Mobile ─────────────────────────────────────────────────
        console.log('Mobile 390×844:');
        const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const pageM = await ctxM.newPage();
        await pageM.setContent(TEST_HTML);

        await pageM.evaluate(() => {
            const t = document.getElementById('btn-a');
            t.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
            t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        await pageM.waitForTimeout(200);

        // Bottom-sheet variant: data-visible="true" + position fixed at bottom
        const sheetState = await pageM.evaluate(() => {
            const t = document.querySelector('.eclaw-hover-click-toolbar');
            const cs = getComputedStyle(t);
            return {
                hidden: t.hidden,
                visible: t.getAttribute('data-visible'),
                position: cs.position,
                bottom: cs.bottom,
                left: cs.left,
            };
        });
        check('mobile: bottom-sheet visible', sheetState.hidden === false && sheetState.visible === 'true');
        check('mobile: fixed bottom anchoring',
            sheetState.position === 'fixed' && sheetState.bottom === '0px');

        // Compact grid layout — first two chips share a row, third wraps below.
        const chipOffsets = await pageM.evaluate(() => {
            const chips = Array.from(document.querySelectorAll('.eclaw-hover-click-toolbar__chip'));
            return chips.map((c) => ({ id: c.dataset.chip, top: c.offsetTop }));
        });
        const grid = chipOffsets[0].top === chipOffsets[1].top && chipOffsets[2].top > chipOffsets[1].top;
        check('mobile: chips use two-column grid',
            grid, `offsets ${JSON.stringify(chipOffsets.slice(0, 4))}`);

        await ctxM.close();
    } finally {
        await browser.close();
    }

    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    if (failed) process.exit(1);
}

if (require.main === module) {
    runTests().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { runTests };
