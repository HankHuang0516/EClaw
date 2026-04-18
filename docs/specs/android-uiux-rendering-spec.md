# Android UI/UX 渲染規範

> **建立日期**：2026-04-14
> **依據**：`docs/specs/android-app-spec.md` + `docs/plans/2026-04-14-android-e2e-test-scenarios.md` + Web 版 `docs/plans/2026-04-12-brm-uiux-rendering-spec.md`
> **涵蓋**：16 個 Activity + 3 個 Service + 1 個 Widget + 多個 Bottom Sheet/Dialog
> **組織**：按 Activity/元件分組

---

## 目錄

1. [LoginActivity — 登入 / 註冊](#1-loginactivity)
2. [MainActivity — Dashboard](#2-mainactivity-dashboard)
3. [ChatActivity — 原生聊天](#3-chatactivity)
4. [AiChatBottomSheet — AI 助手](#4-aichatbottomsheet)
5. [MissionControlActivity — Kanban WebView](#5-missioncontrolactivity)
6. [Card Holder (WebViewActivity embed)](#6-card-holder-webviewactivity-embed)
7. [FileManagerActivity — 檔案管理](#7-filemanageractivity)
8. [SettingsActivity — 設定](#8-settingsactivity)
9. [OfficialBorrowActivity + Billing Flow](#9-officialborrowactivity--billing)
10. [MessageActivity — Push Landing](#10-messageactivity)
11. [WallpaperPreviewActivity + Live Wallpaper Service](#11-wallpaper)
12. [Widget — 桌面小工具](#12-widget)
13. [FeedbackActivity + History](#13-feedback)
14. [DebugLogViewer + CrashLogViewer](#14-debug-viewers)
15. [共用元件](#15-共用元件)
16. [主題 / 色票 / 字型](#16-主題-色票-字型)
17. [i18n 渲染規則](#17-i18n-渲染規則)
18. [錯誤狀態 / 空狀態 / Loading 狀態](#18-狀態)
19. [與 Web 的差異標記](#19-與-web-的差異標記)

---

## 1. LoginActivity

**涉及場景**：A1-A6, B1-B5, C1-C3

### 1.1 頁面佈局

```
┌─────────────────────────────────────────┐
│           [EClawbot logo]               │
│             EClawbot                    │
├─────────────────────────────────────────┤
│  [Login] [Register] [Device]            │ ← Tab 切換
├─────────────────────────────────────────┤
│  Login tab:                             │
│    Email       [__________________]     │
│    Password    [__________________]     │
│    [    Login    ]                      │
│    Forgot password?                     │
│    ──────── or ────────                 │
│    [Sign in with Google]                │
│    [Sign in with Facebook]              │
│                                         │
│  Register tab:                          │
│    Email / Password / Confirm           │
│    [Agree to Terms] checkbox            │
│    [   Register   ]                     │
│                                         │
│  Device tab:                            │
│    Device ID      [__________________]  │
│    Device Secret  [__________________]  │
│    [Login with Device]                  │
├─────────────────────────────────────────┤
│  Language: [ EN / 繁中 / ... ] dropdown │
└─────────────────────────────────────────┘
```

### 1.2 渲染規則

| 元素 | View | 規則 |
|------|------|------|
| Logo | `ImageView` | `ic_launcher_round`，96dp |
| Tab switcher | `TabLayout` | 3 tab，目前 tab 下有底線 |
| Email/Password | `TextInputLayout` | Material，label 浮動 |
| Primary button | `MaterialButton` `filled` | 色 `@color/primary`，圓角 12dp |
| Social button | `MaterialButton` `outlined` | icon + text |
| Error | `TextInputLayout` 的 `error` 屬性 | 紅框 + 紅字 |
| 語系切換 | `Spinner` 或 `MaterialAutoCompleteTextView` | 底部 |

### 1.3 互動狀態

- **Loading**：按鈕內顯示 `CircularProgressIndicator`（24dp），文字隱藏
- **Validation**：Email 格式不對 → 即時 error，密碼 <6 字 → error
- **Network error**：`Snackbar.LENGTH_LONG` 顯示錯誤
- **Success**：`finish()` 並 `startActivity(MainActivity)`，`overridePendingTransition` fade

---

## 2. MainActivity (Dashboard)

**涉及場景**：G1-G9, H1-H4, I1-I3, J1-J4, K1-K3, L1-L5

### 2.1 頁面佈局

```
┌────────────────────────────────────────────────┐
│  EClawbot                   [💰 1,234]  [👤]   │ ← AppBar
│                                                │
│  Dashboard                            ✎        │
│  10 entities bound                             │
├────────────────────────────────────────────────┤
│  [🤖 Entities]  [🏢 Org Chart]                 │ ← Segmented tabs
├────────────────────────────────────────────────┤
│  RecyclerView (GridLayoutManager, span=2):     │
│  ┌────────────────┐ ┌────────────────┐         │
│  │ 🦞 Mac_B       │ │ 🦊 Mac_F       │         │
│  │ #0  IDLE       │ │ #1  SLEEPING   │         │
│  │ Lv.13 4000 XP  │ │ Lv.1  30/100   │         │
│  │ Code: akdsv7📋 │ │ Code: wjkzxz📋 │         │
│  │ Waiting...     │ │ Zzz...         │         │
│  └────────────────┘ └────────────────┘         │
│  ┌────────────────┐ ┌────────────────┐         │
│  │ Rental Bot     │ │ + Add Entity   │         │
│  │ 🤖 Rented      │ │                │         │
│  └────────────────┘ └────────────────┘         │
├────────────────────────────────────────────────┤
│  [🤖] Official Bot Borrow  BETA   ▾            │
├────────────────────────────────────────────────┤
│  Bottom Nav                                    │
└────────────────────────────────────────────────┘
```

### 2.2 Entity Card 渲染

| 元素 | 資料來源 | 規則 |
|------|----------|------|
| Avatar | `entity.avatar` | 若是 emoji（單字元）→ `TextView` 48sp；若是 URL → Glide `.circleCrop()` |
| Name | `entity.name` | 左對齊，max 2 行，ellipsize end |
| Slot ID | `entity.entityId` | `#N`，灰字 |
| State badge | `entity.state` | IDLE（綠）/ BUSY（橘）/ SLEEPING（灰）/ EXEC（藍） |
| XP bar | `entity.xp`, `entity.level` | ProgressBar 高 4dp，圓角 |
| Public code | `entity.publicCode` | Monospace 字型，點擊 copy |
| Rental badge | `entity.rental_status` | `leased_in` → `🤖 Rented`（紫）；`leased_out` → `📤 Leased Out`（橘） |
| Message preview | `entity.message` | 底部，1 行，灰字 |
| Empty slot | `!isBound` | 虛線外框，中央 `+ Add Entity` |

### 2.3 Org Chart Tab

- 切到 `🏢 Org Chart` 後：**載入 WebView** 指向 `dashboard.html#org-chart` 的 iframe（避免重寫 drag-drop 邏輯）
- WebView 寬高填滿 parent
- 注入 `window.deviceId` + `window.deviceSecret` 由 bridge 提供

### 2.4 Spacing / Typography

| 項 | 值 |
|----|---|
| Card corner radius | 16dp |
| Card padding | 12dp |
| Card elevation | 2dp |
| 卡片間距 | 8dp (gridSpacing) |
| AppBar title | 20sp, Medium |
| Card name | 16sp, Medium |
| Meta 資訊 | 12sp, Regular, `@color/text_secondary` |

---

## 3. ChatActivity

**涉及場景**：M1-M8, N1-N6, O1-O4, P1-P4, Q1-Q2, R1-R3

### 3.1 頁面佈局

```
┌────────────────────────────────────────────────┐
│  ← Chat                              [15 sent] │
│  [All] [🦞Mac_B (#0)] [🦊Mac_F (#1)] [...] ▼  │ ← Filter chips
├────────────────────────────────────────────────┤
│  (滾動區)                                       │
│                                                │
│                          ┌───────────────────┐ │ ← Sent (右)
│                          │ Hi how are you?   │ │
│                          └───────────────────┘ │
│                           下午 3:45  Read      │
│                                                │
│  🦞 Mac_B → You                                │
│  ┌──────────────────────┐                      │
│  │ I'm good, thanks!    │                      │
│  └──────────────────────┘                      │
│   👍 👎   下午 3:46                            │
│                                                │
│  ─── 今天 ───                                   │ ← Date separator
│                                                │
├────────────────────────────────────────────────┤
│  Send to: [☐ All] [☑ Mac_B] [☐ Mac_F] ...  [+]│
├────────────────────────────────────────────────┤
│  [+] [🎤] [ Type a message...    ]      [Send] │
└────────────────────────────────────────────────┘
```

### 3.2 訊息 bubble 渲染

#### Sent（我發送，`is_from_user=true` 且非 cross-device incoming）
- **對齊**：`Gravity.END`（右）
- **背景**：`@drawable/bubble_sent`（藍色 `@color/primary`，圓角 16dp 但右下 4dp）
- **文字色**：白色
- **meta 在下方右側**：`時間 · Read/Delivered/Sent`

#### Received（bot 回覆，`is_from_bot=true`）
- **對齊**：`Gravity.START`（左）
- **背景**：`@drawable/bubble_received`（灰 `@color/surface_variant`，圓角 16dp 但左下 4dp）
- **文字色**：`@color/text_primary`
- **Source label 在氣泡上方**：`🦞 Mac_B → You`（小字 + avatar）
- **Reaction 列在氣泡下方**：`👍 N  👎 M`（可點）
- **meta 在最下方左側**：`時間`

#### Platform message（`source === 'platform'`）
- **對齊**：置中
- **背景**：`@drawable/bubble_platform`（淺黃 `@color/accent_soft`）
- **文字色**：灰
- **前綴**：`🤖 EClawbot Platform`

### 3.3 Source label 規則

對應 `docs/specs/agent-message-rendering-spec.md`：

| Source pattern | 渲染 |
|----------------|------|
| `web_chat` / `android_chat` / `widget` | `You → 🦞 Mac_B · Web/Android/Widget` |
| `scheduled` | `📅 Schedule: {label} → Entity` |
| `mission_notify` | `🎯 Mission Control` |
| `entity:0:LOBSTER` | `🦞 Mac_B → You` |
| `entity:0:LOBSTER->1,2` | `🦞 Mac_B → Sent to Mac_F ✓ Lobster ✗`（多 target 分開列出） |
| `entity:0:LOBSTER->broadcast` | `🦞 Mac_B → Broadcast` |
| `xdevice:ABC123:🦞->XYZ456` | 有 🔗 前綴：`🔗 You → Entity(XYZ456)` 或 `🔗 Sender(ABC123) → Entity` |
| `kanban_notify` | `📋 系統通知` 樣式（見 platform） |

### 3.4 Filter Chips

- `HorizontalScrollView` + `ChipGroup`
- 第一個固定是「All」，Selected 狀態高亮
- Entity chip：avatar + name + (#ID)
- 超過 6 個 → 顯示 `▼+N` 展開 Bottom Sheet 選取

### 3.5 訊息分組 / 日期分隔

- 同 sender + 5 秒內 + 相同內容（broadcast）→ 合併成一個 bubble，顯示「Sent to A B C」
- 訊息列表跨日 → 插入 `Date Separator View`：`今天` / `昨天` / `MM/dd`（用 i18n key `chat_date_today` / `chat_date_yesterday`）

### 3.6 輸入區

- `[+]` → 彈出上傳選單（照片 / 檔案 / 位置）
- `[🎤]` → 長按錄音，顯示 `RecordingIndicatorHelper` 的波形
- `[Type a message...]` → `TextInputEditText`，支援貼上圖片（`InputContentInfoCompat`）
- `[Send]` → 按鈕，enabled 只在有文字或附件時

### 3.7 使用限制 UI

- `R.string.daily_limit_reached` 文字（黃色警告條）顯示在輸入框上方
- 輸入框 disabled（半透明）
- Send button disabled

---

## 4. AiChatBottomSheet

**涉及場景**：S1-S6, T1-T3, U1-U2

### 4.1 佈局

```
                                    (85% 高度)
┌────────────────────────────────────────────┐
│  ────── (drag handle)                     │
│  🤖 AI Support Chat               ✕       │
├────────────────────────────────────────────┤
│  (訊息區)                                   │
│  ┌──────────────────────┐                  │
│  │ Hi! How can I help?  │                  │
│  └──────────────────────┘                  │
│                          ┌────────────────┐│
│                          │ Your question  ││
│                          └────────────────┘│
│  (Markwon 渲染的 markdown 回覆)             │
│                                            │
├────────────────────────────────────────────┤
│  [Type your question...]          [Send]   │
└────────────────────────────────────────────┘
```

### 4.2 行為

- FAB (`R.id.fab_ai_chat`) 點擊 → 滑上
- `BottomSheetBehavior.STATE_EXPANDED` = 85%，`STATE_COLLAPSED` = hidden
- 下拉 `handle` → 暫存草稿到 `ChatPreferences`
- **90 秒無互動 → 自動 collapse**（`AiChatViewModel.idleTimeout`）
- 回覆訊息：Markwon 渲染，code block 有橫向 scroll + `Copy` 按鈕
- 錯誤時：紅色訊息 bubble + `Retry` 按鈕

### 4.3 WebView Guard

WebView Activity（MissionControl、CardHolder）中 **不顯示 FAB**，避免雙重 AI chat。實作：Activity 設 `aiChatFabVisible = false`。

---

## 5. MissionControlActivity (Kanban WebView)

### 5.1 佈局

```
┌────────────────────────────────────────────────┐
│  ← Mission / Kanban                   [ ⟳ ]    │
├────────────────────────────────────────────────┤
│  (WebView 填滿)                                 │
│                                                │
│  載入: https://eclawbot.com/portal/kanban.html │
│         ?deviceId=XXX&deviceSecret=YYY         │
│                                                │
│  渲染完全遵循 kanban.html 的 CSS                │
│                                                │
└────────────────────────────────────────────────┘
```

### 5.2 注入參數

URL 追加：
- `?deviceId=...` — 免再登入
- `&deviceSecret=...`
- `&platform=android` — 讓 web 端知道是 WebView（可隱藏某些元素，如頂部 nav）
- `&lang=zh-TW` — 傳遞 locale

### 5.3 SwipeRefreshLayout

WebView 包在 `SwipeRefreshLayout` 內，下拉觸發 `webView.reload()`。

### 5.4 返回鍵行為

- WebView 有 history → pop history
- history 空 → `finish()`

### 5.5 載入狀態

- Loading：顯示 `CircularProgressIndicator` 覆蓋中央
- Error：顯示 `R.string.webview_load_error` + Retry 按鈕
- `onReceivedSslError` → 顯示警告 dialog（不自動 proceed）

---

## 6. Card Holder (WebViewActivity embed)

Since v1.0.74 the native `CardHolderActivity` was removed. The CARDS bottom-nav tab now launches the generic `WebViewActivity` pointed at the portal embed URL:

```
https://eclawbot.com/portal/card-holder.html?embed=1&deviceId=…&deviceSecret=…
```

### 6.1 佈局

```
┌────────────────────────────────────────────────┐
│  (App top bar with title "Cards" + back)       │
├────────────────────────────────────────────────┤
│  WebView 填滿：                                  │
│  portal/card-holder.html?embed=1               │
│  ├─ [📁 我的名片] [🏗 Bot 廣場]  (in-page tabs) │
│  ├─ filter chips + search                       │
│  └─ card list / detail modals                   │
└────────────────────────────────────────────────┘
```

### 6.2 embed=1 contract

`shared/nav.js` and `shared/footer.js` both read `?embed=1` and skip rendering so
the portal loses its top-level nav/footer chrome. Within `card-holder.html`,
`body.embedded` CSS hides the redundant page-title `h2` and trims the page-header
to just the search bar.

### 6.3 Feature parity (no native port)

The MyCard detail modal already ships:
- **Run Interview** — shared `AgentCardEditor` (`shared/agent-card-editor.js`)
- **Bot Plaza publish toggle** — `togglePlazaCH`
- **Start Chat** button (deep-links to `/c/<publicCode>`)
- **Share** button (existing `openShareModal` + QR)
- **Edit** capabilities/tags/protocols via `AgentCardEditor`

### 6.4 BRM 入口標示

BRM / Marketplace is reached by tapping the **Bot 廣場** sub-tab inside the portal
(which iframes `community.html?embed=1`). No separate native BRM entry.

詳見 `docs/plans/2026-04-14-brm-mobile-parity-gap.md`.

---

## 7. FileManagerActivity

### 7.1 佈局

```
┌────────────────────────────────────────────────┐
│  ← Files                              [🔍] [+] │
│  📂 /  (breadcrumb)                            │
├────────────────────────────────────────────────┤
│  RecyclerView (LinearLayoutManager):           │
│                                                │
│  📁 folder-a/                      > │
│  📁 folder-b/                      > │
│  📄 photo.jpg            2.3 MB   ⋮ │
│  📄 report.pdf          512 KB    ⋮ │
│  🎵 audio.mp3           1.1 MB    ⋮ │
│                                                │
├────────────────────────────────────────────────┤
│  Used: 234 MB / 500 MB (progress bar)          │
└────────────────────────────────────────────────┘
```

### 7.2 檔案類型 icon

| 副檔名 | Icon |
|--------|------|
| folder | 📁 / `ic_folder` |
| image | 🖼️ / `ic_image` 縮圖 |
| video | 🎥 / `ic_video` |
| audio | 🎵 / `ic_audio` |
| pdf | 📕 / `ic_pdf` |
| doc/docx | 📘 / `ic_doc` |
| other | 📄 / `ic_file` |

### 7.3 長按選單

- Rename / Move / Share to Chat / Delete

---

## 8. SettingsActivity

### 8.1 佈局（PreferenceFragment 風格）

```
┌────────────────────────────────────────────────┐
│  ← Settings                                    │
├────────────────────────────────────────────────┤
│  Account                                       │
│  ├─ Email: hank@...                            │
│  ├─ Device ID: 480def4c...                     │
│  └─ Sign out                                   │
│                                                │
│  Wallet                                        │
│  ├─ Balance: 💰 1,234 e-coins                  │
│  ├─ Top Up                                     │
│  ├─ Upgrade Plan (Starter / Pro / Business)   │
│  └─ Subscription status: Active until 5/14    │
│                                                │
│  Preferences                                   │
│  ├─ Language: 繁體中文     >                   │
│  ├─ Theme:    System       >                   │
│  ├─ Notifications          >                   │
│  └─ Live Wallpaper         >                   │
│                                                │
│  Tools                                         │
│  ├─ Environment Variables  >                   │
│  ├─ Remote Screen Control  >                   │
│  ├─ My Rentals (BETA)      >                   │ ← 新入口
│  └─ Feedback               >                   │
│                                                │
│  About                                         │
│  ├─ Version 1.0.64 (70)                        │
│  ├─ Privacy Policy         >                   │
│  ├─ Terms of Service       >                   │
│  └─ Debug (long press)                         │
└────────────────────────────────────────────────┘
```

### 8.2 Debug 隱藏指令

長按「Version 1.0.64 (70)」5 次 → 解鎖 Debug section：
- View Crash Logs
- View Debug Logs
- Force Crash (E2E test)
- Reset Preferences
- Show device secret

---

## 9. OfficialBorrowActivity + Billing

### 9.1 Official Borrow

目前為「Sold Out + 提交月租需求」的 stub 對話框 — **不是完整 BRM UI**。

```
┌──────────────────────────┐
│  Sold Out                │
│                          │
│  Monthly bots are        │
│  currently sold out.     │
│                          │
│  Submit a rental demand  │
│  request?                │
│                          │
│      [Cancel] [Submit]   │
└──────────────────────────┘
```

### 9.2 Billing Flow

Google Play Billing UI 由系統接管 — **不要自己畫**。只畫進入按鈕：

```
┌──────────────────────────┐
│  Choose Plan             │
│                          │
│  [ Starter ]             │
│  $5.99/mo                │
│  2,000 e-coins/mo        │
│  SKU: eclaw_sub_starter  │
│                          │
│  [ Pro ]   RECOMMENDED   │
│  $19.99/mo               │
│  8,000 e-coins/mo        │
│  10% rental discount     │
│  SKU: eclaw_sub_pro      │
│                          │
│  [ Business ]            │
│  $49.99/mo               │
│  20,000 e-coins/mo       │
│  SKU: eclaw_sub_business │
└──────────────────────────┘
```

**3 方必須對齊**：`app/build.gradle.kts` 的 product ID 常量、`backend/subscription.js` 的 `googlePlayProductId`、Google Play Console 登記的 SKU。任一不同步 → 購買失敗或驗證失敗。

---

## 10. MessageActivity

Push notification landing page — 當 app 被 kill 後從 push 開啟時經過此頁，然後導向實際目的地（ChatActivity / MissionControlActivity）。

### 10.1 通常不可見（立即轉跳）

若 `intent.extras` 有 `entityId` → 跳 ChatActivity
若 `intent.extras` 有 `cardId` → 跳 MissionControlActivity
都沒有 → 跳 MainActivity

---

## 11. Wallpaper

### 11.1 WallpaperPreviewActivity

```
┌────────────────────────────────────────────────┐
│  ← Wallpaper Preview                           │
├────────────────────────────────────────────────┤
│  (GLSurfaceView 預覽區)                         │
│  Entity 動畫預覽                                │
│                                                │
├────────────────────────────────────────────────┤
│  Settings:                                     │
│  ├─ Primary entity: [Mac_B ▼]                  │
│  ├─ Animation speed: [▬▬▬▬▬●▬▬▬▬]              │
│  ├─ Background: [Image picker]                 │
│  └─ Show message bubbles: [☑]                  │
│                                                │
│  [ Set as Wallpaper ]                          │
└────────────────────────────────────────────────┘
```

### 11.2 ClawWallpaperService 渲染

- Entity sprite 使用 `ClawRenderer` (OpenGL ES 2.0)
- 收到新訊息 → 顯示氣泡 5 秒後淡出
- `onVisibilityChanged(false)` → 暫停渲染（省電）

---

## 12. Widget

### 12.1 佈局（4x1）

```
┌──────────────────────────────────────┐
│ 🦞 Mac_B  IDLE  [3 unread]           │
│ "Waiting for your next message..."   │
└──────────────────────────────────────┘
```

### 12.2 更新機制

- `RemoteViews` 透過 `AppWidgetManager.updateAppWidget`
- FCM 接到訊息 → 廣播 intent 給 widget receiver → 觸發更新
- 點擊 → PendingIntent 開 ChatActivity

---

## 13. Feedback

### 13.1 FeedbackActivity

```
┌────────────────────────────────────────────────┐
│  ← Feedback                                    │
├────────────────────────────────────────────────┤
│  Category  [ Bug / Feature / Other ▼ ]         │
│  Title     [__________________________]        │
│  Description                                   │
│  ┌──────────────────────────────────────┐     │
│  │                                      │     │
│  │                                      │     │
│  └──────────────────────────────────────┘     │
│  Screenshots: [+ Add] [img1.jpg] [img2.jpg]    │
│                                                │
│  [ Submit ]                                    │
└────────────────────────────────────────────────┘
```

### 13.2 FeedbackHistoryActivity

- RecyclerView，每筆顯示 title / status（pending/resolved） / timestamp
- 點進詳情：顯示 description + screenshots + bot reply（若有）

---

## 14. Debug Viewers

### 14.1 CrashLogViewerActivity

- `RecyclerView`，每行顯示時間戳 + 第一行錯誤訊息
- 點進看完整 stack trace（monospace）
- Share button → 送到 Feedback

### 14.2 DebugLogViewerActivity

- 即時 `adb logcat` 風格顯示
- Filter chips：Info / Warn / Error
- Clear / Export 按鈕

---

## 15. 共用元件

### 15.1 Bottom Nav

5 tab：Dashboard / Chat / Cards / Mission / Settings
（Files 移入 Settings 下級）

| Tab | Icon | Activity |
|-----|------|----------|
| Dashboard | `ic_dashboard` | MainActivity |
| Chat | `ic_chat_bubble` | ChatActivity |
| Cards | `ic_badge` | WebViewActivity (→ `portal/card-holder.html?embed=1`) |
| Mission | `ic_task` | MissionControlActivity |
| Settings | `ic_settings` | SettingsActivity |

### 15.2 AppBar

- `MaterialToolbar`
- 高度 56dp
- 可選 overflow menu（⋮）
- Wallet badge 點擊 → Settings → Wallet

### 15.3 FAB (AI Chat)

- `FloatingActionButton` extended
- 固定右下 16dp
- Icon：🤖 / `ic_ai_chat`
- 可拖曳移動位置（`AiChatFabHelper`）

### 15.4 Avatar View

Reusable layout：`view_entity_avatar.xml`
- 支援 emoji / URL 兩種
- 圓形裁切
- 有狀態小圓點（IDLE 綠 / BUSY 橘 / SLEEPING 灰）

### 15.5 Dialog / Snackbar / Toast

- 警告 / 確認：`MaterialAlertDialogBuilder`
- 短通知：`Snackbar`（可帶 action）
- 簡單成功：`Toast`（避免濫用）

---

## 16. 主題 / 色票 / 字型

### 16.1 主色

```
primary       #6750A4  (紫)
onPrimary     #FFFFFF
secondary     #625B71
tertiary      #7D5260
error         #B3261E
surface       #FFFBFE
onSurface     #1C1B1F
```

### 16.2 Dark theme

`values-night/colors.xml`

```
primary       #D0BCFF
onPrimary     #381E72
surface       #1C1B1F
onSurface     #E6E1E5
```

### 16.3 狀態色

- IDLE：`#4CAF50`
- BUSY：`#FF9800`
- SLEEPING：`#9E9E9E`
- EXEC：`#2196F3`
- RENTAL badge：`#9C27B0`
- LEASED_OUT badge：`#FF9800`

### 16.4 字型

- Body：Roboto Regular 14sp
- Title：Roboto Medium 20sp
- Monospace（public code / logs）：Roboto Mono 14sp

### 16.5 Spacing

4dp grid — 所有間距使用 4 的倍數（4 / 8 / 12 / 16 / 24 / 32）。

---

## 17. i18n 渲染規則

### 17.1 支援語系

en / zh-rTW / zh-rCN / ja / ko / th / vi / in / es
（9 種，跟 Web 的 12 種略少；未覆蓋的 fallback 到 en）

### 17.2 絕對禁止

- **硬編字串**（Toast / dialog / layout）— CI lint `MissingTranslation` 會捕捉
- **重複 `<string name="X">`**— build 會直接失敗（見 android-app-spec §14.1.A）
- **raw key 出現在 UI**（如 `chat_date_yesterday`）— QA 要測每個語系所有頁面

### 17.3 佔位符

`%1$s`、`%1$d` — 位置型，方便翻譯者重排順序

### 17.4 Plural

用 `<plurals>` 不要用 `if-else`：
```xml
<plurals name="entity_count">
    <item quantity="one">%d entity</item>
    <item quantity="other">%d entities</item>
</plurals>
```

### 17.5 日期 / 數字

- 使用 `DateUtils.getRelativeTimeSpanString()` 讓系統處理 locale
- 金額：`NumberFormat.getCurrencyInstance(locale)`

---

## 18. 狀態

### 18.1 Loading

| 情境 | UI |
|------|----|
| 全頁載入 | `CircularProgressIndicator` 置中 + 灰色背景 |
| Inline（按鈕內） | 按鈕內換 CircularProgress，文字隱藏 |
| 列表載入更多 | 底部 footer 顯示 ProgressBar |
| WebView | 覆蓋層 + progress |

### 18.2 Empty State

| 情境 | UI |
|------|----|
| 無 entity | 中央 `ic_empty_entities` + 「Add your first entity」按鈕 |
| 無訊息 | 中央 `ic_empty_chat` + 「Say hello to get started」 |
| 無檔案 | 中央 `ic_empty_files` + 「Upload your first file」 |

### 18.3 Error State

| 情境 | UI |
|------|----|
| 網路錯 | `Snackbar` + Retry action |
| 401/403 | Dialog「Session expired」→ 跳登入 |
| 500 | `Snackbar` 含 request ID |
| WebView load error | 全頁 + Retry 按鈕 |

### 18.4 Offline Mode

- 頂部 banner：`@color/warning` + `R.string.offline_mode`
- 快取資料可讀、不能寫
- 恢復連線後自動 sync + 消除 banner

---

## 19. 與 Web 的差異標記

> 這些差異是「原生化」的設計決策，不是 bug。

| 項目 | Web 行為 | Android 行為 |
|------|---------|------------|
| 聊天輸入框貼圖片 | Ctrl+V 貼 | 長按輸入框 → Paste image |
| 組織架構 | 頁內切換 | MainActivity Tab 切換（但實為 WebView） |
| BRM 市集 | 頂部 nav | Cards tab → Community sub-tab |
| 訂閱購買 | TapPay / 信用卡 | Google Play Billing |
| Top-up | TapPay | Google Play Billing consumables |
| Push | Web Push | FCM |
| 顯示 cookie banner | 有 | 無（不需要） |

---

## 20. 參考

- Android spec：`docs/specs/android-app-spec.md`
- Android E2E 場景：`docs/plans/2026-04-14-android-e2e-test-scenarios.md`
- Android E2E 藍圖：`docs/plans/2026-04-14-android-e2e-blueprint.md`
- Agent message rendering：`docs/specs/agent-message-rendering-spec.md`
- Web BRM UIUX spec：`docs/plans/2026-04-12-brm-uiux-rendering-spec.md`
- BRM mobile parity gap：`docs/plans/2026-04-14-brm-mobile-parity-gap.md`
