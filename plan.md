# Plan: Android Chat → WebView Migration

## 目標
將 Android 原生 ChatActivity（~3,100 行 Kotlin）替換為 WebView 載入 Web Portal 的 `chat.html`，一勞永逸解決訊息渲染邏輯不一致的問題。

## 架構設計

### 核心策略
- **ChatActivity.kt** 改為只包含：WebView + 底部導航列（BottomNavHelper）
- **WebView** 載入 `https://eclawbot.com/portal/chat.html`（production URL）
- **JS Bridge** (`window.AndroidBridge`) 處理原生功能：Widget 更新、Toast、Telemetry
- **認證**：透過 JS Bridge 提供 deviceId/deviceSecret，chat.html 偵測 WebView 環境後自動以 device credentials 認證

### 保留 vs. 移除

| 元素 | 動作 | 理由 |
|------|------|------|
| BottomNavHelper | **保留** | 底部導航是全 App 共用 |
| AiChatFabHelper | **保留** | AI 聊天浮動按鈕 |
| ChatAdapter.kt | **移除** | 渲染由 WebView 處理 |
| ChatRepository.kt | **保留但降級** | Widget 仍需讀取最後訊息；移除 syncFromBackend/processEntityMessage 等複雜邏輯 |
| ChatDatabase/Room | **保留但降級** | Widget 用；但不再做即時同步 |
| EntityChipHelper | **移除** | 實體選擇由 Web UI 處理 |
| SlashCommandRegistry | **移除** | 斜線指令由 Web UI 處理 |
| ChatIntegrityValidator | **移除** | 不再需要雙層驗證 |
| ChatPreferences | **部分保留** | Widget 需要的欄位保留 |
| StateRepository 中的 chat 邏輯 | **移除** | processEntityMessage、processMessageQueue 不再需要 |

## 實作步驟

### Step 1: 建立 WebView 基礎設施
**檔案**: 新增 `app/.../ui/chat/ChatWebViewManager.kt` (~150 行)

- WebView 設定：
  - `javaScriptEnabled = true`
  - `domStorageEnabled = true`（localStorage 支援）
  - `mediaPlaybackRequiresUserGesture = false`（語音播放）
  - `mixedContentMode = MIXED_CONTENT_ALWAYS_ALLOW`
  - `allowFileAccess = true`
- WebChromeClient：
  - `onShowFileChooser()` — 系統檔案選擇器（相機、圖庫、通用檔案）
  - `onPermissionRequest()` — 麥克風權限轉交
  - `onConsoleMessage()` — 轉發到 Timber log
- WebViewClient：
  - `onPageFinished()` — 隱藏載入動畫
  - `onReceivedError()` — 顯示重試畫面
  - `shouldOverrideUrlLoading()` — 外部連結用系統瀏覽器開啟
- Cookie 管理：
  - `CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)`
  - 確保 session cookie 在 App 重啟後持久化

### Step 2: JS Bridge 介面
**檔案**: 新增 `app/.../ui/chat/ChatJsBridge.kt` (~80 行)

```kotlin
class ChatJsBridge(private val activity: ChatActivity) {
    @JavascriptInterface
    fun updateWidget(lastMessage: String)  // 更新首頁 Widget

    @JavascriptInterface
    fun showToast(message: String)  // 原生 Toast

    @JavascriptInterface
    fun getDeviceId(): String  // 提供認證資訊

    @JavascriptInterface
    fun getDeviceSecret(): String  // 提供認證資訊

    @JavascriptInterface
    fun log(level: String, message: String)  // Timber 日誌

    @JavascriptInterface
    fun getAppVersion(): String  // 版本資訊
}
```

### Step 3: 改造 ChatActivity.kt
**檔案**: `app/.../ChatActivity.kt` (從 1,411 行精簡到 ~200 行)

**新的 onCreate 流程**：
1. setContentView (新 layout：WebView + 載入動畫 + 底部導航)
2. 初始化 BottomNavHelper、AiChatFabHelper
3. 初始化 WebView + 注入 JS Bridge
4. 載入 `https://eclawbot.com/portal/chat.html`
5. 處理 Intent extras（深連結、指定實體等）

**保留的原生能力**：
- `onBackPressed` → WebView.canGoBack() 優先
- `onActivityResult` → 轉交 WebChromeClient 的檔案選擇結果
- 權限處理（CAMERA、RECORD_AUDIO）
- 底部導航切換
- AI Chat FAB

**刪除**（~1,200 行）：
- RecyclerView/ChatAdapter 初始化
- Entity chip 載入邏輯
- 訊息發送流程
- 語音錄製邏輯
- 檔案選擇邏輯
- 斜線指令自動完成
- pollEntityMessages 輪詢
- 訊息過濾 UI
- Contact 管理 UI

### Step 4: 新增 WebView 專用 Layout
**檔案**: 新增/修改 `app/.../res/layout/activity_chat.xml`

```xml
<FrameLayout>
    <!-- WebView 佔滿整個畫面 -->
    <WebView android:id="@+id/webViewChat"
        android:layout_width="match_parent"
        android:layout_height="match_parent" />

    <!-- 載入動畫（WebView 載入完成後隱藏）-->
    <ProgressBar android:id="@+id/loadingIndicator"
        android:layout_gravity="center" />

    <!-- 離線錯誤畫面 -->
    <LinearLayout android:id="@+id/offlineView"
        android:visibility="gone">
        <TextView text="@string/chat_offline_message" />
        <Button text="@string/retry" />
    </LinearLayout>

    <!-- AI Chat FAB -->
    <FloatingActionButton android:id="@+id/fabAiChat" />

    <!-- 底部導航 -->
    <BottomNavigationView android:id="@+id/bottomNav" />
</FrameLayout>
```

### Step 5: Web Portal chat.html 適配
**檔案**: `backend/public/portal/chat.html` (+50 行)

在 chat.html 頂部新增 WebView 偵測與適配邏輯：

```javascript
const isAndroidWebView = typeof AndroidBridge !== 'undefined';

if (isAndroidWebView) {
    // 1. 隱藏 Web 導航列和 footer（Android 有自己的）
    document.addEventListener('DOMContentLoaded', () => {
        document.querySelector('.navbar')?.remove();
        document.querySelector('footer')?.remove();
        // 調整 body padding（移除 nav 佔用的空間）
        document.body.style.paddingTop = '0';
        document.body.style.paddingBottom = '0';
    });

    // 2. 認證 — 用 Bridge 取得 device credentials
    window._androidDeviceId = AndroidBridge.getDeviceId();
    window._androidDeviceSecret = AndroidBridge.getDeviceSecret();

    // 3. 覆寫 sendMessage 成功 callback，通知 Widget
    const _origSend = window.sendMessage;
    window.sendMessage = async function(...args) {
        const result = await _origSend.apply(this, args);
        try { AndroidBridge.updateWidget(args[0]); } catch(e) {}
        return result;
    };
}
```

在 `auth.js` 中新增 WebView 認證路徑：
```javascript
// 若是 Android WebView 且無 session cookie，
// 用 Bridge 提供的 device credentials 做 device-login
if (isAndroidWebView && !currentUser) {
    const deviceId = window._androidDeviceId;
    const deviceSecret = window._androidDeviceSecret;
    // POST /api/auth/device-login 取得 session
}
```

### Step 6: 清理移除的程式碼

**可刪除的檔案**：
- `app/.../ui/chat/ChatAdapter.kt` (667 行)
- `app/.../ui/chat/SlashCommandRegistry.kt`
- `app/.../ui/chat/EntityChipHelper.kt`
- `app/.../ui/chat/ChatIntegrityValidator.kt`
- `app/.../ui/chat/LinkPreviewHelper.kt`
- `app/.../ui/chat/RecordingIndicatorHelper.kt`

**簡化的檔案**：
- `ChatRepository.kt`：移除 syncFromBackend()、processEntityMessage() 等（~500 行）
- `StateRepository.kt`：移除 processMessageQueue()、chat 相關邏輯
- `ChatPreferences.kt`：只保留 Widget 需要的欄位

### Step 7: 測試驗證

**功能測試清單**：
- [ ] WebView 載入 chat.html 成功
- [ ] 自動認證（device credentials）
- [ ] 發送文字訊息
- [ ] 接收即時訊息（Socket.IO）
- [ ] 圖片上傳（相機 + 圖庫）
- [ ] 語音錄製與播放
- [ ] 檔案上傳
- [ ] 訊息反應（like/dislike）
- [ ] 實體選擇（tab bar）
- [ ] 斜線指令
- [ ] 連結預覽
- [ ] Widget 更新
- [ ] 離線處理
- [ ] 返回鍵行為
- [ ] 螢幕旋轉保持狀態
- [ ] 底部導航切換
- [ ] 深連結開啟
- [ ] i18n 語言同步

## 風險與緩解

| 風險 | 影響 | 緩解措施 |
|------|------|----------|
| WebView 載入慢 | UX 降級 | 載入動畫 + 後續可做 Service Worker 快取 |
| 離線無法使用 | 功能中斷 | 離線提示 + 重試按鈕（原生 chat 也需要網路） |
| Cookie 過期 | 認證失敗 | JS Bridge 自動重新注入 credentials |
| 語音錄製 | Web Audio API 可能不支援 | Android WebView 自 Chrome 53+ 支援 getUserMedia |
| 相機選擇器 | File input 不好用 | WebChromeClient.onShowFileChooser 提供原生選擇器 |

## 預估改動量

| 操作 | 行數 |
|------|------|
| 新增 ChatWebViewManager.kt | +150 行 |
| 新增 ChatJsBridge.kt | +80 行 |
| 新增/修改 activity_chat.xml | +40 行 |
| 改造 ChatActivity.kt | -1,200 行 / +100 行 |
| 修改 chat.html (WebView 適配) | +50 行 |
| 修改 auth.js (WebView 認證) | +20 行 |
| 刪除 ChatAdapter.kt 等 UI helpers | -967 行 |
| 簡化 ChatRepository.kt | -500 行 |
| 簡化 StateRepository.kt | -50 行 |
| **淨減少** | **~2,300 行 Kotlin** |
