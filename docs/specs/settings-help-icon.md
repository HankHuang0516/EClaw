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
- Help content is i18n'd across 17 locales.
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
```html
<label for="kanban_nudge_batch_size" data-help-key="kanban_nudge_batch_help">
  <span data-i18n="kanban_nudge_batch_label">每次督促張數</span>
  <span class="help-icon"
        data-help-content-key="kanban_nudge_batch_help"
        tabindex="0"
        role="button"
        aria-label="Help"></span>
</label>
```
The `data-help-content-key` attribute is the bridge to i18n; the `help-popover.js` component reads it, looks up `i18n.get("kanban_nudge_batch_help")`, and renders.

## 3. i18n Key Convention

For each labeled settings field with key `<field_key>`:
- `<field_key>_label` — short label (existing pattern).
- `<field_key>_help` — 1-3 sentence explanation (NEW). Must exist in every locale.

Underscore-suffix (not dot-suffix) chosen for compatibility with the flat-key style already used in `backend/public/shared/i18n.js`.

Example:
- `kanban_nudge_batch_label` (existing) — "每次督促張數"
- `kanban_nudge_batch_help` (new) — "每個 cron tick 整台裝置最多挑 N 張 L1 候選卡發提醒。跨實體共用這個額度，不是每個實體 N 張。L2/L3 升級不受此限。"

### 3.1 Locale set
17 locales:
- Canonical (handled in child 3): `en` (base), `zh-rTW`
- Fanout (handled in child 6): `ar`, `de`, `es`, `fr`, `hi`, `id`, `in`, `it`, `ja`, `ko`, `ms`, `pt-rBR`, `ru`, `th`, `vi`, `zh-rCN` (16)

## 4. Bidirectional Code↔Doc Invariant

The system enforces TWO contracts via a `HELP-KEY` magic comment, validated by a CI gate (child 8) and the i18n patrol cron (child 7).

### 4.1 Annotation format
At every code site that renders or binds a settings field, place a nearby comment within the same source-code block (3-line window above the field's HTML/JSX/template):

```html
<!-- HELP-KEY: kanban_nudge_batch_help -->
<label for="kanban_nudge_batch_size" data-help-key="kanban_nudge_batch_help">
  ...
</label>
```

For JS-rendered fields:
```js
// HELP-KEY: kanban_nudge_batch_help
const el = h('span', { 'data-help-content-key': 'kanban_nudge_batch_help' });
```

### 4.2 Code → help invariant
- Every `HELP-KEY: <key>` annotation MUST point to a key that exists in `backend/public/shared/i18n.js` for both `en` and `zh-rTW` (the canonical pair). Missing → CI fail.
- Fanout locales (the other 16) are checked by the patrol cron (warning-level, not hard-block).

### 4.3 Help → code invariant
- Every `<X>_help` key in `backend/public/shared/i18n.js` MUST have ≥1 `HELP-KEY: <X>_help` annotation in the codebase. Missing → CI fail (key orphaned).
- The patrol cron repeats this check periodically and auto-files cards for drift.

### 4.4 Tooling preference
- **Annotations-first** (this design): scan code for `HELP-KEY:` comments via grep, build the set at CI time, compare against i18n keys.
- **Hand-edited registry** (rejected for v1): explicit registry file would add another point of drift.

Per #6 spike (`card_7b563f51b8f00ca4c72dfdbe`), grep-based scan is feasible on the current codebase; the 1.3M-line `backend/public/shared/i18n.js` is the only perf concern, and a key-extraction script (per-key one-liner) is fast enough.

## 5. Component API

`backend/public/shared/help-popover.js` (delivered in PR #3065 by #4):
- `HelpPopover.show(iconEl)` — open the popover for a given `<span class="help-icon">`.
- `HelpPopover.hide()` — close any open popover.
- `HelpPopover.isOpen` — bool.
- Auto-init on `DOMContentLoaded`: every `.help-icon` gets click handlers.
- Popover content sourced from `iconEl.dataset.helpContentKey` → `i18n.get(key)`.

## 6. Acceptance

Spec is accepted when:
- [ ] This document merged to main.
- [ ] #6 sign-off on the bidirectional invariant section (§4).
- [ ] Section 2.4 markup contract reviewed against #4's `help-popover.js` PR #3065 — confirm `data-help-content-key` is the attribute name the component reads.
- [ ] Child 3 (Backend inventory) can begin once §3 (key convention) is locked.
- [ ] Child 6 (i18n fanout) can begin once §3.1 (locale set) is locked.
- [ ] Child 7 (cron soft warning) can implement §4 rules.
- [ ] Child 8 (CI hard gate) can implement §4 rules.

## 7. Out of Scope (not this spec)

- Per-field migration order (which fields get `?` icon first) — covered by child 3 inventory.
- The actual help copy for each field — child 3 deliverable.
- Translation of help copy to 16 fanout locales — child 6.
- Hand-edited registry file (deferred per §4.4).
- Settings page UI redesign beyond `?` icon placement.

## 8. Change Log

- 2026-06-01 09:10 TWT — Draft v1 (`#2` author, parent card_af9e8feee8282c1b7407a367).
