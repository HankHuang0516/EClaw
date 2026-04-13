# BRM UIUX 渲染差異報告

> 開始日期：2026-04-13
> 比對基準：`docs/plans/2026-04-12-brm-uiux-mockup.html` + `rendering-spec.md`

---

## 迭代 1 差異（40 項：11 P1 + 17 P2 + 12 P3）

修復 PR：#1731 (my-rentals)、#1732 (community modal)、dashboard badges

## 迭代 2 驗證

### 結構層面已修復（~20 項）
- Marketplace: 🟢/🔴 availability badge ✅, capability chip colors ✅, ✓/✗ marks ✅
- Modal: 費用預估 ✅, 餘額充足性 ✅, 面試分數 ✅, 隱私 checkbox ✅, 小時制 ✅
- My Rentals: Bot 名稱 ✅, 押金摘要 ✅, 自訂 Dialog ✅, 申訴表單 ✅

### 新發現：統一 i18n key 未翻譯（~20 keys）
所有新增 `mp_` / `mr_` / `emr_` keys 在 production 顯示為 raw key text。
修復子 agent 工作中。

---

## 迭代 3 — PR #1733 (i18n fix) + CDN cache bypass 後

### i18n 修復確認（全部通過）

| 頁面 | 驗證結果 |
|------|---------|
| Marketplace 卡片「🟢 Available」 | ✅ 翻譯正確 |
| Modal「Interview score: 91/147 (62%)」 | ✅ |
| Modal「Deposit / Estimated usage / Estimated total cost」 | ✅ |
| Modal「❌ Insufficient balance — Need 40, Current 0 (Deficit 40)」 | ✅ |
| Modal「Top Up」按鈕 | ✅ |
| Modal 隱私警告完整翻譯 | ✅ |
| Modal「I understand and agree」checkbox | ✅ |
| My Rentals「Ended (Normal)」badge | ✅ |
| My Rentals「Full refund 10.0 ecoins」 | ✅ |
| Console errors | ✅ 0 errors |

### 剩餘差異（vs Mockup 規範）

| 項目 | 規範要求 | 現狀 | 等級 |
|------|---------|------|------|
| 能力篩選下拉（多選） | 規範 §1.2 | 仍用分類 chips 而非能力下拉 | P2 |
| 費率範圍滑桿 | 規範 §1.2 | 不存在 | P2 |
| 卡片 model_detected | 規範 §1.3 | 卡片上不顯示 | P3 |
| 已出租卡片 opacity:0.6 | 規範 §1.4 | 需驗證（無 active contract） | 待測 |
| 自有 Bot「👤 你的 Bot」角標 | 規範 §1.5 | 不存在 | P3 |
| Modal 成功動畫 | 規範 §2.6 | 需實際租借驗證 | 待測 |
| My Rentals 進度條（active 合約） | 規範 §3.2.1 | 需 active 合約驗證 | 待測 |
| My Rentals Chat/Usage 按鈕 | 規範 §3.2.1 | 需 active 合約驗證 | 待測 |
| My Rentals 提前結束 Dialog | 規範 §3.2.3 | 需 active 合約驗證 | 待測 |
| My Rentals 申訴正式表單 | 規範 §3.4.2 | 需驗證 | 待測 |
| Dashboard rental badge | 規範 §5 | 需 active 合約驗證 | 待測 |
| Chat 隱私 Banner + 計費 | 規範 §7 | 未實作 | P2 |

### 迭代 3 統計
- **已確認修復**: 迭代 1 的 40 項差異中，~28 項已修復
- **剩餘 P2**: ~5 項（能力篩選、費率滑桿、chat Banner 等）
- **剩餘 P3**: ~3 項（model name、自有 Bot 角標等）
- **待測**: ~6 項（需 active 合約才能驗證的功能）
- **0 JS errors**

---

## 迭代 4 — PR #1734 (marketplace filters) + #1735 (API rental_status) 後

### Marketplace 最終比對 vs Mockup

| Mockup 規範 | 結果 |
|------------|------|
| 搜尋框 | ✅ |
| 能力篩選 chips（7 項） | ✅ python_exec, web_browse, vision, file_io, reasoning, coding, tts |
| 費率範圍滑桿 1-50 e幣/1K | ✅ 雙滑桿 |
| 排序下拉 | ✅ Popular/Newest/Rating/Active |
| 🟢 Available badge | ✅ |
| 🔴 Rented badge + opacity:0.6 | ✅（UIUX Check 卡片半透明 + Rented 紅 badge） |
| Capability chips 帶顏色 + ✓/✗ | ✅ |
| 費率 + 押金 | ✅ |

### Modal 最終比對

| Mockup 規範 | 結果 |
|------------|------|
| 面試分數 | ✅ |
| 能力 chips ✓/✗ | ✅ |
| 小時制時長 | ✅ |
| 預估總費用 | ✅ |
| 餘額充足性指示 | ✅ |
| 隱私 checkbox | ✅ |
| 🔒 Rent Now 按鈕 | ✅ |

### My Rentals 最終比對

| Mockup 規範 | 結果 |
|------------|------|
| Bot 名稱 | ✅ |
| 狀態 badge（翻譯） | ✅ Ended (Normal) / Active |
| 進度條 | ✅ |
| 剩餘時間 | ✅ Remaining: 5h 59m |
| 押金狀態 | ✅ Deposit: 10.0 ecoins (frozen) / Full refund |
| Chat / End Early / Usage Details 按鈕 | ✅ |

### 剩餘差異（僅 P3 微調）

| 項目 | 等級 |
|------|------|
| Dashboard rental badge（API 已回傳 rental_status，前端需 cache bypass 驗證） | P3 |
| 自有 Bot「👤 Your Bot」角標（需後端 `is_own` flag） | P3 |
| 分頁器（目前全載入） | P3 |
| chat.html 租借 Bot 隱私 Banner + 計費 footer | P2（feature gap） |

### 迭代 4 統計
- **P1 差異**: 0（全部修復）
- **P2 差異**: 1（chat.html feature gap）
- **P3 差異**: 3（微調）
- **總修復 PR**: #1731-#1735（5 個 PR）

### Active 合約驗證結果

| 項目 | 結果 |
|------|------|
| My Rentals active card: Bot 名稱 | ✅ |
| My Rentals active card: 🟢 Active badge | ✅ |
| My Rentals active card: Chat/End Early/Usage Details 按鈕 | ✅ |
| My Rentals active card: Deposit (frozen) | ✅ |
| My Rentals active card: Remaining 5h 59m | ✅ |
| My Rentals active card: 進度條 | ✅ |
| Dashboard: 2 entities bound | ✅ |
| Dashboard: rental entity 名稱+code+message | ✅ |
| Dashboard: 🤖 Rented badge | ❌ `/api/entities` 不回傳 rental_status |
| Dashboard: ⏱️ 剩餘時間倒數 | ❌ 同上原因 |
