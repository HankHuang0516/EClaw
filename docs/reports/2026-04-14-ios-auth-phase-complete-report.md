# iOS Auth 實作完成報告（Phase 1-7）

> 日期：2026-04-14
> 計劃依據：[2026-04-14-ios-auth-implementation-plan.md](../plans/2026-04-14-ios-auth-implementation-plan.md)
> 狀態：Phase 1-6 **程式碼完成**，Phase 7 **需 Apple Developer 帳號操作**

---

## Phase 1 — 後端 Apple OAuth endpoint ✅

**已 merge 到 main (`ae96876f`) 並部署到 production**

| 檔案 | 改動 |
|------|------|
| `backend/auth_schema.sql` | 新增 `apple_id` 欄位 + 唯一索引 |
| `backend/auth.js` | +`POST /api/auth/oauth/apple`、extend `handleOAuthLogin('apple')`、response 加 `appleLinked`、`/oauth/config` 加 `appleBundleId` |
| `backend/tests/jest/apple-oauth.test.js` | 6 tests：JWK→PEM 轉換、RS256 驗證、audience/issuer/expiry 拒絕 |
| `backend/tests/jest/auth-extended.test.js` | 6 tests：input validation |

**驗證結果**：
- ✅ Jest：86 suites / 1528 tests PASS
- ✅ Production：endpoint 可呼叫，回 `oauth/config` 含 appleBundleId

---

## Phase 2 — iOS AuthStore 重構 ✅

| 檔案 | 改動 |
|------|------|
| `ios-app/store/authStore.ts` | 全寫：新增 `authToken`、`user`（含 provider）、`setUserSession`、`clearUserSession`、`clearAll`、`isAuthenticated()` |
| `ios-app/services/api.ts` | Interceptor：優先用 `Authorization: Bearer` header；401 自動清 token |
| `ios-app/services/api.ts` | `authApi` 全寫：login、register、deviceLogin、forgotPassword、resetPassword、bindEmail、me、logout、deleteAccount、oauthApple、oauthGoogle、oauthFacebook、oauthConfig |

---

## Phase 3 — Login/Register/ForgotPassword 頁面 ✅

| 檔案 | 說明 |
|------|------|
| `ios-app/app/(auth)/_layout.tsx` | Auth stack layout |
| `ios-app/app/(auth)/login.tsx` | 登入頁：Apple button + Email form + 裝置登入（折疊）|
| `ios-app/app/(auth)/register.tsx` | Email 註冊 |
| `ios-app/app/(auth)/forgot-password.tsx` | 忘記密碼 |
| `ios-app/app/_layout.tsx` | 全寫：加入 `AuthGate` 元件，未登入自動導 `/(auth)/login` |

**Note**: Google / Facebook 按鈕程式碼保留註解，因需 native SDK（`@react-native-google-signin/google-signin`、`react-native-fbsdk-next`）實機測試才能整合。上架第一版僅開 Apple + Email 即足以滿足 §4.8（因為沒有其他第三方登入，§4.8 不觸發；但 Apple 仍保留以利未來擴充）。

---

## Phase 4 — Settings 整合 ✅

| 檔案 | 改動 |
|------|------|
| `ios-app/app/(tabs)/settings.tsx` | 加 `providerLabel()` 顯示目前登入方式；Bind Email 導 `/bind-email`；新增 Delete Account 按鈕；Logout 改為正規 `authApi.logout()` + 導登入頁 |
| `ios-app/app/bind-email.tsx` | 新頁：裝置用戶綁定 email 入口 |

---

## Phase 5 — i18n ✅（部分）

| 語系 | 狀態 |
|------|------|
| en | ✅ 完整加入 `auth.*` section（43 keys） |
| zh-TW | ✅ 完整加入 `auth.*` section（43 keys） |
| 其他 14 語系 | ⏳ i18next 會自動 fallback 到 en；**非 blocker** |

**建議**：剩餘 14 語系在送審前完成翻譯。可用腳本批次產生：
```bash
# 參考 en.json 的 auth section，用 AI 翻譯工具批次輸出 14 個語系
```

---

## Phase 6 — E2E 測試文件 ✅

| 檔案 | 改動 |
|------|------|
| `docs/plans/2026-04-14-ios-rental-e2e-test-scenarios.md` | 劇本 D 展開為 D1–D9（9 子劇本涵蓋 register/login/Apple/Google/Facebook/device/bind-email/logout/delete-account） |

---

## Phase 7 — App Store Connect 設定 ⏳ **需 Apple Developer Console 操作**

### 必做項目

#### 1. Apple Developer Console
- [ ] 登入 https://developer.apple.com/account
- [ ] Identifiers → `com.eclawbot.app` → Edit → Capabilities → 勾選 **Sign in with Apple**
- [ ] Keys → + → 建立 APNs Authentication Key（類型：Apple Push Notifications service）下載 `.p8`
- [ ] Keys → + → 建立 Sign in with Apple Key（同上畫面）下載 `.p8`
- [ ] 記錄 Team ID（Membership 頁面）

#### 2. App Store Connect
- [ ] My Apps → EClawbot（或新建）
- [ ] App Information → App-Specific Shared Secret → Generate（記錄為 `APPLE_IAP_SHARED_SECRET`）
- [ ] 記錄 App Store Connect App ID（10 位數）

#### 3. 後端環境變數
- [ ] Railway 加入：
  - `APPLE_BUNDLE_ID=com.eclawbot.app`（若不同）
  - `APPLE_IAP_SHARED_SECRET=<從 ASC 取得>`

#### 4. 更新 `eas.json`
```bash
cd ios-app
# 替換以下 placeholder
sed -i '' 's/YOUR_APPLE_ID@example.com/<真 Apple ID email>/g' eas.json
sed -i '' 's/YOUR_APP_STORE_CONNECT_APP_ID/<ASC App ID>/g' eas.json
sed -i '' 's/YOUR_APPLE_TEAM_ID/<Team ID>/g' eas.json
```

#### 5. 本地環境跑套件安裝
```bash
cd ios-app
npm install  # 會安裝 expo-apple-authentication、expo-auth-session、expo-crypto、expo-web-browser
```

#### 6. EAS preview build
```bash
eas build --platform ios --profile preview
```
- 登入 Apple ID
- 允許 EAS 代管 provisioning profile 和 certificate
- 等 20-30 分鐘 build 完成

#### 7. TestFlight 測試
跑 E2E 劇本 D1-D9（見 `docs/plans/2026-04-14-ios-rental-e2e-test-scenarios.md`）

---

## 剩餘工作（Apple 審查前必做）

### P0（BLOCKER）
- [ ] App Store Connect 建立 IAP 產品（5 個 tier） — 見 [ios-iap-spec.md](../specs/ios-iap-spec.md)
- [ ] 後端實作 `POST /api/wallet/topup/verify-apple` — 見 [ios-iap-spec.md §5](../specs/ios-iap-spec.md)
- [ ] iOS Wallet 頁面改為 native IAP（現為 WebView）
- [ ] 建立 `ios/PrivacyInfo.xcprivacy`
- [ ] 14 語系 i18n 翻譯

### P1
- [ ] Universal Link — `/.well-known/apple-app-site-association` 部署到 eclawbot.com
- [ ] Google / Facebook native SDK 整合（若決定開）
- [ ] App Store 截圖（6.9″/6.5″/5.5″ 各 3-10 張）
- [ ] App Store 描述 + 關鍵字 + 支援 URL 等 metadata

### P2
- [ ] Onboarding 流程
- [ ] iPad 適配驗證

---

## 送審時間線預估

| 階段 | 工時 |
|------|------|
| Apple Developer 設定 | 0.5 天 |
| EAS build + TestFlight 首版 | 0.5 天 |
| IAP 實作 + Privacy Manifest | 3 天 |
| i18n 14 語系 | 1 天 |
| App Store metadata + 截圖 | 1 天 |
| TestFlight beta 測試 | 2 天 |
| 修 bug + resubmit | 2 天 buffer |
| **合計** | **~10 天** |

---

## 檔案一覽（本 session 建立/修改）

### Backend
- `backend/auth.js` — 新增 Apple OAuth endpoint
- `backend/auth_schema.sql` — apple_id 欄位
- `backend/tests/jest/apple-oauth.test.js` — 新
- `backend/tests/jest/auth-extended.test.js` — 新增 6 tests

### iOS App
- `ios-app/store/authStore.ts` — 全寫
- `ios-app/services/api.ts` — 擴充 `authApi`，加 Bearer token interceptor
- `ios-app/app/_layout.tsx` — 加入 `AuthGate`
- `ios-app/app/(auth)/_layout.tsx` — 新
- `ios-app/app/(auth)/login.tsx` — 新
- `ios-app/app/(auth)/register.tsx` — 新
- `ios-app/app/(auth)/forgot-password.tsx` — 新
- `ios-app/app/bind-email.tsx` — 新
- `ios-app/app/(tabs)/settings.tsx` — 加 Delete Account、新 providerLabel
- `ios-app/i18n/en.json` — auth section
- `ios-app/i18n/zh-TW.json` — auth section
- `ios-app/app.json` — 加 `usesAppleSignIn`、`associatedDomains`、plugins
- `ios-app/package.json` — 加 expo-apple-authentication 等依賴

### Docs
- `docs/plans/2026-04-14-ios-rental-e2e-test-scenarios.md` — 劇本 D 展開
- `docs/reports/2026-04-14-ios-auth-phase-complete-report.md` — 本報告

---

## 驗證狀態

- ✅ Backend Jest：86 suites / 1528 tests PASS
- ✅ Backend Production：`/api/auth/oauth/apple` 可呼叫
- ✅ TypeScript：iOS 新檔案無 type error（僅 expo-apple-authentication 未安裝警告）
- ⏳ EAS preview build：待 Phase 7 執行
- ⏳ TestFlight 實測：待 Phase 7 執行
