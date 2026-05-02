# 看板卡片狀態 / Kanban Card Status

> Single source of truth: [`backend/public/shared/kanban-status.js`](../../backend/public/shared/kanban-status.js)

## 動機 / Why this spec exists

2026-04-28 之前，看板狀態 (status) 是手抄重複定義在 6 個地方：

1. `backend/kanban.js` 的 `STATUSES` 常量
2. `backend/public/portal/kanban.html` 的欄位 (`<div class="kb-column" data-status>` + `STATUSES` JS const)
3. `backend/public/portal/chat.html` 的看板預覽 `statusOrder`
4. `backend/i18n/kanban-notifications.js` 各語系 `statusLabels`
5. `backend/public/shared/i18n.js` `kb_col_*` 與 `kanban_status_*` 鍵
6. `backend/device-preferences.js` 的 `NUDGE_STATUS_OPTIONS` 督促白名單

它們飄移後出現實際 bug：`card_c043100f5b43e7711fef05cc` 設成 `blocked`，但 `kanban.html` 沒有 `blocked` 欄 → 卡片在 UI 上完全消失。

本規範統一所有狀態 enum 到單一檔案，並列出新增狀態時必須同步動到的所有點。

---

## 規範狀態 (Canonical Statuses)

```
['backlog', 'todo', 'in_progress', 'review', 'done', 'blocked']
```

| Status | 中文 | Emoji | 督促 (nudgeable) | 預設督促 |
|---|---|---|---|---|
| `backlog` | 待排程 | 📦 | ✅ | ❌ |
| `todo` | 待辦 | 📋 | ✅ | ✅ |
| `in_progress` | 進行中 | 🔄 | ✅ | ✅ |
| `review` | 審核中 | 👀 | ✅ | ✅ |
| `done` | 完成 | ✅ | ❌（已完成不應督促） | ❌ |
| `blocked` | 已封鎖 | 🚫 | ✅ | ❌ |

### 優先排序 (Priority Order — for kanban list views)

```
in_progress < review < todo < backlog < blocked < done
```

含意：使用者進入看板時看到「進行中」的卡片在最上面，「已封鎖」往下沉但**不**沉到「完成」之後（因為 blocked 仍是活躍工作）。

---

## 必須改動點清單 (When adding a new status)

新增 status 時**必須**同步以下檔案；缺一即會出現「狀態存在但 UI 看不見」的歷史 bug 重演：

### 1. SoT 模組（先動）
- `backend/public/shared/kanban-status.js`：
  - `STATUSES` 加新值
  - `STATUS_I18N_KEYS` 加 `<status>: 'kb_col_<status>'`
  - `STATUS_LABELS_EN` 加英文 label
  - `STATUS_EMOJI` 加 emoji
  - `PRIORITY_ORDER` 排定優先序
  - `NUDGEABLE_STATUSES` 決定是否可督促
  - `NUDGE_DEFAULT_STATUSES` 決定是否預設督促

### 2. 後端
- `backend/kanban_schema.sql` 第 13 行 status 欄註解（純註解，但必須含新狀態名）

### 3. 前端 UI
- `backend/public/portal/kanban.html`：
  - desktop column (`<div class="kb-column" data-status="<status>">`)
  - mobile tab (`<button class="kb-mobile-tab" data-status="<status>">`)
  - CSS 顏色 row（`.kb-column[data-status="<status>"] .kb-col-title { color: ... }` + `::before { background: ... }`）

### 4. 督促 / 設定
- `backend/public/portal/settings.html` 督促 chip row（如果新狀態應該可督促，加一條 `<label class="nudge-status-chip">`）

### 5. i18n
- `backend/public/shared/i18n.js`：每個語系的 `kb_col_<status>`、有 `kanban_status_*` 系列的也要補
- `backend/i18n/kanban-notifications.js`：每個語系 `statusLabels.<status>`

### 6. 規範書
- 本檔案表格更新

---

## 「狀態隱藏」反模式 (Anti-pattern guard)

以下情況**禁止**：

- 在 `chat.html`、`info.html` 或任何頁面定義不存在於 SoT `STATUSES` 的「幻影狀態」（歷史曾出現 `doing` — 已於 PR #2202 移除）
- 在某個檔案加新 status 卻不動 SoT
- 把 `done` 加進 `NUDGEABLE_STATUSES`（已完成的卡不應再被督促）
- 後端 enum 比前端 enum 多（會出現「卡片狀態合法但 UI 沒對應欄」）

### 落地檢查 (Lint-style)

新增/修改 status 後務必：

```bash
node -e "const KS=require('./backend/public/shared/kanban-status.js'); console.log(KS.STATUSES);"
grep -rn "data-status=\"" backend/public/portal/ | sort -u  # 比對 UI 欄位齊備
grep -nE "statusLabels: \{" backend/i18n/kanban-notifications.js  # 比對通知翻譯
```

---

## 歷史變更 (Changelog)

- **2026-04-28** — 引入本規範與 `kanban-status.js` SoT；補上 `blocked` 在 `kanban.html` / `chat.html` / `settings.html` / `i18n.js` 缺漏；移除 `chat.html` 幻影 `doing` 狀態。Umbrella card_42526620af35fb0b27edb2a2，PR #2202 / #2203 / #2204。

---

## 相關規範

- 督促 (nudge) 流程細節：尚未獨立規範，目前散落在 `kanban.js` `processDeviceStaleCards` 與 `device-preferences.js`
- 自動結案截圖閘 (screenshot-gate)：`reference_card_evidence_pipeline.md`（Claude 記憶）
