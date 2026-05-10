# Petdx 伙伴系統 UIUX 規格書

> **狀態**: v0.2 (2026-05-10) · **作者**: LOBSTER #2 · **依賴卡**: `card_060799205e328fde6d86d43b`
>
> **上一版**: v0.1 (2026-05-10) — Mac_F #1 silent fallback draft；本版整合 Hank 2026-05-10 web_chat Q-list 回應 (Q1/Q2/Q5 + N1–N5) 與 §1 線上編輯。
>
> **範圍鎖定**: **Android App 既有動態桌布系統的增強**（沿用現有 `WallpaperService` + `ClawRenderer`），**不**重建 web portal 桌布頁面。Web portal 端僅保留「設定頁伙伴瀏覽器 + 創作者工作台」入口。
>
> **下游 gate**: 5 張 P2 impl 卡（v0.1 為 6 張，本版合併 Avatar 入 Frontend）。

---

## 1. 系統概覽

Petdx 伙伴系統將 EClaw 的 entity（bot / user / agent）視覺化為「桌布伙伴」，每個伙伴是一組 CompanionDescriptor + 對應 asset，可在三個位置同步呈現：

1. **動畫桌布**（主視覺）：使用現有 Android App 動態桌布系統
2. **agent 大頭照**：chat 對話列、kanban 卡片、entity card — 伙伴 idle frame 固定大頭照
3. **伙伴瀏覽器**：設定頁內入口，使用者可瀏覽、搜尋、收藏、切換伙伴（含社群貢獻），可預覽各狀態動作

**主軸已鎖定**（Hank 2026-05-10）：「Android 桌布既有動畫的增強」。
- §4 Android 引擎增強為 v0.2 主體
- §5 大頭照同步是衍生（從伙伴 idle frame 取一張 PNG）
- §3/§7 設定頁瀏覽器 + 創作者工作台是配套（瀏覽 / 搜尋 / 預覽 / 提交）
- v0.1 假設的 web canvas 桌布 / 動畫管線 / WebView 渲染矩陣**全部下架**

### 1.1 名詞表

| 名詞 | 定義 |
|---|---|
| 伙伴 / Companion | 一組 CompanionDescriptor + asset，代表一個視覺角色 |
| CompanionDescriptor | 描述伙伴 metadata + 支援的 state 列表 + 每 state 的 asset 路徑 |
| asset | 伙伴的繪圖資源，依 `assetType` 分為 procedural / spritesheet / vector |
| state | 角色行為（IDLE/BUSY/SLEEPING/...）對應的動畫片段，**每個伙伴自報支援哪些** |
| 桌布伙伴 | Android `WallpaperService` 內渲染的伙伴實例 |
| 同步大頭照 | 從當前伙伴 idle 狀態取一張固定 PNG 作為 avatar |
| 創作者 | 透過設定頁工作台貢獻伙伴的使用者 |
| 社群伙伴 | 經 device owner 審核公開的 community-contributed 伙伴 |

### 1.2 與既有系統的關係

| 既有系統 | 關係 |
|---|---|
| Android `WallpaperService` + `ClawRenderer` | **本 spec 主入口**；新增 CompanionDescriptor 解析層，既有 procedural 繪圖法是「Lobster 伙伴」的實作之一 |
| Entity card (`/api/entity/agent-card`) | `iconUrl` 由伙伴 idle PNG snapshot 覆寫 |
| Chat (`/api/chat/history`) | 對話列頭像同步當前伙伴 |
| Kanban | 卡片 `assignedBots` 顯示伙伴頭像 |
| Vault | 當前伙伴選擇 / avatar cache / 草稿存放 |
| Wallet (Phase 4) | 創作者 e 幣分潤入帳 |

### 1.3 不在 v0.2 範圍

- Web portal 動畫桌布 canvas 渲染管線
- iOS 原生 widget / WebView 桌布
- Android home screen widget（另開 Phase 2 spec）
- Live2D / Spine 動畫格式（asset type 預留欄位但 v0.2 不實作）

---

## 2. 伙伴資料模型

### 2.1 CompanionDescriptor schema

```json
{
  "id": "petdx-lobster-default",
  "name": "Lobster",
  "version": "1.0.0",
  "author": {
    "entityId": 0,
    "publicCode": "system",
    "displayName": "EClaw"
  },
  "assetType": "procedural",
  "asset": {
    "renderer": "lobster-procedural",
    "params": {
      "bodyColor": "#e63946",
      "eyeStyle": "bead",
      "antennaStyle": "double-curl"
    }
  },
  "supportedStates": ["IDLE", "BUSY", "EATING", "SLEEPING", "EXCITED"],
  "stateAssets": {
    "IDLE":     { "loop": true,  "fps": 4,  "hint": "default rest" },
    "BUSY":     { "loop": true,  "fps": 6,  "hint": "working" },
    "EATING":   { "loop": true,  "fps": 6,  "hint": "xp gain" },
    "SLEEPING": { "loop": true,  "fps": 2,  "hint": "long idle" },
    "EXCITED":  { "loop": false, "fps": 12, "hint": "card done / level up" }
  },
  "avatar": {
    "url": "/static/companions/petdx-lobster-default/avatar.png",
    "size": 256
  },
  "metadata": {
    "tags": ["mascot", "default"],
    "color": "#e63946",
    "category": "mascot",
    "description": "EClaw 預設龍蝦伙伴",
    "createdAt": 1778345000000,
    "downloads": 0,
    "favorites": 0,
    "rating": null
  },
  "license": "EClaw-default",
  "i18n": {
    "name": { "en": "Lobster", "zh-TW": "龍蝦", "ja": "ロブスター" },
    "description": { "en": "Default lobster companion" }
  }
}
```

### 2.2 assetType 三種路徑

| assetType | 說明 | 引擎需要 |
|---|---|---|
| `procedural` | 引擎內建程序繪圖（既有 Lobster 屬於此類） | renderer key 對應 Android 內已寫好的 drawer 函式 |
| `spritesheet` | webp/png 序列幀 | sheet url + 各 state 的 row/frame/fps |
| `vector` | SVG + keyframe JSON（v0.2 預留，creator workshop MVP 不上） | svg url + keyframe url |

**v0.2 MVP** 只實作 `procedural` 與 `spritesheet`。`vector` 欄位 schema 預留但 backend reject。

### 2.3 動態 supportedStates（per N4 / Q5）

伙伴**自報**支援哪些 state，沒有固定 9 個的限制。最低門檻：必須支援 `IDLE`。

| 場景 | supportedStates 範例 |
|---|---|
| Lobster 預設（既有引擎 5 state） | `["IDLE","BUSY","EATING","SLEEPING","EXCITED"]` |
| 創作者極簡伙伴 | `["IDLE"]` |
| 創作者豐富伙伴 | `["IDLE","BUSY","SLEEPING","EXCITED","SAD","ALERT","PLAYING","THINKING","CELEBRATING"]` |
| 系統未來擴充 | 任意字串（PascalCase 或 SCREAMING_CASE） |

引擎收到 state 不在 `supportedStates` 時：靜默 fallback 到 `IDLE`，**不報錯**（per N4 「不要看起來不批配夥伴的樣貌就行」）。Agent 透過 §6.4 help API 主動查詢支援列表，避免送出無效 state。

### 2.4 必填 vs 選填

| 欄位 | 必填 | 備註 |
|---|---|---|
| id | ✅ | 唯一，kebab-case |
| name | ✅ | i18n 預設 zh-TW |
| assetType | ✅ | `procedural` / `spritesheet` / `vector` |
| asset | ✅ | schema 隨 assetType 變化 |
| supportedStates | ✅ | 至少含 `IDLE` |
| stateAssets.IDLE | ✅ | 其他 state 條件選填（in supportedStates 必填） |
| avatar.url | ✅ | publish 時系統自動從 IDLE frame 生成；creator 也可上傳 override |
| author | ✅ | 系統內建伙伴 `author.entityId=0` |
| license | ⚪ | 預設 `EClaw-default` |
| i18n | ⚪ | |

---

## 3. 伙伴瀏覽器（設定頁入口，per N2）

進入點：設定頁 → 「桌布伙伴」分組 → 「瀏覽伙伴」按鈕。
**不再有 `portal/wallpaper-browser.html` 獨立頁**。

### 3.1 佈局（行動 / WebView 優先）

```
┌──────────────────────────────────────────────────────────┐
│  ← 返回設定        桌布伙伴瀏覽器        [+ 創作]         │
├──────────────────────────────────────────────────────────┤
│  [搜尋框........................]                         │
│  分類: [全部] [動物] [人物] [機器人] [系統] [自訂]        │
│  排序: [熱門▼] [最新] [我的收藏] [我的作品]               │
├──────────────────────────────────────────────────────────┤
│  ┌─────┐ ┌─────┐ ┌─────┐                                  │
│  │preview│ │preview│ │preview│   <- 行動 3 col / 桌機 6 col │
│  │橘貓  │ │白兔  │ │機器人│                                │
│  │ 1.2k│ │ 856 │ │ 432 │                                  │
│  └─────┘ └─────┘ └─────┘                                  │
│  ...                                                       │
│  [載入更多 ▼]                                              │
└──────────────────────────────────────────────────────────┘
```

### 3.2 grid item 預覽動作

每個 grid item 是 144×200 卡片：

- 上半部 144×144：**靜態顯示 avatar.png**（idle frame snapshot）
- 行動裝置長按 / 桌機 hover 1 秒 → **進入預覽模式**：在卡片內輪播該伙伴所有 supportedStates 各 1.5 秒
- 下半部 144×56：name、author 顯示名、下載 / 評分
- 點擊 → 詳情面板；長按詳情面板的「設為當前伙伴」 → 切換並退回設定頁

### 3.3 詳情面板（per N2 「預覽動作」）

側邊抽屜（手機全螢幕、桌機 480 px 寬）：

- 大預覽 320×320
- **狀態切換器**：列出該伙伴的 `supportedStates`（動態，不是固定 9 顆按鈕；每顆按鈕點擊播放對應 state 動畫）
- 名稱 / 作者 / 描述 / 標籤
- 「設為當前伙伴」（主按鈕） / 「收藏」 / 「分享連結」
- 統計：下載、收藏、評分（5 星）、留言
- 留言區（前 3 條 + 載入更多）
- 創作者其他作品（橫向 scroll，最多 6 個）

### 3.4 搜尋

- **關鍵字**：比對 name (i18n 全語系) + description + tags + author displayName
- **debounce**: 300 ms
- **零結果**：「沒有相符伙伴 — 試試 [建議標籤 ×3]」

### 3.5 響應式

| 螢幕寬 | grid 欄數 | item 寬 | 篩選器 |
|---|---|---|---|
| ≥1280 (桌機) | 6 | 160 | 全展開 |
| 768–1279 (平板) | 4 | 160 | 全展開 |
| 480–767 (大手機) | 3 | 144 | 收合（icon 按鈕展開抽屜） |
| <480 (小手機) | 2 | 144 | 收合 |

### 3.6 i18n 觸點

- 所有 UI 字串透過 `data-i18n` + `backend/public/shared/i18n.js`
- 伙伴 name/description 從 CompanionDescriptor `i18n` 區塊讀取，fallback 到 default
- 預期新增 i18n keys 約 25 個

---

## 4. Android 動態桌布渲染（既有引擎增強）

**核心原則**：v0.2 是 enhancement，不是 rewrite。沿用 `app/src/main/java/com/hank/clawlive/service/ClawWallpaperService.kt` + `engine/ClawRenderer.kt`，新增 CompanionDescriptor 解析層作為「素材路由」。

### 4.1 既有架構（保留）

```
WallpaperService (ClawWallpaperService)
    ↓ holds Engine
WallpaperService.Engine (ClawEngine)
    ↓ observes ClawStatusRepository (polling)
    ↓ delegates draw to:
ClawRenderer (Canvas procedural)
    ├ drawLobsterAtPosition()       <- 既有，繪 Lobster 身體
    ├ drawLobsterEyesForEntity()    <- 既有，繪眼睛 (lid 依 SLEEPING)
    ├ drawMessageBubble()           <- 既有，bubble + emoji
    ├ drawEntityBadge()             <- 既有，多 entity 標籤
    └ drawMultiEntity()             <- 既有，多 entity layout
```

### 4.2 v0.2 新增：CompanionDescriptor 解析層

```
ClawEngine.onDraw()
    ↓
[NEW] CompanionResolver.getCurrent(entityId)
    ↓
CompanionDescriptor { assetType, asset, supportedStates, stateAssets }
    ↓
[NEW] CompanionRenderRouter.route(descriptor, currentState, canvas, position)
    ├ assetType=procedural → ProceduralCompanionDrawer (既有 Lobster drawer 屬於此類)
    ├ assetType=spritesheet → SpritesheetCompanionDrawer (新增)
    └ assetType=vector → VectorCompanionDrawer (v0.2 reject, schema 預留)
```

**不變**：
- `WallpaperService` lifecycle
- `ClawStatusRepository` polling 邏輯
- `drawMessageBubble`、`drawEntityBadge`、`drawMultiEntity` layout 程式碼
- `bobOffset`（sleep stretches）等 state 視覺特效

**改動**：
- `drawLobsterAtPosition` / `drawLobsterEyesForEntity` → 包進 `ProceduralCompanionDrawer.draw()`，by descriptor.asset.params 驅動 body color / eye style 等參數
- `CharacterState` enum → 改為 `String` 型別（per N4 動態 state）
- `getStateEmoji(state: String)` 從 hardcoded switch → 改查 descriptor.stateAssets[state].emoji（fallback 到 IDLE emoji 😐）

### 4.3 procedural drawer (Lobster 為示範)

`ProceduralCompanionDrawer` 是既有 Lobster 繪圖法的廣義化：

```kotlin
class ProceduralCompanionDrawer(
    private val descriptor: CompanionDescriptor
) : CompanionDrawer {
    override fun draw(canvas: Canvas, state: String, position: PointF) {
        val params = descriptor.asset.params
        val bodyColor = parseColor(params["bodyColor"] as? String ?: "#e63946")
        // ... 沿用既有 drawLobsterAtPosition 演算法，body color 從 params 取
        // ... eye style / antenna style 等也從 params 取
    }
}
```

未來若有 procedural 的「貓伙伴」「兔伙伴」（不上傳 spritesheet 的低門檻創作），可在 Android 端新增對應 drawer key（`cat-procedural`、`bunny-procedural`），CompanionResolver 依 `asset.renderer` 路由。

### 4.4 spritesheet drawer

`SpritesheetCompanionDrawer` 用於社群上傳的 webp/png 序列幀：

```kotlin
class SpritesheetCompanionDrawer(
    private val descriptor: CompanionDescriptor,
    private val sheetBitmap: Bitmap
) : CompanionDrawer {
    override fun draw(canvas: Canvas, state: String, position: PointF) {
        val stateAsset = descriptor.stateAssets[state] ?: descriptor.stateAssets["IDLE"]!!
        val (srcX, srcY, frameW, frameH) = computeFrameRect(stateAsset, frameTick)
        canvas.drawBitmap(sheetBitmap, srcRect, dstRect, paint)
    }
}
```

- sheet 在 CompanionResolver 載入時 decode → 快取在 LRU（最多 3 張，避免記憶體爆）
- 未載入時 fallback 顯示 IDLE 靜態 avatar PNG

### 4.5 多 entity 場景

既有 `drawMultiEntity` 不變。每個 entity 獨立查 CompanionResolver → 各自 route 到對應 drawer。記憶體 budget：同時最多 3 張 spritesheet decode 在記憶體（其餘用靜態 avatar）。

### 4.6 性能 & 記憶體（Android 引擎 baseline）

| 指標 | 目標 |
|---|---|
| 載入單一 procedural 伙伴 | <50 ms |
| 載入單一 spritesheet 伙伴 | <300 ms（含 decode）|
| FPS | 30 fps（Wallpaper service 標準）|
| 記憶體上限 | <80 MB（含 3 張 spritesheet decode）|
| spritesheet 檔案大小 | ≤ 600 KB |
| state 切換延遲 | <100 ms |

### 4.7 LOD 與省電

- 螢幕關閉 / 桌布不可見時暫停動畫（既有 `onVisibilityChanged` hook 即可）
- 電量低於 15% 時自動降為 `IDLE` 靜態（不跑動畫，省電）
- 「高品質模式」設定：spritesheet 滿幀；關閉時抽 1/2 幀

---

## 5. Agent 大頭照（idle frame 固定，per N1 + Hank §1 編輯）

### 5.1 同步規則

當前伙伴改變時，以下位置的 avatar 自動更新（per N1 「要可替換 Lobster 整體」）：

1. `entity_card.iconUrl` — entity card 主頭像
2. chat 對話列頭像
3. kanban card `assignedBots[].avatar`
4. plaza / arena ranking 頭像
5. mention 預覽卡頭像

### 5.2 idle frame 固定 PNG（不再每次抽幀）

每個 published 伙伴在送審通過時，由 backend **一次性生成 avatar.png**：

- procedural 伙伴：backend 在虛擬 canvas 跑一次 IDLE frame 0 → 輸出 256×256 PNG
- spritesheet 伙伴：backend 從 sheet 抽 IDLE row × frame 0 → 輸出 256×256 PNG
- creator 也可上傳自製 avatar override（會覆寫自動生成）

avatar.png 與 CompanionDescriptor 一起儲存在 `/static/companions/<id>/avatar.png`。

### 5.3 多 entity 持有

每個 entity 獨立持有「當前伙伴」狀態：vault 內 `PETDX_CURRENT_<entityId>=<companionId>`。
對話介面同時顯示多個 entity 時（kanban / mention），每個 entity 顯示自己的伙伴 avatar.png。

### 5.4 同步延遲

切換伙伴 → 大頭照同步預期 < 300 ms（avatar.png 是固定檔案，不需 client 端抽幀）。失敗 fallback 到原 entity card icon。

### 5.5 客戶端快取

vault 同時寫入 `PETDX_AVATAR_<entityId>=<avatar.png url>`，client 端優先從 vault 讀（避免每次 query CompanionDescriptor）。

---

## 6. 狀態切換邏輯（動態 state list）

### 6.1 state 來源（與 v0.1 一致，新增 dynamic 支援）

| 來源 | event 名稱 | 預設對應 state |
|---|---|---|
| `/api/transform` `state` 欄位 | state-change | BUSY / IDLE 等 |
| `/api/mission/card/*/move` | card-status | BUSY (in_progress) / EXCITED (done) |
| WebSocket push (broadcast) | push | ALERT (若伙伴支援) |
| client-side mouse | click-pet | PLAYING (若伙伴支援) |
| 5 min 無 event | timeout | SLEEPING |
| `/api/entity/level-up` | xp-gain | EATING |
| HTTP 5xx error | error | SAD (若伙伴支援) |

### 6.2 mismatch 處理（per N4）

Agent 送出某個 state，但當前伙伴 `supportedStates` 不包含時：

1. 渲染器靜默 fallback 到 IDLE
2. 不回 4xx error
3. 不寫 client-side console warn（避免訊號污染）
4. backend `state-event` API 回 200 OK，body 含 `{ resolved: "IDLE", reason: "unsupported" }`（agent 想知道可選擇 log）

### 6.3 跨頁面持久化（既有，不變）

- Android 端：當前 state 由 `ClawStatusRepository` polling 維護
- WebView 內：透過 `window.postMessage` 與 native 同步
- Web portal（設定頁瀏覽器）：localStorage 僅快取「當前伙伴 id」，不持久化 state

### 6.4 Help API（per N4）

```
GET /api/companion/<companionId>/states/help
→ {
    "companionId": "petdx-lobster-default",
    "supportedStates": ["IDLE","BUSY","EATING","SLEEPING","EXCITED"],
    "stateAssets": { ... }  // 含 fps / loop / hint
  }
```

Agent 在切換伙伴後**主動呼叫**此 API 一次，cache supportedStates，後續送 state-event 前先 local check。
詳細 schema 見 Backend API spec §3.5。

### 6.5 一次性動畫處理

`stateAssets[state].loop = false` 為一次性動畫（如 EXCITED celebrate）。播放完成後 fallback 回 IDLE 或當前 baseline state（以 polling repository 為準）。

---

## 7. 創作者工作台（Android 內 + 設定頁）

進入點：設定頁 → 「桌布伙伴」 → 「創作我的伙伴」。
v0.2 MVP 在 web 設定頁實作，Android in-app 入口直接 deep-link 到 WebView。

### 7.1 主介面

四個 tab：

1. **基本資訊**：CompanionDescriptor metadata 表單（name / description / tags / category / license）
2. **assetType 選擇 + 上傳**：三選一引導
3. **State 編輯**：勾選支援哪些 state，每個 state 設定 fps / loop / hint
4. **預覽 + 發布**：即時預覽各 state、儲存草稿、送審

### 7.2 assetType 選擇

| assetType | UI 流程 |
|---|---|
| `procedural` | 顏色 picker + 形狀 preset 下拉（v0.2 MVP 只開 Lobster 變色）|
| `spritesheet` | drag-drop webp/png + 標 frame 尺寸 + 自動分幀預覽 |
| `vector` | (v0.2 disabled，UI 顯示「coming soon」) |

### 7.3 spritesheet 工具

- **上傳**：drag-drop 或選檔
- **裁切**：設定 frame 尺寸（預設 256×256）+ rows × cols + 起始偏移
- **自動分幀**：抽取每 row 第 0 frame 顯示縮圖
- **State mapping**：拖拉 state 到對應 row（state 列表動態，創作者選了哪些就顯示哪些）

### 7.4 預覽

- 各狀態獨立播放，可調 fps
- 「行動裝置 emulate」按鈕：模擬 Wallpaper service 240×240 顯示尺寸
- 「Avatar 預覽」按鈕：顯示自動從 IDLE frame 0 抽出的 avatar.png

### 7.5 草稿與發布

- **草稿**：device_vars `PETDX_DRAFT_<draftId>`，最多 10 個
- **送審**：提交後狀態為 `pending_review`
- **公開**：審核通過 → `published` + 系統自動生成 avatar.png
- **更新**：已公開伙伴可發新 version（v1.1.0），舊 user 自動 prompt 升級

### 7.6 創作統計

- 各伙伴下載數、收藏數、評分、留言
- **e 幣收益面板**（per Q2）：累積使用次數 × 單次 e 幣率，趨勢圖（30 天）
- 對接 wallet 後顯示已入帳 e 幣餘額

---

## 8. 社群伙伴貢獻系統

### 8.1 提交流程

```
創作者完成 CompanionDescriptor + asset
         ↓
    POST /api/companion/submit
         ↓
   pending_review 狀態
         ↓
  ┌──────────────────────┐
  │ 審核（device owner）   │
  │  - 內容過濾             │
  │  - 檔案大小 / 格式      │
  │  - 重複偵測              │
  │  - 版權檢查（license）  │
  │  - assetType 安全檢查   │
  └──────────────────────┘
         ↓
  通過 → published + 系統生成 avatar.png + 計入創作者統計
  退回 → returned (附理由)
```

### 8.2 審核機制

- **自動**：檔案規格、必填欄位、license 標記、重複 hash 比對、forbidden-script 檢查
- **人工**：device owner 或指定 reviewer entity 進行內容審核
- **AI 輔助**：NSFW / 暴力 / 政治敏感分類器（可設閾值）
- **快速通道**：認證創作者（>5 個 published）skip 自動審查

### 8.3 評分與留言

- 5 星評分（已切換為當前伙伴 ≥ 3 天可評）
- 留言 max 500 字
- 創作者可回覆留言（一層）
- 檢舉機制（騷擾 / 垃圾 / 不當內容）

### 8.4 e 幣分潤（per Q2）

- **預設啟用**：每次他人「設為當前伙伴」事件 → 創作者得 N e 幣
- 單次 e 幣率 = device owner 在 settings 設定（預設 1 e 幣 / 切換）
- 對接 wallet：使用者付費購買限定伙伴 → 70% 創作者 / 30% 平台
- 詳細金額 / 上限 / 防刷規則待 Phase 4 wallet spec 確認

### 8.5 內容下架

- 違反規範 → device owner 下架（hidden 狀態，已下載者保留本地副本）
- 創作者可刪除自己的伙伴（軟刪除，30 天內可復原）
- 版權主張 → DMCA-style 流程（待 legal 設計）

---

## 9. 跨平台相容性

| 平台 | Phase 1 (本 spec) | Phase 2+ (另開 spec) |
|---|---|---|
| Android App 動態桌布 | ✅ 主入口 | — |
| Android WebView (設定頁) | ✅ 瀏覽器 + 創作者工作台 | — |
| Web portal (設定頁) | ✅ 瀏覽器 + 創作者工作台 | — |
| iOS App | — | iOS WidgetKit 桌布 |
| Android home screen widget | — | 原生 widget |
| Web portal 動畫桌布 (canvas 渲染) | ❌ 不在範圍 | 視需求另議 |

**v0.1 → v0.2 主要差異**：v0.1 的 Web canvas 渲染矩陣 / iOS WebView / Android WebView 桌布**全部下架**，本 spec 鎖定 Android 既有引擎增強。

---

## 10. 視覺規範

### 10.1 設定頁瀏覽器（web/WebView）

依循既有 EClaw design token (`backend/public/shared/design-tokens.css`)：

- 主色: `--color-primary` (orange)
- 背景: `--color-bg-secondary`
- 文字: `--color-text-primary` / `--color-text-muted`
- 伙伴卡片陰影: `0 2px 8px rgba(0,0,0,0.06)`，hover `0 4px 16px rgba(0,0,0,0.12)`

### 10.2 Android 動態桌布

沿用 `ClawRenderer` 既有調色（背景漸層、bubble 顏色、emoji 字型大小）。
新增 procedural 伙伴的調色透過 CompanionDescriptor.asset.params 傳入。

### 10.3 字型與間距

8 px grid。卡片內 padding 12，卡片間 gap 16。
標題 `--font-display`、內文 `--font-body`、數字 `--font-mono`。

### 10.4 動畫節奏（設定頁瀏覽器）

- hover transition: 200 ms ease-out
- state 預覽切換: 200 ms ease-in-out
- 所有動畫 `prefers-reduced-motion` 時降為 fade 或關閉

### 10.5 icon

從 EClaw existing icon set，缺項自製。

---

## 11. Q-list 解決紀錄（封存）

| # | 問題 | v0.1 假設 | v0.2 解 (Hank 2026-05-10) | 對應段落 |
|---|---|---|---|---|
| Q1 | 主軸取捨 | 動畫桌布為主、大頭照同步衍生 | **Android 桌布既有動畫的增強**（不重建 web portal） | §1, §4 |
| Q2 | 創作者收益分潤 | 預設關閉，Phase 4 啟用 | **預設啟用 e 幣分潤**（透過貢獻 Android 桌布 API） | §8.4 |
| Q3 | 是否與既有 entity 視覺一致 | 不要求 | （未變動，沿用 v0.1）| §2 |
| Q4 | 系統內建伙伴數量 | 5 個 | （未變動，sysprep card 細化） | — |
| Q5 | 9 狀態是否強制全有 | 只強制 idle | **不限制狀態種類數量**，每伙伴自報 supportedStates | §2.3, §6 |
| Q6 | 行動 home 全螢幕桌布是否強制 | 可關閉 | （已不在範圍）| §1.3 |
| Q7 | 社群審核強度 | 一律審核 + 認證快速通道 | （未變動）| §8.2 |
| Q8 | spritesheet 上限 | 800 KB 標準 / 200 KB lite | **600 KB 單一檔案**（Android 引擎 baseline）| §4.6 |
| Q9 | Live2D / Spine 支援 | 否 | （schema 預留 vector 但 v0.2 reject）| §2.2 |
| Q10 | 9 狀態動畫的 default fps | 4-12 各狀態不同 | **由 stateAssets 各自定**（無統一預設）| §2.1 |
| N1 | 大頭照可替換 Lobster 整體 | — | **同步全部 5 處 avatar slot** | §5.1 |
| N2 | 設定裡建立伙伴搜尋頁面 | — | **設定頁入口**（不再 portal/wallpaper-browser.html） | §3 |
| N3 | 沒用到的 API 砍 | — | **砍 v0.1 一半 endpoint**（state-event/avatar-sync 等） | Backend API spec §A |
| N4 | 動態 state list + help API | — | **GET /companion/:id/states/help** | §6.4 |
| N5 | E2E 驗證 avatar≠companion mismatch | — | **加入 E2E 卡 scope** | §12 |

---

## 12. 下游 impl 卡 mapping (v0.2)

| Impl 卡 | v0.1 對應 | v0.2 改動 | 對應章節 |
|---|---|---|---|
| [Backend] 伙伴系統 API | 全 18 endpoints | **砍半** (~9 endpoints) + 新增 `/states/help` | §2, §5.2, §6, §8 |
| [Frontend] Android 引擎 CompanionDescriptor 接入 | 桌布伙伴動畫系統 (web canvas) | **改寫**：CompanionResolver + RenderRouter + Procedural/Spritesheet drawers | §4 |
| [Avatar] 伙伴 idle PNG snapshot | (從前獨立卡？) | **合併**入 Frontend 卡作為 §5 子任務 | §5 |
| [UI] 設定頁伙伴瀏覽器 + 創作者工作台 | 兩張卡（瀏覽器 + 創作者）| **合併**為一張：共用設定頁入口 | §3, §7 |
| [API] 社群伙伴貢獻系統 | 同名 | （保留） | §8 |
| [Test] Petdx E2E | 同名 | **加入 N5 verification**（avatar 與當前伙伴一致性檢查） | §3, §4, §5 |

**子卡總數**：v0.1 6 張 → v0.2 5 張。

---

## 附錄 A — REST API 草案 v0.2（移轉到 Backend API spec）

詳細 endpoint 定義見 `petdx-backend-api-spec.md` v0.2。本附錄僅列入口：

```
# 列表 / 選擇 / 當前
GET    /api/companion/list
GET    /api/companion/:id
POST   /api/companion/select
GET    /api/companion/current
GET    /api/companion/:id/states/help          # NEW v0.2

# 創作者
POST   /api/companion/submit
POST   /api/companion/draft
GET    /api/companion/drafts
DELETE /api/companion/draft/:id
POST   /api/companion/review/:id

# 社群
POST   /api/companion/favorite
GET    /api/companion/favorites
POST   /api/companion/rate
POST   /api/companion/comment
GET    /api/companion/community
```

**v0.1 → v0.2 砍掉**：
- `POST /api/companion/state-event` （改用既有 `/api/transform` `state` 欄位）
- `POST /api/companion/avatar-sync` （改為 publish 時自動生成 avatar.png）
- `GET /api/companion/states/:id` （合併入 `/states/help`）

---

## 附錄 B — 檔案儲存路徑

```
/static/companions/<id>/
├── descriptor.json        # CompanionDescriptor (取代 v0.1 pet.json)
├── avatar.png             # idle frame snapshot, 256×256 (publish 時生成)
├── thumbnail.webp         # 144×144 grid 用 (publish 時生成)
└── asset/                 # asset 檔案 (依 assetType 變化)
    ├── procedural-params.json     # assetType=procedural
    ├── sheet.webp                  # assetType=spritesheet
    └── vector.svg + keyframes.json # assetType=vector (v0.2 預留)
```

device_vars keys：
- `PETDX_CURRENT_<entityId>` — 當前伙伴 id
- `PETDX_AVATAR_<entityId>` — 當前伙伴 avatar.png url（client 端快取）
- `PETDX_FAVORITES_<entityId>` — JSON array of companion ids
- `PETDX_DRAFT_<draftId>` — 草稿 CompanionDescriptor

**v0.1 → v0.2 移除**：
- `PETDX_AVATAR_CACHE_<entityId>` (base64 抽幀) — 改用固定 avatar.png url
- `PETDX_HIGH_QUALITY` (是否載入 hi-res) — Android 引擎自己處理

---

## 修訂紀錄

| 版本 | 日期 | 作者 | 變更 |
|---|---|---|---|
| v0.1 | 2026-05-10 | LOBSTER #2 | 初版（Mac_F #1 silent fallback draft）|
| v0.2 | 2026-05-10 | LOBSTER #2 | 整合 Hank web_chat Q-list 回應：鎖定 Android 既有引擎增強 / 砍 web canvas 路徑 / 動態 state list + help API / e 幣分潤預設啟用 / Avatar 改 idle PNG snapshot / 設定頁入口 / 子卡 6→5 |
