'use strict';

/**
 * reference-parser unit tests — verifies message-text scanner extracts
 * card_/review_/src:// tokens, deduplicates, and that buildReferencesBlock
 * formats both resolved and unresolved entries correctly.
 */

const { scanReferences, buildReferencesBlock } = require('../../reference-parser');

describe('scanReferences', () => {
    test('extracts single card_ short prefix', () => {
        const refs = scanReferences('看 card_f6321df2 這張');
        expect(refs).toEqual([{ refType: 'card', refId: 'card_f6321df2', raw: 'card_f6321df2' }]);
    });

    test('extracts card_ in 24-hex long form', () => {
        const refs = scanReferences('card_d3cdda1455152e3caee8d4ac done');
        expect(refs[0].refId).toBe('card_d3cdda1455152e3caee8d4ac');
    });

    test('extracts card_ in UUID form', () => {
        const refs = scanReferences('card_7b7dd9e3-55e1-4074-b101-40c47161d8de ok');
        expect(refs[0].refId).toBe('card_7b7dd9e3-55e1-4074-b101-40c47161d8de');
    });

    test('extracts review_ slug', () => {
        const refs = scanReferences('review_perf_q2_2026 complete');
        expect(refs).toEqual([{ refType: 'review', refId: 'review_perf_q2_2026', raw: 'review_perf_q2_2026' }]);
    });

    test('extracts src:// with anchor', () => {
        const refs = scanReferences('see src://kanban/card/f6321df2aaa0#comment-abc plz');
        expect(refs).toHaveLength(1);
        expect(refs[0]).toMatchObject({
            refType: 'src',
            refId: 'src://kanban/card/f6321df2aaa0#comment-abc',
            kind: 'kanban',
            innerType: 'card',
            innerId: 'f6321df2aaa0',
            anchor: '#comment-abc',
        });
    });

    test('extracts src:// without anchor', () => {
        const refs = scanReferences('src://reviews/agent/1a2b3c4d5e6f pending');
        expect(refs[0].anchor).toBeNull();
        expect(refs[0].refId).toBe('src://reviews/agent/1a2b3c4d5e6f');
    });

    test('deduplicates repeated references', () => {
        const refs = scanReferences('card_f6321df2 again card_f6321df2 and card_f6321df2');
        expect(refs).toHaveLength(1);
    });

    test('dedup is case-insensitive for card_/src:// (normalised to lowercase)', () => {
        const refs = scanReferences('CARD_F6321DF2 and card_f6321df2');
        expect(refs).toHaveLength(1);
        expect(refs[0].refId).toBe('card_f6321df2');
    });

    test('preserves order of first occurrence across types', () => {
        const refs = scanReferences('check card_f6321df2 then review_abc123456 then src://kanban/card/abcdef12');
        expect(refs.map(r => r.refType)).toEqual(['card', 'review', 'src']);
    });

    test('mixed message with all three types', () => {
        const refs = scanReferences('這張 card_f6321df2 關聯 review_perf_q2_2026 還有 src://reviews/agent/1a2b3c4d5e6f');
        expect(refs).toHaveLength(3);
    });

    test('empty / null / non-string input returns empty array', () => {
        expect(scanReferences('')).toEqual([]);
        expect(scanReferences(null)).toEqual([]);
        expect(scanReferences(undefined)).toEqual([]);
        expect(scanReferences(42)).toEqual([]);
    });

    test('does not match note_ prefix (owned by NoteLinkRender)', () => {
        const refs = scanReferences('note_1234567890abcdef12345678 should be ignored');
        expect(refs).toEqual([]);
    });

    test('does not match skill_/rule_/listing_ (EntityLinkRender owns them)', () => {
        // Only card_ is in our scan scope — other entity types flow through mention-parser
        // or entity-link-render upstream without needing backend context expansion here.
        const refs = scanReferences('skill_f6321df2 rule_f6321df2 listing_f6321df2');
        expect(refs).toEqual([]);
    });

    test('word boundary — card_xxx not matched inside a larger token', () => {
        const refs = scanReferences('xcard_f6321df2'); // leading x means no \b at start
        expect(refs).toEqual([]);
    });
});

describe('buildReferencesBlock', () => {
    test('returns empty string for no refs', () => {
        expect(buildReferencesBlock([])).toBe('');
        expect(buildReferencesBlock(null)).toBe('');
    });

    test('singular "reference" in header when count is 1', () => {
        const block = buildReferencesBlock([
            { refType: 'card', refId: 'card_f6321df2', resolved: true, title: 'Test Card' }
        ]);
        expect(block).toMatch(/cites 1 reference;/);
    });

    test('plural "references" when count > 1', () => {
        const block = buildReferencesBlock([
            { refType: 'card', refId: 'card_f6321df2', resolved: true, title: 'A' },
            { refType: 'card', refId: 'card_abcdef12', resolved: true, title: 'B' },
        ]);
        expect(block).toMatch(/cites 2 references;/);
    });

    test('resolved card includes title + status + priority + last comment', () => {
        const block = buildReferencesBlock([{
            refType: 'card',
            refId: 'card_f6321df2',
            resolved: true,
            title: '修按鈕顏色',
            status: 'in_progress',
            priority: 'P1',
            lastComment: '改好了，等 review',
        }]);
        expect(block).toMatch(/"修按鈕顏色"/);
        expect(block).toMatch(/status: in_progress/);
        expect(block).toMatch(/priority: P1/);
        expect(block).toMatch(/last comment: "改好了，等 review"/);
    });

    test('unresolved ref includes reason', () => {
        const block = buildReferencesBlock([
            { refType: 'card', refId: 'card_deadbeef', resolved: false, error: 'not_found' },
        ]);
        expect(block).toMatch(/card_deadbeef — \(not found\)/);
    });

    test('unsupported type surfaces as "type not indexed yet"', () => {
        const block = buildReferencesBlock([
            { refType: 'review', refId: 'review_xyz789', resolved: false, error: 'unsupported' },
        ]);
        expect(block).toMatch(/review_xyz789 — \(type not indexed yet\)/);
    });

    test('long last-comment truncated to 140 chars', () => {
        const long = 'x'.repeat(500);
        const block = buildReferencesBlock([{
            refType: 'card',
            refId: 'card_f6321df2',
            resolved: true,
            title: 'Test',
            lastComment: long,
        }]);
        const m = block.match(/last comment: "(x+)"/);
        expect(m).toBeTruthy();
        expect(m[1].length).toBe(140);
    });

    test('anchor from src:// shows on its own line attr', () => {
        const block = buildReferencesBlock([{
            refType: 'src',
            refId: 'src://kanban/card/abcdef12#comment-xyz',
            resolved: true,
            title: 'Parent card',
            anchor: '#comment-xyz',
        }]);
        expect(block).toMatch(/anchor: #comment-xyz/);
    });
});
