# Android E2E 執行藍圖

> **日期**：2026-04-14
> **目的**：Android v1.0.64 上線前完整覆蓋 56 劇本 ~330 步驟
> **工具**：Android Studio + Espresso + UI Automator + adb + WebView JavaScriptInterface + backend API 驗證
> **對應**：Web 版 `2026-04-14-playwright-e2e-blueprint.md`

---

## 總覽

| 類別 | Batch | 劇本 | 時間 | 優先級 |
|------|-------|------|------|--------|
| 環境預檢 | 0 | — | 5 min | — |
| 認證 + 導覽 | 1 | A, B, C, D, E, F | 30 min | BLOCKER (A-C, F) |
| Dashboard + Entity | 2 | G, H, I, J, K, L | 25 min | BLOCKER (G, J, K) |
| Chat 原生 | 3 | M, N, O, P, Q, R | 40 min | BLOCKER (M, P) |
| AI Chat | 4 | S, T, U | 15 min | BLOCKER (S) |
| Mission / Kanban | 5 | V, W, X | 20 min | BLOCKER (V) |
| Card Holder + BRM | 6 | Y, Z, AA | 20 min | BLOCKER (Z smoke) |
| File / Env Vars | 7 | BB, CC, DD | 15 min | HIGH |
| Settings + Billing | 8 | EE, FF, GG | 20 min | BLOCKER (FF, GG) |
| Live Wallpaper | 9 | HH, II, JJ | 15 min | MEDIUM |
| Push Notifications | 10 | KK, LL, MM | 15 min | BLOCKER (KK, LL) |
| Widget | 11 | NN, OO, PP | 10 min | MEDIUM |
| Remote Control | 12 | QQ, RR, SS | 12 min | MEDIUM |
| Feedback + Crash | 13 | TT, UU, VV | 8 min | HIGH |
| 跨平台一致性 | 14 | WW, XX, YY | 15 min | BLOCKER (WW) |
| 回歸邊界 | 15 | ZZ, AAA, BBB, CCC, DDD | 25 min | MEDIUM |
| 清理 + 報告 | 16 | — | 5 min | — |
| **合計** | | **56 劇本** | **~275 min** | |

> **LAUNCH_BLOCKER 小計**：~135 min（Batch 0-8 + 10 + 14 精選）

---

## 測試環境準備

### 硬體 / 模擬器

| 設備 | 用途 | API |
|------|------|-----|
| **Pixel 8 emulator** | 主要 CI + 開發測試 | 35 |
| **Pixel 4a 實機** | 中階效能驗證 | 33 |
| **Nexus 5X emulator** | 低階 + 舊版相容 | 24 |
| **Samsung S24 實機**（可選） | OEM skin 驗證 | 34 |

### 測試帳號

| 角色 | 識別 | 備註 |
|------|------|------|
| Owner device | `480def4c-2183-4d8e-afd0-b131ae89adcc` | hank 主裝置，有 #0-#3 entity |
| Renter email | `e2e-renter-test@eclawbot.com` | 一般用戶 flow，會租 bot |
| Billing test user | Google Play Console 測試名單內 | IAP 沙盒 |
| Admin | 獨立 admin 帳號 | 只跑 admin flow（Batch 13 部分） |

### 工具 checklist

```bash
# 必裝
adb                    # 已裝 Android Studio 即有
gradle wrapper         # ./gradlew.bat / ./gradlew
Firebase CLI           # push 測試用 — npm install -g firebase-tools
Google Play Console    # 瀏覽器即可

# 建議
scrcpy                 # 實機鏡像便於錄影
Android Profiler       # Android Studio 內建
Frida                  # Security 測試（劇本 SS 用）
```

---

## Batch 0：環境預檢（5 min）

| # | 動作 | 驗證 |
|---|------|------|
| 0-1 | `adb devices` | 至少一台 connected |
| 0-2 | `./gradlew clean` | 無錯誤 |
| 0-3 | 跑 `docs/specs/android-app-spec.md §14.1` 檢查 | duplicate key / XML / missing key 全 clean |
| 0-4 | `gh run list --branch main -L 3` | Android CI + Backend CI 皆綠 |
| 0-5 | `curl -s https://eclawbot.com/api/health` | uptime > 60s（確認 Railway 已部署最新） |
| 0-6 | 用 Renter email 登入 Web 端 → 記錄 wallet balance | baseline |
| 0-7 | 用 Owner device login 登入 Web 端 → 記錄 wallet + entities | baseline |

---

## Batch 1：認證 + 導覽（30 min） ★ BLOCKER

### 1.1 冷啟動 + 註冊 (A) — 10 min

| Step | 方法 | 驗證 |
|------|------|------|
| A1 | `adb shell pm clear com.hank.clawlive` + 開啟 | Splash → Login，無 crash |
| A2 | 手動切 8 語系逐一截圖 | 無 raw key |
| A3 | 用新 email 註冊 | 成功進 Dashboard |
| A4 | 收信 → 點驗證連結 | Deep link 回 app |
| A5 | 登出 → 點 Google 登入 | Credentials Manager 啟動 |
| A6 | 登出 → 點 Facebook 登入 | WebView OAuth 完成 |

### 1.2 裝置登入 (B) — 5 min

| Step | 方法 | 驗證 |
|------|------|------|
| B1-B3 | UI Automator：填 Device ID/Secret，驗證錯誤 | Toast + 無 crash |
| B4 | 登入後 `adb shell am force-stop ...` → 重開 | Auto re-login |
| B5 | `adb shell am background-activity ...` + 等 12h（或 mock time） | Reconnect |

### 1.3 登出 + 切帳號 (C) — 5 min

| Step | 方法 | 驗證 |
|------|------|------|
| C1-C3 | UI 操作登出 + 重新登入不同帳號 | 無資料混合 |

### 1.4 Deep Links + Push (D) — 5 min

| Step | 方法 | 驗證 |
|------|------|------|
| D1 | `adb shell am start -a VIEW -d "eclaw://chat?entityId=2"` | ChatActivity + filter 預選 #2 |
| D2 | `adb shell am start -a VIEW -d "eclaw://kanban"` | MissionControlActivity |
| D3 | Firebase Console 送測試 push | 點 push → 跳對應頁 |

### 1.5 Bottom Nav (E) — 3 min

| Step | 方法 | 驗證 |
|------|------|------|
| E1-E3 | Espresso：各 bottom nav 項點 3 輪 | 無閃爍、無 leak |

### 1.6 權限 (F) — 2 min

| Step | 方法 | 驗證 |
|------|------|------|
| F1-F5 | 手動觸發各權限流程 | 授權/拒絕/永拒各流程正確 |

---

## Batch 2：Dashboard + Entity（25 min） ★ BLOCKER

### 2.1 Entity Cards (G) — 8 min

| Step | 方法 | 驗證 |
|------|------|------|
| G1-G9 | Espresso：`RecyclerView` 操作 + Glide 載入驗證 | 卡片渲染正確 |

**重點斷言**：
- G2: emoji 用 `TextView` 渲染，URL 用 Glide + `ImageView`
- G4: `badge_rental` view 可見性正確（leased_in / leased_out / null）
- G7: `ClipboardManager` setPrimaryClip 被呼叫

### 2.2 Org Chart (H) — 5 min

| Step | 方法 | 驗證 |
|------|------|------|
| H1-H4 | WebView JS bridge：`org-chart.html` drag-drop | Hierarchy JSON 更新到 `/api/device/org-chart` |

### 2.3 Agent Card + Identity (I) — 4 min

### 2.4 Rental Entity Renter 視角 (J) — 4 min
### 2.5 Leased-Out Owner 視角 (K) — 2 min
### 2.6 Entity CRUD (L) — 2 min

---

## Batch 3：Chat 原生（40 min） ★ BLOCKER

### 3.1 訊息收發 (M) — 10 min

**Espresso 腳本**：
```kotlin
@Test fun m1_filterAllShowsCombinedTimeline() {
    onView(withId(R.id.chip_all)).perform(click())
    onView(withId(R.id.recycler_messages))
        .check(matches(hasDescendant(withText(containsString("Received:")))))
}

@Test fun m3_sentMessageRightAligned() {
    onView(withId(R.id.input_text)).perform(typeText("hello"))
    onView(withId(R.id.btn_send)).perform(click())
    // Check bubble gravity
    onView(withText("hello"))
        .check(matches(isInsideParent(hasLayoutGravity(Gravity.END))))
}
```

| Step | 方法 | 驗證 |
|------|------|------|
| M1-M8 | Espresso + 手動送訊息 | bubble 位置 / source label / reaction / link preview |

### 3.2 媒體訊息 (N) — 10 min

| Step | 方法 | 驗證 |
|------|------|------|
| N1 | Intent 注入 + Photo picker | 上傳進度 → 縮圖 |
| N2-N6 | 分別測各媒體類型 | 渲染正確 |

### 3.3 A2A (O) — 5 min
### 3.4 即時同步 (P) — 5 min ★最關鍵

**雙視窗驗證**：
1. Android：`adb logcat -s Socket` 觀察 connect/disconnect
2. Web（另開 browser）：同帳號登入同個 entity
3. 交叉送訊息，秒錶計時同步速度（應 <3 秒）

### 3.5 日期分隔 (Q) — 3 min
### 3.6 使用限制 (R) — 7 min — 需要等額度耗盡

---

## Batch 4：AI Chat（15 min）

### 4.1 基本 (S) — 5 min ★ BLOCKER

| Step | 方法 | 驗證 |
|------|------|------|
| S1-S6 | UI Automator：FAB click → sheet 操作 | Bottom sheet 高度 + Markwon 渲染 |

### 4.2 錯誤處理 (T) — 5 min
### 4.3 Idle Timeout (U) — 5 min（含 90s 等待）

---

## Batch 5：Mission / Kanban WebView（20 min）

### 5.1 載入 (V) — 5 min ★ BLOCKER

**關鍵斷言**：
- WebView URL query string 含 deviceId + deviceSecret
- `webView.evaluateJavascript("document.title")` 回傳正確
- `webView.evaluateJavascript("document.querySelectorAll('.kanban-col').length")` = 5

### 5.2 Kanban 操作 (W) — 10 min

| Step | 方法 | 驗證 |
|------|------|------|
| W1-W5 | WebView JS 操作（`dispatchEvent`） | 卡片 CRUD 成功 |

### 5.3 Mission Notes (X) — 5 min

---

## Batch 6：Card Holder + BRM（20 min）

### 6.1 Card Holder (Y) — 5 min
### 6.2 BRM Smoke (Z) — 10 min ★ BLOCKER (Z1-Z5)

> **注意**：BRM 完整 28 劇本透過 Web 端 Playwright 驗證。Android 這裡只確認 WebView 嵌入無問題，不重測 BRM 業務邏輯。

| Step | 方法 | 驗證 |
|------|------|------|
| Z1 | Card Holder tab → Community sub-tab | WebView 載入 community.html |
| Z2 | 點 capability chip | 即時過濾（web 層處理） |
| Z3 | 點 listing → modal | Modal 在 WebView 內正常彈出 |
| Z4 | 租借 flow 完整走一次（真的扣 e 幣） | 合約建立成功 |
| Z5 | Back to Dashboard | Rental entity 出現 native list |

### 6.3 My Rentals (AA) — 5 min

> **已知 gap**：Android 無直接入口。透過 Card Holder → Community → Settings WebView 進入，或 deep link `eclaw://my-rentals`。

---

## Batch 7：File / Env Vars（15 min） HIGH

### 7.1 File Manager 基本 (BB) — 6 min
### 7.2 File + Chat 整合 (CC) — 5 min
### 7.3 Env Vars (DD) — 4 min

---

## Batch 8：Settings + Billing（20 min） ★ BLOCKER

### 8.1 Settings 基本 (EE) — 5 min

### 8.2 訂閱 (FF) — 10 min ★最關鍵

**Google Play 沙盒 checklist**：
- [ ] 帳號在 Play Console 測試人員名單
- [ ] License testing enabled
- [ ] Product `eclaw_sub_starter` / `eclaw_sub_pro` / `eclaw_sub_business` 皆 active
- [ ] Server-side verification endpoint 有回 200

| Step | 方法 | 驗證 |
|------|------|------|
| FF1-FF5 | 手動走 IAP 完整 flow | SKU 正確、e-coin 入帳、降級行為 |

### 8.3 E-coin 儲值 (GG) — 5 min

---

## Batch 9：Live Wallpaper（15 min） MEDIUM

### 9.1 設定 (HH) — 3 min
### 9.2 渲染 (II) — 5 min — 實機才能測
### 9.3 效能 (JJ) — 7 min — Profiler 跑

---

## Batch 10：Push Notifications（15 min）

### 10.1 接收 (KK) — 5 min ★ BLOCKER

**Firebase 測試流程**：
```bash
# 1. 取 FCM token
adb logcat -s "FCM" | grep "token"
# 2. Firebase Console → Cloud Messaging → New notification
# 3. 目標：指定 FCM token
# 4. 觀察 app 行為
```

### 10.2 Tap 行為 (LL) — 5 min ★ BLOCKER
### 10.3 設定 (MM) — 5 min

---

## Batch 11：Widget（10 min） MEDIUM

| Step | 方法 | 驗證 |
|------|------|------|
| NN1-PP1 | 手動放桌面 + 觀察 | 渲染 + 更新 + 多 widget |

---

## Batch 12：Remote Control（12 min） MEDIUM

### 12.1 授權 (QQ) — 3 min
### 12.2 控制 (RR) — 5 min — Web 端發指令
### 12.3 安全 (SS) — 4 min — 時限 + notification

---

## Batch 13：Feedback + Crash（8 min） HIGH

### 13.1 Feedback 提交 (TT) — 3 min
### 13.2 Feedback History (UU) — 2 min
### 13.3 Crash + Debug (VV) — 3 min

**故意 crash 方式**：
```kotlin
// Settings → Debug → 按隱藏指令（長按 version 5 次）
// → 觸發 `throw RuntimeException("E2E crash test")`
```

---

## Batch 14：跨平台一致性（15 min） ★ BLOCKER

**雙視窗並排**：
- 左：Android 裝置（scrcpy）
- 右：Chrome 開 eclawbot.com/portal

### 14.1 訊息一致性 (WW) — 5 min ★最關鍵
### 14.2 設定一致性 (XX) — 5 min
### 14.3 Identity 一致性 (YY) — 5 min

---

## Batch 15：回歸邊界（25 min） MEDIUM

### 15.1 App 升級 (ZZ) — 5 min
安裝 v1.0.63 APK → 開 app → 登入 → 升級到 v1.0.64 → 檢查資料

### 15.2 低版本 Android (AAA) — 10 min
跑 API 24 emulator 的完整 smoke

### 15.3 低階硬體 (BBB) — 3 min
### 15.4 多語系邊界 (CCC) — 5 min
### 15.5 網路異常 (DDD) — 2 min
`adb shell svc wifi disable` + `enable` 測試

---

## Batch 16：清理 + 報告（5 min）

| # | 動作 |
|---|------|
| 16-1 | 清除測試帳號產生的假資料 |
| 16-2 | 寫執行結果到 `docs/reports/YYYY-MM-DD-android-e2e-execution-log.md` |
| 16-3 | 失敗項目開 GitHub issue 標 `android-e2e-regression` |
| 16-4 | 更新 `docs/specs/android-app-spec.md §17 Things That Have Bitten Us` |

---

## 快速 Smoke（15 min）— 每次 PR 合併前

僅跑 LAUNCH_BLOCKER 子集：

| # | 劇本 | 時間 |
|---|------|------|
| 0 | 預檢 | 2 min |
| 1 | A3, B1-B2, C1 (auth) | 3 min |
| 2 | E1, F3 (nav + notif perm) | 1 min |
| 3 | G1-G2 (dashboard) | 1 min |
| 4 | M1, M3, M4, P1 (chat sync) | 4 min |
| 5 | S1 (AI chat open) | 1 min |
| 6 | V1 (kanban load) | 1 min |
| 7 | Z1 (BRM WebView load) | 1 min |
| 8 | KK1 (push received) | 1 min |

---

## 進階：自動化策略

| 層級 | 工具 | 覆蓋率目標 |
|------|------|-----------|
| Unit（ViewModel、Repository、Utils） | JUnit + MockK | 80% |
| Integration（Retrofit、Room） | JUnit + MockWebServer + Room test | 60% |
| UI（native screens） | Espresso | 40% P0 劇本 |
| UI（WebView screens） | Playwright（web 端） | 100%（不在 Android 重測） |
| System（push、wallpaper、widget） | 手動 + screenshot | 100% P0 |
| 效能 | Android Profiler + Macrobenchmark | 冒煙即可 |

---

## 失敗處理 SOP

| 情境 | 行動 |
|------|------|
| Emulator 掛掉 | `adb kill-server && adb start-server` → wipe + 重建 AVD |
| WebView 白畫面 | 開 `chrome://inspect` 接 remote debug，看 console error |
| Socket 斷線重連失敗 | 看 `adb logcat -s SocketManager`，檢查 handshake |
| IAP 卡住 | Play Console → Order management → 重新整理測試購買狀態 |
| Push 收不到 | 確認 `google-services.json` 沒誤提交 CI dummy 版本 |

---

## 參考

- Android E2E 測試場景：`docs/plans/2026-04-14-android-e2e-test-scenarios.md`
- Android spec：`docs/specs/android-app-spec.md`
- Android UIUX 渲染規範：`docs/specs/android-uiux-rendering-spec.md`
- Web E2E 藍圖：`docs/plans/2026-04-14-playwright-e2e-blueprint.md`
- Release workflow：`.agent/workflows/release.md`
