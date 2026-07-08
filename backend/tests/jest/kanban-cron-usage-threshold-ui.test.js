/**
 * Static UX audit for the schedule-editor usage-threshold sliders
 * (card_d948f8ccc6326cf4370720cf, parent card_ad507345ce19fc5f51c2d814).
 *
 * Two sliders (5h, 7d) added under the existing Enabled toggle let users
 * cap per-card cron dispatch by current entity usage. Backend dispatcher
 * wiring lands separately — this UI just persists the values and shows
 * a live "current usage" hint pulled from /api/usage/snapshot.
 *
 * The sliders exist in TWO call sites (inline schedule tab + legacy
 * editSchedModal), so every fingerprint is double-checked.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const kanbanHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'kanban.html'), 'utf8');

describe('kanban schedule editor — usage-threshold sliders (card_d948f8cc)', () => {
    // Both slider tags must include type="range" + min/max 50-99 — but the
    // attribute order varies between the template-literal site and the
    // static modal site, so we extract the tag and assert attributes.
    function sliderTag(id) {
        const re = new RegExp('<input[^>]*\\bid="' + id + '"[^>]*>');
        const m = kanbanHtml.match(re);
        return m ? m[0] : '';
    }

    test('inline schedule panel renders both range sliders', () => {
        const tag5h = sliderTag('sp-skip-5h');
        const tag7d = sliderTag('sp-skip-7d');
        expect(tag5h).toContain('type="range"');
        expect(tag5h).toContain('min="50"');
        expect(tag5h).toContain('max="99"');
        expect(tag7d).toContain('type="range"');
        expect(tag7d).toContain('min="50"');
        expect(tag7d).toContain('max="99"');
    });

    test('legacy editSchedModal renders both range sliders', () => {
        const tag5h = sliderTag('edit-skip-5h');
        const tag7d = sliderTag('edit-skip-7d');
        expect(tag5h).toContain('type="range"');
        expect(tag5h).toContain('min="50"');
        expect(tag5h).toContain('max="99"');
        expect(tag7d).toContain('type="range"');
        expect(tag7d).toContain('min="50"');
        expect(tag7d).toContain('max="99"');
    });

    test('i18n keys ship as data-i18n attributes for later dict backfill', () => {
        // Hermes/#3/#4 own the i18n dict update in a separate card. The
        // inline EN fallback strings ship now so users see something
        // immediately, but the data-i18n attribute MUST be present so the
        // dict update will pick them up at apply().
        expect(kanbanHtml).toContain('data-i18n="cron_skip_5h_label"');
        expect(kanbanHtml).toContain('data-i18n="cron_skip_7d_label"');
        expect(kanbanHtml).toContain('data-i18n="cron_skip_help_text"');
    });

    test('both save handlers include skipIf5h/skipIf7d in PUT /schedule body', () => {
        // saveSchedulePanel (inline tab)
        expect(kanbanHtml).toMatch(/schedBody\.skipIf5hUsagePctOver\s*=\s*parseInt\(skip5hEl\.value/);
        expect(kanbanHtml).toMatch(/schedBody\.skipIf7dUsagePctOver\s*=\s*parseInt\(skip7dEl\.value/);
        // saveAutoSchedule (legacy modal)
        expect(kanbanHtml).toMatch(/body\.skipIf5hUsagePctOver\s*=\s*parseInt\(editSkip5hEl\.value/);
        expect(kanbanHtml).toMatch(/body\.skipIf7dUsagePctOver\s*=\s*parseInt\(editSkip7dEl\.value/);
    });

    test('both load paths read skipIf5h/skipIf7d off card.schedule with sane defaults', () => {
        // renderSchedulePanel (inline tab)
        expect(kanbanHtml).toMatch(/Number\.isFinite\(sc\.skipIf5hUsagePctOver\)\s*\?\s*sc\.skipIf5hUsagePctOver\s*:\s*85/);
        expect(kanbanHtml).toMatch(/Number\.isFinite\(sc\.skipIf7dUsagePctOver\)\s*\?\s*sc\.skipIf7dUsagePctOver\s*:\s*95/);
        // editAutoSchedule (legacy modal) also reads them and pushes into the inputs
        expect(kanbanHtml).toContain("document.getElementById('edit-skip-5h')");
        expect(kanbanHtml).toContain("document.getElementById('edit-skip-7d')");
    });

    test('live usage hint hits /api/usage/snapshot and degrades silently on failure', () => {
        expect(kanbanHtml).toContain("fetch('/api/usage/snapshot?'");
        // Both target placeholder elements exist so populateCurrentUsageDisplay
        // has somewhere to write the live %s.
        expect(kanbanHtml).toContain('id="sp-cur-5h"');
        expect(kanbanHtml).toContain('id="sp-cur-7d"');
        expect(kanbanHtml).toContain('id="edit-cur-5h"');
        expect(kanbanHtml).toContain('id="edit-cur-7d"');
        // Helper is invoked from both editor entry points.
        const callMatches = (kanbanHtml.match(/populateCurrentUsageDisplay\(\{/g) || []).length;
        expect(callMatches).toBeGreaterThanOrEqual(3); // 1 def + 2 call sites minimum
    });

    test('? icon explainer popover wires toggle handler and inline help text', () => {
        expect(kanbanHtml).toContain('toggleCronSkipHelp');
        // Help-text container exists for BOTH editors so the toggle has a
        // target regardless of which surface the user opens.
        expect(kanbanHtml).toContain('id="sp-cron-skip-help"');
        expect(kanbanHtml).toContain('id="edit-cron-skip-help"');
    });

    test('value-display spans update live via oninput=updateCronSkipDisplay', () => {
        expect(kanbanHtml).toContain('id="sp-skip-5h-val"');
        expect(kanbanHtml).toContain('id="sp-skip-7d-val"');
        expect(kanbanHtml).toContain('id="edit-skip-5h-val"');
        expect(kanbanHtml).toContain('id="edit-skip-7d-val"');
        const oninputMatches = (kanbanHtml.match(/oninput="updateCronSkipDisplay\(\)"/g) || []).length;
        expect(oninputMatches).toBeGreaterThanOrEqual(4);
    });
});
