# iOS In-App Purchase 規範書 (iOS IAP Spec)

> **版本**: 1.0.0
> **建立日期**: 2026-04-14
> **適用範圍**: `ios-app/` (React Native / Expo)
> **目的**: 定義 iOS App 內購買流程、product ID 命名、後端驗證、跨平台錢包同步。
> **依據**: [BRM Design §9](../plans/2026-04-10-bot-rental-marketplace-design.md)、[`backend/wallet.js`](../../backend/wallet.js)

---

## 1. 為什麼需要 IAP

Apple App Store Review Guideline **§3.1.1**：
> "Apps offering in-app purchases must use Apple's in-app purchase API to process purchases of digital content or services."

EClawbot 的 **e幣** 是數位貨幣，用於租借 Bot 付費。因此：

- ✅ **必須**：iOS App 所有 e幣加值**只能**走 Apple IAP
- ❌ **禁止**：iOS 導向 TapPay / Stripe / 網頁 checkout（會被 Apple 拒絕）
- ✅ **例外**：Android、Web Portal 不受限，可繼續用 Google Play Billing / TapPay
- ✅ **跨平台同步**：同一 `deviceId` 在 iOS IAP 加值後，Android / Web 也能花用（共用錢包餘額）

---

## 2. E幣系統複習

| 項目 | 值 | 說明 |
|------|----|----|
| 最小單位 | `mli` | 1 e幣 = 1,000 mli（避免浮點誤差） |
| 匯率 | 1 USD ≈ 3,000 e幣 | 見 `wallet.js` `USD_TO_MLI` |
| 顯示格式 | `10.0 e幣` | `{mli / 1000}.{小數一位} e幣` |

### 2.1 現有加值檔位（`TOPUP_TIERS`）

| Product ID | 美元 | 加值 e幣 | 紅利 | 備註 |
|-----------|------|---------|------|------|
| `ec.topup.small` | $1 | 3,000 | 0% | 最小單位 |
| `ec.topup.starter` | $3 | 9,450 | +5% | 新手優惠 |
| `ec.topup.standard` | $5 | 16,200 | +8% | 標準 |
| `ec.topup.advanced` | $10 | 33,600 | +12% | 進階 |
| `ec.topup.premium` | $20 | 69,000 | +15% | 最高 CP |

**⚠️ iOS 上架時這份檔位必須完整對映到 App Store Connect 的 Consumable IAP 產品，Product ID 保持一致**。

---

## 3. Apple IAP Product ID 命名規範

### 3.1 命名規則

Apple IAP product ID **全局唯一**（跨 Bundle ID），建議使用反向網域前綴。但為了**與 Android 共用 product ID 方便後端辨識**，採用以下規則：

```
ec.topup.{tier}
```

**保持與 Android 一致**。後端 `wallet.js` 的 `TOPUP_TIERS` 已使用此格式，iOS 沿用即可。

### 3.2 產品類型

| 類型 | 用途 | 選擇 |
|------|------|------|
| Consumable | 一次性購買，可重複購買 | ✅ **全部 5 個加值檔位用此類型** |
| Non-Consumable | 永久解鎖功能 | ❌ 不使用 |
| Auto-Renewable Subscription | 訂閱制 | ⏸️ 未來若推訂閱版時再加 |
| Non-Renewing Subscription | 固定期間訂閱 | ❌ 不使用 |

### 3.3 App Store Connect 設定清單

每個 product 在 App Store Connect 需填寫：

| 欄位 | 範例（`ec.topup.standard`） |
|------|---------------------------|
| Product ID | `ec.topup.standard` |
| Reference Name | `EClaw 標準加值包` |
| Price Tier | Tier 5 (USD 4.99) |
| Localization (zh-Hant) | 顯示名稱「標準加值 16,200 e幣」、描述「儲值 16,200 e幣，+8% 紅利」 |
| Localization (en) | "Standard Top-Up 16,200 e-coins"、"Buy 16,200 e-coins with 8% bonus" |
| Review Screenshot | 顯示 Wallet 頁面的加值按鈕 |

---

## 4. iOS IAP 實作規範

### 4.1 套件選擇

**使用 `react-native-iap`**（`expo-in-app-purchases` 已於 SDK 53 棄用）：

```bash
cd ios-app
npx expo install react-native-iap
```

需在 `app.json` 加入 plugin：

```json
{
  "expo": {
    "plugins": [
      "react-native-iap"
    ]
  }
}
```

### 4.2 購買流程（狀態機）

```
[User taps 加值按鈕]
    ↓
[初始化連線 initConnection()]
    ↓
[取得產品資訊 getProducts({ skus: IOS_PRODUCT_IDS })]
    ↓
[顯示產品列表] ──→ [User 點選某產品]
                       ↓
                  [requestPurchase({ sku })]
                       ↓
                  [Apple 付款彈窗 → 扣款]
                       ↓
                  [purchaseUpdatedListener 收到 purchase]
                       ↓
               ┌──────────────────────────────┐
               │ 呼叫後端驗證                  │
               │ POST /api/wallet/topup/verify-apple
               │ { receipt, productId, transactionId }
               └──────────────────────────────┘
                       ↓
                  [後端回 { success, credited_mli }]
                       ↓
                  [finishTransaction(purchase)]  ⚠️ 必做
                       ↓
                  [更新 Wallet UI 顯示新餘額]
```

### 4.3 關鍵規則

| 規則 | 說明 |
|------|------|
| ✅ `finishTransaction` 必須呼叫 | 否則 Apple 會一直重送，且用戶看到「pending」 |
| ✅ 後端驗證先，才 `finishTransaction` | 避免 receipt 驗證失敗但 Apple 已結案 |
| ✅ `purchaseUpdatedListener` 全域監聽 | App 啟動時掛載，處理中斷的交易 |
| ✅ 同一 `transactionId` idempotent | 後端用 `transactionId` 做唯一鍵，重複驗證回同樣結果 |
| ❌ 不得顯示 Apple 以外的付款選項 | 包括「去網頁加值更便宜」這類文字 |

---

## 5. 後端 Apple Receipt 驗證

### 5.1 新增 Endpoint

**目前不存在**，需新增：

```
POST /api/wallet/topup/verify-apple
```

**Body**:
```json
{
  "deviceId": "uuid",
  "deviceSecret": "...",
  "productId": "ec.topup.standard",
  "transactionId": "2000000123456789",
  "receipt": "base64-encoded-receipt-data"
}
```

**Response（成功）**:
```json
{
  "success": true,
  "credited_mli": 16200000,
  "credited_display": "16200.0 e幣",
  "new_balance_mli": 20000000,
  "transaction_id": "uuid-ledger-entry"
}
```

**Response（重複交易）**:
```json
{
  "success": true,
  "already_credited": true,
  "credited_mli": 16200000,
  "transaction_id": "uuid-ledger-entry"
}
```

### 5.2 驗證邏輯

```
1. 查詢 DB：transactionId 是否已存在於 wallet_ledger.metadata.apple_transaction_id
   ├─ 存在 → 回 already_credited: true（idempotent）
   └─ 不存在 → 繼續

2. 呼叫 Apple 驗證 API
   ├─ 首選：POST https://buy.itunes.apple.com/verifyReceipt
   ├─ 若回 21007 → 改呼叫 sandbox: https://sandbox.itunes.apple.com/verifyReceipt
   └─ Body: { "receipt-data": receipt, "password": APP_SHARED_SECRET }

3. 解析 Apple 回應
   ├─ status !== 0 → 回 400, error: "invalid_receipt"
   ├─ 找出 in_app[] 中 transaction_id 相符的項目
   └─ 驗證 product_id 與請求一致

4. 根據 productId 查詢 TOPUP_TIERS[productId].ecoins
   └─ 若無此 tier → 回 400, error: "unknown_product"

5. 寫入 wallet_ledger
   ├─ type: 'topup'
   ├─ amount_mli: tier.ecoins * 1000
   ├─ metadata: { apple_transaction_id, productId, platform: 'ios' }
   └─ 同時更新 wallet.balance_mli

6. 回 { success: true, credited_mli, new_balance_mli }
```

### 5.3 環境變數

`backend/.env` 新增：

```
APPLE_IAP_SHARED_SECRET=<從 App Store Connect → My Apps → App Information → App-Specific Shared Secret>
APPLE_IAP_ENV=production  # or "sandbox" for dev
```

### 5.4 Server-to-Server 通知（可選但建議）

Apple 提供 **App Store Server Notifications V2** — 當有退款、訂閱取消等事件會主動通知後端。

- Endpoint: `POST /api/wallet/apple-s2s-notify`
- 用途：處理 `REFUND` 事件時自動從用戶錢包扣回 e幣
- 設定位置：App Store Connect → App Information → App Store Server Notifications

---

## 6. 跨平台錢包同步

### 6.1 同一 deviceId 的多平台邏輯

EClaw 的 `wallet` 綁 `device_id`，不綁平台。因此：

| 情境 | 結果 |
|------|------|
| iOS 加值 100 e幣 | `wallet_ledger` 寫入 `platform: 'ios'`，`balance_mli += 100000` |
| Android 同 deviceId 查餘額 | 看到加值後的餘額，可正常花用 |
| Web Portal 同 deviceId 查餘額 | 同上 |

### 6.2 跨裝置帳號怎麼辦？

目前 EClaw 以 `deviceId` 為錢包主鍵，**不是 userId**。若用戶在兩台 iPhone 分別用不同 device 登入，餘額不共用。

**暫時方案**：提示用戶只在主要裝置加值，或用 device handover 功能轉移錢包（未實作）。

**長期方案**：若未來推出 `user_wallet` 聚合，需另撰規範書。

---

## 7. UI 呈現規範

### 7.1 iOS Wallet 頁面（取代 WebView）

現況：`ios-app/app/wallet.tsx` 是 WebView wrapper。

**改為 Native**，顯示元素：

```
┌─────────────────────────────────────┐
│  💰 錢包                            │
├─────────────────────────────────────┤
│  餘額                               │
│  ┌───────────────────────────────┐  │
│  │     10,450.0 e幣              │  │
│  │     ≈ USD $3.48               │  │
│  └───────────────────────────────┘  │
├─────────────────────────────────────┤
│  加值（透過 Apple IAP）             │
│  ┌───────────────────────────────┐  │
│  │  Small    $1    → 3,000 e幣   │  │
│  │  Starter  $3    → 9,450 e幣 +5%│  │
│  │  Standard $5    → 16,200 e幣+8%│ ★ │
│  │  Advanced $10   → 33,600 e幣+12%│ │
│  │  Premium  $20   → 69,000 e幣+15%│ │
│  └───────────────────────────────┘  │
├─────────────────────────────────────┤
│  交易紀錄                           │
│  [透過 /api/wallet/ledger 拉取]     │
└─────────────────────────────────────┘
```

### 7.2 i18n keys（需新增）

```javascript
// ios-app/i18n/zh-TW.json 等
"wallet_balance": "餘額",
"wallet_topup_via_apple": "加值（透過 Apple IAP）",
"wallet_topup_processing": "處理中...",
"wallet_topup_success": "加值成功！",
"wallet_topup_failed": "加值失敗，請稍後再試",
"wallet_topup_pending": "交易處理中，請稍候",
"wallet_topup_recover": "恢復未完成的購買",
"wallet_tier_small": "小額",
"wallet_tier_starter": "新手",
"wallet_tier_standard": "標準",
"wallet_tier_advanced": "進階",
"wallet_tier_premium": "尊榮",
"wallet_bonus_label": "+{pct}% 紅利"
```

### 7.3 禁止行為（Apple Review 會盯）

- ❌ 不得在 iOS 顯示「前往網頁加值更便宜」字樣
- ❌ 不得開啟外部瀏覽器導向 TapPay 或其他付款頁
- ❌ 不得提示用戶「此加值僅限 iOS」（Apple 禁止定價差別暗示）
- ❌ 不得繞過 IAP 用 receipt URL 以外的付款方式

---

## 8. 測試規範

### 8.1 Sandbox 測試

1. App Store Connect → Users and Access → Sandbox Testers → 建立測試帳號
2. iPhone → Settings → App Store → Sandbox Account → 登入測試帳號
3. 用 Xcode 或 TestFlight 安裝 Debug build
4. 走完整流程：產品列表 → 購買 → Sandbox 彈窗 → 後端驗證 → 餘額更新

### 8.2 測試案例

| # | 場景 | 預期結果 |
|---|------|---------|
| T1 | 購買 `ec.topup.standard` → 成功 | 餘額 +16,200 e幣，ledger 有 entry |
| T2 | 同 transactionId 重送驗證 | 回 `already_credited: true`，餘額不重複 |
| T3 | 網路中斷後重啟 App | `purchaseUpdatedListener` 補驗證未完成交易 |
| T4 | 後端驗證失敗 | App 顯示 error，**不呼叫** `finishTransaction` |
| T5 | Apple 回 sandbox（21007） | 後端自動切 sandbox 端點，仍驗證成功 |
| T6 | 退款（App Store Server Notification） | 自動從錢包扣回對應 e幣 |

### 8.3 審查送件時的 demo 資料

App Store 審查員需要：
- Sandbox tester 帳號（寫在 App Review Information）
- 測試裝置 deviceId + deviceSecret（寫在 App Review Information）
- 測試流程說明：「登入 → Wallet → 點選 Standard → 完成購買 → 驗證餘額更新」

---

## 9. 上架前 Checklist

| 項目 | 狀態 |
|------|------|
| `react-native-iap` 安裝完成 | ⬜ |
| 5 個 Consumable product 在 App Store Connect 建立完成 | ⬜ |
| `APPLE_IAP_SHARED_SECRET` 加入後端 env | ⬜ |
| `POST /api/wallet/topup/verify-apple` 實作完成 | ⬜ |
| `wallet_ledger` schema 支援 `apple_transaction_id` 唯一索引 | ⬜ |
| Sandbox 測試案例 T1–T6 全部通過 | ⬜ |
| App Store Server Notifications V2 endpoint 設定（可選） | ⬜ |
| `ios-app/app/wallet.tsx` 改為 native UI | ⬜ |
| i18n keys 補齊（zh-TW、en、ja、ko、th、vi、id、ms、hi、ar、fr、es、de） | ⬜ |
| WebView fallback 移除（iOS 不得連到 TapPay 頁） | ⬜ |

---

## 10. 版本歷史

| 版本 | 日期 | 說明 |
|------|------|------|
| 1.0.0 | 2026-04-14 | 初版規範，定義 IAP 產品、後端驗證、跨平台錢包同步規則 |

---

> **審查關鍵提醒**：Apple 會特別檢查（1）有沒有繞過 IAP 的付款方式、（2）receipt 驗證是否在後端完成、（3）是否顯示非 Apple 的定價。這三點不過關**一定**被拒。
