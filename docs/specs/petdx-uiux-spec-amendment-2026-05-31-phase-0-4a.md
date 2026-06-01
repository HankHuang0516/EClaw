# petdx UIUX Spec Amendment 2026-05-31 — Phase 0 §0.4a

**Status**: draft, supersedes the §0.4 chain order in the
2026-05-30 amendment for any reader from this date forward.
The companion implementation card is `card_42673c44`; this doc has to land
first.

**Why now.** The morning after the Phase 0 implementation merged, Hank
opened the dashboard and saw the system entities (Mac_F, Eclaw_Office,
Hermes, Codex) still wearing the Phase-0 default lobster avatar — even
though all four had been switched to live R2 spritesheet companions
through the marketplace. The frontend chain reordering in PR #3046
unblocked the user-visible bug; this amendment closes the underlying
backend-side invariant gap so the chain reorder can't drift back.

The exact failure: `/api/companion/select` was inserting into
`companion_select_log` and updating `companion_current` but never writing
back to the vault keys (`PETDX_CURRENT_<id>`, `PETDX_AVATAR_<id>`,
`PETDX_SOURCE_<id>`). The vault stayed pinned at whatever Phase 0
backfilled. Three rows of state existed and they immediately disagreed.

The architectural commitment this amendment makes:

> **The companion_current table + cached descriptor IS the source of
> truth. The vault is a fast-paint mirror, never the other way around.**
> Any vault read that surfaces a value the descriptor disagrees with
> must lose. Any write path that touches one row of state without
> touching all three is a bug.

---

## §0.4 Frontend resolver priority — chain reorder

The chain published in the 2026-05-30 amendment placed
`_entityPetdxAvatarMap` (vault enrichment via `/api/entities`) above
`AvatarPetdx.descriptorAvatarUrl` (live cached descriptor). That order
is hereby reversed:

```
1. _entityAvatarMap[entityId]                          // explicit non-default avatar (URL or user-set emoji)
2. localStorage[`eclaw_avatar_${entityId}`]            // user-set custom emoji
3. AvatarPetdx.descriptorAvatarUrl(entityId)           // CHANGED: live cached descriptor URL — source of truth
4. _entityPetdxAvatarMap[entityId]                     // CHANGED: vault PETDX_AVATAR — fast-paint mirror / boot fallback
5. _characterEmoji(entityId)                           // PR #3027 stopgap (kept until §0.6)
6. ENTITY_CHARS_DEFAULT[entityId]                      // legacy emoji fallback
7. final emoji fallback                                // DEFAULT_CHARACTER_EMOJI
```

Step 4 stays in the chain because at first paint `AvatarPetdx.preload()`
has not resolved yet, and the vault enrichment was already in the
`/api/entities` response that the page used to render the entity card.
Without step 4 the first paint flickers to a character emoji and then
swaps to the descriptor URL once preload returns. Step 4 is exactly a
"fast-paint mirror" of whatever the descriptor will eventually report —
and the §0.4a invariant below is what keeps it from going stale.

Implementation: shipped in PR #3046 (commit on `main` 2026-05-31 ~09:13
TW). This amendment is the spec-side companion to that fix.

---

## §0.4a Vault is a mirror, not a writeback target

### Invariant (single sentence)

> Every write that mutates a user's current companion selection MUST
> update `companion_current`, `companion_select_log`, and the three
> `PETDX_*_<entityId>` vault keys atomically. No endpoint may return
> `success: true` on partial completion.

### What "atomic" means here

A single database transaction wraps:

1. The `companion_select_log` insert (with `source = 'api'` for the
   existing CHECK constraint AND `origin` for the new audit dimension).
2. The `companion_current` upsert (companion id, selected-at timestamp,
   selector entityId).
3. The vault write of all three keys via the existing
   `createPetdxPhase0Io().setDeviceVars({...})` batch.

If any of the three fails, the transaction rolls back and the route
returns 5xx with an error body that names which layer failed. Callers
retry. We do not paper over partial state.

The vault write needs the descriptor's `avatar.url` (or the procedural
`/static/companions/<id>/avatar.png` for Phase 0 procedural companions).
Resolve that *before* the transaction opens so the transaction body
contains only writes.

### The three vault keys, restated

For every write to `companion_current`, the corresponding vault entries
MUST be set to:

| key                              | value                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `PETDX_CURRENT_<entityId>`       | The companion id selected (e.g. `petdx-lobster-default`, `zoro-9889c11ded54`, …).                  |
| `PETDX_AVATAR_<entityId>`        | The avatar URL the renderer will paint as the fast-paint fallback.                                 |
| `PETDX_SOURCE_<entityId>`        | The provenance tag. See the table below for the canonical set.                                     |

`PETDX_SOURCE_<entityId>` values:

| Source tag           | Set by                                                                          |
| -------------------- | -------------------------------------------------------------------------------- |
| `phase0-auto`        | The bind hook on `/api/bind` (first-time + rebind), `/api/official-borrow/*`, `/api/transform` character-change. |
| `phase0-backfill`    | `scripts/petdx-phase0-backfill.js` or `POST /api/admin/petdx-phase0/backfill` (the admin endpoint added in PR #3033). |
| `user-selected`      | `POST /api/companion/select` (this is the value that was missing before).        |
| `rental-inherited`   | Reserved for the future rental-inherit flow.                                     |

### `companion_select_log.origin`

The migration shipped with PR #3032 added the `origin` column but the
`/api/companion/select` insert never started writing to it — the route
only filled the existing `source` column (which is CHECK-constrained to
`portal | app | api`). The select route is the originator of
`user-selected` events; the missing `origin` write is what made the log
table un-useful for diffing "who chose this" from "what wrote this row."

This amendment makes the `origin` write mandatory for `select` and
keeps the existing semantic split: `source` describes the transport
(`api`), `origin` describes the trigger (`user-selected`).

The bind hook already writes `origin` correctly via
`createPetdxPhase0Io().appendCompanionSelectLog({...})` (with values
`phase0-auto` or `phase0-backfill`). The select route is the last
remaining write path that touches the table without filling `origin`.

### The contract `/api/companion/select` MUST satisfy (post-amendment)

```
Input:  { companionId, source: 'portal'|'app'|'api' }, authenticated as
        either device-owner or entity-bot.

Effects (single transaction):
    INSERT INTO companion_select_log (..., source, origin)
        VALUES (..., 'api', 'user-selected')
    UPSERT companion_current SET companion_id = companionId
    setDeviceVars(deviceId, {
        PETDX_CURRENT_<entityId>: companionId,
        PETDX_AVATAR_<entityId>:  resolvedAvatarUrl,
        PETDX_SOURCE_<entityId>:  'user-selected',
    })

On any failure: ROLLBACK, return 5xx with { layer: 'log'|'current'|'vault', error }.
```

The Phase 0 hook's existing IO factory (`createPetdxPhase0Io()` in
`backend/index.js`) already handles encrypt/decrypt + audit-log writes
through a shared pool — the select route can reuse that factory so the
write semantics stay consistent with the bind hook.

---

## §0.4a Test obligations

Before the impl PR can merge, the following jest cases (or their
equivalents) must exist:

1. **Happy path** — `POST /api/companion/select` writes all three
   vault keys + the select log row with `origin = 'user-selected'` +
   the companion_current row. One transaction, all three rows present.
2. **Vault failure rolls everything back** — Mock the vault write to
   throw. Assert `companion_select_log` and `companion_current` see no
   new row. Assert the response is 5xx with `layer: 'vault'`.
3. **Log failure rolls everything back** — Mock the log insert to
   throw. Assert vault keys are unchanged and `companion_current` has
   no new row.
4. **Current-table failure rolls everything back** — Symmetric case.
5. **`/api/entities` enrichment reflects the new selection** — After
   a successful select, the enrichment for that entity returns the new
   `petdxAvatarUrl` + `petdxCompanionId` (no separate refresh required).

Frontend regression coverage:

6. **Resolver picks descriptor URL over a stale vault enrichment** —
   already added to
   `tests/jest/portal-entity-avatar-resolver.test.js` in PR #3046; the
   amendment locks the test as a §0.4a obligation so a future refactor
   that re-swaps the chain order has to also delete the test, which
   makes the intent obvious in review.

---

## §0.4a Migration / rollout notes

No DB migration is needed — the `companion_select_log.origin` column
exists from the 2026-05-30-companion-origin migration (PR #3032).

No data backfill is needed for the vault — Phase 0's `backfill` script
already populated the three vault keys with `phase0-backfill` /
`phase0-auto` origins. Any vault entry whose `PETDX_SOURCE_*` is one of
those Phase 0 tags is by definition NOT a user selection, so the
amendment is forward-only: vault entries with those source tags can be
overwritten by a subsequent `/api/companion/select` with
`user-selected`.

Existing rows in `companion_select_log` with `NULL` origin can be left
as-is. They represent pre-amendment writes; the chain doesn't read from
`origin` for rendering decisions (it reads from `PETDX_SOURCE_*` in the
vault), so the historical gap is audit-only.

---

## Revision history

| Version | Date       | Author       | Notes                                                                                                              |
| ------- | ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| 0.4a-1  | 2026-05-31 | LOBSTER #2   | First draft. Three calls (§0.4a section name, "fast-paint mirror" architecture term, atomic transaction failure semantics) per Hank long-term mandate 2026-05-31 10:07 TW; #6 review notes (vault key list, origin write, transaction boundary, invariant wording) folded in verbatim. |
