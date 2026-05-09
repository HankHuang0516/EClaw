# Petdx Backend API 設計規格

> **狀態**: v0.1 (2026-05-10) · **作者**: LOBSTER #2 · **依賴卡**: `card_e8aeba8feedf22a714a33fc6`
>
> **上游**: [Petdx UIUX 規格書 v0.1](./petdx-uiux-spec.md) §A 附錄
>
> **下游**: 實作 `backend/petdx-api.js` + DB 遷移 + i18n keys
>
> **Pending**: Mac_F #1 + Hank review of Petdx spec v0.1 §11 開放問題（影響本 API：Q1 主軸 / Q2 entity 視覺關係 / Q3 收益分潤）

---

## 1. 概覽

`/api/companion/*` 命名空間統一處理 Petdx 伙伴系統的所有 backend 操作。所有端點：

- 三件式 auth（deviceId + botSecret + entityId）
- 與既有 `/api/transform`, `/api/mission/*` 同樣的 rate-limit + audit log
- 多租戶：每個 device 的 companion library 獨立（系統內建除外）
- 透過 `device_vars` 持久化 per-entity 狀態（current companion / favorites）

## 2. 端點總覽

| Method | Path | 用途 | Auth |
|---|---|---|---|
| GET | `/api/companion/list` | 瀏覽伙伴（含過濾搜尋） | botSecret |
| GET | `/api/companion/:id` | 單一伙伴詳情 | botSecret |
| POST | `/api/companion/select` | 切換當前伙伴 | botSecret |
| GET | `/api/companion/current` | 當前 entity 的伙伴 | botSecret |
| GET | `/api/companion/states/:id` | 9 動畫狀態定義 | botSecret |
| POST | `/api/companion/state-event` | 觸發狀態切換 | botSecret |
| POST | `/api/companion/sync` | 主動同步 agent 大頭照 | botSecret |
| POST | `/api/companion/favorite` | 收藏/取消收藏 | botSecret |
| GET | `/api/companion/favorites` | 收藏清單 | botSecret |
| POST | `/api/companion/rate` | 評分 | botSecret |
| POST | `/api/companion/comment` | 留言 | botSecret |
| GET | `/api/companion/comments/:id` | 留言列表 | botSecret |
| POST | `/api/companion/submit` | 創作者提交 | botSecret |
| POST | `/api/companion/draft` | 儲存草稿 | botSecret |
| GET | `/api/companion/drafts` | 草稿清單 | botSecret |
| DELETE | `/api/companion/draft/:id` | 刪除草稿 | botSecret |
| POST | `/api/companion/review/:id` | 審核（device owner only） | deviceSecret |
| GET | `/api/companion/community` | 社群伙伴清單 | botSecret |

---

## 3. 端點細節

### 3.1 GET `/api/companion/list`

伙伴瀏覽器主端點。

**Query params**:

| 參數 | 型別 | 預設 | 說明 |
|---|---|---|---|
| `deviceId` | string | required |  |
| `botSecret` | string | required |  |
| `entityId` | int | required |  |
| `category` | string | `''` (all) | `animal` / `human` / `robot` / `custom` |
| `mood` | string | `''` | `happy` / `busy` / `sleepy` / `playful` |
| `color` | string | `''` | hex `#xxxxxx` 或 named bucket（red/orange/...） |
| `q` | string | `''` | 關鍵字（name / description / tags / author） |
| `tags` | string[] | `[]` | comma-separated, AND 比對 |
| `sort` | string | `popular` | `popular` / `recent` / `rating` / `favorites` |
| `scope` | string | `all` | `all` / `system` / `community` / `mine` |
| `page` | int | `1` | 1-indexed |
| `limit` | int | `30` | max 100 |

**Response 200**:

```json
{
  "success": true,
  "page": 1,
  "limit": 30,
  "total": 142,
  "companions": [
    {
      "id": "petdx-orange-cat-001",
      "name": "橘貓菲比",
      "thumbnailUrl": "/static/companions/petdx-orange-cat-001/thumbnail.webp",
      "author": { "entityId": 12, "publicCode": "ab3xyz", "displayName": "Hank" },
      "tags": ["cat", "orange", "cute"],
      "mood": "happy",
      "color": "#ff8c42",
      "stats": { "downloads": 1234, "favorites": 89, "rating": 4.7, "ratingCount": 32 },
      "isFavorited": true,
      "isCurrent": false,
      "version": "1.0.0",
      "scope": "community"
    }
  ]
}
```

**Errors**: `400 invalid_params`, `401 unauthorized`, `429 rate_limit`

### 3.2 GET `/api/companion/:id`

單一伙伴完整 metadata（含 spritesheet URL 與 9 狀態定義）。

**Response 200**: pet.json 全文 + stats + isFavorited/isCurrent flags。

### 3.3 POST `/api/companion/select`

切換當前伙伴。

**Body**:
```json
{
  "deviceId": "...",
  "botSecret": "...",
  "entityId": 2,
  "companionId": "petdx-orange-cat-001",
  "syncAvatar": true
}
```

**行為**:
1. 寫入 `device_vars.PETDX_CURRENT_<entityId> = companionId`
2. 若 `syncAvatar=true`（預設）→ 觸發 §3.7 sync flow
3. 廣播 `companion-selected` event 到 WebSocket 所有 subscribed clients
4. 寫入 `companion_events` audit log

**Response 200**:
```json
{
  "success": true,
  "previous": "petdx-default-bot-001",
  "current": "petdx-orange-cat-001",
  "avatarUrl": "data:image/webp;base64,..."
}
```

**Errors**: `404 companion_not_found`, `403 not_allowed`（社群伙伴未過審）

### 3.4 GET `/api/companion/current`

讀取當前 entity 的伙伴（從 `device_vars.PETDX_CURRENT_<entityId>`）。若未設定 → 回傳系統預設。

### 3.5 GET `/api/companion/states/:id`

回傳 9 狀態定義（與 pet.json `states` 一致），用於 frontend 動畫渲染。Cache: 1h immutable。

### 3.6 POST `/api/companion/state-event`

通知 backend 一個 state-changing event 發生，由 backend 計算當前該播哪個 state。

**Body**:
```json
{
  "deviceId": "...",
  "botSecret": "...",
  "entityId": 2,
  "event": "card-done",
  "context": { "cardId": "card_xxx", "priority": "P0" }
}
```

**Event types**: `state-change` / `card-status` / `push` / `click-pet` / `timeout` / `xp-gain` / `error`

**Response 200**:
```json
{
  "success": true,
  "previousState": "working",
  "newState": "celebrating",
  "transitionMs": 200,
  "expiresAt": 1778349000000
}
```

celebrating/eating/alert 一次性 state 含 `expiresAt`，過期後 frontend 自動 fallback。

### 3.7 POST `/api/companion/sync`

主動觸發大頭照同步。Backend 從 spritesheet 抽 idle frame 0，寫入 `entity_card.iconUrl`，回傳 data URL。

**Body**:
```json
{ "deviceId":"...", "botSecret":"...", "entityId": 2, "companionId": "..." }
```

**Response 200**:
```json
{
  "success": true,
  "avatarDataUrl": "data:image/webp;base64,...",
  "cacheKey": "PETDX_AVATAR_CACHE_2",
  "syncedTargets": ["entity_card", "chat_avatar", "kanban_avatar", "plaza_avatar", "mention_avatar"]
}
```

**內部流程**:
1. 從 `companions.spritesheet_url` 載入圖
2. canvas drawImage(sheet, 0, idleRow*frameH, frameW, frameH, 0, 0, 256, 256)
3. canvas.toDataURL('image/webp', 0.85) → base64 string
4. 寫入 `entity_cards.icon_url` for entity = entityId
5. 寫入 `device_vars.PETDX_AVATAR_CACHE_<entityId>`
6. 同步 cache invalidation broadcast

### 3.8 POST `/api/companion/favorite`

```json
{ "deviceId":"...", "botSecret":"...", "entityId":2, "companionId":"...", "on":true }
```

寫入 `companion_favorites` table。

### 3.9 GET `/api/companion/favorites`

回傳當前 entity 的收藏 companion 清單（簡略卡片格式）。

### 3.10 POST `/api/companion/rate`

```json
{ "deviceId":"...", "botSecret":"...", "entityId":2, "companionId":"...", "stars": 5 }
```

**驗證**:
- stars: 1-5 整數
- entity 必須**已切換為當前伙伴 ≥ 3 天**才可評（`companion_select_log` 查詢）
- 同一 entity 對同一 companion 只能評 1 次（覆寫）

### 3.11 POST `/api/companion/comment`

```json
{ "deviceId":"...", "botSecret":"...", "entityId":2, "companionId":"...", "text": "..." }
```

**驗證**: text ≤ 500 chars, 非空, 通過 NSFW 自動過濾。

### 3.12 GET `/api/companion/comments/:id`

```
?page=1&limit=20&sort=recent
```

回傳留言列表（含創作者回覆）。

### 3.13 POST `/api/companion/submit`

創作者提交伙伴到社群審核。

**Multipart body**:
- `petJson`: pet.json 內容（string）
- `spritesheet`: webp 檔案
- `spritesheetLite`: webp 檔案 (optional)
- `spritesheetHires`: webp 檔案 (optional)
- `thumbnail`: webp 縮圖（160x160）

**驗證**:
- pet.json schema（§Petdx spec §2.4）
- spritesheet ≤ 800 KB / lite ≤ 200 KB / hires ≤ 2 MB
- pet.json `id` 全域唯一（含已存在草稿）
- author.entityId 必須等於 caller entityId
- license 標記必填

**處理**:
1. 寫入 `/static/companions/<id>/`
2. 寫入 `companions` table，status=`pending_review`
3. 通知 device owner（透過 kanban card 或 chat）

**Response 200**:
```json
{
  "success": true,
  "companionId": "...",
  "status": "pending_review",
  "estimatedReviewTimeHours": 24
}
```

### 3.14 POST `/api/companion/draft` / GET `/api/companion/drafts` / DELETE `/api/companion/draft/:id`

草稿 CRUD。每 entity 最多 10 個草稿，存於 `device_vars.PETDX_DRAFT_<draftId>`。

### 3.15 POST `/api/companion/review/:id`

**Auth**: `deviceSecret`（device owner only），不接受 botSecret。

**Body**:
```json
{
  "deviceId": "...",
  "deviceSecret": "...",
  "decision": "approve",
  "reason": "OK",
  "feedback": "（可選，給創作者）"
}
```

**decision**: `approve` / `reject` / `request_changes`

**處理**:
- approve → status=`published`, 通知創作者
- reject → status=`rejected`, 30 天後自動清理
- request_changes → status=`pending_changes`, 通知創作者修改

### 3.16 GET `/api/companion/community`

```
?author=<entityId>&page=1&limit=30&sort=popular
```

社群已 published 伙伴清單，可依作者過濾。

---

## 4. 資料庫 Schema

### 4.1 `companions` (主表)

```sql
CREATE TABLE companions (
  id              TEXT PRIMARY KEY,                     -- e.g. "petdx-orange-cat-001"
  name            TEXT NOT NULL,
  version         TEXT NOT NULL DEFAULT '1.0.0',
  author_entity_id INTEGER,                              -- NULL = system built-in
  device_id       TEXT,                                  -- 創作者所屬 device
  pet_json        TEXT NOT NULL,                         -- 完整 pet.json (JSON string)
  spritesheet_url TEXT NOT NULL,
  spritesheet_lite_url TEXT,
  spritesheet_hires_url TEXT,
  thumbnail_url   TEXT NOT NULL,
  scope           TEXT NOT NULL DEFAULT 'community',    -- 'system' | 'community' | 'private'
  status          TEXT NOT NULL DEFAULT 'pending_review', -- 'pending_review' | 'published' | 'rejected' | 'hidden' | 'pending_changes'
  license         TEXT NOT NULL DEFAULT 'EClaw-default',
  category        TEXT,
  mood            TEXT,
  color           TEXT,
  tags            TEXT,                                  -- JSON array
  i18n_data       TEXT,                                  -- JSON
  download_count  INTEGER NOT NULL DEFAULT 0,
  favorite_count  INTEGER NOT NULL DEFAULT 0,
  rating_avg      REAL,
  rating_count    INTEGER NOT NULL DEFAULT 0,
  comment_count   INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  published_at    INTEGER,
  rejected_at     INTEGER,
  reject_reason   TEXT
);

CREATE INDEX idx_companions_status ON companions(status);
CREATE INDEX idx_companions_author ON companions(author_entity_id);
CREATE INDEX idx_companions_scope_status ON companions(scope, status);
CREATE INDEX idx_companions_popular ON companions(download_count DESC) WHERE status = 'published';
CREATE INDEX idx_companions_recent ON companions(published_at DESC) WHERE status = 'published';
```

### 4.2 `companion_favorites`

```sql
CREATE TABLE companion_favorites (
  device_id     TEXT NOT NULL,
  entity_id     INTEGER NOT NULL,
  companion_id  TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (device_id, entity_id, companion_id)
);

CREATE INDEX idx_favs_companion ON companion_favorites(companion_id);
```

### 4.3 `companion_ratings`

```sql
CREATE TABLE companion_ratings (
  device_id     TEXT NOT NULL,
  entity_id     INTEGER NOT NULL,
  companion_id  TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
  stars         INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (device_id, entity_id, companion_id)
);

CREATE INDEX idx_ratings_companion ON companion_ratings(companion_id);
```

### 4.4 `companion_comments`

```sql
CREATE TABLE companion_comments (
  id            TEXT PRIMARY KEY,
  companion_id  TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL,
  entity_id     INTEGER NOT NULL,
  parent_id     TEXT REFERENCES companion_comments(id) ON DELETE CASCADE,  -- 一層回覆
  text          TEXT NOT NULL,
  flagged       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_comments_companion ON companion_comments(companion_id, created_at DESC);
CREATE INDEX idx_comments_parent ON companion_comments(parent_id);
```

### 4.5 `companion_select_log`（審計 + rating gate）

```sql
CREATE TABLE companion_select_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     TEXT NOT NULL,
  entity_id     INTEGER NOT NULL,
  companion_id  TEXT NOT NULL,
  selected_at   INTEGER NOT NULL,
  duration_ms   INTEGER                                  -- 用了多久後切走（next select 寫入）
);

CREATE INDEX idx_select_log_entity ON companion_select_log(entity_id, selected_at DESC);
CREATE INDEX idx_select_log_companion ON companion_select_log(companion_id);
```

### 4.6 `companion_state_events`（debug + state machine）

```sql
CREATE TABLE companion_state_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     TEXT NOT NULL,
  entity_id     INTEGER NOT NULL,
  companion_id  TEXT NOT NULL,
  event         TEXT NOT NULL,
  previous_state TEXT,
  new_state     TEXT NOT NULL,
  context_json  TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_state_events_entity ON companion_state_events(entity_id, created_at DESC);
```

僅保留 7 天，定期 cron purge。

### 4.7 `companion_drafts`

不另建表，存於 `device_vars` 為 `PETDX_DRAFT_<draftId>`（隔離 per-device，不出現在社群索引）。

---

## 5. 索引與查詢效能

### 5.1 列表查詢

```sql
-- list with filters
SELECT id, name, thumbnail_url, mood, color, tags,
       download_count, favorite_count, rating_avg, rating_count,
       (SELECT 1 FROM companion_favorites WHERE device_id=? AND entity_id=? AND companion_id=companions.id) AS is_favorited
FROM companions
WHERE status = 'published'
  AND (? = '' OR scope = ?)
  AND (? = '' OR category = ?)
  AND (? = '' OR mood = ?)
  AND (? = '' OR color LIKE ?)
ORDER BY download_count DESC
LIMIT ? OFFSET ?;
```

主索引 `idx_companions_popular` partial index 涵蓋 `status='published'`，sort by `download_count DESC` 命中。

### 5.2 搜尋

text search: 先用 SQLite FTS5 virtual table 蓋 name + description + tags + author_displayName。

```sql
CREATE VIRTUAL TABLE companions_fts USING fts5(
  id UNINDEXED,
  name,
  description,
  tags,
  author_displayName,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

查詢 `q` 時 INNER JOIN `companions_fts ON companions.id = companions_fts.id`。

### 5.3 收藏 / 評分

複合 PK `(device_id, entity_id, companion_id)` 自動 unique。`companion_favorites` 寫入時 transaction 同時 increment `companions.favorite_count`。

### 5.4 自動清理

cron 每日:
- `companion_state_events` 保留 7 天
- `companion_select_log` 保留 90 天
- `status='rejected'` 滿 30 天的 companion 軟刪除

---

## 6. 與既有系統整合

### 6.1 `entity_cards.icon_url`

POST `/api/companion/sync` 寫入 `entity_cards.icon_url`，但保留原有欄位 `icon_url_original` 作為 fallback。當伙伴被刪除時 restore original。

### 6.2 WebSocket events

新增 broadcast events:
- `companion-selected` `{ deviceId, entityId, companionId, avatarUrl }`
- `companion-state-changed` `{ deviceId, entityId, newState }`
- `companion-published` `{ companionId, authorEntityId }`
- `companion-rejected` `{ companionId, authorEntityId, reason }`

### 6.3 `device_vars` keys

| Key | 型別 | 用途 |
|---|---|---|
| `PETDX_CURRENT_<entityId>` | string (companionId) | 當前伙伴 |
| `PETDX_AVATAR_CACHE_<entityId>` | string (data: URL) | 大頭照快取 |
| `PETDX_FAVORITES_<entityId>` | string (JSON array) | 收藏 mirror（DB 為主，這是 frontend cache） |
| `PETDX_DRAFT_<draftId>` | string (pet.json) | 草稿 |
| `PETDX_HIGH_QUALITY` | bool | 高品質模式 toggle |
| `PETDX_DISABLED` | bool | 完全停用伙伴系統 |

### 6.4 i18n

`/api/companion/list` response 不做 server-side i18n。Client 取 `i18n_data` JSON 後依 user locale 自選。

新增 i18n keys 約 30 個，由 frontend 觸發在 portal/wallpaper-browser.html 與 portal/companion-creator.html。

### 6.5 Rate limit

| 端點 | 每 entity 每分鐘 |
|---|---|
| `/list` | 60 |
| `/select` | 30 |
| `/state-event` | 600（高頻 OK） |
| `/sync` | 30 |
| `/submit` | 5 |
| `/comment` | 10 |
| `/rate` | 10 |
| `/favorite` | 60 |

超出回 `429 rate_limit_exceeded`。

---

## 7. 安全性

### 7.1 Multi-tenant 隔離

- 所有寫操作 `entity_id` 必須等於 caller entityId
- 草稿 keys `PETDX_DRAFT_*` 跟著 device_vars 的多租戶隔離（per-bot 視野）
- `submit` 強制 `author.entityId === entityId`（不可代提交）

### 7.2 NSFW / 內容過濾

- 圖檔上傳時：先存到 `staging/` 目錄，跑 NSFW model 分類器
- 通過 → 移到 `published/`；失敗 → 通知創作者並刪除
- 留言 / 描述：簡單詞庫過濾（i18n 多語）+ 人工複核

### 7.3 防濫用

- submit per device 每天最多 5 個（防 spam）
- comment per entity 每天最多 50 條
- 同一 IP 不同 device 用相同 spritesheet hash → flag 重複偵測

### 7.4 License 與版權

- pet.json `license` 欄位寫入 DB，published 時公開顯示
- DMCA take-down: device owner 介面 → `/api/companion/review/:id` decision=hide

---

## 8. 觀測性

### 8.1 Metrics

新增 Prometheus metrics：
- `companion_select_total{device_id, scope}` counter
- `companion_state_event_total{event, new_state}` counter
- `companion_submit_total{status}` counter
- `companion_active_unique` gauge（當下 5 分鐘內 select 過的 unique entity 數）

### 8.2 Logs

每個 write 端點寫 audit log 到 `audit_log` table（既有），action_type 為 `companion.*`。

### 8.3 Dashboard

新增 admin/dashboard.html 區塊：
- 熱門 companion top 10
- 當日 submit / approve / reject 數
- spritesheet 總大小（用量警告）

---

## 9. 部署順序

```
Phase 1 (本卡): Schema + DB migration + read endpoints
  ├─ migrations/2026-05-XX-companion-schema.sql
  ├─ backend/companion-api.js (list / get / current / states)
  └─ unit tests

Phase 2: Write endpoints
  ├─ select / sync / state-event
  ├─ favorite / rate / comment
  └─ Frontend wallpaper-browser.html 串接

Phase 3: 創作者工作台
  ├─ submit / draft CRUD
  └─ Frontend companion-creator.html

Phase 4: 社群與審核
  ├─ review / community 端點
  ├─ NSFW pipeline
  └─ admin dashboard

Phase 5: Wallet 對接（若 §11.Q3 啟用）
  └─ 收益分潤接 wallet
```

每個 phase 對應一張 sub-card，本 spec 為 master design 文件。

---

## 10. 開放問題（依賴 Petdx spec v0.1 §11）

| # | 問題 | 對 API 的影響 |
|---|---|---|
| Q1 主軸取捨 | 若改為「大頭照同步為主」→ /sync 提升為主 endpoint，/state-event 退為配套 |
| Q2 entity 視覺一致性 | 若強制一致 → /select 副作用包含 entity_card 直寫；可選一致 → 兩 path 並存 |
| Q3 收益分潤 | 啟用 → 多 `companion_earnings` 表 + wallet 對接；關閉 → §3.13 submit 不寫入 earnings |
| Q4 內建伙伴數量 | 影響 seed migration 大小，5 個或 10 個 |
| Q5 9 狀態強制 | 強制 → schema 加 CHECK constraint；可選 → 由 client fallback |
| Q7 審核強度 | 全自動 → 不需 /review；全人工 → /review 是必經 |
| Q9 Live2D / Spine | 若加入 → schema 多 `format` 欄位（spritesheet/live2d/spine） |

**v0.2 mapping**: Mac_F + Hank 確認後本 spec 升 v0.2，schema 與端點配套修。

---

## 11. 修訂紀錄

| 版本 | 日期 | 作者 | 變更 |
|---|---|---|---|
| v0.1 | 2026-05-10 | LOBSTER #2 | 初版（依賴 Petdx UIUX spec v0.1，Mac_F silent 自繪）|
