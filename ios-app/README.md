# E-Claw iOS App

React Native + Expo 開發的 iOS App。App shell 保留 iOS 登入、推播、原生能力與底部 tab；五個主要 tab 全部載入 EClawbot Portal WebView，與 Android App 的 WebView 入口保持一致。

## 開發環境需求（Windows）

- **Node.js**: v18+ （已測試 v24）
- **npm**: v9+
- **iPhone**: 安裝 [Expo Go](https://apps.apple.com/app/expo-go/id982107779)（App Store 免費）
- 無需 Mac、無需 Xcode！

## 快速開始

```bash
cd ios-app
npx expo start
```

啟動後會顯示 QR Code，用 iPhone 相機掃描即可在 Expo Go 中開啟 App。

> 如果 QR Code 無法連線，嘗試切換到 **Tunnel** 模式：
> ```bash
> npx expo start --tunnel
> ```

## 專案結構

```
ios-app/
├── app/                    # Expo Router 頁面
│   ├── (tabs)/
│   │   ├── index.tsx       # WebView: /portal/dashboard.html
│   │   ├── chat.tsx        # WebView: /portal/chat.html
│   │   ├── mission.tsx     # WebView: /portal/mission.html
│   │   ├── cards.tsx       # WebView: /portal/card-holder.html
│   │   └── settings.tsx    # WebView: /portal/settings.html
│   ├── chat/[entityId].tsx # 個人聊天頁
│   ├── entity-manager.tsx  # 實體管理
│   ├── schedule.tsx        # 排程管理
│   ├── file-manager.tsx    # 檔案管理器
│   ├── ai-chat.tsx         # AI 助手聊天
│   ├── usage.tsx           # WebView: /portal/dashboard.html#usageWidget
│   ├── companion.tsx       # WebView: /portal/petdx-browser.html
│   ├── mindmap.tsx         # WebView: /portal/mindmap.html?perfFixture=52
│   ├── plaza.tsx           # WebView: /portal/community.html#rental
│   ├── kanban.tsx          # WebView: /portal/kanban.html#automationSetup
│   ├── official-borrow.tsx # 官方機器人租賃
│   └── feedback.tsx        # 反饋系統
├── services/
│   ├── api.ts              # 所有 API 端點（Axios）
│   ├── socketService.ts    # Socket.IO 實時通信
│   └── notificationService.ts  # APNs 推播通知
├── store/
│   ├── authStore.ts        # 認證狀態（Zustand）
│   ├── entityStore.ts      # 實體狀態
│   └── chatStore.ts        # 聊天狀態
├── i18n/                   # 8 種語言翻譯
│   ├── en.json, zh-TW.json, zh-CN.json
│   ├── ja.json, ko.json, th.json, vi.json, id.json
│   └── index.ts
├── components/
│   ├── PortalTabScreen.tsx # 五個主 tab 共用的 WebView shell
│   ├── PortalStackScreen.tsx # 子頁 WebView 共用深色 shell
│   ├── WebViewScreen.tsx   # auth 注入、embed/hideChrome、native tab bridge
│   ├── EntityCard.tsx      # 舊原生首頁元件，非主要 tab 入口
│   └── BindingCodeCard.tsx # 舊原生首頁元件，非主要 tab 入口
├── hooks/
│   ├── useEntities.ts      # 實體列表 + 5s 輪詢
│   └── useChat.ts          # 聊天歷史 + 分頁
├── app.json                # Expo 配置（bundleId, permissions）
├── eas.json                # EAS Build 配置
└── package.json
```

## 主 Tab WebView Contract（對齊 Android）

五個底部 tab 必須都是 WebView，不再維護第二套 RN 原生主頁 UI：

| Tab | iOS route | Portal URL | Android 對應 |
|-----|-----------|------------|--------------|
| Home | `(tabs)/index` | `/portal/dashboard.html` | `MainActivity` WebView |
| Chat | `(tabs)/chat` | `/portal/chat.html` | `ChatActivity` WebView |
| Mission | `(tabs)/mission` | `/portal/mission.html` | `MissionControlActivity` WebView |
| Cards | `(tabs)/cards` | `/portal/card-holder.html` | `WebViewActivity` CARDS |
| Settings | `(tabs)/settings` | `/portal/settings.html` | Settings portal fallback / app settings surface |

所有 tab 透過 `PortalTabScreen` → `WebViewScreen` 載入，並自動附加 `embed=1`、`hideChrome=1`、`deviceId`、`deviceSecret`、`authToken`。`WebViewScreen` 會注入 `EClawNativeNav`，讓 portal 頁面可以在 iOS shell 內切換 `home/chat/mission/cards/settings`。

Secondary app routes that open existing portal features also use `PortalStackScreen` + `WebViewScreen`: `usage`, `companion`, `mindmap`, `plaza`, `kanban`, `org-chart`, `community`, `my-rentals`, and `invite`. The App Store capture routes intentionally land on screenshot-stable feature anchors for the mindmap graph, rental listing filter, and Kanban nudge settings without mutating backend data.

## 功能清單（對齊 Android）

| 功能 | 狀態 |
|-----|------|
| 主首頁（Portal Dashboard） | ✅ WebView |
| 廣播發送 | ✅ WebView |
| 聊天頁面（文字 + 圖片 + 語音） | ✅ WebView |
| Mission Control / Kanban / Notes | ✅ WebView |
| JIT 變數批准對話框 | ✅ Portal / WebView |
| AI 助手聊天（含圖片分析） | ✅ |
| 官方機器人租賃 | ✅ |
| 設定頁面（帳戶/語言/通知） | ✅ WebView |
| 實體管理（重命名/頭像/移除） | ✅ WebView |
| 排程管理 | ✅ |
| 檔案管理器 | ✅ |
| 反饋系統（含截圖上傳） | ✅ |
| 8 種語言（EN/TW/CN/JP/KR/TH/VI/ID） | ✅ |
| Socket.IO 實時通信 | ✅ |
| APNs Push 通知 | ✅ |
| **跳過功能** | |
| Live Wallpaper | ❌（iOS 不支援）|
| 遠端螢幕控制 | ❌（iOS 限制） |

## 發佈到 TestFlight（免 Mac）

### 步驟 1：設定 EAS Build

```bash
# 安裝 EAS CLI
npm install -g eas-cli

# 登入 Expo 帳號（免費）
eas login

# 建立 iOS 建置
eas build --platform ios --profile preview
```

> ⚠️ 需要 Apple Developer 帳號（$99/年）

### 步驟 2：提交到 App Store Connect

```bash
eas submit --platform ios --latest
```

### 步驟 3：TestFlight 測試

在 App Store Connect 中邀請測試者，他們可以直接從 TestFlight 安裝測試版。

## iOS vs Android 差異

| 功能 | Android | iOS |
|-----|---------|-----|
| Push 通知 | Firebase FCM | APNs |
| 五個底部 tab | Android WebView / native shell | WebView / Expo tab shell |
| 付款訂閱 | Google Play Billing | Apple IAP (待實作) |
| 付款租賃 | TapPay 信用卡 | Apple IAP 或 Safari 外部連結 |
| Live Wallpaper | ✅ | ❌ |
| 遠端控制 | ✅ | ❌ |

## 環境變數

App 不需要 `.env` 文件，認證資訊（deviceId/deviceSecret）儲存在 iOS Keychain（SecureStore）中。

## API 連線

預設連接 `https://eclawbot.com`，在 `services/api.ts` 的 `BASE_URL` 修改。

## 相依套件版本

- Expo SDK: ~55
- React Native: 0.83
- React: 19
- Socket.IO Client: ^4
- Zustand: ^5
- i18next: ^25
- React Native Paper: Material Design 3
