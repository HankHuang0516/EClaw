# News Publishing API — 多平台文章發布系統

## 分析：入口網站語系國家 vs 可用 API 平台

### 語系國家列表（8 個）
| 語系 | 國家/地區 |
|------|----------|
| en | 全球（美/英/澳等） |
| zh-TW | 台灣、香港 |
| zh-CN | 中國大陸 |
| ja | 日本 |
| ko | 韓國 |
| th | 泰國 |
| vi | 越南 |
| id | 印尼 |

### 各國主流文章/部落格平台 — API 可用性分析

| 國家 | 平台 | 有 Publishing API? | 狀態 |
|------|------|-------------------|------|
| **全球 (en)** | DEV.to | ✅ Forem API v1 | API Key 認證，Markdown |
| 全球 (en) | Medium | ❌ API 已棄用 | 不再核發新 token |
| **全球** | WordPress.com | ✅ REST API v2 | OAuth 2.0 |
| **全球** | Telegraph (Telegra.ph) | ✅ telegra.ph API | 極簡，自動建帳號 |
| 全球 | Blogger | ✅ 已支援 | — |
| 全球 | Hashnode | ✅ 已支援 | — |
| 全球 | X/Twitter | ✅ 已支援 | — |
| **日本 (ja)** | Qiita | ✅ API v2 | OAuth/Bearer Token |
| 日本 | note.com | ❌ 無公開 API | 僅 Web 介面 |
| 日本 | Zenn.dev | ❌ 唯讀 API | 用 Git 發布 |
| 日本 | Hatena Blog | ⚠️ AtomPub API | 過時協議，僅限日本帳號 |
| **韓國 (ko)** | Tistory | ❌ API 已關閉 | 2024/02 停止服務 |
| 韓國 | Naver Blog | ❌ 僅搜尋 API | 無寫入功能 |
| **中國 (zh-CN)** | 微信公眾號 | ✅ 草稿 API | AppID+Secret+IP白名單 |
| 中國 | CSDN / 掘金 / 簡書 | ❌ 無公開 API | — |
| **泰/越/印尼** | 無本地平台有 API | ❌ | 使用全球平台 |

### 結論：需新增的平台（5 個）

已支援：Blogger、Hashnode、X/Twitter
新增：

1. **DEV.to** — 全球最大開發者社群，Forem API v1
2. **WordPress.com** — 全球最大部落格平台，REST API
3. **Telegraph (Telegra.ph)** — 極簡發布（Telegram 生態），零門檻
4. **Qiita** — 日本最大技術知識分享平台
5. **WeChat Official Account (微信公眾號)** — 中國大陸主流內容平台

---

## 實作計畫

### Step 1: DEV.to (Forem API)

**API 規格：**
- Base URL: `https://dev.to/api`
- Auth: `api-key` header
- Content: Markdown

**路由：**
| Method | Route | 說明 |
|--------|-------|------|
| GET | `/devto/me` | 取得認證用戶資訊 |
| POST | `/devto/publish` | 發布文章 |
| PUT | `/devto/post/:postId` | 更新文章 |
| DELETE | `/devto/post/:postId` | 刪除（取消發布） |

**Body (publish):**
```json
{
  "title": "string",
  "body_markdown": "string",
  "published": true,
  "tags": ["string"],
  "series": "string (optional)",
  "canonical_url": "string (optional)"
}
```

**ENV:** `DEVTO_API_KEY`

---

### Step 2: WordPress.com (REST API)

**API 規格：**
- Base URL: `https://public-api.wordpress.com/wp/v2/sites/{site_id}`
- Auth: OAuth 2.0 Bearer Token
- Content: HTML

**路由：**
| Method | Route | 說明 |
|--------|-------|------|
| GET | `/wordpress/me` | 取得用戶 + 站台列表 |
| POST | `/wordpress/publish` | 發布文章 |
| PUT | `/wordpress/post/:postId` | 更新文章 |
| DELETE | `/wordpress/post/:postId` | 刪除文章 |

**Body (publish):**
```json
{
  "siteId": "string",
  "title": "string",
  "content": "string (HTML)",
  "status": "publish|draft",
  "categories": ["string"],
  "tags": ["string"]
}
```

**ENV:** `WORDPRESS_ACCESS_TOKEN`

---

### Step 3: Telegraph (Telegra.ph API)

**API 規格：**
- Base URL: `https://api.telegra.ph`
- Auth: access_token（由 createAccount 自動產生）
- Content: Node 格式（支援 HTML 轉換）

**路由：**
| Method | Route | 說明 |
|--------|-------|------|
| POST | `/telegraph/account` | 建立/取得帳號 |
| POST | `/telegraph/publish` | 發布頁面 |
| PUT | `/telegraph/page/:path` | 編輯頁面 |
| GET | `/telegraph/page/:path/views` | 查看瀏覽數 |

**Body (publish):**
```json
{
  "title": "string",
  "content": "string (HTML)",
  "author_name": "string (optional)",
  "author_url": "string (optional)"
}
```

**ENV:** `TELEGRAPH_ACCESS_TOKEN`（或自動建立）

---

### Step 4: Qiita (API v2)

**API 規格：**
- Base URL: `https://qiita.com/api/v2`
- Auth: Bearer Token
- Content: Markdown
- Rate Limit: 1000/hr (authenticated)

**路由：**
| Method | Route | 說明 |
|--------|-------|------|
| GET | `/qiita/me` | 取得認證用戶資訊 |
| POST | `/qiita/publish` | 發布文章 |
| PUT | `/qiita/post/:postId` | 更新文章 |
| DELETE | `/qiita/post/:postId` | 刪除文章 |

**Body (publish):**
```json
{
  "title": "string",
  "body": "string (Markdown)",
  "tags": [{"name": "string", "versions": []}],
  "private": false,
  "tweet": false
}
```

**ENV:** `QIITA_ACCESS_TOKEN`

---

### Step 5: WeChat Official Account (微信公眾號)

**API 規格：**
- Base URL: `https://api.weixin.qq.com/cgi-bin`
- Auth: access_token (via AppID + AppSecret)
- Content: HTML
- 限制：需 IP 白名單、僅產生草稿（需手動發布）

**路由：**
| Method | Route | 說明 |
|--------|-------|------|
| GET | `/wechat/token` | 取得/刷新 access_token |
| POST | `/wechat/upload-image` | 上傳封面圖 |
| POST | `/wechat/draft` | 建立草稿文章 |
| GET | `/wechat/drafts` | 列出草稿 |
| DELETE | `/wechat/draft/:mediaId` | 刪除草稿 |

**Body (draft):**
```json
{
  "title": "string",
  "content": "string (HTML)",
  "thumb_media_id": "string (封面圖 media_id)",
  "author": "string (optional)",
  "digest": "string (摘要, optional)"
}
```

**ENV:** `WECHAT_APP_ID`, `WECHAT_APP_SECRET`

---

### Step 6: 統一列表端點

新增一個端點列出所有支援的平台：

```
GET /api/publisher/platforms
```

回傳：
```json
{
  "platforms": [
    { "id": "blogger", "name": "Blogger", "region": "global", "status": "configured|not_configured", "authType": "oauth" },
    { "id": "hashnode", "name": "Hashnode", "region": "global", "status": "...", "authType": "api_key" },
    { "id": "x", "name": "X (Twitter)", "region": "global", "status": "...", "authType": "oauth1a" },
    { "id": "devto", "name": "DEV.to", "region": "global", "status": "...", "authType": "api_key" },
    { "id": "wordpress", "name": "WordPress.com", "region": "global", "status": "...", "authType": "bearer" },
    { "id": "telegraph", "name": "Telegraph", "region": "global", "status": "...", "authType": "auto" },
    { "id": "qiita", "name": "Qiita", "region": "ja", "status": "...", "authType": "bearer" },
    { "id": "wechat", "name": "WeChat Official Account", "region": "zh-CN", "status": "...", "authType": "app_credentials" }
  ]
}
```

### Step 7: 測試

- 新增 `backend/tests/test-publisher-platforms.js` 覆蓋所有新平台 API
- 新增 Jest 單元測試驗證 input validation
- 更新 CLAUDE.md 的 Regression Tests 清單

### 修改檔案

| 檔案 | 修改內容 |
|------|---------|
| `backend/article-publisher.js` | 新增 5 個平台的路由 + `/platforms` 端點 |
| `backend/.env.example` | 新增 env var 說明 |
| `CLAUDE.md` | 更新 Article Publisher coverage、env vars、test 清單 |
| `backend/tests/test-publisher-platforms.js` | 新增 regression test |
| `backend/tests/jest/publisher.test.js` | 新增 Jest 測試 |

---

## 風險與注意事項

1. **微信公眾號** 需要 IP 白名單設定，Railway 的 IP 可能變動 → 需用固定 IP 代理或記錄
2. **Telegraph** 帳號是匿名的，access_token 遺失無法恢復
3. **DEV.to** 刪除文章實際是 unpublish（設 published: false）
4. **WordPress.com** OAuth 需在 developer.wordpress.com 註冊 app
5. 所有新平台的 env var 都是 optional，未設定時端點回傳 501 Not Configured
