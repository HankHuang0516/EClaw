/**
 * Static UX audit for the @mention feature.
 *
 * Ensures chat.html wires in the mention-autocomplete + mention-render
 * modules, mounts the autocomplete on messageInput, and renders tokens
 * through MentionRender in the message bubble pipeline.
 *
 * Also verifies the shared modules and i18n keys exist.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const chatHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'chat.html'), 'utf8');
const i18nJs = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'i18n.js'), 'utf8');
const indexJs = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
const sharedRenderJs = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'chat-message-render.js'), 'utf8');
const mentionAutocompleteJs = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'shared', 'mention-autocomplete.js'), 'utf8');

describe('Mention feature — static wiring', () => {
    test('mention-autocomplete.js and mention-render.js are present in portal/shared', () => {
        expect(fs.existsSync(path.join(ROOT, 'public', 'portal', 'shared', 'mention-autocomplete.js'))).toBe(true);
        expect(fs.existsSync(path.join(ROOT, 'public', 'portal', 'shared', 'mention-render.js'))).toBe(true);
    });

    test('mention-parser.js backend module exists', () => {
        expect(fs.existsSync(path.join(ROOT, 'mention-parser.js'))).toBe(true);
    });

    test('chat.html includes mention-autocomplete.js script tag', () => {
        expect(chatHtml).toContain('shared/mention-autocomplete.js');
    });

    test('chat.html includes mention-render.js script tag', () => {
        expect(chatHtml).toContain('shared/mention-render.js');
    });

    test('chat.html mounts MentionAutocomplete on messageInput', () => {
        expect(chatHtml).toMatch(/MentionAutocomplete\.attach\(\s*document\.getElementById\(['"]messageInput['"]\)/);
    });

    test('chat.html runs MentionRender via the shared ChatMessageRender pipeline', () => {
        // The bubble pipeline now delegates the chip chain to ChatMessageRender
        // (shared between chat.html and kanban.html). Verify chat.html invokes
        // the shared module *and* the shared module wires MentionRender into
        // the chain — together these still guarantee @mention chip rendering.
        expect(chatHtml).toContain('ChatMessageRender.renderTextChips');
        expect(sharedRenderJs).toContain('MentionRender.renderMentionTokens');
    });

    test('chat.html exposes buildMentionEntityMap helper', () => {
        expect(chatHtml).toContain('function buildMentionEntityMap');
    });

    test('chat.html has mention-chip CSS class', () => {
        expect(chatHtml).toContain('.mention-chip');
        expect(chatHtml).toContain('.mention-chip-all');
        expect(chatHtml).toContain('.mention-chip-cross');
    });

    test('chat.html auto-adds @-mentioned entities without overriding the target-bar', () => {
        // Card_1e59f703 design: target-bar selection is preserved (never
        // wholesale overwritten) but @-mentions resolve to entityIds and any
        // mention pointing OUTSIDE the current selection is auto-added so the
        // typed `@Hermes` can never silently land at a different entityId.
        // Wholesale-overwrite patterns are still forbidden — only `.push()`
        // expansion is allowed.
        expect(chatHtml).toContain('shared/mention-resolver.js');
        expect(chatHtml).toMatch(/MentionResolver\.resolve\s*\(/);
        const sendMsgIdx = chatHtml.indexOf('async function sendMessage');
        const sendMsgEnd = chatHtml.indexOf('} // sendMessage', sendMsgIdx);
        const sendMsgBody = chatHtml.slice(sendMsgIdx, sendMsgEnd > 0 ? sendMsgEnd : sendMsgIdx + 6000);
        expect(sendMsgBody).not.toMatch(/targets\.local\s*=\s*localMentions/);
        expect(sendMsgBody).not.toMatch(/targets\.local\s*=\s*\(boundEntities\s*\|\|\s*\[\]\)\.map/);
        // Auto-add path: mention resolver result must be merged into targets via push()
        expect(sendMsgBody).toMatch(/targets\.local\.push\(/);
    });

    test('mention autocomplete uses shared avatar renderer for Petdx partner avatars', () => {
        // Regression: the @mention dropdown hand-rendered an old emoji/img
        // avatar, so entities with selected companions did not match the
        // partner-system look used elsewhere in Chat.
        expect(mentionAutocompleteJs).toContain('function renderMentionAvatar');
        expect(mentionAutocompleteJs).toContain('global.renderAvatarHtml(avatar, 20, entityId)');
        expect(mentionAutocompleteJs).toContain('global.AvatarPetdx.mount(dropdown)');
        expect(mentionAutocompleteJs).not.toMatch(/const\s+avatar\s*=\s*it\.avatar\s*&&\s*\/\^https/);

        const attachIdx = chatHtml.indexOf('MentionAutocomplete.attach');
        const attachSnippet = chatHtml.slice(attachIdx, attachIdx + 1600);
        expect(attachSnippet).toContain('entityId: e.entityId');
    });

    test('mention autocomplete avatar debug endpoint is registered', () => {
        expect(indexJs).toContain("/api/debug/mention-autocomplete-avatar");
        expect(indexJs).toContain("bug: 'mention-autocomplete-avatar'");
        expect(indexJs).toContain('autocompleteUsesSharedAvatarRenderer');
    });
});

describe('Mention feature — i18n keys', () => {
    const REQUIRED_KEYS = [
        'mention_all_label',
        'mention_all_warning',
        'mention_all_confirm',
        'mention_search_card_holder',
        'mention_not_found',
        'mention_blocked_contact'
    ];

    test('all required keys are present in English dictionary', () => {
        for (const key of REQUIRED_KEYS) {
            expect(i18nJs).toContain(`"${key}"`);
        }
    });

    test('Traditional Chinese (zh) has at least mention_all_label translated', () => {
        // Full 12-language coverage deferred — English fallback in t() handles the rest.
        // Guard: zh must have at least one mention_* key translated.
        const zhSection = i18nJs.slice(i18nJs.indexOf('zh: {'), i18nJs.indexOf('ja: {'));
        expect(zhSection).toContain('mention_all_label');
    });
});

describe('Mention feature — skill template sync', () => {
    const skillTemplates = fs.readFileSync(path.join(ROOT, 'data', 'skill-templates.json'), 'utf8');

    test('eclaw-a2a-toolkit skill documents @mention auto-routing', () => {
        expect(skillTemplates).toContain('eclaw-a2a-toolkit');
        expect(skillTemplates).toContain('@mention Auto-Routing');
    });

    test('skill template references <@xxxxxx> token format', () => {
        expect(skillTemplates).toContain('<@xxxxxx>');
    });
});

describe('Mention feature — Fix A: displayText propagation (regression)', () => {
    test('/api/client/speak derives pushText from mentionParse.displayText', () => {
        // Regression: bot #0 received raw <@xxxxxx> token instead of @name,
        // which confused the LLM into routing to a previous conversation
        // partner instead of the tagged entity. The fix is to use
        // mentionParse.displayText (tokens replaced with @name) when
        // pushing to the bot, while still storing raw text in chat_messages
        // so the frontend can re-render chips.
        expect(indexJs).toMatch(/(const|let)\s+pushText\s*=\s*\(mentionParse\s*&&\s*mentionParse\.displayText\)\s*\|\|\s*text/);
    });

    test('channel push uses pushText (not raw text)', () => {
        // After unifiedPush refactoring, the client/speak channel path calls
        // unifiedPush with message: pushText, which internally calls pushToChannelCallback.
        // Post-vault-keyref (card_247a3a68) the local name may be
        // `entityPushText` — a per-target derivative of `pushText` used to
        // pick the [[VAULT_KEYREF]] hint form for channel-bound receivers.
        // Both names are acceptable; raw `text` is not.
        const speakIdx = indexJs.indexOf("app.post('/api/client/speak'");
        expect(speakIdx).toBeGreaterThan(0);
        const channelSection = indexJs.indexOf("entity.bindingType === 'channel'", speakIdx);
        expect(channelSection).toBeGreaterThan(speakIdx);
        const nextElse = indexJs.indexOf('} else if (entity.webhook)', channelSection);
        const channelSnippet = indexJs.slice(channelSection, nextElse);
        expect(channelSnippet).toMatch(/message:\s+(?:entityPushText|pushText)\b/);
    });

    test('OpenClaw webhook pushMsg uses pushText in Content: line', () => {
        // The instruction-first push format builds a pushMsg string that
        // includes `Content: ${text}` — this must be updated to pushText
        // (or its per-target derivative `entityPushText`, post
        // card_247a3a68) so the LLM sees human-readable @name instead of
        // raw tokens and never the raw `${text}`.
        expect(indexJs).toMatch(/Content:\s*\$\{(entityPushText|pushText)\}/);
        // The raw `${text}` form must not appear in the OpenClaw Content line
        expect(indexJs).not.toMatch(/pushMsg\s*\+=\s*`Content: \$\{text\}/);
    });
});

describe('Mention feature — Fix B: imperative [MENTIONS] wording (regression)', () => {
    const pushContextJs = fs.readFileSync(path.join(ROOT, 'push-context.js'), 'utf8');

    test('buildMentionsBlock uses IMPORTANT ROUTING HINT header', () => {
        expect(pushContextJs).toContain('[MENTIONS — IMPORTANT ROUTING HINT]');
    });

    test('buildMentionsBlock instructs MUST call speakTo', () => {
        expect(pushContextJs).toContain('you MUST call');
    });

    test('buildMentionsBlock warns against falling back to previous partner', () => {
        expect(pushContextJs).toContain('Do NOT fall back to a previous conversation partner');
    });
});
