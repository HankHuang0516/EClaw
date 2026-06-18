'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const kanbanSrc = fs.readFileSync(path.join(ROOT, 'kanban.js'), 'utf8');

function extractFunctionBody(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) throw new Error(`function not found: ${signature}`);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
    }
    throw new Error(`unterminated function: ${signature}`);
}

describe('autoReviewOnTransform — aboutCardId inference from transformMessage text', () => {
    const sig = 'async function autoReviewOnTransform(deviceId, entityId, transformMessage, aboutCardId)';
    const body = extractFunctionBody(kanbanSrc, sig);

    test('regex literal `\\bcard_[a-f0-9]{8,}\\b` is present', () => {
        expect(body).toMatch(/\/\\bcard_\[a-f0-9\]\{8,\}\\b\/gi/);
    });

    test('inference happens BEFORE the "no aboutCardId provided" skip', () => {
        const inferIdx = body.indexOf('inferred aboutCardId');
        const skipIdx = body.indexOf('no aboutCardId provided');
        expect(inferIdx).toBeGreaterThan(-1);
        expect(skipIdx).toBeGreaterThan(-1);
        expect(inferIdx).toBeLessThan(skipIdx);
    });

    test('inference is gated on aboutCardId being falsy AND transformMessage being a non-empty string', () => {
        expect(body).toMatch(/!aboutCardId\s*&&\s*typeof transformMessage === 'string'\s*&&\s*transformMessage\.length > 0/);
    });

    test('multiple distinct card_ids in message → skip (ambiguous), do not pick first', () => {
        expect(body).toMatch(/unique\.length === 1/);
        expect(body).toMatch(/distinct card_ids in message but no explicit aboutCardId/);
    });

    test('inference dedupes via Set + lowercases for case-insensitive identity', () => {
        expect(body).toMatch(/new Set\(matches\.map\(m => m\.toLowerCase\(\)\)\)/);
    });

    test('legacy "skip when nothing extractable" guard still runs as the second gate', () => {
        // After inference attempt, if aboutCardId still undefined → skip.
        // Log level is warn|debug (PR #3499 downgraded to debug for log hygiene);
        // the gate's behavior — advise + return — is what matters here.
        expect(body).toMatch(/if\s*\(\s*!\s*aboutCardId\s*\)\s*{\s*console\.(?:warn|debug)\([^)]*no aboutCardId provided[\s\S]*?return\s*;?\s*}/);
    });
});

describe('autoReviewOnTransform — regex behavior contract', () => {
    // Pure unit test of the regex pattern (no DB / no module load)
    const PATTERN = /\bcard_[a-f0-9]{8,}\b/gi;

    test('matches 8-char hex card id', () => {
        const m = 'closed card_cc7a3f0c per SOP'.match(PATTERN);
        expect(m).toEqual(['card_cc7a3f0c']);
    });

    test('matches longer hex card id (24-char as commonly returned by /api/mission/card)', () => {
        const m = 'see card_cc7a3f0c4e2a8b1d9f1234ab for context'.match(PATTERN);
        expect(m).toEqual(['card_cc7a3f0c4e2a8b1d9f1234ab']);
    });

    test('does NOT match too-short card id (under 8 chars)', () => {
        const m = 'card_abc123 is too short'.match(PATTERN);
        expect(m).toBeNull();
    });

    test('does NOT match card_id with non-hex chars', () => {
        const m = 'card_zzzzzzzz has non-hex'.match(PATTERN);
        expect(m).toBeNull();
    });

    test('case-insensitive: uppercase hex matches too', () => {
        const m = 'CARD_AABBCCDD11'.match(PATTERN);
        expect(m).toEqual(['CARD_AABBCCDD11']);
    });

    test('multi-mention preserves duplicates; dedup is caller responsibility', () => {
        const m = 'card_cc7a3f0c then card_cc7a3f0c again'.match(PATTERN);
        expect(m).toEqual(['card_cc7a3f0c', 'card_cc7a3f0c']);
    });

    test('two distinct ids surface both', () => {
        const m = 'about card_aaaaaaaa and card_bbbbbbbb'.match(PATTERN);
        expect(m).toEqual(['card_aaaaaaaa', 'card_bbbbbbbb']);
    });
});
