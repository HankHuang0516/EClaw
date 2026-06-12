/**
 * Static invariant test for the chat routing chip (routing-viz v1, Part B).
 * Card: card_b3724a801eb600036aab901c. #6 v1 spec:
 *   1. per-message chip 來源→目標·LV{to_lv} as the primary visual
 *   2. segmented LV palette (not a linear gradient)
 *   3. frontend RENDERS routing_meta only — never recomputes routing
 *   4. minimal negative indicator: 路由未確認 / 路由降級 / 路由失敗
 *
 * testEnvironment:'node' → lock the source surface (same pattern as
 * chat-quote-smart-receiver.test.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const chatHtml = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'chat.html'),
    'utf8'
);

describe('routing chip — render helper', () => {
    test('renderRoutingChip + routingLvSegment exist', () => {
        expect(chatHtml).toMatch(/function\s+renderRoutingChip\s*\(\s*msg\s*\)/);
        expect(chatHtml).toMatch(/function\s+routingLvSegment\s*\(\s*lv\s*\)/);
    });

    test('reads backend msg.routing_meta — does not recompute routing (#6 spec point 3)', () => {
        const fn = chatHtml.match(/function\s+renderRoutingChip\s*\(\s*msg\s*\)\s*\{[\s\S]*?\n        \}/);
        expect(fn).not.toBeNull();
        const body = fn[0];
        expect(body).toMatch(/msg\s*&&\s*msg\.routing_meta/);
        // pulls from/to/lv straight off routing_meta
        expect(body).toMatch(/rm\.from_name/);
        expect(body).toMatch(/rm\.to_name/);
        expect(body).toMatch(/rm\.to_lv/);
        // must NOT derive a target from hierarchy/boundEntities here
        expect(body).not.toMatch(/boundEntities|getSuperior|hierarchy/);
    });

    test('segmented LV palette maps to the #6 breakpoints (1-2/3-4/5-6/7-8/9+)', () => {
        const seg = chatHtml.match(/function\s+routingLvSegment\s*\(\s*lv\s*\)\s*\{[\s\S]*?\n        \}/)[0];
        expect(seg).toMatch(/Number\.isFinite\(n\)/);
        expect(seg).toMatch(/n\s*<=\s*2\)\s*return\s*'1'/);
        expect(seg).toMatch(/n\s*<=\s*4\)\s*return\s*'3'/);
        expect(seg).toMatch(/n\s*<=\s*6\)\s*return\s*'5'/);
        expect(seg).toMatch(/n\s*<=\s*8\)\s*return\s*'7'/);
        expect(seg).toMatch(/return\s*'9'/);
        expect(seg).toMatch(/return\s*'unknown'/);
    });

    test('negative indicators: unconfirmed (routed but no meta) / degraded / failed', () => {
        const body = chatHtml.match(/function\s+renderRoutingChip[\s\S]*?\n        \}/)[0];
        expect(body).toMatch(/rc-unconfirmed/);
        expect(body).toMatch(/rm\.status\s*===\s*'failed'/);
        expect(body).toMatch(/rm\.status\s*===\s*'degraded'/);
        // unconfirmed only when the message WAS routed (entity/xdevice source)
        expect(body).toMatch(/parseEntitySource\(msg\s*&&\s*msg\.source\)/);
    });
});

describe('routing chip — CSS palette + template wiring', () => {
    test('all 6 LV-segment CSS classes present with distinct colours', () => {
        expect(chatHtml).toMatch(/\.routing-chip\.rc-lv-unknown\s*\{[^}]*#6B7280/);
        expect(chatHtml).toMatch(/\.routing-chip\.rc-lv-1\s*\{[^}]*#2563EB/);
        expect(chatHtml).toMatch(/\.routing-chip\.rc-lv-3\s*\{[^}]*#0F766E/);
        expect(chatHtml).toMatch(/\.routing-chip\.rc-lv-5\s*\{[^}]*#B45309/);
        expect(chatHtml).toMatch(/\.routing-chip\.rc-lv-7\s*\{[^}]*#C2410C/);
        expect(chatHtml).toMatch(/\.routing-chip\.rc-lv-9\s*\{[^}]*#B91C1C/);
    });

    test('negative-state CSS classes present', () => {
        expect(chatHtml).toMatch(/\.routing-chip\.rc-unconfirmed\s*\{/);
        expect(chatHtml).toMatch(/\.routing-chip\.rc-degraded\s*\{/);
        expect(chatHtml).toMatch(/\.routing-chip\.rc-failed\s*\{/);
    });

    test('chip is computed per message and rendered in the meta row', () => {
        expect(chatHtml).toMatch(/const\s+routingChipHtml\s*=\s*renderRoutingChip\(msg\)/);
        expect(chatHtml).toMatch(/<div class="chat-meta">\$\{routingChipHtml\}\$\{time\}<\/div>/);
    });
});

describe('routing chip — i18n key parity (en / zh / zh-TW)', () => {
    const i18nJs = fs.readFileSync(
        path.join(__dirname, '..', '..', 'public', 'shared', 'i18n.js'),
        'utf8'
    );
    const KEYS = [
        'chat_routing_label',
        'chat_routing_unconfirmed',
        'chat_routing_degraded',
        'chat_routing_failed',
        'chat_routing_broadcast',
        'chat_routing_xdevice',
    ];
    // locate each locale block by its opener, bounded by the next opener
    const LOCALE_RE = /^(\s*)("?(en|zh|zh-TW)"?):\s*\{\s*$/gm;
    const matches = [];
    let m;
    while ((m = LOCALE_RE.exec(i18nJs)) !== null) matches.push({ name: m[3], start: m.index });
    matches.sort((a, b) => a.start - b.start);
    const blocks = {};
    matches.forEach((e, i) => {
        const end = i + 1 < matches.length ? matches[i + 1].start : i18nJs.length;
        if (!blocks[e.name]) blocks[e.name] = i18nJs.slice(e.start, end);
    });

    ['en', 'zh', 'zh-TW'].forEach(loc => {
        KEYS.forEach(k => {
            test(`${loc} has ${k}`, () => {
                expect(blocks[loc]).toBeDefined();
                expect(blocks[loc]).toMatch(new RegExp('"' + k + '"\\s*:\\s*"[^"]+"'));
            });
        });
    });
});
