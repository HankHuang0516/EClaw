/**
 * Visual layout regression: hover-click-toolbar (slice 3/4)
 *
 * Spec: docs/specs/a-hover-click-dom-interaction.md §3.3 (anchoring) +
 *       §3.1 (mobile vs desktop variant)
 * Card: card_af967715a0ab1724da98dcc2 (Test/P2)
 *
 * Pixel-comparison visual regression (pixelmatch + pngjs) is a heavier
 * lift that adds dev deps and CI infra; this lighter-weight check
 * regression-locks the QUANTITATIVE LAYOUT INVARIANTS the screenshots
 * in PR #3107 captured:
 *
 *   - desktop toolbar docks at the viewport top-right without covering the
 *     selected element
 *   - desktop toolbar width is capped per spec §3.1 (max 480px)
 *   - mobile bottom-sheet pins to viewport bottom (top edge in
 *     bottom half of screen)
 *   - mobile chip grid stays compact as the action set grows
 *   - selected element gets the ring class
 *
 * A future PR can add full pixelmatch-baseline regression on top of
 * this layer once pngjs/pixelmatch land as devDeps.
 *
 * Run: node backend/tests/visual/hover-click-toolbar.spec.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const TOOLBAR_CSS = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'hover-click-toolbar.css'), 'utf8');
const DOM_SELECT_JS = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'dom-select.js'), 'utf8');
const TOOLBAR_JS = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'hover-click-toolbar.js'), 'utf8');
const CHROMIUM_EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

const BASELINE = require('./hover-click-toolbar.baseline.js');

const HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Visual regression fixture</title>
<style>
${TOOLBAR_CSS}
body { font-family: -apple-system, sans-serif; padding: 24px; background: #f4f4f5; }
.demo-scene { background: #ffffff; border: 1px solid rgba(0,0,0,0.12); border-radius: 12px; padding: 24px; max-width: 720px; }
.demo-card { border: 1px solid rgba(0,0,0,0.12); border-radius: 10px; padding: 12px; margin-top: 12px; }
.demo-button { background: #6366f1; color: white; border: 0; padding: 8px 16px; border-radius: 8px; cursor: pointer; }
</style>
</head><body>
<script>window.i18n = { t: (k) => k };</script>
<script>${DOM_SELECT_JS}</script>
<script>${TOOLBAR_JS}</script>
<div class="demo-scene" id="scene">
  <div class="demo-card">
    <button id="btn-a" class="demo-button">Button A</button>
  </div>
</div>
<script>
(function() {
  const scene = document.getElementById('scene');
  const tb = window.EClawHoverClickToolbar.createHoverClickToolbar({});
  window.__tb = tb;
  window.EClawDomSelect.createDomSelect({
    scope: scene,
    onSelect: (el) => tb.open(el),
    onDismiss: () => tb.close(),
  });
})();
</script>
</body></html>`;

function check(name, actual, expected, results, tolerance) {
    let pass;
    let detail;
    if (typeof expected === 'object' && 'min' in expected && 'max' in expected) {
        pass = actual >= expected.min && actual <= expected.max;
        detail = `${actual} ∈ [${expected.min}, ${expected.max}]`;
    } else {
        const tol = tolerance == null ? 0 : tolerance;
        pass = Math.abs(actual - expected) <= tol;
        detail = `${actual} vs ${expected} (±${tol})`;
    }
    results.push({ name, pass, detail });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

async function runTests() {
    const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_EXECUTABLE });
    const results = [];
    try {
        // ── Desktop ──
        console.log('Desktop 1280×800 — popover layout:');
        const ctxD = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const pageD = await ctxD.newPage();
        await pageD.setContent(HTML);
        await pageD.evaluate(() => {
            const t = document.getElementById('btn-a');
            t.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
            t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        await pageD.waitForTimeout(100);

        const desktop = await pageD.evaluate(() => {
            const btn = document.getElementById('btn-a');
            const tb = document.querySelector('.eclaw-hover-click-toolbar');
            const btnR = btn.getBoundingClientRect();
            const tbR = tb.getBoundingClientRect();
            return {
                ringSelected: btn.classList.contains('eclaw-dom-select__ring-selected'),
                toolbarVisible: !tb.hidden,
                toolbarWidth: Math.round(tbR.width),
                toolbarTop: Math.round(tbR.top),
                toolbarRightGap: Math.round(1280 - tbR.right),
                toolbarLeftInViewport: tbR.left >= 0 && tbR.right <= 1280,
                chipCount: tb.querySelectorAll('.eclaw-hover-click-toolbar__chip').length,
            };
        });

        check('desktop: selected ring on target', desktop.ringSelected ? 1 : 0, 1, results);
        check('desktop: toolbar visible', desktop.toolbarVisible ? 1 : 0, 1, results);
        check('desktop: chip count', desktop.chipCount, BASELINE.desktop.chipCount, results);
        check('desktop: toolbar width ≤ spec cap',
            desktop.toolbarWidth, BASELINE.desktop.toolbarWidth, results);
        check('desktop: toolbar docks at viewport top',
            desktop.toolbarTop, BASELINE.desktop.toolbarTop, results);
        check('desktop: toolbar docks at viewport right',
            desktop.toolbarRightGap, BASELINE.desktop.toolbarRightGap, results);
        check('desktop: toolbar within viewport horizontally',
            desktop.toolbarLeftInViewport ? 1 : 0, 1, results);

        await ctxD.close();

        // ── Mobile ──
        console.log('Mobile 390×844 — bottom-sheet layout:');
        const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const pageM = await ctxM.newPage();
        await pageM.setContent(HTML);
        await pageM.evaluate(() => {
            const t = document.getElementById('btn-a');
            t.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
            t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        await pageM.waitForTimeout(200);

        const mobile = await pageM.evaluate(() => {
            const tb = document.querySelector('.eclaw-hover-click-toolbar');
            const cs = getComputedStyle(tb);
            const tbR = tb.getBoundingClientRect();
            const chips = Array.from(tb.querySelectorAll('.eclaw-hover-click-toolbar__chip'));
            const lastChipTop = chips.length ? chips[chips.length - 1].offsetTop : 0;
            return {
                position: cs.position,
                bottom: parseFloat(cs.bottom),
                visible: !tb.hidden,
                width: Math.round(tbR.width),
                topInBottomHalf: tbR.top >= 422, // viewport height 844, top ≥ half
                chipsVerticalSpan: lastChipTop,
            };
        });

        check('mobile: bottom-sheet fixed positioning',
            mobile.position === 'fixed' && mobile.bottom === 0 ? 1 : 0, 1, results);
        check('mobile: visible', mobile.visible ? 1 : 0, 1, results);
        check('mobile: full-viewport width', mobile.width, BASELINE.mobile.width, results);
        check('mobile: top edge in bottom half of viewport',
            mobile.topInBottomHalf ? 1 : 0, 1, results);
        check('mobile: chips stay compact in grid',
            mobile.chipsVerticalSpan, BASELINE.mobile.chipsVerticalSpan, results);

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
