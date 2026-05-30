/**
 * Petdx Phase 0 — default companion auto-assignment hook.
 *
 * Spec: docs/specs/petdx-uiux-spec-amendment-2026-05-30-phase-0.md v0.6
 *
 * This module is intentionally side-effect-free at require time. Callers wire
 * `assignDefaultCompanionIfMissing` into the five bind entry points listed in
 * spec §0.3, plus the standalone backfill script (§0.5).
 *
 * Storage contract (per spec §0.2a):
 *
 *   PETDX_CURRENT_<entityId>   — companion id ('petdx-lobster-default')
 *   PETDX_AVATAR_<entityId>    — avatar.png URL (cached on client)
 *   PETDX_SOURCE_<entityId>    — origin tag, value ∈ {
 *                                  'phase0-auto'      (bind/rebind/character-change hook),
 *                                  'phase0-backfill'  (backfill script),
 *                                  'user-selected'    (companion-select endpoint),
 *                                  'rental-inherited' (lessor inheritance)
 *                                }
 *
 * Audit log (per spec §0.2a + the 2026-05-30-companion-origin.sql migration):
 *   companion_select_log.source = 'api'           (existing CHECK column)
 *   companion_select_log.origin = <newSource>     (new column)
 */

'use strict';

const LOBSTER_EMOJI = '\u{1F99E}';
const PIG_EMOJI     = '\u{1F437}';

/**
 * Character → companion id table. Per spec §0.2, Phase 0 ships only the
 * lobster descriptor; non-Lobster characters resolve to lobster until the
 * Phase 0.1 descriptors land. Keep this in sync with the spec.
 */
const CHARACTER_COMPANION = {
    LOBSTER: 'petdx-lobster-default',
    PIG:     'petdx-lobster-default',
    CHICKEN: 'petdx-lobster-default',
    CAT:     'petdx-lobster-default',
    DOG:     'petdx-lobster-default',
    BEAR:    'petdx-lobster-default',
};
const SYSTEM_DEFAULT_COMPANION = 'petdx-lobster-default';

/**
 * The avatar URL shape that the resolver expects. See spec §0.4 and the
 * /static/companions express.static mount added in backend/index.js.
 */
function avatarUrlFor(companionId) {
    return `/static/companions/${companionId}/avatar.png`;
}

/**
 * Mirrors backend _isCharacterDefaultAvatar (see backend/index.js + the jest
 * test character-avatar-sync.test.js). Treats null / empty / Lobster / Pig
 * emoji as a system-default avatar; anything else (custom emoji, URL) is a
 * user-set value that Phase 0 must preserve.
 */
function isCharacterDefaultAvatar(avatar) {
    if (avatar === null || avatar === undefined || avatar === '') return true;
    if (avatar === LOBSTER_EMOJI) return true;
    if (avatar === PIG_EMOJI)     return true;
    return false;
}

/**
 * Pick the companion for a fresh / rebound entity per spec §0.2 priority:
 *   1. identity.public.companionId  (when bot-identity-layer lands)
 *   2. character → companion table
 *   3. system default
 *
 * `entity` is the post-bind entity record. Callers MUST NOT pass an entity
 * with a rental_status of 'leased_in' — that case is filtered upstream.
 */
function pickDefaultCompanion(entity) {
    const fromIdentity = entity && entity.identity && entity.identity.public
        && entity.identity.public.companionId;
    if (fromIdentity) return fromIdentity;

    const fromCharacter = entity && entity.character
        ? CHARACTER_COMPANION[entity.character]
        : null;
    if (fromCharacter) return fromCharacter;

    return SYSTEM_DEFAULT_COMPANION;
}

/**
 * Decide whether the hook should run for this entity in this mode.
 * Returns a `{ skip: <reason> }` object when the hook must early-exit, or
 * `null` when the hook should proceed to write vault entries.
 *
 * Skip reasons mirror §0.1 negatives + §0.2a ownership invariants:
 *   - 'rental-leased-in'             (entity is renting another lessor's companion)
 *   - 'user-custom-avatar'           (entity has a non-default avatar)
 *   - 'preserves_existing_source'    (existing PETDX_SOURCE_* is user-selected / rental-inherited)
 *   - 'missing_source_tag_refuse_overwrite' (existing PETDX_CURRENT_* with no PETDX_SOURCE_*)
 *   - 'already_assigned'             (bind/backfill modes only — current already populated)
 *   - 'no_refresh_needed'            (rebind/character-change — avatar isn't default OR character unchanged)
 */
function decideAction({ entity, ctx, existingCompanion, existingSource }) {
    if (entity && entity.rental_status === 'leased_in') {
        return { skip: 'rental-leased-in' };
    }
    if (!isCharacterDefaultAvatar(entity && entity.avatar)) {
        return { skip: 'user-custom-avatar' };
    }
    if (existingCompanion && existingSource &&
        existingSource !== 'phase0-auto' &&
        existingSource !== 'phase0-backfill') {
        return { skip: 'preserves_existing_source', source: existingSource };
    }
    if (existingCompanion && !existingSource) {
        return { skip: 'missing_source_tag_refuse_overwrite' };
    }
    if (ctx.mode === 'bind' || ctx.mode === 'backfill') {
        if (existingCompanion) return { skip: 'already_assigned' };
    }
    if (ctx.mode === 'rebind' || ctx.mode === 'character-change') {
        const wasDefault = isCharacterDefaultAvatar(entity && entity.avatar);
        const prevChar = ctx.previousEntity ? ctx.previousEntity.character : null;
        const charChanged = prevChar !== (entity && entity.character);
        if (!(wasDefault && charChanged)) {
            return { skip: 'no_refresh_needed' };
        }
    }
    return null;
}

/**
 * Source tag for vault + audit log.
 */
function pickNewSource(ctx) {
    return ctx.mode === 'backfill' ? 'phase0-backfill' : 'phase0-auto';
}

/**
 * Core hook. Pure function over IO injected via `io`:
 *
 *   io = {
 *     getDeviceVar(deviceId, key)             → Promise<string|null>
 *     setDeviceVar(deviceId, key, value)      → Promise<void>
 *     appendCompanionSelectLog({...})         → Promise<void>
 *     log(level, tag, message, meta)          → void          (non-fatal logging)
 *   }
 *
 * Returns `{ assigned, avatarUrl, source }` on a successful write, or
 * `{ skipped: <reason>, source? }` on an intentional no-op. Throws only on
 * unexpected IO failure (caller may choose to swallow per spec §0.3:
 * "Errors are non-fatal — bind still succeeds").
 */
async function assignDefaultCompanionIfMissing(deviceId, entity, ctx, io) {
    if (!entity || entity.entityId === undefined || entity.entityId === null) {
        return { skipped: 'no_entity_id' };
    }
    const validModes = ['bind', 'rebind', 'character-change', 'backfill'];
    if (!ctx || !validModes.includes(ctx.mode)) {
        return { skipped: 'invalid_mode' };
    }

    const eid = entity.entityId;
    const currentKey = `PETDX_CURRENT_${eid}`;
    const avatarKey  = `PETDX_AVATAR_${eid}`;
    const sourceKey  = `PETDX_SOURCE_${eid}`;

    let existingCompanion = null;
    let existingSource = null;
    try {
        existingCompanion = await io.getDeviceVar(deviceId, currentKey);
        existingSource    = await io.getDeviceVar(deviceId, sourceKey);
    } catch (err) {
        io.log && io.log('warn', '[petdx-phase0]', 'getDeviceVar failed', {
            deviceId, entityId: eid, error: err && err.message,
        });
        return { skipped: 'vault_read_failed' };
    }

    const decision = decideAction({ entity, ctx, existingCompanion, existingSource });
    if (decision) {
        if (decision.skip === 'missing_source_tag_refuse_overwrite') {
            io.log && io.log('warn', '[petdx-phase0]', 'untrusted-current-without-source', {
                deviceId, entityId: eid,
            });
        }
        return { skipped: decision.skip, source: decision.source };
    }

    const companionId = pickDefaultCompanion(entity);
    const avatarUrl   = avatarUrlFor(companionId);
    const newSource   = pickNewSource(ctx);

    try {
        await io.setDeviceVar(deviceId, currentKey, companionId);
        await io.setDeviceVar(deviceId, avatarKey,  avatarUrl);
        await io.setDeviceVar(deviceId, sourceKey,  newSource);
    } catch (err) {
        io.log && io.log('error', '[petdx-phase0]', 'vault write failed', {
            deviceId, entityId: eid, error: err && err.message,
        });
        return { skipped: 'vault_write_failed' };
    }

    try {
        if (io.appendCompanionSelectLog) {
            await io.appendCompanionSelectLog({
                deviceId,
                entityId: eid,
                companionId,
                source: 'api',         // CHECK-constrained existing column
                origin: newSource,     // new column from 2026-05-30-companion-origin.sql
                ctxMode: ctx.mode,
                ctxSource: ctx.source || null,
            });
        }
    } catch (err) {
        io.log && io.log('warn', '[petdx-phase0]', 'audit log write failed', {
            deviceId, entityId: eid, error: err && err.message,
        });
        // Audit-log failure is non-fatal: vault writes already succeeded.
    }

    return { assigned: companionId, avatarUrl, source: newSource };
}

module.exports = {
    CHARACTER_COMPANION,
    SYSTEM_DEFAULT_COMPANION,
    avatarUrlFor,
    isCharacterDefaultAvatar,
    pickDefaultCompanion,
    decideAction,
    pickNewSource,
    assignDefaultCompanionIfMissing,
};
