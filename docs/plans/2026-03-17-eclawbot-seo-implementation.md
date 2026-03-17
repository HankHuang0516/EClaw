# EClawbot SEO 改善實施計畫

> **日期：2026-03-17**
> **品牌區隔：EClaw → EClawbot（避免與 ELAUT E-Claw 混淆）**

---

## 現狀分析

### 已有的 SEO 基礎
- ✅ `robots.txt` — 但過度限制，僅開放 2 個路徑
- ✅ `sitemap.xml` — 但只有 2 個 URL
- ✅ meta description — 所有 portal 頁面都有
- ✅ OG/Twitter tags — 只有 index.html 有
- ✅ JSON-LD — 只有 SoftwareApplication，缺 Organization
- ✅ hreflang — 8 語言
- ✅ canonical URL — index.html 有
- ✅ 排程任務 `seo` 每日執行技術 SEO 審查

### 缺失的關鍵項目
| 項目 | 重要性 | 說明 |
|------|--------|------|
| **品牌名統一** | 🔴 P0 | 所有 meta/JSON-LD 仍寫 "EClaw"，應改 "EClawbot" |
| **OG image** | 🔴 P0 | 完全沒有 og:image，社群分享無圖片 |
| **llms.txt** | 🔴 P0 | AI 搜尋引擎讀取品牌資訊的專用檔案 |
| **Landing page** | 🔴 P0 | 無公開行銷頁面，只有登入表單 |
| **sitemap 擴充** | 🟡 P1 | 只有 2 URL，應加入 landing、API docs 等 |
| **FAQPage schema** | 🟡 P1 | 結構化 FAQ 讓搜尋結果顯示 FAQ rich snippet |
| **robots.txt 調整** | 🟡 P1 | 開放 landing page、FAQ 等公開頁面 |
| **OG tags 全頁面** | 🟡 P1 | 只有 index.html 有 OG，其他頁面缺失 |

---

## 實施步驟

### Step 1: 品牌 OG Image 上傳
- 將使用者提供的品牌圖放到 `backend/public/assets/og-image.png`
- 所有頁面加入 `og:image` 和 `twitter:image`

### Step 2: 建立 `llms.txt`
- 放在 `backend/public/llms.txt`，描述 EClawbot 品牌資訊
- 在 `index.js` 加入路由 `/llms.txt`

### Step 3: 建立 Landing Page
- `backend/public/landing.html` — 公開行銷頁面（不需登入）
- 包含：品牌介紹、功能亮點、FAQ、CTA
- 加入 FAQPage JSON-LD schema
- 路由：`/` 或 `/landing`

### Step 4: 更新品牌名 → EClawbot
- 所有 meta title/description 中的 "EClaw" → "EClawbot"
- JSON-LD 中的品牌名更新
- OG tags 更新

### Step 5: 擴充 sitemap.xml
- 加入 landing page、info 頁面等公開可爬取的 URL

### Step 6: 調整 robots.txt
- 允許爬取 landing page
- 加入 llms.txt 路徑

### Step 7: 測試驗證
- 確認所有頁面 meta tags 正確
- 驗證 JSON-LD 結構有效
- 確認 sitemap/robots 格式正確
