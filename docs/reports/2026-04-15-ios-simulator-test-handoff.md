# iOS Simulator 測試交接文件

> 建立日期：2026-04-15
> 目的：iOS Simulator 上驗證 EClawbot App 的 Phase 2-6 認證系統
> 目標讀者：另一個 Claude Code 執行者（或人類 tester）
> 狀態：Build 4768db25 已觸發，完成後可安裝測試

---

## 背景

EClawbot iOS App 剛完成認證系統重構（方案 C：完整帳號系統）。送審前需在 Simulator 先驗證主要流程。

**重要限制**：Apple Sign-In **無法**在 Simulator 穩定測試（需實機 TestFlight）。本測試涵蓋其他 6 項功能。

**相關文件**：
- 實作計劃：[`docs/plans/2026-04-14-ios-auth-implementation-plan.md`](../plans/2026-04-14-ios-auth-implementation-plan.md)
- iOS 平台規範：[`docs/specs/ios-app-spec.md`](../specs/ios-app-spec.md)
- E2E 測試場景：[`docs/plans/2026-04-14-ios-rental-e2e-test-scenarios.md`](../plans/2026-04-14-ios-rental-e2e-test-scenarios.md)

---

## 環境資訊

| 項目 | 值 |
|------|---|
| 作業系統 | macOS (Darwin) |
| 專案目錄 | `/Users/hank/Desktop/Project/EClaw/ios-app` |
| Bundle ID | `com.eclawbot.app` |
| 後端 URL | `https://eclawbot.com` |
| EAS 專案 | `@hank_huang0516_2/eclawbot`（projectId: `9e492c28-9aa9-4bab-997d-780d7eb500ed`） |
| Apple Team | `KLBQRT47CT` (Pin Huang) |
| App Store Connect App ID | `6762198865` |
| Build ID（待測） | `4768db25-8ee1-4742-80ac-a562a8bc6dcf` |

---

## Step 1：下載 Simulator Build

```bash
cd /Users/hank/Desktop/Project/EClaw/ios-app

# 查看 build 狀態（應為 "finished"）
eas build:view 4768db25-8ee1-4742-80ac-a562a8bc6dcf

# 取得下載 URL
eas build:view 4768db25-8ee1-4742-80ac-a562a8bc6dcf --json 2>/dev/null | python3 -c "
import json,sys
d = json.load(sys.stdin)
url = d[0].get('artifacts', {}).get('buildUrl') or d[0].get('applicationArchiveUrl')
print(url)
"
```

如果 build 還在跑，等 4-8 分鐘。若 errored，看 log：
```bash
eas build:list --limit 1 --json > /tmp/build.json
grep -oE 'https://job-logs.eascdn.net[^"]*' /tmp/build.json | tail -1 | xargs curl -s | tail -50
```

---

## Step 2：安裝到 Simulator

```bash
# 下載 .tar.gz
BUILD_URL=$(eas build:view 4768db25-8ee1-4742-80ac-a562a8bc6dcf --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['artifacts']['applicationArchiveUrl'])")

curl -o /tmp/eclaw.tar.gz "$BUILD_URL"

# 解壓
mkdir -p /tmp/eclaw-build
tar -xzf /tmp/eclaw.tar.gz -C /tmp/eclaw-build

# 找 .app
APP_PATH=$(find /tmp/eclaw-build -name "*.app" -maxdepth 3 | head -1)
echo "App: $APP_PATH"

# 開 Simulator（若沒開）
open -a Simulator

# 等 simulator boot
sleep 10

# 列出可用裝置
xcrun simctl list devices booted

# 若沒有 booted device，啟動一個
# xcrun simctl boot "iPhone 16"

# 安裝
xcrun simctl install booted "$APP_PATH"

# 啟動
xcrun simctl launch booted com.eclawbot.app
```

**成功啟動**：Simulator 會顯示 E-Claw 的 Splash Screen 然後進入登入頁。

---

## Step 3：執行 6 項測試

**使用 Playwright MCP 無法直接控制 Simulator**（Playwright 只能用瀏覽器）。

**使用 iOS Simulator Automation**：用 `xcrun simctl` 指令 + 螢幕截圖 + 手動點擊。

或最實際的做法：**手動操作 + 截圖記錄**。

### 截圖工具
```bash
# 截圖 Simulator 當前畫面
xcrun simctl io booted screenshot /tmp/simulator-$(date +%s).png
# Mac 預覽開啟
open /tmp/simulator-*.png
```

### 測試案例

#### Test #1 — 首次開 App 導登入頁

**操作**：App 啟動

**預期**：
- 顯示 "🦞 EClawbot" Logo
- 下方有 Apple Sign-In 黑色按鈕（模擬器按下會失敗，**不要點**）
- 分隔線下有 Email / Password 輸入框
- 下方有 "Register | Forgot Password?" 連結
- 最底有 "Device Login (Advanced)" 折疊按鈕

**驗證方法**：
```bash
xcrun simctl io booted screenshot /tmp/test1-login-page.png
open /tmp/test1-login-page.png
# 人眼看：Apple 按鈕 + Email form + 底下連結都在
```

**可能 bug**：
- 如果導 Tab Bar 而不是登入頁 → AuthGate 邏輯錯（_layout.tsx）
- 如果 UI 白屏 → 有 JS 錯誤，看 simulator Console
- 如果 Apple 按鈕不見 → `appleAvailable` 判斷錯

---

#### Test #2 — Email 註冊流程

**操作**：
1. 登入頁點「Register」連結
2. 填：
   - Email: `sim-test-$(date +%s)@test.com`（動態 email 避免重複）
   - Display Name: `Sim Tester`
   - Password: `test1234` （≥6 字）
   - Confirm Password: `test1234`
3. 點「Register」按鈕

**預期**：
- 顯示 Alert「Registration successful」
- 按 OK 後導回登入頁

**後端驗證**：
```bash
# 檢查 user_accounts 表是否有新記錄
# （需要 admin API 或直接 DB 查）
curl -s "https://eclawbot.com/api/auth/me" \
  -H "Authorization: Bearer TOKEN" 2>&1 | python3 -m json.tool
```

**可能 bug**：
- Validation 錯誤卻顯示成功 → 前端驗證缺失
- 成功但沒寄驗證信 → 後端 Resend 設定問題（非 blocker）
- 密碼不合格卻通過 → 前端驗證 bug

---

#### Test #3 — Email 登入

**操作**：
1. 用剛註冊的帳號登入
2. 填 Email + Password
3. 點「Login」

**預期**：
- 成功後導向 (tabs)/index（Dashboard）
- 顯示空 entity 列表或 binding code 產生器

**後端驗證**：
```bash
# 直接 call login 看 response
curl -s -X POST "https://eclawbot.com/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"剛註冊的 email","password":"test1234"}' | python3 -m json.tool
```

**可能 bug**：
- 401 密碼錯誤 → 後端密碼 hash 問題
- 成功但 UI 沒跳轉 → AuthGate 沒偵測到 authToken
- Dashboard 白屏 → useEntities hook 錯

---

#### Test #4 — Settings 顯示登入方式

**操作**：
1. 已登入狀態
2. Tab Bar 點「設定」（Settings / ⚙️）

**預期**：
- Account 區塊顯示：
  - Email: 剛註冊的 email
  - Provider label: **"Signed in with Email"**
- 不應出現「Bind Email」按鈕（因為已是 email 用戶）
- 最底有「Logout」按鈕（outlined）
- 其下有「Delete Account」按鈕（紅色 text-only）

**可能 bug**：
- Provider label 顯示「Device-only authentication」→ authStore.user.provider 沒存對
- 仍顯示 Bind Email CTA → 條件判斷 `!user?.email` 錯

---

#### Test #5 — Bind Email 頁面（裝置用戶路徑）

**前置**：先登出，用「Device Login (Advanced)」模式登入（不建議新用戶做，但可測）。

**或跳過**：Email 用戶不需 bind-email，這個頁面是給**純裝置認證的舊用戶**用的。

**驗證 bind-email.tsx 能正常 render**（即使不真 bind）：

**操作**：
1. 登出
2. 點登入頁「Device Login (Advanced)」
3. 填任意 deviceId + deviceSecret（或真的 production 的）
4. 登入後 Settings 會顯示「Device-only authentication」
5. Bind Email CTA 出現 → 點擊開啟 bind-email.tsx

**預期**：
- 標題「Bind Email」
- 3 個輸入框（Email, Password, Confirm Password）
- 「Bind Email」主按鈕 + 「Cancel」次按鈕

**實際測試 production deviceId 的值**：
```
deviceId: 480def4c-2183-4d8e-afd0-b131ae89adcc
deviceSecret: REDACTED-ASK-HANK-FOR-VALUE
```
（這是 hank 的裝置，**不要真的 bind email**，只是測 UI）

---

#### Test #7 — 跨平台帳號互通（最重要）

**目的**：驗證 Web 已註冊 + 綁定實體的帳號，iOS 登入能看到同樣資料。

**前置**：
- 需要一個 Web Portal 已註冊的帳號（含綁定 entity、有錢包餘額）
- **使用 hank 的正式帳號驗證**（最真實，但不要改資料）

#### 建議測試帳號

| 用途 | 帳號 |
|------|------|
| Web 已註冊 + 綁定 | `bbb880008@gmail.com`（hank 主要帳號）|
| deviceId | `480def4c-2183-4d8e-afd0-b131ae89adcc` |
| 預期綁定的 entities | #0/#1/#2/#3 四個已綁定（Claude/Mac_E/Mac_F/主管）|

**警告**：這是 production 帳號，**只能 READ，不要刪除 entity 或加值**。

#### 測試流程

##### 7.1 取得 hank 的 email 登入密碼

**問題**：hank 的帳號可能是 Google/FB OAuth 登入，沒有密碼。

解法 1 — 先檢查帳號類型：
```bash
# 呼叫後端 /api/auth/providers 看 bbb880008@gmail.com 是哪種
# 若 Google OAuth，iOS Simulator 無法測（同 Apple Sign-In 問題）
```

解法 2 — 用 forgot-password 設一個密碼：
```bash
curl -s -X POST "https://eclawbot.com/api/auth/forgot-password" \
  -H "Content-Type: application/json" \
  -d '{"email":"bbb880008@gmail.com"}'
# 收 email → 點重設連結 → 設臨時密碼（測完改回）
```

**推薦解法 3**：用 **device login** 測跨平台互通：

##### 7.2 Device Login 驗證（最安全）

hank 的 deviceId/deviceSecret 可以換 JWT，登入後 App 應看到所有綁定的 entity 和聊天記錄。

**操作**：
1. iOS App 登出
2. 登入頁 → Device Login (Advanced)
3. 填：
   - deviceId: `480def4c-2183-4d8e-afd0-b131ae89adcc`
   - deviceSecret: `REDACTED-ASK-HANK-FOR-VALUE`
4. 點 Login with Device

**預期**：
- 登入成功
- Dashboard 顯示 **4 個綁定的 entities**（#0/#1/#2/#3）
- 可切到 Chat tab 看到歷史訊息
- Wallet 顯示 hank 的真實餘額（不是 0）
- Settings 顯示「Device-only authentication」
- 有 Bind Email CTA（因為裝置帳號無 email 記錄）

**後端驗證**：
```bash
# 這個 deviceId 真的存在 + 有 entity
curl -s "https://eclawbot.com/api/entities?deviceId=480def4c-2183-4d8e-afd0-b131ae89adcc&deviceSecret=REDACTED-ASK-HANK-FOR-VALUE" | python3 -c "import json,sys; print('entity count:', len([e for e in json.load(sys.stdin).get('entities',[]) if e.get('isBound')]))"
# 應為 4
```

##### 7.3 iOS 端登出 → 用 Web 帳號登入（若有密碼）

**操作**：
1. iOS 登出
2. 填 `bbb880008@gmail.com` + 設過的臨時密碼
3. 登入

**預期**：
- 登入成功
- **看到同樣的 4 個 entities**（Web 和 iOS 共用 user → device 映射）
- 驗證跨平台資料一致性

##### 7.4 iOS 端 Bind Email 後 Web 驗證

**操作（若有時間測）**：
1. 建一個**新**裝置帳號（透過 Android 或 API 產生 deviceId）
2. iOS 以新 deviceId device-login
3. Settings → Bind Email → 填一個未用過的 email
4. 確認綁定成功
5. **切到 Web Portal** 同帳號登入 → 看是否能看到同樣資料

**預期**：綁定後 iOS 和 Web 看到相同 entity、chat history、wallet balance。

---

#### Test #8 — Logout 清除 session

**操作**：
1. Settings 點「Logout」
2. Alert 確認

**預期**：
- 自動跳回登入頁（/(auth)/login）
- SecureStore 的 authToken + user_profile 已清
- deviceId + deviceSecret **保留**（為下次裝置登入方便）

**驗證**：
```bash
# 模擬器 SecureStore 在本機 Keychain
# 登出後 authToken 應已清
# 可以在 App 重啟後看是否直接跳登入頁（不是 Tab Bar）
```

**可能 bug**：
- Logout 後仍留在 Tab Bar → AuthGate redirect 邏輯錯
- deviceId 也被清掉 → clearUserSession vs clearAll 搞混

---

## Step 4：回報測試結果

建立測試報告 `docs/reports/2026-04-15-ios-simulator-test-results.md`：

```markdown
# iOS Simulator 測試結果 — 2026-04-15

## 執行環境
- Simulator: iPhone 16 (iOS 17.x)
- Build: 4768db25-8ee1-4742-80ac-a562a8bc6dcf
- Commit: （跑 `git rev-parse HEAD`）

## 測試結果

| # | 測試 | 結果 | 截圖 | Bug |
|---|------|------|------|-----|
| 1 | 首次開 App 導登入頁 | ✅/❌ | test1-login-page.png | - |
| 2 | Email 註冊 | ✅/❌ | test2-register.png | - |
| 3 | Email 登入 | ✅/❌ | test3-login.png | - |
| 4 | Settings provider 顯示 | ✅/❌ | test4-settings.png | - |
| 5 | Bind Email 頁面渲染 | ✅/❌ | test5-bind.png | - |
| **7** | **跨平台帳號互通（Device Login）** | **✅/❌** | **test7-cross-platform.png** | **-** |
| 8 | Logout 清 session | ✅/❌ | test8-logout.png | - |

## 發現 Bugs

（若有 bug 逐項描述：現象、重現步驟、預期 vs 實際、Console log、截圖）

## 截圖位置
/tmp/test*.png

## 建議
（如有）
```

---

## 疑難排解

### 問題 A：Simulator 啟動 App 後白屏

**查 log**：
```bash
xcrun simctl spawn booted log stream --level debug --predicate 'process == "E-Claw"' 2>&1 | head -50
```

常見原因：
- `expo-apple-authentication` 未正確初始化 → 看 error stack
- JavaScript 錯誤 → Metro bundler 沒 attach（simulator 是 release build，不需要）

### 問題 B：無法下載 build artifact

```bash
# Re-login EAS
eas logout
eas login
# 再試
```

### 問題 C：`xcrun simctl install` 失敗

```bash
# 確認 .app 存在
ls -la $APP_PATH
# 確認 bundle id
plutil -p "$APP_PATH/Info.plist" | grep BundleIdentifier
# 應為 com.eclawbot.app

# 重啟 simulator
xcrun simctl shutdown booted
xcrun simctl boot "iPhone 16"
xcrun simctl install booted "$APP_PATH"
```

### 問題 D：Apple Sign-In 按鈕顯示但按下沒反應

**預期行為**：Simulator 對 Apple Sign-In 支援有限，按下可能：
- 無反應
- 跳出「發生錯誤，請稍後再試」
- 跳出 Face ID simulation 但失敗

**這是 Simulator 已知限制，不是 App bug**。用 TestFlight 實機測才準。

---

## 後端 API 參考（給 debug 用）

| Endpoint | 用途 |
|----------|------|
| `POST /api/auth/register` | Email 註冊 |
| `POST /api/auth/login` | Email 登入 |
| `POST /api/auth/device-login` | 裝置登入 |
| `POST /api/auth/oauth/apple` | Apple Sign-In（Simulator 不測） |
| `POST /api/auth/bind-email` | 綁定 Email |
| `POST /api/auth/logout` | 登出 |
| `DELETE /api/auth/account` | 刪除帳號 |
| `GET /api/auth/me` | 取得當前用戶 |
| `GET /api/auth/oauth/config` | OAuth 設定（檢查 Apple 是否開啟）|

**驗證後端 Apple endpoint 存在**：
```bash
curl -s -X POST "https://eclawbot.com/api/auth/oauth/apple" -H "Content-Type: application/json" -d '{}'
# 應回 400 with "identityToken required"

curl -s "https://eclawbot.com/api/auth/oauth/config" | python3 -m json.tool
# appleEnabled 應為 true
```

---

## 附錄 A：Simulator 快捷鍵

| 操作 | 快捷鍵 |
|------|--------|
| 回主畫面 | Cmd + Shift + H |
| 重啟 App | Cmd + Shift + H + H |
| 軟鍵盤開關 | Cmd + K |
| 搖一搖（觸發 RN dev menu） | Cmd + Ctrl + Z |
| 截圖到桌面 | Cmd + S |
| 錄影 | File → Record Screen |

---

## 附錄 B：測試完成後

測試結束後，移除安裝：

```bash
xcrun simctl uninstall booted com.eclawbot.app
rm -rf /tmp/eclaw-build
rm -f /tmp/eclaw.tar.gz
rm -f /tmp/test*.png
```

---

## 總結

- ✅ 6 項 Simulator 可測
- ❌ 2 項（Apple Sign-In）必須實機 TestFlight
- 📸 每項都截圖
- 📝 填回報 markdown
- 🐛 Bug 用 `[BUG-iOS-{NNN}]` 格式編號

完成後告訴 hank 結果，他會決定是否推進 IAP 階段。
