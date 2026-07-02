/**
 * Kanban detail-modal 3 enhancements — card_3651ed7ad8e676d3a4f6a9dc.
 * Contract tests over kanban.html source (maximize / splitter / side chips);
 * interactive behavior is covered by the prod Playwright E2E on the card.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'kanban.html'),
    'utf8'
);
const i18nSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'shared', 'i18n.js'),
    'utf8'
);

function sliceBetween(startNeedle, endNeedle) {
    const start = src.indexOf(startNeedle);
    const end = src.indexOf(endNeedle, start + startNeedle.length);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
}

describe('kanban modal — maximize', () => {
    test('maximize button sits in the modal header with aria-pressed', () => {
        expect(src).toMatch(/<button class="kb-modal-maximize" id="kbModalMaxBtn" onclick="toggleModalMaximize\(\)"[^>]*aria-pressed="false"/);
    });
    test('kb-modal-max class expands to ~95vw/95vh', () => {
        expect(src).toMatch(/\.kb-modal\.kb-modal-max \{ max-width:95vw; width:95vw; height:95vh; max-height:95vh; \}/);
    });
    test('toggle persists to localStorage kb_modal_max and applyModalPrefs restores it', () => {
        expect(src).toMatch(/localStorage\.setItem\('kb_modal_max'/);
        expect(src).toMatch(/localStorage\.getItem\('kb_modal_max'\) === '1'/);
    });
});

describe('kanban modal — splitter', () => {
    test('splitter element has separator role + ns-resize cursor styling', () => {
        expect(src).toMatch(/id="kbModalSplitter" role="separator" aria-orientation="horizontal"/);
        expect(src).toMatch(/\.kb-modal-splitter \{[^}]*cursor:ns-resize/);
    });
    test('meta height is driven by the --kb-meta-h CSS var', () => {
        expect(src).toMatch(/--kb-meta-h:min\(32vh, 260px\)/);
        expect(src).toMatch(/\.kb-modal-meta \{[^}]*max-height:var\(--kb-meta-h\)/);
    });
    test('drag persists px height to kb_modal_split_px with a floor of 80px', () => {
        expect(src).toMatch(/localStorage\.setItem\('kb_modal_split_px'/);
        expect(src).toMatch(/Math\.max\(80, Math\.min\(h, Math\.round\(modal\.clientHeight \* 0\.8\)\)\)/);
    });
    test('keyboard arrows nudge the split (a11y)', () => {
        expect(src).toMatch(/e\.key !== 'ArrowUp' && e\.key !== 'ArrowDown'/);
    });
    test('user split overrides the comments-mode auto-height (kb-user-split escape)', () => {
        expect(src).toMatch(/\.kb-modal\.kb-modal-comments-active:not\(\.kb-user-split\) \.kb-modal-meta \{ max-height:none/);
        expect(src).toMatch(/\.kb-modal\.kb-user-split \.kb-modal-meta \{ max-height:var\(--kb-meta-h\)/);
        expect(src).toMatch(/modal\.classList\.add\('kb-user-split'\)/);
    });
});

describe('kanban modal — side prev/next chips', () => {
    test('both side chips exist, hidden by default', () => {
        expect(src).toMatch(/id="kbSidePrev" style="display:none"/);
        expect(src).toMatch(/id="kbSideNext" style="display:none"/);
    });
    test('openDetail wires chips via updateModalSideChips(card)', () => {
        expect(src).toMatch(/updateModalSideChips\(card\);/);
        expect(src).toMatch(/wire\(sp, card\.linkedPrevCardId/);
        expect(src).toMatch(/wire\(sn, card\.linkedNextCardId/);
    });
    test('chip without a linked id stays display:none (no spacing leak)', () => {
        expect(src).toMatch(/if \(!linkedId\) \{ btn\.style\.display = 'none'; btn\.onclick = null; return; \}/);
    });
    test('chip click switches card via openDetail(linkedId)', () => {
        expect(src).toMatch(/btn\.onclick = \(e\) => \{ e\.stopPropagation\(\); openDetail\(linkedId\); \};/);
    });
});

describe('kanban modal — i18n keys', () => {
    const NEEDED = [
        'kb_modal_maximize', 'kb_modal_restore', 'kb_modal_splitter_aria',
        'kb_modal_prev_card', 'kb_modal_next_card',
    ];
    test.each(NEEDED)('%s is declared in i18n.js', (key) => {
        expect(i18nSrc).toMatch(new RegExp('"' + key + '":'));
    });
});

describe('kanban modal — task relation chips keep screenshot review visible', () => {
    test('relation task chips open linked cards on the screenshots tab', () => {
        const detailChipRow = sliceBetween('function renderDetailLinkChipRow(card)', 'function renderParentArchivedBanner');
        const moveBarSecondary = sliceBetween('function renderTaskSecondaryActions(card)', 'function toggleTaskOverflow');

        expect(src).toMatch(/function openTaskChipDetail\(cardId, event\)/);
        expect(src).toMatch(/openDetail\(cardId, \{ initialTab: 'screenshots' \}\)/);
        expect(src).toMatch(/data-open-tab="\$\{escapeHtml\(opts\.openTab\)\}"/);
        expect(detailChipRow).toMatch(/openTaskChipDetail\('\$\{escapeJs\(parentId\)\}', event\)/);
        expect(detailChipRow).toMatch(/openTaskChipDetail\('\$\{escapeJs\(card\.linkedPrevCardId\)\}', event\)/);
        expect(detailChipRow).toMatch(/openTaskChipDetail\('\$\{escapeJs\(card\.linkedNextCardId\)\}', event\)/);

        // The move-bar secondary row intentionally stays PR/Chat-only, so this
        // guard must be anchored to the real description chip row above.
        expect(moveBarSecondary).not.toMatch(/openTaskChipDetail/);
        expect(moveBarSecondary).not.toMatch(/linkedPrevCardId|linkedNextCardId/);
    });

    test('openDetail selects the requested initial tab instead of always resetting to comments', () => {
        const openDetail = sliceBetween('async function openDetail(cardId, opts = {})', 'function renderDetailTags');

        expect(openDetail).toMatch(/const initialTab = opts && opts\.initialTab === 'screenshots' \? 'screenshots' : 'comments';/);
        expect(openDetail).toMatch(/document\.querySelector\(`\.kb-modal-tab\[data-detail-tab="\$\{initialTab\}"\]`\)/);
        expect(openDetail).toMatch(/switchDetailTab\(initialTab, initialBtn\);/);
        expect(src).toMatch(/data-detail-tab="screenshots" data-i18n="kb_tab_screenshots"/);
    });

    test('screenshots panel keeps the field, thumbnails, and help icon contract', () => {
        const loadScreenshots = sliceBetween('async function loadScreenshots()', 'function openLightbox');

        expect(loadScreenshots).toMatch(/const shots = \(data\.files \|\| \[\]\)\.filter\(f => \(f\.mimeType \|\| f\.mime_type \|\| ''\)\.startsWith\('image\/'\)\);/);
        expect(loadScreenshots).toMatch(/class="kb-ss-banner on"/);
        expect(loadScreenshots).toMatch(/class="kb-ss-help"/);
        expect(loadScreenshots).toMatch(/aria-label="\$\{help\}"/);
        expect(loadScreenshots).toMatch(/class="kb-ss-grid"/);
        expect(loadScreenshots).toMatch(/class="kb-ss-thumb"/);
        expect(loadScreenshots).toMatch(/openLightbox\(this\.dataset\.url, this\.dataset\.name\)/);
    });
});
