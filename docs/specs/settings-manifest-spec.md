# Settings Manifest / APP Auto-Sync Seam Spec

> Source of truth for how a NEW Settings feature reaches the mobile apps with
> ZERO app rebuild.
> Logic:    [`backend/lib/settings-manifest.js`](../../backend/lib/settings-manifest.js) (`buildSettingsManifest`)
> Endpoint: `GET /api/settings-manifest` in [`backend/index.js`](../../backend/index.js) (next to `/api/version`)
> Web UI:   [`backend/public/portal/settings.html`](../../backend/public/portal/settings.html)
> Tests:    [`backend/tests/jest/settings-manifest.test.js`](../../backend/tests/jest/settings-manifest.test.js)

## 動機 / Why this spec exists

Hank's request: 「設計一種方法讓設定內的新功能自主同步到 APP 中」 — design a way for
new Settings features to auto-sync into the app.

The EClaw mobile app is **HYBRID**:
- Android `SettingsActivity.kt` is **native** for some Settings features and
  **WebView-embeds** `backend/public/portal/settings.html` for others.
- iOS is the same shape.

Today there is **no settings manifest/schema**. The native half is hand-maintained,
so it **drifts** from the web half every time a web-only Settings feature ships.
Adding a feature to the web does not surface it in the app until someone hand-edits
the native code and ships a store release.

`/api/version` (`backend/index.js`, near the `/api/version` handler) carries
**hardcoded per-platform feature lists** — a parallel, stale source of truth that
makes the drift worse, not better.

### Drift list (2026-06 settings audit)

| Severity | Feature | Drift |
|----------|---------|-------|
| HIGH | `rotate_secret` (Rotate Secret) | missing from BOTH Android and iOS native |
| HIGH | `switch_device` (Switch Device) | missing from BOTH Android and iOS native |
| MED  | `rental_management` (出租管理) | full UI is web-only on both apps |
| MED  | `agent_policy` (Agent Policy) | web-only on both apps |
| MED  | `channel_api` (Channel API) | Android settings is **read-only** (partial) |
| MED  | `notifications` | iOS exposes **fewer** notification categories (partial) |

---

## 1. 名詞 / Vocabulary

- **Settings feature** — One row in the Settings page (e.g. *Subscription*,
  *Rotate Secret*). Identified by a stable `key`.
- **native support** — How well the running app implements a feature in native code:
  - `true` — fully native screen.
  - `"partial"` — native UI exists but is incomplete; the rest lives on the web.
  - `false` — no native UI; the app must open the web fallback.
- **webFallback** — A portal URL the app opens in a WebView when native support is
  `false` or `"partial"`, or when the version gate downgrades the feature.
- **minAppVersion** — The FIRST app version that ships the declared native support
  for a platform. An older app is downgraded to `native:false` + `webFallback`.

---

## 2. The seam

```
                     GET /api/settings-manifest?appVersion=&platform=
  App launch ───────────────────────────────────────────────►  backend
       ▲                                                            │
       │   { success:true, manifest:{ platform, appVersion,         │
       │       stage:1, features:[ {key,name,enabled,native,        │
       │       webFallback,minAppVersion}, ... ] } }                │
       └────────────────────────────────────────────────────────────┘

  For each enabled feature the app surfaces an entry:
    native === true       → render the native screen
    native === "partial"  → render native UI + a "more on web" link → webFallback
    native === false      → open webFallback in a WebView
```

The manifest is a **pure capability descriptor**: it contains no user data, so the
endpoint needs **no auth** — it mirrors `/api/version`'s public-GET access pattern.
The function `buildSettingsManifest(appVersion, platform)` is pure,
device-/entity-/locale-agnostic (**Globe-user**): the same inputs always produce the
same manifest for any user worldwide.

### 2.1 Endpoint contract

`GET /api/settings-manifest?appVersion=<semver>&platform=<android|ios>`

- `appVersion` — optional. When omitted, native support is reported as declared
  (no version downgrade).
- `platform` — optional, case-insensitive. Unknown / missing → defaults to `android`.
- Response: `{ "success": true, "manifest": { ...see §2 } }`.
- On internal error: `500 { "success": false, "error": "manifest_build_failed" }`.

### 2.2 Feature entry shape

```jsonc
{
  "key": "rotate_secret",            // stable identifier
  "name": "Rotate Secret",           // display label (apps may localize)
  "enabled": true,                   // feature is live at all
  "native": false,                   // true | "partial" | false  (post-gate)
  "webFallback": "https://eclawbot.com/portal/settings.html?focus=rotate_secret",
  "minAppVersion": "0.0.0"           // floor for native support on this platform
}
```

`webFallback` is **always present** so the app can open it whenever it needs to,
regardless of `native`. URLs point at
`https://eclawbot.com/portal/settings.html?focus=<key>` (the `?focus=<key>` param
tells the portal to scroll to / highlight that section), or the relevant portal page.

---

## 3. The auto-sync contract (the answer to Hank's request)

A **NEW** Settings feature reaches the app with **ZERO app rebuild** by doing only:

1. Add the feature's section to the web `backend/public/portal/settings.html`.
2. Add ONE entry to `FEATURES` in `backend/lib/settings-manifest.js`.

Then, the next time any app launches and calls `GET /api/settings-manifest`:

- If the feature is declared `native:false` (the default for a brand-new web-only
  feature), every app immediately surfaces an entry that opens the web fallback in a
  WebView. No store release. The feature is live on day one.
- Later, when a platform ships native support, bump that feature's `native` and
  `minAppVersion` for the platform. Apps at/above the floor get the native screen;
  older binaries keep the web fallback automatically.

This removes the drift class entirely: the web settings page + the manifest are the
single source of truth, and the manifest is what the app reads.

### Version gating (worked example)

Feature `companion_petdx` declared `native:{android:true}`, `minAppVersion:{android:"2.5.0"}`:

| Running app | `native` returned | Surface |
|-------------|-------------------|---------|
| `1.0.0` (old) | `false` | WebView → `webFallback` |
| `2.5.0` | `true` | native screen |
| `3.0.0` | `true` | native screen |

---

## 4. Globe-user / setup conditions / ? icon UX

- **Globe-user**: no device, entity, or locale is hardcoded. The manifest is
  identical for every user worldwide; `name` strings are English defaults that apps
  localize via their existing i18n. No single-tenant carveouts.
- **Setup conditions**: none for Stage 1 — the endpoint is public and stateless.
  Apps must send `appVersion` + `platform` on launch to get correct gating; if they
  don't, they get the "declared" (latest-capable) view, which is safe (it may show a
  native flag the binary can't honor — Stage 2 apps must send `appVersion`).
- **? icon UX (empty / disabled state)**: when a feature shows the web-fallback
  variant, the app's `?` affordance should reveal: *what* (this setting opens in the
  web view because the native screen isn't in this app version yet), *needs* (update
  the app to get the native screen, or use it on the web now), and the *next step*
  (a tappable "Open on web" / "Update app" button).

---

## 5. Stages / follow-ups

- **Stage 1 (this spec — backend only, NO app code):** `buildSettingsManifest` +
  `GET /api/settings-manifest` + tests + this spec. Ships independently; no build.
- **Stage 2 (needs an app build):** Android `SettingsActivity.kt` and the iOS
  settings screen **consume** `/api/settings-manifest` at launch and render entries
  from it (native vs WebView per `native`). Tracked as a follow-up card.
- **Stage 3 (needs a build):** Native implementation of the HIGH-drift features
  `rotate_secret` + `switch_device`, plus a **full dynamic schema registry**
  (field-level declarations, so even the contents of a native screen are
  manifest-driven). Tracked as a follow-up card.

`/api/version`'s hardcoded feature lists should eventually be derived from this
manifest (out of scope for Stage 1).
