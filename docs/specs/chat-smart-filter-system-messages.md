# Chat Smart Filter — System Messages Enhancement

**Status**: draft (awaiting #1 sign-off — #6 GO with amendments 2026-06-01 19:16 TW, folded below)
**Author**: #2 (LOBSTER)
**Date**: 2026-06-01
**Related**: docs/specs/chat-send-to-spec.md, docs/specs/chip-ux-spec.md
**Cards**: card_d9f090c474ef6e7210f7361a

---

## Problem

`portal/chat.html` 目前的 filter chips 只有 **All / per-Entity / per-Contact / My Messages**。沒有任何維度可以把「系統訊息」（kanban 督促、monitor healthcheck、scheduled、handshake 等）跟真實對話分離。

實測 chat_messages 中系統訊息佔比顯著（依 `/api/chat/history` 採樣 2000 筆，最近一段 deviceId=480def4c 數據）:

| 類型 | 估佔比 | 痛點 |
|---|---|---|
| 真實對話 (web_chat + bot-to-bot routed) | ~70% | 對話被淹沒 |
| kanban_notify (含督促) | ~20% | 督促雜訊高，但偶爾要回看 |
| monitor-healthcheck / modelcheck | ~5% | 純 debug 用，平日無關 |
| codex-*, target-mode, handshake | ~3% | 工程性事件，多數時候是雜訊 |
| platform / reopen / invite_redeem / scheduled | ~2% | 少量但相關 |

使用者主訴: 想要在 chat 看真實對話時，能一鍵隱藏 monitor/handshake 等噪音，但仍可隨時切回看 kanban 督促或 system event。

---

## System Message Type Inventory

`chat_messages.source` 欄位實際出現的值，依語義分群：

### A. 對話 (Conversation) — 預設 ON

| Source pattern | 來源 | 範例 |
|---|---|---|
| `web_chat` | Hank 在 fakechat UI 輸入 | "你好" |
| `client` | `/api/client/speak` 外部 user 輸入 | 公開頻道訊息 |
| `entity:N:LABEL->M` | bot-to-bot 路由 (speakTo 單體) | #2 → #6 review request |
| `entity:N:LABEL->M,K,...` | bot-to-bot 多目標路由 | broadcast 子集 |
| `xdevice:*` | 跨裝置對話 (#6 補充 2026-06-01) | xdevice:tbwb9e->3xa3h4 |
| `android_chat`, `android_widget`, `widget` | App / widget 入口 (#6 補充) | mobile App 送出 |
| `form_submission` | 表單入口 (#6 補充) | landing page submit |
| `bot`, `Entity N`, 任意 `entity.name` / `fromLabel` legacy 字串 | 歷史 bot reply source (#6 補充) | 舊資料 |
| `Mac_ClaudeAce主管` (legacy 中文 label) | 歷史 entity-label 格式 | 舊資料 |

### B. 任務系統 (Tasks / Kanban) — 預設 ON

| Source pattern | 來源 | 範例 |
|---|---|---|
| `kanban_notify` | `backend/kanban.js:427` notifyEntities() | 「新卡分配」「狀態變更」「督促提醒」「review 通知」「stale 警告」 |
| `kanban_notify:N,M,...` | 同上但有 target list 後綴 | 多 bot 分派 |
| `mission_notify` / `mission_notify:N,M` | mission/task chain 通知 (注意 exact 或 `:`-prefix; 不能 prefix 比對 `mission_notifyfoo`) | task 完成廣播 |
| `reopen` | 卡片 reopen 事件 (`kanban.js:2076`) | review 退回 |
| `kanban_comments`, `kanban_pending_notify` | 若 helper 被複用於 chat-history 之外 (#6 補充) | 卡片留言廣播 |

### C. 健康監控 (System Health) — 預設 OFF（debug 才打開）

| Source pattern | 來源 |
|---|---|
| `monitor-healthcheck-N` | 每 entity 健康巡查 cron |
| `monitor-modelcheck-N` | 模型版本檢查 cron |
| `manual-steps123-healthcheck-N` | 手動 healthcheck 變體 |
| `healthcheck` | 通用 healthcheck |
| `rental_health_system` | rental health ping (`chat.html:3857`) |

### D. 工程事件 (Platform / Auth Events) — 預設 OFF

| Source pattern | 來源 |
|---|---|
| `platform` | 系統指令回覆 (`index.js:11194`) |
| `SYSTEM` (大寫，case-insensitive 比對) | 舊系統訊息 source (#6 補充) |
| `admin_secret_notify` | admin secret 變更通知 (#6 補充) |
| `bind_handshake` | 裝置 bind 握手 |
| `bot_register` / `bot_register_handshake` | 機器人註冊 |
| `invite_redeem` | 邀請碼使用 (`chat.html:3188`) |
| `codex-*-N` | #6 (Codex) handshake / ack 變體 |
| `target-mode-N` / `target_mode` | brain target-mode pings |

### E. 排程 (Scheduled) — 預設 ON

| Source pattern | 來源 |
|---|---|
| `scheduled` | scheduled-messages.js |

---

## Categorization Rule (canonical mapping)

實作於 `backend/public/portal/shared/chat-source-category.js` (新檔):

```js
// Canonical: take the message, not just source. Falls back to is_from_user/bot flag
// for legacy rows where source is unreliable (#6 amendment 2026-06-01).
//
// Returns one of: 'conversation' | 'kanban' | 'health' | 'platform' | 'scheduled' | 'unknown'
function categorizeChatMessage(msg) {
    const raw = (msg && msg.source) || '';
    const s = String(raw).trim();
    const sLower = s.toLowerCase();

    if (!s) {
        // null/empty source — fall back to message flags
        if (msg && (msg.is_from_user || msg.is_from_bot)) return 'conversation';
        return 'unknown';
    }

    // Explicit conversation sources
    if (s === 'web_chat' || s === 'client' ||
        s === 'android_chat' || s === 'android_widget' || s === 'widget' ||
        s === 'form_submission' || s === 'bot') return 'conversation';
    if (s.startsWith('entity:') || s.startsWith('xdevice:')) return 'conversation';

    // Kanban / mission — EXACT or `:`-prefix only (avoid `mission_notifyfoo` false positive)
    if (s === 'kanban_notify' || s.startsWith('kanban_notify:')) return 'kanban';
    if (s === 'mission_notify' || s.startsWith('mission_notify:')) return 'kanban';
    if (s === 'reopen' || s === 'kanban_comments' || s === 'kanban_pending_notify') return 'kanban';

    // Health monitors
    if (s.startsWith('monitor-healthcheck') ||
        s.startsWith('monitor-modelcheck') ||
        s.startsWith('manual-steps') ||
        s === 'healthcheck' ||
        s === 'rental_health_system') return 'health';

    // Platform / auth events (case-insensitive for SYSTEM legacy)
    if (sLower === 'platform' || sLower === 'system' ||
        s === 'admin_secret_notify' ||
        s.startsWith('bind_') ||
        s.startsWith('bot_register') ||
        s === 'invite_redeem' ||
        s.startsWith('codex-') ||
        s.startsWith('target-mode') ||
        s === 'target_mode') return 'platform';

    if (s === 'scheduled') return 'scheduled';

    // Legacy bot/entity-name reply rows: 中文管理員 label or arbitrary Entity-name.
    // Trust message flags as last-resort signal of "this is dialog, not system".
    if (msg && (msg.is_from_user || msg.is_from_bot)) return 'conversation';
    // Legacy 中文 label pattern fallback
    if (/^[A-Za-z_一-鿿]+主管?$/.test(s)) return 'conversation';

    return 'unknown';
}

// Back-compat shim if a caller only has the source string
function categorizeChatSource(source) {
    return categorizeChatMessage({ source });
}
```

**Key contract** (#6 amendment 2026-06-01):
- Wrapper takes message, not source — so flag fallback works for legacy bot rows
- `source.trim()` normalized before any match
- `platform`/`SYSTEM` matched case-insensitively
- `mission_notify` / `kanban_notify` only exact or `:`-prefix — NOT broad prefix (avoid `mission_notifyfoo` false positive)
- `unknown` returned only as last resort; UI MUST show unknown by default (regression-safe)

---

## UI Spec

### Filter Chip 擴增

`portal/chat.html` line 2863 `#filterChips` 旁邊加 **toggle group** (與現有 entity/contact chips 平行):

```html
<div class="chip-group" id="filterChips">
    <button class="filter-chip active" data-filter="all">All</button>
    <button class="filter-chip" data-filter="my">My Messages</button>
    <!-- existing entity/contact chips injected here -->
</div>

<div class="chip-group chip-group-system" id="systemFilterChips">
    <!-- new — system message category toggles -->
    <button class="sys-chip active"  data-syscat="conversation" data-i18n="chat_sys_conversation">💬 對話</button>
    <button class="sys-chip active"  data-syscat="kanban"       data-i18n="chat_sys_kanban">📋 看板</button>
    <button class="sys-chip active"  data-syscat="scheduled"    data-i18n="chat_sys_scheduled">⏰ 排程</button>
    <button class="sys-chip"         data-syscat="platform"     data-i18n="chat_sys_platform">🔧 系統</button>
    <button class="sys-chip"         data-syscat="health"       data-i18n="chat_sys_health">❤️ 健康</button>
</div>
```

**行為**:
- 5 個 sys-chip 各自 toggle (multi-select)，多選 OR (任一 active 即顯示)
- 預設 active: `conversation`, `kanban`, `scheduled`
- 預設 inactive: `platform`, `health`
- `getFilteredMessages()` 先跑現有 entity/my/all/xdevice filter，再用 sys-chip 集合做第二層過濾
- 偏好持久化到 `localStorage['chatSysFilter']` (per device)
- mobile 390x844: chip group wrap 成第二排，不擠壓 input bar

### Empty state

當所有 sys-chip 都 off → 顯示 hint: 「目前所有系統訊息類別都已隱藏。點 chip 重新顯示」（data-i18n: `chat_sys_all_hidden`）。

### "Show all hidden" 提示

當有 ≥10 條訊息被 sys-filter 隱藏時，chat 底部出現 banner: 「N 條系統訊息已隱藏 — 顯示」(data-i18n: `chat_sys_n_hidden`)。點擊 = 暫時 enable 所有 sys-chip。

---

## Implementation Plan

### Phase 1 — Backend (no schema change needed)
- 新檔 `backend/public/portal/shared/chat-source-category.js` 匯出 `categorizeChatSource()`
- chat.html 引入該檔
- (不動 backend schema — source 欄位本來就存)

### Phase 2 — Frontend
- chat.html 加 #systemFilterChips DOM + CSS
- 修改 `getFilteredMessages()` — sys-cat 過濾要**在** `withRentalHealthSystemMessages(...)` **之後**才套用 (#6 amendment 2026-06-01)，否則 rental_health_system 是合成後加入會 bypass filter
- 加 `applySystemFilters(messages)` helper
- localStorage key: `eclaw.chatSysFilter.v1:${deviceId}` (per-device, 不是 browser-wide) (#6 amendment)
- "N hidden" banner — empty-state 文案需顧及「unknown 仍 show」的情況：當所有 chip off 但仍有 unknown 訊息時，提示「N 條未分類訊息仍顯示中」(#6 amendment)
- Deep-link reveal: 若 linked message 被 cat-filter 隱藏 → auto-enable 該 category，或顯示「被 filter 隱藏 — 點此顯示」reveal action (#6 amendment)
- i18n key 加: `chat_sys_conversation`, `chat_sys_kanban`, `chat_sys_scheduled`, `chat_sys_platform`, `chat_sys_health`, `chat_sys_all_hidden`, `chat_sys_n_hidden`, `chat_sys_link_hidden_reveal`, `chat_sys_unknown_shown` (en + zh, per memory feedback_check_i18n_fallback_before_emergency)

### Phase 3 — Tests + E2E
- jest: `tests/jest/chat-source-category.test.js` table-driven coverage (#6 amendment):
  - 每個 inventory 中的 source pattern 斷言 category (含 #6 補的 xdevice:*, android_chat, widget, form_submission, bot, SYSTEM 大寫, admin_secret_notify, kanban_comments, kanban_pending_notify)
  - null/empty source → flag fallback test
  - `unknown` for truly unrecognized source
  - **False-positive guards**: `mission_notifyfoo`, `kanban_notifybar`, `monitor-healthcheck` 後面接奇怪字串 — 確保 prefix 比對不誤判
  - `source.trim()` 邊界 ('  web_chat  ' → conversation)
  - case-insensitive: `SYSTEM` / `system` / `System` 都歸 platform
  - flag fallback: source 是 legacy 中文 label 但 is_from_bot=true → conversation
- 靜態測試 (#6 amendment): chat.html 必須先載入 `chat-source-category.js` 才用 (script order); `#systemFilterChips` 預設 active state 對應 spec 預設值
- Playwright E2E: 開 chat 確認 5 chip 出現、預設狀態正確、toggle 後即時 filter、reload 後狀態保留、deep-link 到被 filter 隱藏的 msg 會 auto-reveal
- 跑 mobile 390x844 + desktop 1280x800 截圖

### Phase 4 — Docs
- 更新 docs/specs/chat-send-to-spec.md 加 cross-ref
- 更新 user-facing help icon (per spec-help-icon initiative): `chat_sys_filter_help`

---

## Acceptance

- [ ] `backend/public/portal/shared/chat-source-category.js` 含 `categorizeChatSource()`，jest 覆蓋全部 inventory pattern
- [ ] chat.html #systemFilterChips 渲染 5 個 chip，預設 conversation/kanban/scheduled ON，platform/health OFF
- [ ] toggle 任一 chip 即時更新訊息列表 (no full reload)
- [ ] reload chat 後 sys-filter 狀態還原 (localStorage)
- [ ] mobile 390x844 + desktop 1280x800 都不擠壓 input bar，chip wrap 正常
- [ ] i18n: en + zh 都有 7 個新 key
- [ ] "N hidden" banner 在 ≥10 條被隱藏時出現
- [ ] PR 含 mobile + desktop 截圖 (per feedback_personal_screenshot_review)
- [ ] check-settings-help-invariant pass (per spec-first chain)
- [ ] #1 + #6 sign-off on this spec before any code lands

---

## Open Questions for #1 / #6

1. **預設分類**: conversation/kanban/scheduled ON、platform/health OFF — 同意嗎？
2. **`unknown` category**: 遇到未知 source 字串時要 show 還是 hide？目前提案 show (regression-safe)。
3. **persistence scope**: localStorage per device 還是 sync 到 device-vars 跨裝置？目前提案 localStorage (簡化 v1)。
4. **multi-select OR vs AND**: 5 chip 任一 active 就顯示 = OR；要不要支援 "只看 kanban + 隱藏其他" 這種 exclusive 模式？目前提案 OR + single chip click 行為（點不變、shift+click = 排他）— 但 v1 可省略 shift+click 功能。
5. **bot-to-bot 是否獨立分類**: 現方案放 conversation；要不要拆出 `bot-to-bot` 子類？目前提案不拆 (per-entity chip 已可以)。

---

## Non-goals (v1)

- 不做 source-level granular filter (e.g. 只看 kanban_notify 但不看 mission_notify) — 一律走 category 層
- 不做時間/keyword 搜尋（已有 search 框，不在本卡 scope）
- 不改 source 寫入端 (backend 不動)
- 不改 chat_messages schema
