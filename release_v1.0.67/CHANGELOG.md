# Release v1.0.67 - 2026-04-16

## What's New / 更新內容

### English
- [Fix] E-coin topup payment now correctly credits coins — fixed backend auth mismatch between Android device credentials and JWT, reversed consume/verify order
- [Fix] Topup tier dialog upgraded from plain AlertDialog to Material3 BottomSheetDialog with tier cards, prices, and bonus badges
- [Fix] SpeakTo echo prevention — org chart forwarding no longer sends messages back to the original sender
- [Fix] Org chart forwarding is now silent — no duplicate chat bubbles in user's chat view
- [Fix] Activity memory leak fixed — topup callback properly cleaned up in onDestroy
- [Improve] Topup dialog fully localized with i18n string resources (en + zh-TW)
- [Improve] i18n: added Malay (ms) 114 keys, Hindi (hi) 112 keys, French/German/Thai/Vietnamese/Indonesian/Arabic/Chinese gap fills (74 keys)
- [Improve] Settings pages (Wallet, My Rentals, Invite, Delete Account) open in in-app WebView
- [Fix] Missing string resources for settings menu items added with translations

### 繁體中文
- [修復] E-coin 儲值付款現在正確入帳 — 修復後端 Android 裝置認證與 JWT 不匹配問題，調整驗證/消費順序
- [修復] 儲值方案對話框從純文字 AlertDialog 升級為 Material3 BottomSheet 卡片式介面，顯示方案名稱、價格與加贈徽章
- [修復] SpeakTo 回聲問題 — 組織圖轉發不再將訊息回傳給原始發送者
- [修復] 組織圖轉發現為靜默模式 — 不再在聊天介面產生重複訊息泡泡
- [修復] Activity 記憶體洩漏修復 — 儲值回調在 onDestroy 中正確清理
- [改進] 儲值對話框完整支援多語系（英文 + 繁體中文）
- [改進] 多語系：新增馬來語 114 個翻譯、印地語 112 個翻譯、法/德/泰/越/印尼/阿拉伯/中文補齊 74 個翻譯
- [改進] 設定頁面（錢包、我的租借、邀請好友、刪除帳戶）使用應用內 WebView 開啟
- [修復] 設定選單缺少的字串資源已補齊並翻譯

## Technical Changes
- Backend: Dual auth (device + JWT fallback) for `/api/wallet/topup/verify-google`
- Backend: `orgChartForward` now accepts `opts.fromEntityId` to prevent sender echo
- Backend: Silent org chart forwarding via `unifiedPush` without `saveChatMessage`
- Android: `BottomSheetDialog` + `MaterialCardView` tier cards for topup UI
- Android: versionCode 72→73, versionName 1.0.66→1.0.67
- Android: Added `bg_bonus_badge` drawable, `dialog_topup_tiers` and `item_topup_tier` layouts
- i18n: ms (114), hi (112), fr/de/th/vi/id/ar/zh (74) translation keys added
