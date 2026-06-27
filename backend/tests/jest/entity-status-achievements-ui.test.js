/**
 * Achievements UI slice — card_8ca0b6acb1fb3d7a0b650dfd (frontend follow-up
 * to the PR #3290 backend slice). Contract tests over entity-status-panel.js
 * source + i18n key presence; DOM behavior is covered by the prod Playwright
 * E2E attached to the card.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const panelSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'shared', 'entity-status-panel.js'),
    'utf8'
);
const i18nSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'shared', 'i18n.js'),
    'utf8'
);

const AXES = ['tasks_done', 'chat_upvotes', 'chat_downvotes', 'prs_merged', 'cards_reviewed', 'notes_authored'];

describe('entity-status-panel — achievements section contract', () => {
    test('achievements section markup is present between counters and log', () => {
        const counters = panelSrc.indexOf('data-section="counters"');
        const achievements = panelSrc.indexOf('data-section="achievements"');
        const log = panelSrc.indexOf('data-section="log"');
        expect(counters).toBeGreaterThan(-1);
        expect(achievements).toBeGreaterThan(counters);
        expect(log).toBeGreaterThan(achievements);
    });

    test('fetches hit the backend achievement routes', () => {
        expect(panelSrc).toMatch(/\/achievements\?\$\{qs\.toString\(\)\}/);
        expect(panelSrc).toMatch(/\/achievement\/\$\{encodeURIComponent\(axis\)\}\/events/);
    });

    test('renderAchievements rows reuse the counter row shape (style parity)', () => {
        expect(panelSrc).toMatch(/function renderAchievements\(/);
        // same class as counter rows + role/tabindex/aria-expanded + chevron
        const block = panelSrc.slice(panelSrc.indexOf('function renderAchievements'));
        expect(block).toMatch(/__counter-row" data-axis="\$\{escapeHtml\(a\.axis\)\}" data-kind="achievement"/);
        expect(block).toMatch(/role="button" tabindex="0"/);
        expect(block).toMatch(/aria-expanded="false"/);
        expect(block).toMatch(/SVG_CHEVRON/);
    });

    test('click handler branches achievement rows to the achievement drill-down', () => {
        expect(panelSrc).toMatch(/dataset\.kind === 'achievement'/);
        expect(panelSrc).toMatch(/toggleAchievementDrilldown\(root, eid, axis, counterRow\)/);
    });

    test('keyboard Enter/Space also branches on data-kind', () => {
        expect(panelSrc).toMatch(/active\.dataset\.kind === 'achievement'/);
    });

    test('card chips use the src://kanban/card/<bare> preview format', () => {
        const block = panelSrc.slice(panelSrc.indexOf('function renderAchievementEvents'));
        expect(block).toMatch(/src:\/\/kanban\/card\/' \+ bareId/);
        expect(block).toMatch(/data-ref-type="src"/);
    });

    test('chat chips carry data-ref-type="message" with the message id', () => {
        const block = panelSrc.slice(panelSrc.indexOf('function renderAchievementEvents'));
        expect(block).toMatch(/data-ref-type="message" data-ref-id="\$\{escapeHtml\(chip\.messageId\)\}"/);
    });

    test('open() fetches counters and achievements concurrently', () => {
        // card_errctr added the error-history fetch (histP) to the same
        // concurrent batch — counters + achievements + history load together.
        expect(panelSrc).toMatch(/Promise\.all\(\[statusP, achP, histP\]\)/);
    });

    test.each(AXES)('local label fallback covers axis %s in zh + en', (axis) => {
        const zh = panelSrc.indexOf('ACHIEVEMENT_LABELS_ZH');
        const en = panelSrc.indexOf('ACHIEVEMENT_LABELS_EN');
        expect(zh).toBeGreaterThan(-1);
        expect(en).toBeGreaterThan(-1);
        const zhBlock = panelSrc.slice(zh, en);
        const enBlock = panelSrc.slice(en, panelSrc.indexOf('};', en));
        expect(zhBlock).toContain(axis + ':');
        expect(enBlock).toContain(axis + ':');
    });
});

describe('entity-status-panel — achievement i18n keys exist in i18n.js', () => {
    const NEEDED = [
        'entity_status_achievements_section_title',
        ...AXES.map(a => 'entity_status_achievement_' + a),
        'entity_status_achievement_no_events',
    ];
    test.each(NEEDED)('%s is declared', (key) => {
        expect(i18nSrc).toMatch(new RegExp('"' + key + '":'));
    });
});
