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

    test('hasCharacterChanged requires a previous entity snapshot', () => {
        expect(hook.hasCharacterChanged({ character: 'LOBSTER' }, null)).toBe(false);
        expect(hook.hasCharacterChanged({ character: 'LOBSTER' }, {})).toBe(true);
        expect(hook.hasCharacterChanged({ character: 'LOBSTER' }, { character: 'LOBSTER' })).toBe(false);
        expect(hook.hasCharacterChanged({ character: 'PIG' }, { character: 'LOBSTER' })).toBe(true);
        expect(hook.hasCharacterChanged(
            { entityId: 7, character: 'PIG' },
            { entityId: 8, character: 'LOBSTER' },
        )).toBe(false);
        expect(hook.hasCharacterChanged(
            { entityId: 7, character: 'PIG' },
            { entityId: 7, character: 'LOBSTER' },
        )).toBe(true);
    });

    test('isValidContext accepts only spec-listed sources when present', () => {
        expect(hook.isValidContext({ mode: 'bind', source: 'bind-endpoint' })).toBe(true);
        expect(hook.isValidContext({ mode: 'bind' })).toBe(true);
        expect(hook.isValidContext({ mode: 'bind', source: 'unknown' })).toBe(false);
        expect(hook.isValidContext({ mode: 'fictional', source: 'bind-endpoint' })).toBe(false);
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
    test('first-time bind appends the companion_select_log row (PR-B: no vault write)', async () => {
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
        // PR-B: the vault mirror is gone — the single SoT write is the audit log.
        expect(io.vars.PETDX_CURRENT_7).toBeUndefined();
        expect(io.vars.PETDX_AVATAR_7).toBeUndefined();
        expect(io.vars.PETDX_SOURCE_7).toBeUndefined();
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

    test('rebind mode without previousEntity cannot infer a refresh', async () => {
        const io = makeIo({
            PETDX_CURRENT_7: LOBSTER_COMPANION,
            PETDX_AVATAR_7:  LOBSTER_AVATAR_URL,
            PETDX_SOURCE_7:  'phase0-auto',
        });
        const result = await hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'PIG', avatar: null },
            { mode: 'rebind', source: 'bind-endpoint' },
            io,
        );
        expect(result).toEqual({ skipped: 'no_refresh_needed', source: undefined });
        expect(io.auditCalls).toHaveLength(0);
    });

    test('rebind mode ignores previousEntity snapshots from another slot', async () => {
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
                previousEntity: { entityId: 8, character: 'LOBSTER', avatar: LOBSTER_EMOJI },
                source: 'bind-endpoint',
            },
            io,
        );
        expect(result).toEqual({ skipped: 'no_refresh_needed', source: undefined });
        expect(io.auditCalls).toHaveLength(0);
    });

    test('character-change mode skips when previousEntity is missing or unchanged', async () => {
        const ioMissing = makeIo({
            PETDX_CURRENT_7: LOBSTER_COMPANION,
            PETDX_AVATAR_7:  LOBSTER_AVATAR_URL,
            PETDX_SOURCE_7:  'phase0-auto',
        });
        await expect(hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'PIG', avatar: null },
            { mode: 'character-change', source: 'transform' },
            ioMissing,
        )).resolves.toEqual({ skipped: 'no_refresh_needed', source: undefined });

        const ioUnchanged = makeIo({
            PETDX_CURRENT_7: LOBSTER_COMPANION,
            PETDX_AVATAR_7:  LOBSTER_AVATAR_URL,
            PETDX_SOURCE_7:  'phase0-auto',
        });
        await expect(hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'LOBSTER', avatar: null },
            {
                mode: 'character-change',
                source: 'transform',
                previousEntity: { entityId: 7, character: 'LOBSTER', avatar: LOBSTER_EMOJI },
            },
            ioUnchanged,
        )).resolves.toEqual({ skipped: 'no_refresh_needed', source: undefined });
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

    test('source tag without current companion is still authoritative', async () => {
        const io = makeIo({
            PETDX_SOURCE_7: 'rental-inherited',
        });
        const result = await hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'LOBSTER', avatar: null },
            { mode: 'bind' },
            io,
        );
        expect(result).toEqual({ skipped: 'preserves_existing_source', source: 'rental-inherited' });
        expect(io.vars.PETDX_CURRENT_7).toBeUndefined();
        expect(io.auditCalls).toHaveLength(0);
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

    test('unknown context source returns invalid_context_source skipped', async () => {
        const io = makeIo();
        const result = await hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'LOBSTER', avatar: null },
            { mode: 'bind', source: 'unknown-source' },
            io,
        );
        expect(result.skipped).toBe('invalid_context_source');
        expect(io.vars.PETDX_CURRENT_7).toBeUndefined();
    });

    test('companion_select_log write failure is FATAL (log is the only SoT write)', async () => {
        const io = makeIo();
        io.appendCompanionSelectLog = async () => { throw new Error('log boom'); };
        const result = await hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'LOBSTER', avatar: null },
            { mode: 'bind' },
            io,
        );
        expect(result).toEqual({ skipped: 'log_write_failed' });
        // PR-B: no vault mirror is written at all.
        expect(io.vars.PETDX_CURRENT_7).toBeUndefined();
        expect(io.vars.PETDX_SOURCE_7).toBeUndefined();
    });
});

// PR-A — idempotency reads now come from companion_select_log via
// io.getLatestSelection (the DB source of truth), not the PETDX_ vault mirror.
function makeDbIo(seedSelection = null) {
    const vars = {};
    const auditCalls = [];
    const logCalls = [];
    let selection = seedSelection;
    return {
        vars,
        auditCalls,
        logCalls,
        async getLatestSelection(_deviceId, _entityId) { return selection; },
        async getDeviceVar() { throw new Error('getDeviceVar must not be used when getLatestSelection exists'); },
        async setDeviceVar(_deviceId, key, value) { vars[key] = value; },
        async appendCompanionSelectLog(entry) {
            auditCalls.push(entry);
            selection = { companionId: entry.companionId, source: entry.origin };
        },
        log(level, tag, message, meta) { logCalls.push({ level, tag, message, meta }); },
    };
}

describe('petdx-phase0-hook — SoT read via getLatestSelection (PR-A)', () => {
    test('first-time bind with no prior selection assigns + appends log', async () => {
        const io = makeDbIo(null);
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
        expect(io.auditCalls).toHaveLength(1);
        expect(io.auditCalls[0]).toMatchObject({ origin: 'phase0-auto', source: 'api' });
    });

    test('second bind is a no-op when a phase0 selection already exists in the log', async () => {
        const io = makeDbIo({ companionId: LOBSTER_COMPANION, source: 'phase0-auto' });
        const result = await hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'LOBSTER', avatar: LOBSTER_EMOJI },
            { mode: 'bind' },
            io,
        );
        expect(result).toEqual({ skipped: 'already_assigned', source: undefined });
        expect(io.auditCalls).toHaveLength(0);
    });

    test('user-selected selection in the log is preserved', async () => {
        const io = makeDbIo({ companionId: 'petdx-custom-001', source: 'user-selected' });
        const result = await hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'LOBSTER', avatar: LOBSTER_EMOJI },
            { mode: 'bind' },
            io,
        );
        expect(result).toEqual({ skipped: 'preserves_existing_source', source: 'user-selected' });
        expect(io.auditCalls).toHaveLength(0);
    });

    test('null selection (e.g. PR-B unbind tombstone) makes a rebound entity re-assignable', async () => {
        // getLatestSelection returns null after a tombstone, so bind proceeds.
        const io = makeDbIo(null);
        const result = await hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'LOBSTER', avatar: null },
            { mode: 'bind', source: 'bind-endpoint' },
            io,
        );
        expect(result.assigned).toBe(LOBSTER_COMPANION);
        expect(io.auditCalls).toHaveLength(1);
    });

    test('getLatestSelection failure short-circuits with selection_read_failed', async () => {
        const io = makeDbIo(null);
        io.getLatestSelection = async () => { throw new Error('db down'); };
        const result = await hook.assignDefaultCompanionIfMissing(
            'D1',
            { entityId: 7, character: 'LOBSTER', avatar: null },
            { mode: 'bind' },
            io,
        );
        expect(result).toEqual({ skipped: 'selection_read_failed' });
        expect(io.auditCalls).toHaveLength(0);
    });
});
