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

// Pages that include ai-chat.js
const PAGES_WITH_AI_CHAT = [
    'admin.html',
    'card-holder.html',
    'chat.html',
    'dashboard.html',
    'env-vars.html',
    'feedback.html',
    'files.html',
    'mission.html',
    'schedule.html',
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

    test('all ai-chat pages have inline WebView guard script', () => {
        for (const page of PAGES_WITH_AI_CHAT) {
            const content = pageContents[page];
            expect(content).toBeDefined();
            // Guard must set __blockAiChatWidget before ai-chat.js loads
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

    test('inline guard detects AndroidBridge', () => {
        for (const page of PAGES_WITH_AI_CHAT) {
            const content = pageContents[page];
            expect(content).toMatch(/typeof AndroidBridge/);
        }
    });

    test('inline guard detects EClawAndroid user agent', () => {
        for (const page of PAGES_WITH_AI_CHAT) {
            const content = pageContents[page];
            expect(content).toMatch(/EClawAndroid/);
        }
    });

    test('inline guard includes MutationObserver fallback for cached ai-chat.js', () => {
        for (const page of PAGES_WITH_AI_CHAT) {
            const content = pageContents[page];
            expect(content).toMatch(/MutationObserver/);
            expect(content).toMatch(/aiChatFab/);
            expect(content).toMatch(/aiChatPanel/);
        }
    });

    test('ai-chat.js has cache-busting query param', () => {
        for (const page of PAGES_WITH_AI_CHAT) {
            const content = pageContents[page];
            expect(content).toMatch(/ai-chat\.js\?v=/);
        }
    });

    test('ai-chat.js checks __blockAiChatWidget flag', () => {
        const aiChatCode = fs.readFileSync(AI_CHAT_JS, 'utf-8');
        expect(aiChatCode).toMatch(/window\.__blockAiChatWidget/);
    });

    test('ai-chat.js has isAndroidWebView detection', () => {
        const aiChatCode = fs.readFileSync(AI_CHAT_JS, 'utf-8');
        expect(aiChatCode).toMatch(/function isAndroidWebView/);
        expect(aiChatCode).toMatch(/AndroidBridge/);
        expect(aiChatCode).toMatch(/EClawAndroid/);
    });

    test('ai-chat.js does NOT have visible debug banner (silent telemetry only)', () => {
        const aiChatCode = fs.readFileSync(AI_CHAT_JS, 'utf-8');
        // No visible debug elements — all debugging via silent telemetry API
        expect(aiChatCode).not.toMatch(/background:\s*red/);
        expect(aiChatCode).not.toMatch(/AI-CHAT DEBUG REPORT/);
        expect(aiChatCode).toMatch(/Silent debug/);
    });

    test('ai-chat.js sends comprehensive debug data via telemetry', () => {
        const aiChatCode = fs.readFileSync(AI_CHAT_JS, 'utf-8');
        expect(aiChatCode).toMatch(/hasBlockFlag/);
        expect(aiChatCode).toMatch(/scriptTags/);
        expect(aiChatCode).toMatch(/readyState/);
    });
});
