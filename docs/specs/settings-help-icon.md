# Settings Help-Icon System — Spec

**Status:** Draft (child 1 of card_af9e8feee8282c1b7407a367)
**Authors:** #2 LOBSTER (Mac_C), #6 Codex (invariant proposal)
**Reviewers:** Hank (product), #6 (planner)
**Card:** `card_e5336dfba3950ff5ceb4c8bd`
**Parent:** `card_af9e8feee8282c1b7407a367`

## 1. Motivation

Settings pages today use inline labels and short hover hints. Weak inline copy ("實體一視同仁") misleads users about scope. The fix:
- Every labeled settings field gets a `?` help icon.
- Click reveals a popover with the canonical explanation.
- Help content is i18n'd across 16 locales (en + zh canonical + 14 fanout per §3.1).
- Code and i18n entries reference each other via a `HELP-KEY` annotation, enforced by a CI gate + i18n patrol cron.

## 2. UI Pattern

### 2.1 Icon
- Inline `?` (SVG, 16×16) immediately after the field label.
- Color: matches secondary text; hover bumps to primary.
- Tab-focusable (`tabindex="0"`, `role="button"`, `aria-label="Help"`).

### 2.2 Trigger
- **Click-only.** (Per Hank 2026-06-01 directive — unified desktop + mobile.)
- Hover does NOT open the popover.
- Same icon also opens on Enter or Space when focused.

### 2.3 Popover
- Positions snap to icon; default below-right.
- Viewport collision detection → auto-flip to opposite side.
- Max width 280px; multi-line wrap.
- Slide-in transition (200ms).
- Dismissed by: ESC, click outside, close button (×), Tab off (when focus trap exits).
- Focus trap while open: first focusable inside popover takes focus; Tab cycles inside.
- ESC restores focus to the icon.
- `aria-describedby` on the icon points to the popover's `id`; popover has `role="tooltip"`.

### 2.4 Markup contract

PR #3065 already implements the popover with a content-based attribute API (`data-help-content`/`data-help`). Settings pages MUST resolve the i18n key before binding the attribute, so the markup is rendered server-side OR via a template helper that wraps `i18n.get(key)`:

```html
<!-- Server-rendered or template-resolved -->
<label for="kanban_nudge_batch_size">
  <span data-i18n="kanban_nudge_batch_label">每次督促張數</span>
  <span class="help-icon"
        data-help-content="{{ i18n.get('kanban_nudge_batch_help') }}"
        tabindex="0"
        role="button"
        aria-label="Help"></span>
</label>
```

For JS-rendered settings, a thin convenience helper is added to PR #3065 (`HelpPopover.bindByKey(iconEl, key)` — resolves `i18n.get(key)` then calls existing `show(content, anchor, placement)` API on click). Consumers prefer `bindByKey` over manually resolving + calling `show`.

## 3. i18n Key Convention

For each labeled settings field with key `<field_key>`:
- `<field_key>_label` — short label (existing pattern).
- `<field_key>_help` — 1-3 sentence explanation (NEW). Must exist in every locale.

Underscore-suffix (not dot-suffix) chosen for compatibility with the flat-key style already used in `backend/public/shared/i18n.js`.

Example:
- `kanban_nudge_batch_label` (existing) — "每次督促張數"
- `kanban_nudge_batch_help` (new) — "每個 cron tick 整台裝置最多挑 N 張 L1 候選卡發提醒。跨實體共用這個額度，不是每個實體 N 張。L2/L3 升級不受此限。"

### 3.1 Locale set

**Authoritative source**: top-level locale keys in `backend/public/shared/i18n.js` (NOT Android `values-*/strings.xml` — those use different naming conventions like `zh-rTW`, `pt-rBR`, `in`).

Verified at 2026-06-01 09:30 TWT via combined grep (4-space-indented unquoted + quoted-anywhere). `"zh-CN"` is at column 0, not 4-space indent, which an earlier scan missed (caught here per #6's review):

| Locale | Form | Role |
|--------|------|------|
| `en` | unquoted, 4-space | Canonical base (handled in child 3) |
| `zh` | unquoted, 4-space | Canonical Traditional Chinese (handled in child 3) |
| `zh-TW` | quoted, 4-space | Thin override stub — publisher-guide only (≈41 keys); falls back through `zh` at runtime per `tests/jest/i18n-fallback-chain.test.js`. NOT a canonical injection target. |
| `zh-CN` | quoted, column 0 | Fanout (handled in child 6) |
| `ja`, `ko`, `th`, `vi`, `id`, `fr`, `es`, `de`, `pt`, `ms`, `hi`, `ar` | unquoted, 4-space | Fanout (12 locales — handled in child 6) |

**Count: 16 confirmed top-level locales** (en + zh canonical + 14 fanout: zh-CN, ja, ko, th, vi, id, fr, es, de, pt, ms, hi, ar, plus thin zh-TW override stub).

**Architectural note (added 2026-06-01 per Jest CI feedback):** the canonical pair is `en` + `zh`, not `en` + `zh-TW`. Spec round-1 said zh-TW, but `tests/jest/i18n-fallback-chain.test.js` hard-asserts `zh-TW` stays <50 keys (it's a publisher-guide-only override stub), and the i18n runtime resolves `zh-TW` → `zh` → `en`. Injecting canonical content into `zh` is therefore the right place. See memory `feedback_check_i18n_fallback_before_emergency`.

## 4. Bidirectional Code↔Doc Invariant

The system enforces TWO contracts via a `HELP-KEY` magic comment, validated by a CI gate (child 8) and the i18n patrol cron (child 7).

### 4.1 Annotation format
At every code site that renders or binds a settings field, place a nearby comment within the same source-code block (3-line window above the field's HTML/JSX/template):

```html
<!-- HELP-KEY: kanban_nudge_batch_help -->
<label for="kanban_nudge_batch_size">
  <span data-i18n="kanban_nudge_batch_label">每次督促張數</span>
  <span class="help-icon"
        data-help-content="{{ i18n.get('kanban_nudge_batch_help') }}"></span>
</label>
```

For JS-rendered fields (using PR #3065's helper wrapper per §5):
```js
// HELP-KEY: kanban_nudge_batch_help
HelpPopover.bindByKey(iconEl, 'kanban_nudge_batch_help');
```

### 4.2 Code → help invariant
- Every `HELP-KEY: <key>` annotation MUST point to a key that exists in `backend/public/shared/i18n.js` for both `en` and `zh` (the canonical pair — see §3.1 architectural note on why `zh`, not `zh-TW`). Missing → CI fail.
- Fanout locales are checked by the i18n patrol cron (warning-level, not hard-block). The soft layer is `node backend/scripts/i18n-check.js`: it reports settings-help gaps for non-canonical real locale blocks and keeps exit code 0 if EN references are otherwise valid. `zh-TW` is intentionally skipped here because it is a thin fallback stub; Traditional Chinese canonical coverage is enforced through `zh`.

### 4.3 Help → code invariant (SCOPED to settings-help keys)

The naive form ("every `<X>_help` key in `backend/public/shared/i18n.js` must have an annotation") is **too broad** — it would catch existing non-settings keys like `slash_cmd_help` and false-fail CI. Scope is required.

**Scoping mechanism**: child 3 (Backend inventory) MUST produce a `settings-help-keys.json` artifact (or equivalent generated registry) listing exactly the keys that are settings-help-icon copy. The orphan invariant runs ONLY against that set:
- Every key in `settings-help-keys.json` MUST have ≥1 `HELP-KEY: <key>` annotation in the codebase. Missing → CI fail.
- Keys NOT in `settings-help-keys.json` are ignored (existing non-settings `_help` keys like `slash_cmd_help` are unaffected).

The registry is GENERATED by child 3's inventory script, NOT hand-edited, so it stays in sync with the actual settings inventory and can be re-generated as new fields are added. Child 7 (cron soft warning) re-runs the inventory generator periodically and auto-files cards if the registry drifts from the actual settings DOM.

This is a thin compromise on §4.4 (annotations-first) — the registry is purely derived from the actual settings codebase, not a separate source of truth.

### 4.4 Tooling preference
- **Annotations-first** (this design): scan code for `HELP-KEY:` comments via grep, build the set at CI time, compare against i18n keys.
- **Hand-edited registry** (rejected for v1): explicit registry file would add another point of drift.

Per #6 spike (`card_7b563f51b8f00ca4c72dfdbe`), grep-based scan is feasible on the current codebase; the 1.3M-line `backend/public/shared/i18n.js` is the only perf concern, and a key-extraction script (per-key one-liner) is fast enough.

## 5. Component API

`backend/public/shared/help-popover.js` (delivered in PR #3065 by #4) exposes a **content-based** API:
- `HelpPopover.show(content, anchor, placement)` — open the popover with raw content text at `anchor` element.
- `HelpPopover.hide()` — close any open popover.
- `HelpPopover.isOpen()` — function returning bool.
- Auto-init on `DOMContentLoaded`: every `.help-icon` gets click handlers that read `icon.dataset.helpContent || icon.dataset.help`.

To bridge the content-based component API to this spec's key-based markup (§2.4), PR #3065 SHALL ALSO export a convenience wrapper:
- `HelpPopover.bindByKey(iconEl, key)` — attach click handler that resolves `i18n.get(key)` then calls `show(content, iconEl, "auto")`.

This keeps the existing content-based core for legacy callers AND lets settings pages use the key-based markup the rest of the spec assumes. The wrapper is the recommended path for all new settings consumers; raw `data-help-content` remains supported for non-settings call sites.

## 6. Acceptance

Spec is accepted when:
- [ ] This document merged to main.
- [ ] #6 sign-off on the bidirectional invariant section (§4).
- [ ] Section 2.4 markup contract reviewed against #4's `help-popover.js` PR #3065 — confirm `data-help-content` is the attribute name the component reads AND that PR #3065 adds the `HelpPopover.bindByKey(iconEl, key)` wrapper per §5.
- [ ] Child 3 (Backend inventory) can begin once §3 (key convention) is locked.
- [ ] Child 6 (i18n fanout) can begin once §3.1 (locale set) is locked.
- [ ] Child 7 (cron soft warning) can implement §4 rules.
- [ ] Child 8 (CI hard gate) can implement §4 rules.

## 7. Out of Scope (not this spec)

- Per-field migration order (which fields get `?` icon first) — covered by child 3 inventory.
- The actual help copy for each field — child 3 deliverable.
- Translation of help copy to the 14 fanout locales — child 6.
- Hand-edited registry file (deferred per §4.4).
- Settings page UI redesign beyond `?` icon placement.

## 8. Change Log

- 2026-06-01 09:10 TWT — Draft v1 (`#2` author, parent card_af9e8feee8282c1b7407a367).
- 2026-06-01 09:20 TWT — §3.1 locale set amended after #6 review: removed Android-style names, confirmed 14 top-level backend i18n.js locales.
- 2026-06-01 09:27 TWT — Round-2 amendments after #6's §4 review:
  - §2.4 markup contract rewritten to match PR #3065's actual content-based API (`data-help-content`); template-resolved i18n.get pattern + helper wrapper.
  - §4.2: `zh-rTW` → `zh-TW`, fanout count corrected to 12.
  - §4.3: scoped orphan check to a generated `settings-help-keys.json` registry (produced by child 3), so existing non-settings `_help` keys like `slash_cmd_help` are not false-failed.
  - §5: re-baselined to PR #3065's actual API surface; added `bindByKey(iconEl, key)` wrapper requirement.
- 2026-06-01 09:31 TWT — Round-3 amendments after #6's second review (CHANGES REQUESTED on f8fe488):
  - §3.1: locale list amended to 16 — `"zh-CN"` is at column 0 indent (not 4-space), which earlier scans missed. Fanout count corrected to 14.
  - §4.1: code examples updated to match PR #3065's content-based API (`data-help-content` not `data-help-key`/`data-help-content-key`), and JS example uses `HelpPopover.bindByKey` per §5.
  - §4.2: fanout count text "12 other top-level locales" → "14 other top-level locales".
  - §7: "16 fanout locales" → "14 fanout locales".
- 2026-06-01 17:59 TWT — Child 7 soft-warning SOP clarified:
  - §4.2 names `backend/scripts/i18n-check.js` as the patrol layer for settings-help fanout gaps.
  - `zh-TW` is explicitly skipped by the soft warning because it is a fallback stub, not a fanout injection target.
  - Fanout gaps are warning-only and must not change the checker exit code.
