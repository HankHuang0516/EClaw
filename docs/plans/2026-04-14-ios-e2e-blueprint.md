# iOS E2E 完整驗證藍圖

> 日期：2026-04-14
> 目的：iOS 上架前完整覆蓋 16 類別 ~160 步驟
> 工具：混合策略 — Playwright MCP（WebView 頁面）+ iOS Simulator 手動（native 頁面）+ 後端 API 驗證
> 帳號：Owner = device login `480def4c`, Renter = `e2e-renter-test@eclawbot.com`
> 依據：[iOS E2E Scenarios](./2026-04-14-ios-rental-e2e-test-scenarios.md)

---

## 測試策略

| 頁面類型 | 測試方式 | 工具 |
|---------|---------|------|
| Native 頁（Dashboard, Chat, Wallet, Settings, Sign in with Apple） | iOS Simulator 手動 + 螢幕錄影 | Xcode Simulator + QuickTime |
| WebView 頁（Marketplace, My Rentals, Arena） | Playwright MCP 操作同 URL | Playwright MCP |
| 原生橋接（IAP, APNs, Universal Link） | Sandbox tester + Xcode Console | Xcode + Apple Sandbox |
| 後端驗證 | API assist | curl / Playwright evaluate |

**注意**：無 Mac 時無法跑 Xcode Simulator。建議：
- 租用 Mac Mini cloud（例：MacinCloud）跑驗收
- 或用 EAS Build + TestFlight + 實機測試

---

## 總覽

| 類別 | Batch | 劇本 | 時間 | 優先級 |
|------|-------|------|------|--------|
| 環境預檢 | 0 | — | 5 min | — |
| IAP 核心流程 | 1 | C | 25 min | BLOCKER |
| Sign in with Apple | 2 | D | 10 min | BLOCKER |
| Happy path | 3 | A | 20 min | BLOCKER |
| 提前終止 | 4 | B | 10 min | BLOCKER |
| App 生命週期 | 5 | E | 8 min | BLOCKER |
| WebView 橋接 | 6 | G | 10 min | BLOCKER |
| IAP 異常 | 7 | H | 20 min | BLOCKER |
| Universal Link | 8 | I | 8 min | BLOCKER |
| Push 通知 | 9 | J | 15 min | BLOCKER |
| 權限請求 | 10 | K | 10 min | P1 |
| 網路切換 | 11 | F | 8 min | P1 |
| iPad 支援 | 12 | L | 10 min | P2（若有 iPad） |
| Apple Review 紅線 | 13 | M | 8 min | BLOCKER |
| 隱私合規 | 14 | N | 8 min | BLOCKER |
| 效能 | 15 | O | 10 min | P1 |
| Accessibility | 16 | P | 10 min | P1 |
| 清理 | 17 | — | 3 min | — |
| **合計** | | **16 劇本** | **~198 min** | |

---

## Batch 0：環境預檢

- ⬜ Mac 環境 / MacinCloud 可用
- ⬜ Xcode 16+ 安裝完成
- ⬜ EAS Build 跑完 preview build
- ⬜ TestFlight 能收到 build
- ⬜ Sandbox tester 帳號建立
- ⬜ APNs Key 已上傳
- ⬜ `/.well-known/apple-app-site-association` 部署確認
- ⬜ Renter / Owner 後端帳號正常
- ⬜ Renter 餘額歸零（為 Batch 1 做準備）

---

## Batch 1：IAP 核心流程（BLOCKER，劇本 C）

**這是 iOS 最重要的 batch，全部 PASS 才能上架。**

| Step | 操作 | 驗證 | 工具 |
|------|------|------|------|
| C1 | API 設 Renter balance = 10 mli | `GET /api/wallet/balance` | curl |
| C2 | WebView 開 community.html，租借 deposit=5 bot | Playwright MCP | Playwright |
| C3 | Bot chat 跑 100 token 消耗 | Socket.IO log | Playwright evaluate |
| C4 | `ended_zero_balance` 觸發 | API | curl |
| C5 | App 顯示餘額不足通知 | Simulator 觀察 | Xcode Simulator |
| C6 | 點 CTA 開 wallet.tsx | Simulator | Xcode Simulator |
| C7 | 看到 5 個 IAP tier 正確顯示 | Simulator | Xcode Simulator |
| C8 | 點 Standard ($5) | Sandbox 彈窗出現 | Xcode Simulator |
| C9 | 完成 sandbox 付款 | Apple receipt 返回 | Xcode Simulator |
| C10 | Log 看到 App 呼叫 `/api/wallet/topup/verify-apple` | Xcode Console | Xcode |
| C11 | 後端回 success, 16,200 e幣 | API response | Xcode Console |
| C12 | App 呼叫 `finishTransaction` | Xcode Console | Xcode |
| C13 | Wallet UI 顯示新餘額 16,210 | Simulator | Xcode Simulator |
| C14 | `wallet_ledger` 有新 entry, metadata 含 apple_transaction_id | API | curl |

**所有 14 步都 PASS 才算 Batch 1 通過。**

---

## Batch 2：Sign in with Apple（BLOCKER，劇本 D）

| Step | 操作 | 驗證 |
|------|------|------|
| D1 | 全新 App，開登入頁 | 看到 Apple 登入按鈕 |
| D2 | 按 Sign in with Apple | Apple 彈窗跳出 |
| D3 | 允許登入 + 分享 email | identityToken 返回 |
| D4 | App 呼叫 `POST /api/auth/oauth/apple` | 後端建立 user |
| D5 | 取得 authToken 導向 Dashboard | Dashboard 顯示 |
| D6 | 登出重開 | 可再次登入 |
| D7 | 同時測 Google/Facebook 按鈕還在 | ✅（不可只有 Apple） |

---

## Batch 3：Happy Path（BLOCKER，劇本 A）

混合 Playwright（WebView）+ Simulator（native）：

| Step | 工具 | 說明 |
|------|------|------|
| A1–A2 | curl | API 建 listing + Arena |
| A3 | curl | 上架 |
| A4 | Simulator | Renter 登入 |
| A5 | Simulator | 切 Marketplace tab（Settings → Marketplace） |
| A6–A9 | Playwright | WebView 內完成租借 |
| A10–A11 | Playwright | My Rentals 兩個 tab 驗證 |
| A12 | Simulator | Chat native 頁和 bot 對話 |
| A13–A14 | Playwright | 結束 + 評價 |
| A15 | Simulator | Wallet native 頁看收益 |

---

## Batch 4：提前終止（BLOCKER，劇本 B）

Playwright MCP 操作 my-rentals WebView，同 Web 版 B 劇本。

---

## Batch 5：App 生命週期（BLOCKER，劇本 E）

純 Simulator 操作：

| Step | 操作 | 驗證 |
|------|------|------|
| E1 | Chat 中按 Home | App 背景 |
| E2 | 回前景 | Socket 自動重連（看 Xcode Console） |
| E3 | IAP 中按 Home | 中斷交易 |
| E4 | 回前景 | `purchaseUpdatedListener` 觸發 |
| E5 | IAP 中強制關 App | 重開後補驗證 |

---

## Batch 6：WebView 橋接（BLOCKER，劇本 G）

| Step | 操作 | 驗證 |
|------|------|------|
| G1 | Native 登入 | AsyncStorage 有 authToken |
| G2 | 打開 community.tsx | WebView URL 帶 token |
| G3 | Playwright MCP 在 WebView 內 call API | 認證通過 |
| G4 | Native 登出 | WebView 內 API 401 |

---

## Batch 7：IAP 異常（BLOCKER，劇本 H）

| # | 測試方法 |
|---|---------|
| H1 | Simulator IAP 彈窗按 Cancel |
| H2 | Simulator 付款中關網路 |
| H3 | curl 打同 transactionId 兩次 |
| H4 | 偽造 receipt 打後端 |
| H5 | 用 sandbox tester 但配 prod env |
| H6 | App Store Server Notification 模擬退款 |

---

## Batch 8：Universal Link（BLOCKER，劇本 I）

| Step | 操作 |
|------|------|
| I1 | iPhone Safari 打 `https://eclawbot.com/p/CODE` |
| I2 | iMessage 送 agent card URL 給自己 |
| I3 | 解除安裝 App，再點連結 |

需事先確認 `/.well-known/apple-app-site-association` 部署成功：
```bash
curl https://eclawbot.com/.well-known/apple-app-site-association
```

---

## Batch 9：Push 通知（BLOCKER，劇本 J）

需實機才能完整測試（Simulator 不支援 push）：

| Step | 實機操作 |
|------|---------|
| J1 | 首次開 App 彈權限 |
| J2 | 允許，APNs token 傳後端 |
| J3 | curl 觸發後端 push |
| J4 | 實機收到通知 |
| J5 | 前景/背景/鎖定三種狀態分別測 |

---

## Batch 10：權限請求（P1，劇本 K）

Simulator 可測：

| # | 步驟 |
|---|------|
| K1 | 首次選相機 |
| K2 | 首次選相簿 |
| K3 | 首次錄音 |
| K4 | 模擬拒絕後再次請求 |

---

## Batch 11：網路切換（P1，劇本 F）

Simulator Network Link Conditioner 模擬：
- WiFi → 4G
- 斷網
- 低速

---

## Batch 12：iPad（P2）

若 App 支援 iPad，需另跑 iPad Simulator 測所有 Batch 1–11 主要項目。

---

## Batch 13：Apple Review 紅線（BLOCKER，劇本 M）

**送審前絕對要跑**：

- ⬜ M1 Wallet 頁無 TapPay/Stripe 按鈕
- ⬜ M2 無「網頁加值更便宜」字樣
- ⬜ M3 WebView 付款 iframe 被攔截
- ⬜ M4 Sign in with Apple 與 Google/FB 並存
- ⬜ M5 所有 NSUsageDescription 具體
- ⬜ M6 PrivacyInfo.xcprivacy 正確

**任何一項 FAIL 立刻送審會被拒**。

---

## Batch 14：隱私合規（BLOCKER，劇本 N）

- ⬜ Wireshark / Charles 抓封包確認無 tracking
- ⬜ 刪除帳號真的刪
- ⬜ Offline 快取不含敏感資料

---

## Batch 15：效能（P1，劇本 O）

Xcode Instruments：
- Time Profiler（啟動時間）
- Allocations（memory）
- Core Animation（frame rate）

---

## Batch 16：Accessibility（P1，劇本 P）

- Xcode → Accessibility Inspector
- Settings → Accessibility → VoiceOver

---

## Batch 17：清理

- ⬜ 測試資料清除
- ⬜ Sandbox tester 重置
- ⬜ TestFlight build 標記為「not suitable for review」或刪除

---

## 執行時間預估

| 情境 | 時間 |
|------|------|
| 全部 17 Batch（含實機 + iPad） | ~4 hrs |
| 僅 BLOCKER Batch（1–9, 13–14） | ~2 hrs |
| P1+P2 加項 | ~1.5 hrs |

---

## 測試報告產出

每個 Batch 完成後記錄於 `docs/reports/2026-04-14-ios-e2e-execution-log.md`（見該文件範本）。

---

## 版本歷史

| 版本 | 日期 | 說明 |
|------|------|------|
| 1.0.0 | 2026-04-14 | 初版 iOS E2E 藍圖，17 Batch |
