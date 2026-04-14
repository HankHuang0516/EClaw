# iOS UIUX 渲染差異報告

> 日期：2026-04-14（範本建立）
> 比對基準：
>   - [ios-app-spec.md](../specs/ios-app-spec.md)
>   - [ios-iap-spec.md](../specs/ios-iap-spec.md)
>   - Apple Human Interface Guidelines（HIG）
>   - Web 版實作（feature parity）
> 狀態：⏸️ **尚未開始** — 等待 EAS preview build

---

## 目的

本報告記錄 iOS App 實際渲染與規範書/HIG 的差異，作為迭代修復依據。每一輪修復後，把修掉的項目從表格移除或標記為 ✅。

---

## 三層比對

| 基準 | 檢查重點 |
|------|---------|
| **規範書**（`ios-app-spec.md`） | 結構、流程、feature parity、禁止行為 |
| **Apple HIG** | 視覺、互動、字體、色彩、觸控目標 |
| **Web 版** | UX 功能對齊（除非明確標為 iOS 特有） |

---

## 迭代 1（⏸️ 待 TestFlight build 後開始）

### 1.1 結構差異（預期項目）

| 區域 | 規範要求 | iOS 實際 | 差異說明 | 嚴重度 |
|------|---------|---------|---------|--------|
| Tab Bar | 5 個 tab：首頁/聊天/任務/名片/設定 | _TBD_ | _TBD_ | — |
| Wallet 入口 | Tab Bar 或 Settings 入口 | _TBD_ | _TBD_ | — |
| Marketplace 入口 | Settings 或首頁 CTA | _TBD_ | _TBD_ | — |
| My Rentals 入口 | Settings | _TBD_ | _TBD_ | — |
| Arena 入口 | 若無 WebView wrapper 則缺 | _TBD_ | _TBD_ | — |

### 1.2 HIG 視覺差異（預期項目）

| 項目 | HIG 標準 | iOS 實際 | 嚴重度 |
|------|---------|---------|--------|
| 觸控目標 | ≥ 44×44 pt | _TBD_ | — |
| Safe Area | 所有頁面 respect | _TBD_ | — |
| 深色模式 | 跟系統 | _TBD_ | — |
| Dynamic Type | 支援字體放大 | _TBD_ | — |
| Haptic | 關鍵操作有觸覺回饋 | _TBD_ | — |
| Launch Screen | 品牌色背景，無文字 | _TBD_ | — |
| App Icon | 1024×1024，無圓角 | _TBD_ | — |

### 1.3 IAP 合規差異（P0 重點）

| 檢查項 | 規範要求 | iOS 實際 | 嚴重度 |
|-------|---------|---------|--------|
| 加值方式 | **只有** Apple IAP | _TBD_ | P0 |
| 加值檔位數量 | 5（小到大） | _TBD_ | P0 |
| Product ID | `ec.topup.{tier}` | _TBD_ | P0 |
| Receipt 後端驗證 | `POST /api/wallet/topup/verify-apple` | _TBD_ | P0 |
| Idempotency | 同 transactionId 不重複入帳 | _TBD_ | P0 |
| `finishTransaction` | 驗證成功後才呼叫 | _TBD_ | P0 |
| 非 IAP 文字 | 「網頁加值更便宜」類不得出現 | _TBD_ | P0 |
| WebView 付款 iframe | 必須攔截 | _TBD_ | P0 |

### 1.4 認證合規差異（P0 重點）

| 檢查項 | 規範要求 | iOS 實際 | 嚴重度 |
|-------|---------|---------|--------|
| Sign in with Apple | 存在 | _TBD_ | P0 |
| Google 登入保留 | 可保留 | _TBD_ | — |
| Facebook 登入保留 | 可保留 | _TBD_ | — |
| 三者並存 | 必要 | _TBD_ | P0 |
| 按鈕樣式符 HIG | Apple 官方樣式 | _TBD_ | P1 |

### 1.5 Feature Parity 差異

比對 Web 版功能，iOS 應一致（除非明確為 iOS 特有）：

| 功能 | Web | iOS | 差異 | 嚴重度 |
|------|-----|-----|------|--------|
| Entity CRUD | ✅ | _TBD_ | — | — |
| Chat 多 entity | ✅ | _TBD_ | — | — |
| AI 助理 | ✅ | _TBD_ | — | — |
| Mission Control | ✅ | _TBD_ | — | — |
| Kanban | ✅ | _TBD_ | — | — |
| Card Holder | ✅ | _TBD_ | — | — |
| Wallet Ledger | ✅ | _TBD_ | — | — |
| Rental Marketplace | ✅ | _TBD_ WebView | — | — |
| My Rentals | ✅ | _TBD_ WebView | — | — |
| Arena 面試 | ✅ | _TBD_ | — | — |
| Org Chart | ✅ | _TBD_ | — | — |
| Note Pages | ✅ | _TBD_ | — | — |

### 1.6 i18n 差異

| 語系 | Web 支援 | iOS 支援 | 差異 |
|------|---------|---------|------|
| zh-TW | ✅ | _TBD_ | — |
| zh-CN | ✅ | _TBD_ | — |
| en | ✅ | _TBD_ | — |
| ja | ✅ | _TBD_ | — |
| ko | ✅ | _TBD_ | — |
| th | ✅ | _TBD_ | — |
| vi | ✅ | _TBD_ | — |
| id | ✅ | _TBD_ | — |
| ms | ✅ | _TBD_ | — |
| hi | ✅ | _TBD_ | — |
| ar | ✅ | _TBD_ | — |
| fr | ✅ | _TBD_ | — |
| es | ✅ | _TBD_ | — |
| de | ✅ | _TBD_ | — |

**IAP 新增 i18n key**（見 `ios-iap-spec.md §7.2`）：

| Key | Web | iOS |
|-----|-----|-----|
| `wallet_topup_via_apple` | N/A | _TBD_ |
| `wallet_topup_success` | N/A | _TBD_ |
| `wallet_topup_failed` | N/A | _TBD_ |
| `wallet_tier_small` | N/A | _TBD_ |
| `wallet_tier_starter` | N/A | _TBD_ |
| `wallet_tier_standard` | N/A | _TBD_ |
| `wallet_tier_advanced` | N/A | _TBD_ |
| `wallet_tier_premium` | N/A | _TBD_ |
| `wallet_bonus_label` | N/A | _TBD_ |

---

## 迭代 2（⏸️ 待迭代 1 完成）

_修復迭代 1 列出的差異後，在此記錄剩餘差異。_

---

## 迭代 3（⏸️ 送審前最終比對）

_送審前最後一次 diff check。_

---

## 已知永久差異（不修）

iOS 和 Web 本質不同，以下差異**接受不修**：

| 差異 | 原因 |
|------|------|
| iOS 用 Apple IAP，Web 用 TapPay | Apple 政策強制 |
| iOS 支援 Haptic，Web 沒有 | 硬體能力差異 |
| iOS 的 Sign in with Apple，Web 沒有 | 平台特有 |
| iOS 導航用 Tab Bar，Web 用 top nav | 平台慣例 |
| iOS 無首頁 widget，Web 無此概念 | 未實作（P3 延後） |
| iOS BRM 部分為 WebView | 開發成本考量（P2 迭代再 native） |

---

## 差異統計

| 迭代 | P0 | P1 | P2 | P3 | 總計 |
|------|----|----|----|----|------|
| 1 | — | — | — | — | — |
| 2 | — | — | — | — | — |
| 3 | — | — | — | — | — |

---

## 修復 PR 記錄

| PR | 迭代 | 修復項目 | Merged |
|----|------|---------|--------|
| _（尚無）_ | — | — | — |

---

## 版本歷史

| 版本 | 日期 | 說明 |
|------|------|------|
| 1.0.0 | 2026-04-14 | 初版範本，等待 build 後填值 |
