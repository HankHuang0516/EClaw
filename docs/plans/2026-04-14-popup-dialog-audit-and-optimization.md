# EClaw Portal — Legacy Popup Dialog Audit & Optimization Plan

> Date: 2026-04-14
> Auditor: #2 (Mac_ClaudeAce)
> Method: Static code analysis (grep) + Playwright MCP dynamic verification
> Scope: All `*.html` files under `backend/public/`

---

## Executive Summary

The EClaw Portal currently uses **64 native browser dialogs** (`alert()`, `confirm()`, `prompt()`) across 15 HTML files. These are disruptive to UX — they block the main thread, cannot be styled, break i18n consistency, and are increasingly suppressed by modern browsers.

The portal already has two reusable patterns to replace them:
1. **`showToast(message, type)`** in `portal/shared/api.js` — for notifications
2. **`.dialog-overlay`** CSS class in `portal/shared/style.css` — for modal dialogs

---

## Audit Results

| File | `alert()` | `confirm()` | `prompt()` | Total | Priority |
|------|-----------|-------------|------------|-------|----------|
| portal/mission.html | 0 | 12 | 2 | **14** | P1 |
| portal/admin.html | 6 | 3 | 0 | **9** | P2 |
| portal/my-rentals.html | 6 | 0 | 0 | **6** | P1 |
| portal/card-holder.html | 0 | 5 | 1 | **6** | P2 |
| portal/community.html | 5 | 0 | 0 | **5** | P1 |
| arena/exam.html | 4 | 0 | 0 | **4** | P3 |
| portal/files.html | 0 | 2 | 2 | **4** | P2 |
| portal/invite.html | 3 | 0 | 0 | **3** | P3 |
| portal/settings.html | 2 | 1 | 0 | **3** | P2 |
| portal/dashboard.html | 0 | 2 | 0 | **2** | P2 |
| arena/index.html | 2 | 0 | 0 | **2** | P3 |
| portal/share-chat.html | 2 | 0 | 0 | **2** | P3 |
| portal/chat.html | 0 | 2 | 0 | **2** | P2 |
| portal/kanban.html | 0 | 1 | 0 | **1** | P3 |
| portal/env-vars.html | 0 | 1 | 0 | **1** | P3 |
| **TOTAL** | **30** | **29** | **5** | **64** | |

---

## Dialog Categories & Replacement Strategy

### 1. `alert()` → `showToast()` (30 instances)

These are pure notification messages (success, error, info). Direct replacement with existing `showToast()`.

**Pattern:**
```js
// BEFORE
alert('Review submitted!');

// AFTER
showToast(tt('mr_review_submitted', 'Review submitted!'), 'success');
```

**Categorization:**
| Type | Count | Example |
|------|-------|---------|
| Success feedback | 8 | "Review submitted!", "Dispute filed!", "Code redeemed!" |
| Error messages | 18 | "Failed", "Error: ...", "請先登入才能留言" |
| Validation warnings | 4 | "Submit to leaderboard first", "Please select a rating" |

**Effort:** Low — direct 1:1 replacement, `showToast()` already exists.

### 2. `confirm()` → Custom Confirm Modal (29 instances)

These require user decision (Yes/No). Need a reusable `showConfirm()` component.

**Pattern:**
```js
// BEFORE
if (!confirm(i18n.t('mc_confirm_delete'))) return;

// AFTER
const ok = await showConfirm({
    title: i18n.t('mc_confirm_delete_title'),
    message: i18n.t('mc_confirm_delete'),
    confirmText: i18n.t('yes'),
    cancelText: i18n.t('cancel'),
    danger: true
});
if (!ok) return;
```

**Categorization:**
| Type | Count | Files |
|------|-------|-------|
| Delete confirmation | 18 | mission (12), files (2), chat (1), dashboard (2), settings (1) |
| Destructive action | 8 | card-holder (5), admin (3) |
| Version mismatch | 1 | mission (1) |
| Automation delete | 1 | kanban (1) |
| Env var delete | 1 | env-vars (1) |

**Effort:** Medium — requires new `showConfirm()` utility + convert all callers to `async/await`.

### 3. `prompt()` → Custom Input Modal (5 instances)

These request text input from the user. Need a reusable `showPrompt()` component.

**Pattern:**
```js
// BEFORE
const name = prompt(i18n.t('mc_prompt_category_name'));

// AFTER
const name = await showPrompt({
    title: i18n.t('mc_prompt_category_name'),
    placeholder: 'e.g. Work, Personal',
    confirmText: i18n.t('create'),
});
```

**Instances:**
| File | Usage |
|------|-------|
| mission.html | Category name input, Rename category |
| files.html | Folder name input, Move to folder selection |
| card-holder.html | Friend request message |

**Effort:** Medium — requires new `showPrompt()` utility.

---

## Proposed Implementation

### Phase 1: Shared Dialog Components (in `portal/shared/api.js`)

Add two new utility functions alongside existing `showToast()`:

```js
// Confirm dialog — returns Promise<boolean>
function showConfirm({ title, message, confirmText, cancelText, danger }) { ... }

// Prompt dialog — returns Promise<string|null>
function showPrompt({ title, message, placeholder, defaultValue, confirmText }) { ... }
```

Both should:
- Use the existing `.dialog-overlay` CSS pattern
- Support i18n via `data-i18n` attributes
- Support keyboard navigation (Enter = confirm, Escape = cancel)
- Be non-blocking (Promise-based)
- Support `danger` mode (red confirm button) for destructive actions
- Auto-focus the confirm button (or input field for prompt)
- Animate in/out with CSS transitions

### Phase 2: Migration Order (by priority)

| Phase | Files | Instances | Rationale |
|-------|-------|-----------|-----------|
| 2a | community.html, my-rentals.html | 11 | Rental flow — highest user visibility |
| 2b | mission.html | 14 | Most instances, core workflow |
| 2c | dashboard.html, settings.html, card-holder.html | 11 | Secondary pages |
| 2d | files.html, chat.html, admin.html | 9 | Internal/power-user pages |
| 2e | arena/, invite.html, share-chat.html, kanban.html, env-vars.html | 10 | Low-traffic pages |

### Phase 3: CSS Enhancement

Add to `portal/shared/style.css`:
```css
/* Confirm/Prompt dialog */
.confirm-dialog { ... }  /* Styled like existing .dialog-overlay */
.confirm-dialog.danger .btn-confirm { background: var(--error); }
.confirm-dialog .input-field { ... }  /* For prompt mode */
```

---

## Playwright MCP Verification Notes

Dynamic testing with Playwright confirmed:
- **Login flow**: Works correctly, redirects to dashboard.html
- **Dashboard**: Found 4 delete buttons using `confirmRemove()` with `confirm()`
- **Settings**: Found 4 channel delete buttons using `deleteChannelAccount()` with `confirm()`
- **Admin**: Found 3 bot remove buttons using `confirmRemoveBot()` with `confirm()`
- **All pages load without console errors** after the i18n fix (commit 945ed2ea)
- **No dialogs triggered during passive navigation** — all are behind user actions

---

## Estimated Impact

| Metric | Before | After |
|--------|--------|-------|
| Native dialogs | 64 | 0 |
| Consistent styling | No | Yes (matches design system) |
| i18n support | Partial | Full |
| Keyboard accessible | Browser-dependent | Full control |
| Mobile UX | Disruptive | Inline |
| Thread blocking | Yes | No (Promise-based) |

---

## Files to Modify

1. `portal/shared/api.js` — Add `showConfirm()` and `showPrompt()` utilities
2. `portal/shared/style.css` — Add confirm/prompt dialog styles
3. 15 HTML files listed in audit table — Replace `alert/confirm/prompt` calls
4. `portal/shared/i18n.js` — Add dialog button translation keys (confirm, cancel, delete, etc.)
