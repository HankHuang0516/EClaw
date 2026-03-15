# EClaw UIUX Audit Report — 2026-03-14

## Executive Summary

Comprehensive UIUX audit across Web Portal (5 pages) and Android App (12+ layouts). Found **no critical functionality bugs**, but identified significant **design system fragmentation** and **accessibility gaps**.

| Platform | Critical | High | Medium | Low |
|----------|----------|------|--------|-----|
| Web Portal | 2 | 6 | 8 | 4 |
| Android App | 0 | 3 | 20+ | 5 |

---

## Web Portal Findings

### Critical

1. **Hardcoded colors everywhere** — 200+ hardcoded hex values across all 5 portal pages, despite CSS variables being defined in `shared/style.css`. Makes theming impossible.
   - dashboard.html: channel badge `#1a3a2a/#4ade80/#2d6a4a`, XP bar `#FFD700`, cyan accent `#4FC3F7`
   - chat.html: platform message colors `#eef2ff/#334155`, reaction colors `#4CAF50/#F44336`
   - mission.html: success color `#4caf50`, hover `#2E2E50`

2. **chat.html platform message colors** — Lines 156-170 use hardcoded light/dark color sets instead of CSS variables.

### High

1. **Touch targets < 44px** — Language selector (padding 4px 8px), edit mode button, remove file button (22x22px), checkbox (14x14px)
2. **Zero aria-labels** on interactive elements; onclick handlers on non-button `<div>` elements (dashboard.html lines 951, 976, 1014, 1021)
3. **Reaction colors not colorblind-safe** — chat.html uses `#4CAF50` (green) / `#F44336` (red) without patterns
4. **Entity label colors untested** — chat.html `#FF6B6B`, `#FFB6C1` on dark bg, no contrast verification
5. **Inline dialog styles** — dashboard.html line 1070 uses `rgba(33,150,243,...)` inline
6. **Beta badge gradient** — dashboard.html `#FF6B35, #FF9F1C` with no fallback

### Medium

- OAuth buttons missing `aria-label` (index.html)
- Form inputs missing `autocomplete` attributes
- Only one breakpoint (640px) — no 480px mobile rules
- No visible `:focus` styles for keyboard navigation
- Inconsistent CSS variable fallbacks
- Voice button styling differs between sent/received (chat.html)
- Entity checkbox grid not responsive (mission.html)
- Recording indicator `#ff4444` duplicated inline (chat.html)

---

## Android App Findings

### High

1. **Touch targets < 48dp** — Multiple ImageButtons at 40x40dp (ai_chat back/attach/clear, entity_manager back, main edit mode). Voice play button 32dp, reaction buttons 28dp. Send button 44dp.
2. **Missing contentDescription** — ImageView in activity_main.xml (expand arrow), mission_control (schedule icon), message items (link preview), ai_chat (multiple)
3. **No dark mode support** — `values-night/` directory missing. Theme uses Material3.DayNight parent but no custom night colors defined.

### Medium (20+)

- **16+ hardcoded hex colors** in XML layouts: `#000000` backgrounds (feedback, crash_log, privacy_policy), `#222222` (message), `#FF5722` (chat timer), `#4FC3F7` (agent card), etc.
- **dimens.xml has only 1 entry** (`chat_input_section_height`) — no standardized spacing/sizing system
- **Excessive LinearLayout nesting** — feedback.xml has 31 LinearLayouts; should use ConstraintLayout
- **RecyclerView inside NestedScrollView** in mission_control — scroll conflicts
- **Inconsistent avatar/icon sizes** — 20dp, 28dp, 32dp, 36dp, 56dp scattered without dimen references
- **Color contrast concerns** — `text_disabled` #666666 on `surface_dim` #0D0D1A may fail WCAG AA

### Low

- ImageButton should migrate to Material3 IconButton
- Missing standard dimen definitions (icon sizes, button heights, standard margins)
- Minor styling inconsistencies across item layouts

---

## Priority Fix Plan

### P0 — Immediate (Accessibility)
- [ ] Web: Add `aria-label` to all interactive elements
- [ ] Web: Increase all touch targets to minimum 44x44px
- [ ] Android: Increase all touch targets to minimum 48x48dp
- [ ] Android: Add `contentDescription` to all ImageView/ImageButton

### P1 — Short-term (Design System)
- [ ] Web: Extract hardcoded colors to CSS variables
- [ ] Android: Extract hardcoded colors to `colors.xml`
- [ ] Android: Create `values-night/colors.xml` for dark mode
- [ ] Android: Expand `dimens.xml` with standard values
- [ ] Web: Add `@media (max-width: 480px)` rules

### P2 — Medium-term (Code Quality)
- [ ] Web: Add visible `:focus` styles
- [ ] Web: Add `autocomplete` to form inputs
- [ ] Android: Refactor nested LinearLayouts to ConstraintLayout
- [ ] Android: Fix RecyclerView-in-NestedScrollView conflicts
- [ ] Both: Verify WCAG AA contrast ratios

### P3 — Long-term (Polish)
- [ ] Android: Migrate to Material3 IconButton
- [ ] Web: Document design tokens
- [ ] Both: Colorblind-safe color patterns for status indicators
