# Mission Page Folder/Category Structure - Implementation Plan

## Overview
Add collapsible category folders to all 7 Mission sections (TODO, Mission, Done, Notes, Skills, Souls, Rules), enabling structured grouping with drag-to-recategorize, rename, clear, and delete operations.

## Data Model Changes

### JSONB Structure (No DB Schema Change)
Add `category` field to each item type + `categoryOrder`/`categoryState` to dashboard:

```javascript
// Each item gets a `category` field (null = uncategorized)
{ id, title, category: "Frontend", ... }

// Dashboard-level metadata
{
  categoryOrder: {
    todo: ["Frontend", "Backend", "DevOps"],
    mission: ["Sprint 1"],
    done: [],
    notes: ["Meeting", "Tech"],
    skills: ["Core", "Tools"],
    souls: [],
    rules: ["Workflow"]
  },
  categoryState: {
    "todo:Frontend": true,    // expanded
    "todo:Backend": false,    // collapsed
  }
}
```

Notes already have `category` field - just leverage it.

## Implementation Steps

### Step 1: Backend (mission.js)
- Bot APIs: Add `category` param to add/update endpoints for todo, note, skill, soul, rule
- `POST /todo/add` — accept `category`
- `POST /todo/update` — accept `newCategory`
- `POST /note/add` — already has `category`, no change
- `POST /note/update` — accept `newCategory`
- `POST /skill/add` — accept `category`
- `POST /skill/update` (new) — accept `newCategory`
- `POST /soul/add` — accept `category`
- `POST /soul/update` — accept `newCategory`
- `POST /rule/add` — accept `category`
- `POST /rule/update` — accept `newCategory`
- GET /dashboard — preserve `categoryOrder` and `categoryState` in dashboard JSONB

### Step 2: Web Portal (mission.html)
1. **Category grouping in render functions**: Group items by `category`, render collapsible folders
2. **Category header UI**: Folder icon + name + count + expand/collapse toggle + rename/clear/delete buttons
3. **Add Category dialog**: Per-section "+" folder button
4. **Rename Category**: Click category name to inline-edit
5. **Delete Category**: Move items to uncategorized, remove from categoryOrder
6. **Clear Category**: Delete all items in category (with confirmation)
7. **Drag-and-drop**: HTML5 drag API to move items between categories
8. **Add/Edit dialogs**: Add category dropdown to all item add/edit dialogs
9. **Persist expand/collapse state**: Save categoryState on toggle
10. **i18n**: Add keys for all new UI strings

### Step 3: i18n Keys
Add to `i18n.js`:
- `mc_add_category`, `mc_rename_category`, `mc_delete_category`, `mc_clear_category`
- `mc_uncategorized`, `mc_confirm_clear_category`, `mc_confirm_delete_category`
- `mc_drag_hint`, `mc_expand_all`, `mc_collapse_all`

### Step 4: Tests
- Jest test for category in bot API endpoints
- Integration test for category CRUD lifecycle

### Step 5: Simplify Skill Review
- Run simplify skill on all changed UI code before commit

## Files to Modify
1. `backend/mission.js` — Bot API category support
2. `backend/public/portal/mission.html` — UI rendering + drag-drop
3. `backend/public/shared/i18n.js` — New i18n keys
4. `backend/tests/jest/mission.test.js` — Category test cases

## Scope Exclusions (Phase 2)
- Android/iOS category UI (separate task)
- Nested sub-categories
- Category color labels
- Category templates
