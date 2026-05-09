# Petdx 伙伴系統 UIUX 規格書

> **狀態**: v0.1 draft (2026-05-10) · **作者**: LOBSTER #2 · **依賴卡**: `card_060799205e328fde6d86d43b`
>
> **Pending Mac_F #1 review**: 主軸取捨（動畫桌布 vs agent 大頭照同步）為 v0.1 假設，Mac_F 回覆後 v0.2 修訂。
>
> **下游 gate**: 6 張 P2 impl 卡（Backend API / Frontend 動畫 / 瀏覽器 UI / E2E / 社群貢獻 / 創作者工作台）。

---

## 1. 系統概覽

Petdx 伙伴系統將 EClaw 的 entity（bot / user / agent）視覺化為「桌布伙伴」，每個伙伴是一張 spritesheet 動畫圖加上 metadata，可在三個位置同步呈現：

1. **動畫桌布**（主視覺）：portal 首頁背景與 chat 空白區，桌布伙伴依當前 entity 狀態播放動畫
2. **agent 大頭照**：chat 對話列、kanban 卡片、entity card — 伙伴 idle frame 抽幀作為大頭照
3. **伙伴瀏覽器**：portal/wallpaper-browser 頁面，使用者可瀏覽、搜尋、收藏、切換伙伴

**主軸假設（待 Mac_F 確認）**: 「動畫桌布為主軸，大頭照同步是衍生」。理由：
- 動畫桌布是新功能，亮點在 spritesheet + 9 狀態切換
- 大頭照早已存在（entity card），同步只是把伙伴選擇 propagate 到既有 avatar slot
- 創作者貢獻的價值在動畫質量（會動的伙伴）而非靜態頭像

若 Mac_F 主張「大頭照同步為主軸」，§5 升至獨立模組，§4 退為配套。

### 1.1 名詞表

| 名詞 | 定義 |
|---|---|
| 伙伴 / Companion | 一組 spritesheet + pet.json + metadata，代表一個視覺角色 |
| spritesheet | 9 動畫狀態各 N 幀串成一張 webp |
| 狀態 / state | 9 種角色行為（idle/working/sleeping/...）對應的動畫片段 |
| 桌布伙伴 | 渲染在 portal 背景的伙伴實例 |
| 同步大頭照 | 從當前伙伴 idle 狀態第一幀抽出的 avatar |
| 創作者 | 上傳伙伴到社群的使用者 |
| 社群伙伴 | 經審核公開的 community-contributed 伙伴 |

### 1.2 與既有系統的關係

| 既有系統 | 關係 |
|---|---|
| Entity card (`/api/entity/agent-card`) | 大頭照欄位由伙伴 idle frame 覆寫 |
| Chat (`/api/chat/history`) | 對話列頭像同步當前伙伴 |
| Kanban | 卡片 assignedBots 顯示伙伴頭像 |
| Vault | 創作者收益（若啟用）寫入 device_vars |
| Wallet (Phase 4 rebind) | 創作者收益分潤對接 wallet |

---

## 2. 伙伴資料模型

### 2.1 pet.json schema

```json
{
  "id": "petdx-orange-cat-001",
  "name": "橘貓菲比",
  "version": "1.0.0",
  "author": {
    "entityId": 12,
    "publicCode": "ab3xyz",
    "displayName": "Hank"
  },
  "spritesheet": {
    "url": "/static/companions/petdx-orange-cat-001/sheet.webp",
    "frameWidth": 256,
    "frameHeight": 256,
    "rows": 9,
    "stateLayout": ["idle", "working", "sleeping", "celebrating", "thinking", "eating", "playing", "sad", "alert"]
  },
  "states": {
    "idle":        { "row": 0, "frames": 6,  "fps": 4,  "loop": true },
    "working":     { "row": 1, "frames": 8,  "fps": 6,  "loop": true },
    "sleeping":    { "row": 2, "frames": 4,  "fps": 2,  "loop": true },
    "celebrating": { "row": 3, "frames": 12, "fps": 12, "loop": false },
    "thinking":    { "row": 4, "frames": 6,  "fps": 4,  "loop": true },
    "eating":      { "row": 5, "frames": 8,  "fps": 6,  "loop": true },
    "playing":     { "row": 6, "frames": 10, "fps": 8,  "loop": true },
    "sad":         { "row": 7, "frames": 6,  "fps": 3,  "loop": true },
    "alert":       { "row": 8, "frames": 4,  "fps": 8,  "loop": true }
  },
  "metadata": {
    "tags": ["cat", "orange", "cute"],
    "mood": "happy",
    "color": "#ff8c42",
    "category": "animal",
    "description": "一隻每天賴床的橘貓",
    "createdAt": 1778345000000,
    "downloads": 0,
    "favorites": 0,
    "rating": null
  },
  "license": "CC-BY-4.0",
  "i18n": {
    "name": { "en": "Phoebe the Orange Cat", "zh-TW": "橘貓菲比", "ja": "ロボエの三毛ネコ" },
    "description": { "en": "An orange cat that sleeps in every morning" }
  }
}
```

### 2.2 spritesheet.webp 規格

- **格式**: webp (lossy, q=85) · fallback png 8-bit
- **解析度**: 每 frame 256×256（標準）/ 384×384（高品質）/ 128×128（行動裝置 lite）
- **總尺寸上限**: 1024×9216 px (256×9 rows × 12 frames)
- **檔案大小**: 標準版 ≤ 800 KB，lite ≤ 200 KB
- **背景**: 透明 alpha channel
- **frame 排列**: 由左至右、上至下，row 對應狀態，col 對應 frame index

範例 layout（256×256 frame，每 row 12 frames）:

```
row 0 (idle):        [f0][f1][f2][f3][f4][f5][--][--][--][--][--][--]   <- 6 frames used
row 1 (working):     [f0][f1][f2][f3][f4][f5][f6][f7][--][--][--][--]   <- 8 frames
row 2 (sleeping):    [f0][f1][f2][f3][--][--][--][--][--][--][--][--]   <- 4 frames
... (rows 3-8)
```

### 2.3 9 狀態列舉與觸發規則

| state | 觸發條件 | 預設 fps | loop |
|---|---|---|---|
| `idle` | 預設、無事件 | 4 | yes |
| `working` | entity state=ACTIVE / kanban card in_progress / chat 等待回應 | 6 | yes |
| `sleeping` | entity 5min 無互動 / 凌晨時段 | 2 | yes |
| `celebrating` | kanban card → done / PR merged / level up | 12 | no (一次性) |
| `thinking` | entity state=PROCESSING / chat 訊息送出後 | 4 | yes |
| `eating` | XP 增加 / earning 進帳 | 6 | yes |
| `playing` | 使用者主動互動（點擊伙伴）| 8 | yes |
| `sad` | error / 任務失敗 / wedge 偵測 | 3 | yes |
| `alert` | nudge / push notification / mention | 8 | yes |

**state 優先序**（同時觸發時取上層）:

```
celebrating > alert > sad > eating > playing > thinking > working > sleeping > idle
```

### 2.4 必填 vs 選填

| 欄位 | 必填 | 備註 |
|---|---|---|
| id | ✅ | 唯一，kebab-case |
| name | ✅ | i18n 預設 zh-TW |
| spritesheet.url | ✅ | absolute or relative |
| spritesheet.frameWidth/Height | ✅ |  |
| states.idle | ✅ | 至少 idle 必填，其他狀態可省略並 fallback 到 idle |
| metadata.tags | ⚪ | 至少 1 個 tag |
| metadata.color | ⚪ | hex，影響瀏覽器分類過濾 |
| author | ✅ | 系統內建伙伴 author.entityId=0 |
| license | ⚪ | 預設 `EClaw-default` |
| i18n | ⚪ |  |

---

## 3. 伙伴瀏覽器 (Companion Browser)

進入點: `portal/wallpaper-browser.html`，從 settings 頁的「桌布伙伴」入口開啟。

### 3.1 佈局

```
┌──────────────────────────────────────────────────────────┐
│  [搜尋框........................]   [+ 創作我的伙伴]      │
├──────────────────────────────────────────────────────────┤
│  分類: [全部] [動物] [人物] [機器人] [自訂]               │
│  心情: [全部] [開心] [忙碌] [愛睏] [淘氣]                 │
│  顏色: [⚪][🔴][🟠][🟡][🟢][🔵][🟣]                       │
│  排序: [熱門▼] [最新] [我的收藏]                          │
├──────────────────────────────────────────────────────────┤
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐         │
│  │preview│ │preview│ │preview│ │preview│ │preview│ │preview│  <- 6 col grid
│  │橘貓  │ │白兔  │ │機器人│ │獨角獸│ │柴犬  │ │企鵝  │         │
│  │ 1.2k│ │ 856 │ │ 432 │ │ 312 │ │ 280 │ │ 210 │         │
│  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘         │
│  ┌─────┐ ...                                              │
│                                                            │
│  [載入更多 ▼]                                              │
└──────────────────────────────────────────────────────────┘
```

### 3.2 grid item

每個 grid item 是 160×220 卡片：

- 上半部 160×160：**hover 時播放 idle 動畫**（4fps，~1.5s 循環），預設顯示 idle 第一幀
- 下半部 160×60：name（粗體）、author 顯示名（小字灰色）、下載數 / 評分
- **點擊 → 開啟詳情面板**，**雙擊 → 直接切換為當前伙伴**
- 右上角 ❤ icon: 收藏狀態，點擊切換

### 3.3 詳情面板

側邊抽屜（手機全螢幕、桌機 480 px 寬）:

- 大預覽 320×320，**狀態切換器**（9 顆按鈕對應 9 狀態，點擊播放對應動畫）
- 名稱 / 作者 / 描述 / 標籤
- 「設為桌布伙伴」（主按鈕）/「收藏」/「分享連結」
- 統計：下載數、收藏數、評分（5 星）、留言數
- 留言區（前 3 條 + 載入更多）
- 創作者其他作品（橫向 scroll，最多 6 個）

### 3.4 搜尋

- **關鍵字**: 比對 name (i18n 全語系) + description + tags + author displayName
- **debounce**: 300ms
- **零結果**: 顯示「沒有相符伙伴 — 試試 [建議標籤 ×3]」

### 3.5 響應式

| 螢幕寬 | grid 欄數 | item 寬 | 篩選器 |
|---|---|---|---|
| ≥1280 | 6 | 160 | 全展開 |
| 768–1279 | 4 | 160 | 全展開 |
| 480–767 | 3 | 144 | 收合（icon 按鈕展開抽屜） |
| <480 | 2 | 144 | 收合 |

### 3.6 i18n 觸點

- 所有 UI 字串透過 `data-i18n` + `backend/public/shared/i18n.js`
- 伙伴 name/description 從 pet.json `i18n` 區塊讀取，fallback 到 default 值
- 預期新增 i18n keys 約 30 個（瀏覽器 UI 25 + 詳情面板 5）

---

## 4. 桌布伙伴渲染 (Wallpaper Companion)

### 4.1 渲染目標

桌布伙伴出現在以下位置（依優先序）:

1. **portal 首頁背景**: 右下角浮動，z-index 5，不擋住主要內容
2. **chat 空白區**: 對話歷史末尾右下角，z-index 10
3. **kanban 看板背景**: 看板右下角，z-index 1（最淡）
4. **行動裝置 home WebView**: 全螢幕背景，覆蓋整個視窗（解析度依裝置）

### 4.2 尺寸與位置

| 容器 | 預設尺寸 | 位置 | 偏移 |
|---|---|---|---|
| portal 首頁 | 192×192 | bottom-right | 32 px from edge |
| chat 空白區 | 144×144 | bottom-right | 16 px |
| kanban | 96×96 | bottom-right | 16 px (淡 30% 透明) |
| 行動 home | 螢幕寬 × 螢幕寬（正方形） | center-bottom | safe-area + 24 px |

### 4.3 渲染管線

```
pet.json + spritesheet.webp
         ↓
   <canvas> drawImage(sheet, srcX, srcY, frameW, frameH, 0, 0, displayW, displayH)
         ↓
   每 1000/fps ms 切換到下一 frame
         ↓
   state 切換時：fade-out 200 ms → 換 row → fade-in 200 ms
```

**實作策略**:
- 使用 `<canvas>` 而非 CSS `background-position`（GPU 加速、低記憶體）
- 預載入 spritesheet（`<link rel="preload" as="image">`）
- visibility: hidden 時暫停動畫（節省 CPU）
- requestAnimationFrame 而非 setInterval（避免背景 tab 跑空轉）

### 4.4 過渡動畫

- **fade**: 預設，state 切換時 200 ms opacity 0.3 → 1
- **slide**: alert/celebrating 用，從容器外滑入
- **bounce**: playing 用，scale 1 → 1.1 → 1（150 ms）
- **none**: 強制無過渡（測試 / debug）

### 4.5 性能 & 記憶體

| 指標 | 目標 |
|---|---|
| 初始載入 | spritesheet ≤ 800 KB，3G 下 ≤ 3 s |
| FPS | 桌機 60 fps，行動 30 fps |
| 記憶體 | <50 MB（單伙伴） |
| CPU | idle 時 <2%，working 時 <5% |
| 切換伙伴 | 老伙伴 unload → 新伙伴 load，總 <1 s |

LOD 策略（distance-based 但實際是 viewport-size-based）:
- viewport <480 px → 載入 lite spritesheet
- viewport ≥ 480 → 載入 standard
- 「高品質模式」開關（settings）→ 載入 hi-res

---

## 5. Agent 大頭照同步

### 5.1 同步規則

當前伙伴改變時，以下位置的 avatar 自動更新:

1. `entity_card.iconUrl` — entity card 主頭像
2. chat header 對話列頭像
3. kanban card `assignedBots[].avatar`
4. plaza / arena ranking 頭像
5. mention 預覽卡頭像

### 5.2 抽幀邏輯

從伙伴 spritesheet 抽出 `idle` 狀態 frame 0 作為 avatar:

```js
// pseudo
const sheet = await loadImage(pet.spritesheet.url);
const frame = pet.states.idle;
const canvas = document.createElement('canvas');
canvas.width = canvas.height = 256;
canvas.getContext('2d').drawImage(
  sheet,
  0,  // srcX = frame 0
  frame.row * pet.spritesheet.frameHeight,  // srcY
  pet.spritesheet.frameWidth, pet.spritesheet.frameHeight,
  0, 0, 256, 256
);
const avatarDataUrl = canvas.toDataURL('image/webp', 0.85);
```

抽出的 avatar **快取在 device_vars** (`PETDX_AVATAR_CACHE_<entityId>`)，避免每次重抽。

### 5.3 多 entity 場景

若使用者切換為 bot #2 (LOBSTER) → 桌布伙伴 = LOBSTER 的伙伴；若切到 bot #1 (Mac_F) → 桌布伙伴 = Mac_F 的伙伴。每個 entity 獨立持有「當前伙伴」狀態（vault 內 `PETDX_CURRENT_<entityId>`）。

對話介面同時顯示多個 entity 時（kanban / mention），每個 entity 顯示自己的伙伴 avatar。

### 5.4 同步延遲

切換伙伴 → 大頭照同步預期 < 500 ms（含 cache 寫入）。失敗 fallback 到原 entity card icon。

---

## 6. 狀態切換邏輯

### 6.1 state machine

```
                ┌────────┐
   ┌─→ idle ──→│working │──→ celebrating ──┐
   │           └────────┘                   │
   │              ↑↓                        │
   │           thinking                     │
   │              ↑↓                        │
   │            alert ←──── nudge / push    │
   │              ↑                         │
   │            sad ←────── error           │
   │              ↑                         │
   ↑          eating ←───── XP gain         │
   │              ↑                         │
   │           playing ←──── user click     │
   │              ↓                         │
   └────── sleeping ←──── 5min idle         │
                  └─────────────────────────┘
```

### 6.2 觸發來源

| 來源 | event 名稱 | 對應 state |
|---|---|---|
| `/api/transform` `state` 欄位 | state-change | working / thinking / idle |
| `/api/mission/card/*/move` | card-status | working (in_progress) / celebrating (done) |
| WebSocket push (broadcast) | push | alert |
| client-side mouse | click-pet | playing |
| 5min 無 event | timeout | sleeping |
| `/api/entity/level-up` | xp-gain | eating |
| HTTP 5xx error | error | sad |

### 6.3 跨頁面持久化

當前伙伴的 state 寫入 `localStorage.petdx_current_state` + 透過 `BroadcastChannel('petdx')` 同步多個 tab。WebView 內透過 `window.postMessage` 與 native 同步（行動裝置）。

### 6.4 一次性動畫處理

`celebrating`、`eating`、`alert` 為 `loop:false` 一次性動畫。播放完成後 fallback 回 `idle`（或當前 state）。

---

## 7. 創作者工作台

進入點: `portal/companion-creator.html`

### 7.1 主介面

四個 tab：

1. **設計器**: pet.json 表單 + 即時預覽
2. **Spritesheet 工具**: 上傳、裁切、自動分幀
3. **動畫預覽**: 9 狀態切換播放
4. **發布**: 草稿管理、社群提交、創作統計

### 7.2 設計器

左側表單（pet.json 各欄位），右側即時預覽 320×320。

- 表單分區：基本資訊 / spritesheet / states / metadata / i18n
- 每個欄位即時驗證（紅框 + 訊息）
- 「JSON 模式」toggle 切換為純 JSON 編輯（monaco editor）
- 自動儲存到 `localStorage` + 「儲存草稿」按鈕寫到 device_vars

### 7.3 Spritesheet 工具

- **上傳**: drag-drop 或選檔（webp/png/gif）
- **裁切**: 設定 frame 尺寸（預設 256×256）+ rows × cols + 起始偏移
- **自動分幀**: 抽取每 row 第 0 frame 顯示縮圖
- **狀態 mapping**: 拖拉 9 狀態到對應 row
- **預覽**: 各狀態獨立播放，可調 fps

### 7.4 動畫預覽

3×3 grid 顯示 9 狀態同時播放（可 hover 暫停 / 點擊單獨展開）。

### 7.5 草稿與發布

- **草稿**: device_vars `PETDX_DRAFT_<id>`，最多 10 個
- **送審**: 提交後狀態為 `pending_review`
- **公開**: 審核通過 → `published`
- **更新**: 已公開伙伴可發新 version（v1.1.0），舊 user 自動 prompt 升級

### 7.6 創作統計

- 各伙伴下載數、收藏數、評分、留言
- 收益面板（若啟用社群分潤）：累積 XP / wallet credit
- 趨勢圖（30 天）

---

## 8. 社群伙伴貢獻系統

### 8.1 提交流程

```
創作者完成 pet.json + spritesheet
         ↓
    POST /api/companion/submit
         ↓
   pending_review 狀態
         ↓
  ┌──────────────────────┐
  │ 審核（人 + 自動）       │
  │  - 內容過濾（NSFW）    │
  │  - 檔案大小 / 格式      │
  │  - 重複偵測              │
  │  - 版權檢查（license）  │
  └──────────────────────┘
         ↓
  通過 → published / 退回 → returned (附理由)
         ↓
  公開到瀏覽器，計入創作者統計
```

### 8.2 審核機制

- **自動**: 檔案規格、必填欄位、license 標記、重複 hash 比對
- **人工**: device owner 或指定 reviewer entity 進行內容審核
- **AI 輔助**: NSFW / 暴力 / 政治敏感分類器（可設閾值）
- **快速通道**: 認證創作者（>5 個 published）skip 自動審查

### 8.3 評分與留言

- 5 星評分（已切換為當前伙伴 ≥ 3 天可評）
- 留言 max 500 字
- 創作者可回覆留言（一層）
- 檢舉機制（騷擾 / 垃圾 / 不當內容）

### 8.4 收益分潤（Phase 4 wallet 對接）

- 預設關閉；device owner 可在 settings 啟用
- 啟用後，每次「設為當前伙伴」事件 → 創作者得 1 XP（或設定金額）
- 對接 wallet：使用者付費購買限定伙伴 → 70% 創作者 / 30% 平台
- **本 spec 不定義具體金額**，待 Phase 4 wallet 規格確認

### 8.5 內容下架

- 違反規範 → device owner 下架（hidden 狀態，已下載者保留本地副本）
- 創作者可刪除自己的伙伴（軟刪除，30 天內可復原）
- 版權主張 → DMCA-style 流程（待 legal 設計）

---

## 9. 跨平台相容性

| 平台 | 桌布渲染 | 大頭照同步 | 瀏覽器 | 創作者工作台 |
|---|---|---|---|---|
| Web (Chrome/Safari) | ✅ canvas | ✅ | ✅ | ✅ |
| Android WebView | ✅ canvas | ✅ | ✅ | ⚠️ 限基本功能 |
| iOS WebView | ✅ canvas | ✅ | ✅ | ⚠️ 限基本功能 |
| Android home screen widget | ✅ native (Phase 2) | ✅ | ❌ | ❌ |
| iOS WidgetKit | ✅ native (Phase 2) | ✅ | ❌ | ❌ |

**Phase 1**（本 spec 範圍）: 全部 WebView 為主，原生 widget 未涵蓋
**Phase 2**: 原生 home screen widget（另開 spec）

---

## 10. 視覺規範

### 10.1 色彩

依循既有 EClaw design token (`backend/public/shared/design-tokens.css`):

- 主色: `--color-primary` (orange)
- 背景: `--color-bg-secondary`
- 文字: `--color-text-primary` / `--color-text-muted`
- 伙伴卡片陰影: `0 2px 8px rgba(0,0,0,0.06)`，hover `0 4px 16px rgba(0,0,0,0.12)`

### 10.2 字型

- 標題: `--font-display`（系統預設）
- 內文: `--font-body`
- 數字（下載數 / 評分）: `--font-mono`

### 10.3 間距

8 px grid。卡片內 padding 12，卡片間 gap 16。

### 10.4 動畫節奏

- hover transition: 200 ms ease-out
- state 切換 fade: 200 ms ease-in-out
- celebrating bounce: cubic-bezier(0.34, 1.56, 0.64, 1)
- 所有動畫 prefers-reduced-motion 時降為 fade 或關閉

### 10.5 icon

從 EClaw existing icon set，缺項自製（lucide-react / hero-icons 風格）。

---

## 11. 開放問題（待 Mac_F #1 / Hank 確認）

| # | 問題 | v0.1 假設 | 可選方案 |
|---|---|---|---|
| Q1 | 主軸取捨 | 動畫桌布為主、大頭照同步衍生 | 反過來 / 兩者並重 |
| Q2 | 伙伴是否與既有 entity 視覺一致 | 不要求 — 伙伴是純美術角色，與 entity 是「使用者選擇」關係 | 強制 entity 自帶預設伙伴 |
| Q3 | 創作者收益分潤 | 預設關閉，Phase 4 wallet 對接後啟用 | 一開始就上 XP-only 收益 |
| Q4 | 系統內建伙伴數量 | 5 個（覆蓋常見 mood × color）| 1 個 / 10 個 |
| Q5 | 9 狀態是否強制全有 | 只強制 idle，其他可省略 fallback | 全部強制 |
| Q6 | 行動 home 全螢幕桌布是否強制 | 可關閉（settings 預設開）| 強制 / 預設關 |
| Q7 | 社群審核強度 | 一律審核 + 認證快速通道 | 全自動（AI only）/ 全人工 |
| Q8 | spritesheet 上限 | 800 KB 標準 / 200 KB lite | 可調 |
| Q9 | 是否支援 Live2D / Spine | 否（v1 純 spritesheet）| Phase 2 加入 |
| Q10 | 9 狀態動畫的 default fps | 4-12 各狀態不同 | 統一 8 |

---

## 12. 下游 impl 卡 mapping

| Impl 卡 | 對應章節 |
|---|---|
| [Backend] 伙伴系統 API 設計 | §2 (data model), §5.2 (avatar cache), §6.2 (state events), §8 (community) |
| [Frontend] 桌布伙伴動畫系統 | §4 (rendering), §6 (state machine) |
| [UI] 伙伴瀏覽器與選擇器 | §3 (browser) |
| [Test] Petdx E2E 測試 | §3, §4, §5 (跨平台 §9) |
| [API] 社群伙伴貢獻系統 | §8 |
| [UI] 伙伴創作者工作台 | §7 |

---

## 附錄 A — REST API 草案（送 Backend 卡細化）

```
GET    /api/companion/list?category=&mood=&color=&q=&sort=&page=&limit=
GET    /api/companion/:id
POST   /api/companion/select       { companionId }
GET    /api/companion/current      → 當前 entity 的伙伴
GET    /api/companion/states/:id   → 9 狀態定義
POST   /api/companion/state-event  { event:'card-done'|'error'|'xp-gain'|... }

POST   /api/companion/submit       (multipart: pet.json + sheet.webp)
POST   /api/companion/draft        (儲存草稿)
GET    /api/companion/drafts
DELETE /api/companion/draft/:id
POST   /api/companion/review/:id   { decision:'approve'|'reject', reason }

POST   /api/companion/favorite     { companionId, on:true|false }
GET    /api/companion/favorites
POST   /api/companion/rate         { companionId, stars:1-5 }
POST   /api/companion/comment      { companionId, text }

POST   /api/companion/avatar-sync  { companionId } → 主動觸發抽幀並寫入 entity card
GET    /api/companion/community?author=&page=
```

所有端點 deviceId + botSecret + entityId 三件式 auth（與既有 `/api/transform` 一致）。

---

## 附錄 B — 檔案儲存路徑

```
/static/companions/<id>/
├── pet.json
├── sheet.webp           # 標準
├── sheet-lite.webp      # 行動裝置
├── sheet-hires.webp     # 高品質
├── thumbnail.webp       # 160×160 縮圖（grid 用）
└── README.md            # 創作者選填
```

device_vars keys:
- `PETDX_CURRENT_<entityId>` — 當前伙伴 id
- `PETDX_AVATAR_CACHE_<entityId>` — base64 avatar (data: url)
- `PETDX_FAVORITES_<entityId>` — JSON array of companion ids
- `PETDX_DRAFT_<draftId>` — 草稿 pet.json
- `PETDX_HIGH_QUALITY` — boolean，是否載入 hi-res

---

## 修訂紀錄

| 版本 | 日期 | 作者 | 變更 |
|---|---|---|---|
| v0.1 | 2026-05-10 | LOBSTER #2 | 初版（Mac_F #1 silent fallback draft）|
