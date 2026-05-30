# Petdx UI/UX Spec — Phase 0 Amendment (2026-05-30)

> **Parent spec**: `petdx-uiux-spec.md` v0.2 (2026-05-10)
> **Status**: draft, pending #1 Mac_F + #6 Codex review
> **Author**: LOBSTER #2
> **Trigger card**: `card_244941011dad263bd87d3e73`
> **Trigger incident**: PR #3027 (kanban avatar resolver) shipped a `character → LOBSTER 🦞 emoji` fallback that contradicts §5 (kanban avatar must sync from companion idle frame). Hank flagged this as a spec-bypass violation; per the spec-first rule, this amendment formalizes the missing Phase 0 layer before the next implementation PR.

---

## Why this amendment

Parent spec §5 assumes every entity has a published `CompanionDescriptor` with a backend-generated `avatar.png` at `/static/companions/<id>/avatar.png` and vault entries `PETDX_CURRENT_<entityId>` + `PETDX_AVATAR_<entityId>`. In production (2026-05-30 snapshot), **no entity on the live device has those vault entries** — Mac_F (#1), Mac_E (#3), Eclaw_Office (#4), Hermes (#5), and Codex (#6) all resolve through emoji-only fallback paths. The §5 sync layer was specified but never reached "first responder bind" status.

Phase 0 closes this gap by **auto-assigning a default companion at entity bind time** so §5 has something real to sync from, and so the frontend never has to fall through to a generic character emoji default.

---

## §0.1 Trigger

Default-companion auto-assignment fires:

1. **At `/api/entity/bind` success** for any newly-bound entity, regardless of binding type (channel / api-key / rental).
2. **At `/api/entity/rebind`** when `character` changes AND the entity has no user-set custom avatar (i.e. `avatar` is `null` or a system-default emoji per `_isCharacterDefaultAvatar()` — see `backend/index.js` `_isCharacterDefaultAvatar`).
3. **At backfill migration** (`scripts/petdx-phase0-backfill.js`) for entities that pre-date this amendment.

Auto-assignment does **NOT** fire when:

- The entity already has a non-null `PETDX_CURRENT_<entityId>` vault entry (idempotency).
- The entity has a user-set custom avatar (URL or non-default emoji) — Phase 0 must not override user choice.
- The entity is in a `rental_status = rented_in` state — rental bots inherit the lessor's companion choice, not a fresh default.

---

## §0.2 Smart-match rule

Companion selection priority (first match wins):

1. **Explicit `identity.public.companionId`** (if/when bot-identity-layer.md §Step 2 lands the field) — bot author can pin a preferred companion.
2. **Character → companion mapping** — Phase 0 ships with **only `petdx-lobster-default` as the published descriptor**. The non-Lobster character keys in the table below resolve to the lobster default until their descriptors land in Phase 0.1 (§0.7). This avoids §0.4 resolver pointing at a non-existent `/static/companions/<id>/avatar.png` for entities whose character isn't LOBSTER:

   | character | Phase 0 companion id     | Phase 0.1 target          | rationale |
   |-----------|--------------------------|---------------------------|-----------|
   | `LOBSTER` | `petdx-lobster-default`  | (no change)               | matches existing procedural Lobster renderer |
   | `PIG`     | `petdx-lobster-default`  | `petdx-pig-default`       | descriptor pending Phase 0.1 |
   | `CHICKEN` | `petdx-lobster-default`  | `petdx-chicken-default`   | descriptor pending Phase 0.1 |
   | `CAT`     | `petdx-lobster-default`  | `petdx-cat-default`       | descriptor pending Phase 0.1 |
   | `DOG`     | `petdx-lobster-default`  | `petdx-dog-default`       | descriptor pending Phase 0.1 |
   | `BEAR`    | `petdx-lobster-default`  | `petdx-bear-default`      | descriptor pending Phase 0.1 |
   | *(unknown)* | `petdx-lobster-default` | (no change)               | matches `_getCharacterDefaultAvatar(null)` fallback |

   When Phase 0.1 ships any non-Lobster descriptor, this table updates and a follow-up backfill re-runs §0.5 for entities whose `PETDX_SOURCE_<entityId>` is `phase0-auto` (so user-selected companions stay untouched — see §0.2a).

3. **System default**: `petdx-lobster-default`.

The mapping is **not** keyed off `entityId` — that was the bug class PR #3027 fixed. It is keyed off the live `character` field that the entity actually reports.

### §0.2a Ownership / source tagging

Every Phase 0 write tags its origin so future code (rebind, Phase 0.1 re-backfill, manual companion change) can tell a system-default from a user choice:

- `PETDX_SOURCE_<entityId>` vault key, value ∈ `{ phase0-auto, phase0-backfill, user-selected, rental-inherited }`.
- Phase 0 only overwrites `PETDX_CURRENT_<entityId>` / `PETDX_AVATAR_<entityId>` when the existing `PETDX_SOURCE_<entityId>` is **absent** or in the set `{ phase0-auto, phase0-backfill }`. Any `user-selected` or `rental-inherited` tag is preserved untouched.
- The companion-select endpoint (§7 of parent spec) writes `PETDX_SOURCE_<entityId> = user-selected` so user choice is durable through subsequent rebinds.
- Equivalent audit row written to `companion_select_log` table with `source` column, so the vault tag has a queryable mirror.

---

## §0.3 Backend bind hook

The hook signature must accept entry-point context because the live backend has multiple bind paths (`/api/bind`, `/api/entity/rebind`, official-borrow `/api/official-borrow/bind-free`, and `/api/transform` character-change side-effect). A flat "exists → no-op" rule would mis-handle rebinds. The hook is therefore parameterised:

```js
/**
 * @param deviceId      string
 * @param entity        current entity record (post-bind)
 * @param ctx           {
 *                        mode: 'bind' | 'rebind' | 'character-change' | 'backfill',
 *                        previousEntity: <prior record or null>,
 *                        source: 'bind-endpoint' | 'official-borrow' | 'transform' | 'backfill-script'
 *                      }
 */
async function _assignDefaultCompanionIfMissing(deviceId, entity, ctx) {
    const currentKey = `PETDX_CURRENT_${entity.entityId}`;
    const avatarKey  = `PETDX_AVATAR_${entity.entityId}`;
    const sourceKey  = `PETDX_SOURCE_${entity.entityId}`;

    const existingCompanion = await getDeviceVar(deviceId, currentKey);
    const existingSource    = await getDeviceVar(deviceId, sourceKey);

    // Preserve any user choice or inherited rental companion. §0.2a tags.
    if (existingCompanion && existingSource &&
        existingSource !== 'phase0-auto' &&
        existingSource !== 'phase0-backfill') {
        return { skipped: 'preserves_existing_source', source: existingSource };
    }

    // For bind / backfill: skip if already populated by us.
    if (ctx.mode === 'bind' || ctx.mode === 'backfill') {
        if (existingCompanion) return { skipped: 'already_assigned' };
    }

    // For rebind / character-change: only refresh if the avatar slot is still a
    // character default (per `_isCharacterDefaultAvatar(entity.avatar)`) AND the
    // character actually changed compared to ctx.previousEntity.
    if (ctx.mode === 'rebind' || ctx.mode === 'character-change') {
        const wasDefault = _isCharacterDefaultAvatar(entity.avatar);
        const charChanged = ctx.previousEntity?.character !== entity.character;
        if (!(wasDefault && charChanged)) {
            return { skipped: 'no_refresh_needed' };
        }
    }

    const companionId = pickDefaultCompanion(entity);   // §0.2
    const avatarUrl = `/static/companions/${companionId}/avatar.png`;
    const newSource = ctx.mode === 'backfill' ? 'phase0-backfill' : 'phase0-auto';

    await setDeviceVar(deviceId, currentKey, companionId);
    await setDeviceVar(deviceId, avatarKey,  avatarUrl);
    await setDeviceVar(deviceId, sourceKey,  newSource);
    await appendCompanionSelectLog({
        deviceId, entityId: entity.entityId,
        companionId, source: newSource,
        mode: ctx.mode, ctxSource: ctx.source,
    });
    return { assigned: companionId, avatarUrl, source: newSource };
}
```

`pickDefaultCompanion(entity)` follows §0.2's priority order. Errors are non-fatal — bind still succeeds; auto-assign failures emit a `[petdx-phase0]` log line with `ctx.mode` + `ctx.source` and let the resolver fall through to the §5.4 fallback chain.

The four bind paths each call `_assignDefaultCompanionIfMissing` with appropriate `ctx`:

| Entry point                              | `ctx.mode`         | `ctx.source`        |
|------------------------------------------|--------------------|---------------------|
| `/api/bind`                              | `'bind'`           | `'bind-endpoint'`   |
| `/api/entity/rebind`                     | `'rebind'`         | `'bind-endpoint'`   |
| `/api/official-borrow/bind-free`         | `'bind'`           | `'official-borrow'` |
| `/api/transform` (character-change side) | `'character-change'`| `'transform'`       |
| `scripts/petdx-phase0-backfill.js`       | `'backfill'`       | `'backfill-script'` |

---

## §0.4 Frontend resolver priority

`backend/public/portal/shared/entity-utils.js` `getAvatarForEntity(entityId)` updates its precedence chain to put petdx layers first:

```
1. _entityAvatarMap[entityId]                          // explicit avatar from /api/entities
2. localStorage[`eclaw_avatar_${entityId}`]            // user-set custom emoji
3. _entityPetdxAvatarMap[entityId]                     // NEW: from PETDX_AVATAR_<id> vault read
4. AvatarPetdx.descriptorAvatarUrl(entityId)           // NEW: cached CompanionDescriptor.avatar.url
5. _characterEmoji(entityId)                           // PR #3027 stopgap (kept until §0.6)
6. ENTITY_CHARS_DEFAULT[entityId]                      // legacy emoji fallback
7. final emoji fallback                                // DEFAULT_CHARACTER_EMOJI
```

`updateEntityMaps` gains a third map `_entityPetdxAvatarMap`. The canonical transport is **server-side enrichment in `/api/entities`**: the endpoint joins/decrypts vault entries once and returns `petdxCompanionId` + `petdxAvatarUrl` alongside each entity record. This is preferred over a batched `/api/device-vars?keys=PETDX_AVATAR_*` read because (a) pages already fetch entities, (b) the existing `/api/device-vars` lacks a `keys=` projection and adding one would broaden the read surface, and (c) it keeps vault read paths off the UI layer entirely.

`AvatarPetdx.preload({...entityIds})` is called from every page that lists entities — this amendment does not change that contract; it only adds the `descriptorAvatarUrl(entityId)` helper that returns the descriptor's `avatar.png` URL when the descriptor is cached.

---

## §0.5 Backfill migration

`scripts/petdx-phase0-backfill.js`:

```
for each device in production
    for each entity where PETDX_CURRENT_<entityId> is null
        if entity has user-set custom avatar (per §0.1 negative case)
            skip
        else
            companionId = pickDefaultCompanion(entity)
            write PETDX_CURRENT_<entityId> + PETDX_AVATAR_<entityId>
            log [petdx-phase0-backfill] <deviceId> <entityId> <companionId>
```

Runs once per device, idempotent. Hooked into `backend/scripts/run-migrations.js` so the next deploy executes it for the live device automatically.

---

## §0.6 PR #3027 deprecation

The `_characterEmoji()` step in `getAvatarForEntity` (PR #3027 line 53–55) becomes unreachable for any entity that completed Phase 0 bind or backfill. The step stays in the resolver chain through a tighter quarantine window before removal:

- The window starts when `scripts/petdx-phase0-backfill.js` reports `success` on the live production device.
- The step is removed only after **all three** conditions hold:
  1. At least **two clean release cycles** have passed since the success report.
  2. At least **7 days** have passed (so a slow week of releases doesn't truncate the window).
  3. **Zero** `[petdx-phase0-resolver-fallthrough]` log hits across all production devices during the window.

If any of the three fails (early release cadence, short calendar gap, or a single fallthrough log), the window resets. This protects against:

- Entities created during the deploy window before backfill completes.
- Race conditions where bind succeeds but vault write fails.
- Future entity types that bypass the bind hook (e.g. ephemeral CI bots).

---

## §0.7 Out of scope for this amendment

These are deliberately deferred to follow-up specs/PRs:

- Pig / Chicken / Cat / Dog / Bear `CompanionDescriptor` authoring (Phase 0.1 — needs creator workflow per §7).
- `identity.public.companionId` field addition to the identity layer (waits on bot-identity-layer.md merge).
- Avatar transition animation when companion changes (Phase 1 — parent spec §6 covers state animation but not avatar morph).
- E-coin payout on Phase 0 auto-assigned companions (Phase 4 wallet spec).

---

## §0.8 Acceptance for the implementation PR

1. `_assignDefaultCompanionIfMissing` lands in `backend/index.js` with jest coverage:
   - bind a fresh entity → `PETDX_CURRENT_*` + `PETDX_AVATAR_*` exist
   - re-bind with new character → vault keys update only when avatar is default
   - re-bind with custom avatar → vault keys preserved
   - idempotency: second bind is a no-op
2. `scripts/petdx-phase0-backfill.js` exists and runs cleanly against the live device record (verified via `--dry-run`).
3. `entity-utils.js` resolver order matches §0.4, with vm/behavior tests added to `backend/tests/jest/portal-entity-avatar-resolver.test.js` covering the new petdx-first path.
4. Kanban E2E: open `/portal/kanban.html` after deploy, verify #1 Mac_F and #5 Hermes render `petdx-lobster-default` `avatar.png` (or its canvas mount), not 🦞 emoji.
5. PR body cites this amendment file by path.

---

## Modification log

| Version | Date       | Author       | Change                                                                                                                                |
|---------|------------|--------------|---------------------------------------------------------------------------------------------------------------------------------------|
| 0.1     | 2026-05-30 | LOBSTER #2   | Initial draft (post PR #3027 incident)                                                                                                |
| 0.2     | 2026-05-30 | LOBSTER #2   | Per #6 review: §0.2 lobster-only Phase 0 + §0.2a source tagging, §0.3 hook context + 4 entry points, §0.4 enrichment chosen, §0.6 quarantine = 2 cycles + 7 days + 0 fallthrough |
