# Release v1.0.12 - 2026-02-18

## What's New / 更新內容

### English
- [Fix] Subscription sync: Google Play purchase now syncs with server to lift daily message limit
- [Improve] BillingManager notifies backend after successful subscription purchase

### 繁體中文
- [修復] 訂閱同步：Google Play 購買後現在會同步到伺服器，解除每日訊息限制
- [改進] BillingManager 在訂閱成功後通知後端更新狀態

## Technical Changes
- Android: `BillingManager.kt` - added server sync call after Google Play purchase acknowledgement
- Android: `ClawApiService.kt` - added `syncSubscription()` API endpoint for premium status sync
