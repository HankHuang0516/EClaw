# Mission Center v2 — Kanban 看板系統設計規格

> 來源：老闆手繪 Agent Collaboration Workflow 概念圖 + 口述需求
> 日期：2026-03-26
> 狀態：草稿，待老闆確認

---

## 一、核心概念

將任務中心從「扁平列表」升級為 **五欄式看板（Kanban Board）**，每個工作事項是一個 **Session 方塊（Card）**，可在五個狀態欄之間流動。

## 二、五個狀態欄（左→右）

| # | 狀態 | 顏色 | 說明 |
|---|------|------|------|
| 1 | **Backlog** | 灰色 | 尚未啟動的需求池 |
| 2 | **TODO** | 藍色 | 已排定、等待開工 |
| 3 | **In Progress** | 橙黃色 | 正在執行中 |
| 4 | **Review** | 橙色 | 完成待驗收 |
| 5 | **Done** | 綠色 | 驗收通過（auto clean） |

## 三、Session 方塊（Card）結構

### 3.1 卡片外觀
```
┌──────────────────────────┐
│ 🔴 P1        assigned: #4 │  ← 左上：優先級  右上：assigned bot
│                            │
│   [P2-1] Quick Start 文案  │  ← 中間：項目名稱
│   撰寫 3 步快速開始中英文案  │  ← 概述（1-2 行）
│                            │
│ 💬 3  📎 1  📝 2           │  ← 底部：留言數、檔案數、筆記數
└──────────────────────────┘
```

### 3.2 卡片內部（點開展開）

| 區域 | 說明 |
|------|------|
| **留言板** | Bot 和人類都可以留言。Bot 必須把跟任務相關的對話內容放在這裡，而非聊天頁面。支援 Markdown。 |
| **筆記區** | 任務相關的技術筆記、決策記錄、參考資料。所有 assigned bot 可讀寫。 |
| **檔案區** | 附件（截圖、設計稿、文件等）。支援上傳和連結。 |

### 3.3 卡片欄位

| 欄位 | 類型 | 說明 |
|------|------|------|
| `id` | UUID | 唯一識別碼 |
| `title` | string | 項目名稱 |
| `description` | string | 概述 |
| `priority` | enum | P0（最高）/ P1 / P2 / P3（最低） |
| `status` | enum | backlog / todo / in_progress / review / done |
| `assignedBots` | int[] | 目前負責的 entity ID 列表（支援多 bot） |
| `createdBy` | int | 建立者 entity ID |
| `createdAt` | timestamp | 建立時間 |
| `statusChangedAt` | timestamp | 最後狀態變更時間（用於卡住檢測） |
| `staleThresholdMs` | number | 卡住催促閾值（預設 10800000 = 3hr，Bot 可配置） |
| `doneRetentionMs` | number | Done 保留時間（預設 86400000 = 24hr，Bot 可配置） |
| `schedule` | object\|null | 排程設定（選填，見下方說明） |
| `comments` | array | 留言板記錄 |
| `notes` | array | 筆記列表 |
| `files` | array | 檔案附件列表 |

## 四、狀態流轉機制

### 4.1 流動規則
```
Backlog ⇄ TODO ⇄ In Progress ⇄ Review → Done
```

- **可以前進也可以倒退**（例如 Review 發現問題 → 退回 In Progress 或 TODO）
- Done 狀態不可倒退（已結案）
- **每次變更狀態時，必須指定新的 assigned bot(s)**
- 推進時，**後台自動 push 通知新 assigned bot**
- 通知同時 **渲染在該卡片的留言板上**
- **聊天頁面不重複通知**（任務通知只走卡片內留言板）

### 4.2 狀態變更動作
```
moveCard(cardId, newStatus, newAssignedBots[])
```
- 更新 status（可前進或倒退，Done 除外）
- 更新 assignedBots
- 重置 statusChangedAt = now()
- 在卡片留言板自動添加系統訊息：「狀態更新：TODO → In Progress，指派給 #4」
- Push 通知所有新 assigned bots

### 4.3 誰可以推進？
- **assigned bot**（完成工作後推到下一狀態）
- **總指揮 #2**（可以推進任何卡片）
- **老闆**（最高權限）

## 五、自動化機制

### 5.1 卡住催促（Stale Card Detection）

| 條件 | 動作 |
|------|------|
| 卡片在 **TODO / In Progress / Review** 超過 `staleThresholdMs`（預設 3 小時） | Push 通知所有 assigned bots 繼續推進 |

- **計時器在每次狀態變更時重置**
- 催促訊息也渲染在卡片留言板上
- 每次催促間隔不低於 1 小時（避免轟炸）
- `staleThresholdMs` 由 Bot 可配置（預設 3 小時 = 10800000ms）

### 5.2 自動清除（Done Auto-Clean）

| 條件 | 動作 |
|------|------|
| 卡片在 **Done** 超過 `doneRetentionMs`（預設 24 小時） | 自動歸檔（從看板移除，資料保留） |

- `doneRetentionMs` 由 Bot 可配置（預設 24 小時 = 86400000ms）
- 歸檔卡片可在 **Settings 頁面** 的歷史入口查看

## 六、建立新卡片

- **誰可以建立**：老闆、總指揮 #2
- **建立時指定**：title、description、priority、initialStatus（預設 Backlog）、assignedBot
- **建立後**：自動出現在對應狀態欄
- **如果 initialStatus ≠ Backlog**：立即 push 通知 assigned bot

## 七、Bot 行為規範

### 7.1 任務相關對話 → 卡片留言板
Bot 在處理任務時，所有跟任務相關的溝通**必須寫入卡片留言板**，而非聊天頁面。

### 7.2 聊天頁面 → 保持乾淨
聊天頁面只用於：
- 跟任務無關的對話
- 緊急通知
- 人際互動

### 7.3 進度更新
Bot 必須定期更新卡片的 description 或留言板，反映最新進度。

## 七-B、卡片排程機制

Session 方塊可以額外設定排程，機制與現有排程任務相同。

### 排程欄位（`schedule` object）

| 欄位 | 類型 | 說明 |
|------|------|------|
| `enabled` | boolean | 是否啟用排程 |
| `type` | enum | `once`（一次性）/ `recurring`（重複性） |
| `cronExpression` | string | Cron 表達式（重複性用），例如 `0 9 * * 1` = 每週一 09:00 |
| `runAt` | timestamp | 一次性排程的執行時間 |
| `timezone` | string | 時區，預設 `Asia/Taipei` |
| `lastRunAt` | timestamp | 最後執行時間 |
| `nextRunAt` | timestamp | 下次執行時間（系統計算） |

### 排程行為

- **一次性（once）**：到達 `runAt` 時間後，push 通知 assigned bots 開始工作，並自動將卡片從 Backlog/TODO 推進到 In Progress
- **重複性（recurring）**：每次觸發時，push 通知 assigned bots，在卡片留言板添加系統訊息
- 重複性卡片 **不會自動歸檔**（即使在 Done 也會在下次觸發時重新啟動回 TODO）
- 排程觸發時間由後端定時器掃描（與卡住催促共用同一個 interval）

### API

```
PUT    /api/mission/card/:id/schedule
Body: { enabled, type, cronExpression?, runAt?, timezone? }
```

---

## 八、API 設計（草案）

### Cards CRUD
```
POST   /api/mission/card          — 建立新卡片
GET    /api/mission/cards          — 取得所有卡片（可依 status 過濾）
GET    /api/mission/card/:id       — 取得單張卡片詳情
PUT    /api/mission/card/:id       — 更新卡片
DELETE /api/mission/card/:id       — 刪除/歸檔卡片
```

### 狀態推進
```
POST   /api/mission/card/:id/move
Body: { newStatus, assignedBots: [entityId, ...] }
```

### 留言板
```
GET    /api/mission/card/:id/comments
POST   /api/mission/card/:id/comment
Body: { text, fromEntityId }
```

### 筆記
```
GET    /api/mission/card/:id/notes
POST   /api/mission/card/:id/note
Body: { title, content, fromEntityId }
```

### 檔案
```
POST   /api/mission/card/:id/file
Body: multipart/form-data
```

### 歸檔
```
GET    /api/mission/cards/archived  — 取得歸檔卡片列表（分頁）
GET    /api/mission/card/:id        — 歸檔卡片也可用同一端點查詢
```

### 配置
```
PUT    /api/mission/card/:id/config
Body: { staleThresholdMs, doneRetentionMs }
```

## 九、前端 UI

### 9.1 桌面版
- 五欄橫向排列，每欄內卡片垂直堆疊
- 拖放（drag & drop）移動卡片
- 點擊卡片展開 Detail Modal（留言板 / 筆記 / 檔案 三個 tab）

### 9.2 手機版
- 頂部 tab 切換五個狀態
- 每個 tab 內卡片垂直列表
- 點擊展開同樣的 Detail Modal

### 9.3 卡片顏色
- 依優先級顯示左邊色條：P0=紅色、P1=橙色、P2=藍色、P3=灰色
- 狀態欄標題帶顏色標識

## 十、與現有系統的關係

### 10.1 現有 TODO/Mission 系統
- **v2 取代現有的 todoList / missionList**
- 遷移計畫：將現有 TODO items 轉換為 Kanban cards

### 10.2 Dashboard
- Dashboard 顯示看板摘要：各欄卡片數量、卡住的卡片警告

### 10.3 聊天頁面
- 移除任務通知的自動轉發到聊天
- 聊天頁面可增加「查看相關卡片」的快捷入口

---

## 老闆確認事項（2026-03-26 15:00 確認）

| # | 問題 | 決定 |
|---|------|------|
| 1 | 卡片可以倒退嗎？ | ✅ **可以**。Review 有問題可倒退回任一前序狀態，重走流程。 |
| 2 | 一張卡可以 assign 多個 bot？ | ✅ **可以**。`assignedBots` 改為陣列。 |
| 3 | 需要 due date / deadline？ | ❌ **不需要**。有背景自動催促機制足夠。 |
| 4 | 催促間隔 3 小時可配置？ | ✅ **可配置**。由 Bot 控制，預設 3 小時。欄位：`staleThresholdMs`，預設 `10800000`。 |
| 5 | Done 24 小時清除可配置？ | ✅ **可配置**。由 Bot 控制，預設 24 小時。欄位：`doneRetentionMs`，預設 `86400000`。 |
| 6 | 歸檔卡片歷史入口？ | ✅ **有**。放在 Settings 頁面，提供歸檔卡片的查詢/瀏覽入口。 |

---

_老闆已確認所有問題，開始分拆任務開工。_

---

## 十一、排程整合看板（方案 B — 老闆確認 2026-03-26）

### 核心概念：「⚡ 自動化」摺疊區

看板保留五欄，另加一個**摺疊式自動化區域**，位於看板上方或側邊。

### 架構

```
┌─────────────────────────────────────────────┐
│ ⚡ 自動化 (3 active)              [展開 ▼] │
│ ┌──────┐ ┌──────┐ ┌──────┐                  │
│ │UIUX  │ │Agent │ │Skill │  ← 重複排程卡片  │
│ │巡檢  │ │Card  │ │Scan  │    (折疊/展開)    │
│ │4h ↻  │ │24h ↻ │ │1h ↻  │                  │
│ └──────┘ └──────┘ └──────┘                  │
├─────────────────────────────────────────────┤
│ Backlog │  TODO  │ In Prog │ Review │ Done  │
│         │ ┌────┐ │         │        │       │
│         │ │自動 │ │         │        │       │
│         │ │建的 │ │         │        │       │
│         │ │臨時 │ │         │        │       │
│         │ │卡片 │ │         │        │       │
│         │ └────┘ │         │        │       │
└─────────────────────────────────────────────┘
```

### 自動化卡片 vs 普通卡片

| 屬性 | 自動化卡片（Automation） | 普通卡片（Card） |
|------|--------------------------|------------------|
| 位置 | ⚡ 摺疊區 | 五欄看板 |
| schedule | 必有（recurring） | 選填（once/無） |
| 觸發行為 | 自動「生出」臨時卡片到 TODO | 自己移動到 In Progress |
| 完成後 | 臨時卡片歸檔，母卡不動 | 正常歸檔 |
| 顯示 | 名稱 + cron + 下次觸發 + 最近執行結果 | 正常卡片 |

### 觸發流程

```
自動化卡片（母卡）
    │
    │ cron 觸發
    ▼
自動建立臨時卡片（子卡）→ TODO
    │ assignedBots = 母卡的 assignedBots
    │ title = "[Auto] 母卡標題 (03/26 18:30)"
    │ 自動 push 通知 assigned bots
    ▼
Bot 執行 → In Progress → Review → Done → 自動歸檔
    │
    │ 結果回寫母卡
    ▼
母卡更新 lastRunAt + 留言板記錄執行結果
```

### 子卡特殊屬性

| 欄位 | 說明 |
|------|------|
| `parentCardId` | 指向母卡 UUID |
| `isAutoGenerated` | true |
| `autoTitle` | 自動生成的標題含時間戳 |

### 母卡（自動化）特殊屬性

| 欄位 | 說明 |
|------|------|
| `isAutomation` | true |
| `schedule.type` | 必須是 `recurring` |
| `lastRunResult` | 最近一次子卡的執行結果摘要 |
| `activeChildId` | 目前進行中的子卡 ID（同時只能有一張） |

### UI 互動

**摺疊區：**
- 預設收合，顯示「⚡ 自動化 (N active)」
- 展開後顯示所有 recurring 卡片，横向排列
- 每張顯示：名稱、cron 描述（如「每 4 小時」）、下次觸發、最近結果 ✅/❌
- 點擊展開同樣的 Detail Modal

**建立自動化：**
- 新增卡片時多一個 toggle「⚡ 設為自動化」
- 開啟後顯示 cron 設定（快捷選項 + 自訂）
- 快捷：每小時 / 每 4 小時 / 每天 / 每週一

**臨時卡片標示：**
- 卡片上顯示「⚡」badge 表示自動生成
- 標題前綴 [Auto]
- 可點擊查看母卡

### API 變更

```
POST   /api/mission/card          — 新增 isAutomation 欄位
GET    /api/mission/cards          — 新增 ?automation=true 過濾自動化卡片
GET    /api/mission/card/:id/children — 列出母卡的所有子卡歷史
```

### 遷移計畫

1. 現有 scheduler.js 的排程 → 逐步轉成自動化卡片
2. schedule.html 保留但加導航到看板
3. 最終 schedule.html 廢棄，排程全在看板管理

### 規則

- 同一時間一張母卡只能有一張活躍子卡
- 如果子卡還在 In Progress，新觸發會跳過（避免重複）
- 跳過時在母卡留言板記錄「⏭ 跳過：上一次執行尚未完成」
- 子卡完成後，結果摘要回寫母卡的 lastRunResult


### 排程任務遷移計畫（Merge scheduler → Kanban）

**目標：** 將現有 scheduler.js 的 15 個排程任務全部遷移到 Kanban 自動化卡片，最終廢掉 schedule.html。

**階段一：共存期**
- Kanban 自動化觸發器 + 現有 scheduler.js 並行
- 新排程一律用 Kanban 建立
- 舊排程逐步手動遷移

**階段二：遷移**
- 腳本讀取 scheduler.js 的 15 個 schedule
- 每個轉成一張 isAutomation=true 的 Kanban 卡片
- cron 表達式、assignedBots、描述全部帶過來
- 驗證新卡片觸發正常後，disable 舊 schedule

**階段三：廢棄**
- scheduler.js 的定時觸發邏輯由 kanban.js 的 backgroundTick 接管
- schedule.html 改成 redirect 到 kanban.html
- 最終移除 scheduler.js（保留 DB table 做歷史查詢）

**前端整合：**
- mission.html 的 sub-tab「📅 Schedule」→ 改指向 kanban.html 的自動化區
- kanban.html 成為唯一的任務管理入口

