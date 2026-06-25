const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const settingsHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'settings.html'), 'utf8');
const i18nJs = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'i18n.js'), 'utf8');

describe('settings action request preferences (card_8151054f frontend)', () => {
    test('renders the Needs-you request settings panel with PR #3732 preference keys', () => {
        expect(settingsHtml).toContain('id="actionRequestSettingsCard"');
        expect(settingsHtml).toContain('id="toggleActionRequestRealtime"');
        expect(settingsHtml).toContain("saveActionRequestRealtimePref(this.checked)");
        expect(settingsHtml).toContain('id="actionRequestTimeoutPolicy"');
        expect(settingsHtml).toContain("saveActionRequestTimeoutPolicy(this.value)");
        expect(settingsHtml).toContain('value="keep"');
        expect(settingsHtml).toContain('value="auto_dismiss"');
        expect(settingsHtml).toContain('value="escalate"');
    });

    test('loads, saves, and socket-applies action request device preferences', () => {
        expect(settingsHtml).toMatch(/function applyActionRequestPrefs\(prefs = \{\}\)/);
        expect(settingsHtml).toContain('prefs.action_request_realtime !== false');
        expect(settingsHtml).toContain('normalizeActionRequestTimeoutPolicy(prefs.action_request_timeout_policy)');
        expect(settingsHtml).toContain('applyActionRequestPrefs(prefs);');
        expect(settingsHtml).toContain('action_request_realtime: !!enabled');
        expect(settingsHtml).toContain('action_request_timeout_policy: normalizeActionRequestTimeoutPolicy(value)');
        expect(settingsHtml).toContain('applyActionRequestPrefs(data.prefs);');
    });

    test('EN and ZH strings exist for the settings surface', () => {
        [
            'action_request_settings_title',
            'action_request_realtime_label',
            'action_request_timeout_policy_label',
            'action_request_timeout_keep',
            'action_request_timeout_auto_dismiss',
            'action_request_timeout_escalate',
            'action_request_realtime_on',
            'action_request_realtime_off',
        ].forEach(key => {
            expect(i18nJs).toContain(`"${key}"`);
        });
        expect(i18nJs).toContain('"action_request_settings_title": "Needs-you requests"');
        expect(i18nJs).toContain('"action_request_settings_title": "需要你請求"');
    });
});
