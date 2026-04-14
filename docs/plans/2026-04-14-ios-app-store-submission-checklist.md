# iOS App Store 上架 Checklist

> **建立日期**: 2026-04-14
> **目標**: EClawbot iOS v1.0.0 送審通過並上架
> **依據**: [ios-app-spec.md](../specs/ios-app-spec.md)、[ios-iap-spec.md](../specs/ios-iap-spec.md)、[Mobile Parity Gap](./2026-04-14-brm-mobile-parity-gap.md)

---

## 使用方式

- 🔴 **P0**：不處理會被 Apple 拒，**必須全部完成才能送審**
- 🟠 **P1**：Apple 會檢查但有變通方案
- 🟡 **P2**：建議但非強制
- ✅ = 已完成、⬜ = 待處理、⏸️ = 不做、⚠️ = 有風險

---

## P0 — 送審前絕對必要

### 1. Apple 開發者帳號與憑證

- ⬜ 確認 Apple Developer Program 年費 $99 USD 已繳（有效）
- ⬜ App Store Connect 建立 App 紀錄（Bundle ID `com.eclawbot.app`）
- ⬜ 取得 Apple Team ID（Apple Developer → Membership）
- ⬜ 取得 App Store Connect App ID（10 位數）
- ⬜ 建立 App-Specific Shared Secret（App Information → App-Specific Shared Secret）→ 記錄為 `APPLE_IAP_SHARED_SECRET`
- ⬜ 建立 APNs Key（Certificates, Identifiers & Profiles → Keys → `+` → Apple Push Notifications service (APNs)）下載 `.p8` 檔

### 2. IAP 設定（參照 [ios-iap-spec.md](../specs/ios-iap-spec.md)）

- ⬜ App Store Connect 建立 5 個 Consumable IAP 產品：
  - ⬜ `ec.topup.small` ($0.99 / $1 tier)
  - ⬜ `ec.topup.starter` ($2.99)
  - ⬜ `ec.topup.standard` ($4.99)
  - ⬜ `ec.topup.advanced` ($9.99)
  - ⬜ `ec.topup.premium` ($19.99)
- ⬜ 每個產品填寫所有語系的 Display Name + Description
- ⬜ 每個產品上傳 Review Screenshot
- ⬜ `react-native-iap` 安裝並整合到 `wallet.tsx`
- ⬜ 後端新增 `POST /api/wallet/topup/verify-apple` endpoint
- ⬜ `wallet_ledger` 新增 `apple_transaction_id` 唯一索引（防重複入帳）
- ⬜ 新增環境變數 `APPLE_IAP_SHARED_SECRET`、`APPLE_IAP_ENV`
- ⬜ Sandbox tester 測試 T1–T6 全通過

### 3. Privacy Manifest

- ⬜ 建立 `ios-app/ios/PrivacyInfo.xcprivacy`（見 [ios-app-spec.md §5.1](../specs/ios-app-spec.md)）
- ⬜ 宣告收集的資料類型（email、deviceId、productInteraction 等）
- ⬜ 宣告 Required Reason API（UserDefaults、FileTimestamp、DiskSpace 等）
- ⬜ `NSPrivacyTracking: false`（確認無 3rd party tracking）

### 4. Sign in with Apple

- ⬜ `expo-apple-authentication` 安裝
- ⬜ Xcode Capabilities 啟用 `Sign in with Apple`
- ⬜ App Store Connect → App ID → Capabilities 勾選 Sign in with Apple
- ⬜ iOS 登入頁加入 Apple Sign-In 按鈕
- ⬜ 後端新增 `POST /api/auth/oauth/apple`
- ⬜ 後端驗證 Apple identity token（用 Apple 公鑰 JWKS）
- ⬜ 與 Google/Facebook 登入一起顯示（不可只有 Apple）

### 5. `eas.json` 填入真實值

- ⬜ 替換 `appleId`: `YOUR_APPLE_ID@example.com` → 真 email
- ⬜ 替換 `ascAppId`: 實際 10 位數
- ⬜ 替換 `appleTeamId`: 實際 Team ID

### 6. Info.plist / app.json 權限說明本地化

- ⬜ `NSCameraUsageDescription`：中英對照清楚用途
- ⬜ `NSPhotoLibraryUsageDescription`：中英對照清楚用途
- ⬜ `NSPhotoLibraryAddUsageDescription`：中英對照清楚用途
- ⬜ `NSMicrophoneUsageDescription`：中英對照清楚用途
- ⬜ 每個說明**不得含糊**（例：「為了 App 功能」會被拒）

### 7. App Store 資料頁（App Store Connect）

- ⬜ App Name: `EClawbot`
- ⬜ Subtitle（30 字）: 如「AI Agent Collaboration Hub」
- ⬜ 類別主/副：Productivity / Social Networking
- ⬜ 年齡分級填寫（4+）
- ⬜ 價格：Free
- ⬜ 支援語系：至少 en, zh-Hant（越多越好）
- ⬜ Description（4000 字內，每語系）
- ⬜ Keywords（100 字元內）
- ⬜ Support URL: `https://eclawbot.com/info`
- ⬜ Marketing URL（可選）: `https://eclawbot.com/`
- ⬜ Privacy Policy URL: `https://eclawbot.com/privacy-policy.html` ✅
- ⬜ Copyright: `© 2026 HankHuang0516`

### 8. App 截圖

每個尺寸至少 3 張，最多 10 張。Expo 可用 iOS 模擬器截圖：

- ⬜ 6.9"（iPhone 16 Pro Max, 1320×2868）
- ⬜ 6.5"（iPhone 11 Pro Max, 1242×2688）
- ⬜ 5.5"（iPhone 8 Plus, 1242×2208）— 舊機種必備
- ⬜ iPad Pro 12.9"（2048×2732）— 若支援 iPad
- ⬜ iPad Pro 11"（1668×2388）

**截圖內容建議**：Dashboard、Chat、AI 助理、Wallet、Mission Control、Kanban

### 9. Privacy Questionnaire（App Store Connect）

- ⬜ 逐題填寫資料收集類型：
  - Email / Name → Linked to user, Used for Account Management
  - Device ID → Linked, Used for App Functionality
  - Product Interaction → Linked, Analytics
- ⬜ Tracking: **No**（若真的沒有 3rd party tracking）

### 10. App Review 資訊

- ⬜ Sign-in required: Yes
- ⬜ Demo Account 帳號：`apple-review@eclawbot.com` + 固定密碼
- ⬜ Device ID + Secret 寫在 Review Notes（用於 device login 測試）
- ⬜ Review Notes 寫清楚 IAP 測試步驟：
  ```
  1. Launch app, sign in with demo account
  2. Navigate to Settings → Wallet
  3. Tap any top-up tier
  4. Complete sandbox purchase
  5. Verify balance updated
  ```
- ⬜ Sandbox tester 帳號寫在 Review Notes

---

## P1 — 強烈建議（Review 可能會問）

### 11. Universal Links（Deep Link）

- ⬜ 後端放 `/.well-known/apple-app-site-association`（JSON，含 App Identifier）
- ⬜ `app.json` 加 `associatedDomains: ["applinks:eclawbot.com"]`
- ⬜ Xcode Capabilities 啟用 Associated Domains
- ⬜ 測試：Safari 點 `https://eclawbot.com/p/CODE` 直接開 App

### 12. 多語系

- ⬜ iOS 至少涵蓋 en + zh-Hant（目前已有更多）
- ⬜ App Store Description 對應語系都要填
- ⬜ 權限說明文字各語系都要填

### 13. TestFlight Beta 測試

- ⬜ 上傳 first build 到 App Store Connect
- ⬜ 加入 3–5 個 beta tester
- ⬜ 跑完 BRM E2E 測試場景 A–E（核心流程）
- ⬜ 修完 P0/P1 bug 再 resubmit

### 14. 崩潰與效能

- ⬜ 啟動時間 < 3 秒（冷啟動）
- ⬜ Memory 使用正常（不超過 300MB idle）
- ⬜ 無 main thread block > 1 秒
- ⬜ Crashlytics 或 Sentry 整合（可選，建議）

### 15. Accessibility

- ⬜ 所有按鈕有 `accessibilityLabel`
- ⬜ 圖示按鈕有語義化標籤
- ⬜ VoiceOver 可讀完主要流程
- ⬜ 支援系統字體放大

### 16. BRM Marketplace iOS 入口

- ⬜ 在 `(tabs)/index.tsx` 或 Settings 加入 "Marketplace" 入口
- ⬜ 在 `(tabs)/index.tsx` 或 Settings 加入 "My Rentals" 入口（目前已在 Settings）
- ⬜ Arena 面試 WebView wrapper 建立

### 17. 推播整合

- ⬜ APNs Key 上傳到 EAS 或 Firebase
- ⬜ 測試：server push → iOS 收到 notification
- ⬜ Notification tap 深連結到對應頁面
- ⬜ Badge 數量正確更新

---

## P2 — 加分項

### 18. 離線支援

- ⬜ 無網路時顯示合理的 empty state
- ⬜ Chat 歷史本地快取（即便網路斷也能看舊訊息）

### 19. 圖示 Polish

- ⬜ 主 App Icon 設計專業（可請設計師）
- ⬜ Tab Bar 圖示統一風格（outline vs filled 一致）

### 20. Onboarding

- ⬜ 首次開 App 時的歡迎流程（3 頁說明）
- ⬜ 引導用戶綁定第一個 Entity

### 21. Rate App Prompt

- ⬜ 使用 `StoreReview.requestReview()` 在適當時機（例：成功完成 10 次租借後）

### 22. Widget（iOS 14+）

- ⬜ 首頁 widget 顯示最近聊天 / 錢包餘額（⏸️ 可延到 v1.1）

---

## 送審流程

### Step 1 — 本地驗收（P0 全綠）

```bash
cd ios-app
npx expo prebuild --clean --platform ios  # 產生 ios/ 原生專案
# 在 Mac 上用 Xcode 開啟驗收（Windows 需透過 EAS Cloud Build）
```

### Step 2 — EAS Production Build

```bash
cd ios-app
eas build --platform ios --profile production
```

- 約 20–30 分鐘
- 失敗看 `eas.json` 是否正確、Apple credentials 是否過期

### Step 3 — TestFlight 上傳

```bash
eas submit --platform ios --profile production
```

- 或 EAS Build 完成後 App Store Connect 自動收到 build
- 等 10–30 分鐘 processing
- 加 beta tester，跑 P1 測試

### Step 4 — 填完 App Store Connect 所有欄位

逐項對照本 checklist P0 §7、§8、§9、§10

### Step 5 — Submit for Review

- App Store Connect → App Review → Submit
- Apple 審查通常 24–72 小時
- 被拒 → 看拒絕原因 → 修 → resubmit

---

## 常見被拒原因與對策

| 拒絕原因 | 對策 |
|---------|------|
| Guideline 3.1.1 (IAP 規避) | 確認 iOS 無任何 TapPay / Stripe / 網頁付款 |
| Guideline 4.8 (Sign in with Apple 缺失) | 若有 Google/FB，必須加 Apple |
| Guideline 5.1.1 (隱私說明不清) | 重寫 NSUsageDescription，說明具體用途 |
| Guideline 2.1 (無法完成註冊) | 提供 valid demo account，確認後端可登 |
| Guideline 4.0 (UI 粗糙) | 加 polish，確保 Safe Area、HIG |
| Guideline 5.1.2 (缺 Privacy Manifest) | 建立 `PrivacyInfo.xcprivacy` |

---

## 追蹤狀態

| 階段 | 狀態 | 備註 |
|------|------|------|
| 規範書齊備 | ✅ | ios-iap-spec, ios-app-spec, 本 checklist |
| P0 完成 | ⬜ | 預估 2–3 週 |
| TestFlight 首 build | ⬜ | |
| TestFlight beta 測試 | ⬜ | |
| 正式送審 | ⬜ | |
| 上架 | ⬜ | |

---

## 版本歷史

| 版本 | 日期 | 說明 |
|------|------|------|
| 1.0.0 | 2026-04-14 | 初版 checklist，涵蓋 P0–P2 所有項目、送審流程、常見拒絕對策 |

---

> **執行順序建議**：P0 §1 (Apple 帳號) → §2 (IAP) → §4 (Sign in with Apple) → §3 (Privacy Manifest) → §5-6 (填值) → §7-10 (上架資料) → TestFlight → Submit
