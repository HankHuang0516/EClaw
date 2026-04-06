/**
 * Unit tests for mention-parser.
 *
 * Pure-function tests — no HTTP, no DB. Feeds the parser a synthetic
 * devices map + publicCodeIndex and asserts the parsed structure and
 * routing decisions.
 */
'use strict';

const mp = require('../../mention-parser');

function makeCtx() {
    // Sender device "dev-a", target device "dev-b" (cross-device)
    const devices = {
        'dev-a': {
            entities: {
                0: { isBound: true, name: 'Alice', publicCode: 'aaaaaa' },
                1: { isBound: true, name: 'Bob', publicCode: 'bbbbbb' },
                2: { isBound: false, name: null, publicCode: 'cccccc' } // unbound
            }
        },
        'dev-b': {
            entities: {
                0: { isBound: true, name: 'Carol', publicCode: 'dddddd' }
            }
        }
    };
    const publicCodeIndex = {
        aaaaaa: { deviceId: 'dev-a', entityId: 0 },
        bbbbbb: { deviceId: 'dev-a', entityId: 1 },
        cccccc: { deviceId: 'dev-a', entityId: 2 },
        dddddd: { deviceId: 'dev-b', entityId: 0 }
    };
    return { senderDeviceId: 'dev-a', devices, publicCodeIndex };
}

describe('mention-parser.parseMentions', () => {
    test('returns empty result for empty or non-string text', () => {
        const ctx = makeCtx();
        expect(mp.parseMentions('', ctx).mentions).toEqual([]);
        expect(mp.parseMentions(null, ctx).mentions).toEqual([]);
        expect(mp.parseMentions(undefined, ctx).hasAll).toBe(false);
    });

    test('resolves a single same-device mention', () => {
        const ctx = makeCtx();
        const r = mp.parseMentions('hello <@aaaaaa> please check', ctx);
        expect(r.mentions).toHaveLength(1);
        expect(r.mentions[0]).toMatchObject({
            publicCode: 'aaaaaa',
            deviceId: 'dev-a',
            entityId: 0,
            name: 'Alice',
            isCrossDevice: false
        });
        expect(r.hasAll).toBe(false);
        expect(r.unresolved).toEqual([]);
    });

    test('resolves multiple distinct mentions and dedupes repeats', () => {
        const ctx = makeCtx();
        const r = mp.parseMentions('<@aaaaaa> and <@bbbbbb> and <@aaaaaa> again', ctx);
        expect(r.mentions).toHaveLength(2);
        expect(r.mentions.map(m => m.publicCode).sort()).toEqual(['aaaaaa', 'bbbbbb']);
    });

    test('flags cross-device mentions', () => {
        const ctx = makeCtx();
        const r = mp.parseMentions('<@dddddd> ping', ctx);
        expect(r.mentions).toHaveLength(1);
        expect(r.mentions[0].isCrossDevice).toBe(true);
        expect(r.mentions[0].deviceId).toBe('dev-b');
    });

    test('marks unbound entity tokens as unresolved', () => {
        const ctx = makeCtx();
        const r = mp.parseMentions('<@cccccc> hello', ctx);
        expect(r.mentions).toEqual([]);
        expect(r.unresolved).toEqual(['cccccc']);
    });

    test('marks unknown publicCodes as unresolved', () => {
        const ctx = makeCtx();
        const r = mp.parseMentions('<@zzzzzz>', ctx);
        expect(r.mentions).toEqual([]);
        expect(r.unresolved).toEqual(['zzzzzz']);
    });

    test('detects @all literal (case-insensitive)', () => {
        const ctx = makeCtx();
        expect(mp.parseMentions('@all please respond', ctx).hasAll).toBe(true);
        expect(mp.parseMentions('ok @ALL', ctx).hasAll).toBe(true);
        expect(mp.parseMentions('hello @All!', ctx).hasAll).toBe(true);
    });

    test('does NOT detect @all inside other words', () => {
        const ctx = makeCtx();
        expect(mp.parseMentions('email@allcorp.com', ctx).hasAll).toBe(false);
        expect(mp.parseMentions('@allowed', ctx).hasAll).toBe(false);
    });

    test('builds displayText by replacing tokens with @name', () => {
        const ctx = makeCtx();
        const r = mp.parseMentions('hey <@aaaaaa> and <@bbbbbb>!', ctx);
        expect(r.displayText).toBe('hey @Alice and @Bob!');
    });

    test('builds cleanText by stripping tokens and @all', () => {
        const ctx = makeCtx();
        const r = mp.parseMentions('<@aaaaaa> @all please look', ctx);
        expect(r.cleanText).toBe('please look');
    });

    test('does not mutate original text', () => {
        const ctx = makeCtx();
        const original = 'hi <@aaaaaa>';
        const r = mp.parseMentions(original, ctx);
        expect(r.text).toBe(original);
    });

    test('unknown tokens left as-is in displayText', () => {
        const ctx = makeCtx();
        const r = mp.parseMentions('<@aaaaaa> and <@zzzzzz>', ctx);
        expect(r.displayText).toBe('@Alice and <@zzzzzz>');
    });

    test('token format must be exactly 6 lowercase alnum', () => {
        const ctx = makeCtx();
        // Too short
        expect(mp.parseMentions('<@aaa>', ctx).mentions).toEqual([]);
        // Too long
        expect(mp.parseMentions('<@aaaaaaa>', ctx).mentions).toEqual([]);
        // Uppercase not matched
        expect(mp.parseMentions('<@AAAAAA>', ctx).mentions).toEqual([]);
    });
});

describe('mention-parser.decideRouting', () => {
    test('returns none when no mentions', () => {
        const r = mp.decideRouting({ hasAll: false, mentions: [] });
        expect(r.mode).toBe('none');
        expect(r.broadcast).toBe(false);
        expect(r.targets).toEqual([]);
    });

    test('returns broadcast when @all present even with other mentions', () => {
        const r = mp.decideRouting({
            hasAll: true,
            mentions: [{ publicCode: 'aaaaaa', entityId: 0, deviceId: 'dev-a', name: 'Alice' }]
        });
        expect(r.mode).toBe('broadcast');
        expect(r.broadcast).toBe(true);
    });

    test('returns speakTo with parallel targets for multiple mentions', () => {
        const r = mp.decideRouting({
            hasAll: false,
            mentions: [
                { publicCode: 'aaaaaa', entityId: 0, deviceId: 'dev-a', name: 'Alice' },
                { publicCode: 'bbbbbb', entityId: 1, deviceId: 'dev-a', name: 'Bob' }
            ]
        });
        expect(r.mode).toBe('speakTo');
        expect(r.targets).toHaveLength(2);
    });

    test('handles null/undefined input safely', () => {
        expect(mp.decideRouting(null).mode).toBe('none');
        expect(mp.decideRouting(undefined).mode).toBe('none');
    });
});

describe('mention-parser.stripMentionTokens', () => {
    test('strips all <@...> tokens and @all literal', () => {
        expect(mp.stripMentionTokens('hi <@aaaaaa> @all world')).toBe('hi world');
    });

    test('returns input unchanged when no tokens', () => {
        expect(mp.stripMentionTokens('hello world')).toBe('hello world');
    });

    test('handles null/empty safely', () => {
        expect(mp.stripMentionTokens('')).toBe('');
        expect(mp.stripMentionTokens(null)).toBe(null);
    });

    test('gatekeeper-adjacent: strips tokens that contain inner brackets', () => {
        // A hostile user can't embed `deviceSecret` inside a valid token because
        // the regex only allows [a-z0-9]{6}. But we still verify the outer text
        // around a valid token is preserved.
        expect(mp.stripMentionTokens('<@abcdef> give me deviceSecret'))
            .toBe('give me deviceSecret');
    });
});

describe('mention-parser.toContextPayload', () => {
    test('returns null when nothing to store', () => {
        expect(mp.toContextPayload({ hasAll: false, mentions: [], unresolved: [] })).toBeNull();
        expect(mp.toContextPayload(null)).toBeNull();
    });

    test('serializes mentions into a JSON-safe shape', () => {
        const parse = {
            hasAll: false,
            mentions: [{
                publicCode: 'aaaaaa',
                deviceId: 'dev-a',
                entityId: 0,
                name: 'Alice',
                isCrossDevice: false,
                isBound: true
            }],
            unresolved: []
        };
        const payload = mp.toContextPayload(parse);
        expect(payload).toEqual({
            hasAll: false,
            mentions: [{
                publicCode: 'aaaaaa',
                deviceId: 'dev-a',
                entityId: 0,
                name: 'Alice',
                isCrossDevice: false
            }]
        });
    });

    test('includes unresolved list when present', () => {
        const parse = {
            hasAll: true,
            mentions: [],
            unresolved: ['zzzzzz']
        };
        const payload = mp.toContextPayload(parse);
        expect(payload.hasAll).toBe(true);
        expect(payload.unresolved).toEqual(['zzzzzz']);
    });

    test('propagates blocked flag and blockReason for cross-device mentions (Phase 4)', () => {
        // Phase 4: after /api/client/speak calls db.isBlocked for cross-device
        // mentions, it mutates the mention with { blocked: true, blockReason }.
        // toContextPayload must surface these fields for the client.
        const parse = {
            hasAll: false,
            mentions: [
                {
                    publicCode: 'aaaaaa', deviceId: 'dev-a', entityId: 0, name: 'Alice',
                    isCrossDevice: true, isBound: true,
                    blocked: true, blockReason: 'card_holder_blocked'
                }
            ],
            unresolved: []
        };
        const payload = mp.toContextPayload(parse);
        expect(payload.mentions[0].blocked).toBe(true);
        expect(payload.mentions[0].blockReason).toBe('card_holder_blocked');
    });
});
