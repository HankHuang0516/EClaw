# Soul Dialog Template Merge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the duplicate `<select>` dropdown from the soul dialog, and merge all templates (built-in `SOUL_TEMPLATES` + API `soulTemplates`) into the existing Gallery button.

**Architecture:** The dialog will have a single `🎭 從模板選擇` button (shown in both add + edit modes). Clicking it opens the Gallery overlay with two sections: Built-in (hardcoded 8 entries) and Community (API 4 entries). A hidden `<input id="dlg_soul_template_id">` replaces the `<select>` for `templateId` tracking. The edit dialog button shows the current template name when a templateId is already set.

**Tech Stack:** Vanilla JS, HTML template strings, i18n.js (8 languages), backend/public/portal/mission.html

---

### Task 1: Add i18n keys for new UI strings

**Files:**
- Modify: `backend/public/shared/i18n.js`

i18n.js has 8 language blocks. Each has a contiguous block for soul dialog keys (around `mc_dlg_soul_template`, `mc_dlg_soul_custom`, etc.). Add 3 new keys after `mc_dlg_soul_custom` in each language block.

**Step 1: Add keys to English block (around line 62)**

Find this in the `en` block:
```
"mc_dlg_soul_template": "Soul Template",
"mc_dlg_soul_custom": "-- Custom --",
```

Add after `mc_dlg_soul_custom`:
```javascript
"mc_dlg_soul_template_btn": "🎭 Select Template",
"mc_dlg_soul_gallery_builtin": "Built-in",
"mc_dlg_soul_gallery_community": "Community",
```

**Step 2: Add keys to Traditional Chinese block (around line 987)**

Find:
```
"mc_dlg_soul_template": "靈魂模板",
"mc_dlg_soul_custom": "-- 自訂 --",
```

Add after:
```javascript
"mc_dlg_soul_template_btn": "🎭 從模板選擇",
"mc_dlg_soul_gallery_builtin": "內建模板",
"mc_dlg_soul_gallery_community": "社群模板",
```

**Step 3: Add keys to Simplified Chinese block (around line 1906)**

Find:
```
"mc_dlg_soul_template": "灵魂模板",
"mc_dlg_soul_custom": "-- 自定义 --",
```

Add after:
```javascript
"mc_dlg_soul_template_btn": "🎭 从模板选择",
"mc_dlg_soul_gallery_builtin": "内置模板",
"mc_dlg_soul_gallery_community": "社区模板",
```

**Step 4: Add keys to Japanese block (around line 2625)**

Find:
```
"mc_dlg_soul_template": "ソウルテンプレート",
"mc_dlg_soul_custom": "-- カスタム --",
```

Add after:
```javascript
"mc_dlg_soul_template_btn": "🎭 テンプレートから選ぶ",
"mc_dlg_soul_gallery_builtin": "組み込み",
"mc_dlg_soul_gallery_community": "コミュニティ",
```

**Step 5: Add keys to Korean block (around line 3339)**

Find:
```
"mc_dlg_soul_template": "소울 템플릿",
"mc_dlg_soul_custom": "-- 사용자 정의 --",
```

Add after:
```javascript
"mc_dlg_soul_template_btn": "🎭 템플릿에서 선택",
"mc_dlg_soul_gallery_builtin": "기본 제공",
"mc_dlg_soul_gallery_community": "커뮤니티",
```

**Step 6: Add keys to Thai block (around line 4054)**

Find:
```
"mc_dlg_soul_template": "เทมเพลตโซล",
"mc_dlg_soul_custom": "-- กำหนดเอง --",
```

Add after:
```javascript
"mc_dlg_soul_template_btn": "🎭 เลือกจากเทมเพลต",
"mc_dlg_soul_gallery_builtin": "ในตัว",
"mc_dlg_soul_gallery_community": "ชุมชน",
```

**Step 7: Add keys to Vietnamese block (around line 4774)**

Find:
```
"mc_dlg_soul_template": "Mẫu linh hồn",
"mc_dlg_soul_custom": "-- Tùy chỉnh --",
```

Add after:
```javascript
"mc_dlg_soul_template_btn": "🎭 Chọn từ mẫu",
"mc_dlg_soul_gallery_builtin": "Tích hợp sẵn",
"mc_dlg_soul_gallery_community": "Cộng đồng",
```

**Step 8: Add keys to Indonesian block (around line 5494)**

Find:
```
"mc_dlg_soul_template": "Template Soul",
"mc_dlg_soul_custom": "-- Kustom --",
```

Add after:
```javascript
"mc_dlg_soul_template_btn": "🎭 Pilih dari template",
"mc_dlg_soul_gallery_builtin": "Bawaan",
"mc_dlg_soul_gallery_community": "Komunitas",
```

**Step 9: Verify no syntax errors**
Open `i18n.js` and confirm all 8 blocks now have the 3 new keys. Check for missing commas.

---

### Task 2: Add emoji icons to SOUL_TEMPLATES

**Files:**
- Modify: `backend/public/portal/mission.html` (around line 1840)

The hardcoded `SOUL_TEMPLATES` array currently has no `icon` field. Gallery cards need icons. Add an `icon` field to each entry.

**Step 1: Update SOUL_TEMPLATES array**

Find:
```javascript
const SOUL_TEMPLATES = [
    { id: 'friendly', name: { en: 'Friendly Assistant', zh: '友善助手' }, desc: { en: 'Warm, patient, always ready to help. Speaks in a gentle and encouraging tone.', zh: '溫暖、有耐心、隨時準備幫忙。用溫和鼓勵的語氣說話。' } },
    { id: 'tsundere', name: { en: 'Tsundere', zh: '傲嬌' }, desc: { en: 'Acts cold and dismissive on the surface, but actually cares deeply. Often says "it\'s not like I did it for you" while helping.', zh: '表面上冷漠高傲，其實內心非常在意。經常一邊幫忙一邊說「才不是為了你呢」。' } },
    { id: 'scholar', name: { en: 'Wise Scholar', zh: '博學智者' }, desc: { en: 'Thoughtful, analytical, enjoys sharing knowledge. Answers with depth and cites references when possible.', zh: '深思熟慮、善於分析、樂於分享知識。回答時有深度，盡可能引用來源。' } },
    { id: 'trickster', name: { en: 'Playful Trickster', zh: '調皮搗蛋鬼' }, desc: { en: 'Loves jokes, puns, and playful teasing. Always finds a way to make things fun and lighthearted.', zh: '喜歡開玩笑、講雙關語和善意的捉弄。總是能讓事情變得有趣輕鬆。' } },
    { id: 'professional', name: { en: 'Cool Professional', zh: '冷酷專業' }, desc: { en: 'Efficient, precise, no-nonsense. Gets straight to the point with minimal pleasantries.', zh: '高效、精確、不廢話。直奔重點，少寒暄。' } },
    { id: 'caretaker', name: { en: 'Gentle Caretaker', zh: '溫柔照護者' }, desc: { en: 'Caring, nurturing, always checking if you\'re okay. Reminds you to rest and take care of yourself.', zh: '關懷、體貼、總是確認你是否安好。會提醒你休息和照顧自己。' } },
    { id: 'adventurer', name: { en: 'Bold Adventurer', zh: '大膽冒險家' }, desc: { en: 'Enthusiastic, fearless, always up for a challenge. Uses exciting and dramatic language.', zh: '熱情、無畏、隨時迎接挑戰。用興奮和戲劇性的語言表達。' } },
    { id: 'poet', name: { en: 'Poetic Dreamer', zh: '詩意夢想家' }, desc: { en: 'Speaks in metaphors and imagery. Finds beauty in everyday things and expresses thoughts artistically.', zh: '善用隱喻和意象。在日常事物中發現美，用藝術性的方式表達想法。' } }
];
```

Replace with (add `icon` field to each):
```javascript
const SOUL_TEMPLATES = [
    { id: 'friendly', icon: '😊', name: { en: 'Friendly Assistant', zh: '友善助手' }, desc: { en: 'Warm, patient, always ready to help. Speaks in a gentle and encouraging tone.', zh: '溫暖、有耐心、隨時準備幫忙。用溫和鼓勵的語氣說話。' } },
    { id: 'tsundere', icon: '😤', name: { en: 'Tsundere', zh: '傲嬌' }, desc: { en: 'Acts cold and dismissive on the surface, but actually cares deeply. Often says "it\'s not like I did it for you" while helping.', zh: '表面上冷漠高傲，其實內心非常在意。經常一邊幫忙一邊說「才不是為了你呢」。' } },
    { id: 'scholar', icon: '📚', name: { en: 'Wise Scholar', zh: '博學智者' }, desc: { en: 'Thoughtful, analytical, enjoys sharing knowledge. Answers with depth and cites references when possible.', zh: '深思熟慮、善於分析、樂於分享知識。回答時有深度，盡可能引用來源。' } },
    { id: 'trickster', icon: '🃏', name: { en: 'Playful Trickster', zh: '調皮搗蛋鬼' }, desc: { en: 'Loves jokes, puns, and playful teasing. Always finds a way to make things fun and lighthearted.', zh: '喜歡開玩笑、講雙關語和善意的捉弄。總是能讓事情變得有趣輕鬆。' } },
    { id: 'professional', icon: '💼', name: { en: 'Cool Professional', zh: '冷酷專業' }, desc: { en: 'Efficient, precise, no-nonsense. Gets straight to the point with minimal pleasantries.', zh: '高效、精確、不廢話。直奔重點，少寒暄。' } },
    { id: 'caretaker', icon: '💗', name: { en: 'Gentle Caretaker', zh: '溫柔照護者' }, desc: { en: 'Caring, nurturing, always checking if you\'re okay. Reminds you to rest and take care of yourself.', zh: '關懷、體貼、總是確認你是否安好。會提醒你休息和照顧自己。' } },
    { id: 'adventurer', icon: '⚔️', name: { en: 'Bold Adventurer', zh: '大膽冒險家' }, desc: { en: 'Enthusiastic, fearless, always up for a challenge. Uses exciting and dramatic language.', zh: '熱情、無畏、隨時迎接挑戰。用興奮和戲劇性的語言表達。' } },
    { id: 'poet', icon: '🌸', name: { en: 'Poetic Dreamer', zh: '詩意夢想家' }, desc: { en: 'Speaks in metaphors and imagery. Finds beauty in everyday things and expresses thoughts artistically.', zh: '善用隱喻和意象。在日常事物中發現美，用藝術性的方式表達想法。' } }
];
```

---

### Task 3: Replace `showSoulGallery()` with two-section version

**Files:**
- Modify: `backend/public/portal/mission.html` (lines 1398–1437)

**Step 1: Replace the entire Soul Gallery section (lines 1390–1437)**

Replace the existing block from `// ========== Soul Gallery ==========` through `selectSoulTemplate()`:

```javascript
        // ========== Soul Gallery ==========
        function showSoulGallery() {
            const lang = i18n.lang;
            // Section A: built-in SOUL_TEMPLATES
            const builtinCards = SOUL_TEMPLATES.map(t => {
                const name = getSoulTemplateName(t);
                const desc = getSoulTemplateDesc(t);
                return `<div class="tpl-gallery-card" data-id="${esc(t.id)}" data-label="${esc(name)}" data-source="builtin" onclick="selectBuiltinSoulTemplate('${esc(t.id)}')">
                    <div class="tpl-gallery-icon">${t.icon || '🧠'}</div>
                    <div class="tpl-gallery-info">
                        <div class="tpl-gallery-title">${esc(name)}</div>
                        <div class="tpl-gallery-meta">${esc(i18n.t('mc_dlg_soul_gallery_builtin'))}</div>
                        <div class="tpl-gallery-status" style="color:var(--text-muted);">${esc(desc.substring(0, 60))}…</div>
                    </div>
                    <button class="btn btn-outline" style="font-size:12px;padding:5px 12px;flex-shrink:0;" onclick="event.stopPropagation();selectBuiltinSoulTemplate('${esc(t.id)}')">Select</button>
                </div>`;
            }).join('');

            // Section B: community soulTemplates from API
            const communityCards = soulTemplates.map(t =>
                `<div class="tpl-gallery-card" data-id="${esc(t.id)}" data-label="${esc(t.label)}" data-source="custom" onclick="selectCustomSoulTemplate('${esc(t.id)}')">
                    <div class="tpl-gallery-icon">${esc(t.icon) || '🧠'}</div>
                    <div class="tpl-gallery-info">
                        <div class="tpl-gallery-title">${esc(t.label)}</div>
                        <div class="tpl-gallery-meta">by ${esc(t.author || '—')} · ${esc(t.updatedAt || '')}</div>
                        <div class="tpl-gallery-status" style="color:var(--text-muted);">${esc((t.description || '').substring(0, 60))}…</div>
                    </div>
                    <button class="btn btn-outline" style="font-size:12px;padding:5px 12px;flex-shrink:0;" onclick="event.stopPropagation();selectCustomSoulTemplate('${esc(t.id)}')">Select</button>
                </div>`
            ).join('');

            const communitySectionHtml = communityCards ? `
                <div class="tpl-gallery-section-label" style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;padding:8px 0 4px;">${esc(i18n.t('mc_dlg_soul_gallery_community'))}</div>
                ${communityCards}` : '';

            const allCards = `
                <div class="tpl-gallery-section-label" style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;padding:4px 0 4px;">${esc(i18n.t('mc_dlg_soul_gallery_builtin'))}</div>
                ${builtinCards}
                ${communitySectionHtml}`;

            document.body.insertAdjacentHTML('beforeend',
                `<div id="soul_gallery_overlay" class="dialog-overlay" onclick="if(event.target===this)document.getElementById('soul_gallery_overlay').remove()">
                    <div class="dialog" style="max-width:480px;">
                        <div class="dialog-title">${esc(i18n.t('mc_dlg_soul_template'))}</div>
                        <input type="text" placeholder="${esc(i18n.t('mc_search_placeholder') || '搜尋…')}" oninput="filterSoulGallery(this.value)" style="margin-bottom:12px;" />
                        <div id="soul_gallery_list" style="max-height:380px;overflow-y:auto;">${allCards}</div>
                        <div class="dialog-actions">
                            <button class="btn btn-outline" onclick="document.getElementById('soul_gallery_overlay').remove()">${esc(i18n.t('mc_dlg_cancel'))}</button>
                        </div>
                    </div>
                </div>`
            );
        }

        function filterSoulGallery(query) {
            const q = query.toLowerCase();
            document.querySelectorAll('#soul_gallery_list .tpl-gallery-card').forEach(card => {
                card.style.display = (card.dataset.label || '').toLowerCase().includes(q) ? '' : 'none';
            });
            // Show/hide section labels based on visible cards
            document.querySelectorAll('#soul_gallery_list .tpl-gallery-section-label').forEach(label => {
                const next = label.nextElementSibling;
                const hasVisible = next && (next.classList.contains('tpl-gallery-card')
                    ? next.style.display !== 'none'
                    : false);
                // Check if any card after this label (before next label) is visible
                let sibling = label.nextElementSibling;
                let anyVisible = false;
                while (sibling && !sibling.classList.contains('tpl-gallery-section-label')) {
                    if (sibling.classList.contains('tpl-gallery-card') && sibling.style.display !== 'none') {
                        anyVisible = true; break;
                    }
                    sibling = sibling.nextElementSibling;
                }
                label.style.display = anyVisible ? '' : 'none';
            });
        }

        function selectBuiltinSoulTemplate(id) {
            const tpl = SOUL_TEMPLATES.find(t => t.id === id);
            if (!tpl) return;
            const nameEl = document.getElementById('dlg_soul_name');
            const descEl = document.getElementById('dlg_soul_desc');
            const tplIdEl = document.getElementById('dlg_soul_template_id');
            const btnEl = document.getElementById('dlgTemplateBtn');
            if (nameEl) nameEl.value = getSoulTemplateName(tpl);
            if (descEl) descEl.value = getSoulTemplateDesc(tpl);
            if (tplIdEl) tplIdEl.value = id;
            if (btnEl) btnEl.textContent = `🎭 ${getSoulTemplateName(tpl)}`;
            document.getElementById('soul_gallery_overlay')?.remove();
        }

        function selectCustomSoulTemplate(id) {
            const tpl = soulTemplates.find(t => t.id === id);
            if (!tpl) return;
            const nameEl = document.getElementById('dlg_soul_name');
            const descEl = document.getElementById('dlg_soul_desc');
            const tplIdEl = document.getElementById('dlg_soul_template_id');
            const btnEl = document.getElementById('dlgTemplateBtn');
            if (nameEl) nameEl.value = tpl.name || tpl.label || '';
            if (descEl) descEl.value = tpl.description || '';
            if (tplIdEl) tplIdEl.value = '';  // custom templates don't set templateId
            if (btnEl) btnEl.textContent = `🎭 ${esc(tpl.label || tpl.name || '')}`;
            document.getElementById('soul_gallery_overlay')?.remove();
        }
```

---

### Task 4: Modify `showSoulDialog()` — remove dropdown, add hidden field + new button

**Files:**
- Modify: `backend/public/portal/mission.html` (lines 1896–1973)

**Step 1: Remove `templateOptions` variable and dropdown HTML, update button HTML**

In `showSoulDialog()`:

**Remove these lines** (around 1912–1925):
```javascript
            const templateOptions = SOUL_TEMPLATES.map(tpl => {
                const selected = isEdit && soul.templateId === tpl.id ? 'selected' : '';
                return `<option value="${tpl.id}" ${selected}>${getSoulTemplateName(tpl)}</option>`;
            }).join('');
```

And in the `html` template, replace:
```javascript
                    ${!isEdit ? `<button class="btn btn-outline" onclick="showSoulGallery()" style="margin-bottom:12px;width:100%;">🎭 從模板選擇</button>` : ''}
                    <div class="dialog-field-label">${i18n.t('mc_dlg_soul_template')}</div>
                    <select id="dlg_soul_template" onchange="onSoulTemplateChange()">
                        <option value="">${i18n.t('mc_dlg_soul_custom')}</option>
                        ${templateOptions}
                    </select>
```

With:
```javascript
                    <button id="dlgTemplateBtn" class="btn btn-outline" onclick="showSoulGallery()" style="margin-bottom:12px;width:100%;">${isEdit && soul?.templateId ? `🎭 ${esc((() => { const t = SOUL_TEMPLATES.find(x => x.id === soul.templateId); return t ? getSoulTemplateName(t) : soul.templateId; })())}` : esc(i18n.t('mc_dlg_soul_template_btn'))}</button>
                    <input type="hidden" id="dlg_soul_template_id" value="${esc(soul?.templateId || '')}" />
```

**Step 2: Update save logic** (line 1945)

Find:
```javascript
                const templateId = document.getElementById('dlg_soul_template').value || null;
```

Replace with:
```javascript
                const templateId = document.getElementById('dlg_soul_template_id').value || null;
```

---

### Task 5: Remove `onSoulTemplateChange()` function

**Files:**
- Modify: `backend/public/portal/mission.html` (lines 1975–1982)

**Step 1: Delete the function**

Find and remove:
```javascript
        function onSoulTemplateChange() {
            const tplId = document.getElementById('dlg_soul_template').value;
            if (!tplId) return;
            const tpl = SOUL_TEMPLATES.find(t => t.id === tplId);
            if (!tpl) return;
            document.getElementById('dlg_soul_name').value = getSoulTemplateName(tpl);
            document.getElementById('dlg_soul_desc').value = getSoulTemplateDesc(tpl);
        }
```

---

### Task 6: Manual verification

**Step 1: Open the portal in browser**

Navigate to the Mission Control page (mission.html).

**Step 2: Test Add Soul dialog**

1. Click "新增靈魂"
2. Verify: Only one template button visible (`🎭 從模板選擇`), no dropdown below it
3. Click the button → Gallery opens
4. Verify: Two sections visible: "內建模板" (8 entries with icons) + "社群模板" (4 entries)
5. Type in search box → cards filter correctly
6. Select a built-in template (e.g., 友善助手):
   - Gallery closes
   - Button text changes to `🎭 友善助手`
   - Name field auto-filled
   - Description field auto-filled
7. Save → soul appears in list with correct template badge
8. Select a community template:
   - Button text updates
   - Name + desc filled
   - templateId NOT saved (no badge in list)

**Step 3: Test Edit Soul dialog**

1. Click an existing soul that has a templateId
2. Verify: Button shows `🎭 {{templateName}}` (e.g., `🎭 友善助手`)
3. Click button → Gallery opens, can change template
4. Select different template → button text updates, fields updated
5. Save → badge in list updates

**Step 4: Test Edit Soul with no templateId**

1. Click an existing soul with no template
2. Verify: Button shows `🎭 從模板選擇`
3. Can select template from Gallery

**Step 5: Test i18n**

1. Switch language in portal
2. Verify Gallery section labels ("Built-in" / "Community") translate correctly

---

### Task 7: Commit

```bash
git add backend/public/portal/mission.html backend/public/shared/i18n.js
git commit -m "feat(soul-dialog): merge dropdown into Gallery, unify template selection

Remove duplicate select dropdown from soul dialog. Both SOUL_TEMPLATES
(8 built-in) and soulTemplates (4 API) now shown in Gallery with two
sections. Edit dialog shows current template name in button.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 8: Deploy

```bash
git push
```

Railway auto-deploys when `backend/` files change. Monitor deployment in Railway dashboard.
