# Mission Page — 「交互開發 / Interactive Development」Sub-tab Spec

> Source of truth for the new `🧪 交互開發` sub-tab on the mission-page nav and
> the public `interactive-dev.html` page that hosts the shared point-and-edit demo.
> Tracker cards: spec `card_6f790e0a9548293e128967fe`, bug `card_a4ad4592a68281200b575d70`.

> Sub-tab nav lives in:
> - [`backend/public/portal/mission.html`](../../backend/public/portal/mission.html) (`<div class="sub-tabs">`)
> - [`backend/public/portal/kanban.html`](../../backend/public/portal/kanban.html)
> - [`backend/public/portal/env-vars.html`](../../backend/public/portal/env-vars.html)
>
> New page: `backend/public/portal/interactive-dev.html`
> Shared component: [`backend/public/portal/shared/point-edit-demo.js`](../../backend/public/portal/shared/point-edit-demo.js)
> Existing dev-only mount (kept hidden behind `?demo=pointedit`): `panel-point-edit-demo` block in [`info.html`](../../backend/public/portal/info.html) starting line 5442.

---

## 1. 為什麼 / Problem statement

Point-and-Edit demo Tracks A / B / C / D-lite are already in production
(PRs #2991, #3006, #3013, #3040, #3041; i18n #3000 / #3092). The flagship sandbox
component (`panel-point-edit-demo` + the boot routine in `shared/point-edit-demo.js`)
is wired into `info.html` only, and is hidden behind the `?demo=pointedit` query
flag — `flagOn()` returns false without the flag, `boot()` no-ops, and `unveilTab()`
never reveals the `info-tab-flagged` button. Result: the entire vertical is invisible
to anybody who lands on the portal naturally. Roadmap.html doesn't mention it either.

Hank's 2026-06-03 12:48 TW directive: surface the demo as a first-class portal
sub-tab between `📋 Kanban Board` and `🔐 Env Variables`, on every page that
already renders the mission-page sub-tab nav (mission / kanban / env-vars).
The new sub-tab lands on a brand new page (`interactive-dev.html`) that mounts
the shared component unconditionally and exposes the 3-mode chip (A · DOM,
B · Coordinate, C · Mind-map) — the D · Text-selection track is part of the same
boot so it tags along for free.

This spec also covers the public-roadmap exposure that closes
`card_a4ad4592a68281200b575d70` ("prematurely-done bug" — bug was that the track
A/B/C tickets moved to `done` while there was no public surface for end users).

---

## 2. 名詞 / Vocabulary

- **sub-tab nav** — the `<div class="sub-tabs">` block rendered near the top of
  `mission.html` / `kanban.html` / `env-vars.html` / `screen-control.html` /
  `publisher.html`. Five anchors, one marked `.active` per page.
- **Interactive Dev tab** — the new fourth anchor, label `🧪 交互開發`, target
  `interactive-dev.html`, BETA badge in a secondary span.
- **point-edit demo** — the existing `panel-point-edit-demo` block in `info.html`
  plus the boot logic in `shared/point-edit-demo.js`. Self-mounts on
  `DOMContentLoaded` when `flagOn()` returns true.
- **3-mode chip** — the `<div class="ped-mode-switch">` `role="tablist"` inside
  the panel. A / B / C / D buttons.

---

## 3. Tab placement + name

### 3.1 Order (after this spec)

| # | label                       | href                  | i18n key                          |
|---|-----------------------------|-----------------------|-----------------------------------|
| 1 | 🧠 Mind                     | `mission.html`        | `mc_tab_label`                    |
| 2 | 📋 Kanban Board             | `kanban.html`         | `kanban_tab`                      |
| **3** | **🧪 Interactive Dev** *(BETA)* | **`interactive-dev.html`** | **`mission_tab_interactive_dev`** + **`mission_tab_interactive_dev_beta`** |
| 4 | 🔐 Env Variables            | `env-vars.html`       | `kb_subtab_env` / `nav_env_vars`  |
| 5 | 📱 Remote Control           | `screen-control.html` | `kb_subtab_remote` / `nav_remote_control` |
| 6 | 📰 Publisher                | `publisher.html`      | `nav_publisher`                   |

### 3.2 Exact HTML to insert

In each of `mission.html` (between current lines 870/871), `kanban.html`
(between lines 675/676), and `env-vars.html` (between lines 272/273):

```html
<a class="sub-tab" href="interactive-dev.html">🧪 <span data-i18n="mission_tab_interactive_dev">Interactive Dev</span> <span class="beta-badge" data-i18n="mission_tab_interactive_dev_beta">BETA</span></a>
```

The `.beta-badge` style is added inline in the page's `<style>` block (same as
existing `.sub-tab` rules). Visual: `font-size:10px; padding:1px 6px;
border-radius:8px; background:rgba(255,176,32,0.16); color:#ffb020; margin-left:4px;
letter-spacing:0.5px;` — matches the warning/beta palette already used by
`roadmap.html` status badges.

### 3.3 Active state on the new page

`interactive-dev.html` reuses the same nav block but flips the active class to
its own anchor. The existing `?embed=1` link-preservation block at
`mission.html:879` is copied verbatim into the new page.

---

## 4. interactive-dev.html

### 4.1 Page chrome

- Same `<head>` boilerplate as `kanban.html`: meta viewport, theme vars,
  `shared/api.js`, `shared/nav.js`, `shared/public-nav.js`,
  `../shared/telemetry.js`, `../shared/i18n.js?v=1.2.2`, `shared/footer.js`.
- Same sub-tabs nav block as §3.1, with `.active` on this anchor.
- `<h1 data-i18n="interactive_dev_page_title">🧪 Interactive Development</h1>`
  immediately under the nav (matches `kanban.html` H1 placement).
- Lazy-mount strategy: a `<div id="interactive-dev-mount">` placeholder is
  rendered in markup. After `DOMContentLoaded`, the page sets
  `window.POINTEDIT_DEMO = true` **before** appending `<script src="shared/point-edit-demo.js">`,
  so `flagOn()` returns true and the boot routine self-attaches to the panel.
  The full `panel-point-edit-demo` markup (lifted from `info.html:5442–5685`)
  is rendered inside the mount.

> *Why lazy:* the panel block contains 13 `data-point-edit-id` anchors and the
> mind-map sandbox; injecting it after first paint keeps the sub-tabs LCP fast.
> Same payload, no markup divergence — see §6 for the dedupe plan.

### 4.2 3-mode chip + shared task input

The chip is the existing `<div class="ped-mode-switch">` (A · Hover & Click /
B · Coordinate + AST / C · Mind-map Node / D · Text Selection). Per dispatch,
the page is described as A/B/C — D ships in the same chip because removing it
would fork the shared component. The composer `<textarea>` (the "shared task
input") and the `<pre data-ped-payload>` live in the existing right-rail
`<aside class="ped-composer">` block; no copy-paste forking.

### 4.3 Acceptance criteria

- Tab is visible in mission.html / kanban.html / env-vars.html without any
  `?demo=*` query flag.
- Clicking it navigates to `interactive-dev.html` (HTTP 200, no 404).
- On `interactive-dev.html`, the `.ped-mode-switch` renders, mode A is active
  by default, clicking modes B/C/D toggles `.active` correctly.
- Mode A: hover → click on `.ped-block` → payload appears in `data-ped-payload`.
- Mode C: click `[data-ped-anchor]` mind-map node → payload appears.
- Prod URL screenshots attached to the impl card:
  - Mobile 390×844 (`https://eclawbot.com/portal/mission.html`)
  - Desktop 1280×800 (`https://eclawbot.com/portal/interactive-dev.html`)
- BETA badge renders on every locale (no untranslated key showing up as
  `mission_tab_interactive_dev_beta`).

---

## 5. i18n keys (× 13 locales)

New keys added to `backend/public/shared/i18n.js`. Locales: `en`, `zh-TW`,
`zh-CN`, `ja`, `ko`, `es`, `pt`, `fr`, `de`, `vi`, `th`, `id`, `ms`.

| key | en | zh-TW | zh-CN | ja | ko | es | pt | fr | de | vi | th | id | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `mission_tab_interactive_dev` | Interactive Dev | 交互開發 | 交互开发 | インタラクティブ開発 | 인터랙티브 개발 | Desarrollo interactivo | Desenvolvimento interativo | Dév. interactif | Interaktive Entwicklung | Phát triển tương tác | การพัฒนาแบบโต้ตอบ | Pengembangan interaktif | Pembangunan interaktif |
| `mission_tab_interactive_dev_beta` | BETA | 測試版 | 测试版 | ベータ | 베타 | BETA | BETA | BÊTA | BETA | BETA | เบต้า | BETA | BETA |
| `interactive_dev_page_title` | 🧪 Interactive Development | 🧪 交互開發 | 🧪 交互开发 | 🧪 インタラクティブ開発 | 🧪 인터랙티브 개발 | 🧪 Desarrollo interactivo | 🧪 Desenvolvimento interativo | 🧪 Développement interactif | 🧪 Interaktive Entwicklung | 🧪 Phát triển tương tác | 🧪 การพัฒนาแบบโต้ตอบ | 🧪 Pengembangan interaktif | 🧪 Pembangunan interaktif |

All three keys must be **translated, not English passthroughs** — per Hank's
recurring guidance on i18n cleanup (gap warnings fire CI if an English string
appears in a non-en bucket).

---

## 6. Dedupe / future cleanup

The panel block currently lives inside `info.html` (lines 5442–5685). For this
spec we lift a copy into `interactive-dev.html` so the new page is self-contained
and the dev-only `info.html` tab keeps working (still hidden behind
`?demo=pointedit`). The duplication is intentional and short-lived:

- Phase A (this spec): two copies of the panel HTML; one shared `point-edit-demo.js`.
- Phase B (follow-up, not in this spec): extract the panel HTML into a
  `<template id="panel-point-edit-demo-tmpl">` partial loaded by both pages
  (or via a one-line `fetch().then(...)` against a shared `.html` partial).
  Tracked separately to keep this PR small.

Once Phase B lands, `info.html` either drops the inline copy or keeps it for the
dev-only `?demo=pointedit` shortcut — decided at that time.

---

## 7. Bug card linkage (card_a4ad4592)

The companion bug card calls out that the Track A/B/C tickets moved to `done`
prematurely — there was no public surface, so "done" was internally
indistinguishable from "shipped but invisible". This spec closes that gap by:

1. Adding the new sub-tab + page (§3 + §4).
2. Adding a `Point-and-Edit Demo` callout to `roadmap.html` linking to
   `/portal/interactive-dev.html` (one card next to the §6 *Bot Capability
   Assessment* row).
3. Leaving the `info.html` dev-only tab unchanged — still hidden, still
   `?demo=pointedit`-gated.

Cross-comment policy: when the impl PR merges, post on both
`card_6f790e0a...` (spec parent) and `card_a4ad4592...` (bug) with the PR URL
and Railway deploy SHA.

---

## 8. Out of scope

- Refactoring the panel into a Web Component or framework partial (covered by
  Phase B in §6).
- Adding new Tracks (E/F/...) — current chip stays A/B/C/D.
- Auth gating — the demo is public and stateless; no entity context needed.
- Changing the `?demo=pointedit` query semantics in `info.html` — kept as-is
  for backwards compat with internal links.

---

## 9. Rollout

- One impl PR opens immediately after this spec merges (per the spec-first
  workflow). Linked via `linkedNextCardId` / `linkedPrevCardId` on the cards.
- After the impl PR merges, Railway redeploys main → Playwright session
  captures the two acceptance screenshots → attached to the impl card → all
  three cards move to `done`.
- No feature flag, no staged rollout. The component itself has been in prod
  behind `?demo=pointedit` since 2026-05; this just adds a fixed entry point.
