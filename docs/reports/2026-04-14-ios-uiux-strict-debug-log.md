# iOS UIUX 嚴格偵錯記錄

> 日期：2026-04-14（範本建立）
> 方法：iOS Simulator 手動操作 + Xcode Accessibility Inspector + Playwright MCP（WebView 頁面）
> 禁止：跳過 UI 直接 call API 驗證；繞過 Apple IAP 付款頁
> 比對基準：[ios-app-spec.md](../specs/ios-app-spec.md)、[ios-iap-spec.md](../specs/ios-iap-spec.md)、Apple Human Interface Guidelines、Web 版 UIUX
> 審查：Codex + Apple TestFlight Reviewer（若開啟）
> 狀態：⏸️ **尚未開始** — 等待 EAS preview build

---

## 使用方式

本文件記錄 iOS App UIUX 偵錯迭代。每輪迭代：
1. 在 Simulator / 實機操作 App
2. 對照 spec + HIG，發現不一致就記錄 bug
3. 截圖 + 描述 + 嚴重度
4. 修復後標記 ✅ 並記錄修復 commit/PR

嚴重度：
- **P0**：Apple Review 會直接拒（必修）
- **P1**：影響主要功能或體驗
- **P2**：視覺不一致或次要功能
- **P3**：建議改善

---

## 迭代 1 — 第一次 TestFlight build 檢查（⏸️ 待跑）

### Scene A：App 啟動與登入頁

| Bug ID | 嚴重度 | 描述 | 截圖 | 狀態 |
|--------|--------|------|------|------|
| BUG-iOS-A1 | — | _待發現_ | — | — |

_預期常見問題：_
- Launch screen 過渡太慢或閃黑
- Sign in with Apple 按鈕樣式未符 HIG
- Google/Facebook 按鈕位置導致 Apple Review 誤認「只有非 Apple 登入」
- 字體過大或過小（無 respect dynamic type）

### Scene B：Dashboard（Home Tab）

| Bug ID | 嚴重度 | 描述 | 截圖 | 狀態 |
|--------|--------|------|------|------|
| BUG-iOS-B1 | — | _待發現_ | — | — |

_預期常見問題：_
- Entity 卡片 avatar 顯示異常
- Rental badge（🤖 Rented / 📤 出租中）在 iOS 未實作或樣式不一致
- Org Chart 入口 tap 區過小（< 44pt）
- Safe Area 未正確處理（頂部被 status bar 蓋）

### Scene C：Chat Tab + 個別聊天頁

| Bug ID | 嚴重度 | 描述 | 截圖 | 狀態 |
|--------|--------|------|------|------|
| BUG-iOS-C1 | — | _待發現_ | — | — |

_預期常見問題：_
- Cross-device 訊息方向錯（`isSent` 判斷失誤）
- Keyboard 彈出後輸入框被遮
- Chat bubble 未支援深色模式
- Org chart forward 訊息 source parsing 失敗

### Scene D：Wallet Tab（Native IAP）⚠️ **P0 重點**

| Bug ID | 嚴重度 | 描述 | 截圖 | 狀態 |
|--------|--------|------|------|------|
| BUG-iOS-D1 | — | _待發現_ | — | — |

_預期常見問題：_
- ❌ **P0**：顯示「前往網頁加值」類似文字（Apple Review 立刻拒）
- ❌ **P0**：WebView 開啟 TapPay / Stripe 頁面
- ❌ **P0**：IAP tier 未跟 App Store Connect 產品對齊
- ❌ **P0**：`finishTransaction` 未呼叫導致交易卡在 pending
- ❌ **P0**：同 transactionId 重複驗證未 idempotent
- Sandbox/Prod 切換邏輯錯
- Receipt 解析失敗 UI 無反應

### Scene E：Marketplace（WebView Wrapper）

| Bug ID | 嚴重度 | 描述 | 截圖 | 狀態 |
|--------|--------|------|------|------|
| BUG-iOS-E1 | — | _待發現_ | — | — |

_預期常見問題：_
- WebView 載入白屏時間過長無 loading state
- Auth token 未正確傳遞導致 WebView 內 API 401
- 在 WebView 內點付款按鈕彈出網頁版 TapPay（⚠️ P0）
- iOS 內 User-Agent 偵測失敗，WebView 沒跳過 AI chat widget

### Scene F：My Rentals（WebView）

| Bug ID | 嚴重度 | 描述 | 截圖 | 狀態 |
|--------|--------|------|------|------|
| BUG-iOS-F1 | — | _待發現_ | — | — |

_預期常見問題：_
- 租借中/出租中 tab 視角誤會（已在 Web 修過，確認 iOS 同步）
- 評分彈窗 keyboard 遮擋
- iOS Safari 樣式差異（分享按鈕、捲動）

### Scene G：Settings Tab

| Bug ID | 嚴重度 | 描述 | 截圖 | 狀態 |
|--------|--------|------|------|------|
| BUG-iOS-G1 | — | _待發現_ | — | — |

_預期常見問題：_
- Marketplace 入口未顯示
- My Rentals 入口位置太深
- Sign out 後 AsyncStorage 未清乾淨

### Scene H：Sign in with Apple 流程

| Bug ID | 嚴重度 | 描述 | 截圖 | 狀態 |
|--------|--------|------|------|------|
| BUG-iOS-H1 | — | _待發現_ | — | — |

_預期常見問題：_
- ❌ **P0**：按鈕未遵守 HIG（顏色、字型、corner radius）
- ❌ **P0**：後端驗證失敗無 fallback
- Email 選擇「Hide My Email」時資料存錯
- 重複登入同 Apple ID 建重複 user

### Scene I：Push Notification UI

| Bug ID | 嚴重度 | 描述 | 截圖 | 狀態 |
|--------|--------|------|------|------|
| BUG-iOS-I1 | — | _待發現_ | — | — |

_預期常見問題：_
- 權限請求時機不當（一開 App 就彈）
- 拒絕後無法再次請求（需引導去 Settings）
- Deep link 到錯誤頁面
- Badge 數字不同步

### Scene J：Universal Link

| Bug ID | 嚴重度 | 描述 | 截圖 | 狀態 |
|--------|--------|------|------|------|
| BUG-iOS-J1 | — | _待發現_ | — | — |

_預期常見問題：_
- `apple-app-site-association` 無法從 server 取得
- URL 帶參數時 App 無法正確解析
- 點連結開 Safari 而非 App

---

## 迭代 2 — 修復後驗證（⏸️）

_待迭代 1 完成後進行_

---

## 迭代 3 — 送審前最終檢查（⏸️）

_待迭代 2 完成後進行_

---

## 迭代 4 — 送審回饋修復（⏸️）

_若 Apple Review 被拒，記錄拒絕原因與修復_

---

## 常見 Apple Review 被拒 UIUX 問題（預防性檢查）

| # | 問題 | 嚴重度 | 預防措施 |
|---|------|--------|---------|
| 1 | IAP 被 bypass | P0 | Wallet 頁全 native，無 WebView 付款 |
| 2 | 無 Sign in with Apple 但有 Google/FB | P0 | 三者並存 |
| 3 | NSUsageDescription 含糊 | P0 | 每個權限說具體用途 |
| 4 | PrivacyInfo.xcprivacy 缺失 | P0 | 建立並宣告所有 API |
| 5 | 按鈕 < 44pt | P1 | 統一檢查觸控目標 |
| 6 | 無 Safe Area | P1 | 所有 Screen 用 SafeAreaView |
| 7 | 字體不支援 Dynamic Type | P2 | 使用 `useFontScale()` |
| 8 | 崩潰率 > 1% | P0 | Sentry 監控 |
| 9 | 啟動白屏 > 3s | P1 | Splash screen 優化 |
| 10 | 無網路時白屏 | P1 | Empty state |

---

## Bug 統計

| 嚴重度 | 發現 | 修復 | Pending |
|--------|------|------|---------|
| P0 | 0 | 0 | 0 |
| P1 | 0 | 0 | 0 |
| P2 | 0 | 0 | 0 |
| P3 | 0 | 0 | 0 |
| **總計** | **0** | **0** | **0** |

---

## 版本歷史

| 版本 | 日期 | 說明 |
|------|------|------|
| 1.0.0 | 2026-04-14 | 初版範本，等待 build 後執行 |
