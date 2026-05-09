# 聊天頁面 Send to 規格書

> 整併自 `android-uiux-rendering-spec.md`、`agent-message-rendering-spec.md`、`guide-mention-tagging.md`、`2026-04-12-brm-uiux-rendering-spec.md`、`2026-03-07-channel-bot-context-parity-design.md`。
> 本文件為三平台（Web Portal / Android / iOS）聊天頁面「Send to（傳送對象）」的單一事實來源（SoT）。
> 涵蓋：UI 佈局、目標選擇規則、API 對應、@mention 互動、跨裝置與租借 bot 行為、渲染規則。

**Status**: Active — last updated 2026-05-09
**Related code**: `backend/index.js`、`backend/mention-parser.js`、`backend/public/portal/chat.html`、`app/.../ChatActivity.kt`

---

## 1. 概念與術語

| 名詞 | 定義 |
|------|------|
| **Send to（傳送對象）** | 使用者在聊天輸入框送出訊息時，要把訊息推給哪幾個 entity 的決策。 |
| **Send-to 按鈕** | 輸入框旁的按鈕（`Send to ▾`）。按下展開 entity 選單；點選某 entity 會把 `<@xxxxxx>` token **插入到聊天輸入框文字**（在當前 caret 位置）。**不維護獨立的目標狀態**。 |
| **`@mention`（路由真相）** | 訊息文字中的 `<@xxxxxx>` / `@xxxxxx` / `<@N>` / `@all` 標記。**唯一的路由事實來源**：訊息送出時，所有被 mention 的 entity 自動成為 speak-to 目標。 |
| **`speakTo`** | bot-to-bot API 中指定收件 entity 的欄位（陣列，元素為 6 字元 publicCode）。 |
| **`broadcast`** | 一對多廣播，送給此裝置上所有已綁定 entity；由 `@all` 觸發。 |
| **Cross-device speak-to** | 透過 publicCode 把訊息送到「其他裝置」的 entity。 |

---

## 2. UI 佈局（三平台一致）

### 2.1 Android / Web Portal

```
┌────────────────────────────────────────────────┐
│  ← Chat                              [15 sent] │
│  [All] [🦞Mac_B (#0)] [🦊Mac_F (#1)] [...] ▼  │ ← Filter chips（僅瀏覽過濾）
├────────────────────────────────────────────────┤
│  (訊息滾動區)                                   │
├────────────────────────────────────────────────┤
│  [Send to ▾] [+] [🎤] [ <@bbbbbb> Hi   ]  [Send]│ ← Send-to 按鈕 + 輸入框
└────────────────────────────────────────────────┘

按下 [Send to ▾] 後展開選單：

┌────────────────────────────────────────┐
│ 📢 Broadcast to all entities    [@all] │
├────────────────────────────────────────┤
│ 🦞 Mac_B (#0)              #aaaaaa     │
│ 🦊 Mac_F (#1)              #bbbbbb     │
│ 🌐 Alice (cross-device)    #dddddd  🔗 │
│ 🔒 Coding Wizard (rented)  #eeeeee     │
└────────────────────────────────────────┘
       ↓ 點選一項
輸入框自動於 caret 位置插入 `<@bbbbbb> `
```

### 2.2 元件規範

| 元件 | 規範 |
|------|------|
| **Filter chips** | `HorizontalScrollView` + `ChipGroup`；只負責訊息歷史過濾，**完全不影響傳送對象**。 |
| **Send to 按鈕** | 單一按鈕（標籤 `Send to ▾` / `傳送至 ▾`）。按下開啟選單；點選 entity 後把 `<@xxxxxx> ` token 插入輸入框 caret 位置（含尾隨空格）。**按鈕本身不維護任何狀態**。 |
| **選單內容** | 第一項固定為「📢 Broadcast to all（@all）」；接下來依序為：本裝置綁定 entity → Card Holder 已收藏聯絡人（含跨裝置）→ 租借 bot。 |
| **跨裝置 entity** | 在選單中帶 🔗 link badge；點選後插入該 entity 的 publicCode。 |
| **租借 bot** | 在選單中帶 🔒 標記；點選後插入後在送出時走 rental-proxy 計費路徑。 |
| **`@all` 點選** | 跳出確認 modal「Broadcast to all entities?」→ 確認後插入字面字串 `@all `。 |
| **輸入框 chip 渲染** | 已輸入的 `<@xxxxxx>` token 在輸入框中即時渲染為可點選的彩色 chip（可整體刪除）。 |

### 2.3 互動細節

- **Send 按鈕 enable 條件**：訊息文字非空（含至少一個有效 mention 或純文字）。
- **無 mention 時**：訊息送出後，後端視為「對 filter chips 當前選中的 entity」發送（沿用 chat 上下文），或 fallback 到 entity 0。⚠️ 若 filter 為「All」且無 mention → Send 按鈕 disabled，提示使用者「請使用 Send to 選擇收件對象或輸入 @mention」。
- **重複 mention 去重**：輸入框中相同 publicCode 多次 mention，後端只 speak-to 一次。
- **不再持久化勾選狀態**：每則訊息獨立判斷路由（避免「上次選了忘記取消」造成誤送）。
- **快捷鍵**：直接在輸入框打 `@` 也會開啟同樣的下拉選單（與 Send to 按鈕共用 component）。

---

## 3. 路由規則（核心）

### 3.1 使用者送訊的真相來源（v2，2026-05-09 起）

**訊息文字中的 `@mention` 是路由的唯一真相來源。** Send to 按鈕僅是把 token 插入文字的捷徑；按下按鈕本身不會建立任何隱性目標狀態。

| 訊息文字中的 mention | 送出時的後端 API |
|---------------------|------------------|
| 含一個 `<@xxxxxx>`（同裝置 publicCode 或 `<@N>`） | `POST /api/client/speak` with `entityId: N` |
| 含多個 mention | `POST /api/client/speak` with `entityId: [N, M, ...]`（去重後） |
| 含 `@all` | `POST /api/client/speak` with `broadcast: true` |
| 含跨裝置 publicCode（解析為 `isCrossDevice: true`） | `POST /api/client/cross-speak`（前端分流，每個 remote code 一筆） |
| 完全無 mention | 沿用 filter chips 當前選中的 entity 為 fallback；若 filter 為 All → Send 按鈕 disabled |

### 3.2 Bot 送訊的真相來源（與 user 端統一）

| 來源 | 行為 |
|------|------|
| **User → Bot**（chat input） | `@mention` 為路由真相（與 bot 端對稱）。 |
| **Bot → Bot**（`/api/transform`） | 若 message 含 `<@xxxxxx>` 而 **未** 提供 `speakTo` → 後端自動填入 `speakTo: ["xxxxxx"]`。若 bot 顯式提供 `speakTo` 或 `broadcast`，顯式值優先（覆寫 mention auto-fill）。 |

> 設計原則變更（v2）：v1 採「user 端有 UI 故 mention 是 hint」的不對稱設計，但實作（`chat.html` MentionResolver）已 auto-add mention 為 target。v2 將文字 mention 統一為兩端的路由真相，移除 hint-only 與不對稱描述。

---

## 4. API 對應

### 4.1 `POST /api/client/speak` — User → Entity

```json
{
  "deviceId": "...",
  "deviceSecret": "...",
  "entityId": 0,                   // 或 [0, 1, 2]
  "broadcast": false,              // 勾「All」時為 true
  "text": "<@bbbbbb> 幫我問 TSMC",
  "source": "web_chat"             // web_chat / android_chat / widget / my_app
}
```

**Response**：
```json
{
  "success": true,
  "targets": [{ "entityId": 0, "pushed": true, "mode": "push" }],
  "broadcast": false,
  "mentions": {
    "hasAll": false,
    "mentions": [
      { "publicCode": "bbbbbb", "name": "Bob", "isCrossDevice": false }
    ]
  }
}
```

> `targets` 只列出實際送出的 entity（=Target bar 勾選的）。`mentions` 內的 entity **不會**被加進送達清單。

### 4.2 `POST /api/transform` — Entity → Entity（含跨裝置）

```json
{
  "deviceId": "...",
  "entityId": 0,
  "botSecret": "...",
  "state": "IDLE",
  "message": "<@bbbbbb> 這是分析結果",
  "speakTo": ["bbbbbb"],          // 顯式（bot-to-bot 真相），可選
  "broadcast": false,             // 一對多
  "targetDeviceId": "..."         // 跨裝置時填入；不填則同裝置
}
```

**後端決策順序**：
1. 若 `speakTo` 或 `broadcast` 顯式提供 → 直接採用。
2. 否則解析 `message` 中的 `<@xxxxxx>` → auto-fill `speakTo`。
3. 否則回覆原始發送方（auto-route）。

### 4.3 `POST /api/client/cross-speak` — User → 跨裝置 Entity

由前端在使用者勾選 Card Holder 跨裝置聯絡人時自動分流呼叫；payload 帶 `targetPublicCode`。

### 4.4 已棄用的端點

`/api/entity/speak-to`、`/api/entity/broadcast`、`/api/entity/cross-speak` 仍可運作但會回傳 deprecation warning，新功能應一律走 `/api/transform`。

> 解決衝突 **C3**：本文件取代 `agent-message-rendering-spec.md` §3.1 的端點清單（該段未標 deprecation）。以本節為 SoT。

---

## 5. @mention 互動規格

### 5.1 Token 格式（`backend/mention-parser.js` 的權威定義）

| Token | 場合 | 備註 |
|-------|------|------|
| `<@xxxxxx>` | 訊息文字內 | `xxxxxx` 為 6 字元 publicCode（`a-z0-9`）。輸入框 autocomplete 插入此格式。 |
| `@xxxxxx` | 訊息文字內 | Bare publicCode。Word-boundary lookbehind 排除 `user@gmail.com` 等 email-like。 |
| `<@N>` / `@#N` / `@N` | 訊息文字內 | 同裝置 entityId（1-3 位數）。 |
| `@all` | 訊息文字內 | Word-boundary、case-insensitive。觸發 broadcast hint。 |

### 5.2 自動完成下拉

```
┌────────────────────────────────────────┐
│ 📢 Broadcast to all entities    [@all] │  ← 永遠第一筆
├────────────────────────────────────────┤
│ 🤖 Main Assistant         #aaaaaa      │
│ 🦞 Stock Analyst          #bbbbbb      │
│ 🌐 Alice (cross-device)   #dddddd  🔗  │  ← 綠色 link badge
└────────────────────────────────────────┘
```

- 觸發：在 word boundary 輸入 `@`。
- 模糊比對：prefix / substring / subsequence 三段。
- 鍵盤：`↑↓` 導航、`Enter`/`Tab` 確認、`Esc` 關閉、`@all` 跳確認 modal。
- IME 安全：CJK 組字過程不會誤觸。

### 5.3 接收 bot 收到的 hint

對 channel-bound bot 推送 payload：
```json
{
  "event": "message",
  "from": "web_chat",
  "text": "<@bbbbbb> ask about TSMC",
  "eclaw_context": {
    "mentions": [{ "publicCode": "bbbbbb", "name": "Stock Analyst", "isCrossDevice": false }],
    "hasAll": false
  }
}
```

對 webhook bot 則於 `pushMsg` 文字尾端附加可被 LLM 解析的 `[MENTIONS]` 區塊。

---

## 6. 訊息渲染規則

### 6.1 Bubble 對齊與樣式

| 訊息類型 | 對齊 | 來源條件 |
|----------|------|----------|
| **Sent**（自己送出） | 右 | `is_from_user=true` 且 **非** cross-device incoming |
| **Received**（bot 回覆） | 左 | `is_from_bot=true` |
| **Cross-device incoming** | 左 | `is_from_user=true` 但 source 為 `xdevice:...` 形式 |
| **Platform** | 置中 | `source === 'platform'` |

> ⚠️ 關鍵規則：`is_from_user=true` 不等於「本裝置送出」——跨裝置傳入訊息也是 `is_from_user=true` 但須靠左渲染。整合驗證請使用 `isIncomingCrossDevice(msg)` helper。

### 6.2 Source label 對應

實際後端產出格式為 `entity:${fromId}:${entity.character}`（`backend/index.js:6725`）。`{char}` 即 `entities.character` 欄位內容（可能是 emoji `🦞` 或字符常數 `LOBSTER`，視 entity 建立來源而定）。前端 label 渲染時依 character 反查對應 emoji + 顯示名。

| Source pattern | 渲染 label |
|----------------|-----------|
| `web_chat` / `android_chat` / `widget` | `You → 🦞 Mac_B · Web/Android/Widget` |
| `entity:0:🦞`（或 `entity:0:LOBSTER`） | `🦞 Mac_B → You` |
| `entity:0:🦞->1,2` | `🦞 Mac_B → Sent to Mac_F ✓ Lobster ✗`（多 target 分列，含送達狀態） |
| `entity:0:🦞->broadcast` | `🦞 Mac_B → Broadcast` |
| `xdevice:ABC123:🦞->XYZ456` | `🔗 You → Entity(XYZ456)` 或 `🔗 Sender(ABC123) → Entity` |
| `scheduled` | `📅 Schedule: {label} → Entity` |
| `mission_notify` | `🎯 Mission Control` |
| `kanban_notify` | `📋 系統通知` |

> 解決衝突 **C5**：源字串中 `{char}` 由後端取自 `entity.character`，可能為 emoji 或常數名稱，皆為合法。前端渲染應 tolerate 兩種格式。

### 6.3 Broadcast 分組

同 sender + 5 秒內 + 相同內容 → 合併成一個 bubble，顯示「Sent to A B C」並列出每個 target 的送達狀態（✓ / ✗）。

### 6.4 同上級轉發（org chart 自動轉發）

```
🐶 Mac_E (#3) → 發送至 🦸 主管 (#2)
```
- 不參與 broadcast 合併。
- 來源類型：`Transform speakTo`（`index.js`）。

---

## 7. 跨裝置送訊（Cross-device speak-to）

### 7.1 觸發路徑

1. Card Holder 勾選遠端裝置的 entity 聯絡人 → 加入 Target bar。
2. 訊息文字內 `<@xxxxxx>` 解析到 `isCrossDevice=true` 的 publicCode。
3. Bot 送 `/api/transform` 帶 `targetDeviceId` 與 `speakTo`。

### 7.2 渲染差異

- Source 前綴 🔗（綠色 link badge）。
- Source 格式：`xdevice:{myCode}:{myChar}->{remoteCode}`。
- 同裝置多 entity → 合併分組；跨裝置 **不合併**，每個 entity 各自一條訊息。

### 7.3 Auto-route 回覆

接收方裝置的 bot 回覆 `/api/transform` 時，後端會自動將回覆路由回原始發送裝置（不需要 bot 自行指定 `targetDeviceId`）。

---

## 8. 租借 bot（BRM）特殊規則

對應 `2026-04-12-brm-uiux-rendering-spec.md` DD#15：

| 操作 | 是否允許 |
|------|---------|
| 自有 bot → 租借 bot（同 device） speakTo | ✅ 經 rental-proxy 計量 |
| 租借 bot 接收 speakTo | ✅ |
| 租借 bot 送 broadcast | ✅ |
| 租借 bot 出現在 kanban `assigned_bots` | ✅ |
| 租借 bot 改名 / 刪除 / 改 identity | ❌ |
| 租借 bot 跨裝置 speakTo 到擁有者其他裝置 | ❌ |
| 租借 bot 出現在預設 target chips | ❌（需透過 @mention 指定） |

Target chip 帶 🔒 標記，bubble 左側顯示來源 bot avatar + 名稱 + 計量提示。

---

## 9. 安全限制

| 風險 | 處理 |
|------|------|
| `@mention` token 包裹敏感字（如 `botSecret`）規避 Gatekeeper | `stripMentionTokens()` 在敏感詞偵測前執行 |
| 跨裝置 `@` 給已封鎖的對象 | `db.isBlocked()` 檢查；blocked mention 標記 `blocked:true` 並警告 |
| 未知 publicCode | 進入 `unresolved` 陣列，不報錯 |
| Token 格式注入 | Regex 嚴格限定 `[a-z0-9]{6}` |
| 配額 | mention 本身不耗配額；轉發走 `/api/transform` 才計（5 訊息 / 30 分 / pair） |

---

## 10. 鍵盤快捷鍵（Web Portal）

| 鍵 | 動作 |
|----|------|
| `@`（word boundary） | 開啟自動完成 |
| `↑` / `↓` | 導航候選 |
| `Enter` / `Tab` | 確認選取 |
| `Esc` | 關閉下拉 |
| `Ctrl+Enter` / `Cmd+Enter` | 送出訊息 |

---

## 11. 程式碼對應

| 層級 | 檔案 | 用途 |
|------|------|------|
| 後端 — speak/transform | `backend/index.js` | `/api/client/speak`、`/api/transform` 路由與 mention auto-fill |
| 後端 — 解析器 | `backend/mention-parser.js` | 5 patterns + token strip |
| 後端 — 推送組裝 | `backend/push-context.js` | callback push 加入 `eclaw_context.mentions` |
| Web — autocomplete | `backend/public/portal/shared/mention-autocomplete.js` | 下拉 UI、模糊比對、IME safe |
| Web — chip 渲染 | `backend/public/portal/shared/mention-render.js` | token → chip HTML |
| Web — chat 整合 | `backend/public/portal/chat.html` | Target bar、輸入框、send |
| Android — chat 整合 | `app/.../ChatActivity.kt` + adapter / ViewModel | Target chips、source label 渲染 |
| iOS — chat 整合 | `ios-app/app/chat.tsx` | Target chips、source label 渲染 |
| 測試 | `backend/tests/jest/mention-*.test.js`、`test-broadcast.js`、`test-broadcast-recipient-block.js`、`test-cross-speak-*.test.js` | 43+ 單元 / 整合 / 靜態測試 |
| Skill template | `backend/data/skill-templates.json`（`eclaw-a2a-toolkit`） | 教 bot 如何讀懂 `[MENTIONS]` / `eclaw_context` |

---

## 12. 參考來源（被本文件取代或整併）

| 原始文件 | 關係 |
|----------|------|
| `docs/specs/android-uiux-rendering-spec.md` §3 | UI 佈局、filter vs target bar、輸入區規範 |
| `docs/specs/agent-message-rendering-spec.md` §4 | Source label、bubble 對齊、跨裝置渲染、broadcast 分組 |
| `docs/guide-mention-tagging.md` | @mention token 格式、autocomplete、API、安全 |
| `docs/plans/2026-04-12-brm-uiux-rendering-spec.md` DD#15 | 租借 bot 在 send chips 的限制 |
| `docs/plans/2026-03-07-channel-bot-context-parity-design.md` | channel-bound bot speakTo 推送行為 |

---

## 13. 已知差異與待辦

- iOS RN 原生 autocomplete 尚未實作（目前 Android 透過 WebView 繼承）。
- CJK 拼音 / romaji 模糊比對未支援。
- `@channel:xxx` 群組式 mention 尚未規劃。
- i18n key 僅 `en` + `zh` 完整，其他 10 語言 fallback 至英文。
- v2 UI（Send to 按鈕）尚未在三平台實作，需後續 PR：
  - Web Portal `chat.html`：移除 `target-bar` chip group，新增 `Send to ▾` 按鈕重用 `mention-autocomplete.js` 下拉。
  - Android `ChatActivity.kt`：移除 target ChipGroup，新增 `MaterialButton` + `PopupMenu`。
  - iOS `chat.tsx`：移除 target FlatList，新增 button + ActionSheet。
  - 測試：更新 `tests/jest/mention-*.test.js` 驗證「無 mention 時 Send 按鈕 disabled」「mention auto-route」邏輯。

---

## 14. 衝突解決紀錄（v2）

| 衝突 ID | 解決方式 |
|---------|---------|
| **C1** Target bar 多選 vs 單選 | 廢除 target bar；以 Send to 按鈕 + mention 文字取代，自然消除多/單選爭議。 |
| **C2** `[+]` vs `[輸入代碼]` | Send to 選單統一收納本裝置 entity / Card Holder 聯絡人 / 跨裝置 publicCode 三類；底部留「✏️ 輸入 publicCode」入口。 |
| **C3** deprecated 端點 | 本文件 §4.4 為 SoT；`agent-message-rendering-spec.md` §3.1 將補 deprecation note 並反向連結至本文件。 |
| **C4** `@mention` 是否影響路由 | **由 user 拍板**：v2 起 `@mention` = 路由真相（兩端對稱），UI 從勾選改為按鈕（按下插入 `<@xxxxxx>` 至文字）。 |
| **C5** Source `{char}` 格式 | tolerate 雙格式（emoji 或常數）；前端 source label 渲染需依 character 反查 entity 顯示資訊。 |
| **C6** Read 三態 vs 二態 | 後端 `is_delivered` 為 boolean，故 UI 採 **Sent / Delivered 二態**；`agent-message-rendering-spec.md` §4.1.1 為 SoT。`android-uiux-rendering-spec.md` §3.2 中的 `Read` 字眼為陳舊 mock，應於下次 spec 更新移除。 |
| **C7** `@all` 用語 | 統一為「`@all` token 觸發 broadcast；user 端訊息中含 `@all` → `broadcast: true`；bot 端也適用」。 |
| **C8** 每日訊息上限 UI | 已隨 v1.1105 移除每日上限；`android-uiux-rendering-spec.md` §3.7 daily-limit 段落應刪除。本文件不再提及。 |

---

## 變更紀錄

| 日期 | 異動 |
|------|------|
| 2026-05-09 | 初版整併（合併 4 份散落規格 + BRM/channel parity 補充） |
| 2026-05-09 | v2：C4 拍板 — `@mention` = 路由真相；UI 從 target chip checkbox 改為 Send to 按鈕；解決 C1–C8 全部衝突 |
