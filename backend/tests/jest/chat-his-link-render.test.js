/**
 * Static wiring audit for the `his_<uuid>` history-reference chip feature.
 *
 * Ensures chat.html loads his-link-render.js, calls it in the bubble render
 * pipeline, defines openHistoryMessage(), carries the visual chip styling,
 * and the shared module itself transforms UUID tokens as advertised.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const chatHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'chat.html'), 'utf8');
const i18nJs = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'i18n.js'), 'utf8');
const hisRenderPath = path.join(ROOT, 'public', 'portal', 'shared', 'his-link-render.js');
const sharedRenderJs = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'chat-message-render.js'), 'utf8');

const SAMPLE_UUID = '7c424d88-9007-4d9b-9363-d811755847b1';
const SAMPLE_UUID_2 = '015181ca-52a7-439a-8971-34e2523f4adb';

describe('his_<uuid> chip — static wiring', () => {
    test('his-link-render.js exists under portal/shared', () => {
        expect(fs.existsSync(hisRenderPath)).toBe(true);
    });

    test('chat.html includes his-link-render.js script tag', () => {
        expect(chatHtml).toContain('shared/his-link-render.js');
    });

    test('chat.html runs HisLinkRender via the shared ChatMessageRender pipeline', () => {
        // The bubble pipeline now delegates the chip chain to ChatMessageRender
        // (shared between chat.html and kanban.html). Verify chat.html invokes
        // the shared module *and* the shared module wires HisLinkRender into
        // the chain — together these still guarantee his_<uuid> rendering.
        expect(chatHtml).toContain('ChatMessageRender.renderTextChips');
        expect(sharedRenderJs).toContain('HisLinkRender.renderHisLinks');
    });

    test('chat.html defines openHistoryMessage function', () => {
        expect(chatHtml).toMatch(/function\s+openHistoryMessage\s*\(/);
    });

    test('chat.html carries .his-link CSS class + flash keyframes', () => {
        expect(chatHtml).toContain('.his-link');
        expect(chatHtml).toContain('his-flash');
    });

    test('quote-reply composer auto-injects his_<uuid> into the outgoing prefix', () => {
        // When replyContext is present, the send path must build a quotePrefix
        // that contains his_<parent_uuid> so the referenced bubble renders as
        // a chip for everyone. Regression guard against the earlier digit-only
        // bug that mangled UUIDs into numeric garbage.
        expect(chatHtml).toMatch(/UUID_RE\s*=\s*\/\^\[0-9a-f\]\{8\}/);
        expect(chatHtml).toMatch(/hisToken\s*=\s*UUID_RE\.test\(rawMsgId\)/);
        expect(chatHtml).toMatch(/`\s*his_\$\{rawMsgId\}`/);
        // Negative guard: the old digit-stripping regex must be gone from this
        // site so we don't silently regress to numeric-only handling.
        expect(chatHtml).not.toMatch(/his_\$\{String\(replyContext\.msgId\)\.replace\(\/\[\^0-9\]/);
    });
});

describe('his_<uuid> chip — module behaviour', () => {
    // Run the IIFE against a throwaway sandbox so we can exercise the regex
    // without spinning a browser.
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(hisRenderPath, 'utf8'), sandbox);
    vm.runInNewContext(sharedRenderJs, sandbox);
    const HisLinkRender = sandbox.window.HisLinkRender;
    const ChatMessageRender = sandbox.window.ChatMessageRender;

    test('exposes renderHisLinks on window', () => {
        expect(typeof HisLinkRender.renderHisLinks).toBe('function');
    });

    test('exposes normalize / extract helpers for downstream surfaces', () => {
        expect(typeof HisLinkRender.normalizeMessageId).toBe('function');
        expect(typeof HisLinkRender.extractFirstMessageId).toBe('function');
        expect(typeof ChatMessageRender.normalizeHistoryMessageId).toBe('function');
        expect(typeof ChatMessageRender.extractFirstHistoryMessageId).toBe('function');
    });

    test('transforms "his_<uuid>" into a clickable chip with data-msg-id', () => {
        const out = HisLinkRender.renderHisLinks(`see his_${SAMPLE_UUID} for context`);
        expect(out).toContain('class="his-link"');
        expect(out).toContain(`data-msg-id="${SAMPLE_UUID}"`);
        expect(out).toContain(`openHistoryMessage('${SAMPLE_UUID}')`);
        expect(out).toContain(`his_${SAMPLE_UUID}`);
    });

    test('matches multiple UUID tokens in one string', () => {
        const out = HisLinkRender.renderHisLinks(`compare his_${SAMPLE_UUID} and his_${SAMPLE_UUID_2}`);
        expect((out.match(/class="his-link"/g) || []).length).toBe(2);
    });

    test('does NOT match digit-only suffix (his_123)', () => {
        // Regression guard for the original numeric-SERIAL assumption. Now
        // that messages.id is a UUID we should reject bare digit tokens —
        // this also prevents matching the old buggy digit-stripped garbage
        // like his_74248890074993638117558471.
        const out = HisLinkRender.renderHisLinks('this his_123 should not render');
        expect(out).not.toContain('class="his-link"');
        const out2 = HisLinkRender.renderHisLinks('his_74248890074993638117558471 legacy garbage');
        expect(out2).not.toContain('class="his-link"');
    });

    test('does NOT match non-hex suffix (his_abc)', () => {
        const out = HisLinkRender.renderHisLinks('this_is his_abc not a chip');
        expect(out).not.toContain('class="his-link"');
    });

    test('respects word boundaries (xhis_<uuid>, his_<uuid>extra)', () => {
        const out1 = HisLinkRender.renderHisLinks(`xhis_${SAMPLE_UUID}`);
        expect(out1).not.toContain('class="his-link"');
        // trailing hex char after the 12-block should block the match so we
        // don't eat a longer hex run as if it were a UUID.
        const out2 = HisLinkRender.renderHisLinks(`his_${SAMPLE_UUID}a`);
        expect(out2).not.toContain('class="his-link"');
    });

    test('normalises uppercase UUIDs to lowercase in output', () => {
        const upper = SAMPLE_UUID.toUpperCase();
        const out = HisLinkRender.renderHisLinks(`ref his_${upper}`);
        expect(out).toContain(`data-msg-id="${SAMPLE_UUID}"`);
        expect(out).toContain(`openHistoryMessage('${SAMPLE_UUID}')`);
    });

    test('extractFirstMessageId accepts direct UUID or embedded his_<uuid> token', () => {
        expect(HisLinkRender.extractFirstMessageId(SAMPLE_UUID.toUpperCase())).toBe(SAMPLE_UUID);
        expect(HisLinkRender.extractFirstMessageId(`before his_${SAMPLE_UUID} after`)).toBe(SAMPLE_UUID);
        expect(HisLinkRender.extractFirstMessageId(`noise his_123`)).toBe('');
    });

    test('shared ChatMessageRender delegates history-id extraction to HisLinkRender', () => {
        expect(ChatMessageRender.normalizeHistoryMessageId(SAMPLE_UUID.toUpperCase())).toBe(SAMPLE_UUID);
        expect(ChatMessageRender.extractFirstHistoryMessageId(`context his_${SAMPLE_UUID_2}`)).toBe(SAMPLE_UUID_2);
    });
});

describe('his_<uuid> chip — i18n keys', () => {
    const REQUIRED_KEYS = [
        'chat_his_not_rendered_preview',
        'chat_his_not_found'
    ];

    test('all required keys are present in English dictionary', () => {
        for (const key of REQUIRED_KEYS) {
            expect(i18nJs).toContain(`"${key}"`);
        }
    });

    test('key appears in every locale block (14 occurrences each)', () => {
        for (const key of REQUIRED_KEYS) {
            const count = (i18nJs.match(new RegExp(`"${key}":`, 'g')) || []).length;
            expect(count).toBe(14);
        }
    });
});
