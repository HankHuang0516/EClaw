/**
 * Layout baseline for the hover-click toolbar (slice 3/4).
 *
 * Captured 2026-06-20 from `node backend/tests/visual/hover-click-toolbar.spec.js`
 * after the toolbar expanded to 11 chips. If a future change shifts these
 * numbers, the spec test will fail loudly — pick: update baseline + add a
 * comment explaining the intent, or revert the change.
 *
 * Values use a small tolerance (3-4px) for desktop horizontal/vertical
 * positions to absorb sub-pixel rounding in Chromium across runs. Mobile
 * width uses {min,max} since the chip dimensions can flex slightly with
 * the system font fallback.
 */
'use strict';

module.exports = {
    desktop: {
        chipCount: 11,
        // Desktop is intentionally docked near the viewport top-right so it
        // does not cover the selected element. The shell uses border-box
        // sizing and a 480px cap.
        toolbarWidth: { min: 430, max: 490 },
        toolbarTop: { min: 12, max: 20 },
        toolbarRightGap: { min: 12, max: 20 },
    },
    mobile: {
        // Full-viewport width on bottom-sheet variant with border-box sizing.
        width: { min: 386, max: 394 },
        // Two-column grid keeps the expanded 11-chip set compact.
        chipsVerticalSpan: { min: 220, max: 360 },
    },
};
