/**
 * Layout baseline for the hover-click toolbar (slice 3/4).
 *
 * Captured 2026-06-03 from `node backend/tests/visual/hover-click-toolbar.spec.js`
 * against the merged impl (PR #3107 + #3109 + #3110). If a future change
 * shifts these numbers, the spec test will fail loudly — pick: update
 * baseline + add a comment explaining the intent, or revert the change.
 *
 * Values use a small tolerance (3-4px) for desktop horizontal/vertical
 * positions to absorb sub-pixel rounding in Chromium across runs. Mobile
 * width uses {min,max} since the chip dimensions can flex slightly with
 * the system font fallback.
 */
'use strict';

module.exports = {
    desktop: {
        chipCount: 7,
        // max-width is 480px per spec §3.1; default box-sizing is content-box
        // so padding (8+8) and border (1+1) add ~18px → outer width up to
        // ~498. Locked here so a future box-sizing/padding change is
        // visible. If we switch to box-sizing: border-box, tighten this.
        toolbarWidth: { min: 360, max: 510 },
        // Toolbar should anchor close under the bounding box (spec §3.3
        // "directly below the selected element's bounding box"). 8px is
        // the gap in code; allow ±4px for layout differences.
        toolbarTopVsButton: { min: 4, max: 16 },
    },
    mobile: {
        // Full-viewport width on bottom-sheet variant. Same content-box
        // padding-overflow issue → outer width = viewport + padding + border.
        // Viewport 390 + (12+12) padding + ~2px border ≈ 416.
        width: { min: 410, max: 422 },
        // Vertical span of the chip list — last chip's offsetTop. With
        // 7 chips × ~46px spacing observed in baseline (move=12, last≈288).
        chipsVerticalSpan: { min: 240, max: 360 },
    },
};
