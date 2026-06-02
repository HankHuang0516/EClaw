# Spec: Chat page filter bar — summary-chip + expand/collapse panel

**Status:** Draft — awaiting #6 UIUX sign-off
**Card:** `card_11776d156c2bfd9c92ee81bf` (P1, opened 2026-06-02 08:32 TW)
**Driver:** Hank web_chat 2026-06-02 08:32 TW — 「開卡把聊天頁面的過濾欄位增加風格一致的展開收合UX」
**Author:** #2 (LOBSTER)

---

## 1. Problem statement

Today `portal/chat.html` stacks **two** filter rows directly above the message area:

```
[ All ] [ Entity A ] [ Entity B ] … [ My Messages ]        ←  #filterChips  (entity / scope)
[ 💬 對話 ] [ 📋 看板 ] [ ⏰ 排程 ] [ 🔧 系統 ] [ ❤️ 健康 ]      ←  #systemFilterChips (smart filter)
```

On desktop the rows wrap; on mobile each row is a horizontal scroll with a fade-out + `#filterToggle` overflow indicator. Together they occupy ~96px of vertical space on mobile (≈11% of a 390×844 viewport) just to expose controls the user touches rarely after the first read.

User pain reported by Hank: 「目前看起來散亂」. Concrete UX failures:

- **No information hiding:** the second row of system-category chips is always visible even when defaults are active (3 of 5 chips on).
- **No state-at-a-glance:** when the user has a non-default filter selected (e.g. "kanban only"), nothing in the collapsed UI tells them the message stream is filtered — they have to scan the chip row to remember.
- **No precedent to copy:** `portal/kanban.html` uses a flat `.kb-filter-chips` row; `portal/mission.html` and `portal/info.html` don't have filter bars in this shape. So Hank's request "與其他頁面一致" actually means "**introduce** a shared pattern that chat needs first, and other pages can adopt later" — not "copy an existing one." This spec calls that out so we don't paint ourselves into a corner.

### 1.1 Why now

PR #3086 (smart-filter system messages, merged 2026-06-01) added the second chip row but kept the always-visible layout — Hank flagged the "散亂" feeling the next morning. The cost of fixing the pattern grows the longer it lives: every subsequent FE page picks up the inconsistency.

---

## 2. Proposal

Introduce a **summary-chip + popover panel** primitive in `backend/public/shared/` so chat is the first adopter and other pages can switch over without re-implementing the JS / styling.

### 2.1 Collapsed state (default)

```
┌──────────────────────────────────────────────┐
│ 🔽 過濾條件 (3)                              │  ←  summary chip — single 36px row
└──────────────────────────────────────────────┘
```

- One row, ≈36px tall on mobile / 32px on desktop.
- Displays the number of **non-default** filter selections (entity selection plus any toggled-off system category).
- `(3)` text comes from `data-i18n="chat_filter_summary_count"` so locales can render it idiomatically.
- Clicking / tapping opens the expanded panel.
- Long-press on mobile opens the panel and announces it via `aria-live` for screen readers.

### 2.2 Expanded state (panel)

```
┌──────────────────────────────────────────────┐
│ 過濾條件                              [ ✕ ] │
├──────────────────────────────────────────────┤
│  Scope                                      │
│  ◉ All   ○ My Messages                      │
│                                              │
│  Entity                                     │
│  [ All ] [ Entity A ] [ Entity B ] …        │
│                                              │
│  System messages                            │
│  ☑ 💬 對話   ☑ 📋 看板   ☑ ⏰ 排程             │
│  ☐ 🔧 系統   ☐ ❤️ 健康                        │
└──────────────────────────────────────────────┘
```

- Panel is a flyout / popover anchored under the summary chip, not a full-screen modal. Width = container width on mobile; max-content on desktop.
- Dismiss: click the `✕`, click outside the panel, or press Esc.
- Each filter group keeps its current input shape — we're regrouping, not redesigning the individual controls.
- Re-using the existing `.filter-chip` / `.sys-chip` classes; only the wrapper + summary primitive are new.

### 2.3 Shared primitive

New file `backend/public/shared/filter-summary.js` (+ `filter-summary.css`) exports:

```js
function createFilterSummary({
  anchorEl,        // where to mount the summary chip
  panelContent,    // function or HTML that builds the expanded panel
  countActive,     // function returning the number of non-default selections
  i18nKey,         // base key, e.g. "chat_filter"
  onOpen, onClose, // optional callbacks
});
```

Chat is the first caller; kanban / mission can adopt later by passing their own `panelContent` / `countActive`.

### 2.4 Mobile / desktop

| Viewport | Summary chip | Panel anchoring |
|---|---|---|
| Mobile 390×844 | Full container width, 36px | Bottom-anchored bottom-sheet, slides up; covers ~50% of viewport |
| Desktop 1280×800 | Auto-width, 32px | Dropdown popover under the chip, max-width 480px |

Mobile reuses the existing `.scroll-to-bottom-btn` z-index layer; popover uses the `.dialog-overlay` z-index used by `showConfirm` for consistency with PR #3088's modal stack.

---

## 3. Acceptance

### 3.1 UX

- [ ] Summary chip is the only visible filter row in the default state.
- [ ] Summary chip shows the **active filter count** matching what's actually applied to the message stream.
- [ ] Tapping the chip opens the panel; tapping outside or pressing Esc closes it.
- [ ] The `✕` button receives default focus when the panel opens (per PR #3088 destructive-confirm pattern — safe default focus on dismiss).
- [ ] Long-press on mobile opens the panel and announces `aria-live="polite"`.

### 3.2 Visual

- [ ] Web (1280×800) and Mobile (390×844) before / after screenshots attached to the implementation PR.
- [ ] Dark-mode contrast unchanged (use existing CSS variables `--card-border`, `--bg`, etc.).
- [ ] Reduced motion: no slide animation when `prefers-reduced-motion: reduce`.

### 3.3 i18n

- [ ] `chat_filter_summary_label` (e.g. "過濾條件" / "Filters" / "フィルター" / …) — all locales in `backend/public/shared/i18n.js`.
- [ ] `chat_filter_summary_count` with placeholder substitution (e.g. `"Filters ({n})"`).
- [ ] `chat_filter_summary_close` aria label.
- [ ] All existing chip labels keep their current keys — no churn there.
- [ ] Locales covered (matching project memory `feedback_i18n_translate_not_passthrough` — every locale gets a locale-appropriate translation, not English passed through): zh-TW, zh, en, ja, ko, es, pt, fr, de, it, vi, th, id.

### 3.4 Tests

- [ ] Static jest invariant test (same pattern as PR #3088's `showConfirm-danger-default-focus.test.js`) locking the summary chip markup + click-out / Esc handler + the count-callback wiring against silent regression.
- [ ] Manual screenshot diff for both viewports in the implementation PR description.

---

## 4. Non-goals (v1)

- **Other pages** don't switch yet. The primitive is built shareable; chat adopts first; kanban / mission / community migrations are tracked separately so they don't block this PR.
- **No filter persistence across sessions** beyond what currently exists. Today the chat filter state is in-memory only; this spec doesn't change that.
- **No new filter types** (date range, full-text search, etc.). Those are out of scope.
- **No "applied / pending" distinction.** The panel applies filters immediately on toggle, same as today.
- **No keyboard chord shortcut** to open the panel (e.g. `/`). Could be added later if a usage signal warrants it.

---

## 5. Open questions for #6 review

1. **Should the summary chip live above the messages area (current proposal) or pin to the bottom near `#scrollToBottomBtn`?**
   - Bottom-pinning saves the top 36px for the message stream but breaks "filter is part of the header" intuition. I lean top.
2. **Panel-open animation on mobile: slide-up bottom-sheet or fade-in popover?**
   - Slide-up matches iOS native action sheets; fade-in is faster on Android. Either works.
3. **Should we keep the always-visible `[ All ] [ My Messages ]` scope toggle as a peer to the summary chip, instead of folding it into the panel?**
   - Hank uses these constantly; hiding them behind a click adds friction. Worth weighing.
4. **`#filterToggle` overflow indicator (the existing entity-chip fade-out) — keep its semantics inside the panel, or drop it (entity list is now panel-vertical)?**
   - I lean drop on the assumption the panel can grow vertically with scrolling on mobile.
5. **Should the count include the system-message smart-filter toggles?**
   - "Filters (3)" reading 1 entity + 2 toggled-off categories is mathematically right but UX-ambiguous. Maybe split into "Filters (1) · Hidden (2)"?
6. **Do we want a "Reset filters" link inside the panel?**
   - Cheap to add; covers the "I clicked something and don't remember what" case.

---

## 6. Rollback

The primitive is gated behind a single import in chat.html; reverting the integration commit removes the summary chip and restores the original two-row layout. No DB or backend changes; no data migration.

---

## 7. References

- Card `card_11776d156c2bfd9c92ee81bf` (P1) — driver.
- PR #3088 (`fix(portal): safe-default-focus on destructive confirm dialogs`) — reuse the same focus-management primitive for the panel's `✕` button.
- PR #3086 (smart-filter for system messages) — added the second chip row that motivated this cleanup.
- `backend/public/portal/chat.html` lines 2912–2930 — current filter bar markup.
- Project memory `feedback_i18n_translate_not_passthrough` — locale handling expectations.
- Project memory `feedback_rendering_cards_screenshot_review` — `requiresScreenshotReview=true` on this card.
