# iOS 租借市場 E2E 測試場景

> 建立日期：2026-04-14
> 平台：iOS App (React Native + Expo, `ios-app/`)
> 工具：Playwright MCP（WebView wrapper 頁面）+ iOS 模擬器手動驗證（native 頁面）+ Detox（E2E 自動化，若採用）
> 帳號：Owner = hank (bbb880008@gmail.com), Renter = e2e-renter-test@eclawbot.com
> 依據：[Web 版場景](./2026-04-12-rental-e2e-test-scenarios.md) + [iOS App Spec](../specs/ios-app-spec.md) + [iOS IAP Spec](../specs/ios-iap-spec.md)

---

## 測試範圍說明

iOS 的 BRM 測試涵蓋：
- **Native 頁面**：Dashboard (`index.tsx`)、Chat、Wallet (IAP)、Settings、Sign in with Apple
- **WebView 頁面**：Community / Marketplace、My Rentals、Arena 面試
- **原生橋接**：Apple IAP 回呼、APNs 推播、Deep Link、AsyncStorage

**與 Web 版差異**：
- Wallet 必須走 IAP，不是 TapPay
- 登入必須測 Sign in with Apple
- 需測 Universal Link 深連結
- WebView 頁面需測 App ↔ Web 的 auth token 傳遞

---

## 初階驗證（基礎交錯流程）

### 劇本 A：完美交易（Happy Path on iOS）

| Step | 角色 | 操作 | 頁面 | 驗證 |
|------|------|------|------|------|
| A1 | Owner | App 開啟，Sign in with Apple 登入 | 登入頁 (native) | authToken 存入 AsyncStorage |
| A2 | Owner | 建立 Listing（API） | API | status=draft |
| A3 | Owner | Arena 面試（WebView wrapper） | /arena WebView | score≥40%, passed=true |
| A4 | Owner | 上架 Listing（API） | API | status=listed |
| A5 | Renter | 開 App，email 登入 | 登入頁 | 導向 (tabs)/index |
| A6 | Renter | 點 Settings → Marketplace | community.tsx WebView | 載入 community.html#rental |
| A7 | Renter | WebView 內看到剛上架 Bot 卡片 | WebView | 卡片顯示 rate/deposit/rating |
| A8 | Renter | 點進詳情 Modal | WebView | deposit/duration 正確 |
| A9 | Renter | 輸入 6hr，按「租借」 | WebView | contract=active, deposit hold |
| A10 | Owner | Settings → My Rentals → 出租中 tab | my-rentals.tsx WebView | 看到 active contract |
| A11 | Renter | My Rentals → 租借中 tab | my-rentals.tsx WebView | 看到同一份 active contract |
| A12 | Renter | 切回 (tabs)/chat，和 rental bot 聊天 | chat/[entityId].tsx (native) | 可正常送訊息、收回覆 |
| A13 | Renter | 回 My Rentals → 正常結束 | WebView | ended_normal, 押金 100% 退 |
| A14 | Renter | 提交 5★ 評價 | WebView | 成功提交 |
| A15 | Owner | Wallet 頁面（native）確認收益 | wallet.tsx (native) | balance += 85% 租金 |
| A16 | 雙方 | Wallet ledger 核對 | wallet.tsx | drift=0 |

### 劇本 B：提前終止 + 申訴

與 Web 版 B 劇本相同，但在 iOS：
- 所有 UI 在 `my-rentals.tsx` WebView
- 付款相關：押金 hold/release 不經 IAP（非新增付款），無需 IAP 驗證
- 申訴流程：WebView 內 form 提交

### 劇本 C：餘額不足 + IAP 加值

| Step | 角色 | 操作 | 頁面 | 驗證 |
|------|------|------|------|------|
| C1 | Renter | 餘額設為 10 e幣（近零） | API | balance=10 |
| C2 | Renter | 嘗試租借 1hr deposit=5 bot | Community WebView | rent 成功 |
| C3 | Renter | 跑 100 tokens 消耗，balance<0 | bot chat | ended_zero_balance |
| C4 | Renter | App 提示「餘額不足，請加值」 | notification / modal | 顯示加值 CTA |
| C5 | Renter | 點 CTA → 開 Wallet native 頁 | wallet.tsx | 看到 5 個 IAP tier |
| C6 | Renter | 點選 Standard ($5) | wallet.tsx | Apple 付款彈窗跳出 |
| C7 | Renter | 完成 sandbox 付款 | Apple | receipt 返回 |
| C8 | App | 呼叫 `POST /api/wallet/topup/verify-apple` | Backend | success, credited 16,200 e幣 |
| C9 | App | `finishTransaction` 後更新 UI | wallet.tsx | 顯示新餘額 |
| C10 | Renter | 重新租借同一 bot | Community WebView | 成功 |

### 劇本 D：Sign in with Apple

| Step | 角色 | 操作 | 頁面 | 驗證 |
|------|------|------|------|------|
| D1 | 新用戶 | App 開啟，點 Sign in with Apple | 登入頁 | Apple 驗證彈窗 |
| D2 | 新用戶 | 允許 Apple 登入，選「分享 email」 | Apple 系統 | 回 identityToken |
| D3 | App | 呼叫 `POST /api/auth/oauth/apple` | Backend | 建立 user + device |
| D4 | App | 收到 authToken，導向 (tabs)/index | Dashboard | 顯示空 entity 列表（新用戶） |
| D5 | 新用戶 | 綁定 Bot, 看到 UI 正常 | 各頁 | 與 email 登入一致 |
| D6 | 同用戶 | 登出，重開 App | 登入頁 | 可再次 Apple 登入，不需重填 |

---

## 中階驗證（操作錯亂 + 防護）

### 劇本 E：App 背景/前景切換

| Step | 操作 | 預期 |
|------|------|------|
| E1 | 租借中，按 Home 切背景 | WebSocket 斷線 |
| E2 | 回前景 | WebSocket 自動重連，chat 狀態恢復 |
| E3 | 正在 IAP 付款時切背景 | 回前景後 `purchaseUpdatedListener` 仍收到 purchase event |
| E4 | IAP 付款完成但 App 崩潰 | 重開後 listener 補驗證 |

### 劇本 F：網路切換

| Step | 操作 | 預期 |
|------|------|------|
| F1 | WiFi → 4G 切換 | Chat 短暫 offline 後重連 |
| F2 | 完全斷網 | Empty state 顯示「無連線」 |
| F3 | WebView 頁離線時打開 | 顯示離線提示，不白屏 |

### 劇本 G：WebView 與 Native 的 Auth 傳遞

| Step | 操作 | 預期 |
|------|------|------|
| G1 | Native 頁登入 | authToken 存 AsyncStorage |
| G2 | 打開 community.tsx WebView | URL query 帶 `?token=XXX` 或 header 傳 |
| G3 | WebView 內 JS 可呼叫 `/api/wallet/balance` | 成功（認證通過） |
| G4 | Native 登出 | WebView 內 session 也失效 |

### 劇本 H：IAP 異常處理

| # | 場景 | 預期 |
|---|------|------|
| H1 | 付款取消（用戶按 Cancel） | 顯示「已取消」，不扣款 |
| H2 | 付款中斷（網路斷） | `purchaseUpdatedListener` 下次啟動補救 |
| H3 | 同 transactionId 重複驗證 | 後端回 `already_credited: true` |
| H4 | Receipt 過期或無效 | 後端回 400，App 顯示 error |
| H5 | Sandbox tester 但打到 prod 端點 | 後端自動 fallback 到 sandbox |
| H6 | Apple 回 refund 通知 | App Store Server Notification 觸發扣回 |

---

## 高階驗證（Apple 特有項目）

### 劇本 I：Universal Link 深連結

| Step | 操作 | 預期 |
|------|------|------|
| I1 | Safari 開 `https://eclawbot.com/p/CODE` | 若已裝 App 直接打開對應頁 |
| I2 | iMessage 分享 agent card URL | 點擊打開 App card holder |
| I3 | 未裝 App 時點連結 | 開 Safari 顯示網頁版 |

### 劇本 J：Push Notification

| Step | 操作 | 預期 |
|------|------|------|
| J1 | 首次開 App | 彈出通知權限請求 |
| J2 | 允許通知 | APNs token 註冊到後端 |
| J3 | Bot 來訊時 | iOS 收到 notification |
| J4 | App 前景時有訊息 | In-app banner，不干擾 |
| J5 | App 背景時點通知 | Deep link 到對應 chat |
| J6 | 鎖定畫面上通知 | Badge 數字更新 |

### 劇本 K：權限請求

| # | 場景 | 預期 |
|---|------|------|
| K1 | 首次拍頭像 | 彈出相機權限請求 |
| K2 | 首次選相簿圖 | 彈出相簿權限請求 |
| K3 | 首次錄音 | 彈出麥克風權限請求 |
| K4 | 用戶拒絕權限 | 顯示替代方案（如改用 emoji 頭像） |
| K5 | Settings 改權限後重新進入 | App 偵測並恢復功能 |

### 劇本 L：iPad 支援（若啟用）

| # | 場景 | 預期 |
|---|------|------|
| L1 | iPad 橫向 | 雙欄 layout（chat list + chat） |
| L2 | iPad 分割視窗 | App 正常運作 |
| L3 | iPad 鍵盤操作 | Tab / Enter 正常 |

---

## 安全與合規驗證

### 劇本 M：Apple Review 紅線

| # | 檢查項 | 預期 |
|---|--------|------|
| M1 | Wallet 頁無任何非 IAP 付款按鈕 | ✅ |
| M2 | 無「前往網頁加值」之類文字 | ✅ |
| M3 | WebView 內付款 iframe 攔截 | ✅ |
| M4 | Sign in with Apple 與 Google/Facebook 同時顯示 | ✅ |
| M5 | 所有 NSUsageDescription 說明具體用途 | ✅ |
| M6 | PrivacyInfo.xcprivacy 存在且正確 | ✅ |

### 劇本 N：隱私資料處理

| # | 檢查項 | 預期 |
|---|--------|------|
| N1 | App 啟動時不送出未授權的 tracking 請求 | ✅ |
| N2 | 第三方 SDK（如有）無 IDFA 存取 | ✅ |
| N3 | 用戶要求刪除帳號能真的刪除 | ✅ |
| N4 | Offline 快取不含敏感資料 | ✅ |

---

## 效能驗證

### 劇本 O：效能基準

| 指標 | 目標 | 測試方法 |
|------|------|---------|
| 冷啟動時間 | < 3s | 關閉 App 重開計時 |
| 熱啟動時間 | < 1s | 背景切前景 |
| Chat 載入 | < 2s | 打開 chat 列表 |
| Memory idle | < 300MB | Instruments memory |
| Frame rate | 60fps | 滑 Chat list 測量 |

---

## Accessibility 驗證

### 劇本 P：VoiceOver

| Step | 檢查 | 預期 |
|------|------|------|
| P1 | Dashboard 所有按鈕有 accessibilityLabel | ✅ |
| P2 | VoiceOver 可讀完登入→建立 Bot 流程 | ✅ |
| P3 | 系統字體放大 150% 時 UI 不破版 | ✅ |

---

## 完整劇本對照

| 類別 | iOS 劇本 | Web 對應 | 備註 |
|------|---------|----------|------|
| Happy path | A | A | |
| 提前終止 | B | B | |
| **IAP 加值** | **C** | **—** | **iOS 特有** |
| **Sign in with Apple** | **D** | **—** | **iOS 特有** |
| App 生命週期 | E | — | iOS 特有 |
| 網路切換 | F | — | iOS 特有 |
| WebView 橋接 | G | — | iOS 特有 |
| IAP 異常 | H | — | iOS 特有 |
| Universal Link | I | — | iOS 特有 |
| Push 通知 | J | — | iOS 特有 |
| 權限請求 | K | — | iOS 特有 |
| iPad | L | — | iOS 特有 |
| Apple Review 紅線 | M | — | iOS 特有 |
| 隱私合規 | N | — | iOS 特有 |
| 效能 | O | — | iOS 特有 |
| Accessibility | P | — | iOS 特有 |

**iOS 專屬劇本 14 個，Web 共通 2 個，共 16 類別、~160 步驟。**

> Web 版的中/高階劇本（C–U, V–BB）若涉及 UI 在 iOS 是 WebView wrapper，**直接走 Web 測試結果**，無需重測。

---

## 版本歷史

| 版本 | 日期 | 說明 |
|------|------|------|
| 1.0.0 | 2026-04-14 | 初版，16 類別 iOS E2E 劇本 |
