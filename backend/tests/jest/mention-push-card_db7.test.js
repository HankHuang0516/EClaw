/**
 * Unit tests — user-mention scanner (card_db71f4423cb1697f9935f460).
 *
 * Pure-function tests: feeds the scanner a synthetic devices map and
 * asserts the resolved mentions. No HTTP, no DB. Also asserts the
 * notification-prefs default block exposes the new `user_mention`
 * toggle and that it is gated correctly by isCategoryEnabled.
 */
'use strict';

const ums = require('../../user-mention-scanner');
const notif = require('../../notifications');

function makeDevices() {
    // Three devices with display names + one with none.
    return {
        'dev-hank': { userDisplayName: 'Hank' },
        'dev-hank-dev': { userDisplayName: 'HankDev' },
        'dev-alice': { userDisplayName: 'Alice Wong' },     // contains a space
        'dev-yuki':  { userDisplayName: 'ユキ' },             // CJK
        'dev-noname':{ userDisplayName: null }                // not indexed
    };
}

describe('normalizeNameKey', () => {
    test('lowercases + trims + collapses whitespace', () => {
        expect(ums.normalizeNameKey('  Hank  Dev  ')).toBe('hank dev');
    });
    test('returns null for null/undefined/non-string/empty', () => {
        expect(ums.normalizeNameKey(null)).toBeNull();
        expect(ums.normalizeNameKey(undefined)).toBeNull();
        expect(ums.normalizeNameKey('')).toBeNull();
        expect(ums.normalizeNameKey('   ')).toBeNull();
        expect(ums.normalizeNameKey(42)).toBeNull();
    });
    test('NFKC folds half-width and full-width forms', () => {
        // 'Ｈａｎｋ' = full-width latin → after NFKC + lowercase → 'hank'
        expect(ums.normalizeNameKey('Ｈａｎｋ')).toBe('hank');
    });
});

describe('isClaimedByEntityParser', () => {
    test('@all (any case) is claimed', () => {
        expect(ums.isClaimedByEntityParser('all')).toBe(true);
        expect(ums.isClaimedByEntityParser('All')).toBe(true);
        expect(ums.isClaimedByEntityParser('ALL')).toBe(true);
    });
    test('1-3 ASCII digits is claimed (entityId form)', () => {
        expect(ums.isClaimedByEntityParser('1')).toBe(true);
        expect(ums.isClaimedByEntityParser('42')).toBe(true);
        expect(ums.isClaimedByEntityParser('999')).toBe(true);
    });
    test('4+ digits NOT claimed', () => {
        expect(ums.isClaimedByEntityParser('1234')).toBe(false);
    });
    test('6-char lowercase alnum is claimed (publicCode form)', () => {
        expect(ums.isClaimedByEntityParser('abc123')).toBe(true);
        expect(ums.isClaimedByEntityParser('aaaaaa')).toBe(true);
    });
    test('6-char with mixed case is also claimed (lowercased internally)', () => {
        expect(ums.isClaimedByEntityParser('AbC123')).toBe(true);
    });
    test('5 or 7 chars NOT claimed', () => {
        expect(ums.isClaimedByEntityParser('abcde')).toBe(false);
        expect(ums.isClaimedByEntityParser('abcdefg')).toBe(false);
    });
    test('CJK + general words NOT claimed', () => {
        expect(ums.isClaimedByEntityParser('hank')).toBe(false);
        expect(ums.isClaimedByEntityParser('ユキ')).toBe(false);
    });
});

describe('buildIndex', () => {
    test('indexes only devices with a normalized display name', () => {
        const { index, keysByLength } = ums.buildIndex(makeDevices());
        expect(index.has('hank')).toBe(true);
        expect(index.has('hankdev')).toBe(true);
        expect(index.has('alice wong')).toBe(true);
        expect(index.has('ユキ')).toBe(true);
        // dev-noname has null → skipped
        expect(index.size).toBe(4);
        // longest first
        expect(keysByLength[0].length).toBeGreaterThanOrEqual(keysByLength.at(-1).length);
    });
    test('returns empty index for empty/null devices', () => {
        expect(ums.buildIndex(null).index.size).toBe(0);
        expect(ums.buildIndex({}).index.size).toBe(0);
        expect(ums.buildIndex(undefined).index.size).toBe(0);
    });
});

describe('findUserMentions — basic matching', () => {
    test('matches a single bare @<display name>', () => {
        const r = ums.findUserMentions('hey @Hank can you take a look', { senderDeviceId: 'other', devices: makeDevices() });
        expect(r).toHaveLength(1);
        expect(r[0].deviceId).toBe('dev-hank');
        expect(r[0].displayName).toBe('Hank');
        expect(r[0].matchedKey).toBe('hank');
    });

    test('longest-prefix wins (HankDev beats Hank)', () => {
        const r = ums.findUserMentions('ping @HankDev now', { senderDeviceId: 'other', devices: makeDevices() });
        expect(r).toHaveLength(1);
        expect(r[0].deviceId).toBe('dev-hank-dev');
    });

    test('case-insensitive', () => {
        const r = ums.findUserMentions('ok @HANK', { senderDeviceId: 'other', devices: makeDevices() });
        expect(r).toHaveLength(1);
        expect(r[0].deviceId).toBe('dev-hank');
    });

    test('CJK display name', () => {
        const r = ums.findUserMentions('お願い @ユキ さん', { senderDeviceId: 'other', devices: makeDevices() });
        expect(r).toHaveLength(1);
        expect(r[0].deviceId).toBe('dev-yuki');
    });

    test('quoted form matches display name with a space', () => {
        const r = ums.findUserMentions('cc @"Alice Wong" please', { senderDeviceId: 'other', devices: makeDevices() });
        expect(r).toHaveLength(1);
        expect(r[0].deviceId).toBe('dev-alice');
        expect(r[0].isQuoted).toBe(true);
    });

    test('multiple mentions of different users → multiple results, first-occurrence order', () => {
        const r = ums.findUserMentions('hey @Hank and @ユキ', { senderDeviceId: 'other', devices: makeDevices() });
        expect(r.map(x => x.deviceId)).toEqual(['dev-hank', 'dev-yuki']);
    });

    test('per-message dedupe — same user mentioned twice → one result', () => {
        const r = ums.findUserMentions('@Hank @Hank @Hank', { senderDeviceId: 'other', devices: makeDevices() });
        expect(r).toHaveLength(1);
    });
});

describe('findUserMentions — non-matches / boundary safety', () => {
    test('email address does NOT match', () => {
        // 'hank' is the display name — but the @ is preceded by a word char.
        const r = ums.findUserMentions('contact me at hank@example.com', { senderDeviceId: 'other', devices: makeDevices() });
        expect(r).toEqual([]);
    });

    test('inside an existing entity-mention token does NOT match', () => {
        // <@hank01> — even if "hank" is a prefix, the leading `<` blocks the boundary.
        const r = ums.findUserMentions('hello <@hank01> world', { senderDeviceId: 'other', devices: makeDevices() });
        expect(r).toEqual([]);
    });

    test('bare 6-char alnum token is deferred to entity parser (publicCode)', () => {
        // 'hank01' is 6 chars alnum → entity parser owns it; even though
        // 'hank' would prefix-match, we skip the whole token.
        const r = ums.findUserMentions('ping @hank01 now', { senderDeviceId: 'other', devices: makeDevices() });
        expect(r).toEqual([]);
    });

    test('bare @<1-3 digits> is deferred to entity parser', () => {
        const r = ums.findUserMentions('hey @42', { senderDeviceId: 'other', devices: makeDevices() });
        expect(r).toEqual([]);
    });

    test('@all is deferred to entity parser', () => {
        const r = ums.findUserMentions('@all hey', { senderDeviceId: 'other', devices: makeDevices() });
        expect(r).toEqual([]);
    });

    test('@#<digits> is deferred to entity parser', () => {
        // @#1 has a `#` after the `@`, which is not a word char so our
        // readWordToken returns empty token and we skip cleanly.
        const r = ums.findUserMentions('hey @#1 please', { senderDeviceId: 'other', devices: makeDevices() });
        expect(r).toEqual([]);
    });

    test('unmatched display name does NOT produce a result', () => {
        const r = ums.findUserMentions('hey @Bob', { senderDeviceId: 'other', devices: makeDevices() });
        expect(r).toEqual([]);
    });

    test('null display names are not indexed (no false match)', () => {
        // dev-noname has null userDisplayName — should not match anything.
        const r = ums.findUserMentions('hi @noname', { senderDeviceId: 'other', devices: makeDevices() });
        expect(r).toEqual([]);
    });

    test('partial-word match suppressed (Hank in Hankering)', () => {
        // 'Hankering' has 'hank' as prefix but the next char 'e' is a word
        // char → boundary check rejects the prefix-match.
        const r = ums.findUserMentions('this is @Hankering not Hank', { senderDeviceId: 'other', devices: makeDevices() });
        expect(r).toEqual([]);
    });

    test('self-mention suppressed', () => {
        // Sender is dev-hank → his own @Hank does not push to himself.
        const r = ums.findUserMentions('hey @Hank yo', { senderDeviceId: 'dev-hank', devices: makeDevices() });
        expect(r).toEqual([]);
    });

    test('empty text / null / non-string returns empty', () => {
        expect(ums.findUserMentions('', { senderDeviceId: 'other', devices: makeDevices() })).toEqual([]);
        expect(ums.findUserMentions(null, { senderDeviceId: 'other', devices: makeDevices() })).toEqual([]);
        expect(ums.findUserMentions(undefined, { senderDeviceId: 'other', devices: makeDevices() })).toEqual([]);
        expect(ums.findUserMentions(42, { senderDeviceId: 'other', devices: makeDevices() })).toEqual([]);
    });

    test('missing ctx returns empty', () => {
        expect(ums.findUserMentions('hi @Hank', null)).toEqual([]);
    });

    test('devices map with no display names returns empty', () => {
        const r = ums.findUserMentions('hey @Hank', { senderDeviceId: 'other', devices: { 'a': {}, 'b': { userDisplayName: '' } } });
        expect(r).toEqual([]);
    });
});

describe('findUserMentions — ReDoS / pathological inputs', () => {
    test('100k @s caps work at MAX_TOKENS_PER_MESSAGE', () => {
        const text = '@'.repeat(100000);
        const t0 = Date.now();
        const r = ums.findUserMentions(text, { senderDeviceId: 'other', devices: makeDevices() });
        const elapsed = Date.now() - t0;
        // No match (bare @ followed by @ → no word token).
        expect(r).toEqual([]);
        // Must complete fast even with 100k @s.
        expect(elapsed).toBeLessThan(500);
    });

    test('very long word after @ is bounded by MAX_TOKEN_SCAN_LEN', () => {
        const longWord = 'a'.repeat(50000);
        const text = `prefix @${longWord} suffix`;
        const t0 = Date.now();
        const r = ums.findUserMentions(text, { senderDeviceId: 'other', devices: makeDevices() });
        const elapsed = Date.now() - t0;
        expect(r).toEqual([]); // no match in index, but must NOT hang
        expect(elapsed).toBeLessThan(500);
    });

    test('many @-tokens that prefix-match Hank — caps at unique-deviceId dedupe', () => {
        const parts = [];
        for (let i = 0; i < 500; i++) parts.push('@Hank');
        const r = ums.findUserMentions(parts.join(' '), { senderDeviceId: 'other', devices: makeDevices() });
        expect(r).toHaveLength(1);
    });
});

describe('findUserMentions — quoted form edge cases', () => {
    test('unclosed quote falls through to bare-word parsing', () => {
        // '@"Alice Wong' has no closing quote — readQuotedToken returns null,
        // bare reader collects nothing (since `"` is not a word char) →
        // no match.
        const r = ums.findUserMentions('@"Alice Wong', { senderDeviceId: 'other', devices: makeDevices() });
        expect(r).toEqual([]);
    });

    test('quoted form is exact-match (not prefix)', () => {
        // @"Hank " (trailing space) won't normalize to "hank " — it'll be
        // "hank" → matches dev-hank. NFKC + trim semantics.
        const r = ums.findUserMentions('cc @"Hank " ok', { senderDeviceId: 'other', devices: makeDevices() });
        expect(r).toHaveLength(1);
        expect(r[0].deviceId).toBe('dev-hank');
    });

    test('quoted form does not match an unknown name', () => {
        const r = ums.findUserMentions('@"Nobody Here"', { senderDeviceId: 'other', devices: makeDevices() });
        expect(r).toEqual([]);
    });
});

describe('notifications module — user_mention toggle', () => {
    test('user_mention key exists in DEFAULT_PREFS and defaults true', () => {
        expect(notif.DEFAULT_PREFS).toHaveProperty('user_mention', true);
    });

    test('isCategoryEnabled honors explicit false for user_mention', () => {
        expect(notif.isCategoryEnabled({ user_mention: false }, 'user_mention')).toBe(false);
        expect(notif.isCategoryEnabled({ user_mention: true }, 'user_mention')).toBe(true);
    });

    test('isCategoryEnabled defaults to true when key missing (covered by getPrefs merging DEFAULT_PREFS, but verified here for the gate)', () => {
        expect(notif.isCategoryEnabled({}, 'user_mention')).toBe(true);
    });
});
