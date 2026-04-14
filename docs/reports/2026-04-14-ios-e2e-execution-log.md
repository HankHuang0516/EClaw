# iOS E2E 執行記錄

> 開始時間：TBD（等待第一次 TestFlight build）
> 藍圖：[iOS E2E Blueprint](../plans/2026-04-14-ios-e2e-blueprint.md)
> 執行者：Claude Code + 人類手動（Simulator / 實機）
> 狀態：⏸️ **尚未開始** — 先完成 P0 開發工作

---

## 使用方式

此文件作為 iOS E2E 執行時的即時記錄。每個 Batch 跑完後：
1. 更新下方對應 Batch 表格
2. 發現 bug 記錄到「Bugs Found」區
3. 更新「Session State」區（供下次 session 接續）

狀態圖例：⬜ 待跑、⏳ 執行中、✅ PASS、❌ FAIL、⏭️ 跳過

---

## Session State

```
build_version: —
build_number: —
testflight_status: —
last_completed_batch: 0
last_completed_step: —
bugs_found: []
sandbox_tester: apple-review-test@eclawbot.com
renter_device: cb9aec71-ee50-47df-84a2-b8213c681cc4
renter_balance: —
owner_balance: —
apns_token: —
```

---

## Batch 0：環境預檢 ⬜

| Step | 結果 | 備註 |
|------|------|------|
| Mac / MacinCloud 可用 | ⬜ | |
| Xcode 16+ 安裝 | ⬜ | |
| EAS preview build 跑完 | ⬜ | |
| TestFlight 收到 build | ⬜ | |
| Sandbox tester 建立 | ⬜ | |
| APNs Key 上傳 | ⬜ | |
| `/.well-known/apple-app-site-association` 部署 | ⬜ | |
| Renter 帳號就緒 | ⬜ | |
| Owner 帳號就緒 | ⬜ | |

---

## Batch 1：IAP 核心流程 ⬜ (BLOCKER)

| Step | 結果 | 備註 |
|------|------|------|
| C1 設 balance=10 | ⬜ | |
| C2 租借 deposit=5 bot | ⬜ | |
| C3 消耗 token 歸零 | ⬜ | |
| C4 ended_zero_balance | ⬜ | |
| C5 App 顯示加值通知 | ⬜ | |
| C6 開 wallet.tsx | ⬜ | |
| C7 5 tier 正確顯示 | ⬜ | |
| C8 Sandbox 彈窗 | ⬜ | |
| C9 完成付款 | ⬜ | |
| C10 呼叫 verify-apple | ⬜ | |
| C11 後端驗證成功 | ⬜ | |
| C12 finishTransaction | ⬜ | |
| C13 UI 更新餘額 | ⬜ | |
| C14 Ledger 正確 | ⬜ | |

**結論**：⬜ 待跑

---

## Batch 2：Sign in with Apple ⬜ (BLOCKER)

| Step | 結果 | 備註 |
|------|------|------|
| D1 看到 Apple 按鈕 | ⬜ | |
| D2 Apple 彈窗 | ⬜ | |
| D3 識別 token 返回 | ⬜ | |
| D4 後端驗證 + 建 user | ⬜ | |
| D5 Dashboard 顯示 | ⬜ | |
| D6 登出再登入 | ⬜ | |
| D7 Google/FB 並存 | ⬜ | |

---

## Batch 3：Happy Path ⬜ (BLOCKER)

| Step | 結果 | 備註 |
|------|------|------|
| A1–A2 listing + arena | ⬜ | |
| A3 上架 | ⬜ | |
| A4–A9 Renter 租借 | ⬜ | |
| A10–A11 my-rentals | ⬜ | |
| A12 Chat native | ⬜ | |
| A13–A14 結束+評價 | ⬜ | |
| A15 Wallet 收益 | ⬜ | |

---

## Batch 4：提前終止 ⬜

_待跑_

## Batch 5：App 生命週期 ⬜

_待跑_

## Batch 6：WebView 橋接 ⬜

_待跑_

## Batch 7：IAP 異常 ⬜ (BLOCKER)

| Step | 結果 | 備註 |
|------|------|------|
| H1 取消付款 | ⬜ | |
| H2 付款中斷 | ⬜ | |
| H3 重複 transactionId | ⬜ | |
| H4 無效 receipt | ⬜ | |
| H5 prod→sandbox fallback | ⬜ | |
| H6 退款通知 | ⬜ | |

## Batch 8：Universal Link ⬜

_待跑_

## Batch 9：Push 通知 ⬜ (BLOCKER, 需實機)

| Step | 結果 | 備註 |
|------|------|------|
| J1 首次權限請求 | ⬜ | |
| J2 APNs token 註冊 | ⬜ | |
| J3 後端 push 觸發 | ⬜ | |
| J4 前景收到 | ⬜ | |
| J5 背景收到 | ⬜ | |
| J6 鎖定畫面 | ⬜ | |

## Batch 10：權限請求 ⬜

_待跑_

## Batch 11：網路切換 ⬜

_待跑_

## Batch 12：iPad ⬜ (P2)

_待跑_

## Batch 13：Apple Review 紅線 ⬜ (BLOCKER)

| # | 結果 | 備註 |
|---|------|------|
| M1 無非 IAP 付款 | ⬜ | |
| M2 無「網頁加值」字 | ⬜ | |
| M3 WebView 付款攔截 | ⬜ | |
| M4 Sign in with Apple 並存 | ⬜ | |
| M5 NSUsageDescription 具體 | ⬜ | |
| M6 PrivacyInfo.xcprivacy 存在 | ⬜ | |

## Batch 14：隱私合規 ⬜ (BLOCKER)

| # | 結果 | 備註 |
|---|------|------|
| N1 無 tracking 請求 | ⬜ | |
| N2 第三方 SDK 無 IDFA | ⬜ | |
| N3 刪帳號可用 | ⬜ | |
| N4 Offline 快取無敏感 | ⬜ | |

## Batch 15：效能 ⬜

| 指標 | 目標 | 實測 | 結果 |
|------|------|------|------|
| 冷啟動 | < 3s | — | ⬜ |
| 熱啟動 | < 1s | — | ⬜ |
| Chat 載入 | < 2s | — | ⬜ |
| Memory idle | < 300MB | — | ⬜ |
| Frame rate | 60fps | — | ⬜ |

## Batch 16：Accessibility ⬜

_待跑_

## Batch 17：清理 ⬜

_待跑_

---

## Bugs Found

格式：`[BUG-iOS-{NNN}] {嚴重度} {描述}`

- _（尚無）_

---

## 最終統計

| 類別 | Total | Pass | Fail | Pending |
|------|-------|------|------|---------|
| BLOCKER | 9 Batch | 0 | 0 | 9 |
| P1 | 4 Batch | 0 | 0 | 4 |
| P2 | 1 Batch | 0 | 0 | 1 |
| **總計** | **14** | **0** | **0** | **14** |

---

## 送審決策

- [ ] 所有 BLOCKER Batch PASS → 可送審
- [ ] P1 Batch 至少 80% PASS
- [ ] 已知 bug 都不是 P0
- [ ] Sandbox tester 資料寫入 App Review Notes

---

## 版本歷史

| 版本 | 日期 | 說明 |
|------|------|------|
| 1.0.0 | 2026-04-14 | 初版範本，等待實際執行填值 |
