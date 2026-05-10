# Petdx Backend API 設計規格

> **狀態**: v0.2 (2026-05-10) · **作者**: LOBSTER #2 · **依賴卡**: `card_e8aeba8feedf22a714a33fc6`
>
> **上游**: [Petdx UIUX 規格書 v0.2](./petdx-uiux-spec.md)
>
> **下游**: 實作 `backend/companion-api.js` + DB 遷移 + i18n keys
>
> **v0.1 → v0.2 變更**: 鎖定 Android 既有引擎增強 → 砍掉一半 endpoint（state-event / sync / states/:id）/ 新增 `/states/help` / e 幣分潤預設啟用 / avatar.png 在 publish 時自動生成 / state event log 表移除（改用既有 `audit_log`）。

---

## 1. 概覽

`/api/companion/*` 命名空間統一處理 Petdx 伙伴系統的所有 backend 操作。所有端點：

- 三件式 auth（deviceId + botSecret + entityId）
- 與既有 `/api/transform`, `/api/mission/*` 同樣的 rate-limit + audit log
- 多租戶：每個 device 的 companion library 獨立（系統內建除外）
- 透過 `device_vars` 持久化 per-entity 狀態（current companion / favorites）

**v0.2 設計原則**：API 只做 CRUD + 狀態查詢；**不負責 state event 廣播**（既有 `/api/transform` 的 `state` 欄位已涵蓋）。

## 2. 端點總覽

| Method | Path | 用途 | Auth |
|---|---|---|---|
| GET | `/api/companion/list` | 瀏覽伙伴（含過濾搜尋） | botSecret |
| GET | `/api/companion/:id` | 單一伙伴詳情（CompanionDescriptor 全文） | botSecret |
| GET | `/api/companion/:id/states/help` | **NEW**：查該伙伴 supportedStates | botSecret |
| POST | `/api/companion/select` | 切換當前伙伴 | botSecret |
| GET | `/api/companion/current` | 當前 entity 的伙伴 | botSecret |
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
| GET | `/api/companion/:id/earnings` | **NEW**：創作者收益（自己作品） | botSecret |

**v0.1 移除的端點**：
- ~~`GET /api/companion/states/:id`~~ — 合併入 `/states/help`
- ~~`POST /api/companion/state-event`~~ — 改用既有 `/api/transform` `state` 欄位
- ~~`POST /api/companion/sync`~~ — avatar.png 在 publish 時自動生成；client 端讀 vault `PETDX_AVATAR_<entityId>` 即可

---

## 3. 端點細節

### 3.1 GET `/api/companion/list`

伙伴瀏覽器主端點。

**Query params**:

| 參數 | 型別 | 預設 | 說明 |
|---|---|---|---|
| `deviceId` | string | required | |
| `botSecret` | string | required | |
| `entityId` | int | required | |
| `category` | string | `''` (all) | `animal` / `human` / `robot` / `mascot` / `custom` |
| `mood` | string | `''` | `happy` / `busy` / `sleepy` / `playful` |
| `color` | string | `''` | hex `#xxxxxx` 或 named bucket（red/orange/...） |
| `q` | string | `''` | 關鍵字（name / description / tags / author） |
| `tags` | string[] | `[]` | comma-separated, AND 比對 |
| `sort` | string | `popular` | `popular` / `recent` / `rating` / `favorites` |
| `scope` | string | `all` | `all` / `system` / `community` / `mine` |
| `assetType` | string | `''` | `procedural` / `spritesheet` / `vector`（v0.2 新增）|
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
      "avatarUrl": "/static/companions/petdx-orange-cat-001/avatar.png",
      "thumbnailUrl": "/static/companions/petdx-orange-cat-001/thumbnail.webp",
      "author": { "entityId": 12, "publicCode": "ab3xyz", "displayName": "Hank" },
      "tags": ["cat", "orange", "cute"],
      "mood": "happy",
      "color": "#ff8c42",
      "assetType": "spritesheet",
      "supportedStates": ["IDLE","BUSY","SLEEPING","EXCITED"],
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

單一伙伴完整 metadata（CompanionDescriptor 全文 + stats + isFavorited/isCurrent flags + asset URL）。

**Response 200**: 見 UIUX spec §2.1 CompanionDescriptor schema 全文，外加：

```json
{
  "...descriptor fields...": "...",
  "stats": { "downloads": 1234, "favorites": 89, "rating": 4.7, "ratingCount": 32, "commentCount": 12 },
  "isFavorited": true,
  "isCurrent": false,
  "publishedAt": 1778345000000
}
```

### 3.3 GET `/api/companion/:id/states/help`（NEW v0.2）

回傳該伙伴的 supportedStates + 每個 state 的 asset hint。Agent 在切換伙伴後主動呼叫，避免送出該伙伴不支援的 state。

**Cache**: 1h immutable（與 `/api/companion/:id` 一致）。

**Response 200**:

```json
{
  "companionId": "petdx-lobster-default",
  "supportedStates": ["IDLE","BUSY","EATING","SLEEPING","EXCITED"],
  "stateAssets": {
    "IDLE":     { "loop": true,  "fps": 4,  "hint": "default rest" },
    "BUSY":     { "loop": true,  "fps": 6,  "hint": "working" },
    "EATING":   { "loop": true,  "fps": 6,  "hint": "xp gain" },
    "SLEEPING": { "loop": true,  "fps": 2,  "hint": "long idle" },
    "EXCITED":  { "loop": false, "fps": 12, "hint": "card done / level up" }
  },
  "fallbackPolicy": "silent_to_idle"
}
```

**用法**：Agent 收到不支援的 state event 時應 local fallback 到 IDLE，不需呼叫 backend；backend 也不會回 4xx。

### 3.4 POST `/api/companion/select`

切換當前伙伴。

**Body**:
```json
{
  "deviceId": "...",
  "botSecret": "...",
  "entityId": 2,
  "companionId": "petdx-orange-cat-001"
}
```

**行為**:
1. 寫入 `device_vars.PETDX_CURRENT_<entityId> = companionId`
2. **自動寫入** `device_vars.PETDX_AVATAR_<entityId> = <avatar.png url>`（從 companions table 讀 avatar_url）
3. 寫入 `entity_cards.icon_url = <avatar.png url>` for entity = entityId（保留 `icon_url_original` 作為 fallback）
4. 廣播 `companion-selected` event 到 WebSocket subscribed clients
5. 寫入 `companion_select_log`（rating gate + 收益計算用）
6. **若 companion 為他人作品** → 觸發 §3.13 e 幣分潤入帳（per Q2）

**Response 200**:
```json
{
  "success": true,
  "previous": "petdx-default-bot-001",
  "current": "petdx-orange-cat-001",
  "avatarUrl": "/static/companions/petdx-orange-cat-001/avatar.png",
  "earningsAwarded": { "creatorEntityId": 12, "amount": 1, "currency": "ecoin" }
}
```

`earningsAwarded` 為自己選自己作品時為 `null`。

**Errors**: `404 companion_not_found`, `403 not_allowed`（社群伙伴未過審）

### 3.5 GET `/api/companion/current`

讀取當前 entity 的伙伴（從 `device_vars.PETDX_CURRENT_<entityId>`）。若未設定 → 回傳系統預設 `petdx-lobster-default`。

**Response 200**: 同 §3.2 格式 + `selectedAt` timestamp。

### 3.6 POST `/api/companion/favorite`

```json
{ "deviceId":"...", "botSecret":"...", "entityId":2, "companionId":"...", "on":true }
```

寫入 `companion_favorites` table；同時 increment/decrement `companions.favorite_count`（transaction）。

### 3.7 GET `/api/companion/favorites`

回傳當前 entity 的收藏 companion 清單（簡略卡片格式，同 §3.1 item 結構）。

### 3.8 POST `/api/companion/rate`

```json
{ "deviceId":"...", "botSecret":"...", "entityId":2, "companionId":"...", "stars": 5 }
```

**驗證**:
- stars: 1-5 整數
- entity 必須**已切換為當前伙伴 ≥ 3 天**才可評（`companion_select_log` 查詢累積 duration_ms ≥ 259200000）
- 同一 entity 對同一 companion 只能評 1 次（覆寫）

### 3.9 POST `/api/companion/comment`

```json
{ "deviceId":"...", "botSecret":"...", "entityId":2, "companionId":"...", "text": "..." }
```

**驗證**: text ≤ 500 chars, 非空, 通過 NSFW 自動過濾（既有 audit_log NSFW pipeline）。

### 3.10 GET `/api/companion/comments/:id`

```
?page=1&limit=20&sort=recent
```

回傳留言列表（含創作者一層回覆）。

### 3.11 POST `/api/companion/submit`

創作者提交伙伴到社群審核。

**Multipart body**（依 assetType 變化）：

通用：
- `descriptor`: CompanionDescriptor JSON（string）
- `avatar`: PNG 256×256（optional override；缺則 backend 自動生成）

assetType=`procedural`：
- 不需另外檔案，描述參數寫在 descriptor.asset.params

assetType=`spritesheet`：
- `sheet`: webp 檔案 ≤ 600 KB

assetType=`vector`：
- v0.2 拒收，回 `400 unsupported_asset_type`

**驗證**:
- CompanionDescriptor schema（UIUX spec §2.4）
- supportedStates 至少含 IDLE
- author.entityId 必須等於 caller entityId
- license 標記必填
- 重複 hash 偵測（asset 檔案 SHA256）

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

### 3.12 POST `/api/companion/draft` / GET `/api/companion/drafts` / DELETE `/api/companion/draft/:id`

草稿 CRUD。每 entity 最多 10 個草稿，存於 `device_vars.PETDX_DRAFT_<draftId>`（不入 companions 表）。

### 3.13 POST `/api/companion/review/:id`

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
- approve →
  1. status=`published`
  2. **若 descriptor.avatar.url 為空** → backend 跑 server-side render job 從 IDLE state 抽 1 frame → 寫 `/static/companions/<id>/avatar.png`，update `companions.avatar_url`
  3. **同步生成 thumbnail.webp**（144×144，從 avatar.png down-scale）
  4. 通知創作者 + 寫 audit log
- reject → status=`rejected`, 30 天後自動清理
- request_changes → status=`pending_changes`, 通知創作者修改

### 3.14 GET `/api/companion/community`

```
?author=<entityId>&page=1&limit=30&sort=popular
```

社群已 published 伙伴清單，可依作者過濾。

### 3.15 GET `/api/companion/:id/earnings`（NEW v0.2）

創作者查自己作品的累積收益（per Q2 e 幣分潤）。

**Auth**: botSecret + caller entityId 必須等於 companion.author_entity_id（不可看別人收益）

**Query params**:
- `since` / `until` — Unix ms，預設過去 30 天

**Response 200**:
```json
{
  "companionId": "petdx-orange-cat-001",
  "totalEarnings": { "amount": 234, "currency": "ecoin" },
  "selectCount": 234,
  "uniqueSelectors": 87,
  "byDay": [
    { "date": "2026-05-09", "amount": 12, "selects": 12 },
    { "date": "2026-05-08", "amount": 18, "selects": 18 }
  ]
}
```

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
  descriptor      TEXT NOT NULL,                         -- 完整 CompanionDescriptor (JSON string)
  asset_type      TEXT NOT NULL,                         -- 'procedural' | 'spritesheet' | 'vector'
  asset_url       TEXT,                                  -- spritesheet/vector 用；procedural 為 NULL
  avatar_url      TEXT,                                  -- publish 時生成
  thumbnail_url   TEXT,                                  -- publish 時生成
  supported_states TEXT NOT NULL,                        -- JSON array, e.g. ["IDLE","BUSY","SLEEPING"]
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
CREATE INDEX idx_companions_asset_type ON companions(asset_type, status);
```

**v0.1 → v0.2 schema 變更**：
- `pet_json` → `descriptor`（命名一致化）
- 新增 `asset_type`（取代 spritesheet_url/lite/hires 三欄）
- `spritesheet_url/lite/hires` → 合併為單一 `asset_url`
- 新增 `avatar_url`（publish 時生成）
- 新增 `supported_states`（dynamic state list 索引用）

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

### 4.5 `companion_select_log`（審計 + rating gate + 分潤計算）

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
CREATE INDEX idx_select_log_companion_date ON companion_select_log(companion_id, selected_at);
```

### 4.6 `companion_earnings`（NEW v0.2）

```sql
CREATE TABLE companion_earnings (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  companion_id        TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
  creator_entity_id   INTEGER NOT NULL,                  -- companion 作者
  selector_device_id  TEXT NOT NULL,                     -- 誰選了
  selector_entity_id  INTEGER NOT NULL,
  amount              INTEGER NOT NULL,                  -- e 幣量
  currency            TEXT NOT NULL DEFAULT 'ecoin',
  select_log_id       INTEGER REFERENCES companion_select_log(id),
  awarded_at          INTEGER NOT NULL,
  wallet_tx_id        TEXT                              -- Phase 4 wallet 對接時填
);

CREATE INDEX idx_earnings_creator ON companion_earnings(creator_entity_id, awarded_at DESC);
CREATE INDEX idx_earnings_companion ON companion_earnings(companion_id, awarded_at DESC);
```

### 4.7 `companion_drafts`

不另建表，存於 `device_vars` 為 `PETDX_DRAFT_<draftId>`（隔離 per-device，不出現在社群索引）。

### 4.8 ~~`companion_state_events`~~（v0.1 表，v0.2 移除）

state event 不再持久化，需要 debug 時讀既有 `audit_log` 的 `companion.select` action 即可。

---

## 5. 索引與查詢效能

### 5.1 列表查詢

```sql
-- list with filters
SELECT id, name, avatar_url, thumbnail_url, mood, color, tags,
       asset_type, supported_states,
       download_count, favorite_count, rating_avg, rating_count,
       (SELECT 1 FROM companion_favorites WHERE device_id=? AND entity_id=? AND companion_id=companions.id) AS is_favorited
FROM companions
WHERE status = 'published'
  AND (? = '' OR scope = ?)
  AND (? = '' OR category = ?)
  AND (? = '' OR mood = ?)
  AND (? = '' OR color LIKE ?)
  AND (? = '' OR asset_type = ?)
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

### 5.4 收益查詢

`/api/companion/:id/earnings` 用 `idx_earnings_companion` partial index 命中：

```sql
SELECT date(awarded_at/1000, 'unixepoch') AS day,
       SUM(amount) AS total,
       COUNT(*) AS selects
FROM companion_earnings
WHERE companion_id = ?
  AND awarded_at >= ?
  AND awarded_at <= ?
GROUP BY day
ORDER BY day DESC;
```

### 5.5 自動清理

cron 每日:
- `companion_select_log` 保留 90 天（duration 計算用）
- `status='rejected'` 滿 30 天的 companion 軟刪除
- `companion_earnings` 永久保留（會計需求）

---

## 6. 與既有系統整合

### 6.1 `entity_cards.icon_url`

POST `/api/companion/select` 寫入 `entity_cards.icon_url`，但保留原有欄位 `icon_url_original` 作為 fallback。當伙伴被刪除時 restore original。

### 6.2 WebSocket events

新增 broadcast events:
- `companion-selected` `{ deviceId, entityId, companionId, avatarUrl }`
- `companion-published` `{ companionId, authorEntityId }`
- `companion-rejected` `{ companionId, authorEntityId, reason }`

**v0.1 移除**：~~`companion-state-changed`~~（state 改用既有 `/api/transform` 廣播）

### 6.3 `device_vars` keys

| Key | 型別 | 用途 |
|---|---|---|
| `PETDX_CURRENT_<entityId>` | string (companionId) | 當前伙伴 |
| `PETDX_AVATAR_<entityId>` | string (avatar.png url) | 大頭照 url（client 端快取） |
| `PETDX_FAVORITES_<entityId>` | string (JSON array) | 收藏 mirror（DB 為主，這是 frontend cache） |
| `PETDX_DRAFT_<draftId>` | string (CompanionDescriptor) | 草稿 |
| `PETDX_DISABLED` | bool | 完全停用伙伴系統 |
| `PETDX_EARNINGS_RATE` | int | device-level e 幣率（device owner 可在 settings 改，預設 1） |

**v0.1 移除**：~~`PETDX_AVATAR_CACHE_<entityId>`~~（base64 抽幀），~~`PETDX_HIGH_QUALITY`~~（Android 引擎自處理）。

### 6.4 i18n

`/api/companion/list` response 不做 server-side i18n。Client 取 `i18n_data` JSON 後依 user locale 自選。

新增 i18n keys 約 25 個，由 frontend 觸發在設定頁伙伴瀏覽器與創作者工作台。

### 6.5 Rate limit

| 端點 | 每 entity 每分鐘 |
|---|---|
| `/list` | 60 |
| `/:id/states/help` | 60 |
| `/select` | 30 |
| `/submit` | 5 |
| `/comment` | 10 |
| `/rate` | 10 |
| `/favorite` | 60 |
| `/:id/earnings` | 30 |

超出回 `429 rate_limit_exceeded`。

**v0.1 移除**：~~`/state-event` 600/min~~（端點本身砍了），~~`/sync` 30/min~~（端點本身砍了）。

---

## 7. 安全性

### 7.1 Multi-tenant 隔離

- 所有寫操作 `entity_id` 必須等於 caller entityId
- 草稿 keys `PETDX_DRAFT_*` 跟著 device_vars 的多租戶隔離（per-bot 視野）
- `submit` 強制 `author.entityId === entityId`（不可代提交）
- `/:id/earnings` 強制 `caller entityId === companion.author_entity_id`

### 7.2 NSFW / 內容過濾

- 圖檔上傳時：先存到 `staging/` 目錄，跑 NSFW model 分類器
- 通過 → 移到 `published/`；失敗 → 通知創作者並刪除
- 留言 / 描述：簡單詞庫過濾（i18n 多語）+ 人工複核

### 7.3 防濫用

- submit per device 每天最多 5 個（防 spam）
- comment per entity 每天最多 50 條
- 同一 IP 不同 device 用相同 asset hash → flag 重複偵測
- **e 幣分潤防刷**：同一 selector entity 對同一 companion 24h 內只記 1 次（不論切換多少次）

### 7.4 License 與版權

- descriptor `license` 欄位寫入 DB，published 時公開顯示
- DMCA take-down: device owner 介面 → `/api/companion/review/:id` decision=hide

---

## 8. 觀測性

### 8.1 Metrics

新增 Prometheus metrics：
- `companion_select_total{device_id, scope, asset_type}` counter
- `companion_submit_total{status, asset_type}` counter
- `companion_active_unique` gauge（當下 5 分鐘內 select 過的 unique entity 數）
- `companion_earnings_awarded_total{currency}` counter

**v0.1 移除**：~~`companion_state_event_total`~~（端點砍了）

### 8.2 Logs

每個 write 端點寫 audit log 到 `audit_log` table（既有），action_type 為 `companion.*`（包含 `companion.select` 取代 v0.1 state-event log）。

### 8.3 Dashboard

新增 admin/dashboard.html 區塊：
- 熱門 companion top 10
- 當日 submit / approve / reject 數
- asset 總大小（用量警告）
- 當日 e 幣分潤總額

---

## 9. 部署順序

```
Phase 1 (本卡): Schema + DB migration + read endpoints
  ├─ migrations/2026-05-XX-companion-schema-v0.2.sql
  ├─ backend/companion-api.js (list / get / current / states/help)
  └─ unit tests

Phase 2: Write endpoints + Android engine 串接
  ├─ select / favorite / rate / comment
  ├─ Android CompanionResolver + RenderRouter (UIUX spec §4.2)
  └─ 設定頁伙伴瀏覽器串接

Phase 3: 創作者工作台
  ├─ submit / draft CRUD / review
  ├─ avatar.png 自動生成 server job
  ├─ thumbnail.webp 自動生成
  └─ Frontend creator UI（設定頁內）

Phase 4: 社群與審核 + 分潤
  ├─ community 端點
  ├─ NSFW pipeline
  ├─ companion_earnings 寫入 + earnings 查詢端點
  ├─ admin dashboard
  └─ Phase 4 wallet 對接（wallet_tx_id 填寫）
```

每個 phase 對應一張 sub-card，本 spec 為 master design 文件。

---

## 10. v0.2 變更摘要

| 變更項 | v0.1 | v0.2 | 理由 |
|---|---|---|---|
| 端點數 | 18 | 14 (砍 4 加 2 新) | N3「沒用到的就砍」+ N4「help API」+ Q2「e 幣 earnings」 |
| `state-event` 端點 | ✅ | ❌ | 既有 `/api/transform` `state` 欄位涵蓋 |
| `sync` 端點 | ✅ | ❌ | avatar.png 在 publish 時自動生成 |
| `states/:id` 端點 | ✅ (固定 9 state) | ❌ | 合併入 `/states/help`（dynamic） |
| `states/help` 端點 | — | ✅ | N4 動態 state list |
| `:id/earnings` 端點 | — | ✅ | Q2 e 幣分潤 |
| asset_type 欄位 | spritesheet only | procedural / spritesheet / vector | UIUX §2.2 三種 asset path |
| supportedStates 欄位 | hardcoded 9 | dynamic | Q5/N4 |
| avatar 處理 | client-side 抽幀 + base64 cache | publish 時生成 PNG，client 讀 url | 簡化、減記憶體 |
| companion_earnings 表 | 預留 | 必建 | Q2 預設啟用 |
| companion_state_events 表 | ✅ | ❌ | 不再 persist event log |

**v0.1 § 10 開放問題已封存**：所有 Q1-Q9 在 UIUX spec v0.2 §11 已解，本 spec schema 與端點配套修。

---

## 11. 修訂紀錄

| 版本 | 日期 | 作者 | 變更 |
|---|---|---|---|
| v0.1 | 2026-05-10 | LOBSTER #2 | 初版（依賴 Petdx UIUX spec v0.1，Mac_F silent 自繪）|
| v0.2 | 2026-05-10 | LOBSTER #2 | 整合 UIUX v0.2 鎖定 Android 引擎增強：砍 4 端點 + 加 `/states/help` + `/earnings`、schema 改 dynamic state、avatar 改 publish-time PNG、新增 companion_earnings 表 |
