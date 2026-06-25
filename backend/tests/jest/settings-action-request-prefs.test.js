const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const settingsHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'settings.html'), 'utf8');
const i18nJs = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'i18n.js'), 'utf8');

describe('settings action request preferences (card_8151054f frontend)', () => {
    test('renders the Needs-you request settings panel with PR #3737 policy and duration prefs', () => {
        expect(settingsHtml).toContain('id="actionRequestSettingsCard"');
        expect(settingsHtml).toContain('id="toggleActionRequestRealtime"');
        expect(settingsHtml).toContain("saveActionRequestRealtimePref(this.checked)");
        expect(settingsHtml).toContain('id="actionRequestTimeoutPolicy"');
        expect(settingsHtml).toContain("saveActionRequestTimeoutPolicy(this.value)");
        expect(settingsHtml).toContain('id="actionRequestTimeoutMinutes"');
        expect(settingsHtml).toContain("saveActionRequestTimeoutMinutes(this.value)");
        expect(settingsHtml).toContain('value="keep"');
        expect(settingsHtml).toContain('value="auto_dismiss"');
        expect(settingsHtml).toContain('value="safe_default"');
        expect(settingsHtml).toContain('value="consensus"');
        expect(settingsHtml).not.toContain('value="escalate"');
        expect(settingsHtml).toContain('min="5" max="43200" step="5" value="1440"');
    });

    test('loads, saves, and socket-applies action request device preferences', () => {
        expect(settingsHtml).toMatch(/function applyActionRequestPrefs\(prefs = \{\}\)/);
        expect(settingsHtml).toContain('prefs.action_request_realtime !== false');
        expect(settingsHtml).toContain('normalizeActionRequestTimeoutPolicy(prefs.action_request_timeout_policy)');
        expect(settingsHtml).toContain('normalizeActionRequestTimeoutMinutes(prefs.action_request_timeout_minutes)');
        expect(settingsHtml).toContain('applyActionRequestPrefs(prefs);');
        expect(settingsHtml).toContain('action_request_realtime: !!enabled');
        expect(settingsHtml).toContain('action_request_timeout_policy: normalizeActionRequestTimeoutPolicy(value)');
        expect(settingsHtml).toContain('action_request_timeout_minutes: normalizeActionRequestTimeoutMinutes(value)');
        expect(settingsHtml).toContain('applyActionRequestPrefs(data.prefs);');
    });

    test('normalizers match backend timeout-policy contract', () => {
        expect(settingsHtml).toContain("const ACTION_REQUEST_TIMEOUT_POLICIES = ['keep', 'auto_dismiss', 'safe_default', 'consensus'];");
        expect(settingsHtml).toContain('const ACTION_REQUEST_TIMEOUT_MINUTES_MIN = 5;');
        expect(settingsHtml).toContain('const ACTION_REQUEST_TIMEOUT_MINUTES_MAX = 43200;');
        expect(settingsHtml).toContain('const ACTION_REQUEST_TIMEOUT_MINUTES_DEFAULT = 1440;');
        expect(settingsHtml).toContain('Math.max(ACTION_REQUEST_TIMEOUT_MINUTES_MIN, Math.min(ACTION_REQUEST_TIMEOUT_MINUTES_MAX, n))');
    });

    test('EN and ZH strings exist for the settings surface', () => {
        [
            'action_request_settings_title',
            'action_request_realtime_label',
            'action_request_timeout_policy_label',
            'action_request_timeout_keep',
            'action_request_timeout_auto_dismiss',
            'action_request_timeout_safe_default',
            'action_request_timeout_consensus',
            'action_request_timeout_minutes_label',
            'action_request_timeout_minutes_desc',
            'action_request_realtime_on',
            'action_request_realtime_off',
        ].forEach(key => {
            expect(i18nJs).toContain(`"${key}"`);
        });
        expect(i18nJs).toContain('"action_request_settings_title": "Needs-you requests"');
        expect(i18nJs).toContain('"action_request_settings_title": "需要你請求"');
    });
});
