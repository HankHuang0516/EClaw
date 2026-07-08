/**
 * Admin hub self-improvement surface — card_84d5811099ae2660fdf8a2c8.
 *
 * Static contract tests keep this page-level slice small: visible entry,
 * actionable fallback paths, ? help UX, Globe-user/setup/empty-state copy, and
 * EN+ZH i18n keys.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const adminHubSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'admin', 'index.html'),
    'utf8'
);
const i18nSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'shared', 'i18n.js'),
    'utf8'
);

describe('admin hub self-improvement surface', () => {
    test('renders a visible self-improvement card with three action paths', () => {
        expect(adminHubSrc).toContain('id="adminSelfImprovementCard"');
        expect(adminHubSrc).toContain('admin_hub_section_self_improvement');
        expect(adminHubSrc).toContain('href="/portal/kanban.html?q=admin%20self%20improvement"');
        expect(adminHubSrc).toContain('href="/portal/feedback.html"');
        expect(adminHubSrc).toContain('copyAdminSelfImprovementBrief()');
    });

    test('has ? help UX with What / Needs / Next step and accessible toggle state', () => {
        expect(adminHubSrc).toMatch(/class="ah-help-btn"[^>]+aria-expanded="false"[^>]+aria-controls="adminSelfHelp"/);
        expect(adminHubSrc).toContain('admin_hub_self_help_what_label');
        expect(adminHubSrc).toContain('admin_hub_self_help_needs_label');
        expect(adminHubSrc).toContain('admin_hub_self_help_next_label');
        expect(adminHubSrc).toContain('toggleAdminSelfHelp');
    });

    test('copy brief template carries Globe-user, Setup, and empty-state prompts without secrets', () => {
        expect(adminHubSrc).toContain('Globe-user: <which role/capability is affected globally; no hardcoded device/entity/user>');
        expect(adminHubSrc).toContain('Setup: <required admin permission/API/runtime condition; graceful degradation if missing>');
        expect(adminHubSrc).toContain('? icon UX: <What this state means / Needs / Next step>');
        const cardStart = adminHubSrc.indexOf('id="adminSelfImprovementCard"');
        // End the slice at the admin-credentials plumbing that follows the card
        // (renamed getAuthQuery -> getAdminCredentials in card_bb9f0e5c). Fall back
        // to the old name, and assert the bounds are sane so a future rename fails
        // LOUD here instead of silently ballooning the slice to EOF (indexOf -> -1,
        // which slice() treats as "up to the last char" and sweeps in the creds fns).
        let cardEnd = adminHubSrc.indexOf('function getAdminCredentials');
        if (cardEnd < 0) cardEnd = adminHubSrc.indexOf('function getAuthQuery');
        expect(cardStart).toBeGreaterThanOrEqual(0);
        expect(cardEnd).toBeGreaterThan(cardStart);
        const selfImprovementSlice = adminHubSrc.slice(cardStart, cardEnd);
        expect(selfImprovementSlice).not.toMatch(/botSecret|deviceSecret|DATABASE_URL|CLOUDFLARE_API_TOKEN/);
    });
});

describe('admin hub self-improvement i18n', () => {
    const keys = [
        'admin_hub_section_self_improvement',
        'admin_hub_card_self_improvement',
        'admin_hub_card_self_improvement_desc',
        'admin_hub_self_open_kanban',
        'admin_hub_self_open_feedback',
        'admin_hub_self_copy_brief',
        'admin_hub_self_help_what_label',
        'admin_hub_self_help_what',
        'admin_hub_self_help_needs_label',
        'admin_hub_self_help_needs',
        'admin_hub_self_help_next_label',
        'admin_hub_self_help_next',
        'admin_hub_self_help_globe',
        'admin_hub_self_help_setup',
        'admin_hub_self_help_empty',
        'admin_hub_self_status_copied',
        'admin_hub_self_status_copy_failed',
    ];

    test.each(keys)('%s exists in EN + ZH locales', (key) => {
        const matches = i18nSrc.match(new RegExp('"' + key + '":', 'g')) || [];
        // EN + Traditional ZH + Simplified ZH.
        expect(matches.length).toBeGreaterThanOrEqual(3);
    });
});
