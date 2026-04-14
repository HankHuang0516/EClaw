# Android E2E 測試場景

> **建立日期**：2026-04-14
> **目的**：上線前完整覆蓋 Android 原生流程 + WebView 包裝的 BRM/Kanban/Mission 流程
> **工具**：Android Studio Espresso/UI Automator + adb + WebView JavascriptInterface bridge + backend API 驗證
> **測試機**：Pixel 8 emulator (API 35) + 實機 (API 24/29/35)
> **帳號**：Owner device login `480def4c`, Renter email `e2e-renter-test@eclawbot.com`
> **對應**：Web 版 `2026-04-12-rental-e2e-test-scenarios.md` 28 劇本

---

## 測試分類

```
A-F   登入與導覽         (Auth + Navigation)
G-L   Dashboard          (Entity cards + Org chart)
M-R   Chat 原生          (Native chat)
S-U   AI Chat            (Bottom sheet)
V-X   Mission / Kanban   (WebView)
Y-AA  Card Holder + BRM  (WebView bridge)
BB-DD File Manager       (Native)
EE-GG Settings + Billing (Native + IAP)
HH-JJ Live Wallpaper     (Service)
KK-MM Push Notifications (FCM)
NN-PP Widget             (Home screen)
QQ-SS Remote Control     (Service)
TT-VV Feedback + Crash   (Diagnostics)
WW-YY 跨平台一致性        (Android ↔ Web)
ZZ-DDD 回歸邊界           (Regression edges)
```

---

## A — 首次啟動 + 註冊

| Step | 操作 | 預期 |
|------|------|------|
| A1 | 冷啟動（清除 app data） | 顯示 Splash → Login screen，無 crash |
| A2 | 切換語系 zh-TW / zh-CN / ja / ko / th / vi / in / es / en | UI 文字立即切換，無 raw key 顯示（`rn_xxx`、`chat_xxx`）|
| A3 | 點「註冊」→ 填 email + 密碼 + 同意條款 | 成功後自動登入進 Dashboard |
| A4 | 註冊後收到驗證 email → 點連結 | Deep link 回 app，驗證成功 |
| A5 | 試 Google 登入 | Credentials Manager 啟動，綁定成功 |
| A6 | 試 Facebook 登入 | WebView OAuth flow 完成，綁定成功 |

---

## B — 裝置登入（Android 特有）

| Step | 操作 | 預期 |
|------|------|------|
| B1 | 選「裝置登入」分頁 | 顯示 Device ID + Device Secret 輸入框 |
| B2 | 輸入有效 `480def4c` credentials | 登入成功，進 Dashboard |
| B3 | 輸入錯誤 secret | Toast：「Invalid credentials」無 crash |
| B4 | 登入後殺 app → 重開 | 自動還原 session，直接進 Dashboard |
| B5 | 背景超過 12 小時 | 回前景 reconnect socket，保持登入 |

---

## C — 登出 + 切帳號

| Step | 操作 | 預期 |
|------|------|------|
| C1 | Settings → 登出 | Confirm dialog → 回到 Login screen |
| C2 | 登出後嘗試返回鍵 | 不會回到 Dashboard（session cleared）|
| C3 | 登出 → 用不同帳號登入 | 舊資料完全替換（不混合） |

---

## D — Deep Links + Push Intent

| Step | 操作 | 預期 |
|------|------|------|
| D1 | adb 送 `eclaw://chat?entityId=2` | 開 ChatActivity，filter chip 預選 #2 |
| D2 | adb 送 `eclaw://kanban` | 開 MissionControlActivity，載入 kanban.html |
| D3 | 從 FCM push notification 點進來 | 按 payload metadata 導到正確頁面 |
| D4 | 收到 push 但 app 已在前景 | 顯示 in-app banner，不打斷操作 |

---

## E — Bottom Nav

| Step | 操作 | 預期 |
|------|------|------|
| E1 | 點 Dashboard / Chat / Cards / Files / Mission / Settings | 切頁順暢，無閃爍 |
| E2 | 目前頁 icon highlight | 顏色 + 底線正確 |
| E3 | 快速來回切頁 | 無記憶體洩漏，logcat 無 OOM |

---

## F — 權限請求

| Step | 操作 | 預期 |
|------|------|------|
| F1 | 首次發語音訊息 | 要求 RECORD_AUDIO 權限 |
| F2 | 首次傳照片 | 要求 READ_MEDIA_IMAGES（API 33+）/ READ_EXTERNAL_STORAGE |
| F3 | Android 13+ 首次啟動 | 要求 POST_NOTIFICATIONS |
| F4 | 拒絕權限 | 顯示引導 UI，不 crash，功能優雅降級 |
| F5 | 永久拒絕後再嘗試 | 顯示「去設定開啟」按鈕 → 開系統 Settings |

---

## G — Dashboard Entity Cards

| Step | 操作 | 預期 |
|------|------|------|
| G1 | 登入後看 Dashboard | 顯示 N 個 entity 卡片 |
| G2 | Entity 卡片 avatar | 支援 emoji（🦞🐷🐶🦸）+ URL 圖片（Flickr） |
| G3 | Entity 卡片狀態 badge | IDLE/BUSY/SLEEPING 文字 + 顏色不同 |
| G4 | Rental entity 標籤 | `🤖 Rented`（leased_in）/ `📤 Leased Out`（leased_out）|
| G5 | 點卡片 | 進 ChatActivity，entity 被預選 |
| G6 | 長按卡片 | 彈出 overflow menu（xd-settings / agent-card） |
| G7 | 輕觸 public code | Copy 到剪貼簿，Toast 確認 |
| G8 | 滾動到「新增實體」卡片 → 點擊 | 開 add entity dialog |
| G9 | 拉下刷新 | 呼叫 `/api/entities`，更新 XP/level/state |

---

## H — Dashboard Org Chart (WebView)

| Step | 操作 | 預期 |
|------|------|------|
| H1 | 切「🏢 組織架構」分頁 | 載入 dashboard.html 的 org chart tab |
| H2 | 拖曳 entity 卡片到另一個下面 | Hierarchy 更新，虛線動畫連接 |
| H3 | 勾選 `taskForward` | 發任務給下屬時自動 forward 到上司 |
| H4 | 切「🤖 實體總覽」分頁 | 切回 native view，狀態保留 |

---

## I — Agent Card + Identity

| Step | 操作 | 預期 |
|------|------|------|
| I1 | 長按 entity → Agent Card | 顯示 role/description/capabilities |
| I2 | 編輯 identity → 儲存 | `/api/entity/identity` PUT 成功 |
| I3 | 顯示 E2EE badge | 若 `encryption_status=e2ee` 則顯示 🔒 |

---

## J — Rental Entity (Renter 視角)

| Step | 操作 | 預期 |
|------|------|------|
| J1 | 完成租借後回 Dashboard | 租借 bot 以新 slot 出現，有 `🤖 Rented` 標籤 |
| J2 | Rental bot avatar | 繼承 owner 的 avatar（Flickr URL 或 emoji） |
| J3 | 點 rental bot 卡片 | 開 chat，與 native entity 體驗一致 |
| J4 | 合約到期 / 結束後回 Dashboard | Rental slot 消失，slot 空出 |

---

## K — Leased-Out Entity (Owner 視角)

| Step | 操作 | 預期 |
|------|------|------|
| K1 | 自己的 entity 被租後看 Dashboard | 該 entity 顯示 `📤 Leased Out` badge |
| K2 | 點 leased-out entity | 可打開 chat 但**看不到 rental 對話**（隔離） |
| K3 | 合約結束 | badge 消失，entity 恢復 |

---

## L — Entity CRUD

| Step | 操作 | 預期 |
|------|------|------|
| L1 | 新增 entity | 卡片出現，slot ID = max+1 |
| L2 | 編輯 entity 名稱 | Inline 編輯，失焦保存 |
| L3 | 更換 avatar（emoji picker / 上傳圖片） | 即時顯示 |
| L4 | 刪除 entity | Confirm → 送到 trash（7 天）|
| L5 | 從 trash 還原 | 恢復到原 slot（或新 slot） |

---

## M — Chat 原生：訊息收發

| Step | 操作 | 預期 |
|------|------|------|
| M1 | 開 ChatActivity，filter = All | 顯示所有 entity 的合併時間軸 |
| M2 | 點某 entity chip | 只顯示該 entity 的對話 |
| M3 | 輸入文字 → 傳 | 訊息右對齊（sent），藍底，顯示 ↻→✓→✓✓ |
| M4 | Bot 回覆 | 左對齊（received），灰底，顯示 entity name + time |
| M5 | 長按訊息 | 彈出 copy / react / share 選單 |
| M6 | 點 👍 / 👎 | 送 reaction，計數即時更新 |
| M7 | 訊息含 URL | 自動渲染 link preview card（OG data） |
| M8 | 訊息含 `<@publicCode>` | 渲染成 mention chip |

---

## N — Chat 原生：媒體訊息

| Step | 操作 | 預期 |
|------|------|------|
| N1 | 點 📷 → 選 / 拍照片 | 上傳進度條 → 縮圖 bubble + 「已送出」|
| N2 | 接收照片訊息 | Glide 載入，縮圖 + 點擊全螢幕 |
| N3 | 點 🎤 錄音 | 錄音指示器顯示，放開送出 |
| N4 | 接收語音訊息 | 顯示播放按鈕，點擊播放 |
| N5 | 貼上剪貼簿圖片（長按輸入框） | 以圖片訊息送出 |
| N6 | 檔案上傳（File/PDF） | 檔案 bubble，點擊下載 |

---

## O — Chat 原生：A2A 跨 Entity

| Step | 操作 | 預期 |
|------|------|------|
| O1 | 輸入 `<@wjkzxz> hello` | Mention chip 渲染；送出後 webhook push 到 entity #1 |
| O2 | 廣播訊息（勾選 All） | 所有 entity 都收到，source 顯示 `You → A B C · Web/Android` |
| O3 | Entity A 用 speakTo 傳給 B | A 的 chat 顯示 `A → Sent to B`；B 的 chat 顯示 `A → You` |
| O4 | 跨裝置 speakTo | source 以 🔗 開頭 + `[Sender] → [Target]` |

---

## P — Chat 原生：即時同步

| Step | 操作 | 預期 |
|------|------|------|
| P1 | 在 app 中送訊息，用 Web 端看 | 5 秒內出現在 Web chat.html |
| P2 | Web 端送訊息 | App 內即時出現（Socket.IO） |
| P3 | 背景時送訊息 | 顯示 push notification，點擊跳 chat |
| P4 | 關閉網路 → 重連 | Reconnect socket，訊息順序正確，無重複 |

---

## Q — Chat 原生：日期分隔

| Step | 操作 | 預期 |
|------|------|------|
| Q1 | 訊息列表跨日 | 「今天 / 昨天 / 其他日期」正確分隔 |
| Q2 | 所有語系下分隔文字 | zh-TW「今天/昨天」、en「Today/Yesterday」不顯示 raw key |

---

## R — Chat 原生：使用限制

| Step | 操作 | 預期 |
|------|------|------|
| R1 | 達到每日 15 則 | 輸入框 disabled，顯示「Daily message limit reached」 |
| R2 | Premium 訂閱用戶 | 無限制，顯示「Unlimited」 |
| R3 | 隔天重置 | 限制解除 |

---

## S — AI Chat Bottom Sheet：基本

| Step | 操作 | 預期 |
|------|------|------|
| S1 | 點 🤖 FAB | 底部 sheet 滑上，高度佔 85% |
| S2 | 送問題 | 顯示「正在思考」動畫，2-5s 後回覆 |
| S3 | 回覆含 code block | Markwon 渲染語法高亮 |
| S4 | 回覆含圖片 URL | Glide 嵌入顯示 |
| S5 | 下拉 sheet | 關閉，草稿保留 |
| S6 | 重開 sheet | 草稿還在（`ChatPreferences`） |

---

## T — AI Chat：錯誤處理

| Step | 操作 | 預期 |
|------|------|------|
| T1 | 無網路時送出 | 錯誤 bubble + retry 按鈕 |
| T2 | 後端 5xx | 錯誤文字含 request ID，可複製給支援 |
| T3 | WebView 模式隱藏 AI chat | `ai-chat-webview-guard` 生效（不雙重出現） |

---

## U — AI Chat：Idle Timeout

| Step | 操作 | 預期 |
|------|------|------|
| U1 | 開 AI chat sheet 後 90 秒不動 | 自動關閉 |
| U2 | 關閉前有輸入 | 草稿保留，重開可見 |

---

## V — Mission / Kanban WebView：載入

| Step | 操作 | 預期 |
|------|------|------|
| V1 | 點 Mission bottom nav | 載入 kanban.html in WebView，無 404 |
| V2 | 身份自動注入 | URL 含 `?deviceId=X&deviceSecret=Y`，免再登入 |
| V3 | 拉下刷新（SwipeRefreshLayout） | WebView reload |
| V4 | Console error | 無 `Uncaught TypeError`，無 i18n raw key |
| V5 | 返回鍵 | WebView history 先 pop，到底再關頁 |

---

## W — Kanban 操作（透過 WebView）

| Step | 操作 | 預期 |
|------|------|------|
| W1 | 建立卡片 | 指派 entity，出現在 Backlog/Todo 欄 |
| W2 | 拖曳到 In Progress | 動畫順暢，狀態同步 API |
| W3 | Bot 回覆 → auto-move to Review | Owner device 的 Android 端即時看到 |
| W4 | 編輯卡片（title/description/notes） | 保存成功 |
| W5 | 刪除卡片 | Confirm → 消失 |

---

## X — Mission Notes（WebView）

| Step | 操作 | 預期 |
|------|------|------|
| X1 | 新增 note | 出現在 notes list |
| X2 | 編輯 note markdown | Markdown 即時 preview |
| X3 | 發送 note 給 bot（mission-notify） | Bot 收到 push，skills/rules 更新 |

---

## Y — Card Holder（WebView）：Card 管理

| Step | 操作 | 預期 |
|------|------|------|
| Y1 | 開 Card Holder tab | 載入 card-holder.html |
| Y2 | 顯示 My Cards / Recent / Collected 3 分段 | 正確分類 |
| Y3 | Pin 一張卡 | 置頂顯示 |
| Y4 | Block 一張卡 | 不再接收該 entity 訊息 |

---

## Z — BRM 市場（WebView @ community.html#rental）

| Step | 操作 | 預期 |
|------|------|------|
| Z1 | 從 Card Holder 切到 Community 分頁 | 顯示市場 listings grid |
| Z2 | 篩選（capability chip / rate slider） | 卡片即時過濾 |
| Z3 | 點 listing 卡片 | Modal 顯示詳情（rate / duration / capabilities） |
| Z4 | 按「租借」→ 選 6hr → 確認 | Wallet hold deposit，合約建立 |
| Z5 | 租借成功後返回 Dashboard | 新 rental entity 出現（見 §J） |

> **備註**：BRM 完整 28 劇本 (A-BB) 驗證透過 Web 端 Playwright 進行；Android 只做 Z1-Z5 smoke test 確認 WebView 嵌入正常。

---

## AA — My Rentals（WebView @ my-rentals.html）

| Step | 操作 | 預期 |
|------|------|------|
| AA1 | Settings → My Rentals | 載入 my-rentals.html（若有入口） |
| AA2 | 顯示 active / ended 合約 | 狀態 badge 正確 |
| AA3 | 提前結束合約 | Confirm dialog → 結束成功，deposit 50% 退還 |
| AA4 | 提交 review（5★） | 星星 UI + 留言框 → 成功 |

> **已知 gap**：Android 目前沒有直接的「My Rentals」入口。見 `docs/plans/2026-04-14-brm-mobile-parity-gap.md`。

---

## BB — File Manager：基本操作

| Step | 操作 | 預期 |
|------|------|------|
| BB1 | 開 File Manager | 顯示資料夾 + 檔案列表 |
| BB2 | 建立資料夾 | 新資料夾 icon 出現 |
| BB3 | 上傳檔案 | 進度條 → 成功 |
| BB4 | 刪除檔案 | Confirm → 消失 |
| BB5 | 搜尋 | 即時過濾 |

---

## CC — File Manager：與 Chat 整合

| Step | 操作 | 預期 |
|------|------|------|
| CC1 | Chat 中收到檔案 → 開啟 | 下載到 File Manager |
| CC2 | File Manager 長按 → 分享到 Chat | 選擇 entity → 送出為檔案訊息 |

---

## DD — Environment Vars

| Step | 操作 | 預期 |
|------|------|------|
| DD1 | Settings → Env Vars（WebView 或 native） | 顯示 key-value list |
| DD2 | 新增 var（普通 / 加密） | 加密 var 顯示 🔒 |
| DD3 | Bot 讀取（透過 API） | 租借 bot 只能讀 public vars（隔離） |

---

## EE — Settings：基本

| Step | 操作 | 預期 |
|------|------|------|
| EE1 | Settings 頁載入 | 顯示帳號 / 裝置 / 語系 / 通知 / 隱私 / 進階 |
| EE2 | 切換語系 | 全 app 即時切換 |
| EE3 | 切換 dark / light theme | 即時生效 |
| EE4 | 清除快取 | 確認 → 清除 + 回登入 |

---

## FF — Billing：訂閱

| Step | 操作 | 預期 |
|------|------|------|
| FF1 | Settings → Upgrade Plan | 顯示三階 (Starter / Pro / Business) |
| FF2 | 選 Starter → Google Play 付款 flow | SKU = `eclaw_sub_starter` |
| FF3 | 付款成功 | `verifyPurchase` 成功，月度 2000 e-coin 入帳 |
| FF4 | 付款失敗 / 取消 | 訂閱狀態不變，顯示錯誤 toast |
| FF5 | 取消訂閱 | 到期前仍可用，到期後降級 Free |

---

## GG — Billing：E-coin 儲值

| Step | 操作 | 預期 |
|------|------|------|
| GG1 | Wallet → Top Up | 顯示 consumable 選項 |
| GG2 | 選 500 e-coin → 付款 | SKU 正確，付款成功後 wallet 增加 |
| GG3 | 重複購買 | 每次都成功（consumable） |

---

## HH — Live Wallpaper：設定

| Step | 操作 | 預期 |
|------|------|------|
| HH1 | Settings → Live Wallpaper | 跳到系統 Wallpaper picker |
| HH2 | 選 EClaw wallpaper | Preview 正確 |
| HH3 | 設定「鎖定畫面 + 首頁」 | 兩處都生效 |

---

## II — Live Wallpaper：渲染

| Step | 操作 | 預期 |
|------|------|------|
| II1 | 設定後回首頁 | Entity 在桌布上動畫（走路 / idle） |
| II2 | 收到新訊息 | 桌布上顯示氣泡 + 訊息預覽 |
| II3 | 切到其他 app | Wallpaper 繼續運作，不會停止 |

---

## JJ — Live Wallpaper：效能

| Step | 操作 | 預期 |
|------|------|------|
| JJ1 | 開 profiler 跑 1hr | 電量消耗 <3%/hr，無 memory leak |
| JJ2 | 螢幕關閉 | Wallpaper 暫停（onVisibilityChanged） |

---

## KK — Push Notifications：接收

| Step | 操作 | 預期 |
|------|------|------|
| KK1 | Bot 回覆訊息 | 收到 push（title = entity name，body = 訊息） |
| KK2 | Kanban 任務指派 | 收到 push（category = `kanban_assigned`） |
| KK3 | Cross-device speakTo | 收到 push（category = `cross_speak`） |
| KK4 | 同一 entity 連續多則訊息 | Push 合併（一個 notification） |

---

## LL — Push Notifications：Tap 行為

| Step | 操作 | 預期 |
|------|------|------|
| LL1 | 點 chat push | 開 ChatActivity，filter 預選對應 entity |
| LL2 | 點 kanban push | 開 MissionControlActivity，捲到該卡片 |
| LL3 | App 已開時點 push | 不重開 activity，直接切頁 |

---

## MM — Push Notifications：設定

| Step | 操作 | 預期 |
|------|------|------|
| MM1 | Settings → 關閉通知 | FCM topic unsubscribe |
| MM2 | 系統層關閉通知 | App 內設定同步顯示 disabled |

---

## NN — Widget：放置

| Step | 操作 | 預期 |
|------|------|------|
| NN1 | 長按桌面 → Widgets → 選 EClaw | 可加入 |
| NN2 | Widget 初始狀態 | 顯示 primary entity 的 avatar + status |
| NN3 | 點 widget | 開 ChatActivity |

---

## OO — Widget：更新

| Step | 操作 | 預期 |
|------|------|------|
| OO1 | Entity 收到新訊息 | Widget 顯示紅點 + 訊息預覽 |
| OO2 | 設定 widget 的 entity 被刪 | Widget 顯示「請重新設定」|

---

## PP — Widget：多 widget

| Step | 操作 | 預期 |
|------|------|------|
| PP1 | 同時放 2 個 widget，綁不同 entity | 各自更新互不影響 |

---

## QQ — Remote Screen Control：授權

| Step | 操作 | 預期 |
|------|------|------|
| QQ1 | Settings → 啟用遠端控制 | 要求 MediaProjection 權限 |
| QQ2 | 授權後 | 顯示邊框，Web 端可看畫面 |

---

## RR — Remote Screen Control：控制

| Step | 操作 | 預期 |
|------|------|------|
| RR1 | Web 端下指令「點擊」 | Android 端模擬點擊事件 |
| RR2 | Web 端下指令「輸入文字」 | Android 端觸發 InputMethod |

---

## SS — Remote Screen Control：安全

| Step | 操作 | 預期 |
|------|------|------|
| SS1 | 背景超過 5 分鐘 | 自動關閉 service（省電） |
| SS2 | Notification 顯示「正在錄製」 | 不可被 dismiss（persistent） |

---

## TT — Feedback：提交

| Step | 操作 | 預期 |
|------|------|------|
| TT1 | Settings → Feedback | 顯示 form（title / category / description / screenshot） |
| TT2 | 上傳 screenshot | 圖片預覽正確 |
| TT3 | 送出 | 成功 + Feedback History 看到 |

---

## UU — Feedback History

| Step | 操作 | 預期 |
|------|------|------|
| UU1 | Feedback History 列表 | 顯示所有提交，含狀態（pending / resolved） |
| UU2 | 點任一項 | 詳情 + bot 回覆（若有） |

---

## VV — Crash & Debug Log

| Step | 操作 | 預期 |
|------|------|------|
| VV1 | 故意 crash | Native handler 記錄到 `CrashLogger` 檔案 |
| VV2 | Settings → View Crash Logs | 顯示 stack trace |
| VV3 | Settings → View Debug Logs | Timber 輸出可讀 |

---

## WW — 跨平台：訊息一致性

| Step | 操作 | 預期 |
|------|------|------|
| WW1 | Android 送訊息 | Web 3s 內看到，source=`android_chat` |
| WW2 | Web 送訊息 | Android 3s 內看到（Socket + FCM 雙保險） |
| WW3 | 同訊息在 Android / Web / iOS | 渲染一致（sent 右對齊、received 左對齊、時間格式）|

---

## XX — 跨平台：設定一致性

| Step | 操作 | 預期 |
|------|------|------|
| XX1 | Web 改 org chart | Android Dashboard 組織架構分頁即時同步 |
| XX2 | Web 改 agent card | Android 長按 entity → agent card 顯示新資料 |

---

## YY — 跨平台：角色卡 / 身份

| Step | 操作 | 預期 |
|------|------|------|
| YY1 | Web 設 identity role | Android 同 entity 的 identity 一致 |
| YY2 | Android 編 identity | Web 同步更新 |

---

## ZZ — 回歸：App 升級

| Step | 操作 | 預期 |
|------|------|------|
| ZZ1 | 從 v1.0.63 升級到 v1.0.64 | 資料保留，session 保留 |
| ZZ2 | SharedPreferences 結構變更 | 自動 migrate，無 crash |
| ZZ3 | Room schema 變更 | Migration 成功 |

---

## AAA — 回歸：低版本 Android

| Step | 操作 | 預期 |
|------|------|------|
| AAA1 | API 24 (Nougat) | 所有基本功能可用 |
| AAA2 | API 29 (Q) | Scoped storage 相容 |
| AAA3 | API 33 (Tiramisu) | Runtime notification permission |

---

## BBB — 回歸：低階硬體

| Step | 操作 | 預期 |
|------|------|------|
| BBB1 | 1GB RAM 設備 | 不 ANR，不 OOM |
| BBB2 | 慢速 3G | Timeout 設定合理，有 loading spinner |

---

## CCC — 回歸：多語系邊界

| Step | 操作 | 預期 |
|------|------|------|
| CCC1 | 每個語系開每個頁面 | 無 raw key (`rn_xxx`、`chat_xxx`) |
| CCC2 | 長字串測試（德語、阿拉伯語風格） | UI 不被撐爆 |
| CCC3 | RTL locale（阿拉伯語若加入） | 布局方向正確 |

---

## DDD — 回歸：網路異常

| Step | 操作 | 預期 |
|------|------|------|
| DDD1 | 無網路開 app | 顯示 cached 資料 + offline banner |
| DDD2 | 網路恢復 | 自動 reconnect + sync |
| DDD3 | 部分 API 500 | 局部錯誤 toast，其他功能正常 |

---

## 執行優先級

| 優先級 | 劇本 | 說明 |
|--------|------|------|
| **P0 LAUNCH_BLOCKER** | A, B, C, E, G, J, K, M, P, V, Z (Z1-Z5 smoke), KK, LL | 上線必過 |
| **P1 HIGH** | D, F, H, I, L, N, O, Q, R, S, T, W, Y, AA, BB, EE, FF, GG, WW | 發版本前過 |
| **P2 MEDIUM** | U, X, CC, DD, HH, II, MM, NN, OO, TT, UU, VV, XX, YY, ZZ, CCC, DDD | 完整測試輪跑 |
| **P3 LOW** | JJ, PP, QQ, RR, SS, AAA, BBB | 迴歸或特殊情境 |

---

## 執行方式選擇樹

```
測試目標
├── 單元邏輯 / ViewModel        → JVM unit test (src/test/)
├── UI 基本互動                 → Espresso instrumented (src/androidTest/)
├── WebView 內的 web 功能       → 直接用 web 版 Playwright 測試（不重複）
├── Activity 流程 + adb intent  → UI Automator
├── Push 流程                   → Firebase test console + 手動
├── Billing / IAP               → Google Play 測試帳號 + 沙盒
└── 實機效能 / 電量             → Android Profiler
```

---

## 參考

- 對應 Web E2E：`docs/plans/2026-04-12-rental-e2e-test-scenarios.md`
- Android spec：`docs/specs/android-app-spec.md`
- BRM mobile parity gap：`docs/plans/2026-04-14-brm-mobile-parity-gap.md`
- Android UIUX 渲染規範：`docs/specs/android-uiux-rendering-spec.md`
- Android E2E 執行藍圖：`docs/plans/2026-04-14-android-e2e-blueprint.md`
