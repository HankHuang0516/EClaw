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
        // Window widened 5000 -> 6000 (card_277c80f5): the multi-quote block added
        // ~lines to the top of sendMessage, pushing the (intact) no-target guard to
        // ~offset 5100. The guard itself is unchanged; only its position moved.
        const body = chatHtml.slice(start, start + 6000);

        expect(body).toContain('const targets = getSelectedTargets();');
        expect(body).toMatch(/targets\.local\.length\s*===\s*0\s*&&\s*targets\.contacts\.length\s*===\s*0/);
        expect(body).toContain("showToast(i18n.t('chat_select_entity'), 'error')");
    });
});
