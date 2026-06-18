# Desktop App Phase 1 Core 規格書

> **狀態**: v0.1 (2026-06-18) · **作者**: Mac_C #4 · **審查者**: LOBSTER #2
> **依賴卡**: `card_9c59eebac73c584c4dd3b54b` · **上游 ADR**: `docs/desktop-app-adr-001-framework.md`
>
> **Phase 2/3 依賴**: Phase 1 完成後才能啟動（見 linkedPrev 標記）

---

## 1. 概覽

Phase 1 目標：**在 Tauri 2 桌面殼層上，實作 OAuth 自動化綁定 + Agent 探測機制**，讓用戶可在 30 秒內完成單一 Agent 的完整設定。

本規格基於 ADR-001 決策（採用 Tauri 2 + PKCE OAuth + OS Credential Store），只聚焦 Phase 1 的實作範圍。

### 1.1 驗收標準（spec-first）

- [x] ADR-001 framework decision 已確認（Tauri 2）
- [ ] Spec PR 經 #2 review + merge
- [ ] Phase 1 實作子卡拆分
- [ ] MVP build (macOS + Windows)
- [ ] 1 個 OAuth flow (Google) 跑通
- [ ] 1 個 endpoint 探測 + 驗證
- [ ] 截圖 + smoke test

### 1.2 術語對照

| 術語 | 定義 |
|------|------|
| OAuth flow | Authorization Code + PKCE，system browser → loopback redirect |
| Agent binding | 將 EClaw Desktop 與本地 endpoint（HTTP/WS/subprocess）建立安全連接 |
| Agent probe | 對本地 endpoint 發送識別握手，驗證類型/版本/能力 |
| Device binding | OAuth 成功後在 EClaw backend 註冊此安裝實例 |
| Credential envelope | OS Keychain/Credential Manager 內的加密儲存單元 |

---

## 2. OAuth 自動化流程

### 2.1 流程圖

```
User clicks "Bind Agent"
    ↓
App opens system browser → Google OAuth (PKCE S256)
    ↓
Browser redirects to 127.0.0.1:<random-port>/callback?code=XXX&state=YYY
    ↓
App loopback listener intercepts, exchanges code for tokens
    ↓
Tokens stored in OS Credential Store (macOS Keychain / Windows Credential Manager)
    ↓
Device binding: POST /api/device/bind { deviceId, platform, version, installId }
    ↓
Agent probe: scan configured endpoints → identify agent type/version
    ↓
Binding complete → UI shows success state
```

### 2.2 OAuth 參數

| 參數 | 值 |
|------|---|
| Grant type | Authorization Code + PKCE |
| PKCE method | S256 (SHA-256 code challenge) |
| State entropy | 32 bytes random, Base64URL encoded |
| Nonce | 16 bytes random, stored in session envelope |
| Redirect URI | `http://127.0.0.1:<port>/callback` (dynamic port) |
| Loopback listener timeout | 60 seconds |
| Code exchange | Single-use, immediate listener shutdown after exchange |
| Scopes | `openid profile email` (Google) + EClaw-specific scopes |

### 2.3 失敗處理

| 失敗點 | 行為 |
|--------|------|
| Browser closed before auth | Listener timeout → show "Authentication cancelled" |
| Invalid state/nonce | Log error, do not store tokens, show error |
| Token exchange network failure | Retry once (5s delay), then show error |
| Backend bind failure | Show error with retry option; tokens not stored |
| Probe failure | Allow user to proceed without agent binding; show warning |

### 2.4 Token 儲存契約

```
OS Credential Store
└── EClaw Desktop (app identifier: com.eclaw.desktop)
    └── <installId> (UUID generated at install time)
        ├── refresh_token  (encrypted blob, NEVER exposed to renderer)
        ├── access_token   (encrypted blob, in-memory only)
        ├── id_token       (for session validation)
        └── expires_at     (Unix timestamp)
```

Renderer (WebView) 只透過 Tauri command 間接持有 access token，且不得快取或持久化。

---

## 3. Agent 探測機制

### 3.1 支援的 Agent 類型

| Agent 類型 | 識別方式 | 驗證方法 |
|------------|----------|----------|
| EClaw Hermes | `GET /api/whoami` with Authorization header | Expected `entityId`, `deviceId` in response |
| EClaw Codex | Process enumeration + stdout handshake | `claude --print-password` → expected token format |
| Local HTTP agent | HTTP HEAD to configured host:port | Expected `X-EClaw-Agent` header |
| Subprocess agent | Configured command + argv | Exit code + stdout JSON handshake |

### 3.2 Agent Probe 流程

```
1. Read configured endpoints from local config
2. For each endpoint type:
   a. Hermes: HTTP GET to /api/whoami → parse entityId/deviceId
   b. Codex: osascript/Terminal enumeration → extract --print-password output
   c. HTTP: HTTP HEAD to host:port → check X-EClaw-Agent header
   d. Subprocess: spawn with handshake args → parse stdout JSON
3. Deduplicate: if same agent reachable via multiple paths, show one entry
4. Present user with:
   - Agent name / type / version
   - Connection health (latency + response status)
   - "Bind" / "Skip" / "Configure" actions
```

### 3.3 設定檔格式

```json
// ~/.eclaw-desktop/config.json
{
  "installId": "uuid-v4",
  "version": "0.1.0",
  "platform": "darwin",
  "endpoints": [
    { "type": "hermes", "url": "http://localhost:18792", "enabled": true },
    { "type": "codex", "command": "/usr/local/bin/claude", "enabled": false }
  ],
  "lastBinding": {
    "agentType": "hermes",
    "agentId": "entity_5",
    "timestamp": 1781794034
  }
}
```

Config file never contains tokens or secrets.

---

## 4. 三段式用戶體驗（Globe-user / Setup / ? icon）

### 4.1 Globe-user 視角

一般用戶首次開啟 EClaw Desktop，看到：

1. **Welcome screen**: 「歡迎使用 EClaw Desktop」+ 產品截圖
2. **Single CTA**: 「開始設定」（藍色主按鈕）
3. **無任何技術術語**：不出現 OAuth/PKCE/endpoint/credential 等詞
4. **隱私宣言**: 「您的認證資料只存在本機，不会上传到服务器」

### 4.2 Setup 流程（30 秒目標）

| 步驟 | 畫面 | 倒數計時 |
|------|------|----------|
| Step 1 | 點擊「開始設定」 | — |
| Step 2 | 系統瀏覽器開啟 OAuth → 用戶登入 Google | 25s |
| Step 3 | 回到 App → 「正在連接...」動畫 | 5s |
| Step 4 | Agent 探測中 → 顯示找到的 Agent | — |
| Step 5 | 「設定完成！」成功畫面 + 截圖按鈕 | — |

**30 秒假設**：用戶已有 Google 登入狀態，網路正常，localhost 可達。

### 4.3 ? icon 說明

每個技術決策點附 `?` icon，hover/click 顯示白話說明：

| 位置 | 說明內容 |
|------|----------|
| OAuth 步驟 | 「EClaw 使用您信任的 Google 帳號登入，不需要另行註冊。」 |
| 資料儲存 | 「您的登入資料會加密存在您電腦的鑰匙圈（Mac）或認證管理員（Windows），EClaw 伺服器無法讀取。」 |
| Agent 探測 | 「EClaw 會掃描您電腦上已安裝的 EClaw 工具，自動幫您完成設定。」 |
| 失敗重試 | 「如果連接失敗，EClaw 會保存您的設定，下次開啟時自動重試。」 |

---

## 5. 系統權限與最小權限

### 5.1 Required Permissions

| 權限 | 用途 | 是否可選 |
|------|------|----------|
| Network (outbound) | OAuth callback, agent probe, backend bind | Required |
| Keychain/Credential Manager read/write | Token storage | Required |
| Localhost network (inbound) | OAuth loopback listener | Required |
| Process enumeration (macOS) | Codex agent detection | Optional (skip if not found) |
| File system (config dir) | Read/write app config | Required |
| Notifications | Install/update success/failure | Optional |

### 5.2 最小權限原則

- App 預設拒絕所有權限，只在需要時申請
- 不要求：麥克風、相機、螢幕錄製、完整磁碟存取
- 申請系統權限前，必須先展示 `?` icon 說明為何需要

---

## 6. 本地安全儲存

### 6.1 儲存分層

| 資料 | 儲存位置 | 加密 |
|------|----------|------|
| Refresh token | OS Credential Store | OS-level encryption (Keychain/Credential Manager) |
| Access token | In-memory only | N/A |
| Config metadata | `~/.eclaw-desktop/config.json` | No (no secrets) |
| Operation logs | `~/.eclaw-desktop/logs/` | No (redacted) |
| Backup configs | `~/.eclaw-desktop/backups/` | No (no tokens) |

### 6.2 安全紅線

- **永不**：將 refresh token 寫入磁碟、localStorage、IndexedDB、log、screenshot、crash report
- **永不**：在 renderer process 中暴露 credential store 直接讀取能力
- **所有**：Tauri command input 必須 schema-validated

---

## 7. 自動更新機制

### 7.2 Update Flow

```
App launch → check GitHub Releases JSON (or dynamic endpoint)
    ↓
Compare semantic version
    ↓
If newer: show "Update available" notification (not forced)
    ↓
User clicks "Update Now" → download signed artifact
    ↓
Verify signature + code sign notarization
    ↓
Stage new version + run health gate
    ↓
On success: promote to active + show "Updated to vX.Y.Z"
    ↓
On failure: rollback to previous version + show error
```

### 7.2 簽章需求

| 平台 | 簽章類型 |
|------|----------|
| macOS | Apple notarization + Developer ID signing |
| Windows | Microsoft Authenticode (codesign) + optional EV |

---

## 8. 安裝路徑智慧偵測

### 8.1 預設路徑

| 平台 | 預設安裝路徑 |
|------|-------------|
| macOS | `~/Applications/EClaw Desktop.app` |
| Windows | `%LOCALAPPDATA%\EClaw Desktop` (per-user) |
| Windows (admin) | `%ProgramFiles%\EClaw Desktop` (system-wide) |

### 8.2 偵測邏輯

1. 檢查使用者是否有寫入 `~/Applications` / `%LOCALAPPDATA%` 的權限
2. 若無，提示「需要管理員權限」並提供 system-wide 安裝選項
3. 若磁碟空間不足（< 200MB），阻擋安裝並顯示說明
4. 若路徑已存在舊版，詢問「升級」或「全新安裝」

---

## 9. 子卡拆分建議（Phase 1 實作）

Phase 1 merge spec PR 後，拆為以下子卡：

| 子卡 | 負責人 | Scope |
|------|--------|-------|
| P1-A | TBD | Tauri 2 scaffold + 本地 UI bundle |
| P1-B | TBD | OAuth flow (system browser + loopback + token exchange) |
| P1-C | TBD | OS Credential Store 整合（macOS Keychain + Windows CredMgr） |
| P1-D | TBD | Device binding API 對接 |
| P1-E | TBD | Agent probe 機制實作 |
| P1-F | TBD | 30s onboarding UI + Globe-user flow |
| P1-G | TBD | Installer build (macOS DMG + Windows MSI/NSIS) |
| P1-H | TBD | Auto-update + rollback 機制 |
| P1-I | TBD | Smoke E2E + uninstall verification |

每張子卡走 spec-first，先審後寫 code。

---

## 10. i18n 需求

- 所有 UI 字串走 i18n key（EN + ZH-TW + 全 locale）
- `?` icon 說明需納入 i18n dictionary
- OAuth 錯誤訊息本地化
- 技術術語（如 Keychain）在 `?` icon tooltip 中以使用者語言呈現

---

## 11. 排除範圍（Phase 2/3）

以下項目不列入 Phase 1：

- 多 Agent 同時綁定（Phase 2 配置引擎）
- 備份/恢復 UI（Phase 3）
- 跨設備同步（Phase 3）
- 自動安裝程式簽章（Phase 3）

---

## 12. 參考文獻

- [ADR-001: Desktop App Framework](./desktop-app-adr-001-framework.md)
- [Tauri 2 Security Model](https://v2.tauri.app/security/)
- [Tauri Updater](https://v2.tauri.app/plugin/updater/)
- [macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/)
- [Windows Code Signing](https://v2.tauri.app/distribute/sign/windows/)
