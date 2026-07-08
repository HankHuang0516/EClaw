'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const chatHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'chat.html'), 'utf8');

describe('chat target selection safety', () => {
    test('getSelectedTargets does not silently fall back to all entities when every recipient is unchecked', () => {
        const start = chatHtml.indexOf('function getSelectedTargets()');
        expect(start).toBeGreaterThan(0);
        const end = chatHtml.indexOf('// ── Contacts Management ──', start);
        expect(end).toBeGreaterThan(start);
        const body = chatHtml.slice(start, end);

        expect(body).not.toMatch(/boundEntities\.forEach\(\s*e\s*=>\s*local\.push\(e\.entityId\)/);
        expect(body).not.toMatch(/local\.length\s*===\s*0[\s\S]*contactCodes\.length\s*===\s*0[\s\S]*boundEntities/);
    });

    test('sendMessage surfaces the existing select-entity error when no targets are selected', () => {
        const start = chatHtml.indexOf('async function sendMessage()');
        expect(start).toBeGreaterThan(0);
        // Slice to the semantic end-marker (the send-button lookup that immediately
        // follows the no-target guard) instead of a fixed byte window. A fixed window
        // kept breaking when top-of-function code was added (5000->6000 for the
        // multi-quote block card_277c80f5; then the card_2625ae06 abort-restore helper
        // pushed the intact guard past 6000). A semantic marker is shift-proof.
        const end = chatHtml.indexOf("const btn = document.getElementById('btnSend')", start);
        expect(end).toBeGreaterThan(start);
        const body = chatHtml.slice(start, end);

        expect(body).toContain('const targets = getSelectedTargets();');
        expect(body).toMatch(/targets\.local\.length\s*===\s*0\s*&&\s*targets\.contacts\.length\s*===\s*0/);
        expect(body).toContain("showToast(i18n.t('chat_select_entity'), 'error')");
    });
});
