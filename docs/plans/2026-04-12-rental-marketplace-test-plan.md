# Bot Rental Marketplace — 完整測試計畫

> 建立日期：2026-04-12
> 基於：`docs/plans/2026-04-10-bot-rental-marketplace-design.md`
> 現有測試：~231 tests across 13 files

---

## P0 — Production 部署驗證（剛上線的端點）

| # | 測試項目 | 方法 | 驗證內容 | 狀態 |
|---|---------|------|---------|------|
| P0-1 | `GET /api/subscription/plans` 回傳 4 個方案 | curl live | status 200, plans.length=4, officialBotMonthlyEcoin=30000 | ⬜ |
| P0-2 | `GET /api/wallet/topup/tiers` 回傳 5 檔 | curl live | 5 tiers, product IDs = `ec.topup.*` | ⬜ |
| P0-3 | `GET /api/subscription/status` 包含 plan 欄位 | curl live | response 含 `plan` field | ⬜ |
| P0-4 | `subscription_grant` ledger type 被 wallet 接受 | Jest | grantSubscriptionEcoin 寫入 ledger 不報錯 | ⬜ |
| P0-5 | 月贈冪等性：同月重複呼叫不重複發放 | Jest | 同 userId+planId+month 只 credit 一次 | ⬜ |
| P0-6 | 月贈跨月重置：不同月份可再次發放 | Jest | 不同 month key → 新 ledger entry | ⬜ |

## P1 — Wallet 金流安全（已實作，需補測試）

| # | 測試項目 | 方法 | 驗證內容 | 狀態 |
|---|---------|------|---------|------|
| P1-1 | Reconcile：balance = SUM(ledger delta) | Jest | reconcileBalances 0 drift after topup+hold+release 序列 | ⬜ |
| P1-2 | 併發 idempotency：同 key 兩次 creditTopup | Jest | 第二次回傳原 entry，balance 不變 | ⬜ |
| P1-3 | 負餘額防護：holdDeposit > balance 被拒 | Jest | 確認報 insufficient | ✅ 已有 |
| P1-4 | 平台/保險虛擬錢包收費正確 | Jest | splitFees(100000) → owner 85000, platform 13000, insurance 2000 | ✅ 已有 |
| P1-5 | Google Play topup verify：未知 productId 拒絕 | Jest | 400 error | ✅ 已有 |
| P1-6 | Admin grant 需 admin 權限 | Jest | non-admin 被拒 | ✅ 已有 |

## P2 — 租借核心流程（已實作，需補測試）

| # | 測試項目 | 方法 | 驗證內容 | 狀態 |
|---|---------|------|---------|------|
| P2-1 | 完整生命週期：list → interview → publish → rent → end | Jest | contract 狀態 active → ended_normal，deposit 100% 退還 | ⬜ |
| P2-2 | 自租防護 | Jest | owner===renter → 400 | ✅ 已有 |
| P2-3 | 雙重租借防護 | Jest | 同 listing 第二份 contract → exclusivity error | ✅ 已有 |
| P2-4 | Token 計費：chargeRentalUsage 扣款正確 | Jest | 200 char in + 800 char out = 250 tokens × rate → 正確 mli | ⬜ |
| P2-5 | 餘額不足 → suspended 狀態 | Jest | balance=0 + charge → contract.status = suspended_insufficient_funds | ⬜ |
| P2-6 | Grace period 到期 → ended_zero_balance | Jest | expireGracePeriods 正確結束合約 | ⬜ |
| P2-7 | 提前終止 → 50% 退款 | Jest | ended_early_by_renter, refund 50% | ✅ 已有 |
| P2-8 | 5-strike violation → 30% 沒收 | Jest | ended_violation, forfeit 30% | ✅ 已有 |
| P2-9 | Entity guardrail：租借中不可 rename/delete | Jest | middleware 擋下 | ✅ 已有 |
| P2-10 | Vault 隔離：租借實體讀不到 `*_KEY` 變數 | Jest | detectRentalSensitiveData 偵測 API key | ✅ 已有 |
| P2-11 | Rate limit：30 req/min per contract | Jest | 第 31 次被拒 | ✅ 已有 |
| P2-12 | 定價顧問：Opus + 2 capabilities → 正確建議 | Jest | suggestRate 輸出合理範圍 | ✅ 已有 |
| P2-13 | Entity handover：renter 裝置出現租借 bot | Jest | insertRentalEntity 建立 slot | ✅ 已有 |

## P3 — 信任層（已實作，需補測試）

| # | 測試項目 | 方法 | 驗證內容 | 狀態 |
|---|---------|------|---------|------|
| P3-1 | 評價：合約結束後 48h 內可提交 1-5★ | Jest | submitReview 成功 | ✅ 已有 |
| P3-2 | 評價：48h 後不可提交 | Jest | 過期被拒 | ⬜ |
| P3-3 | 評價：同合約不可重複提交 | Jest | duplicate 被拒 | ✅ 已有 |
| P3-4 | 爭議：4 種類型都能建立 + SLA 時間正確 | Jest | bot_crash SLA=5min, quality=72h | ⬜ |
| P3-5 | 爭議：resolve + reject 狀態轉換 | Jest | 正確更新 status | ✅ 已有 |
| P3-6 | 信用分數公式：avg×2 - disputes×0.5 - frauds×2 | Jest | 給定輸入 → 預期分數 | ⬜ |
| P3-7 | 黑名單：加入後 isBlacklisted=true | Jest | 正確阻擋 | ✅ 已有 |
| P3-8 | 冷卻：24h 內不可再租同 listing | Jest | checkCooldown 回傳 blocked | ✅ 已有 |
| P3-9 | 年齡確認：confirmAge 記錄 IP | Jest | fraud_detection_log 有 entry | ✅ 已有 |
| P3-10 | Fraud：新帳號(<7天) deposit +50% | Jest | adjustedDeposit = 1.5× | ✅ 已有 |

## P4 — 整合 + E2E + Production（上線前必備）

| # | 測試項目 | 方法 | 驗證內容 | 狀態 |
|---|---------|------|---------|------|
| P4-1 | Production `/api/subscription/plans` 回傳正確 | Integration | live curl 驗證 | ⬜ |
| P4-2 | Production `/api/wallet/topup/tiers` 回傳 5 檔 | Integration | live curl 驗證 | ⬜ |
| P4-3 | Production `/api/wallet/balance` 需認證 | Integration | 無 cookie → 401 | ⬜ |
| P4-4 | Production `/api/rental/marketplace` 可公開查詢 | Integration | 200 + items array | ⬜ |
| P4-5 | E2E 租借全流程 | Integration | 2 test devices: list→interview→rent→chat→end→balance check | ⬜ |
| P4-6 | Reconcile 0 drift 驗證 | Integration | /admin/reconcile 回傳 ok=true | ⬜ |
| P4-7 | CI 全套 Jest 通過 | CI | 76 suites, 1331+ tests | ⬜ |

---

## 統計

- **總計：46 項測試**
- 已有覆蓋：20 項 ✅
- 需新增：26 項 ⬜
- 分布：P0(6) + P1(2) + P2(4) + P3(3) + P4(7) = 22 項新 Jest/Integration tests

## 相關測試檔案

| 檔案 | 現有 tests | 本計畫新增 |
|------|-----------|-----------|
| `tests/jest/subscription-plans.test.js` | 16 | +6 (P0-4~P0-6) |
| `tests/jest/wallet.test.js` | 48 | +2 (P1-1, P1-2) |
| `tests/jest/rental-contract.test.js` | 24 | +4 (P2-1, P2-4~P2-6) |
| `tests/jest/trust.test.js` | 13 | +3 (P3-2, P3-4, P3-6) |
| `tests/test-subscription-plans-live.js` | 0 (new) | +4 (P4-1~P4-4) |
| `tests/test-rental-e2e.js` | 0 (new) | +3 (P4-5~P4-7) |
