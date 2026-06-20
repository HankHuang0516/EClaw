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
- **Stage 3 — field registry (backend-only slice, SHIPPED, no app build):** a
  **JSON-schema-lite field registry** embedded in the same `FEATURES` table and
  returned by the existing `GET /api/settings-manifest` (no separate
  `/api/settings-schema` endpoint — the manifest stays the single source of
  truth). Per #6's ruling each feature carries a nested `schema` object
  (`{version, renderer, dataSource:{read,write}, fields}`) or `schema:null`; the
  envelope carries a top-level `schemaVersion` too. See §6.
- **Stage 3 — native (needs a build):** Native implementation of the HIGH-drift
  features `rotate_secret` + `switch_device`, plus apps rendering native screen
  *contents* from the field registry above. Tracked as a follow-up card.

`/api/version`'s hardcoded feature lists should eventually be derived from this
manifest (out of scope for Stage 1).

---

## 6. Field registry (Stage-3 backend slice) — #6 nested `schema` format

> **#6 authoritative ruling (postdates the original flat implementation):** the
> field registry is NESTED under a per-feature `schema` object, NOT a flat
> top-level `fields`/`schemaVersion` on the feature. The `schema` also declares
> *where* an app reads and writes the values (`dataSource`), so a generic form
> renderer needs no hardcoded endpoint map.

Each feature MAY declare a `schema` object so an app can render the *contents* of
its settings screen — and persist them — straight from the manifest. Features
with no settable fields emit `schema: null`. The manifest envelope still carries a
top-level `schemaVersion` (`FIELD_SCHEMA_VERSION`, currently `1`) so a consumer
can detect the field format independently of any single feature. `schema` is
emitted verbatim on every platform — it is NOT affected by the `native`
version-downgrade gate.

### 6.1 Schema wrapper shape

```jsonc
{
  "key": "notifications",
  "name": "Notifications",
  "native": { "android": true, "ios": "partial" },
  "minAppVersion": { "android": "1.0.0", "ios": "1.0.0" },
  "schema": {
    "version": 1,                  // breaking field-format version for THIS feature
    "renderer": "form",            // the only renderer today
    "dataSource": {
      "read":  { "method": "GET", "path": "/api/notification-preferences", "auth": "device", "responsePath": "prefs" },
      "write": { "method": "PUT", "path": "/api/notification-preferences", "auth": "device", "requestPath": "prefs" }
    },
    "fields": [
      { "key": "bot_reply", "type": "boolean", "control": "switch",
        "label": { "i18n": "notif_pref_bot_reply", "fallback": "Bot replies" },
        "scope": "device", "default": true, "validation": { "required": false } }
    ]
  }
}
```

- **dataSource** — the REAL settings read/write endpoints (grepped from the
  backend). `read` carries `responsePath` (JSON path to the values object in the
  response, e.g. `prefs` / `profile`); `write` carries `requestPath` (JSON path the
  app nests the payload under). A **pure-action** feature (`rotate_secret`,
  `switch_device`) has no value to read, so `dataSource` carries only `write`.
  `auth` is `device` for every current feature.

### 6.2 Field descriptor shape

```jsonc
{
  "key": "kanban_nudge_batch_size",   // stable per-feature field id, never renamed
  "type": "number",                    // boolean | string | number | enum | multi_enum | action
  "control": "slider",                 // see control vocabulary below
  "label": { "i18n": "kanban_nudge_batch_label", "fallback": "Cards per cycle" },
  "help":  { "i18n": "kanban_nudge_batch_help", "fallback": "..." }, // optional, same shape
  "scope": "device",                   // device | entity | user
  "default": 5,                        // default value — OMITTED for type:"action"
  "writeAliases": ["chat_avatar_size"],// optional: API payload key(s) when ≠ `key`
  "validation": { "min": 1, "max": 20, "step": 1, "unit": "cards" }
}
```

- **label / help** are always `{i18n, fallback}` (Globe-user): `i18n` is the
  canonical key into `backend/public/shared/i18n.js`, `fallback` is the EN default
  an app shows if the key is missing. Reuse existing i18n keys.
- **control vocabulary** (bounded, per type):
  - `boolean` → `switch`
  - `string` → `text` | `textarea` | `password`
  - `number` → `slider` | `stepper`
  - `enum` / `multi_enum` → `select` | `multiselect`
  - `action` → `button`
- **writeAliases** — present only when the write-payload key differs from the
  field `key`. The app writes the value under the alias key(s) instead of `key`.
  An array because one toggle may map to several API keys (e.g. the
  `feedback` toggle governs both `feedback_resolved` and `feedback_reply`).
- **validation** is type-specific:
  - `number` → `{min, max, step, unit}` (+ optional `required`).
  - `enum` / `multi_enum` → `{options:[{value, label:{i18n,fallback}}]}`.
  - `string` → `{maxLength}` (+ optional `required`).
  - `action` → no `default`; may carry `{confirm:true}` for destructive ops.
  - any → `{required}`.

### 6.3 Features with a schema today

| Feature | dataSource (read / write) | Fields | writeAliases |
|---------|---------------------------|--------|--------------|
| `account_identity` | GET+PUT `/api/device/user-profile` (`profile`) | `user_display_name` (string, maxLength 64) | `user_display_name`→`userDisplayName` |
| `chat_prefs` | GET+PUT `/api/device-preferences` (`prefs`) | `avatar_size` (enum small/medium/large) | `avatar_size`→`chat_avatar_size` |
| `notifications` | GET+PUT `/api/notification-preferences` (`prefs`) | 8 boolean switches (`bot_reply`…`rich_card`) | `feedback`→`[feedback_resolved,feedback_reply]`, `todo`→`todo_done`, `rich_card`→`rich_card_question` |
| `kanban_nudge` | GET+PUT `/api/device-preferences` (`prefs`) | `kanban_nudge_batch_size`, `kanban_nudge_interval_minutes` (number) | none (keys match API) |
| `rotate_secret` | POST `/api/device/rotate-secret` (write-only) | `rotate_device_secret` (action, confirm) | n/a |
| `switch_device` | POST `/api/auth/device-login` (write-only) | `device_id`, `device_secret` (string, required) + `switch_device` (action) | `device_id`→`deviceId`, `device_secret`→`deviceSecret` |

Features with no settable fields emit `schema: null`. Adding a field = one targeted
edit to the `FEATURES` entry's `schema.fields`; reuse an existing i18n key or add
new EN+zh-TW+zh-CN keys via `backend/scripts/i18n-insert-locale-keys.js`.
