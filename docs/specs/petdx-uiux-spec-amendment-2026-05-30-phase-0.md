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

1. **At `/api/bind` (first-time)** success for any newly-bound entity, regardless of binding type (channel / api-key / rental).
2. **At `/api/bind` (rebind)** when `character` changes AND the entity has no user-set custom avatar (i.e. `avatar` is `null` or a system-default emoji per `_isCharacterDefaultAvatar()` — see `backend/index.js`). Rebind is detected by the existing `rebindCount` bump path on `/api/bind`; there is **no** separate `/api/entity/rebind` endpoint.
3. **At `/api/official-borrow/bind-free` and `/api/official-borrow/bind-personal`** success, treated as `mode: 'bind'`.
4. **At `/api/transform` character-change side-effect** when the request body sets `character` and changes it.
5. **At backfill migration** (`scripts/petdx-phase0-backfill.js`) for entities that pre-date this amendment.

Auto-assignment does **NOT** fire when:

- **(bind / backfill modes only — idempotency)** The entity already has a non-null `PETDX_CURRENT_<entityId>` vault entry. The rebind and character-change modes deliberately ignore this guard so they can refresh a stale `phase0-auto` / `phase0-backfill` companion when the character key changes (per §0.3's per-mode logic and §0.2a's source-tag check).
- The entity has a user-set custom avatar (URL or non-default emoji) — Phase 0 must not override user choice.
- The entity is in a `rental_status = 'leased_in'` state — rental bots inherit the lessor's companion choice, not a fresh default. (Status enum values from `backend/index.js`: `'leased_in'` / `'leased_out'` / `null`; spec v0.1–v0.2 used the wrong `rented_in` name.)

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

- `PETDX_SOURCE_<entityId>` vault key, value ∈ `{ phase0-auto, phase0-backfill, user-selected, rental-inherited }`. This is the **canonical** ownership signal — the resolver and rebind hook both read it.
- Phase 0 only overwrites `PETDX_CURRENT_<entityId>` / `PETDX_AVATAR_<entityId>` when the existing `PETDX_SOURCE_<entityId>` is **absent** or in the set `{ phase0-auto, phase0-backfill }`. Any `user-selected` or `rental-inherited` tag is preserved untouched. The same rule applies symmetrically: if `PETDX_CURRENT_<entityId>` exists but `PETDX_SOURCE_<entityId>` is missing, Phase 0 treats the missing tag as **untrusted** and refuses to overwrite — it waits for `scripts/petdx-phase0-backfill.js` to stamp a source first.
- The companion-select endpoint (§7 of parent spec) writes `PETDX_SOURCE_<entityId> = user-selected` so user choice is durable through subsequent rebinds.
- **Audit log**: writes go into a **new** `companion_select_log.origin` column (Phase 0 migration `2026-05-30-companion-origin.sql`). The existing `source` column keeps its CHECK constraint (`'portal' | 'app' | 'api'`) untouched — Phase 0 writes `source = 'api'` and uses the new `origin` column for the `phase0-auto | phase0-backfill | user-selected | rental-inherited` tag. This avoids invalidating the existing constraint or breaking older callers that read `source`. Index `idx_companion_select_origin (device_id, entity_id, origin)` is added by the same migration.

---

## §0.3 Backend bind hook

The hook signature must accept entry-point context because the live backend has multiple bind paths. Per `backend/index.js` (verified 2026-05-30):

- `/api/bind` — primary bind, also handles rebind via `rebindCount` bump.
- `/api/official-borrow/bind-free` — free-tier official borrow.
- `/api/official-borrow/bind-personal` — paid-tier official borrow (per `paid_borrow_slots`).
- `/api/transform` — character-change side effect (when the request body sets `character`).

There is **no** `/api/entity/rebind` endpoint; spec v0.1–v0.2 named a fictional one. A flat "exists → no-op" rule would mis-handle rebinds done via `/api/bind`. The hook is therefore parameterised:

```js
/**
 * @param deviceId      string
 * @param entity        current entity record (post-bind)
 * @param ctx           {
 *                        mode: 'bind' | 'rebind' | 'character-change' | 'backfill',
 *                        previousEntity: <prior record or null>,
 *                        source: 'bind-endpoint' | 'official-borrow-free' | 'official-borrow-paid' | 'transform' | 'backfill-script'
 *                      }
 */
async function _assignDefaultCompanionIfMissing(deviceId, entity, ctx) {
    const currentKey = `PETDX_CURRENT_${entity.entityId}`;
    const avatarKey  = `PETDX_AVATAR_${entity.entityId}`;
    const sourceKey  = `PETDX_SOURCE_${entity.entityId}`;

    const existingCompanion = await getDeviceVar(deviceId, currentKey);
    const existingSource    = await getDeviceVar(deviceId, sourceKey);

    // §0.2a invariant: any non-phase0 source is preserved untouched.
    if (existingCompanion && existingSource &&
        existingSource !== 'phase0-auto' &&
        existingSource !== 'phase0-backfill') {
        return { skipped: 'preserves_existing_source', source: existingSource };
    }

    // §0.2a invariant: existing companion + missing source = untrusted state.
    // Refuse to overwrite until the backfill script stamps a source value.
    if (existingCompanion && !existingSource) {
        log('[petdx-phase0] untrusted-current-without-source', { deviceId, entityId: entity.entityId });
        return { skipped: 'missing_source_tag_refuse_overwrite' };
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
        companionId,
        source: 'api',              // existing CHECK constraint column — Phase 0 writes 'api'
        origin: newSource,          // new column from migration 2026-05-30-companion-origin.sql
        ctxMode: ctx.mode,
        ctxSource: ctx.source,
    });
    return { assigned: companionId, avatarUrl, source: newSource };
}
```

`pickDefaultCompanion(entity)` follows §0.2's priority order. Errors are non-fatal — bind still succeeds; auto-assign failures emit a `[petdx-phase0]` log line with `ctx.mode` + `ctx.source` and let the resolver fall through to the §5.4 fallback chain.

Each entry point calls `_assignDefaultCompanionIfMissing` with appropriate `ctx`. `/api/bind` (per `backend/index.js:7000`) accepts only `code` and `name` and does **not** itself bump `rebindCount`; rebind in the live system happens as a `DELETE /api/entity` → `POST /api/bind` cycle, with the bump performed by `DELETE` handlers (e.g. `backend/index.js:9111`, `9233`). For Phase 0 the hook therefore distinguishes bind vs rebind via **`ctx.previousEntity`**: implementation MUST pass the entity record as it existed before the bind cleared its fields (`null` for a slot that had never been bound, non-null for a rebind regardless of how `rebindCount` was bumped).

| Entry point                              | `ctx.mode`            | `ctx.source`             | rebind detection                                    |
|------------------------------------------|-----------------------|--------------------------|-----------------------------------------------------|
| `/api/bind` (first-time)                 | `'bind'`              | `'bind-endpoint'`        | `ctx.previousEntity` is `null`                       |
| `/api/bind` (rebind after unbind)        | `'rebind'`            | `'bind-endpoint'`        | `ctx.previousEntity` is non-null with same `entityId`|
| `/api/official-borrow/bind-free`         | `'bind'`              | `'official-borrow-free'` | n/a — always treated as bind                        |
| `/api/official-borrow/bind-personal`     | `'bind'`              | `'official-borrow-paid'` | n/a — always treated as bind                        |
| `/api/transform` (character-change side) | `'character-change'`  | `'transform'`            | n/a — uses `ctx.previousEntity.character` comparison |
| `scripts/petdx-phase0-backfill.js`       | `'backfill'`          | `'backfill-script'`      | n/a — see §0.5                                       |

---

## §0.4 Frontend resolver priority

`backend/public/portal/shared/entity-utils.js` `getAvatarForEntity(entityId)` updates its precedence chain to put petdx layers first:

```
1. _entityAvatarMap[entityId]                          // explicit non-default avatar only (see invariant below)
2. localStorage[`eclaw_avatar_${entityId}`]            // user-set custom emoji
3. _entityPetdxAvatarMap[entityId]                     // NEW: from /api/entities petdxAvatarUrl enrichment
4. AvatarPetdx.descriptorAvatarUrl(entityId)           // NEW: cached CompanionDescriptor.avatar.url
5. _characterEmoji(entityId)                           // PR #3027 stopgap (kept until §0.6)
6. ENTITY_CHARS_DEFAULT[entityId]                      // legacy emoji fallback
7. final emoji fallback                                // DEFAULT_CHARACTER_EMOJI
```

**`_entityAvatarMap` invariant.** Today `updateEntityMaps` populates `_entityAvatarMap[id]` from `e.avatar` for any truthy value, which means a stale `_getCharacterDefaultAvatar()` emoji on the entity record will beat the petdx layers and re-introduce the 🐷/🦞 bug class. Phase 0 changes the contract: `updateEntityMaps` writes to `_entityAvatarMap[id]` **only when `e.avatar` is non-null AND `!_isCharacterDefaultAvatar(e.avatar)`** (i.e. URL avatar or user-set non-default emoji). The mirror helper `_isCharacterDefaultAvatar(avatar)` MUST be ported to `entity-utils.js` as a small re-implementation of the backend helper. Default-emoji avatars are intentionally dropped from the map so they cannot win over a petdx idle frame.

`updateEntityMaps` gains a third map `_entityPetdxAvatarMap`. The canonical transport is **server-side enrichment in `/api/entities`**: the endpoint joins/decrypts vault entries once and returns `petdxCompanionId` + `petdxAvatarUrl` alongside each entity record. This is preferred over a batched `/api/device-vars?keys=PETDX_AVATAR_*` read because (a) pages already fetch entities, (b) the existing `/api/device-vars` lacks a `keys=` projection and adding one would broaden the read surface, and (c) it keeps vault read paths off the UI layer entirely.

`AvatarPetdx.preload({...entityIds})` is called from every page that lists entities — this amendment does not change that contract; it only adds the `descriptorAvatarUrl(entityId)` helper that returns the descriptor's `avatar.png` URL when the descriptor is cached.

---

## §0.5 Backfill migration

`scripts/petdx-phase0-backfill.js` is the only path that may safely stamp `PETDX_SOURCE_<entityId>` for entities that pre-date this amendment (per §0.2a, the bind hook refuses to overwrite an existing `PETDX_CURRENT_*` whose `PETDX_SOURCE_*` is missing — the script is what closes that loophole).

```
for each device in production
    for each entity in device.entities
        current  = readDeviceVar(deviceId, `PETDX_CURRENT_${entityId}`)
        source   = readDeviceVar(deviceId, `PETDX_SOURCE_${entityId}`)
        rentalIn = entity.rental_status === 'leased_in'
        custom   = !_isCharacterDefaultAvatar(entity.avatar)

        if (rentalIn) { skip 'rental-leased-in'; continue }
        if (custom)   { skip 'user-custom-avatar'; continue }

        // Existing companion + non-phase0 source → preserve.
        if (current && source && source !== 'phase0-auto' && source !== 'phase0-backfill') {
            skip 'preserves_existing_source', source; continue
        }

        // Existing companion + missing source → stamp the source as phase0-backfill,
        // do not change companionId or avatar URL. This is what unblocks future
        // bind-hook refreshes (per §0.2a invariant).
        if (current && !source) {
            writeDeviceVar(deviceId, `PETDX_SOURCE_${entityId}`, 'phase0-backfill')
            appendCompanionSelectLog({
                deviceId, entityId,
                companionId: current,
                source: 'api',             // CHECK-constrained column
                origin: 'phase0-backfill', // new column
                ctxMode: 'backfill',
                ctxSource: 'backfill-script'
            })
            log [petdx-phase0-backfill] stamped-existing <deviceId> <entityId> <current>
            continue
        }

        // Fresh entity → full assign.
        companionId = pickDefaultCompanion(entity)
        avatarUrl   = `/static/companions/${companionId}/avatar.png`
        writeDeviceVar(deviceId, `PETDX_CURRENT_${entityId}`, companionId)
        writeDeviceVar(deviceId, `PETDX_AVATAR_${entityId}`,  avatarUrl)
        writeDeviceVar(deviceId, `PETDX_SOURCE_${entityId}`,  'phase0-backfill')
        appendCompanionSelectLog({
            deviceId, entityId,
            companionId,
            source: 'api',
            origin: 'phase0-backfill',
            ctxMode: 'backfill',
            ctxSource: 'backfill-script'
        })
        log [petdx-phase0-backfill] assigned <deviceId> <entityId> <companionId>
```

Runs once per device, idempotent. Driver supports `--dry-run` (only prints intended actions) and `--commit` (executes). Hooked into `backend/scripts/run-migrations.js` so the next deploy executes the `--commit` form for the live device automatically after the `2026-05-30-companion-origin.sql` migration completes (the migration MUST land first because the audit-log writes use the new `origin` column).

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

1. **Lobster avatar asset shipped + served.** The impl PR creates `backend/public/companions/petdx-lobster-default/avatar.png` (256×256, generated from the procedural Lobster renderer's IDLE frame 0) **and** adds an `app.use('/static/companions', express.static(path.join(__dirname, 'public/companions'), {...}))` mount in `backend/index.js`. The acceptance test fetches `https://eclawbot.com/static/companions/petdx-lobster-default/avatar.png` and asserts HTTP 200 + `Content-Type: image/png`. The bind hook MUST NOT write `PETDX_AVATAR_<entityId>` until this URL is verified live.
2. **DB migration shipped.** `2026-05-30-companion-origin.sql` (a) adds nullable `origin TEXT` column to `companion_select_log`, (b) creates `idx_companion_select_origin (device_id, entity_id, origin)`, (c) leaves the existing `source CHECK (source IN ('portal','app','api'))` untouched. Run via `backend/scripts/run-migrations.js` on next deploy.
3. **`_assignDefaultCompanionIfMissing`** lands in `backend/index.js` with jest coverage:
   - first-time bind → `PETDX_CURRENT_*` + `PETDX_AVATAR_*` + `PETDX_SOURCE_*` written
   - rebind with new character + default avatar → vault keys updated, `source = phase0-auto`
   - rebind with custom avatar → vault keys preserved
   - existing `PETDX_CURRENT_*` with missing `PETDX_SOURCE_*` → refuses overwrite (§0.2a invariant)
   - existing `PETDX_SOURCE_* = user-selected` → preserves untouched
   - idempotency: second bind is a no-op
4. **`scripts/petdx-phase0-backfill.js`** exists and runs cleanly against the live device record (verified via `--dry-run` first, then live with `--commit`). Reports per-entity outcome: `assigned | skipped | preserves_existing_source`.
5. **`entity-utils.js`** resolver order matches §0.4, with vm/behavior tests added to `backend/tests/jest/portal-entity-avatar-resolver.test.js` covering the new petdx-first path.
6. **Kanban E2E**: open `/portal/kanban.html` after deploy, verify #1 Mac_F and #5 Hermes render `petdx-lobster-default` `avatar.png` (or its canvas mount), not 🦞 emoji. Capture before/after screenshots and attach to the impl card.
7. **PR body cites this amendment file by path.**

---

## Modification log

| Version | Date       | Author       | Change                                                                                                                                |
|---------|------------|--------------|---------------------------------------------------------------------------------------------------------------------------------------|
| 0.1     | 2026-05-30 | LOBSTER #2   | Initial draft (post PR #3027 incident)                                                                                                |
| 0.2     | 2026-05-30 | LOBSTER #2   | Per #6 review: §0.2 lobster-only Phase 0 + §0.2a source tagging, §0.3 hook context + 4 entry points, §0.4 enrichment chosen, §0.6 quarantine = 2 cycles + 7 days + 0 fallthrough |
| 0.3     | 2026-05-30 | LOBSTER #2   | Per #6 re-review: §0.1 rental status fixed (leased_in, not rented_in); §0.2a uses new `origin` column on `companion_select_log` to avoid breaking the existing `source` CHECK; §0.3 entry-point table corrected (no `/api/entity/rebind`, adds `/api/official-borrow/bind-personal`, disambiguates `/api/bind` bind vs rebind); §0.3 guard tightened — existing `PETDX_CURRENT_*` with missing `PETDX_SOURCE_*` refuses overwrite; §0.8 adds explicit acceptance for lobster avatar.png asset + `/static/companions` mount + DB migration ordering |
| 0.4     | 2026-05-30 | LOBSTER #2   | Per #6 third review: §0.1 trigger list now matches §0.3 entry-point table (5 numbered triggers, no `/api/entity/{bind,rebind}`); §0.3 `ctx.source` JSDoc enum aligned with the table (`'official-borrow-free'` / `'official-borrow-paid'`); §0.5 backfill pseudocode now writes `PETDX_SOURCE_*` + `origin` audit, handles `rental-leased-in` / `user-custom-avatar` / non-phase0 source / missing source / fresh assign separately, requires migration before `--commit` |
| 0.5     | 2026-05-30 | LOBSTER #2   | Per #6 fourth review: §0.1 idempotency rule scoped to bind/backfill modes only (rebind/character-change deliberately bypass the `PETDX_CURRENT_*` exists guard); §0.3 entry-point table corrected — `/api/bind` does not bump `rebindCount` itself (per backend/index.js:7000 it only accepts `code`/`name`); rebind happens via `DELETE /api/entity` → `POST /api/bind` cycle, so the hook distinguishes bind vs rebind via `ctx.previousEntity` rather than `rebindCount`; §0.4 adds the `_entityAvatarMap` invariant — only non-default avatars enter the map (`!_isCharacterDefaultAvatar(e.avatar)`) so default emojis can never beat petdx layers |
