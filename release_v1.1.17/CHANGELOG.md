# Release v1.1.17 - 2026-07-31

## What's New / 更新內容

### English
- [Fix] Refreshes the live wallpaper companion selection after unbind, rebind, and appearance changes, so the wallpaper no longer keeps drawing the previous companion.
- [Fix] Resolves relative companion asset URLs such as `/api/...` to the production host before Android wallpaper loading, preventing stale or failed Petdx spritesheet fetches.
- [Compliance] Updates Android compileSdk and targetSdk to API 36 to satisfy the 2026 Google Play target API policy warning.
- [Release] Bumps Android to versionCode 128 / versionName 1.1.17 and syncs backend `LATEST_APP_VERSION` to 1.1.17.

### 繁體中文
- [修復] 在解綁、重新綁定與更換外觀後重新整理桌布伙伴選取狀態，避免桌布繼續顯示上一個舊外觀。
- [修復] Android 桌布載入伙伴素材前，會把 `/api/...` 這類相對網址轉成正式站完整網址，避免 Petdx spritesheet 取用失敗或沿用舊快取。
- [合規] Android compileSdk / targetSdk 更新到 API 36，處理 Google Play 2026 目標 API 級別政策提醒。
- [發布] Android 升至 versionCode 128 / versionName 1.1.17，並同步後端 `LATEST_APP_VERSION` 為 1.1.17。

## Technical Changes
- Android: versionCode 128 / versionName 1.1.17, compileSdk 36, targetSdk 36.
- Wallpaper: companion cache keys now track live selection changes and relative asset URLs are normalized before fetch.
- Backend: `LATEST_APP_VERSION` updated to 1.1.17 for runtime update prompts and API version readback.
- Tests: includes focused regression coverage for companion stale state, companion asset URL resolution, and Android target SDK policy.

## Commit Coverage
- 2b64905a fix wallpaper companion stale appearance (#4215)
- 40ed666b fix(android): resolve companion asset urls (#4216)
- 1a49b6bd fix(android): target API 36 for Play policy (#4217)
