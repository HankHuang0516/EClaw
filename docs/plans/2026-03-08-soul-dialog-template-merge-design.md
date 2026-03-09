# Soul Dialog Template Merge Design

**Date:** 2026-03-08
**Scope:** `backend/public/portal/mission.html`, `backend/public/shared/i18n.js`
**Status:** Approved

---

## Problem

The "新增靈魂" dialog has two redundant template selection mechanisms:

| # | Element | Data Source | Effect |
|---|---------|-------------|--------|
| 1 | Gallery button `🎭 從模板選擇` | `soulTemplates` (API: `soul-templates.json`, 4 entries) | Fills name + description only |
| 2 | Dropdown `<select id="dlg_soul_template">` | `SOUL_TEMPLATES` (hardcoded, 8 entries) | Fills name + description + saves `templateId` |

The two sources have different structures and serve different purposes, causing user confusion.

---

## Solution: Unified Gallery

Remove the dropdown. Merge both template sources into the Gallery overlay.

### New Dialog Layout

**Add dialog:**
```
┌─────────────────────────────────┐
│ 新增靈魂                        │
├─────────────────────────────────┤
│  🎭 從模板選擇         [按鈕]   │
│                                 │
│  靈魂名稱                       │
│  [___________________]          │
│  個性描述                       │
│  [___________________]          │
│  mc_dlg_assign (可多選)         │
│  ☐ Entity0  ☐ Entity1          │
│            [取消] [儲存]        │
└─────────────────────────────────┘
```

**Edit dialog (shows current template in button):**
```
│  🎭 友善助手           [按鈕]   │   ← template name shown
```

### Gallery Overlay Layout

```
┌────── 靈魂模板 ──────────────────────┐
│ [搜尋…]                              │
│                                      │
│ ── 內建模板 ──────────────────────── │
│  😊 友善助手     [by Built-in] [選擇]│
│  🧠 傲嬌         [by Built-in] [選擇]│
│  ... (8 個)                          │
│                                      │
│ ── 社群模板 ──────────────────────── │
│  💼 Professional Advisor  [E-Claw]   │
│  🎨 Creative Thinker      [E-Claw]   │
│  ... (API 模板)                      │
└──────────────────────────────────────┘
```

(社群模板 section only shown if `soulTemplates` array is non-empty)

---

## Technical Changes

### 1. Dialog HTML (both add + edit)

**Remove:**
- `<div class="dialog-field-label">靈魂模板</div>`
- `<select id="dlg_soul_template">` with `onchange="onSoulTemplateChange()"`
- Gallery button only in `!isEdit` condition → move to show in BOTH modes

**Add:**
- `<input type="hidden" id="dlg_soul_template_id">` for templateId tracking
- Gallery button in both add + edit, with dynamic label:
  - Add: `🎭 從模板選擇` (i18n: `mc_dlg_soul_template_btn`)
  - Edit (when templateId set): `🎭 {{templateName}}` (shows current template name)
  - Edit (when no templateId): `🎭 從模板選擇`

### 2. Remove

- `onSoulTemplateChange()` function
- `templateOptions` HTML generation variable
- `const selected = isEdit && soul.templateId === tpl.id ? 'selected' : ''` (dropdown pre-selection)

### 3. Modify `showSoulGallery()`

Two sections in the gallery:

**Section A — Built-in (from `SOUL_TEMPLATES`):**
```javascript
const builtinCards = SOUL_TEMPLATES.map(t => {
    const name = getSoulTemplateName(t);
    const desc = getSoulTemplateDesc(t);
    return `<div class="tpl-gallery-card" ... onclick="selectBuiltinSoulTemplate('${t.id}')">
        <div class="tpl-gallery-icon">🧠</div>
        <div class="tpl-gallery-info">
            <div class="tpl-gallery-title">${esc(name)}</div>
            <div class="tpl-gallery-meta">Built-in</div>
            <div class="tpl-gallery-status">${esc(desc.substring(0, 60))}…</div>
        </div>
        <button ...onclick="...selectBuiltinSoulTemplate('${t.id}')">Select</button>
    </div>`;
});
```

**Section B — Community (from `soulTemplates` API):**
Same as current `showSoulGallery()` cards, calls `selectSoulTemplate(id)` (renamed to `selectCustomSoulTemplate`).

### 4. New `selectBuiltinSoulTemplate(id)`

```javascript
function selectBuiltinSoulTemplate(id) {
    const tpl = SOUL_TEMPLATES.find(t => t.id === id);
    if (!tpl) return;
    document.getElementById('dlg_soul_name').value = getSoulTemplateName(tpl);
    document.getElementById('dlg_soul_desc').value = getSoulTemplateDesc(tpl);
    document.getElementById('dlg_soul_template_id').value = id;
    // Update button label
    const btn = document.getElementById('dlgTemplateBtn');
    if (btn) btn.textContent = `🎭 ${getSoulTemplateName(tpl)}`;
    document.getElementById('soul_gallery_overlay')?.remove();
}
```

### 5. Modify `selectSoulTemplate()` → `selectCustomSoulTemplate()`

Same as before but:
- Clear `dlg_soul_template_id` (API templates don't persist as `templateId`)
- Update button label to show template name (without setting templateId)

### 6. Modify Save Logic

Line 1945: change from:
```javascript
const templateId = document.getElementById('dlg_soul_template').value || null;
```
to:
```javascript
const templateId = document.getElementById('dlg_soul_template_id').value || null;
```

### 7. Edit Dialog Init

When `isEdit === true` and `soul.templateId` is set:
```javascript
const currentTpl = SOUL_TEMPLATES.find(t => t.id === soul.templateId);
const btnLabel = currentTpl ? `🎭 ${getSoulTemplateName(currentTpl)}` : `🎭 ${i18n.t('mc_dlg_soul_template_btn')}`;
```
Also: set `value="${esc(soul.templateId || '')}"` on the hidden input.

---

## i18n Keys

| Key | en | zh |
|-----|----|----|
| `mc_dlg_soul_template_btn` | `🎭 Select Template` | `🎭 從模板選擇` |
| `mc_dlg_soul_gallery_builtin` | `Built-in` | `內建模板` |
| `mc_dlg_soul_gallery_community` | `Community` | `社群模板` |

---

## Files to Change

1. `backend/public/portal/mission.html` — HTML + JS (dialog structure, Gallery function, selectTemplate functions, save logic)
2. `backend/public/shared/i18n.js` — add 3 new i18n keys (en + zh)

---

## What Stays the Same

- `SOUL_TEMPLATES` array (still needed for soul list badge display)
- `getSoulTemplateName()` and `getSoulTemplateDesc()` helpers
- `fillSoulTemplate()` helper (can be reused)
- `filterSoulGallery()` (search filter, works on both sections)
- `renderSouls()` badge logic (unchanged)
- API endpoint `/api/soul-templates` (unchanged)
