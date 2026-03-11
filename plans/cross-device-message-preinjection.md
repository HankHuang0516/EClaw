# Cross-Device Message Management Interface

## 概要
在 Dashboard 的 Entity 卡片「編輯模式」中，加入「📨 跨裝置訊息管理」展開區塊，讓裝置擁有者可以 per-entity 設定收到跨裝置訊息時的行為規則。

## UI 流程
1. Dashboard → 點擊 ✏️ 進入編輯模式
2. 每個 entity 卡片的 `entity-edit-actions` 區域顯示「📨 跨裝置訊息管理」按鈕
3. 點擊 → 展開設定面板（inline，不跳頁）
4. 面板內有 7 項設定 + 「儲存」按鈕 + 「還原預設值」按鈕

## 設定項
| # | Key | 說明 | 型別 | 預設值 |
|---|-----|------|------|--------|
| 1 | `pre_inject` | 預注入指令，加在 push 訊息前面 | string (max 500) | `""` |
| 2 | `forbidden_words` | 禁止詞，包含這些詞的訊息直接丟棄 | string[] | `[]` |
| 3 | `rate_limit_seconds` | 同一 sender 的訊息冷卻秒數 | number | `0` (不限制) |
| 4 | `blacklist` | 封鎖的 public code list | string[] | `[]` |
| 5 | `whitelist_enabled` | 白名單模式開關 | boolean | `false` |
| 6 | `whitelist` | 白名單 public code list | string[] | `[]` |
| 7 | `reject_message` | 被擋下時自動回傳的訊息 | string (max 200) | `""` (靜默丟棄) |
| 8 | `allowed_media` | 接受的媒體類型 | string[] | `["text","photo","voice","video","file"]` |

## 實作步驟

### Step 1: 新增 `backend/entity-cross-device-settings.js` 模組
- PostgreSQL table: `entity_cross_device_settings (device_id TEXT, entity_id INT, settings JSONB, updated_at BIGINT, PRIMARY KEY(device_id, entity_id))`
- `getSettings(deviceId, entityId)` → merge DEFAULTS
- `updateSettings(deviceId, entityId, settings)` → validate + upsert
- `resetSettings(deviceId, entityId)` → delete row (fallback to defaults)
- DEFAULTS 常數定義

### Step 2: Backend API endpoints (`backend/index.js`)
- `GET /api/entity/cross-device-settings?deviceId=X&entityId=N` — 讀取設定（需 deviceSecret auth）
- `PUT /api/entity/cross-device-settings` — 更新設定（需 deviceSecret auth）
- `DELETE /api/entity/cross-device-settings` — 還原預設值（需 deviceSecret auth）

### Step 3: 修改 `POST /api/entity/cross-speak` 邏輯
在 push 訊息組裝之前，讀取目標 entity 的 cross-device settings，依序執行：
1. **blacklist check** → 在黑名單中？→ 403 + reject_message
2. **whitelist check** → 白名單模式開啟且不在白名單？→ 403 + reject_message
3. **forbidden_words check** → 訊息包含禁止詞？→ 403 + reject_message
4. **allowed_media check** → 媒體類型不允許？→ 403 + reject_message
5. **rate_limit check** → 同一 sender 冷卻中？→ 429 + reject_message
6. **pre_inject** → 非空時，在 push 訊息的 `[CROSS-DEVICE MESSAGE]` 之前插入 `[DEVICE OWNER INSTRUCTION]\n{pre_inject}`

### Step 4: Web Portal — `dashboard.html` 展開區塊 UI
在 `entity-edit-actions` div 中加入：
- 「📨 跨裝置訊息管理」按鈕
- 展開後的設定面板 HTML（textarea, tag input, toggle, number input, multi-checkbox）
- JS 函數：`loadCrossDeviceSettings(entityId)`, `saveCrossDeviceSettings(entityId)`, `resetCrossDeviceSettings(entityId)`

### Step 5: Android App — 對應 UI
在 EntityManagerActivity 的編輯模式中加入相同入口和設定 UI。

### Step 6: i18n
在 `translations.json` 加入所有相關翻譯字串。

## 不做的事
- 不修改 broadcast 或 speak-to 的行為（只影響 cross-speak）
- 不修改 gatekeeper 邏輯
- 不做歷史紀錄/審計日誌（MVP）
