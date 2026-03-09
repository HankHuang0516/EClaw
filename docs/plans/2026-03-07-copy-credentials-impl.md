# Copy Credentials UX Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add individual copy for Device ID and a "Copy Credentials" button that copies both Device ID + Device Secret together in the settings page Account card.

**Architecture:** Pure frontend change — HTML structure update + new JS functions + i18n keys. No backend changes needed. Reuses existing `showCopyToast()` and the `_fullDeviceId` / `_fullDeviceSecret` variables already in scope.

**Tech Stack:** Vanilla JS, HTML/CSS in `settings.html`, i18n via `i18n.js`

---

### Task 1: Add i18n key `settings_copy_credentials` to all 8 locales

**Files:**
- Modify: `backend/public/shared/i18n.js`

i18n.js has 8 locale blocks. Each block has a `"settings_device_secret"` key — insert `"settings_copy_credentials"` immediately after it in each block.

**Step 1: Add key to `en` locale (line ~403)**

Find:
```js
        "settings_device_secret": "Device Secret",
```
Insert after (en block, line ~403):
```js
        "settings_copy_credentials": "Copy Credentials",
```

**Step 2: Add key to `zh-TW` locale (line ~1316)**

Insert after `"settings_device_secret": "Device Secret",`:
```js
        "settings_copy_credentials": "複製憑證",
```

**Step 3: Add key to `zh-CN` locale (line ~2171)**

Insert after `"settings_device_secret": "设备密钥",`:
```js
        "settings_copy_credentials": "复制凭证",
```

**Step 4: Add key to `ja` locale (line ~2883)**

Insert after `"settings_device_secret": "デバイスシークレット",`:
```js
        "settings_copy_credentials": "認証情報をコピー",
```

**Step 5: Add key to `ko` locale (line ~3590)**

Insert after `"settings_device_secret": "Device Secret",`:
```js
        "settings_copy_credentials": "자격증명 복사",
```

**Step 6: Add key to `th` locale (line ~4298)**

Insert after `"settings_device_secret": "Device Secret",`:
```js
        "settings_copy_credentials": "คัดลอกข้อมูลรับรอง",
```

**Step 7: Add key to `vi` locale (line ~5011)**

Insert after `"settings_device_secret": "Device Secret",`:
```js
        "settings_copy_credentials": "Sao chép thông tin xác thực",
```

**Step 8: Add key to `id` locale (line ~5724)**

Insert after `"settings_device_secret": "Device Secret",`:
```js
        "settings_copy_credentials": "Salin Kredensial",
```

---

### Task 2: Add JS functions `copyDeviceId` and `copyBothCredentials`

**Files:**
- Modify: `backend/public/portal/settings.html`

Find the existing `copyDeviceSecret()` function (~line 988). Insert two new functions **after** it:

```js
        async function copyDeviceId() {
            if (!_fullDeviceId) return;
            try {
                await navigator.clipboard.writeText(_fullDeviceId);
                showCopyToast();
            } catch (e) { console.error('Copy failed:', e); }
        }

        async function copyBothCredentials() {
            if (!_fullDeviceId || !_fullDeviceSecret) return;
            try {
                const text = `Device ID: ${_fullDeviceId}\nDevice Secret: ${_fullDeviceSecret}`;
                await navigator.clipboard.writeText(text);
                showCopyToast();
            } catch (e) { console.error('Copy failed:', e); }
        }
```

---

### Task 3: Update HTML — Device ID row + Copy Credentials button

**Files:**
- Modify: `backend/public/portal/settings.html`

**Step 1: Add 📋 button to Device ID row**

Find the Device ID row's `info-value-mono-group` span:
```html
                <span class="info-value-mono-group">
                    <span class="info-value mono" id="accountDeviceId">--</span>
                    <button id="btnRevealDeviceId" onclick="toggleDeviceIdReveal()"
                        style="background:none;border:none;cursor:pointer;font-size:14px;padding:0 2px;opacity:0.6;line-height:1;flex-shrink:0;"
                        title="顯示/隱藏 Device ID">👁</button>
                </span>
```

Replace with (adds 📋 button after 👁):
```html
                <span class="info-value-mono-group">
                    <span class="info-value mono" id="accountDeviceId">--</span>
                    <button id="btnRevealDeviceId" onclick="toggleDeviceIdReveal()"
                        style="background:none;border:none;cursor:pointer;font-size:14px;padding:0 2px;opacity:0.6;line-height:1;flex-shrink:0;"
                        title="顯示/隱藏 Device ID">👁</button>
                    <button onclick="copyDeviceId()"
                        style="background:none;border:none;cursor:pointer;font-size:14px;padding:0 2px;opacity:0.6;line-height:1;flex-shrink:0;"
                        data-i18n-title="common_copy" title="複製">📋</button>
                </span>
```

**Step 2: Add "Copy Credentials" button row after Device Secret row**

Find the closing `</div>` after the Device Secret row (before the `connectedAccountsRow` div):
```html
            </div>
            <div class="info-row" id="connectedAccountsRow" style="display:none">
```

Insert between them:
```html
            <div style="padding: 10px 0; border-top: 1px dashed var(--card-border);">
                <button onclick="copyBothCredentials()"
                    style="width:100%;background:none;border:1px solid var(--card-border);border-radius:6px;padding:7px 0;cursor:pointer;font-size:13px;color:var(--text-secondary);opacity:0.8;display:flex;align-items:center;justify-content:center;gap:6px;"
                    data-i18n="settings_copy_credentials">Copy Credentials</button>
            </div>
            <div class="info-row" id="connectedAccountsRow" style="display:none">
```

---

### Task 4: Verify and commit

**Step 1: Open settings page in browser**
- Navigate to the Account card
- Confirm Device ID row shows 👁 📋
- Confirm Device Secret row shows 👁 📋
- Confirm "Copy Credentials" button appears between Device Secret and Connected Accounts

**Step 2: Test copy functions**
- Click 📋 on Device ID → clipboard contains the raw UUID → paste to verify
- Click 📋 on Device Secret → clipboard contains raw secret
- Click "Copy Credentials" → clipboard contains:
  ```
  Device ID: <uuid>
  Device Secret: <secret>
  ```
- Confirm toast appears for each copy action

**Step 3: Commit**

```bash
git add backend/public/portal/settings.html backend/public/shared/i18n.js
git commit -m "feat(settings): add copy icon for Device ID and Copy Credentials button"
```

**Step 4: Push**

```bash
git push
```
