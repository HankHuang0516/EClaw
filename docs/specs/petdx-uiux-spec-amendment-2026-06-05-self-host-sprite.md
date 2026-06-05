# Petdx UI/UX Spec Amendment — 2026-06-05 — Self-Host Sprite

**Status**: Draft, awaiting #1 Mac_F sign-off
**Owner**: #2 LOBSTER
**Parent bug**: kanban `card_101194c7ce179b76beea2e69` (E2E observed all 6 entities show "aet load IDLE" canvas placeholder)
**Supersedes**: hot-link decision in `backend/petdex-bridge.js` header comment (line 6) — "圖檔 hot-link 自其 R2 bucket，本表只存 URL + descriptor，不複製二進位資產"

## 1. Why

Petdex's external Cloudflare Worker `petdex-assets.raillyhugo.workers.dev` is returning **HTTP 403 forbidden for every endpoint** as of 2026-06-04 23:35 UTC.

- All 6 EClaw entities' `<canvas class="entity-avatar-canvas">` show fallback text (no sprite render); see screenshots on parent card.
- Failure is global: tested `/curated/boba/spritesheet.webp`, `/pets/clawd-2-…/sprite.webp`, `/`, `petjson.json` — all 403 with body `forbidden`.
- Not a CORS issue (Origin/Referer header makes no difference).
- All 2927 pets currently in Petdex's manifest (`https://petdex.crafter.run/api/manifest`) reference the same broken Worker hostname — this is a global Petdex CDN outage from EClaw's perspective.

The original architectural choice "hot-link, don't copy binaries" (petdex-bridge.js header) was correct for cost/storage at the time but introduced an external SPOF that has now triggered. EClaw 1.0 is a global agent-collab platform; depending on a third-party `workers.dev` subdomain for the avatar render path violates the platform-rule compliance gate (memory `feedback_platform_user_rule_compliance`).

## 2. Goal

Remove external SPOF on `petdex-assets.raillyhugo.workers.dev`. Going forward, EClaw owns the sprite bytes for every companion in our `companions` table.

Non-goal: re-host the entire 2927-pet upstream catalog. We only need the sprites for pets actually referenced by EClaw entities (currently 6) plus any sprites the user picks from the gallery going forward.

## 3. Design

### 3.1 Storage

- **Bucket**: existing EClaw R2 bucket (the one already wired via `CLOUDFLARE_API_TOKEN` device-var), under prefix `petdx-sprites/{slug}/sprite.webp`.
  - Re-use, do not create a new bucket — avoids new infra and matches the platform-rule no-single-tenant guideline.
- **CDN front**: serve via `eclawbot.com/api/files/petdx/{slug}/sprite.webp` (proxies through the existing Files API with the bucket) OR via a Cloudflare-fronted route. Choice: the existing `/api/files/:id` pattern, with deterministic slug-based file IDs so that descriptor URLs are stable.
  - Concretely: `companions.asset_url = companions.avatar_url = companions.thumbnail_url = https://eclawbot.com/api/files/petdx-sprites/{slug}/sprite.webp` (or whatever the proxy path settles to).

### 3.2 Bridge changes (`backend/petdex-bridge.js`)

`syncPetdexCatalog` is amended:

1. For each pet in the manifest, instead of only storing `pet.spritesheetUrl`:
   1. Fetch the sprite bytes from `pet.spritesheetUrl` (with the existing `EClaw-petdex-bridge/1.0` User-Agent).
   2. If 403/404/5xx, **skip the row** and record `failed_at` reason in a new column or a sidecar table. Do NOT write a broken URL into `companions`.
   3. If 200, upload to R2 at `petdx-sprites/{slug}/sprite.webp` (overwrite OK — content is immutable per slug).
   4. Write the EClaw-owned URL into `companions.asset_url` / `avatar_url` / `thumbnail_url`.
2. Add an idempotency guard: if the R2 object already exists AND the descriptor hasn't changed, skip the re-download (HEAD check).
3. Header comment block (lines 6–7) updated to reflect the new policy.

### 3.3 Backfill for the 6 broken entities

Because raillyhugo is currently 403, we cannot re-download the 6 sprites today. The backfill plan:

1. **Immediate (in this PR or follow-up):** add a "needs recovery" marker to the 6 rows. The bridge sync gracefully skips them, doesn't keep overwriting bad URLs.
2. **When raillyhugo recovers** (monitored via Phase 5 below): the regular bridge sync run picks them up automatically, downloads, uploads to R2, swaps URLs.
3. **If raillyhugo never recovers:** UX falls back to renderer emoji (Phase 4 below). Owners can re-pick from the gallery whenever a working sprite is added.

### 3.4 Renderer fallback (`backend/public/shared/petdx-renderer.js`)

Currently when sprite load fails, the canvas shows the literal string `⚠︎ sheet load failed` / `no sprite url` (see `drawSpritesheetMessage` at line 225). Amendment:

- When `spriteImageCache.get(url).error === true`, render an emoji fallback derived from `descriptor.sourceAttribution.slug` or `descriptor.kind` — e.g. 🐾 for creature, 🧑 for character, 🎯 for mascot. Plus the entity's name initial as a tiny badge.
- Keep the "load failed" hint available in console (so we don't lose debuggability) but don't put error text in the user-visible canvas.
- This is intentionally cheap and degrades gracefully — when sprites come back online the next animation tick renders them normally.

### 3.5 Upstream monitor

Add a low-frequency probe (~4h cron, similar to existing 巡查) that does `HEAD https://petdex-assets.raillyhugo.workers.dev/curated/boba/spritesheet.webp` — if it returns 200 again, the bridge re-sync can be triggered immediately.

## 4. Out-of-scope

- Mirroring the full 2927-pet catalog (only on-demand as users pick).
- Replacing the Petdex manifest API (still useful for listing the gallery; only the binaries are self-hosted).
- Adding a custom EClaw companion creator UI — separate roadmap.

## 5. Phases (impl ordering)

- **Phase 0** (this spec) — sign-off by #1.
- **Phase 1** — renderer emoji fallback (smallest, ships fastest, immediate UX win). No infra change.
- **Phase 2** — bridge + R2 upload pipeline + DB URL swap.
- **Phase 3** — upstream monitor cron + auto-trigger re-sync.
- **Phase 4** — backfill verification: re-screenshot card-holder for all 6 entities, sprite render confirmed end-to-end (this is the parent bug card's acceptance criterion).

Each phase = one PR, gated by the previous phase's review + merge per `feedback_pr_workflow` (one lang × one page = one PR, applied here as one logical concern × one PR).

## 6. Risks / open questions for #1

- **R2 cost**: sprites are ~30–80 KB each. 6 sprites today, growing to maybe a few hundred over the gallery's lifetime. Cost is negligible (<$0.01/mo at the current scale).
- **Hot-link license**: PetDex is MIT-licensed; self-hosting binaries is explicitly allowed. Attribution stays in `descriptor.sourceAttribution`.
- **Slug collisions**: PetDex allows multiple users to submit the same display name (e.g. 4 different "tomori" entries in the current manifest). The slug includes a hash suffix for disambiguation; our R2 path uses the full slug so we inherit that disambiguation for free.
- **Renderer fallback emoji choice**: do we want emoji or a static EClaw-branded 🦞 default? — leave open for #1.

## 7. Acceptance for the parent bug card

Parent card `card_101194c7ce179b76beea2e69` moves to done **only when**:

1. All 4 phases above are merged.
2. New prod E2E screenshots (desktop 1280×800 + mobile 390×844) show all 6 entities rendering their actual sprite (not the emoji fallback, not the canvas error text).
3. The 6 sprites are served from EClaw's domain (`eclawbot.com` or its CDN), verifiable via `curl -sI` returning 200.
