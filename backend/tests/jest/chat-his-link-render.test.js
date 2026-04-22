/**
 * Static wiring audit for the `his_<id>` history-reference chip feature.
 *
 * Ensures chat.html loads his-link-render.js, calls it in the bubble render
 * pipeline, defines openHistoryMessage(), carries the visual chip styling,
 * and the shared module itself transforms tokens as advertised.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const chatHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'chat.html'), 'utf8');
const i18nJs = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'i18n.js'), 'utf8');
const hisRenderPath = path.join(ROOT, 'public', 'portal', 'shared', 'his-link-render.js');

describe('his_<id> chip — static wiring', () => {
    test('his-link-render.js exists under portal/shared', () => {
        expect(fs.existsSync(hisRenderPath)).toBe(true);
    });

    test('chat.html includes his-link-render.js script tag', () => {
        expect(chatHtml).toContain('shared/his-link-render.js');
    });

    test('chat.html calls HisLinkRender.renderHisLinks in the bubble pipeline', () => {
        expect(chatHtml).toContain('HisLinkRender.renderHisLinks');
    });

    test('chat.html defines openHistoryMessage function', () => {
        expect(chatHtml).toMatch(/function\s+openHistoryMessage\s*\(/);
    });

    test('chat.html carries .his-link CSS class + flash keyframes', () => {
        expect(chatHtml).toContain('.his-link');
        expect(chatHtml).toContain('his-flash');
    });
});

describe('his_<id> chip — module behaviour', () => {
    // Run the IIFE against a throwaway sandbox so we can exercise the regex
    // without spinning a browser.
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(hisRenderPath, 'utf8'), sandbox);
    const HisLinkRender = sandbox.window.HisLinkRender;

    test('exposes renderHisLinks on window', () => {
        expect(typeof HisLinkRender.renderHisLinks).toBe('function');
    });

    test('transforms "his_123" into a clickable chip with data-msg-id', () => {
        const out = HisLinkRender.renderHisLinks('see his_42 for context');
        expect(out).toContain('class="his-link"');
        expect(out).toContain('data-msg-id="42"');
        expect(out).toContain("openHistoryMessage('42')");
        expect(out).toContain('his_42');
    });

    test('matches multiple tokens in one string', () => {
        const out = HisLinkRender.renderHisLinks('compare his_1 and his_9999');
        expect((out.match(/class="his-link"/g) || []).length).toBe(2);
    });

    test('does NOT match non-numeric suffix (his_abc)', () => {
        const out = HisLinkRender.renderHisLinks('this_is his_abc not a chip');
        expect(out).not.toContain('class="his-link"');
    });

    test('respects word boundaries (xhis_5, his_5y)', () => {
        const out1 = HisLinkRender.renderHisLinks('xhis_5');
        expect(out1).not.toContain('class="his-link"');
        const out2 = HisLinkRender.renderHisLinks('his_5y');
        expect(out2).not.toContain('class="his-link"');
    });

    test('preserves leading zeros in id', () => {
        const out = HisLinkRender.renderHisLinks('his_007');
        expect(out).toContain('data-msg-id="007"');
        expect(out).toContain("openHistoryMessage('007')");
    });
});

describe('his_<id> chip — i18n keys', () => {
    const REQUIRED_KEYS = [
        'chat_his_not_rendered_preview',
        'chat_his_not_found'
    ];

    test('all required keys are present in English dictionary', () => {
        for (const key of REQUIRED_KEYS) {
            expect(i18nJs).toContain(`"${key}"`);
        }
    });

    test('key appears in every locale block (15 occurrences each)', () => {
        for (const key of REQUIRED_KEYS) {
            const count = (i18nJs.match(new RegExp(`"${key}":`, 'g')) || []).length;
            expect(count).toBe(15);
        }
    });
});
