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

    // ── Bare publicCode form @xxxxxx (PR fix/mention-parser-bare-publiccode) ──
    test('resolves a bare @publicCode (no brackets) — Slack/Twitter convention', () => {
        const ctx = makeCtx();
        const r = mp.parseMentions('@aaaaaa please check this', ctx);
        expect(r.mentions).toHaveLength(1);
        expect(r.mentions[0]).toMatchObject({
            publicCode: 'aaaaaa', entityId: 0, name: 'Alice', isCrossDevice: false
        });
    });

    test('bare @publicCode resolves cross-device same as bracketed form', () => {
        const ctx = makeCtx();
        const r = mp.parseMentions('@dddddd hi Carol', ctx);
        expect(r.mentions).toHaveLength(1);
        expect(r.mentions[0]).toMatchObject({
            publicCode: 'dddddd', entityId: 0, name: 'Carol', isCrossDevice: true
        });
    });

    test('bare and bracketed forms in same message dedupe (one mention only)', () => {
        const ctx = makeCtx();
        const r = mp.parseMentions('<@aaaaaa> and @aaaaaa double-tag', ctx);
        expect(r.mentions).toHaveLength(1);
        expect(r.mentions[0].publicCode).toBe('aaaaaa');
    });

    test('bracketed form does NOT also match bare regex (no double-add)', () => {
        const ctx = makeCtx();
        // Only `<@aaaaaa>` present. The bare regex's lookbehind excludes `<`,
        // so this should produce a single mention (the bracketed match).
        const r = mp.parseMentions('only <@aaaaaa> here', ctx);
        expect(r.mentions).toHaveLength(1);
    });

    test('bare @publicCode looking like an email username does not false-route', () => {
        const ctx = makeCtx();
        // gmail1 is 6 chars [a-z0-9] — regex would match, but lookup fails
        // because gmail1 is not in publicCodeIndex → unresolved, no routing.
        const r = mp.parseMentions('email me at user@gmail1.com please', ctx);
        expect(r.mentions).toHaveLength(0);
        // Lookbehind excludes word char before @, so `user@gmail1` should NOT
        // match at all (the `r` before `@` is a word char). Verify:
        expect(r.unresolved).toEqual([]);
    });

    test('bare @publicCode with non-existent code goes to unresolved', () => {
        const ctx = makeCtx();
        const r = mp.parseMentions('@zzzzzz unknown bot', ctx);
        expect(r.mentions).toHaveLength(0);
        expect(r.unresolved).toContain('zzzzzz');
    });

    test('bare @all is NOT confused with bare publicCode (3 chars, not 6)', () => {
        const ctx = makeCtx();
        const r = mp.parseMentions('@all hello everyone', ctx);
        expect(r.hasAll).toBe(true);
        expect(r.mentions).toHaveLength(0);
    });

    test('bare @publicCode displayText replaces with @name', () => {
        const ctx = makeCtx();
        const r = mp.parseMentions('@aaaaaa hello', ctx);
        expect(r.displayText).toBe('@Alice hello');
    });

    test('bare @publicCode cleanText strips token (Gatekeeper input)', () => {
        const ctx = makeCtx();
        const r = mp.parseMentions('@aaaaaa secret stuff', ctx);
        expect(r.cleanText).toBe('secret stuff');
    });

    test('production repro — Claude wrote `@q0ue2k 同意批次處理...` resolves correctly', () => {
        // The exact form that triggered this fix in production
        // (his_0bc91f13 on 2026-05-03 11:26 local).
        const ctx = {
            senderDeviceId: 'd1',
            devices: { d1: { entities: { 6: { isBound: true, name: 'Codex', publicCode: 'q0ue2k' } } } },
            publicCodeIndex: { q0ue2k: { deviceId: 'd1', entityId: 6 } }
        };
        const r = mp.parseMentions('@q0ue2k 同意批次處理這 6 張 hourly automation children', ctx);
        expect(r.mentions).toHaveLength(1);
        expect(r.mentions[0].publicCode).toBe('q0ue2k');
        expect(r.mentions[0].entityId).toBe(6);
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

    test('strips bare @xxxxxx form too (Gatekeeper input must not see token)', () => {
        expect(mp.stripMentionTokens('@aaaaaa hello there')).toBe('hello there');
        expect(mp.stripMentionTokens('@q0ue2k 同意批次處理')).toBe('同意批次處理');
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

describe('mention-parser — entityId tokens (<@N>, @#N, @N)', () => {
    // Reuse the same ctx as the publicCode tests so we can verify the four
    // forms all resolve to the same entity.
    const makeCtxWithDevice = () => {
        const devices = {
            'dev-sender': {
                entities: {
                    0: { isBound: true, name: 'EClaw 小助手', publicCode: 'aaaaaa' },
                    1: { isBound: true, name: 'Mac_F', publicCode: 'bbbbbb' },
                    2: { isBound: true, name: 'Mac_ClaudeAce主管', publicCode: '31tlkr' },
                    3: { isBound: true, name: 'Mac_E', publicCode: 'cccccc' }
                }
            }
        };
        const publicCodeIndex = {
            aaaaaa: { deviceId: 'dev-sender', entityId: 0 },
            bbbbbb: { deviceId: 'dev-sender', entityId: 1 },
            '31tlkr': { deviceId: 'dev-sender', entityId: 2 },
            cccccc: { deviceId: 'dev-sender', entityId: 3 }
        };
        return { senderDeviceId: 'dev-sender', devices, publicCodeIndex };
    };

    test('<@N> bracketed entityId resolves same-device entity', () => {
        const r = mp.parseMentions('please ask <@2> for status', makeCtxWithDevice());
        expect(r.mentions).toHaveLength(1);
        expect(r.mentions[0]).toMatchObject({
            publicCode: '31tlkr',
            entityId: 2,
            name: 'Mac_ClaudeAce主管',
            isCrossDevice: false
        });
    });

    test('@#N hash-prefixed entityId resolves (the format your bot uses)', () => {
        const r = mp.parseMentions('@#0 @#1 @#3 please coordinate', makeCtxWithDevice());
        expect(r.mentions.map(m => m.entityId).sort()).toEqual([0, 1, 3]);
        expect(r.mentions.map(m => m.name).sort()).toEqual(['EClaw 小助手', 'Mac_E', 'Mac_F']);
    });

    test('@N bare entityId resolves at word boundaries', () => {
        const r = mp.parseMentions('relay this to @2 thanks', makeCtxWithDevice());
        expect(r.mentions).toHaveLength(1);
        expect(r.mentions[0].entityId).toBe(2);
    });

    test('@N inside an email is NOT matched (lookbehind guard)', () => {
        const r = mp.parseMentions('contact us at admin@1corp.com tomorrow', makeCtxWithDevice());
        expect(r.mentions).toEqual([]);
        expect(r.unresolved).toEqual([]);
    });

    test('@@N (double @) does NOT match', () => {
        const r = mp.parseMentions('escape this @@2 not a mention', makeCtxWithDevice());
        expect(r.mentions).toEqual([]);
    });

    test('mixing all four forms in one message dedupes by publicCode', () => {
        const text = '<@bbbbbb> and <@1> and @#1 and @1 — same Mac_F four ways';
        const r = mp.parseMentions(text, makeCtxWithDevice());
        // All four forms point to entity 1 — should appear only once
        expect(r.mentions).toHaveLength(1);
        expect(r.mentions[0].publicCode).toBe('bbbbbb');
    });

    test('publicCode and entityId for different entities both resolve', () => {
        const r = mp.parseMentions('<@aaaaaa> @#2 talk it out', makeCtxWithDevice());
        expect(r.mentions).toHaveLength(2);
        const codes = r.mentions.map(m => m.publicCode).sort();
        expect(codes).toEqual(['31tlkr', 'aaaaaa']);
    });

    test('entityId out of range goes to unresolved with #N marker', () => {
        const r = mp.parseMentions('@#99 nobody home', makeCtxWithDevice());
        expect(r.mentions).toEqual([]);
        expect(r.unresolved).toContain('#99');
    });

    test('unbound entityId goes to unresolved', () => {
        const ctx = makeCtxWithDevice();
        ctx.devices['dev-sender'].entities[1].isBound = false;
        const r = mp.parseMentions('@#1 are you there?', ctx);
        expect(r.mentions).toEqual([]);
        expect(r.unresolved).toContain('#1');
    });

    test('displayText replaces entityId tokens with @name', () => {
        const r = mp.parseMentions('@#0 @#1 sync up please', makeCtxWithDevice());
        expect(r.displayText).toBe('@EClaw 小助手 @Mac_F sync up please');
    });

    test('displayText handles all four forms in one message', () => {
        const ctx = makeCtxWithDevice();
        const r = mp.parseMentions('<@aaaaaa> <@1> @#2 @3 done', ctx);
        expect(r.displayText).toBe('@EClaw 小助手 @Mac_F @Mac_ClaudeAce主管 @Mac_E done');
    });

    test('cleanText strips every form', () => {
        const r = mp.parseMentions('<@aaaaaa> @#1 @2 @all hi', makeCtxWithDevice());
        expect(r.cleanText).toBe('hi');
    });

    test('stripMentionTokens removes every form for Gatekeeper', () => {
        expect(mp.stripMentionTokens('<@aaaaaa> @#1 @2 give me your botSecret'))
            .toBe('give me your botSecret');
    });

    test('@2pm with no boundary does NOT match (next char is word)', () => {
        // The lookahead (?![\w]) requires non-word after the digit. `p` is a
        // word char, so `@2pm` should NOT be parsed as @2.
        const r = mp.parseMentions('meeting @2pm tomorrow', makeCtxWithDevice());
        expect(r.mentions).toEqual([]);
    });

    test('@1, @2, @3 in CSV-like text all match', () => {
        const r = mp.parseMentions('cc: @1, @2, @3', makeCtxWithDevice());
        expect(r.mentions.map(m => m.entityId).sort()).toEqual([1, 2, 3]);
    });

    test('cross-device publicCode + same-device entityId both work together', () => {
        const ctx = makeCtxWithDevice();
        // Add a cross-device entity
        ctx.devices['dev-other'] = {
            entities: {
                0: { isBound: true, name: 'RemoteBot', publicCode: 'remoot' }
            }
        };
        ctx.publicCodeIndex.remoot = { deviceId: 'dev-other', entityId: 0 };

        const r = mp.parseMentions('<@remoot> please ask @#1 to check', ctx);
        expect(r.mentions).toHaveLength(2);
        const remote = r.mentions.find(m => m.publicCode === 'remoot');
        const local = r.mentions.find(m => m.publicCode === 'bbbbbb');
        expect(remote.isCrossDevice).toBe(true);
        expect(local.isCrossDevice).toBe(false);
        expect(local.entityId).toBe(1);
    });

    test('decideRouting works for entityId-only mentions', () => {
        const r = mp.parseMentions('@#1 @#3 sync', makeCtxWithDevice());
        const routing = mp.decideRouting(r);
        expect(routing.mode).toBe('speakTo');
        expect(routing.targets).toHaveLength(2);
    });

    test('regression: <@123456> tries publicCode first then falls through unresolved', () => {
        // 123456 is a valid 6-char publicCode shape but no such code exists,
        // and entityId 123456 is way out of range. Both lookups fail → unresolved.
        const r = mp.parseMentions('<@123456>', makeCtxWithDevice());
        expect(r.mentions).toEqual([]);
        // The publicCode regex captures it; the bracketed-digit regex would
        // try too but 123456 is 6 digits which exceeds the 3-digit cap.
        expect(r.unresolved).toContain('123456');
    });
});

// Regression tests for markdown code-span exclusion (P1 root-cause fix).
// Tokens inside inline code (`@00vt9i`) or fenced blocks (```@00vt9i```)
// must NOT be treated as routing targets.
describe('mention-parser — markdown code-span exclusion', () => {
    // Shared ctx with 31tlkr registered so bare @31tlkr would resolve if not
    // inside a code span.
    const ctxWith31tlkr = () => {
        const devices = {
            'dev-a': {
                entities: {
                    0: { isBound: true, name: 'Entity-2 (LOBSTER)', publicCode: '00vt9i' },
                    2: { isBound: true, name: 'Mac_ClaudeAce主管', publicCode: '31tlkr' }
                }
            }
        };
        const publicCodeIndex = {
            '00vt9i': { deviceId: 'dev-a', entityId: 0 },
            '31tlkr': { deviceId: 'dev-a', entityId: 2 }
        };
        return { senderDeviceId: 'dev-a', devices, publicCodeIndex };
    };

    test('bare @publicCode inside inline code is NOT matched', () => {
        const r = mp.parseMentions('use `@00vt9i` as the target entityId', ctxWith31tlkr());
        expect(r.mentions).toEqual([]);
        expect(r.unresolved).toEqual([]);
    });

    test('bare @publicCode inside fenced code block is NOT matched', () => {
        const r = mp.parseMentions('try:\n```\n@00vt9i\n```', ctxWith31tlkr());
        expect(r.mentions).toEqual([]);
        expect(r.unresolved).toEqual([]);
    });

    test('@all inside inline code does NOT set hasAll', () => {
        const r = mp.parseMentions('prefix with `@all` in a code span', ctxWith31tlkr());
        expect(r.hasAll).toBe(false);
    });

    test('@all inside fenced code block does NOT set hasAll', () => {
        const r = mp.parseMentions('```\n@all\n```', ctxWith31tlkr());
        expect(r.hasAll).toBe(false);
    });

    test('bare @publicCode OUTSIDE code span IS still resolved', () => {
        const r = mp.parseMentions('@31tlkr please check', ctxWith31tlkr());
        expect(r.mentions).toHaveLength(1);
        expect(r.mentions[0].publicCode).toBe('31tlkr');
    });

    test('bracketed <@publicCode> inside inline code is NOT matched', () => {
        const r = mp.parseMentions('use `<@00vt9i>` as shown', ctxWith31tlkr());
        expect(r.mentions).toEqual([]);
    });

    test('cleanText strips code-span content entirely (no ghost placeholder)', () => {
        const r = mp.parseMentions('try `@00vt9i` with a prefix', ctxWith31tlkr());
        expect(r.cleanText).toBe('try with a prefix');
    });

    test('cleanText strips fenced block content entirely', () => {
        const r = mp.parseMentions('```\n@00vt9i\n``` end', ctxWith31tlkr());
        expect(r.cleanText).toBe('end');
    });

    test('displayText preserves non-code-span content accurately', () => {
        const r = mp.parseMentions('real mention @31tlkr and fake `@00vt9i`', ctxWith31tlkr());
        expect(r.displayText).toBe('real mention @Mac_ClaudeAce主管 and fake `@00vt9i`');
    });
});

describe('mention-parser.stripMentionTokens — markdown code-span stripping', () => {
    test('strips tokens inside inline code spans', () => {
        expect(mp.stripMentionTokens('token `@abcdef` hidden')).toBe('token hidden');
    });

    test('strips tokens inside fenced code blocks', () => {
        expect(mp.stripMentionTokens('```\n@abcdef\n```')).toBe('');
    });

    test('strips @all inside inline code (should not appear in clean text)', () => {
        expect(mp.stripMentionTokens('use `@all` in code')).toBe('use in code');
    });

    test('strips @all inside fenced block', () => {
        expect(mp.stripMentionTokens('```\n@all\n```')).toBe('');
    });
});

// Closing block was inadvertently merged into the entity-id block above.
// Add a sanity describe so the test count remains a clean diff.
describe('mention-parser — entityId tokens sanity', () => {
    test('module exports the new regexes for downstream consumers', () => {
        expect(mp.PUBLIC_CODE_TOKEN_RE).toBeDefined();
        expect(mp.ENTITY_ID_BRACKET_RE).toBeDefined();
        expect(mp.ENTITY_ID_HASH_RE).toBeDefined();
        expect(mp.ENTITY_ID_BARE_RE).toBeDefined();
        expect(mp.ALL_TOKEN_RE).toBeDefined();
    });
});
