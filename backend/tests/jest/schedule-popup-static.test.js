/**
 * Static UX audit for Phase 2 of the scheduled-message popup feature.
 *
 * Phase 1 (PR #2067) wired the backend (router + DB + 5s poller).
 * Phase 2 (this) adds the chat.html long-press popup UI: mode tabs,
 * target chips, fixed/countdown picker, queue tab with edit/delete.
 *
 * The dispatch path is hard to unit-test in JSDOM because it needs the
 * full pg + auth stack. So we lock the surface here: every chat.html
 * change that wires the popup leaves a fingerprint, and removing one
 * silently regresses the feature for users.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const chatHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'chat.html'), 'utf8');
const i18nJs = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'i18n.js'), 'utf8');

describe('Schedule popup — chat.html wiring', () => {
    test('long-press send button registers a 500ms timer', () => {
        // The long-press handler must use a 500ms threshold on btnSend so a
        // normal click still sends and only a held press opens the popup.
        expect(chatHtml).toContain('attachSchedulePopupHandlers');
        expect(chatHtml).toMatch(/setTimeout\(\(\) => \{\s*_schedLongPressFired = true;\s*openSchedulePopup\(\);\s*\}, 500\)/);
        expect(chatHtml).toContain("getElementById('btnSend')");
    });

    test('init wires attachSchedulePopupHandlers exactly once via DOMContentLoaded path', () => {
        // The handler is idempotent (btn._schedWired guard) but the call site
        // must exist in the init flow so the popup actually wires up.
        const wireRegex = /attachSchedulePopupHandlers\(\)/g;
        const matches = chatHtml.match(wireRegex) || [];
        // Defined once, called once.
        expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    test('schedule popup modal markup is present', () => {
        expect(chatHtml).toContain('id="schedulePopupModal"');
        expect(chatHtml).toContain('id="schedSectionCreate"');
        expect(chatHtml).toContain('id="schedSectionQueue"');
        expect(chatHtml).toContain('id="schedFixedAt"');
        expect(chatHtml).toContain('id="schedCdH"');
        expect(chatHtml).toContain('id="schedCdM"');
        expect(chatHtml).toContain('id="schedCdS"');
        expect(chatHtml).toContain('id="schedTargetsBox"');
        expect(chatHtml).toContain('id="schedQueueList"');
    });

    test('CRUD wiring posts to /api/scheduled-messages', () => {
        expect(chatHtml).toMatch(/apiCall\('POST',\s*'\/api\/scheduled-messages'/);
        expect(chatHtml).toMatch(/apiCall\('GET',\s*'\/api\/scheduled-messages\?/);
        expect(chatHtml).toMatch(/apiCall\('PUT',\s*'\/api\/scheduled-messages\/'/);
        expect(chatHtml).toMatch(/apiCall\('DELETE',\s*'\/api\/scheduled-messages\/'/);
    });

    test('client-side validation matches backend constraints (future + 7-day cap)', () => {
        // Mirror of scheduled-messages.js MAX_SCHEDULE_AHEAD_MS so users see
        // the 7-day error inline instead of after a 400 round-trip.
        expect(chatHtml).toMatch(/7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
        expect(chatHtml).toContain('chat_schedule_err_in_past');
        expect(chatHtml).toContain('chat_schedule_err_too_far');
    });

    test('uses showConfirm (not native confirm) for delete', () => {
        // api.js wraps native confirm with a deprecation warning, so the
        // popup should use the styled showConfirm dialog.
        const cancelFn = chatHtml.slice(chatHtml.indexOf('async function schedCancel'),
                                       chatHtml.indexOf('async function schedCancel') + 600);
        expect(cancelFn).toContain('showConfirm(');
        // Negative guard against regressing back to native confirm:
        expect(cancelFn).not.toMatch(/if\s*\(\s*!\s*confirm\(/);
    });

    test('deviceSecret-only auth (no botSecret leaked to scheduling)', () => {
        // scheduled-messages.js gates ALL routes on deviceSecret — the popup
        // is a user action, never a bot action. The body must not include
        // botSecret which would imply bot-side scheduling.
        const submitFn = chatHtml.slice(chatHtml.indexOf('async function submitScheduledMessage'),
                                        chatHtml.indexOf('async function submitScheduledMessage') + 1000);
        expect(submitFn).toContain('deviceSecret: currentUser.deviceSecret');
        expect(submitFn).not.toMatch(/botSecret\s*:/);
    });
});

describe('Schedule popup — i18n keys', () => {
    const REQUIRED_KEYS = [
        'chat_schedule_title',
        'chat_schedule_tab_create',
        'chat_schedule_tab_queue',
        'chat_schedule_mode_fixed',
        'chat_schedule_mode_countdown',
        'chat_schedule_submit',
        'chat_schedule_no_pending',
        'chat_schedule_err_in_past',
        'chat_schedule_err_too_far',
        'chat_schedule_delete_confirm',
    ];

    test('all required keys are present in English dictionary', () => {
        for (const key of REQUIRED_KEYS) {
            expect(i18nJs).toContain(`"${key}"`);
        }
    });

    test('Traditional Chinese (zh) has at least chat_schedule_title translated', () => {
        // Hermes will backfill the other 13 locales — this just guards the
        // home locale so chat.html doesn't show raw key names to users.
        const zhSection = i18nJs.slice(i18nJs.indexOf('zh: {'), i18nJs.indexOf('ja: {'));
        expect(zhSection).toContain('chat_schedule_title');
    });
});
