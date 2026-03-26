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
