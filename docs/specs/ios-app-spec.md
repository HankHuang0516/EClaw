# iOS App 平台規範書 (iOS App Spec)

> **版本**: 1.3.0
> **建立日期**: 2026-04-14
> **最新修訂**: 2026-04-17 — 首頁對齊 Android MainActivity：header 標題改為 "EClawbot"、加入 Edit Mode 與 Org Chart 入口、移除獨立 Dashboard tab（Android 沒有此 tab）
> **適用範圍**: `ios-app/` (React Native + Expo Router)
> **目的**: 定義 iOS App 的架構、導航、UI 規範、功能範圍，作為所有 iOS 改動的唯一標準。
> **依據**: Apple Human Interface Guidelines、[Mobile Parity Gap](../plans/2026-04-14-brm-mobile-parity-gap.md)、CLAUDE.md §Feature Parity Rule

---

## 1. App 定位

| 項目 | 內容 |
|------|------|
| App 名稱 | EClawbot |
| Bundle ID | `com.eclawbot.app` |
| 版本 | 1.0.0（buildNumber 另計） |
| 最低 iOS 版本 | iOS 15.1（Expo SDK 55 要求） |
| 支援裝置 | iPhone + iPad（universal） |
| 方向 | Portrait 為主，chat/kanban 支援 landscape |
| 類別 | Productivity（主） / Social Networking（副） |
| 年齡分級 | 4+ |

---

## 2. 架構總覽

### 2.1 技術堆疊

| 層 | 技術 | 備註 |
|----|------|------|
| UI Framework | React Native 0.83.2 | |
| 路由 | Expo Router (file-based) | `app/` 目錄結構 = 導航 |
| 平台 | Expo SDK 55 | |
| 狀態管理 | React Context + useState | 不引入 Redux |
| HTTP | fetch API + 自訂 `services/api.ts` | |
| 即時通訊 | Socket.IO client | |
| 本地存儲 | `@react-native-async-storage/async-storage` | 替代 localStorage |
| 推播 | `expo-notifications` → APNs | |

### 2.2 檔案結構

```
ios-app/
├── app/                          # Expo Router 頁面
│   ├── _layout.tsx               # Root layout（auth gate）
│   ├── (tabs)/                   # Tab Bar 五大主頁（對齊 Android BottomNavHelper）
│   │   ├── _layout.tsx           # 深色沉浸式 Tab Bar（無 native header）
│   │   ├── index.tsx             # 🏠 WebView dashboard.html（對齊 Android MainActivity）
│   │   ├── chat.tsx              # 💬 聊天（WebView chat.html，對齊 Android ChatActivity）
│   │   ├── mission.tsx           # 📋 Mission Control（WebView mission.html）
│   │   ├── cards.tsx             # 🎴 WebView card-holder.html（對齊 Android CARDS）
│   │   └── settings.tsx          # ⚙️ WebView settings.html
│   ├── org-chart.tsx             # 🗂️ Org Chart modal（WebView dashboard.html?view=orgchart，從首頁 header 入口打開）
│   ├── usage.tsx                 # WebView dashboard.html#usageWidget
│   ├── companion.tsx             # WebView petdx-browser.html
│   ├── mindmap.tsx               # WebView mindmap.html?perfFixture=52
│   ├── plaza.tsx                 # WebView community.html#rental
│   ├── kanban.tsx                # WebView kanban.html#automationSetup
│   ├── ai-chat.tsx               # 🤖 AI 助理
│   ├── wallet.tsx                # 💰 錢包（iOS 必須 native + IAP）
│   ├── my-rentals.tsx            # 租借管理（我的租賃）
│   ├── community.tsx             # 社群 / 市場（Marketplace）
│   ├── file-manager.tsx          # 檔案
│   ├── feedback.tsx              # 意見回饋
│   ├── invite.tsx                # 邀請碼
│   └── official-borrow.tsx       # 官方 Bot 借用
├── components/                   # 共用元件
│   ├── PortalTabScreen.tsx       # 五個主 tab 共用 WebView shell
│   ├── PortalStackScreen.tsx     # Secondary portal route 共用深色 WebView shell
│   ├── WebViewScreen.tsx         # WebView 包裝器（auth 注入 + embed/hideChrome + native tab bridge）
│   ├── EntityCard.tsx            # 舊原生首頁元件，非主要 tab 入口
│   └── BindingCodeCard.tsx       # 舊原生首頁元件，非主要 tab 入口
├── services/                     # API wrapper + Socket + Telemetry
├── store/                        # Context providers
├── hooks/                        # Custom hooks
├── i18n/                         # 多語系
├── assets/                       # 圖示、啟動畫面
├── app.json                      # Expo 配置
└── eas.json                      # EAS Build / Submit 設定
```

> **已移除**：`chat/[entityId].tsx`、`schedule.tsx`、`entity-manager.tsx`、`card-holder.tsx`、`(tabs)/dashboard.tsx` 已廢棄。聊天由 chat tab WebView 處理；Org Chart 由首頁 header button 開啟 `/org-chart` modal。

App Store capture deep links may use deterministic portal anchors or fixtures when they only change presentation. The current capture routes open a mindmap graph fixture, the rental filter, and the Kanban nudge settings; none of these routes submit cards, create rentals, or mutate backend data by themselves.

### 2.3 Tab Bar 五大主頁（不可變更，對齊 Android `BottomNavHelper`）

| Tab | 圖示 | 路由 | 內容 |
|-----|------|------|------|
| 🏠 首頁 | `home` | `(tabs)/index` | WebView 載入 `/portal/dashboard.html`（詳見 §3.4） |
| 💬 聊天 | `chat` | `(tabs)/chat` | WebView 載入 `/portal/chat.html`（詳見 §3.5） |
| 📋 任務 | `target` | `(tabs)/mission` | WebView 載入 `/portal/mission.html` |
| 🎴 名片 | `card-account-details` | `(tabs)/cards` | WebView 載入 `/portal/card-holder.html` |
| ⚙️ 設定 | `cog` | `(tabs)/settings` | WebView 載入 `/portal/settings.html` |

> **重要**：五個主 tab 必須全部與 Android 的 app shell 體驗一致 — 由 Expo tab shell 承載 portal WebView，tab bar 始終可見，不得在主 tab 重新建立第二套原生 RN UI。

> **v1.4.0 對齊修正**：Home/Cards/Settings 不再使用原生 RN route。iOS 五個 bottom tab 全部走 `PortalTabScreen` + `WebViewScreen`，並由 `WebViewScreen` 注入 `embed=1`、`hideChrome=1`、auth credentials 和 `EClawNativeNav`。

---

## 3. 功能範圍決策

### 3.1 Native vs WebView 決策矩陣

對每個功能，依以下標準決定採用原生或 WebView：

| 標準 | 選 Native | 選 WebView |
|------|----------|-----------|
| 涉及 Apple IAP / 支付 | ✅ 必須 | ❌ 會被 Apple 拒 |
| 高頻使用（每日） | ✅ | ⚠️ 考慮 |
| 低頻/複雜表單 | ⚠️ | ✅ 可接受 |
| 重度互動（drag/drop） | ✅ | ⚠️ |
| 需相機/檔案存取 | ✅ 透過 Expo API | ⚠️ 權限問題 |
| 跨裝置訊息預覽 | ✅ | ❌ 會失去推播整合 |

> **主 tab 覆寫規則**：不論上表一般決策，iOS bottom tabs 在目前版本一律選 WebView，因為 Android 已將主要資訊架構收斂到 portal WebView；新增主 tab 或修改現有主 tab 時，必須先確認對應 portal URL 與 Android 入口。

### 3.2 現況分類

| 功能 | 實作方式 | 對齊 Android | 上架前優先級 |
|------|---------|-------------|-------------|
| 首頁 Dashboard / Entity 管理 | WebView `dashboard.html` | ✅ 對齊 Android MainActivity WebView（詳見 §3.4） | P0 |
| Org Chart（組織圖） | `dashboard.html` 內 portal 入口 / `/org-chart` WebView fallback | ✅ 與 Android 共用 `dashboard.html` | P0 |
| **聊天** | **WebView chat.html** | ✅ 對齊 ChatActivity（詳見 §3.5） | P0 |
| AI 助理 | Native | ✅ | — |
| Mission Control | WebView mission.html | ✅ | — |
| Card Holder | WebView `card-holder.html` | ✅ 對齊 Android CARDS WebView（詳見 §3.6） | — |
| 設定 | WebView `settings.html` | ✅ 由 portal 與 Android settings surface 收斂 | P0 |
| **Wallet** | WebView | 🔴 **必改 Native + IAP** | P0 |
| My Rentals | WebView wrapper | 🟡 可保留但加 native entry | P1 |
| Community / Marketplace | WebView | 🟡 可保留但加 native entry | P1 |
| Arena 面試 | ❌ 無 | 🟡 WebView wrapper 即可 | P2 |
| Kanban Board | 透過 Mission 導 WebView | 🟡 可保留 | P2 |
| ~~Entity Manager~~ | ~~Native modal~~ | ❌ **廢棄** — Android 無此頁面，功能已併入首頁 | P0 |
| File Manager | Native | ✅ | — |
| Feedback | Native | ✅ | — |
| ~~card-holder.tsx~~ | ~~Native standalone~~ | ❌ **廢棄** — 與 Cards tab 重複 | P1 |

> **重大變更（v1.1.0）**：聊天頁從「Native 列表 → push 個別聊天頁」改為「WebView chat.html 直接載入」，與 Android ChatActivity 完全一致。`chat/[entityId].tsx` 不再需要。

> **重大變更（v1.2.0）**：Entity Manager 獨立頁面廢棄。Android 沒有 EntityManagerActivity，所有實體管理（rename、avatar、refresh、remove、agent card、cross-device）都在首頁 Edit Mode 內 inline 完成。iOS 首頁已支援 tap avatar（picker）、tap name（rename）、long press（ActionSheet 含 remove/agent card），與 Android 對齊。Settings 移除「管理實體」入口。

### 3.3 WebView 使用規範

當必須用 WebView 時：

- ✅ 使用 `react-native-webview`
- ✅ URL 限定 `eclawbot.com` 或子網域，不得開外站
- ✅ 注入 auth token（透過 URL query 或 postMessage）
- ✅ 攔截 `mailto:` / `tel:` 交給系統處理
- ✅ 傳遞 `embed=1` query param 讓 Web Portal 隱藏自身導航列
- ❌ 不得在 WebView 內顯示任何付款頁（違反 Apple §3.1.1）
- ❌ 不得在 WebView 內開啟 TapPay / Stripe iframe
- ✅ WebView 內的 JS 需知道自己在 App 內（透過 User-Agent 偵測 `EClawIOS`）
- ❌ 不得注入 debug banner（DIAG bar 僅限開發階段，上架前必須移除）

### 3.4 首頁 UX 規範（對齊 Android `MainActivity`）

首頁由 `PortalTabScreen` 載入 `/portal/dashboard.html`。Entity 列表、Edit Mode、Org Chart 入口、Entity 卡片、綁定碼、空狀態與輪詢行為都由 portal dashboard 擁有；iOS 不再維護第二套 RN 原生首頁。

| 項目 | iOS | Android | 備註 |
|------|-----|---------|------|
| Host | `WebViewScreen` | `MainActivity` WebView | 兩者都附加 app UA 與 credentials |
| URL | `/portal/dashboard.html?embed=1&hideChrome=1` | `/portal/dashboard.html?embed=1` | iOS 額外用 `hideChrome=1` 隱藏 portal 外層 chrome |
| Header | 無 native header | 無額外 native page header | 由 portal dashboard 自己呈現頁內操作 |
| Tab bar | Expo Tabs 常駐 | `BottomNavHelper` 常駐 | 五個 tab 保持同一 app shell |
| Org Chart | dashboard 內入口 / `/org-chart` fallback | dashboard / org chart WebView | 共用 portal contract |

> **不得恢復原生 Home route**：`(tabs)/index.tsx` 只能是 `/portal/dashboard.html` 的 WebView wrapper。若 dashboard 需要調整外觀或功能，修改 `backend/public/portal/dashboard.html` 與共享 portal 資源，再由 iOS/Android WebView 同步受益。

### 3.5 聊天 UX 規範（對齊 Android `ChatActivity`）

#### 3.5.1 核心架構

聊天 tab **必須**使用 WebView 載入 `chat.html`，不得使用原生 entity 列表。

```
┌──────────────────────────────────────────────┐
│  ┌─ WebView: chat.html ──────────────────┐  │
│  │ [Entity A] [Entity B] [All]  ← chips  │  │
│  │                                        │  │
│  │ 14:23 Bot: Hello!                      │  │
│  │                     You: Hi there 14:24│  │
│  │                                        │  │
│  │ [  Type message...        ] [Send]     │  │
│  └────────────────────────────────────────┘  │
├──────────────────────────────────────────────┤
│  🏠    💬    📋    🎴    ⚙️   (tab bar)     │
└──────────────────────────────────────────────┘
```

#### 3.5.2 與 Android 的對齊點

| 項目 | Android ChatActivity | iOS Chat Tab | 一致性 |
|------|---------------------|-------------|--------|
| 內容 | WebView `eclawbot.com` | WebView `chat.html?embed=1` | ✅ |
| Tab bar | 始終可見（BottomNavHelper） | 始終可見（Expo Tabs） | ✅ |
| Entity 切換 | WebView 內 filter chips | WebView 內 filter chips | ✅ |
| 檔案上傳 | 透過 `fileChooserLauncher` | 透過 WebView file input | ✅ |
| Loading 狀態 | ProgressBar → 成功/失敗 | ActivityIndicator overlay | ✅ |
| 離線處理 | 🦞 emoji + Retry 按鈕 | 同上 | ✅ |
| Back 行為 | WebView history → 退出 Activity | WebView history（tab 無需 back） | ✅ |

#### 3.5.3 實作要點

```typescript
// (tabs)/chat.tsx — 簡化為 WebView wrapper
export default function ChatScreen() {
  return (
    <PortalTabScreen
      url="https://eclawbot.com/portal/chat.html"
      tabId="chat"
    />
  );
}
```

- **不需要** `chat/[entityId].tsx`（個別聊天頁已廢棄）
- **不需要** native entity list 或 push navigation
- 首頁 entity card 點擊 → 切換到 Chat tab + 由 WebView 內 filter chip 選取
- WebView 會自動注入 auth token（透過 `WebViewScreen` 的 URL query）

#### 3.5.4 聊天入口

與 Android 一致，聊天**只能**從底部 Chat tab 進入。首頁 entity 卡片不提供導航到聊天的功能。

用戶要和特定 entity 聊天時：
1. 點底部 Chat tab
2. 在 WebView 內的 chat.html 中使用 filter chips 選擇 entity

> **不需要**從首頁傳遞 entityId 到 chat tab。Android 也沒有此機制。

### 3.6 名片夾 UX 規範（對齊 Android CARDS WebView）

#### 3.6.1 核心架構

名片夾 tab 使用 `PortalTabScreen` 載入 `/portal/card-holder.html`。三區佈局與 Bot Plaza 入口都由 portal 擁有，避免 iOS/Android 各自維護不同的名片夾 UI。

| 區塊 | 說明 | API |
|------|------|-----|
| My Cards | 自己的 agent cards（有 publicCode 的 entity） | portal 呼叫 contacts API |
| Recent | 最近互動的聯絡人，按 `lastInteractedAt` 排序 | portal 呼叫 contacts API |
| Collected | 所有收藏的聯絡人，支援搜尋/篩選 | portal 呼叫 contacts API |

#### 3.6.2 與 Android 的對齊點

| 項目 | Android | iOS 現況 | 一致性 |
|------|---------|---------|--------|
| Host | `WebViewActivity` CARDS | `PortalTabScreen` | ✅ |
| URL | `/portal/card-holder.html?embed=1` | `/portal/card-holder.html?embed=1&hideChrome=1` | ✅ |
| 三區佈局 | portal `card-holder.html` | portal `card-holder.html` | ✅ |
| Bot Plaza tab | portal iframe / sub-tab | portal iframe / sub-tab | ✅ |

> **不得恢復原生 Cards route**：`(tabs)/cards.tsx` 只能是 `/portal/card-holder.html` 的 WebView wrapper。Card Holder 外觀、搜尋、filter、Bot Plaza、Chat History 等都應在 portal page 修正。

### 3.7 設定 UX 規範（WebView parity）

#### 3.7.1 Settings tab 核心架構

Settings tab 使用 `PortalTabScreen` 載入 `/portal/settings.html`，讓帳號、語言、通知、Channel API、檔案、回饋、刪帳等入口與 portal 共用。需要 Apple 原生能力的流程仍可由 settings page 導向 iOS native route。

| 項目 | iOS 主 tab | 備註 |
|------|------------|------|
| 帳號狀態 | WebView settings page | auth credentials 由 `WebViewScreen` 注入 |
| 語言/通知/Channel API | WebView settings page | 與 portal 共用 |
| Wallet / IAP | WebView 入口可導向 native Apple IAP route | 不得在 WebView 內處理外部付款 |
| 檔案/回饋/邀請 | WebView 入口或 existing native route | 入口由 portal 決定 |
| 管理實體 | dashboard WebView | 不在 Settings 建立獨立 Entity Manager |

> **不得恢復原生 Settings 主 tab**：`(tabs)/settings.tsx` 只能是 `/portal/settings.html` 的 WebView wrapper。需要 native capability 時，從 portal entry 導向獨立 native route，不要把 bottom tab 本身改回 native list。

---

## 4. UI 規範（Apple HIG 合規）

### 4.1 顏色

遵循系統主題，支援深色模式：

```typescript
// 使用 useColorScheme()
const colorScheme = useColorScheme(); // 'light' | 'dark'
```

**品牌色**：`#7E57C2`（紫）— 與 Web Portal 一致
**強調色**：`#00C853`（綠，成功、加值按鈕）
**警告色**：`#FF5252`（紅，刪除、違規）

### 4.2 字型

- iOS 系統字型：`San Francisco`（SF Pro）
- 不得嵌入自訂中文字型（增加 bundle size，Review 會擋）
- 中文字支援：使用系統字體自動回退

### 4.3 圖示規範

**App Icon**：
- 1024×1024 PNG，無透明通道、無圓角（Apple 自動加圓角）
- 位置：`ios-app/assets/icon.png`
- 現況：✅ 存在，尺寸正確

**各尺寸**（Expo 會自動產生，不需手動提供）：
- 20pt (1x/2x/3x), 29pt, 40pt, 60pt, 76pt, 83.5pt, 1024pt

**Launch Screen / Splash**：
- 位置：`ios-app/assets/splash.png`
- 背景色 `#7E57C2`（與 `app.json` 同步）
- 避免文字（避免未 localized 的 Review 風險）

### 4.4 安全區（Safe Area）

- ✅ 所有 Screen 包 `<SafeAreaView>` 或使用 `useSafeAreaInsets()`
- ✅ Tab Bar 底部自動 respect home indicator

### 4.5 觸控目標

- 最小 44×44 points（HIG 要求）
- 圖示按鈕：48×48
- 列表項目高度：≥ 44

### 4.6 Haptic Feedback

使用 `expo-haptics`：
- 按鈕點擊：`Haptics.selectionAsync()`
- 成功動作：`Haptics.notificationAsync(Success)`
- 刪除、錯誤：`Haptics.notificationAsync(Warning / Error)`

---

## 5. 權限規範（Info.plist NSUsageDescription）

現況已設定（`app.json`）：

| 權限 | Info.plist Key | 說明文字（需 localized） |
|------|---------------|---------------------|
| 相機 | `NSCameraUsageDescription` | 「EClawbot 需要相機以拍攝頭像或附件」 |
| 相簿（讀） | `NSPhotoLibraryUsageDescription` | 「EClawbot 需要存取相簿以選擇頭像或附件」 |
| 相簿（寫） | `NSPhotoLibraryAddUsageDescription` | 「EClawbot 需將圖片儲存至您的相簿」 |
| 麥克風 | `NSMicrophoneUsageDescription` | 「EClawbot 需要麥克風錄製語音訊息」 |

**重要**：每個權限都必須**說明具體用途**，含糊的「為了 App 功能」會被 Review 拒。

### 5.1 Privacy Manifest（2024-05 起強制）

需建立 `ios-app/ios/PrivacyInfo.xcprivacy`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>NSPrivacyCollectedDataTypes</key>
    <array>
        <dict>
            <key>NSPrivacyCollectedDataType</key>
            <string>NSPrivacyCollectedDataTypeEmailAddress</string>
            <key>NSPrivacyCollectedDataTypeLinked</key>
            <true/>
            <key>NSPrivacyCollectedDataTypeTracking</key>
            <false/>
            <key>NSPrivacyCollectedDataTypePurposes</key>
            <array>
                <string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
            </array>
        </dict>
        <!-- 其他資料類型：UserID, DeviceID, ProductInteraction 等 -->
    </array>
    <key>NSPrivacyAccessedAPITypes</key>
    <array>
        <dict>
            <key>NSPrivacyAccessedAPIType</key>
            <string>NSPrivacyAccessedAPICategoryUserDefaults</string>
            <key>NSPrivacyAccessedAPITypeReasons</key>
            <array>
                <string>CA92.1</string>
            </array>
        </dict>
        <!-- FileTimestamp, SystemBootTime, DiskSpace -->
    </array>
    <key>NSPrivacyTracking</key>
    <false/>
</dict>
</plist>
```

---

## 6. 認證規範

採用**方案 C：完整帳號系統**（方案 A/B 已棄用，詳見 [iOS Auth Implementation Plan](../plans/2026-04-14-ios-auth-implementation-plan.md)）。

### 6.1 支援的登入方式

| 方式 | iOS | 後端 endpoint | 備註 |
|------|-----|--------------|------|
| **Email + 密碼** | ✅ 主要 | `POST /api/auth/login` + `/register` | 跨平台通用 |
| **Sign in with Apple** | ✅ 必加 | `POST /api/auth/oauth/apple`（新增） | Apple §4.8 強制 |
| **Google OAuth** | ✅ | `POST /api/auth/oauth/google` | 觸發 §4.8，須與 Apple 並存 |
| **Facebook OAuth** | ✅ | `POST /api/auth/oauth/facebook` | 觸發 §4.8，須與 Apple 並存 |
| **裝置認證** | ✅ 進階 | `POST /api/auth/device-login` | 保留向下相容，預設折疊 |

**Apple §4.8 關鍵**：一旦 App 提供 Google / Facebook / Twitter 等第三方登入，**必須**同時提供 Sign in with Apple。四者並存，**Sign in with Apple 必須置頂或同等突出**。

### 6.2 Token 管理

**儲存位置**：`expo-secure-store`（比 AsyncStorage 安全）

| Key | 內容 | 清除時機 |
|-----|------|---------|
| `auth_token` | JWT（30 天） | 登出、過期、刪帳號 |
| `user_id` | user_accounts.id | 登出、刪帳號 |
| `user_email` | 顯示用 | 登出 |
| `device_id` | 裝置識別 | 刪帳號才清 |
| `device_secret` | 裝置認證備援 | 刪帳號才清 |

**API 請求**：`Authorization: Bearer ${authToken}` header，不再把 deviceSecret 塞進 body（除非純裝置認證路徑）。

**過期處理**：JWT 401 → 嘗試用 device credential refresh → 仍失敗 → 清 token 導登入頁。

### 6.3 Sign in with Apple 實作

使用 `expo-apple-authentication`：

```typescript
import * as AppleAuthentication from 'expo-apple-authentication';

<AppleAuthentication.AppleAuthenticationButton
  buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
  buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
  cornerRadius={8}
  style={{ width: '100%', height: 48 }}
  onPress={handleAppleSignIn}
/>
```

按下後取得 `identityToken`、`authorizationCode`，送後端 `POST /api/auth/oauth/apple` 交換 JWT。後端用 Apple JWKS 公鑰驗證 token。

### 6.4 登入頁排版（§2 Login Screen Layout）

```
1. Apple 按鈕（頂部、標準黑色）
2. Google 按鈕
3. Facebook 按鈕
4. ── or ──
5. Email + Password 表單
6. Register / Forgot Password 連結
7. 裝置認證（折疊，標示「進階」）
```

### 6.5 既有用戶遷移

現有純裝置認證用戶（升級前）：
1. App 啟動 → 讀到 device_id + device_secret，無 authToken
2. 自動呼叫 `/api/auth/device-login` 換 JWT
3. 進 Dashboard + 顯示「綁定 Email」banner
4. 用戶可忽略或點按綁定（走 `/api/auth/bind-email`）

### 6.6 刪除帳號（Apple §5.1.1(v) 強制）

Settings → 刪除帳號 → 呼叫 `DELETE /api/auth/account` → 清 SecureStore → 導登入頁。

### 6.7 Settings — Developer Section

Settings 頁面包含一個可折疊的「Developer」區塊，將以下功能分組：

| 功能 | 說明 | Android 實作 |
|------|------|-------------|
| Crash Logs | 閃退紀錄檢視器 | `CrashLogViewerActivity` |
| Debug Logs | 除錯日誌檢視器 | `DebugLogViewerActivity` |
| Broadcast Settings | 廣播偏好設定 | 可折疊子區塊 |
| Remote Control | 遠端控制設定 | 可折疊子區塊 |

**行為**：
- 預設折疊，點擊標題展開
- 展開箭頭旋轉 180° 動畫
- Crash Logs 顯示數量 badge（如有未讀紀錄）
- Broadcast Settings / Remote Control 為巢狀折疊區塊

**iOS 實作**：使用 `DisclosureGroup` 或自訂可折疊 `Section`，與 Android 視覺一致。

---

## 7. 通訊規範

### 7.1 HTTP Base URL

```typescript
const API_BASE = __DEV__
  ? 'https://eclawbot.com'  // 一律用 prod，不搞 localhost
  : 'https://eclawbot.com';
```

### 7.2 Socket.IO

- 連線到 `wss://eclawbot.com`
- 認證：query `?deviceId=X&deviceSecret=Y`（或 JWT）
- 房間：`device:{deviceId}`
- 事件：`entity:update`, `chat:new`, `chat:reaction`

### 7.3 推播（APNs）

- 取得 token：`Notifications.getDevicePushTokenAsync()`
- 註冊到後端：`POST /api/notifications/register-ios`
  - Body: `{ deviceId, apnsToken, bundleId }`
- 後端：`notifications.js` 已支援 FCM，需新增 APNs 分支

### 7.4 Deep Link / Universal Link

- URL Scheme：`eclawbot://`（app.json 已設定）
- Universal Link：`https://eclawbot.com/...`（需 `associatedDomains`）
- 後端需放 `/.well-known/apple-app-site-association`

---

## 8. 跨平台 Feature Parity

### 8.1 必須與 Web/Android 一致的功能

| 功能 | Web | Android | iOS | 備註 |
|------|-----|---------|-----|------|
| Entity CRUD | ✅ | ✅ | ✅ | |
| **首頁 Entity Card** | ✅ Dashboard | ✅ Dashboard WebView | ✅ Dashboard WebView | 由 `portal/dashboard.html` 共用（§3.4） |
| **聊天** | ✅ chat.html | ✅ WebView chat | ✅ WebView chat | 已定義 §3.5 |
| AI 助理 | ✅ | ✅ | ✅ | |
| Mission Control | ✅ | ✅ | ✅ WebView | |
| Kanban | ✅ | ⚠️ WebView | ⚠️ WebView | 可接受 |
| Card Holder | ✅ | ✅ WebView | ✅ WebView | `portal/card-holder.html` 共用（§3.6） |
| Wallet | ✅ | ✅ Google Play | 🔴 **需 IAP** | |
| BRM Marketplace | ✅ | ⚠️ WebView | ⚠️ WebView | 可接受 |
| My Rentals | ✅ | ⚠️ WebView | ⚠️ WebView | 可接受 |
| Arena 面試 | ✅ | ❌ | ❌ | 上架前需 WebView wrapper |
| Org Chart | ✅ | ✅ WebView (`dashboard.html`) | ✅ WebView (`dashboard.html`) | 三平台共用 `portal/dashboard.html`，drag/drop + 4 模式一致 |

### 8.2 差異可接受的項目

- 深色模式：iOS 跟系統，Android 跟系統，Web 自選
- Haptic feedback：僅 iOS + Android 有
- Widget：Android 有首頁 widget，iOS 未實作（P3）

---

## 9. 建置與發行

### 9.1 EAS Build 設定

`eas.json` 需填入：

```json
{
  "cli": { "version": ">= 5.0.0" },
  "build": {
    "development": { "developmentClient": true, "distribution": "internal" },
    "preview": { "distribution": "internal", "ios": { "simulator": true } },
    "production": {
      "ios": {
        "autoIncrement": true,
        "resourceClass": "m-medium"
      }
    }
  },
  "submit": {
    "production": {
      "ios": {
        "appleId": "hank@eclawbot.com",
        "ascAppId": "1234567890",
        "appleTeamId": "ABC123XYZ"
      }
    }
  }
}
```

### 9.2 版本號規範

- `version`（marketing version）：`1.0.0` 主版本號，遇重大改版才升
- `buildNumber`：EAS autoIncrement，每次 submit 自動 +1
- 與 Android 保持一致性：iOS 1.0.x ↔ Android 1.0.x

---

## 10. 禁止行為（Apple 會拒的紅線）

- ❌ **iOS 加值走 IAP 以外的任何管道**（參見 [ios-iap-spec.md](./ios-iap-spec.md)）
- ❌ 若有 Google/FB 登入，**沒有 Sign in with Apple**
- ❌ 缺少 `PrivacyInfo.xcprivacy`
- ❌ Info.plist 權限說明含糊（例如：「為了 App 功能」）
- ❌ 開啟外部瀏覽器到付款頁
- ❌ 提示用戶「網頁版更便宜」
- ❌ 使用未宣告的 Required Reason API
- ❌ 上架時開發者連結指向 404
- ❌ 沒有測試帳號給審查員
- ❌ App 功能需要 Jailbreak 或 side-load
- ❌ 儲存 Apple IAP `transactionId` 但不驗證 receipt

---

## 11. 版本歷史

| 版本 | 日期 | 說明 |
|------|------|------|
| 1.2.0 | 2026-04-17 | 名片夾對齊 Android（§3.6）；Settings 移除「管理實體」入口（§3.7）；entity-manager.tsx + card-holder.tsx 標記廢棄；實體管理全部併入首頁 |
| 1.1.0 | 2026-04-16 | 首頁 + 聊天頁對齊 Android（經實際程式碼驗證）：Chat tab 改為 WebView chat.html（廢棄 native list + push）；首頁 entity card 豐富化（XP bar、狀態 badge、最後訊息）但不作為導航入口（對齊 Android：card 是管理用，非聊天入口）；新增 §3.4/§3.5 詳細 UX 規範；移除 DIAG debug banner；Root Stack 預設 headerShown:true |
| 1.0.0 | 2026-04-14 | 初版，定義 iOS App 架構、UI、認證、通訊、feature parity、合規要求 |

---

> **關鍵提醒**：本文件為 iOS 上架的唯一標準。任何與本規範不符的實作或改動均視為 bug，應優先修復。
