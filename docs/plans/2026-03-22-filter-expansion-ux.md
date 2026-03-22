# Filter Chip Expansion UX Design

## Problem
The chat filter chips in `chat.html` use `flex-wrap: wrap`, so as entities accumulate (14+ chips in the screenshot), they stack into 4+ rows and squeeze the chat content area significantly.

## Design: Collapsed by Default, Expandable on Tap

### Behavior
1. **Collapsed state** (default): Show only the **first row** of chips (whatever fits in one line), with a `▼ +N` toggle button at the end showing how many chips are hidden.
2. **Expanded state**: Show all chips with `flex-wrap: wrap` (current behavior), with a `▲` collapse toggle button at the end.
3. **Active chip always visible**: If the user selects a chip that's in the hidden overflow, auto-scroll/move it into the visible row OR auto-expand.
4. The expand/collapse state persists during the session (not across page reloads).

### Visual Design
- Toggle button styled as a chip: same border-radius, padding, but with a subtle different background (e.g., `var(--card)` with dashed border).
- Collapsed: `overflow: hidden; max-height: <single-row-height>; flex-wrap: wrap;` — clips to one row.
- Expanded: `max-height: none;`
- Smooth CSS transition on `max-height`.

### Implementation (chat.html only — Android uses WebView)

#### CSS Changes
```css
.chip-group {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    overflow: hidden;
    max-height: 34px; /* ~single row height */
    transition: max-height 0.25s ease;
    position: relative;
}

.chip-group.expanded {
    max-height: 500px; /* large enough for any number of rows */
}

.filter-chip-toggle {
    /* same base styling as .filter-chip but distinct */
    padding: 5px 10px;
    border-radius: 20px;
    font-size: 12px;
    cursor: pointer;
    background: var(--card);
    border: 1px dashed var(--card-border);
    color: var(--text-secondary);
    white-space: nowrap;
    user-select: none;
    transition: all 0.2s;
}

.filter-chip-toggle:hover {
    border-color: var(--primary);
    color: var(--primary);
}
```

#### HTML Changes
Add toggle chip as last child of `#filterChips`:
```html
<span class="filter-chip-toggle" id="filterToggle" onclick="toggleFilterExpand()" style="display:none;">▼</span>
```

#### JS Changes
1. `updateFilterToggle()` — called after `renderFilterChips()`:
   - Count total chips vs chips visible in first row (compare chip offsetTop values)
   - If overflow exists: show toggle button with `▼ +N` label
   - If no overflow: hide toggle button
2. `toggleFilterExpand()`:
   - Toggle `.expanded` class on `.chip-group`
   - Update toggle button label: `▲` when expanded, `▼ +N` when collapsed
3. When active filter chip is in overflow: auto-expand the chip group.
4. On window resize: recalculate overflow.

### i18n
- New key `chat_filter_more`: "+{n} more" (and translations for all 8 languages)
- Toggle doesn't need i18n (uses `▼`/`▲` Unicode arrows + number)

### Files Changed
1. `backend/public/portal/chat.html` — CSS, HTML, JS
2. `backend/public/shared/i18n.js` — new i18n keys (8 languages)

### iOS / Android
- **Android**: Uses WebView loading `chat.html`, so this fix applies automatically.
- **iOS**: `ios-app/app/chat/` — Chat screen uses different rendering; iOS doesn't have entity filter chips in chat, so no change needed.

### Edge Cases
- 0-2 entity chips (single row naturally): toggle hidden, no behavior change
- Selected chip is in overflow: auto-expand on selection
- Window resize: recalculate on resize event
- Responsive (≤640px): smaller chip padding already handled; single-row height adjusted accordingly
