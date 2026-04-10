# BRM Scenario Test Matrix — X × Y Full Coverage

**X 軸（路由方式）**：Human（Portal UI 操作） / Bot（API curl 呼叫）
**Y 軸（角色）**：Renter（租借者） / Owner（出租者）

每個場景涵蓋完整的端到端流程，從進入頁面/呼叫 API 開始到最終結果驗證。

---

## Matrix Overview

| | **Human (Portal UI)** | **Bot (API curl)** |
|---|---|---|
| **Owner** | Scenario A | Scenario B |
| **Renter** | Scenario C | Scenario D |

---

## Scenario A: Owner × Human (Portal UI)

**角色**：Bot 擁有者，透過 Web Portal 上架出租

### 前置條件
- 已登入 Portal（有 JWT cookie）
- 至少有一個已綁定的 bot entity

### 流程

| Step | 操作 | 頁面 | 驗證 |
|------|------|------|------|
| A1 | 前往 Settings → Wallet 儲值 | `settings.html` → `wallet.html` | 看到餘額卡片、儲值方案 |
| A2 | 前往 Marketplace 頁面 | `marketplace.html` (nav bar 🤖) | 頁面載入、搜尋框可用 |
| A3 | 建立新 listing（需透過 API — Portal 尚無 listing 編輯頁） | POST `/api/rental/listing` | 回傳 `{success:true, listing:{id, status:'draft'}}` |
| A4 | 執行面試（需透過 API） | POST `/api/rental/listing/:id/interview` | 回傳面試分數 ≥ 60 |
| A5 | 發布 listing | POST `/api/rental/listing/:id/publish` | status → `listed`，在 marketplace 可搜到 |
| A6 | 在 Marketplace 搜尋自己的 listing | `marketplace.html` 搜尋 | 看到自己的 bot 卡片 |
| A7 | 等待租客租借 | — | 不需操作 |
| A8 | 前往 My Rentals → Leasing Out tab | `my-rentals.html` → "Leasing Out" | 看到 active 契約 |
| A9 | 查看收入 | `wallet.html` → 交易紀錄 | 看到 `rental_income` 類型的 ledger 條目 |
| A10 | 契約結束後查看評分 | Marketplace → 自己的 listing | 看到 avg_rating 更新 |
| A11 | 暫停 listing | POST `/api/rental/listing/:id/pause` | status → `paused`，marketplace 不可見 |
| A12 | 下架 listing | DELETE `/api/rental/listing/:id` | status → `delisted` |

### 驗證清單
- [ ] A1: wallet.html 顯示餘額 + 5 個儲值方案
- [ ] A2: marketplace.html 載入 + grid 渲染
- [ ] A3: listing 建立成功（draft）
- [ ] A5: listing 發布後在 marketplace 可搜到
- [ ] A8: my-rentals.html Leasing Out tab 顯示契約
- [ ] A9: wallet 歷史顯示 rental_income
- [ ] A11: pause 後 marketplace 搜不到
- [ ] A12: delist 後 listing 永久移除

---

## Scenario B: Owner × Bot (API curl)

**角色**：Bot 擁有者的自動化 bot，透過 API 管理上架

### 前置條件
- 有有效的 `deviceId` + `botSecret`（bot auth）
- 或有有效的 JWT token（user auth for /api/rental endpoints）

### 流程

| Step | API Call | Method | Expected Response |
|------|----------|--------|-------------------|
| B1 | 建立 listing | `POST /api/rental/listing` `{ownerDeviceId, ownerEntityId, title, rateMliPerKtoken}` | `{success:true, listing:{id, status:'draft'}}` |
| B2 | 更新 listing rate | `PATCH /api/rental/listing/:id` `{rateMliPerKtoken: 8000}` | `{success:true, listing:{updated_at}}` |
| B3 | 嘗試更新 capabilities（應被拒） | `PATCH /api/rental/listing/:id` `{capabilities:{...}}` | `400 {error:'no_fields_to_update'}` |
| B4 | 發布（未面試） | `POST /api/rental/listing/:id/publish` | `400 {error:'interview_not_passed'}` |
| B5 | 面試通過後發布 | `POST /api/rental/listing/:id/publish` | `{success:true, listing:{status:'listed'}}` |
| B6 | 查詢我的 listings | `GET /api/rental/my-listings` | 回傳 listing 陣列 |
| B7 | 查看 marketplace 自己的 listing | `GET /api/rental/marketplace?sort=rating` | 包含自己的 listing |
| B8 | 查看我的契約（作為 owner） | `GET /api/rental/my-contracts?role=owner` | 回傳 owner 角色的契約 |
| B9 | 查看 listing 評價 | `GET /api/rental/listing/:id/reviews` | 回傳評價陣列 |
| B10 | 查看信用分數 | `GET /api/rental/credit-score` | `{success:true, score:{...}}` |
| B11 | 暫停 listing | `POST /api/rental/listing/:id/pause` | status → `paused` |
| B12 | 恢復 listing | — (目前無 resume API，需重新 publish) | — |
| B13 | 下架 listing | `DELETE /api/rental/listing/:id` | status → `delisted` |
| B14 | 查看錢包餘額 | `GET /api/wallet/balance` | `{wallet:{balance_ecoin, held_ecoin}}` |
| B15 | 查看交易紀錄 | `GET /api/wallet/history?type=rental_income` | 過濾出租金收入 |

### 驗證清單
- [ ] B1-B2: listing CRUD 正常
- [ ] B3: locked fields 保護有效
- [ ] B4-B5: 面試門檻執行
- [ ] B8: role=owner 過濾正確
- [ ] B14-B15: 收入可查詢

---

## Scenario C: Renter × Human (Portal UI)

**角色**：想租借 bot 的使用者，透過 Web Portal 操作

### 前置條件
- 已登入 Portal
- 有足夠的 e幣 餘額（透過 wallet 頁面儲值或 admin grant）

### 流程

| Step | 操作 | 頁面 | 驗證 |
|------|------|------|------|
| C1 | 看到 nav bar e幣 badge | 任何頁面 | 💎 badge 顯示餘額數字，可點擊 |
| C2 | 點擊 badge 進入 wallet | `wallet.html` | 看到餘額 + 歷史 + 儲值方案 |
| C3 | 前往 Marketplace | `marketplace.html` (nav bar 🤖) | 看到 bot grid |
| C4 | 搜尋 bot（輸入關鍵字） | `marketplace.html` 搜尋框 | grid 即時過濾 |
| C5 | 排序（最便宜） | 下拉選單 → Cheapest | 卡片按 rate 升序排列 |
| C6 | 點擊 bot 卡片 | `marketplace.html` overlay | 看到詳情：rate、deposit、duration、rating、uptime |
| C7 | 選擇租期 + 點擊 Rent Now | overlay → 按鈕 | 跳轉 `my-rentals.html`，顯示 active 契約 |
| C8 | 檢查 wallet 餘額減少 | `wallet.html` | balance 減少（deposit 被 hold） |
| C9 | 與租借 bot 對話 | `chat.html` | （P2-F handover 後）rental entity 出現在 chat list |
| C10 | 查看 token 消耗 | `wallet.html` → history | 看到 `rental_spend` 類型 |
| C11 | 提前結束契約 | `my-rentals.html` → "End Early" 按鈕 | 確認對話框 → 契約結束 |
| C12 | 提交評分 | `my-rentals.html` → "Review" 按鈕 | 星星選擇 + 留言 → 提交 |
| C13 | 提出申訴 | `my-rentals.html` → "Dispute" 按鈕 | 選擇類型 → 提交 |
| C14 | 查看申訴狀態 | `my-rentals.html` → Disputes tab | 看到申訴列表 + 狀態 |
| C15 | 使用邀請碼 | `invite.html` → 輸入框 | 兌換成功，餘額增加 100 e幣 |
| C16 | 分享自己的邀請碼 | `invite.html` | 看到 6 碼 + 分享連結 + 複製按鈕 |

### 驗證清單
- [ ] C1: e幣 badge 正確顯示餘額
- [ ] C3-C5: marketplace 搜尋 + 排序
- [ ] C6-C7: 租借流程可完成
- [ ] C8: deposit 正確扣除（held_ecoin 增加）
- [ ] C11: 提前結束 → 50% 押金退還
- [ ] C12: 評分提交 + listing avg 更新
- [ ] C13-C14: 申訴提交 + 可追蹤
- [ ] C15-C16: 邀請碼可兌換 + 可分享

---

## Scenario D: Renter × Bot (API curl)

**角色**：Renter 的自動化 bot 透過 API 執行租借流程

### 前置條件
- 有有效的 JWT token 或 `deviceSecret`
- 有足夠的 e幣 餘額

### 流程

| Step | API Call | Method | Expected Response |
|------|----------|--------|-------------------|
| D1 | 查看錢包餘額 | `GET /api/wallet/balance` | `{wallet:{balance_ecoin}}` ≥ deposit + buffer |
| D2 | 搜尋 marketplace | `GET /api/rental/marketplace?sort=rating&limit=10` | 回傳 listed + passed listings |
| D3 | 查看 listing 詳情 | `GET /api/rental/listing/:id` | 回傳完整 listing（owner_user_id 被隱藏） |
| D4 | 查看 listing 評價 | `GET /api/rental/listing/:id/reviews` | 回傳歷史評價 |
| D5 | 年齡確認（首次租借） | `GET /api/rental/age-check` → 若 false → `POST /api/rental/age-confirm` | `{confirmed: true}` |
| D6 | 啟動租賃 | `POST /api/rental/contract` `{listingId, renterDeviceId, durationMinutes}` | `{success:true, contract:{id, status:'active'}}` |
| D7 | 驗證餘額不足被拒 | `POST /api/rental/contract` (with low balance) | `400 {error:'insufficient_balance_for_rental'}` |
| D8 | 驗證自租被拒 | `POST /api/rental/contract` (owner rents own) | `400 {error:'self_rental_forbidden'}` |
| D9 | 驗證獨佔性 | `POST /api/rental/contract` (same listing) | `400 {error:'listing_already_rented'}` |
| D10 | 查看我的契約 | `GET /api/rental/my-contracts?role=renter` | 回傳 renter 角色的契約 |
| D11 | 正常對話（透過 speak） | `POST /api/client/speak` `{entityId: rentalSlot}` | token 被計量，wallet 扣款 |
| D12 | 查看 token 消耗紀錄 | `GET /api/wallet/history?type=rental_spend` | 每筆對話的扣款 |
| D13 | 正常結束契約 | `POST /api/rental/contract/:id/end` `{endReason:'ended_normal'}` | deposit 全額退還 |
| D14 | 提前結束契約 | `POST /api/rental/contract/:id/end` `{endReason:'ended_early_by_renter'}` | 50% deposit 退還 |
| D15 | 提交評分 | `POST /api/rental/contract/:id/review` `{rating:4, comment:'Good bot'}` | `{success:true, review:{id}}` |
| D16 | 重複評分被拒 | `POST /api/rental/contract/:id/review` (same contract) | `400 {error:'review_already_exists'}` |
| D17 | 提出申訴 | `POST /api/rental/contract/:id/dispute` `{type:'bot_crash'}` | `{success:true, dispute:{id}}` |
| D18 | 查看申訴 | `GET /api/rental/my-disputes` | 回傳申訴列表 |
| D19 | 兌換邀請碼 | `POST /api/invite/redeem` `{code:'ABCDEF'}` | `{success:true, inviteeRewardEcoin:100}` |
| D20 | 查看邀請統計 | `GET /api/invite/stats` | `{totalInvited, totalEarnedMli}` |
| D21 | 查看信用分數 | `GET /api/rental/credit-score` | `{score:{...}}` |
| D22 | 對帳 | `GET /api/wallet/admin/reconcile` (admin only) | `{report:{ok:true}}` |

### 驗證清單
- [ ] D2-D3: marketplace 搜尋 + listing 隱藏 owner_user_id
- [ ] D5: 年齡確認 gate 執行
- [ ] D6: 租賃啟動 + deposit hold
- [ ] D7-D9: 3 種拒絕場景正確
- [ ] D11-D12: token 計量 + 扣款
- [ ] D13: 正常結束 → full deposit refund
- [ ] D14: 提前結束 → 50% refund
- [ ] D15-D16: 評分 + 防重複
- [ ] D17-D18: 申訴 + 查詢
- [ ] D19: 邀請碼兌換 + wallet 入帳

---

## Cross-Scenario Interactions

| Test | X | Y | 驗證內容 |
|------|---|---|---------|
| **Owner lists → Renter rents (Human×Human)** | A3-A5 | C3-C7 | Owner 在 marketplace 看到被租走的 listing 半透明 |
| **Owner lists → Bot rents (API)** | B1-B5 | D6 | API-to-API 全流程 |
| **Bot owner → Human renter** | B1-B5 | C3-C7 | 混合模式：API 上架，Portal 租借 |
| **Human owner → Bot renter** | A3-A5 | D6-D12 | 混合模式：Portal 上架，API 租借 |
| **Renter reviews → Owner sees** | C12 | A10 | 評分反映在 listing avg_rating |
| **Renter disputes → Admin resolves** | C13 | admin API | 申訴→仲裁→deposit 退還 |
| **Renter invites → Friend redeems** | C16 | D19 | 邀請碼跨用戶流通 |
| **Balance exhaustion flow** | — | D11 (loop) | 連續對話 → 餘額歸零 → 禁言 → 押金扣最後一筆 → 退還剩餘 |
| **Cooldown enforcement** | D13 → D6 | — | 結束後 24h 內不能再租同一 listing |
| **Blacklist enforcement** | admin API → D6 | — | 被黑名單的用戶租不到 bot |

---

## Test Environment Requirements

| 項目 | 需求 |
|------|------|
| User accounts | 至少 3 個：Owner, Renter, Admin |
| Devices | 至少 2 個：Owner device (with bound bot), Renter device |
| e幣 balance | Renter: ≥ 10,000 e幣 (admin grant) |
| Bot listing | Owner 建立 + 面試通過 + 發布 |
| Environment | `BROADCAST_TEST_DEVICE_ID` + `BROADCAST_TEST_DEVICE_SECRET` in `.env` |

---

## Automation Plan

**Phase 1 (immediate)**: 所有 "Bot (API curl)" 場景 (B + D) 寫成 `backend/tests/test-rental-e2e.js`

**Phase 2 (follow-up)**: 所有 "Human (Portal UI)" 場景 (A + C) 需要 browser automation (Playwright/Puppeteer) 或手動 QA checklist

**Phase 3**: Cross-Scenario 場景寫成 multi-device integration tests

---

*End of scenario matrix*
