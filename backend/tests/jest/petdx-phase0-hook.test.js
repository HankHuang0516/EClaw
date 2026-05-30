const hook = require('../../petdx-phase0-hook');

const LOBSTER_EMOJI = '\u{1F99E}';
const PIG_EMOJI     = '\u{1F437}';
const LOBSTER_COMPANION = 'petdx-lobster-default';
const LOBSTER_AVATAR_URL = '/static/companions/petdx-lobster-default/avatar.png';

function makeIo(initialVars = {}) {
    const vars = { ...initialVars };
    const logCalls = [];
    const auditCalls = [];
    return {
        vars,
        logCalls,
        auditCalls,
        async getDeviceVar(_deviceId, key) { return vars[key] || null; },
        async setDeviceVar(_deviceId, key, value) { vars[key] = value; },
        async appendCompanionSelectLog(entry) { auditCalls.push(entry); },
        log(level, tag, message, meta) { logCalls.push({ level, tag, message, meta }); },
    };
}

describe('petdx-phase0-hook — pure helpers', () => {
    test('isCharacterDefaultAvatar accepts null / empty / lobster / pig emoji', () => {
        expect(hook.isCharacterDefaultAvatar(null)).toBe(true);
        expect(hook.isCharacterDefaultAvatar(undefined)).toBe(true);
        expect(hook.isCharacterDefaultAvatar('')).toBe(true);
        expect(hook.isCharacterDefaultAvatar(LOBSTER_EMOJI)).toBe(true);
        expect(hook.isCharacterDefaultAvatar(PIG_EMOJI)).toBe(true);
    });

    test('isCharacterDefaultAvatar rejects user-set emoji and URLs', () => {
        expect(hook.isCharacterDefaultAvatar('\u{1F431}')).toBe(false); // 🐱
        expect(hook.isCharacterDefaultAvatar('https://example.com/me.png')).toBe(false);
    });

    test('pickDefaultCompanion uses identity.public.companionId when present', () => {
        const id = hook.pickDefaultCompanion({
            character: 'LOBSTER',
            identity: { public: { companionId: 'petdx-custom-001' } },
        });
        expect(id).toBe('petdx-custom-001');
    });

    test('pickDefaultCompanion falls back to character → lobster (Phase 0)', () => {
        expect(hook.pickDefaultCompanion({ character: 'LOBSTER' })).toBe(LOBSTER_COMPANION);
        expect(hook.pickDefaultCompanion({ character: 'PIG' })).toBe(LOBSTER_COMPANION);
        expect(hook.pickDefaultCompanion({ character: 'BEAR' })).toBe(LOBSTER_COMPANION);
    });

    test('pickDefaultCompanion falls back to system default for unknown character', () => {
        expect(hook.pickDefaultCompanion({ character: 'SHEEP' })).toBe(LOBSTER_COMPANION);
        expect(hook.pickDefaultCompanion({})).toBe(LOBSTER_COMPANION);
    });

    test('avatarUrlFor matches spec §0.4 URL shape', () => {
        expect(hook.avatarUrlFor(LOBSTER_COMPANION)).toBe(LOBSTER_AVATAR_URL);
    });

    test('pickNewSource returns phase0-backfill in backfill mode, phase0-auto otherwise', () => {
        expect(hook.pickNewSource({ mode: 'backfill' })).toBe('phase0-backfill');
        expect(hook.pickNewSource({ mode: 'bind' })).toBe('phase0-auto');
        expect(hook.pickNewSource({ mode: 'rebind' })).toBe('phase0-auto');
        expect(hook.pickNewSource({ mode: 'character-change' })).toBe('phase0-auto');
    });
});

describe('petdx-phase0-hook — assignDefaultCompanionIfMissing', () => {
    test('first-time bind writes all 3 vault keys + audit log', async () => {
        const io = makeIo();
        const result = await hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'LOBSTER', avatar: null },
            { mode: 'bind', source: 'bind-endpoint' },
            io,
        );
        expect(result).toEqual({
            assigned: LOBSTER_COMPANION,
            avatarUrl: LOBSTER_AVATAR_URL,
            source: 'phase0-auto',
        });
        expect(io.vars.PETDX_CURRENT_7).toBe(LOBSTER_COMPANION);
        expect(io.vars.PETDX_AVATAR_7).toBe(LOBSTER_AVATAR_URL);
        expect(io.vars.PETDX_SOURCE_7).toBe('phase0-auto');
        expect(io.auditCalls).toHaveLength(1);
        expect(io.auditCalls[0]).toMatchObject({
            entityId: 7,
            companionId: LOBSTER_COMPANION,
            source: 'api',
            origin: 'phase0-auto',
            ctxMode: 'bind',
            ctxSource: 'bind-endpoint',
        });
    });

    test('second bind is a no-op when phase0-auto already set', async () => {
        const io = makeIo({
            PETDX_CURRENT_7: LOBSTER_COMPANION,
            PETDX_AVATAR_7:  LOBSTER_AVATAR_URL,
            PETDX_SOURCE_7:  'phase0-auto',
        });
        const result = await hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'LOBSTER', avatar: LOBSTER_EMOJI },
            { mode: 'bind' },
            io,
        );
        expect(result).toEqual({ skipped: 'already_assigned', source: undefined });
        expect(io.auditCalls).toHaveLength(0);
    });

    test('rebind with character change + default avatar refreshes vault', async () => {
        const io = makeIo({
            PETDX_CURRENT_7: LOBSTER_COMPANION,
            PETDX_AVATAR_7:  LOBSTER_AVATAR_URL,
            PETDX_SOURCE_7:  'phase0-auto',
        });
        const result = await hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'PIG', avatar: null },
            {
                mode: 'rebind',
                previousEntity: { entityId: 7, character: 'LOBSTER', avatar: LOBSTER_EMOJI },
                source: 'bind-endpoint',
            },
            io,
        );
        // Phase 0 still resolves PIG → lobster, so the URL stays the same, but
        // the audit row + ctxMode log a refresh. Vault values rewritten.
        expect(result.assigned).toBe(LOBSTER_COMPANION);
        expect(result.source).toBe('phase0-auto');
        expect(io.auditCalls[0].ctxMode).toBe('rebind');
    });

    test('rebind with custom avatar preserves user choice', async () => {
        const io = makeIo({});
        const result = await hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'LOBSTER', avatar: 'https://example.com/me.png' },
            { mode: 'rebind', previousEntity: { entityId: 7, character: 'PIG' } },
            io,
        );
        expect(result).toEqual({ skipped: 'user-custom-avatar', source: undefined });
        expect(io.vars.PETDX_CURRENT_7).toBeUndefined();
        expect(io.auditCalls).toHaveLength(0);
    });

    test('existing PETDX_CURRENT with user-selected source is preserved', async () => {
        const io = makeIo({
            PETDX_CURRENT_7: 'petdx-custom-001',
            PETDX_AVATAR_7:  '/static/companions/petdx-custom-001/avatar.png',
            PETDX_SOURCE_7:  'user-selected',
        });
        const result = await hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'LOBSTER', avatar: LOBSTER_EMOJI },
            { mode: 'bind' },
            io,
        );
        expect(result).toEqual({ skipped: 'preserves_existing_source', source: 'user-selected' });
        expect(io.vars.PETDX_CURRENT_7).toBe('petdx-custom-001'); // unchanged
    });

    test('existing PETDX_CURRENT with missing source refuses overwrite', async () => {
        const io = makeIo({
            PETDX_CURRENT_7: 'petdx-legacy',
        });
        const result = await hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'LOBSTER', avatar: null },
            { mode: 'bind' },
            io,
        );
        expect(result).toEqual({ skipped: 'missing_source_tag_refuse_overwrite', source: undefined });
        expect(io.vars.PETDX_CURRENT_7).toBe('petdx-legacy');
        expect(io.logCalls.some(l => l.message === 'untrusted-current-without-source')).toBe(true);
    });

    test('leased_in rental skips auto-assignment', async () => {
        const io = makeIo();
        const result = await hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'LOBSTER', avatar: null, rental_status: 'leased_in' },
            { mode: 'bind' },
            io,
        );
        expect(result).toEqual({ skipped: 'rental-leased-in', source: undefined });
        expect(io.vars.PETDX_CURRENT_7).toBeUndefined();
    });

    test('backfill mode tags audit with phase0-backfill', async () => {
        const io = makeIo();
        const result = await hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'LOBSTER', avatar: null },
            { mode: 'backfill', source: 'backfill-script' },
            io,
        );
        expect(result.source).toBe('phase0-backfill');
        expect(io.vars.PETDX_SOURCE_7).toBe('phase0-backfill');
        expect(io.auditCalls[0].origin).toBe('phase0-backfill');
        expect(io.auditCalls[0].ctxSource).toBe('backfill-script');
    });

    test('invalid mode returns invalid_mode skipped', async () => {
        const io = makeIo();
        const result = await hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'LOBSTER', avatar: null },
            { mode: 'unknown' },
            io,
        );
        expect(result.skipped).toBe('invalid_mode');
    });

    test('vault write failure is reported, no audit', async () => {
        const io = makeIo();
        io.setDeviceVar = async () => { throw new Error('boom'); };
        const result = await hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'LOBSTER', avatar: null },
            { mode: 'bind' },
            io,
        );
        expect(result.skipped).toBe('vault_write_failed');
        expect(io.auditCalls).toHaveLength(0);
    });

    test('audit log failure is non-fatal (vault writes succeed)', async () => {
        const io = makeIo();
        io.appendCompanionSelectLog = async () => { throw new Error('audit boom'); };
        const result = await hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'LOBSTER', avatar: null },
            { mode: 'bind' },
            io,
        );
        expect(result.assigned).toBe(LOBSTER_COMPANION);
        expect(io.vars.PETDX_SOURCE_7).toBe('phase0-auto');
    });
});
