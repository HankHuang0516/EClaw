# Unified App/Web Redirect State Machine — Spec

**Card:** card_14571f26914b9c1eae148362 (OODA-R Phase 2 #7)
**Parent:** card_be59aa034883fe36d3645a27 (10-pain roadmap — pains 1 + 5)
**Status:** APPROVED — #6 review 2026-06-12 06:22 TW (3 open points ruled + 3 amendments folded in this revision)
**Author:** #2 LOBSTER, 2026-06-12

## 1. Problem

Redirect/deep-link behavior is fragmented and mostly absent:

| Surface | Today |
|---|---|
| Android | No `eclaw://` scheme, no App Links `autoVerify` — only the FB-login scheme is registered. App cannot be opened from a link at all. |
| iOS | `applinks:eclawbot.com` entitlement EXISTS (ios-app/EClaw.entitlements) — the missing piece is the server-side AASA file + `/r/` route, not the app config (#6 review amendment 3). |
| Web | `eclaw://note/<id>` is an *internal* pseudo-protocol for iframe note previews (mission.html / share-chat.html) — not OS deep linking; the name collides with what a real app scheme would be. |
| Cross-page | Pages hand-roll `window.location` hops (auth 401 → index, quote → chat.html); no shared route builder, no return-to contract beyond `?authReason`. |

Pain 1 (App 轉導不穩定) and pain 5 (Web 轉導不行) are both symptoms of "no single owner of the route contract".

## 2. Canonical route registry (single SoT)

New `backend/shared/route-registry.js` (plain CJS, importable by backend + copied to portal shared/) declaring every logical destination once:

```js
// URL shapes match the CURRENT consumers exactly (#6 review amendment 1 —
// verified against kanban.html hash handler, chat.html ?contact, /p/ + 
// /community/ Express routes):
const ROUTES = {
  dashboard:   { web: '/portal/dashboard.html',                          params: [] },
  chat:        { web: '/portal/chat.html?contact={publicCode}',          params: ['publicCode'] },
  card:        { web: '/portal/kanban.html?card={cardId}#{cardId}',      params: ['cardId'] },
  note:        { web: '/portal/mission.html?note={noteId}',              params: ['noteId'] },
  profile:     { web: '/p/{publicCode}',                                 params: ['publicCode'] },
  settings:    { web: '/portal/settings.html',                           params: [] },
};
```

- `buildWebUrl(target, params)` / `buildUniversalUrl(target, params)` are the ONLY sanctioned URL constructors. Hand-rolled portal hops migrate opportunistically (out of scope here except the entry points the E2E matrix covers).
- App route = same universal URL (see §3); the app consumes the identical path. No separate `eclaw://` app scheme in v1 — App Links/Universal Links operate on `https://eclawbot.com/r/...` directly, which also IS the web fallback. (The internal `eclaw://note/` iframe protocol is grandfathered and renamed-from-scope; it never leaves the page.)

## 3. Universal entry: `GET /r/:target`

One Express router (`backend/redirect-router.js`) is the single entry for every deep link:

```
https://eclawbot.com/r/card?cardId=card_abc123&traceId=rt_8f3a...&sig=...&exp=...
```

- **Android App Links**: `assetlinks.json` + manifest intent-filter `autoVerify` on `https://eclawbot.com/r/*` → OS opens the app when installed (app slice ships separately; the contract is fixed here).
- **iOS Universal Links**: serve `apple-app-site-association` for the `/r/*` prefix — the app-side `applinks:eclawbot.com` entitlement already exists, so Phase C is server-only.
- **Web / app-not-installed**: the router serves a tiny interstitial that (a) logs telemetry, (b) 302s (or JS-redirects after a 400 ms app-attempt window on mobile UAs) to `buildWebUrl(target, params)`.

### Signed envelope

- `traceId` (`rt_` + 12 hex) — ALWAYS present.
- **Minting is server-side only** (#6 review amendment 2): `POST /api/redirect/mint {target, params}` (botSecret/deviceSecret-authed) returns the signed URL. Portal JS never sees the signing secret; for public targets the portal may build unsigned URLs locally via the registry.
- `sig` + `exp` — REQUIRED only for **sensitive** targets (anything that pre-selects private context: `card`, `note`). HMAC-SHA256 over `target|sortedParams|exp` with server `REDIRECT_SIGNING_SECRET` (reuses JWT_SECRET in v1 — no new key, per no-new-keys rule). Public targets (`dashboard`, `profile`) skip `sig`.
- Invalid/expired sig → state `SIG_REJECTED` → redirect to plain `dashboard` with toast param (`?redirectError=expired`), never a dead end.

## 4. State machine

```
RECEIVED → SIG_CHECK ─fail→ SIG_REJECTED → WEB_FALLBACK(dashboard)
              │ok
        PLATFORM_DETECT (UA + sec-ch-ua-mobile)
              ├─ app-capable mobile → APP_ATTEMPT ─timeout 400ms→ WEB_FALLBACK(target)
              │                        └─(OS takes over)→ APP_OPENED   [terminal, app logs its own arrival]
              └─ desktop / bot → WEB_DIRECT(target)
        WEB_DIRECT/WEB_FALLBACK → AUTH_GATE (existing softAuth on the target page)
              ├─ no session → LOGIN_REDIRECT (index.html?return_to=<urlencoded /r/ url>&authReason=no_token)
              │                  └─ post-login: auth.js consumes return_to → re-enters /r/ (sig still valid ≤ exp)
              └─ session ok → TARGET_RENDERED [terminal]
```

Every transition logs one line (see §5). `return_to` is validated against the route registry (same-origin + known target) — never an open redirect.

## 5. Observability

- Each state transition: `POST /api/redirect/telemetry` (beacon, fire-and-forget) or server-side log when the transition happens in the router: `{traceId, state, target, platform, fallbackReason?, ts}`.
- Storage: `redirect_events` table (traceId, state, target, platform, fallback_reason, created_at; index on traceId + created_at).
- `GET /api/redirect/stats?window=7d` → success rate per target/platform (`TARGET_RENDERED+APP_OPENED / RECEIVED`), powering the acceptance "telemetry dashboard" (v1 = JSON endpoint + a uw-style card on dashboard.html; chart reuses the #3315 SVG helper).

## 6. E2E matrix (feeds Phase 3 #8)

| Flow | desktop web | mobile web | Android app | WebView |
|---|---|---|---|---|
| web→target (logged in) | P0 | P0 | n/a | P0 |
| web→target (before login → return_to) | P0 | P0 | n/a | P0 |
| app-not-installed fallback | n/a | P0 | n/a | n/a |
| app→web (app shares /r/ link) | P1 | P1 | P1* | P1 |
| deep-link to specific card | P0 | P0 | P1* | P0 |
| sig expired / tampered | P0 | P1 | n/a | n/a |

`*` Android slices land with the manifest/assetlinks PR (separate card; needs a release build — flag to Hank only at that point).

## 7. Phasing

- **A (this card, after sign-off):** route-registry + `/r/` router + sig/traceId + telemetry table/endpoints + web/interstitial fallback + LOGIN_REDIRECT return_to in auth.js + jest + prod E2E rows marked P0 above (web/WebView columns).
- **B (separate card):** Android manifest + assetlinks.json + app-side /r/ handler.
- **C (separate card):** iOS AASA.
- **D (separate card):** migrate legacy hand-rolled hops to buildWebUrl.

## 8. Open points for #6 review

1. 400 ms app-attempt window vs going straight to web until Phase B ships (proposal: straight-to-web now, window activates with Phase B — zero user-visible latency today).
2. `redirect_events` retention (proposal: 30 d cron purge piggybacking existing maintenance).
3. Whether `chat` target should be sig-required (it pre-selects an entity but exposes nothing without a session; proposal: public).
