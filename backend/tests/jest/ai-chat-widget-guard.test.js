/**
 * AI Chat Widget Guard — static analysis (Jest)
 *
 * Verifies that all portal pages including ai-chat.js have the inline
 * Android WebView guard to prevent duplicate AI chat widgets.
 * Issue: #419 (duplicate AI service in Android WebView)
 */

const fs = require('fs');
const path = require('path');

const PORTAL_DIR = path.resolve(__dirname, '../../public/portal');
const AI_CHAT_JS = path.resolve(__dirname, '../../public/portal/shared/ai-chat.js');
const STYLE_CSS = path.resolve(__dirname, '../../public/portal/shared/style.css');

const PAGES_WITH_AI_CHAT = [
    'admin.html',
    'card-holder.html',
    'chat.html',
    'dashboard.html',
    'env-vars.html',
    'feedback.html',
    'files.html',
    'kanban.html',
    'settings.html',
];

describe('AI Chat Widget WebView Guard (#419)', () => {
    const pageContents = {};

    beforeAll(() => {
        for (const page of PAGES_WITH_AI_CHAT) {
            const filePath = path.join(PORTAL_DIR, page);
            if (fs.existsSync(filePath)) {
                pageContents[page] = fs.readFileSync(filePath, 'utf-8');
            }
        }
    });

    test('all ai-chat pages have inline WebView guard', () => {
        for (const page of PAGES_WITH_AI_CHAT) {
            const content = pageContents[page];
            expect(content).toBeDefined();
            expect(content).toMatch(/window\.__blockAiChatWidget\s*=\s*true/);
        }
    });

    test('inline guard appears BEFORE ai-chat.js script tag', () => {
        for (const page of PAGES_WITH_AI_CHAT) {
            const content = pageContents[page];
            const guardIdx = content.indexOf('__blockAiChatWidget');
            const scriptIdx = content.indexOf('ai-chat.js');
            expect(guardIdx).toBeGreaterThan(-1);
            expect(scriptIdx).toBeGreaterThan(-1);
            expect(guardIdx).toBeLessThan(scriptIdx);
        }
    });

    test('inline guard detects AndroidBridge and EClawAndroid UA', () => {
        for (const page of PAGES_WITH_AI_CHAT) {
            const content = pageContents[page];
            expect(content).toMatch(/typeof AndroidBridge/);
            expect(content).toMatch(/EClawAndroid/);
        }
    });

    test('ai-chat.js checks __blockAiChatWidget flag', () => {
        const code = fs.readFileSync(AI_CHAT_JS, 'utf-8');
        expect(code).toMatch(/window\.__blockAiChatWidget/);
    });

    test('ai-chat.js has isAndroidWebView detection', () => {
        const code = fs.readFileSync(AI_CHAT_JS, 'utf-8');
        expect(code).toMatch(/function isAndroidWebView/);
        expect(code).toMatch(/AndroidBridge/);
        expect(code).toMatch(/EClawAndroid/);
    });

    test('ai-chat.js has no debug instrumentation', () => {
        const code = fs.readFileSync(AI_CHAT_JS, 'utf-8');
        expect(code).not.toMatch(/AI Chat DBG/);
        expect(code).not.toMatch(/flushDebugToServer/);
        expect(code).not.toMatch(/background:\s*red/);
        expect(code).not.toMatch(/_debugLogs/);
    });

    test('ai-chat.js exposes per-window resize state and controls', () => {
        const code = fs.readFileSync(AI_CHAT_JS, 'utf-8');
        expect(code).toMatch(/WINDOW_STATE_KEY\s*=\s*'eclaw_ai_chat_window_state_v1'/);
        expect(code).toMatch(/function getWindowStateId/);
        expect(code).toMatch(/function setupPanelWindowControls/);
        expect(code).toMatch(/ai-chat-resize-toggle-btn/);
        expect(code).toMatch(/ai-chat-resize-grip/);
        expect(code).toMatch(/pointerdown/);
        expect(code).toMatch(/resizeEnabled/);
    });

    test('ai-chat resize CSS includes desktop grip and disable/mobile fallback', () => {
        const css = fs.readFileSync(STYLE_CSS, 'utf-8');
        expect(css).toMatch(/\.ai-chat-resize-grip\s*\{/);
        expect(css).toMatch(/cursor:\s*nwse-resize/);
        expect(css).toMatch(/\.ai-chat-resize-disabled\s+\.ai-chat-resize-grip\s*\{\s*display:\s*none/);
        expect(css).toMatch(/@media\s*\(max-width:\s*640px\)[\s\S]*\.ai-chat-resize-grip[\s\S]*display:\s*none/);
    });
});
