/**
 * Unit tests for the sender-side mention-resolver helper.
 *
 * Asserts: parse() walks both <@code> and bare @label tokens, diff() flags
 * mentions that aren't in the caller's intended target list, and resolve()
 * preserves an explicit target-bar selection while auto-adding missing
 * @-mentions.
 */
'use strict';

const MR = require('../../public/portal/shared/mention-resolver');

function makePool() {
    return MR.buildPool({
        boundEntities: [
            { entityId: 2, publicCode: 'aaaaaa11', name: 'LOBSTER', character: 'LOBSTER' },
            { entityId: 3, publicCode: 'bbbbbb22', name: 'Mac_E', character: 'LOBSTER' },
            { entityId: 5, publicCode: 'cccccc33', name: 'Hermes', character: 'LOBSTER' }
        ],
        contacts: [
            { publicCode: 'remote01', name: 'Remote-Friend', character: 'PIG' },
            { publicCode: 'blocked9', name: 'Blocked-Bot', blocked: true }
        ]
    });
}

describe('mention-resolver.parse', () => {
    test('returns empty result for empty/non-string text', () => {
        expect(MR.parse('', makePool()).resolved).toEqual([]);
        expect(MR.parse(null, makePool()).resolved).toEqual([]);
        expect(MR.parse(123, makePool()).resolved).toEqual([]);
    });

    test('resolves wrapped autocomplete tokens <@code>', () => {
        const r = MR.parse('hi <@cccccc33> please ship', makePool());
        expect(r.localEntityIds).toEqual([5]);
        expect(r.unresolved).toEqual([]);
        expect(r.allTag).toBe(false);
    });

    test('resolves bare @name (display name)', () => {
        const r = MR.parse('@Hermes please ship', makePool());
        expect(r.localEntityIds).toEqual([5]);
        expect(r.resolved[0].label).toBe('Hermes');
    });

    test('resolves bare @code (publicCode)', () => {
        const r = MR.parse('@bbbbbb22 take this one', makePool());
        expect(r.localEntityIds).toEqual([3]);
    });

    test('case-insensitive label match', () => {
        const r = MR.parse('@hermes go', makePool());
        expect(r.localEntityIds).toEqual([5]);
    });

    test('@all sets allTag', () => {
        const r = MR.parse('@all standup in 5', makePool());
        expect(r.allTag).toBe(true);
        expect(r.localEntityIds).toEqual([]);
    });

    test('flags unknown @-tokens as unresolved', () => {
        const r = MR.parse('@Nobody @Hermes', makePool());
        expect(r.localEntityIds).toEqual([5]);
        expect(r.unresolved).toEqual(['Nobody']);
    });

    test('resolves cross-device contacts by name', () => {
        const r = MR.parse('@Remote-Friend ping', makePool());
        expect(r.remoteCodes).toEqual(['remote01']);
        expect(r.localEntityIds).toEqual([]);
    });

    test('skips blocked contacts', () => {
        const r = MR.parse('@Blocked-Bot hi', makePool());
        expect(r.unresolved).toEqual(['Blocked-Bot']);
    });

    test('dedupes when same entity is mentioned multiple ways', () => {
        const r = MR.parse('@Hermes <@cccccc33> @hermes', makePool());
        expect(r.localEntityIds).toEqual([5]);
    });

    test('does not match @ inside email-like strings', () => {
        const r = MR.parse('email me at user@example.com', makePool());
        expect(r.unresolved).toEqual([]);
        expect(r.localEntityIds).toEqual([]);
    });
});

describe('mention-resolver.diff', () => {
    test('flags missing local entityIds (Hermes typed, Mac_E intended)', () => {
        const parsed = MR.parse('@Hermes please ship', makePool());
        const d = MR.diff(parsed, { local: [3], contacts: [] });
        expect(d.missingLocal).toEqual([5]);
        expect(d.conflicts).toEqual([
            { kind: 'local', mentioned: 5, label: 'Hermes', code: 'cccccc33' }
        ]);
    });

    test('no conflict when mention matches target', () => {
        const parsed = MR.parse('@Hermes go', makePool());
        const d = MR.diff(parsed, { local: [5], contacts: [] });
        expect(d.missingLocal).toEqual([]);
        expect(d.conflicts).toEqual([]);
    });

    test('flags missing remote contact code', () => {
        const parsed = MR.parse('@Remote-Friend ping', makePool());
        const d = MR.diff(parsed, { local: [], contacts: [] });
        expect(d.missingRemote).toEqual(['remote01']);
    });

    test('case-insensitive match for contact codes already in target list', () => {
        const parsed = MR.parse('@Remote-Friend ping', makePool());
        const d = MR.diff(parsed, { local: [], contacts: ['REMOTE01'] });
        expect(d.missingRemote).toEqual([]);
    });
});

describe('mention-resolver.resolve (combined)', () => {
    test('end-to-end: target-bar empty, @-mentions become the target', () => {
        const r = MR.resolve('@Hermes ja batch please', { local: [], contacts: [] }, {
            boundEntities: [
                { entityId: 5, publicCode: 'cccccc33', name: 'Hermes' }
            ],
            contacts: []
        });
        expect(r.missingLocal).toEqual([5]);
        expect(r.allTag).toBe(false);
    });

    test('preserves target-bar selection while adding extra mentioned entity', () => {
        const r = MR.resolve('cc <@cccccc33>', { local: [3], contacts: [] }, {
            boundEntities: [
                { entityId: 3, publicCode: 'bbbbbb22', name: 'Mac_E' },
                { entityId: 5, publicCode: 'cccccc33', name: 'Hermes' }
            ]
        });
        expect(r.missingLocal).toEqual([5]);
        // Caller is responsible for merging missingLocal into targets;
        // resolver itself does not mutate input.
    });

    test('accepts a prebuilt pool object', () => {
        const pool = makePool();
        const r = MR.resolve('@Hermes', { local: [], contacts: [] }, pool);
        expect(r.missingLocal).toEqual([5]);
    });
});
