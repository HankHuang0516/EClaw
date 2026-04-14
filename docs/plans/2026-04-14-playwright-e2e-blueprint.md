# Playwright MCP E2E 完整驗證藍圖

> 日期：2026-04-14
> 目的：上線前完整覆蓋 28 劇本 ~285 步驟
> 工具：Playwright MCP 純 UI + API_ASSIST
> 帳號：Owner = device login `480def4c`, Renter = `e2e-renter-test@eclawbot.com`

---

## 總覽

| 類別 | Batch | 劇本 | 時間 | 優先級 |
|------|-------|------|------|--------|
| 環境預檢 | 0 | — | 3 min | — |
| Listing 生命週期 | 1 | D | 12 min | BLOCKER |
| 操作順序錯亂 | 2 | V1-V6 | 15 min | BLOCKER |
| 防護機制 | 3 | C2/C4-C6 | 8 min | BLOCKER (C2) |
| 重複操作 | 4 | W1-W5 | 5 min | BLOCKER |
| 權限違規 | 5 | Z1-Z5 | 6 min | BLOCKER |
| 快取/併發 | 6 | X1-X3 | 8 min | BLOCKER |
| UI 狀態同步 | 7 | BB1-BB3 | 10 min | BLOCKER (BB1) |
| A2A 跨 Agent | 8 | G-H | 12 min | BLOCKER |
| 安全隔離 | 9 | I + U | 10 min | BLOCKER (I) |
| 檔案 + 計費 | 10 | J + K | 15 min | BLOCKER (K) |
| 併發 + 合約鎖定 | 11 | L + M + T | 12 min | BLOCKER |
| 申訴 + 信任 | 12 | N + O | 15 min | BLOCKER (N) |
| 筆記 + 跨頁一致 | 13 | P + Q | 15 min | BLOCKER (Q) |
| 邊界值 + 品質 | 14 | R + S | 10 min | BLOCKER (R) |
| 清理 | 15 | — | 2 min | — |
| **合計** | | **28 劇本** | **~158 min** | |

---

## LAUNCH_BLOCKER 場景（必須全部 PASS）

### Batch 0：環境預檢（3 min）
- 0-1: Renter email login
- 0-2: 記錄 Renter wallet balance
- 0-3: 切 Owner device login
- 0-4: 記錄 Owner wallet balance

### Batch 1：D 劇本 — Listing 生命週期 UI（12 min）
- D1: 建立 listing → 面試 → 上架 → marketplace 可見
- D2: Pause → Renter marketplace 不可見
- D3: Re-publish → Renter marketplace 可見
- D5: Delist → marketplace 消失
- D7: 舊 listingId 租借被擋

### Batch 2：V 劇本 — 操作順序錯亂（15 min）★最關鍵
- **V1**: 面試前上架 → `interview_not_passed` → 面試通過 → 再上架成功
- V4: Draft 直接租借 → `listing_not_available`
- **V5**: Delist 後 publish → `listing_permanently_delisted`
- V6: 有 active contract 時面試 → `interview_blocked_active_contract`

### Batch 3：C 劇本 — 防護機制（8 min）
- **C2**: 餘額不足時租借 → `insufficient_balance`
- C4: Active contract 時 delist → 記錄行為
- C5: 48h 後提交 review → `review_window_expired`
- C6: 重複 review → `review_already_exists`

### Batch 4：W 劇本 — 重複操作（5 min）
- W1: 連續 publish → `already_listed`
- W2: 重複 end-rental → `contract_already_ended`
- W4: 重複 dispute → `dispute_already_open`
- W5: 已出租再租 → `listing_already_rented`

### Batch 5：Z 劇本 — 權限違規（6 min）
- Z1: Renter publish Owner listing → `listing_forbidden`
- Z2: 第三方 end contract → `contract_end_forbidden`
- Z3: Renter PATCH listing → `listing_not_found_or_forbidden`
- Z4: Owner 自租 → `self_rental_forbidden`
- Z5: 未登入操作 → 401

### Batch 6：X 劇本 — 快取/併發（8 min）
- X1: 瀏覽器舊 rate → 合約 snapshot 用 DB 最新值
- X2: PATCH rate + POST contract 同時 → FOR UPDATE 保護
- X3: 面試完成後 UI 刷新觀察

### Batch 7：BB 劇本 — UI 狀態同步（10 min）★使用者 bug
- **BB1**: 面試完成後不刷新 → 「上架」按鈕是否出現
- BB2: 面試失敗 → UI 回饋正確
- BB3: publish error code 完整覆蓋

### Batch 8：G-H 劇本 — A2A 通訊（12 min）
- G1-G6: A2A task send → bot 回覆 → kanban 顯示
- G7-G8: 租借 bot speakTo + chat 雙向可見
- H1-H7: 持續對話鏈 + broadcast

### Batch 9：I+U 劇本 — 安全隔離（10 min）
- I4-I6: 租借 bot 讀/寫 device-vars → 隔離驗證
- I7: Gatekeeper 攔截敏感資訊
- U2-U6: Rate limit + 超大訊息

### Batch 10：J+K 劇本 — 檔案 + 計費（15 min）
- K1-K9: 發訊息 → bot 回覆 → wallet 扣費 → tokens_consumed 正確
- J1-J8: 檔案上傳/下載/跨 agent 傳輸

### Batch 11：L+M+T 劇本 — 併發 + 合約鎖定（12 min）
- L2-L3: Promise.all 搶租 → 只一份 active
- M2-M7: 合約中 rename/delete/pause → 鎖定保護
- T1-T8: Entity count +1/-1 生命週期

### Batch 12：N+O 劇本 — 申訴 + 信任（15 min）
- N1-N11: 申訴 → admin resolve/reject → wallet 補償
- O1-O7: 3 輪交易 → rating 累積正確

### Batch 13：P+Q 劇本 — 筆記 + 跨頁（15 min）
- P1-P27: Mission notes + Note pages + Kanban card notes
- Q1-Q12: wallet→marketplace→rent→wallet 閉環

### Batch 14：R+S 劇本 — 邊界值 + 品質（10 min）
- R1-R13: duration/rating/review 邊界值
- S1-S13: 9 頁面 0 JS errors + i18n 完整

### Batch 15：清理（2 min）
- Delist 所有測試 listing
- 結束殘留 active contract
- 最終截圖

---

## JEST_ONLY 場景（不用 Playwright）

| 劇本 | 原因 |
|------|------|
| Y1-Y4 | 需精確時間控制（mock Date.now） |
| AA1-AA4 | 需直接操作 DB / 重啟 server |
| K10-K11 | 需 cron 逐步扣費至 suspended |

---

## 帳號切換快捷方式

```javascript
// 切 Owner（免 UI logout/login）
await fetch('/api/auth/device-login', {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({deviceId:'480def4c-2183-4d8e-afd0-b131ae89adcc',
    deviceSecret:'3a4ddb10-2609-42b6-908a-f9d446c97ff9-7cff9697-6391-415d-a282-4e8aea3be49a'})
});

// 切 Renter
await fetch('/api/auth/login', {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({email:'e2e-renter-test@eclawbot.com', password:'Renter2026!'})
});

// 清 cooldown（多輪測試用）
await fetch('/api/rental/debug/clear-cooldown', {
  method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}
});
```

切換後必須 `browser_navigate` 刷新頁面。

---

## 執行規則

1. 每個 Batch 開始前截圖記錄初始狀態
2. 每個 BLOCKER 步驟失敗 → 記錄 bug → 停止該 Batch → 修復後重跑
3. NICE_TO_HAVE 步驟失敗 → 記錄但不阻塞
4. 每個 Batch 結束記錄 PASS/FAIL/SKIP 狀態
5. 所有 BLOCKER batch PASS 後方可上線
