'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const chatHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'chat.html'), 'utf8');
const indexJs = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');

describe('chat.html initial render order', () => {
    test('loadMessages renders chat history before cross-device label lookups', () => {
        const start = chatHtml.indexOf('async function loadMessages()');
        expect(start).toBeGreaterThan(0);
        const end = chatHtml.indexOf('// ── Filtering ──', start);
        expect(end).toBeGreaterThan(start);
        const body = chatHtml.slice(start, end);

        expect(body).not.toMatch(/await\s+resolveXDeviceCodes\(/);
        expect(body).not.toMatch(/await\s+refreshXDeviceLabelsInBackground\(/);

        const renderIndex = body.indexOf('renderMessages(prevCount < allMessages.length);');
        const backgroundIndex = body.indexOf('refreshXDeviceLabelsInBackground(allMessages);');
        expect(renderIndex).toBeGreaterThan(0);
        expect(backgroundIndex).toBeGreaterThan(renderIndex);
    });

    test('background cross-device label refresh updates the already-rendered chat safely', () => {
        const start = chatHtml.indexOf('function refreshXDeviceLabelsInBackground(messages)');
        expect(start).toBeGreaterThan(0);
        const end = chatHtml.indexOf('// ── Render Messages ──', start);
        expect(end).toBeGreaterThan(start);
        const body = chatHtml.slice(start, end);

        expect(body).toContain('resolveXDeviceCodes(messages).then(resolvedAny =>');
        expect(body).toContain('if (!resolvedAny || seq !== _xdeviceResolutionSeq) return;');
        expect(body).toContain('renderFilterChips();');
        expect(body).toContain('renderMessages(false);');
        expect(body).toContain('.catch(() => {});');
    });

    test('debug endpoint reports render-load diagnostics without chat message text', () => {
        const start = indexJs.indexOf("app.get('/api/debug/chat-render-load-order'");
        expect(start).toBeGreaterThan(0);
        const end = indexJs.indexOf('// Temporary diagnostic endpoint for Codex channel A2A loop suppression.', start);
        expect(end).toBeGreaterThan(start);
        const body = indexJs.slice(start, end);

        expect(body).toContain('lookupEligibleCodeCount');
        expect(body).toContain('firstRenderBeforeXdeviceLookup: true');
        expect(body).toContain('lookupRunsInBackground: true');
        expect(body).toMatch(/SELECT id, source, entity_id, is_from_user, is_from_bot, created_at/);
        expect(body).not.toMatch(/SELECT[\s\S]*(text|message)[\s\S]*FROM chat_messages/);
    });
});
