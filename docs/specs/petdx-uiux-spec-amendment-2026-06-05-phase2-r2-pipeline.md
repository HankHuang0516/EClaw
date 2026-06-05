# Petdx UI/UX Spec Amendment — 2026-06-05 — Phase 2 — Bridge R2 Pipeline + Public Sprite Proxy

**Status**: Draft, awaiting #1 Mac_F sign-off
**Owner**: #2 LOBSTER
**Parent bug**: kanban `card_101194c7ce179b76beea2e69`
**Builds on**: PR #3172 (`docs/specs/petdx-uiux-spec-amendment-2026-06-05-self-host-sprite.md`) §5 Phase 2
**Phase 1 reference**: PR #3175 (renderer emoji fallback) — merged 09:51 TW

## 1. Why now

End-to-end pipeline has been proved with `boba`: the upstream Petdex CLI (`npx petdex install boba`) downloaded a working `spritesheet.webp`, EClaw R2 hosted it, the renderer drew it via the R2 signed URL inside `petdx-preview.html`. Screenshot evidence: fakechat `m1780626406096-120`. Source repo: `crafter-station/petdex` (MIT) — manifest at `petdex.crafter.run/api/manifest` still returns all 2927 approved pets; the `raillyhugo.workers.dev` CDN is the only failing surface.

Phase 1 (PR #3175) plugged the user-visible hole; Phase 2 removes the dependency.

## 2. Scope

Single PR covers:

1. **Bridge rewrite** — `backend/petdex-bridge.js syncPetdexCatalog` downloads each pet sprite from its upstream URL, uploads to EClaw R2 under a stable key, and writes the EClaw-owned URL into `companions.asset_url` / `avatar_url` / `thumbnail_url`. Rows whose upstream fetch fails get marked `needs_recovery` and keep their existing URL so the Phase 1 emoji fallback still kicks in.
2. **Public sprite proxy** — new route `GET /api/petdx/:slug/sprite.webp` that streams from R2 with `Content-Type: image/webp`, `Cache-Control: public, max-age=31536000, immutable`, and no auth requirement (these are MIT-licensed public assets). The browser-facing URL stored on `companions.asset_url` is this proxy URL, **not** the short-lived signed URL.
3. **Renderer descriptor URL update** — no code change to the renderer itself; it just reads whatever URL is in `descriptor.asset.url`. The bridge writes the new URL.
4. **`needs_recovery` flag** — new boolean column `companions.needs_recovery` (default false). The Phase 3 monitor (separate card) flips it to true when fresh sprite fetch fails, and back to false when a retry succeeds.

## 3. Design

### 3.1 R2 layout

- Bucket: existing EClaw R2 bucket (the one wired via `CLOUDFLARE_API_TOKEN`).
- Key: `petdx-sprites/{slug}/sprite.webp` — slug is the upstream Petdex slug (it already includes a hash suffix for disambiguation, so no further encoding needed).
- Content-Type: `image/webp` (Petdex sheets are always webp per their convention).
- Idempotency: bridge does a HEAD on the R2 object before writing. Upstream sprites are immutable per slug, so the HEAD short-circuits the network fetch for already-cached rows.

### 3.2 Public proxy

`GET /api/petdx/:slug/sprite.webp` — no `deviceId` / `botSecret` required. The slug is sanitised (`/^[a-z0-9-]+$/`); anything else returns 404. Internally the route either:
- Pipes the R2 stream through Express (`res.set('Content-Type','image/webp'); s3.getObject(...).createReadStream().pipe(res)`), or
- 302-redirects to a fresh signed URL (simpler, lets Cloudflare cache the redirect).

Picking the pipe approach for v1 so the public URL stays stable and easy to CDN-cache. Cost is negligible because Cloudflare R2 egress is free within the same network.

### 3.3 Bridge changes

`backend/petdex-bridge.js`:

```js
async function fetchAndUploadSprite(pool, r2, pet) {
    const key = `petdx-sprites/${pet.slug}/sprite.webp`;
    // Idempotency: skip download if R2 already has the object.
    const exists = await r2.head(key).catch(() => null);
    if (exists) return { ok: true, key, cached: true };

    const resp = await fetch(pet.spritesheetUrl, {
        headers: { 'User-Agent': 'EClaw-petdex-bridge/2.0' },
    });
    if (!resp.ok) {
        return { ok: false, status: resp.status, key };
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    await r2.putObject({ Key: key, Body: buf, ContentType: 'image/webp' });
    return { ok: true, key, cached: false, bytes: buf.length };
}

async function upsertPetdexCompanion(pool, r2, pet) {
    const id = `petdex-${pet.slug}`;
    const result = await fetchAndUploadSprite(pool, r2, pet);
    const ourUrl = result.ok
        ? `${process.env.PUBLIC_BASE_URL}/api/petdx/${pet.slug}/sprite.webp`
        : pet.spritesheetUrl;  // keep upstream URL so renderer fallback still fires
    const needsRecovery = !result.ok;
    const descriptor = buildDescriptor({ ...pet, spritesheetUrl: ourUrl });
    // ...existing SQL with needs_recovery added...
}
```

A small handful of pets (the 6 currently broken EClaw entities) will hit `result.ok === false` because their upstream slugs still 403; they get `needs_recovery = true` and stay on the upstream URL, where the Phase 1 renderer falls back to the emoji.

### 3.4 DB migration

`drizzle/<next>/00xx_add_needs_recovery.sql`:

```sql
ALTER TABLE companions ADD COLUMN IF NOT EXISTS needs_recovery BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS companions_needs_recovery_idx ON companions(needs_recovery) WHERE needs_recovery;
```

### 3.5 Backfill plan

For the 2927 current upstream pets:

- The next scheduled `syncPetdexCatalog` run picks them all up.
- Pets whose upstream is currently 403 stay `needs_recovery = true`. When raillyhugo (or whoever) restores those slugs, the Phase 3 monitor triggers a re-sync and they flip back.
- Total R2 footprint at saturation: ~80 KB × 2927 ≈ 230 MB. Negligible cost.

For the 6 EClaw entities currently displaying the emoji fallback: their sprite URLs are upstream-only and will keep returning 403. Two recovery options, both fine:

1. Wait for upstream to come back; bridge auto-backfills on next sync.
2. User re-picks a new pet from the new (working) catalog via the settings page (this is the Phase C amendment).

Either way, nothing else is broken in the meantime.

## 4. Out of scope (later phases)

- Phase 3 = upstream monitor cron + `needs_recovery` retry loop.
- Phase 4 = E2E verification for the 6 broken EClaw entities → parent card close.
- Phase C (separate amendment, parallel) = portal/settings.html companion picker.

## 5. Risks / open questions for #1

- **Public proxy auth** — confirming we want zero auth on `/api/petdx/:slug/sprite.webp`. The Petdex assets are MIT-licensed public, so this is fine, but worth a sign-off.
- **`PUBLIC_BASE_URL` env var** — does EClaw already export this? If not, the bridge can fall back to a hard-coded `https://eclawbot.com`. Either way, infra config, not code.
- **CDN caching** — Cloudflare in front of the proxy should respect the `Cache-Control: immutable`. Want #1 to confirm there's no edge-rule that would strip it.
- **Quota on `fetch(pet.spritesheetUrl)`** — the bridge sync runs through 2927 pets; if upstream rate-limits, we need a `pLimit(8)` or similar. Adding it preemptively.

## 6. Acceptance for this PR

- New migration applied in staging; `needs_recovery` column exists.
- `syncPetdexCatalog` run against the current upstream manifest writes to R2 for non-failing slugs and marks the rest `needs_recovery = true`.
- `GET /api/petdx/boba/sprite.webp` returns 200 + `image/webp` + the EClaw R2 bytes.
- `companions.asset_url` for boba now points at `eclawbot.com/api/petdx/boba/sprite.webp`.
- `petdx-preview.html` renders boba via the new URL without `?deviceId` in the request.

Parent bug card `card_101194c7ce179b76beea2e69` stays in_progress until Phase 4.
