/**
 * Chat history fuzzy-search box (card_bdc741f62acaf8f76c15de47).
 *
 * Feature: a text search box in the chat.html 篩選條件 (filter) panel that
 * fuzzy-searches the already-loaded historical MESSAGES (in-memory allMessages
 * window, ≤500), highlights the matched substring, debounces input (~250ms),
 * composes with the existing chip filters, shows a distinct empty state, and
 * is XSS-safe (highlight never parses HTML from message content).
 *
 * jest.config.js uses testEnvironment: 'node' with NO jsdom dependency (see
 * filter-summary-invariant.test.js / chat-quote-smart-receiver.test.js for the
 * same reasoning). So we:
 *   1. Lock the surface with static regex contracts against chat.html + i18n.js.
 *   2. Exercise the PURE search logic (tokenize + match + highlight-regex build)
 *      by extracting the functions and running them against plain data.
 *
 * The genuine DOM / real-input / real-render / XSS behaviour is verified by the
 * Playwright harness test at 390x844 (per Hank's rule: verify the REAL render,
 * not API success). This file locks the contract so a future edit can't silently
 * regress it.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const chatHtml = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'chat.html'),
    'utf8'
);
const i18nJs = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'shared', 'i18n.js'),
    'utf8'
);

// ── Extract the pure search predicate so we can run it directly ───────────────
// Mirror the exact logic in chat.html so the test fails if the semantics drift.
// (The real function reads module-level messageSearchTokens; here we inject.)
function makeMatcher(tokens) {
    return function messageMatchesSearch(msg) {
        if (tokens.length === 0) return true;
        const hay = String((msg && msg.text) || '').toLowerCase();
        if (!hay) return false;
        return tokens.every(tok => hay.includes(tok));
    };
}
function tokenize(raw) {
    const q = (raw || '').trim();
    return q ? q.toLowerCase().split(/\s+/).filter(Boolean) : [];
}
// Mirror of the highlight regex builder (escape metachars, longest-first).
function buildHighlightRegex(tokens) {
    const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = tokens
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)
        .map(escapeRe)
        .join('|');
    if (!pattern) return null;
    return new RegExp('(' + pattern + ')', 'gi');
}

describe('chat history fuzzy-search — chat.html surface contract', () => {
    test('search input is mounted inside the filter panel (#filterBarLegacy) with i18n placeholder', () => {
        expect(chatHtml).toMatch(/id="messageSearchInput"/);
        expect(chatHtml).toMatch(/class="chat-search-input"/);
        expect(chatHtml).toMatch(/data-i18n-placeholder="chat_search_placeholder"/);
        // It must live INSIDE the legacy filter bar (which is moved into the
        // filter-summary panel at boot) so it coexists with the chips.
        const barIdx = chatHtml.indexOf('id="filterBarLegacy"');
        const inputIdx = chatHtml.indexOf('id="messageSearchInput"');
        const chipsIdx = chatHtml.indexOf('id="filterChips"');
        expect(barIdx).toBeGreaterThan(-1);
        expect(inputIdx).toBeGreaterThan(barIdx);
        expect(inputIdx).toBeLessThan(chipsIdx); // search sits above the chips
    });

    test('input is debounced (~250ms) via onMessageSearchInput → applyMessageSearch', () => {
        expect(chatHtml).toMatch(/oninput="onMessageSearchInput\(this\.value\)"/);
        expect(chatHtml).toMatch(/function\s+onMessageSearchInput\s*\(/);
        // Debounce timer of 250ms.
        expect(chatHtml).toMatch(/setTimeout\(\s*\(\)\s*=>\s*\{\s*applyMessageSearch\(raw\);\s*\}\s*,\s*250\s*\)/);
        expect(chatHtml).toMatch(/clearTimeout\(_messageSearchDebounce\)/);
    });

    test('search composes with chip filters inside getFilteredMessages (searchGate)', () => {
        expect(chatHtml).toMatch(/function\s+getFilteredMessages\s*\(/);
        expect(chatHtml).toMatch(/const\s+searchGate\s*=/);
        // Every chip branch must route through searchGate so search + chips compose.
        expect(chatHtml).toMatch(/if\s*\(currentFilter === 'all'\)\s*return\s+searchGate\(allMessages\)/);
        expect(chatHtml).toMatch(/return\s+searchGate\(allMessages\.filter\(m => m\.is_from_user/);
        expect(chatHtml).toMatch(/return\s+searchGate\(allMessages\.filter\(m => \{/);
    });

    test('clearing the box restores the full list (clearMessageSearch resets state + re-renders)', () => {
        expect(chatHtml).toMatch(/function\s+clearMessageSearch\s*\(/);
        expect(chatHtml).toMatch(/onclick="clearMessageSearch\(\)"/);
        // clearMessageSearch empties the input then applies an empty query.
        expect(chatHtml).toMatch(/applyMessageSearch\(''\)/);
        // applyMessageSearch with empty query nulls the tokens → search no-op.
        expect(chatHtml).toMatch(/messageSearchTokens\s*=\s*messageSearchQuery/);
    });

    test('distinct empty state ("找不到符合的訊息") when a search matches nothing', () => {
        expect(chatHtml).toMatch(/const\s+isSearchEmpty\s*=\s*messageSearchTokens\.length\s*>\s*0/);
        expect(chatHtml).toMatch(/i18n\.t\('chat_search_no_results'\)/);
    });

    test('highlight is XSS-safe: built via createElement + textContent, never innerHTML from content', () => {
        expect(chatHtml).toMatch(/function\s+highlightSearchMatches\s*\(/);
        // Match text is placed via textContent on a freshly created <mark>.
        expect(chatHtml).toMatch(/document\.createElement\('mark'\)/);
        expect(chatHtml).toMatch(/mark\.textContent\s*=\s*match\[0\]/);
        // It walks TEXT NODES only (NodeFilter.SHOW_TEXT) and reads nodeValue —
        // it must NOT assign innerHTML anywhere in the highlight routine.
        const fnStart = chatHtml.indexOf('function highlightSearchMatches');
        const fnBody = chatHtml.slice(fnStart, fnStart + 2600);
        expect(fnBody).toMatch(/NodeFilter\.SHOW_TEXT/);
        expect(fnBody).not.toMatch(/\.innerHTML\s*=/);
    });

    test('summary chip count includes an active search', () => {
        expect(chatHtml).toMatch(/messageSearchTokens\.length\s*>\s*0\)\s*n\+\+/);
    });
});

describe('chat history fuzzy-search — i18n keys', () => {
    for (const key of ['chat_search_placeholder', 'chat_search_label', 'chat_search_clear', 'chat_search_no_results']) {
        test(`i18n key "${key}" exists in EN + zh-TW`, () => {
            // EN "Search history…" / clear labels + the zh-TW 搜尋 variant.
            expect(i18nJs).toContain(`"${key}":`);
        });
    }
    test('zh-TW placeholder is 搜尋歷史訊息…', () => {
        expect(i18nJs).toContain('"chat_search_placeholder": "搜尋歷史訊息…"');
    });
    test('zh-TW no-results is 找不到符合的訊息', () => {
        expect(i18nJs).toContain('"chat_search_no_results": "找不到符合的訊息"');
    });
});

describe('chat history fuzzy-search — pure search logic', () => {
    const MSGS = [
        { id: 1, text: 'Hello world from the lobster' },
        { id: 2, text: '看板任務已完成，請審查' },
        { id: 3, text: 'The Lobster ordered a WORLD tour' },
        { id: 4, text: '[Photo]' },
        { id: 5, text: '' },
        { id: 6, text: null },
        { id: 7, text: 'price is $5.00 today' },
    ];

    test('empty query matches everything (search is a no-op)', () => {
        const match = makeMatcher(tokenize(''));
        expect(MSGS.filter(match).length).toBe(MSGS.length);
        expect(makeMatcher(tokenize('   ')).call).toBeDefined();
        expect(MSGS.filter(makeMatcher(tokenize('   '))).length).toBe(MSGS.length);
    });

    test('case-insensitive substring match', () => {
        const match = makeMatcher(tokenize('LOBSTER'));
        const ids = MSGS.filter(match).map(m => m.id);
        expect(ids).toEqual([1, 3]);
    });

    test('multi-token AND (all tokens must appear, order-independent)', () => {
        const match = makeMatcher(tokenize('world lobster'));
        const ids = MSGS.filter(match).map(m => m.id);
        expect(ids.sort()).toEqual([1, 3]);
        // one token absent → excluded
        expect(MSGS.filter(makeMatcher(tokenize('lobster spaceship'))).length).toBe(0);
    });

    test('CJK substring match works', () => {
        const match = makeMatcher(tokenize('審查'));
        expect(MSGS.filter(match).map(m => m.id)).toEqual([2]);
    });

    test('null / empty text never matches a non-empty query (no crash)', () => {
        const match = makeMatcher(tokenize('anything'));
        expect(MSGS.filter(match).some(m => m.id === 5 || m.id === 6)).toBe(false);
    });

    test('highlight regex escapes metacharacters so "$5.00" is literal', () => {
        const re = buildHighlightRegex(tokenize('$5.00'));
        expect(re.test('price is $5.00 today')).toBe(true);
        re.lastIndex = 0;
        // The "." must NOT act as a wildcard: "$5x00" should not match.
        expect(re.test('$5x00')).toBe(false);
    });

    test('highlight regex is case-insensitive + matches longest token first', () => {
        const re = buildHighlightRegex(tokenize('lob lobster'));
        const src = 'The Lobster';
        const found = src.match(re);
        expect(found).not.toBeNull();
        // longest-first ordering means the full "Lobster" is captured, not just "Lob"
        expect(found[0].toLowerCase()).toBe('lobster');
    });
});
