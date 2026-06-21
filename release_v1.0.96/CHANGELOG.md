# Release v1.0.96 - 2026-06-21

## What's New / 更新內容

### English
- [Feature] Adds Android wallpaper offline entity and spritesheet cache controls, wallpaper bubble duration control, purposeful walking, interaction states, Petdex action states, and Kanban v2 wallpaper assets with Caveat font and whiteboard layout settings.
- [Feature] Adds Android WebView transport-error reconnect overlay and portal reconnect overlay behavior so disconnects keep the session visible instead of dropping the user into a blank or stale state.
- [Feature] Adds chat send-to picker UX, multi-select sheet, partner avatars, accessible labels, and fallback handling for routing-chip detail modals.
- [Feature] Adds global web-push auto-enable on dashboard, portal home, and chat, plus push round-trip health checks and dead-subscription cleanup.
- [Feature] Adds Kanban schedule usage-threshold sliders and backend cron skip behavior when entity usage is above threshold.
- [Improve] Polishes wallpaper folder depth, task orbit, board/whiteboard text fitting, settings walking toggle behavior, hover toolbar compactness, roadmap scanning, onboarding quick-win flow, marketplace filter summary, compare page scanning, and founder-story share controls.
- [Fix] Preserves OpenClaw reply targets, gates owner-scope portal API calls on real user accounts, exempts single-shot future-runAt cards from stale escalation, and fixes routing-chip modal "undefined" rendering.
- [i18n] Adds usage-warning and cron-skip strings across supported locales.
- [Maintenance] Includes daily arena pool/audit updates and UI self-improvement ledger restoration.

### 繁體中文
- [新功能] 新增 Android 桌布離線 entity / spritesheet 快取控制、訊息泡泡停留時間、目的性走動、互動狀態、Petdex 動作狀態，以及 Kanban v2 桌布素材、Caveat 字型與白板版面設定。
- [新功能] 新增 Android WebView 傳輸錯誤 reconnect overlay 與 Portal reconnect overlay，斷線時維持可理解的狀態，不再讓使用者看到空白或過期畫面。
- [新功能] 新增聊天 send-to picker、多選 sheet、對方頭像、無障礙標籤，並補上 routing-chip 詳細 modal 的 fallback。
- [新功能] 新增 dashboard、入口頁與 chat 的 web-push 自動啟用，以及推播 round-trip 健康檢查與失效 subscription 清理。
- [新功能] 新增 Kanban 排程 usage-threshold sliders，並讓 backend cron 在 entity 用量超過門檻時跳過派送。
- [改進] 改善桌布資料夾深度、任務軌道、白板文字 fitting、設定頁走路 toggle、hover toolbar、roadmap 掃描、onboarding quick-win、marketplace filter summary、compare page 掃描與 founder story 分享控制。
- [修復] 保留 OpenClaw reply targets、限制 owner-scope API 只在真實帳號後呼叫、避免 single-shot future-runAt card 被 stale escalation 誤處理，並修復 routing-chip modal 顯示 `undefined`。
- [i18n] 補齊 usage-warning 與 cron-skip 字串到多語系。
- [維護] 包含每日 arena 題庫 / audit 更新與 UI self-improvement ledger 修復。

## Technical Changes
- Android: versionCode 104 / versionName 1.0.96, wallpaper cache/rendering/interaction updates, reconnect overlay controller/backoff tests, chat send-to UI tests, and wallpaper UI/instrumentation probes.
- Backend: `LATEST_APP_VERSION` updated to 1.0.96; push health, Kanban schedule usage-threshold migrations/API, Petdex bridge, OpenAPI, and related Jest coverage are included from main.
- Portal/API contract: reconnect overlay script, webpush auto-enable, slash-command sync, owner-scope auth gating, Kanban schedule threshold UI, chat routing/send-to fixes, and several public-page scanning improvements are included from main.
- Release tracking: Google Play production baseline confirmed at v1.0.95 / versionCode 103 before preparing this candidate.

## Commit Coverage
- b79ff641 feat(android): add wallpaper offline cache controls (#3596)
- 83a2627a fix(openclaw-channel): preserve EClaw reply targets (#3597)
- b56e4067 fix(portal): gate owner-scope API calls on real user account (#3598)
- 3c46cee6 feat(portal): sync slash commands from Codex bridge (#3599)
- 1624ae27 Remove duplicate settings walking toggle (#3601)
- a6d256e3 fix(portal): keep hover toolbar compact (#3602)
- 089fc41e Add wallpaper bubble duration control (#3603)
- c142dbc7 i18n: add usage_warning keys across locales (#3605)
- d96915be chore(audit): scheduled audit 2026-06-21 (#3609)
- 6a71aec1 feat(i18n): add usage_warning keys across 14 locales (#3608)
- cd4ef2cd Hermes task nudge credential-scope file edit (#3606)
- 1c8e3a6d chore(arena): daily question pool update (#3607)
- 2042f1a6 improve founder story share controls (#3610)
- bf3b26f4 fix(kanban): exempt single-shot future-runAt cards from stale escalation (#3611)
- 32b3b36a Make wallpaper walking purposeful (#3612)
- 64633652 UX: polish roadmap page scanning (#3613)
- f2d374fe Support wallpaper interactions and Petdex action states (#3615)
- 58be843c feat(webpush): global autoEnable on dashboard/index/chat (#3616)
- f94ad4df Enhance wallpaper conversation and kanban motion (#3617)
- 75b9a438 feat(portal): keep session on transport disconnect and show reconnect overlay (#3618)
- 9192e0d8 docs: record UI self-improvement production verification (#3619)
- 21aab74a Improve onboarding quick-win flow (#3622)
- ef646bbc fix(android): polish wallpaper kanban visuals (#3620)
- c70d9255 feat(portal): schedule editor usage-threshold sliders (#3625)
- 7a665b0a feat(cron): skip dispatch when entity usage exceeds threshold (#3626)
- 22a7c934 Improve marketplace filter summary (#3624)
- 3812b6b4 feat(wallpaper): kanban v2 assets, Caveat font, whiteboard, layout settings (#3627)
- 75cee45c feat(push): round-trip health check and dead-subscription cleanup (#3628)
- dbb1f939 docs: restore UI self-improvement production ledger (#3629)
- 7a1a38d1 feat(reconnect-overlay): Android WebViewClient transport-error overlay (#3630)
- 4142afa3 fix(chat): routing-chip detail modal renders "undefined" (#3631)
- 457c439e feat(chat): send-to picker button and multi-select sheet (#3632)
- 486c7a57 i18n: add cron_skip_* keys for 15 locales (#3634)
- 120c9347 Refine wallpaper task orbit and board text fitting (#3635)
- 81874ee7 Tighten wallpaper whiteboard text layout (#3636)
- c28e8653 fix(chat): send-to button partner avatars and a11y label (#3637)
- 900d0fe8 Improve wallpaper folder pile depth (#3638)
- 2f3b8d08 Improve compare page scanning (#3639)
