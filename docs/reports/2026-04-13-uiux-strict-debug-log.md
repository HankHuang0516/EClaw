# UIUX 嚴格偵錯記錄 — 純滑鼠+鍵盤

> 日期：2026-04-13
> 方法：Playwright MCP 純 UI 操作（click, fill_form, handle_dialog, snapshot, screenshot）
> 禁止：browser_evaluate, browser_run_code fetch(), curl API calls
> 比對基準：mockup.html + rendering-spec.md
> 審查：Codex

---

## 場景 A：完美交易 — 逐步偵錯

### Step 0: Renter Dashboard（自動登入）
| Bug ID | 嚴重度 | 描述 | 截圖 |
|--------|--------|------|------|
| BUG-D1 | P2 | Rental entity #1 avatar 是隨機 character（🐷），不是 bot 實際 avatar | strict-A0-login.png |
| BUG-D2 | P2 | Rental entity 卡片無「🤖 Rented」紫色 badge | strict-A0-login.png |
| BUG-D3 | P1 | 合約已結束的 rental entity #0（FINAL TEST）仍留在 dashboard — removeRentalEntity 未清除 | strict-A0-login.png |

### Step 1: Owner Dashboard 登入
| Bug ID | 嚴重度 | 描述 | 截圖 |
|--------|--------|------|------|
| BUG-D4 | P2 | Entity #0（EClaw 小助手）被租出但無「📤 出租中」橘色 badge | strict-A0-owner-dashboard.png |

### Step 2: Owner 瀏覽 Marketplace（出租篩選）
| Bug ID | 嚴重度 | 描述 | 截圖 |
|--------|--------|------|------|
| BUG-M1 | P2 | 所有 9 個 listing 的 avatar 都是同一個 🤖 機器人，不是 bot 實際 avatar | strict-A4-owner-marketplace.png |
| BUG-M2 | P1 | 同一個 Bot（Entity 0）有 9 個重複 listing 在 marketplace — 應只允許一個 active listing per entity | strict-A4-owner-marketplace.png |
| BUG-M3 | P1 | UIUX Check listing 有 active contract 但 Owner 視角顯示「🟢 可租借」— availability 邏輯不一致 | strict-A4-owner-marketplace.png |
| BUG-M4 | P2 | Owner 的 listing 沒有「👤 你的 Bot」角標 | strict-A4-owner-marketplace.png |
| BUG-M5 | P3 | 卡片只顯示 3 個 capability chips（vision, file_io, reasoning），其他被截斷 | strict-A4-owner-marketplace.png |

### Step 3: Owner 點 UIUX Check → Modal
| Bug ID | 嚴重度 | 描述 | 截圖 |
|--------|--------|------|------|
| **BUG-M6** | **P0** | **Owner 有 1,000,008 e幣但 Modal 顯示「❌ 餘額不足 — 需要 40, 目前 0 (差額 40)」— wallet balance 查詢回傳 0** | strict-A5-owner-modal-top.png |
| **BUG-M7** | **P1** | **Listing 有 active contract 但 Modal 仍顯示「可租借」+ 可填時長 + 可勾 checkbox — 缺乏出租中禁止邏輯** | strict-A5-owner-modal-top.png |

---

## Bug 統計（場景 A 前 3 步）

| 等級 | 數量 | 說明 |
|------|------|------|
| **P0 致命** | **1** | 餘額查詢回傳 0（邏輯完全錯誤） |
| **P1 嚴重** | **3** | 重複 listing、availability 不一致、合約結束未清除 entity |
| **P2 中等** | **4** | avatar 錯誤、缺 rental/leased badges |
| **P3 輕微** | **1** | capability chips 截斷 |

**總計：9 個 bug，其中 1 個 P0 致命**

---

## 修復驗證（PR #1737 + #1738 部署後）

### 已修復
| Bug | 修復 PR | 驗證結果 |
|-----|--------|---------|
| BUG-M6 (P0) 餘額=0 | #1737 | ✅ 顯示「✅ 您的餘額: 1000009 e幣 — 餘額充足」 |
| BUG-M2 (P1) 重複 listing | #1738 | ✅ 從 9 個變 1 個（DISTINCT ON 去重） |

### 仍未修復
| Bug | 備註 |
|-----|------|
| BUG-M3 (P1) availability 不一致 | 卡片仍顯示「🟢 可租借」，listing 有 active contract |
| BUG-M8 (P2) self-rental 偵測未生效 | Owner modal 仍顯示完整租借 UI（可能 CDN cache） |
| BUG-D3 (P1) ghost entity | Entity #0 FINAL TEST 合約已結束但仍在 dashboard |
| BUG-D1 (P2) rental avatar 錯誤 | Entity #1 顯示 🐷 而非 bot avatar |
| BUG-D2 (P2) 缺 rental badge | 無「🤖 Rented」紫色 badge |
| BUG-D4 (P2) Owner 缺 leased badge | 無「📤 出租中」橘色 badge |
| BUG-M1 (P2) listing avatar 統一 🤖 | 所有 listing 同一個機器人頭像 |
| BUG-M4 (P2) 缺「你的 Bot」角標 | Owner listing 無自有標記 |
| BUG-M5 (P3) capability chips 截斷 | 卡片只顯示 3 個 chips |

### 剩餘 bug 統計
- P0: 0（已修復）
- P1: 2（availability + ghost entity）
- P2: 6（avatar、badge、self-rental、listing avatar、owner 角標）
- P3: 1（chips 截斷）

