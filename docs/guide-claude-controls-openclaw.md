# 用 Claude 透過 Eclaw 指揮 OpenClaw — 從零開始

> 本文教你如何讓 Claude（AI 助理）成為你的「AI 指揮官」，
> 透過 Eclaw 系統遠端控制你的 OpenClaw bot。

---

## 架構概覽

```
你（User）
  │
  │ 用自然語言下指令
  ▼
Claude（AI 助理）
  │
  │ 呼叫 Eclaw HTTP API
  ▼
Eclaw 後端（eclawbot.com）
  │
  │ Push 通知 / speak-to
  ▼
OpenClaw Bot（你的 AI bot）
  │
  │ 執行任務後回報狀態
  ▼
Eclaw → Claude 查詢結果
```

**三個角色：**
| 角色 | 說明 |
|------|------|
| **Eclaw** | 中控台，管理你的 entity（bot 席位），提供 HTTP API |
| **OpenClaw** | AI bot 的運行平台，執行實際任務 |
| **Claude** | 你的 AI 指揮官，透過 Eclaw API 傳達指令給 OpenClaw |

---

## 前置準備

### 需要的東西

- [ ] Eclaw 帳號（[eclawbot.com](https://eclawbot.com)）+ 手機 App 或 Web Portal
- [ ] 一個已在 OpenClaw 平台上運行的 AI bot
- [ ] bot 已成功**綁定**到你的 Eclaw entity slot（手機 App 掃碼綁定）
- [ ] Claude Code CLI（[安裝說明](https://claude.ai/claude-code)）或 Claude.ai（含 MCP 工具）

---

## Step 1：取得你的憑證

綁定完成後，你需要兩樣資訊給 Claude：

### 1-A. 取得 Device ID

開啟 Eclaw Web Portal → 右上角頭像 → Settings → 點眼睛圖示顯示 → 複製 **Device ID**

```
範例：xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### 1-B. 取得 Device Secret

Device Secret 是你的帳號憑證（owner 層級），讓 Claude 可以設定排程、查詢 entity 狀態等。

取得方式：Eclaw Web Portal → 右上角頭像 → **Settings** → Device Secret 列 → 點眼睛圖示顯示 → 複製。

```
範例：xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

> **注意**：`botSecret` 是 bot 自己在綁定時收到的憑證，由 bot 自己持有，用戶不需要取得也不需要提供給 Claude。

### 1-C. 確認 Entity ID

你最多有 8 個 entity slot（0–7）。
通常第一個 bot 是 entity **0**，第二個是 **1**，以此類推。
在 Dashboard 可以看到各 entity 的名稱與狀態，確認編號後告知 Claude。

---

## Step 2：給 Claude 看「技能說明書」

Eclaw 有一份 AI 指令說明書，告訴 Claude 有哪些 API 可用。說明書網址：

```
https://eclawbot.com/api/skill-doc
```

### 方法 A：Claude Code CLI（最簡單）

直接對 Claude 說，讓它自己用 WebFetch 抓取：

```
請用 WebFetch 讀取 https://eclawbot.com/api/skill-doc，然後幫我控制我的 OpenClaw bot。
```

Claude Code 有 WebFetch 工具，會直接讀取說明書，不需要手動複製貼上。

### 方法 B：Claude.ai + 貼文字 / 上傳檔案

1. 在瀏覽器開啟說明書連結，複製全文，貼入 Claude.ai 對話
2. 或點擊 📎 上傳 `.md` 檔案
3. 對 Claude 說：「請閱讀這份說明書，之後我要用你控制我的 OpenClaw bot」

---

## Step 3：告訴 Claude 你的憑證

在對話中把憑證提供給 Claude：

```
我的 Eclaw 設定：
- Device ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
- Device Secret: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
- 我要控制的 bot 是 Entity 0

請幫我控制這個 OpenClaw bot。
```

> ⚠️ **安全提醒**：Device Secret 是你的帳號憑證，可以操作排程與任務設定。
> 建議只在私人對話中使用，不要公開分享。Bot Secret 是 bot 本身的憑證，無需提供。

---

## Step 4：開始下指令

現在 Claude 已經知道如何使用 Eclaw API，你可以用自然語言下指令：

---

### 範例 1：查看 bot 目前狀態

**你說：**

```
幫我看看我的 bot 目前在做什麼
```

**Claude 會：**

1. 呼叫 `GET https://eclawbot.com/api/entities?deviceId=YOUR_ID`
2. 讀取 entity 0 的 `state` 和 `message`
3. 回報給你：「你的 bot 目前狀態是 IDLE，最後訊息是：...」

---

### 範例 2：給 bot 一個任務

**你說：**

```
叫我的 bot 去搜尋最近 GitHub 上最受歡迎的 Python 爬蟲框架，整理成清單回報給我
```

**Claude 會：**

1. 呼叫 `POST /api/entity/speak-to`，把任務說明推送給 bot
2. 等待 bot 執行並更新狀態
3. 查詢結果後回報給你

---

### 範例 3：讓 bot 變換情緒/狀態

**你說：**

```
讓我的 bot 進入工作模式，顯示「正在分析市場數據」
```

**Claude 會：**

```bash
# Claude 在背後執行
curl -s -X POST "https://eclawbot.com/api/transform" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "YOUR_DEVICE_ID",
    "entityId": 0,
    "botSecret": "YOUR_BOT_SECRET",
    "state": "WORKING",
    "message": "正在分析市場數據"
  }'
```

---

### 範例 4：設定每小時自動執行任務

**你說：**

```
幫我設定一個排程：每天早上 9 點，讓 bot 自動抓取今日科技新聞摘要
```

**Claude 會：**

```bash
curl -s -X POST "https://eclawbot.com/api/bot/schedules" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "YOUR_DEVICE_ID",
    "entityId": 0,
    "botSecret": "YOUR_BOT_SECRET",
    "message": "每日任務：搜尋今日科技新聞，整理 5 則摘要，用 POST /api/transform 更新狀態",
    "repeatType": "cron",
    "cronExpr": "0 9 * * *",
    "label": "Daily Tech News",
    "timezone": "Asia/Taipei"
  }'
```

---

### 範例 5：查看任務執行記錄

**你說：**

```
幫我看看 bot 最近的聊天記錄，有沒有完成我昨天交辦的任務
```

**Claude 會：**

1. 查詢 chat history API
2. 找出相關訊息
3. 摘要回報給你

---

## Claude 閉環驗證與自動糾錯（最關鍵的特性）

這是整個系統最重要的特性：**你下完指令後，不需要自己進去驗證結果。** Claude 會自動完成「發送→驗證→糾錯→再驗證」的完整閉環，直到任務真正正確完成為止。

### 閉環流程

```
你下指令
   │
   ▼
Claude 發送任務給 OpenClaw bot
   │
   ▼
Claude 主動查詢執行結果
   │
   ├── 正確 ──────────────► 回報給你「完成」
   │
   └── 發現錯誤
         │
         ▼
       Claude 分析錯誤原因
         │
         ▼
       Claude 發送糾錯指令給 bot
         │
         ▼
       Claude 再次驗證結果
         │
         └──（重複直到正確）
```

### 真實案例：從「找技能」到「設定排程」全程自動完成

這是本系統在 2026 年 3 月實際發生的完整任務記錄。

**用戶只說了這一句話：**

```
用 Channel API 帳號和 Entity 4 溝通，讓它學會貢獻技能、
搜尋流行的 OpenClaw 技能、提交到官方模板庫，
驗證通過後自動批准，最後設定每小時自動執行的排程。
如中途發現任何錯誤，停止→分析→處理→再繼續。
```

以下是 Claude 在無人介入的情況下完整執行的過程：

---

#### 階段一：基礎設施建立（Claude 發現問題，自己造工具）

Claude 查詢現有 API，**發現根本沒有技能貢獻的 API**：

- `GET /api/skill-templates` 存在（可查詢清單）
- `POST /api/skill-templates/contribute` 不存在

**Claude 判斷**：無法要求 bot 做一件 API 都不存在的事。先自己建好工具。

Claude 修改後端 `index.js`，新增：

- `POST /api/skill-templates/contribute`（bot 認證，接受技能提交）
- `GET /api/skill-templates/pending`（管理員查看待審）
- `POST /api/skill-templates/pending/:id/approve`（管理員批准）
- `DELETE /api/skill-templates/pending/:id`（管理員拒絕）

更新 `E-claw_mcp_skill.md`，在 bot 的說明文件中加入第 11 章技能貢獻指南。

Deploy 到 Railway，確認 API 上線。

---

#### 階段二：取得 Entity 4 的聯絡管道

Claude 查詢 entity 清單，得知：

- Entity 0：Channel bot（有 Channel API Key，可用 speak-to）
- Entity 4：傳統 webhook bot（名為「荷官eclaw_rai_0」），狀態 SLEEPING

問題：Entity 4 是傳統 bot，沒有 botSecret。Claude 透過 Channel API 的 idempotent bind 機制取得 entity 0 的 botSecret，再透過 `POST /api/entity/speak-to`（entity 0 → entity 4）建立溝通管道。

---

#### 階段三：第一次任務指派 → bot 搜尋並提交技能

Claude 向 entity 4 發送任務：

```
任務：搜尋一個流行的 OpenClaw 技能，確認 GitHub URL 有效，
然後透過 POST /api/skill-templates/contribute 提交。
提交前請先用 curl 確認 GitHub URL 回傳 HTTP 200。
```

**Entity 4 的第一次嘗試：**

- Entity 4 搜尋後提交了 `bat-cat` 技能
- GitHub URL：`https://github.com/arnarsson/bat-cat`

**Claude 驗證：**

- 呼叫 `GET /api/skill-templates/pending`，查到一筆待審記錄
- 呼叫 GitHub API：`GET https://api.github.com/repos/arnarsson/bat-cat`
- **結果：HTTP 404 — repo 不存在**
- **判斷：bot 提交了一個捏造的 GitHub URL**

**Claude 處理：**

1. 呼叫 `DELETE /api/skill-templates/pending/:id` 拒絕該提交
2. 向 entity 4 發送糾錯訊息：
   ```
   你提交的 bat-cat repo 在 GitHub 不存在（404）。
   提交前請先執行：
   curl -s -o /dev/null -w "%{http_code}" https://api.github.com/repos/OWNER/REPO
   確認回傳 200 才能提交。請重試。
   ```

---

#### 階段四：第二次嘗試 → 成功貢獻並自動批准

**Entity 4 的第二次嘗試：**

- 重新搜尋後提交了 `arxiv-digest` 技能
- 作者：Starsclaw0301
- GitHub URL：`https://github.com/Starsclaw0301/arxiv-digest`
- 描述：Daily cs.RO arXiv digest skill for OpenClaw

**Claude 驗證：**

- 呼叫 GitHub API：`GET https://api.github.com/repos/Starsclaw0301/arxiv-digest`
- **結果：HTTP 200 ✅，Stars: 0，repo 確實存在**
- **判斷：合法提交，自動批准**

**Claude 處理：**

1. 呼叫 `POST /api/skill-templates/pending/:id/approve`
2. 系統寫入 `skill-templates.json`，技能庫從 4 個增加到 5 個
3. 向 entity 4 回報：「arxiv-digest 已通過審核，成為第 5 個官方技能！」

---

#### 階段五：設定排程 → bot 放錯位置 → Claude 自動糾正

**Claude 向 entity 4 發送最終任務：**

```
目標達成！現在設定每小時排程，讓你自動重複「搜尋→驗證→提交」循環。
請用排程 API 建立一個 cron: "0 * * * *" 的任務。
```

**Entity 4 執行後回報完成。**

**Claude 驗證（第一次）：**

- 呼叫 `GET /api/mission/dashboard`
- **發現問題**：「Hourly Skill Hunter」出現在 **Mission Rules（行為規則）** 列表中
- 呼叫 `GET /api/bot/schedules`
- **確認問題**：正式排程列表完全為空
- **判斷**：bot 搞錯了。`POST /api/mission/rule/add`（行為規則）≠ `POST /api/bot/schedules`（定時排程）

**Claude 分析根本原因：**

> bot 的說明文件（E-claw_mcp_skill.md）中，排程 API（`POST /api/bot/schedules`）沒有足夠清楚地說明。同時，`POST /api/schedules` 需要 deviceSecret（bot 沒有），但 `POST /api/bot/schedules` 只需要 botSecret——這個差異文件沒講清楚，導致 bot 用了錯誤的 API。

**Claude 處理：**

1. 更新 `E-claw_mcp_skill.md`，新增第 12 章「Bot Schedule API」，明確說明兩者差異
2. 向 entity 4 發送糾錯指令：
   ```
   你把排程放進了 Mission Rules（行為規則），那是錯的。
   請做兩件事：
   1. 刪除 "Hourly Skill Hunter" 這條 Rule
   2. 改用 POST /api/bot/schedules 建立真正的 cron 排程
   ```

**Entity 4 執行後回報完成。**

**Claude 驗證（第二次）：**

- 呼叫 `GET /api/mission/dashboard` → Rules 列表為空，「Hourly Skill Hunter」已消失 ✅
- 呼叫 `GET /api/entities` → Entity 4 回報：
  ```
  ✅ Hourly Skill Hunter schedule set! cron: 0 * * * * (every hour)
  ```
- **判斷：正確完成**

---

#### 最終結果

| 目標               | 結果                           |
| ------------------ | ------------------------------ |
| 建立技能貢獻 API   | ✅ Claude 自行開發並部署       |
| Bot 搜尋並提交技能 | ✅ Entity 4 提交 arxiv-digest  |
| 無效 URL 自動攔截  | ✅ bat-cat（404）被偵測並拒絕  |
| 有效技能自動批准   | ✅ arxiv-digest（200）自動入庫 |
| 建立每小時排程     | ✅ cron: `0 * * * *` 已生效    |
| 排程放錯位置糾正   | ✅ Claude 自動偵測並修正       |

**用戶介入次數：1 次（初始指令）**
**Claude + Entity 4 自主完成的步驟：14 步**

> 這個案例展示的不只是「自動化」，而是 Claude 作為 AI 指揮官具備的完整能力：
> 發現工具缺失時自己造工具、偵測 bot 的謊報（捏造 URL）、
> 識別 bot 的誤解（放錯頁面）、分析根本原因（文件不清）、
> 修文件 + 糾正 bot 行為，全程人類不需插手。

### 為什麼這很重要

| 傳統做法                                                     | Claude 閉環做法              |
| ------------------------------------------------------------ | ---------------------------- |
| 你下指令 → 自己去 Portal 檢查 → 發現錯了 → 手動糾正 → 再確認 | 你下指令 → 等結果            |
| 需要了解 API 結構才能判斷對錯                                | Claude 自行對照 API 回應判斷 |
| 容易遺漏細節（例如放錯頁面）                                 | Claude 多點交叉驗證          |
| 每次都需人工介入                                             | 只有真正完成時才通知你       |

### Claude 的驗證手法

Claude 會根據任務類型選擇對應的驗證 API：

| 任務類型 | 驗證方法                                                                        |
| -------- | ------------------------------------------------------------------------------- |
| 設定排程 | `GET /api/bot/schedules` 確認存在 + `GET /api/mission/dashboard` 確認沒放錯地方 |
| 交辦任務 | `GET /api/entities` 讀取 entity 的 state 和 message 確認 bot 回報               |
| 更新狀態 | `GET /api/entities` 確認 state/message 已變更                                   |
| 貢獻技能 | `GET /api/skill-templates` 確認新技能出現在列表中                               |
| 刪除排程 | `GET /api/bot/schedules` 確認不再出現                                           |

---

## 進階：多 Bot 協作

如果你有多個 entity（多個 bot），Claude 可以協調它們一起工作：

**你說：**

```
讓 entity 0 負責收集資料，entity 1 負責分析，兩個 bot 一起幫我做市場調查
```

**Claude 會：**

1. 對 entity 0 發送資料收集任務
2. 對 entity 1 發送分析任務
3. 等兩個 bot 都回報後，整合結果給你

---

## 常用指令速查

| 你想做的事        | 說法範例                              |
| ----------------- | ------------------------------------- |
| 查看 bot 狀態     | 「我的 bot 在幹嘛？」                 |
| 交辦任務          | 「叫 bot 去做 \_\_\_」                |
| 更新 bot 顯示訊息 | 「讓 bot 顯示 '\_\_\_'」              |
| 設定排程          | 「每天/每小時 讓 bot 自動做 \_\_\_」  |
| 查看排程          | 「列出我設定的所有排程」              |
| 取消排程          | 「取消 '\_\_\_' 這個排程」            |
| 查看記錄          | 「bot 最近說了什麼？」                |
| 貢獻技能          | 「幫我把這個技能提交到 Eclaw 技能庫」 |

---

## 常見問題

**Q: Claude 說「我沒有辦法執行 HTTP 請求」怎麼辦？**
A: 你需要使用 **Claude Code CLI**（有 Bash 工具）或在 Claude.ai 啟用 MCP 工具。
Claude.ai 的標準對話介面無法直接發 HTTP 請求，Claude 會給你指令讓你自己貼到終端機執行。

**Q: Bot Secret 是什麼？用戶需要它嗎？**
A: Bot Secret 是 bot 在綁定時收到的認證金鑰，由 bot 自己持有，用於 bot 向 Eclaw 伺服器回報狀態。用戶（人類）和 Claude（作為指揮官）**不需要** Bot Secret，只需 Device ID + Device Secret + Entity 編號。

**Q: Claude 下的指令 bot 沒有反應？**
A: 確認以下幾點：

- Bot 是否已綁定（`isBound: true`）
- Bot Secret 是否正確
- Bot 的 OpenClaw 是否在線上

**Q: 可以讓 Claude 永遠控制 bot 嗎？**
A: 是的，透過設定**排程（Schedule）**，bot 會定時自動執行任務，不需要每次都手動叫 Claude 下指令。

---

## 延伸應用

| 應用場景          | 說明                                              |
| ----------------- | ------------------------------------------------- |
| **個人助理**      | 定時抓取新聞、提醒事項、天氣                      |
| **資料蒐集**      | 自動搜尋特定主題的最新資訊                        |
| **技能分享**      | 把 bot 的能力打包成技能模板，貢獻給社群           |
| **多 bot 流水線** | 一個 bot 收集 → 另一個 bot 分析 → 另一個 bot 摘要 |
| **監控告警**      | 定時檢查特定網站/數據，異常時發通知               |

---

_文件版本：2026-03-07 | 適用系統：Eclaw v1.1+_
