# Companion `avatar_url` — Store-on-Create Contract

**Status**: Draft → pending commander (#2) LGTM
**Owner**: #2 LOBSTER (commander)
**Parent card**: `card_3144142e82b1d27ced1ebe91` — Plaza avatar bug umbrella
**Supersedes (root-cause fix for)**: PR #3527 interim frontend frame-0 crop

---

## 1. Problem & Goal

PETDX companions store an `asset_url` that, for the `spritesheet` asset
type, points at a full **8×9 sprite sheet** (e.g. `/api/petdx/{slug}/sprite.webp`,
1536×1872, 192×208 per frame). Multiple surfaces historically rendered this
sheet directly into a small circular avatar box, so users saw the whole grid
of frames shrunk down instead of a single character portrait
(`card_3144142e82b1d27ced1ebe91`).

PR #3527 shipped an **interim** frontend crop (CSS `background-size:800% 900%`
+ `background-position:0 0`) so the plaza shows frame 0. That fix is per-surface
and re-derivable on every render. This spec defines the **root-cause** contract:
each companion owns a **stored single-frame `avatar_url`**, derived once at
create time, that every surface can render as a plain `<img>`.

**Goal**: `companions.avatar_url` is ALWAYS a ready-to-display single-frame
image. No surface ever needs to know the asset is a sprite sheet.

---

## 2. Data Contract

### 2.1 `companions.avatar_url` invariant

`avatar_url` is ALWAYS a single-frame raster image URL:

- Format: PNG or WebP
- Dimensions: **≤ 512×512**
- Never a sprite sheet, never equal to a multi-frame `asset_url`
- Always directly renderable as `<img src="${avatar_url}">`

`asset_url` keeps its existing meaning (may be a sprite sheet, vector source,
or procedural descriptor). `avatar_url` is **derived from** `asset_url`, never
the same value when `asset_url` is multi-frame.

### 2.2 Per-`asset_type` derivation rule

When a companion is created and the client does **not** supply a valid
`avatarUrl`, the server derives one from `asset_url` based on `asset_type`:

| `asset_type` | Derivation | Output |
|---|---|---|
| `spritesheet` | Crop frame 0 (top-left, 192×208 cell of the 8×9 grid) from `asset_url`, encode WebP | R2 key `petdx-sprites/{slug}/avatar.webp` |
| `vector` | Render the vector source at 256×256 | PNG → R2 |
| `procedural` | Run the procedural drawer, capture a snapshot | PNG → R2 |

Frame-0 geometry for spritesheet derivation is the canonical PETDX layout:
8 columns × 9 rows, each cell 192×208; frame 0 = `(0,0)` → `(192,208)`.

If the client **does** supply `avatarUrl`, it must still satisfy the §2.1
invariant (validated per §3); otherwise the server rejects or re-derives.

### 2.3 R2 key convention

Derived avatars live at `petdx-sprites/{slug}/avatar.webp` (or `.png` for
vector/procedural). `{slug}` is the companion slug. One derived avatar per
companion; re-deriving overwrites the same key (idempotent).

---

## 3. Write Guard (INSERT / UPDATE)

Every write path that sets `companions.avatar_url` MUST enforce:

1. `avatar_url !== asset_url` (a multi-frame source can never be the avatar)
2. `avatar_url` resolves to a **derived single-frame** image, validated by a
   sniff:
   - HTTP/stored content-type is `image/*`
   - decoded dimensions ≤ 512×512

On violation: the write is rejected with a clear error, OR the server derives a
compliant `avatar_url` per §2.2 and proceeds. (Create-flow guard implemented in
Phase 6 / `card_cf96e0a2`.)

The guard is server-side and authoritative — clients cannot bypass it by
sending a sprite-sheet URL as `avatarUrl`.

---

## 4. Read Contract

ALL surfaces consume `avatar_url` as a **plain `<img src>`** (or
`background-image` of a fixed square) and MUST NOT parse, crop, or treat it as a
sprite sheet:

- plaza (`community.html`)
- marketplace
- arena (leaderboard / interview result)
- community
- share-chat
- mind-map (central node)
- card-holder

Once this contract ships, the PR #3527 interim crop becomes redundant: with a
single-frame `avatar_url` stored, `community.html` renders it directly. The
interim crop stays in place until the migration (§5) has backfilled all rows,
then can be removed in a cleanup pass (tracked on the umbrella).

---

## 5. Migration

Backfill existing companions whose `avatar_url` is a sprite sheet (or equals a
multi-frame `asset_url`):

1. Select rows where `asset_type = 'spritesheet'` AND (`avatar_url IS NULL` OR
   `avatar_url = asset_url` OR `avatar_url` points at `/sprite.(webp|png)`)
2. For each, derive frame-0 WebP per §2.2 and upload to the §2.3 R2 key
3. Update `avatar_url` to the derived URL
4. Idempotent + re-runnable; logs each row's before/after

Implemented in Phase 5 / `card_fa860952`.

---

## 6. Globe-user generalization

This contract is **tenant-agnostic and applies to every EClaw user worldwide**:

- Any user creating any PETDX companion (any asset type, any locale) gets a
  compliant single-frame `avatar_url` automatically — no per-tenant config, no
  manual step.
- Derivation runs server-side with shared infra (existing R2 bucket + image
  pipeline); no new external API key, no per-user credential.
- Slugs and R2 keys are globally unique per companion, so no collision across
  users/tenants.
- Surfaces are shared across all users; the read contract (§4) holds identically
  for every locale and device (desktop + mobile).

No single-tenant carve-outs.

---

## 7. Setup conditions (what must be true for this to work)

| Condition | Provided by |
|---|---|
| R2 bucket reachable + writable at `petdx-sprites/{slug}/` | existing infra (already wired) |
| Image decode/encode (frame crop + WebP) available server-side | Phase 2 (`sharp` dep, `card_1d8cfd01`) |
| `companions.avatar_url` column exists (it does) | current schema |
| Frame-extract util | Phase 3 (`card_34a616c7`) |
| Create-flow guard wired into companion-api | Phase 6 (`card_cf96e0a2`) |

No new external keys. Uses already-wired R2 + server image tooling only.

---

## 8. Empty / disabled-state `?` icon UX

Wherever a companion avatar can be absent or still deriving, the surface shows a
neutral placeholder with a `?` affordance (hover tooltip on desktop, tap on
mobile) that explains **what / why / next step**:

- **What**: "This companion has no portrait yet."
- **Why (needs)**: "A single-frame avatar is generated from the character's
  art when the companion is created."
- **Next step (concrete)**: "Re-open the companion in the editor and press
  **Save** to generate its avatar," or for derivation-in-progress: "Avatar is
  being generated — refresh in a moment."

The `?` icon never shows a raw sprite sheet as a fallback. Until `avatar_url`
exists, surfaces render the neutral placeholder, not `asset_url`.

---

## 9. Acceptance (this spec card)

- Spec doc committed via PR
- Reviewed + **LGTM by #2 (commander)** before any implementation PR opens
- Phases 2–8 (`card_1d8cfd01` … `card_8afe8dca`) reference this doc as the
  contract of record

## 10. Phase chain

| Phase | Card | Scope |
|---|---|---|
| 1 | `card_fdf51cb6` | **This spec** |
| 2 | `card_1d8cfd01` | Add `sharp` dep + lockfile + image tooling |
| 3 | `card_34a616c7` | Frame-extract util (sprite → single frame) |
| 4 | `card_884f6f2c` | R2 `avatar.webp` key convention + petdx route |
| 5 | `card_fa860952` | Migration — backfill existing companions |
| 6 | `card_cf96e0a2` | companion-api create-flow guard (§3) |
| 7 | `card_8f2fef28` | Jest tests + companion-api regression |
| 8 | `card_8afe8dca` | Prod verification + close umbrella `card_3144` |
