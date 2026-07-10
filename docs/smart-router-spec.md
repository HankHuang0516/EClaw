# Smart Router — 3-Mode Navigation Spec (Web 單頁 / Web 分割版 / APP)

**Card:** card_1d433654456b95e3a281827f (Hank 2026-06-10 15:21 TW)
**Status:** APPROVED — #6 review 2026-06-12 08:50 TW: Q1=(a), Q2=(c, native follow-up card), Q3=as proposed; 4 amendments folded in this revision
**Author:** #2 LOBSTER, 2026-06-12
**Sibling spec:** `docs/redirect-state-machine-spec.md` (entry/deep-link layer; see §6)

## 1. The three modes

| Mode | Who | Navigation semantics |
|---|---|---|
| 1 `single` | desktop/mobile browser on a standalone portal page | full-page transition (`window.location`) |
| 2 `split` | workspace.html hosting ≥1 `iframe.workspace-pane` | pane-local content swap; sibling panes keep context |
| 3 `app` | Android/iOS app WebView with native bottom tab bar | native tab/Activity switch via typed bridge; scroll preserved; no full reload |

## 2. Mode detection (decision tree, first match wins)

```
detectMode():
  ├─ window.EClawNativeNav exists                → 'app'      (typed bridge, PR #2824)
  │    └─ else AndroidBridge or /EClawAndroid|EClawIOS/i UA   → 'app' (legacy fallback)
  ├─ body.embed-mode  OR  ?embed=1  OR  window.parent !== window
  │    AND parent origin === self origin         → 'split'
  └─ otherwise                                   → 'single'
```

Notes:
- `'app'` outranks `'split'` — an embedded WebView inside the app is still app-mode (the native shell owns the tab bar).
- The `window.parent !== window` check closes today's gap: panes loaded into workspace.html without `?embed=1` still behave as split.
- `single` finally gets an explicit marker: `document.body.dataset.navMode = mode` is set by the router at boot on every page (CSS/tests can key off it).

## 3. Module contract — `backend/public/portal/shared/smart-router.js`

```js
const SmartRouter = {
  mode,                            // 'single' | 'split' | 'app'  (frozen at boot)
  navigate(target, opts = {}),     // target = logical name from the route registry
  onNavigate(handler),             // in-mode transitions (split content swap, app tab replay)
  buildUrl(target, params),        // delegates to route-registry (redirect spec §2) — single URL SoT
};
```

### Per-mode dispatch

| Mode | `navigate()` does |
|---|---|
| `single` | `window.location.assign(buildUrl(target, params))` — browser history natural |
| `split` | `parent.postMessage({type:'split_navigate', requestId, target, params, panel:'self'}, origin)` — workspace.html's existing message listener (the one already relaying `eclaw_quote` / `eclaw_requote`) gains a `split_navigate` case. **Ack contract (#6 review am.4):** `requestId` = `nav_` + 8 hex minted by the pane; the host identifies the requesting iframe via `event.source` (NEVER by src matching — duplicate pages break that), swaps that pane's src, and posts `{type:'split_navigate_ack', requestId}` back to `event.source` BEFORE the swap unloads it. The pane starts a **300 ms** timer at send: ack received → cancel timer, await unload; timer fires with no ack → degrade to `single` dispatch (full-page navigate). A late ack after degradation is ignored (requestId no longer pending). |
| `app` | `window.EClawNativeNav.navigate({targetTab, sourceTab, target, ...params})` — the EXISTING typed contract (`EClawNativeNavBridge.kt` on Android, iOS postMessage twin from PR #2824). Native replays into the destination WebView via `window.eclawHandleNativeNavigateIntent`. ⚠️ The card description guessed `AndroidBridge.navigateTo(toPage)` — that API does not exist; this spec binds to the real bridge. **Native-host mapping (#6 review am.1):** current app shells host the five bottom tabs `home`, `chat`, `mission`, `cards`, and `settings`; iOS maps these to Expo routes `/(tabs)`, `/(tabs)/chat`, `/(tabs)/mission`, `/(tabs)/cards`, and `/(tabs)/settings`. The portal router must keep an explicit target map and ANY target absent from that map (profile, wallet, external destinations, …) falls back to `single` dispatch IMMEDIATELY — no bridge round-trip, no timeout wait. The map grows only when the native shells gain hosts. |

Fallback rule: if a mode-specific dispatch fails (no parent listener ack within 300 ms in split; bridge returns false in app), degrade one level (`app→single`, `split→single`) so navigation never dead-ends.

### `onNavigate(handler)`

- `split`: pane receives `{type:'split_navigated', target}` after the host swaps it (lets the page lazy-init).
- `app`: wraps the existing `eclawHandleNativeNavigateIntent` replay so pages subscribe once instead of defining the global.
- `single`: no-op (full reload re-boots the page anyway); kept for call-site symmetry.

## 4. Migration inventory (proof-slice scope; #6 review am.2+am.3)

⚠️ The original 23-site count under-grepped (it missed bare `location =` and
`location.replace()` forms). Full-form grep over the 6 spec pages + nav.js
finds **28** assignments (settings 11, chat 5, kanban 5, mission 3, files 2,
dashboard 1, nav.js 1), and pages outside this spec's scope contain more.
This table is therefore a **proof-slice inventory** for the listed pages, not
a repo-total; Phase D's first task is the authoritative full-repo grep
(`(window\.)?location(\.href)?\s*=|location\.(assign|replace)\(`) checked in
as a lint snapshot.

| Page | Sites (full-form) | Notes |
|---|---|---|
| settings.html | 11 | 5 static nav cards (wallet/my-rentals/invite/files/petdx) + tour hops + post-action hops + rental-details |
| chat.html | 5 | 2 WebView download interceptions + popup fallback (stay raw); 2 others to classify in Phase D |
| kanban.html | 5 | 2 chat hops with context (`?mention=`, `?msg=`) → registry params; 3 popup fallbacks (stay raw) |
| mission.html | 3 | kanban card hop + 2 chat hops → router |
| files.html | 2 | both chat hops → router (proof slice) |
| dashboard.html | 1 | settings#agent-policy hop → router |
| shared/nav.js | 1 | logout → index (stays raw: auth boundary precedes router boot) |

**Registry expansion required before migration (#6 am.2):** the v1 registry
(dashboard/chat/card/note/profile/settings) must grow targets for
`wallet`, `my-rentals` (+ `rentalId` param), `invite`, `files`, `petdx`
(petdx-browser), `settings` fragment param (e.g. `#agent-policy`), `chat`
extra params (`mention`, `msg`), and tour params (`tour`, `step`) — added in
the same PR as the first page migration that needs each one (registry stays
minimal until a consumer exists; every addition includes its param regex).

## 5. Open questions (defaults proposed; need sign-off)

- **Q1 — split-pane navigate scope:** (a) only the requesting pane changes ✅ proposed. (b) push new pane / (c) push+collapse-oldest rejected for v1: workspace pane management already has its own UX (pane labels + close), navigation silently mutating the pane set would surprise.
- **Q2 — app background-tab WebViews:** (c) hybrid LRU (keep ≤4 alive, evict 5th+) ✅ proposed — matches platform tab-bar norms. Note: implementation lives in the native shells, NOT smart-router.js; the router only guarantees the `navigate` intent contract. Becomes a native-side follow-up card.
- **Q3 — back behavior:** mode 1 = native browser history (router uses `assign`, never `replace`, except auth bounces). mode 3 = page-within-tab back first → previous tab → minimize ✅ proposed (today's Android back already approximates this; codify it). mode 2 = browser back leaves workspace entirely (iframe swaps don't push history) — v1 accepts this; per-pane history is a v2 question.

## 6. Relationship to the redirect state machine (`/r/`)

- `/r/:target` (redirect spec) is the **entry** layer: OS deep links, cross-surface links, login round-trips. It always lands a full page load.
- `SmartRouter.navigate` is the **in-session** layer: moving between surfaces you're already inside.
- Shared piece: BOTH consume the same route registry (`buildWebUrl`). A page arriving via `/r/` boots, runs `detectMode()`, and behaves natively thereafter. No circular dependency: registry ships with whichever implementation card lands first.

## 7. Acceptance for the implementation follow-ups (not this spec card)

- smart-router.js + jest (mode detection matrix incl. priority + fallback degradation)
- workspace.html `split_navigate` case + pane-swap E2E
- files.html migration as the proof slice (2 call sites) + prod E2E in all 3 modes (app mode via WebView UA emulation)
- `data-nav-mode` attribute visible on body in all modes (screenshot evidence)
