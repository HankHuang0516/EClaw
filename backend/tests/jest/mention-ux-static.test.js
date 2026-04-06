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

    test('chat.html calls MentionRender.renderMentionTokens in the bubble pipeline', () => {
        expect(chatHtml).toContain('MentionRender.renderMentionTokens');
    });

    test('chat.html exposes buildMentionEntityMap helper', () => {
        expect(chatHtml).toContain('function buildMentionEntityMap');
    });

    test('chat.html has mention-chip CSS class', () => {
        expect(chatHtml).toContain('.mention-chip');
        expect(chatHtml).toContain('.mention-chip-all');
        expect(chatHtml).toContain('.mention-chip-cross');
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
