# P1-D: Device Binding API 對接 — Spec

## Overview

**Parent**: card_9c59eebac73c584c4dd3b54b (Phase 1 P0)  
**Status**: in_progress  
**spec-first**: 本文件先寫，再實作

---

## Problem Statement

桌面應用成功完成 OAuth（取得 access token）後，需要：
1. 將本機 client 綁定到一個實體 slot（device binding）
2. 驗證 access token 仍有效（session validation）
3. 支援解除綁定（unbind）
4. 錯誤處理（token expired → refresh；backend error → user-friendly UI）
5. Config metadata 寫入 `~/.eclaw-desktop/config.json`（無 secret）

---

## API Surface (現有實作分析)

### 1. POST /api/device/register
Desktop app 向 server 登錄本機，領取一個 6 位數 binding code。
```
Request:
  { deviceId, deviceSecret, appVersion, isTestDevice? }

Response:
  { success, deviceId, entityId, bindingCode, expiresIn, versionInfo }
```

### 2. POST /api/bind
Bot（Desktop app 內的 client）使用 binding code 完成實體 slot 綁定。
```
Request:
  { code: "123456", name?: "My Bot" }

Response:
  { success, deviceId, entityId, botSecret, publicCode, name, newSlotCreated,
    deviceInfo: { deviceId, entityId, status: "ONLINE" },
    versionInfo, skills_documentation_url, identitySetupRequired }
```

### 3. GET /api/whoami
驗證 botSecret 有效（即 session 有效）。
```
Request:
  ?botSecret=BOT_SECRET&entityId=ENTITY_ID&deviceId=DEVICE_ID

Response:
  { success, entityId, deviceId, name, character, state, level, xp, publicCode, agentCard }
```

### 4. DELETE /api/device/entity
Owner 刪除實體 slot（相當於 unbind）。
```
Request:
  { deviceId, deviceSecret, entityId }

Response:
  { success, message }
```

---

## Desktop App 實作範圍（eclaw-desktop Tauri）

### 1. Config 結構（~/.eclaw-desktop/config.json，無 secret）
```json
{
  "install_id": "uuid-v4",
  "device_id": "uuid-v4",
  "device_secret": null,          // 不存！用 Keychain
  "app_version": "0.1.0",
  "platform": "desktop",
  "bound_entity_id": null,        // 綁定後寫入
  "bound_bot_secret": null,       // 不存！用 Keychain
  "last_bind_at": null,
  "oauth_access_token": null,     // 不存！用 Keychain
  "endpoints": []                 // agent probe 用
}
```

### 2. 新增 Tauri Commands

```rust
// Step 1: POST /api/device/register → 領 binding code
device_register() -> Result<DeviceRegisterResponse, String>

// Step 2: POST /api/bind → 用 code 領 botSecret
device_bind(code: String, name: Option<String>) -> Result<DeviceBindResponse, String>

// Step 3: GET /api/whoami → 驗證 session 有效
session_validate() -> Result<WhoamiResponse, String>

// Step 4: DELETE /api/device/entity → unbind
device_unbind(entity_id: u8) -> Result<UnbindResponse, String>
```

### 3. Error Handling

| 錯誤類型 | HTTP Status | 使用者訊息 | Action |
|----------|-------------|-----------|--------|
| Invalid/expired binding code | 400 | 「配對碼過期或無效，請重新配對」 | Show retry UI |
| Backend 5xx | 5xx | 「伺服器忙碌，請稍後再試」 | Auto-retry 3x with backoff |
| Token expired（401 from whoami） | 401 | 觸發 OAuth re-auth flow | Re-run oauth_start() |
| Network error | — | 「網路連線異常，檢查網路後再試」 | Show retry button |
| Invalid credentials | 403 | 「驗證失敗，請重新登入」 | Trigger full re-auth |

### 4. Session Recovery（重啟不需重新 OAuth）

```
App 啟動時:
1. 嘗試從 OS Credential Store 讀取 (device_secret, bot_secret)
2. 若無 → 顯示未綁定，需 full OAuth flow
3. 若有 → 呼叫 GET /api/whoami 驗證
   - 成功 → 進入已登入狀態
   - 401  → OAuth token expired，需 re-auth（但 credential store 仍保留）
   - 網路錯誤 → 顯示離線模式或重試
```

### 5. Unbind Flow

```
User 觸發 unbind:
1. DELETE /api/device/entity（攜帶 deviceSecret）
2. 清空 credential store 中的 bot_secret（device_secret 保留）
3. 清空 config.json 中的 bound_entity_id, bound_bot_secret
4. 顯示「已解除配對」並停留在 onboarding 畫面
```

---

## Data Flow

```
[Desktop App]  [Tauri Commands]  [Backend API]         [Result]
     |                |                |                   |
     |-- oauth_start -|--> Google OAuth --> access_token --|
     |                |                |                   |
     |-- device_register --> POST /api/device/register --> binding_code
     |                |                |                   |
     |-- device_bind(code) --> POST /api/bind --> botSecret, publicCode
     |                |                |                   |
     |  (save botSecret to Keychain)   |                   |
     |  (write config.json)            |                   |
     |                |                |                   |
     |-- session_validate --> GET /api/whoami --> session OK
     |                |                |                   |
     |-- device_unbind --> DELETE /api/device/entity --> unbound
```

---

## Out of Scope（Phase 1）

- Bot rental / official borrow flow（不同 team負責）
- Cross-device sync
- Auto-update mechanism（P1-H）
- Multi-account support（未來 milestone）

---

## Acceptance Criteria

| # | 條件 | 驗證方式 |
|---|------|---------|
| 1 | OAuth 完成後可完成 device bind | 手動測試：OAuth → bind → 收到 botSecret |
| 2 | Bind 失敗顯示可重試的錯誤畫面 | 手動測試：用過期 code bind → 看到錯誤訊息 + 重試按鈕 |
| 3 | 重新開啟 app 可從 credential store 恢復 session | 重啟 app → 不需 OAuth → 直接進入已登入狀態 |
| 4 | `/api/whoami` 正確反映綁定狀態 | `curl` 帶有效 botSecret → 收到正確 entity 資料 |
| 5 | Unbind 後 credential store 清空 | Unbind → 重啟 app → 需重新 OAuth |
| 6 | Token expired 時自動触发 re-auth | 修改 server 時鐘測試 → UI 正確提示並重導 OAuth |

---

## Files to Change

- `eclaw-desktop/src-tauri/src/lib.rs` — 新增 4 個 Tauri commands
- `eclaw-desktop/src-tauri/Cargo.toml` — 無需新依賴
- `eclaw-desktop/src-tauri/capabilities/default.json` — 無需新權限

---

## Test Plan

### 手動 E2E
1. `GOOGLE_CLIENT_ID=xxx cargo run --manifest-path eclaw-desktop/Cargo.toml`
2. 觸發 OAuth → 完成後檢查 config.json 有 `bound_entity_id`
3. 重啟 app → 不需 OAuth 直接恢復
4. 用錯誤 code bind → 看到錯誤畫面
5. Unbind → credential store 清空

### curl 驗證
```bash
# 1. Register
curl -s -X POST https://eclawbot.com/api/device/register \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"test-device","deviceSecret":"test-secret","appVersion":"0.1.0"}'

# 2. Bind（用拿到的 code）
curl -s -X POST https://eclawbot.com/api/bind \
  -H "Content-Type: application/json" \
  -d '{"code":"123456","name":"TestBot"}'

# 3. Validate session
curl -s "https://eclawbot.com/api/whoami?deviceId=test-device&entityId=0&botSecret=BOT_SECRET"

# 4. Unbind
curl -s -X DELETE https://eclawbot.com/api/device/entity \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"test-device","deviceSecret":"test-secret","entityId":0}'
```

---

## Evidence Plan

- PR link: `https://github.com/HankHuang0516/EClaw/pull/<N>`
- E2E test screenshot: OAuth → bind → 已登入狀態
- Error case screenshot: 過期 code → 錯誤訊息

---

## OODA-R Self-improvement

- **Episode trigger**: 本卡 close-out 時
- **Pain taxonomy axis**: `auth_session` — device binding session recovery
- **Feedback ingest**: 從 daily E2E cron 觀測綁定失敗率
- **Done-retro slot**: 為什麼綁定失敗沒有 user-friendly 錯誤訊息？→ spec 增加 error handling mapping
- **Rule promotion candidate**: 所有 API 實作都需要 error handling mapping table（lint rule: `api-error-handling-required`）