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
2. **Character → companion mapping** (canonical table):

   | character | companion id           | rationale |
   |-----------|------------------------|-----------|
   | `LOBSTER` | `petdx-lobster-default` | matches existing procedural Lobster renderer |
   | `PIG`     | `petdx-pig-default`     | matches `_getCharacterDefaultAvatar('PIG')` |
   | `CHICKEN` | `petdx-chicken-default` | parity with backend character enum |
   | `CAT`     | `petdx-cat-default`     | parity with backend character enum |
   | `DOG`     | `petdx-dog-default`     | parity with backend character enum |
   | `BEAR`    | `petdx-bear-default`    | parity with backend character enum |
   | *(unknown)* | `petdx-lobster-default` | matches `_getCharacterDefaultAvatar(null)` fallback |

   *(v0.2 publishes only `petdx-lobster-default`. Pig/Chicken/Cat/Dog/Bear descriptors are scheduled for Phase 0.1 — see §0.7.)*

3. **System default**: `petdx-lobster-default`.

The mapping is **not** keyed off `entityId` — that was the bug class PR #3027 fixed. It is keyed off the live `character` field that the entity actually reports.

---

## §0.3 Backend bind hook

`backend/index.js` `_bindEntity()` (or the closest equivalent at implementation time) gains the following post-bind block:

```js
async function _assignDefaultCompanionIfMissing(deviceId, entity) {
    const currentKey = `PETDX_CURRENT_${entity.entityId}`;
    const avatarKey  = `PETDX_AVATAR_${entity.entityId}`;
    const existing = await getDeviceVar(deviceId, currentKey);
    if (existing) return { skipped: 'already_assigned' };

    const companionId = pickDefaultCompanion(entity);   // §0.2
    const avatarUrl = `/static/companions/${companionId}/avatar.png`;

    await setDeviceVar(deviceId, currentKey, companionId);
    await setDeviceVar(deviceId, avatarKey,  avatarUrl);
    return { assigned: companionId, avatarUrl };
}
```

`pickDefaultCompanion(entity)` follows §0.2's priority order. Errors are non-fatal — bind still succeeds; auto-assign failures emit a `[petdx-phase0]` log line and let the resolver fall through to the §5.4 fallback chain.

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

`updateEntityMaps` gains a third map `_entityPetdxAvatarMap`, populated from a new server-side enrichment in `/api/entities` (returns `petdxCompanionId` + `petdxAvatarUrl` alongside each entity record) or from a separate batched `/api/device-vars?keys=PETDX_AVATAR_*` read. The exact transport is left to the implementation PR; both options are spec-compliant.

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

The `_characterEmoji()` step in `getAvatarForEntity` (PR #3027 line 53–55) becomes unreachable for any entity that completed Phase 0 bind or backfill. The step stays in the resolver chain through one release cycle as a defense-in-depth net for:

- Entities created during the deploy window before backfill completes.
- Race conditions where bind succeeds but vault write fails.
- Future entity types that bypass the bind hook (e.g. ephemeral CI bots).

After two clean release cycles with zero `[petdx-phase0-resolver-fallthrough]` log hits, the `_characterEmoji()` step is removed and the resolver falls straight from petdx layers to `ENTITY_CHARS_DEFAULT` → final fallback.

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

| Version | Date       | Author       | Change                                 |
|---------|------------|--------------|----------------------------------------|
| 0.1     | 2026-05-30 | LOBSTER #2   | Initial draft (post PR #3027 incident) |
