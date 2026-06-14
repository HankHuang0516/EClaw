# Release History

Track git commits for each release to enable changelog generation via `git diff`.

---

## Latest
v1.0.92 | pending PR | 2026-06-14 | versionCode 100 | Production release prep | **Health-checking animation parity + portal/backend reliability rollup**: Android wallpaper/entity cards and iOS entity cards now render the backend `healthChecking` state with visible animation; passive health/self-repair and message-lifecycle backend flow is included; Petdx pagination, entity PR widgets, roadmap live kanban status, chat routing fallback, env-var vault save/delete fixes, avatar Petdx rendering, portal accessibility/parity, rental bind/retirement, redirect/i18n/API error, Plaza, chat, arena, and release/CI reliability fixes are bundled.

v1.0.91 | fc3b1477 | 2026-06-13 | versionCode 99 | Production ✅ (Play API `completed`, live on 2026-06-14 check) | **Play review compliance hotfix**: removed broad Android media/storage permissions (`READ_MEDIA_IMAGES`, `READ_EXTERNAL_STORAGE`, related legacy storage declarations), added manifest permission regression coverage, fixed release lintVital manifest resource issues, and cleared the prior Google Play photo/video permission blocker.

v1.0.90 | superseded | 2026-06-12 | versionCode 98 | Superseded by v1.0.91 before production baseline | **Play review compliance hotfix draft**: remove the restricted Android remote-control automation surface from the production app package and disable the Remote Control settings action path while the feature is redesigned for Google Play policy compliance.

v1.0.89 | 4bcc33e4 | 2026-05-30 | versionCode 97 | Internal ✅ + Production ✅ (submitted for review 2026-05-30 16:07 TW) | **Wallpaper Weekly reset countdown — per-engine Claude/Codex/Both (parity with 5h)** (#3022). PR #3018 v1.0.88 rollup 漏實作 Weekly 那條 per-engine pipeline (整條 hardcoded local Monday 00:00 + 字串模板無 engine slot)；現在 Weekly 跟 5h 走同一個 isEngineVisibleForReset filter，讀 server-supplied epoch (snapshot.claude.live.rateLimits.sevenDay.resetsAt + snapshot.codex.rateLimits.sevenDayResetsAt)，按 Claude/Codex toggle 顯示 1 或 2 條，legacy 本地 Monday line 只在 snapshot==null 或兩邊 sevenDay raw 都缺時 fallback (per #6 Codex design ack Q1-Q4 + #1 Mac_F supervisor cross-review hardened gate to split raw-presence from future-only filtering at PR review). 新字串 wallpaper_reset_window_weekly_next_per_engine 補在 values/ + values-zh-rTW/ (parity with existing 2-locale weekly_next scope; Hermes follow-up for remaining 14 locales).

## Recent
v1.0.88 | 0177811d | 2026-05-29 | versionCode 96 | Internal 🚧 | **Wallpaper UX rollup — 5h+Weekly共存 / Claude vs Codex 標記 / 拖曳hit-box** (#3018) + Wallpaper reset-countdown snapshot==null guard (#3012) + Wallpaper reset-interval toggle 5h vs Weekly (#3005) + Android i18n ai_chat_status streaming externalize + 14 locales (#3003, #3004) + Android i18n Indonesian 838 keys (#3011) + Android i18n 3 hardcoded strings → strings.xml (#2998) + Server Point-and-Edit Demo (Track A DOM/text-selection #2991) + Point-Edit roadmap 3-track walkthrough (#2992) + Point-Edit Playwright universal resolver (#3006 + Track B v2 #3010) + Point-Edit resolver P0 hardening graceful shutdown + rate limit + sanitizer (#3015) + Page transition overlay card_64917ead (#2975) + Platform delivery-confirmation primitives (#2979) + Platform-P2 ack_required (#2980) + Official-bots model_name canonical + PATCH metadata (#2987, #2988) + Channel @-tag visible mention prefix routing improvements + schedule field on /cards (#2989) + Rental health probe bind once per fleet-cron TTL-aware reuse (#2990) + Transform 400-gate malformed speakTo (#3002) + Entity avatar sync on rebind/transform (#2993) + Portal publisher pages load api before auth (#3008) + Org-chart suppress low-signal noise in silent FWD-to-superior (#3014) + Security SSRF per-request route guard + RFC1918/ULA block (#3013) + OpenClaw channel ack target-mode healthcheck nonces (61434361) + Borrow skill doc IMMEDIATE ACTION placeholder redesign Path A (#2986) + Borrow skill doc echo-as-greeting fix (#2982) + Info boundaries hash routing (#2984) + i18n Channel Routing Paths × 11 locales (#2981) + i18n zh Point-and-Edit demo 83 keys (#3000) + i18n zh-CN coverage 149 keys (#2997) + i18n es rm_h4 25 keys (#2995) + i18n Plaza Featured Week 3 keys × 13 locales (#2948) + Retire Hashnode publisher (#2977) + E2E destructive-modals daily playbook + reference run (#2961) + Day 144 info hub three-P0 highlight embed (#3016)

v1.0.85 | 6f46f13b | 2026-05-26 | versionCode 93 | Internal 🚧 | **Live wallpaper Claude/Codex usage overlay — 5h/7d % rendered straight on the home-screen wallpaper, configurable toggle / position / per-engine / per-window, polls /api/usage/snapshot every 30s** (6f46f13b feat android show usage on live wallpaper) + Native tab routing bridge chat↔mission Activity reuse + FLAG_ACTIVITY_REORDER_TO_FRONT (#2832) + Portal Quick Start 75s product walkthrough video embed (#2795) + Portal Nagoya trip image atlas + station maps + 停車場 pins + Day banner hero (#2743) + Portal /portal/bot/:id/about backstory scaffold IP P1 (#2938) + Dashboard usage widget v2 Session/Weekly % bars + projects list, reads live.rate_limits.{five_hour,seven_day}.used_percentage correctly (#2893, #2894, #2895, #2896) + Channel outbound backpressure 30/min + 429 retry-after (#2911) + Channel delivery receipts (#2913) + Channel A2A operational-loop suppression (rebase #2288 #7ceabc91) + Channel handshake fallback to discovered sessions (#2915, #2917) + Hermes H2 health-check cron + 7-day SLA + commander alerts (#2922) + Hermes H4 roadmap proof complete (#2933) + claude-cli-proxy per-request multi-tenant auth H3 Phase 2 (#2937, #2947) + claude-cli-proxy private repo git auth scoping + askpass ignore + case-insensitive allowed-orgs lock (#2926, #2928, #2929) + DELETE /api/entity/queue messageQueue drain (#616) + i18n pt locale block 5109 keys (#2932) + i18n rm_h4 proof keys × 11 locales (#2936) + i18n FCM NotificationChannel labels localized (#2918) + i18n backend AST dedup + zh dedup + 11 zh fill (#2919, #2920, #2921, #2924) + i18n ClawRenderer canvas empty-state 14 locales (#2899) + i18n de6970 locale gap reapply (#2925) + Fix chat target bar carries kanban deep-links (#2946) + Fix portal mobile delete-modal right-edge clip P0 (#2951) + Fix chat preserve recipient across rental-health refresh P0 (#2906) + Fix dashboard Claude weekly bar reset countdown (#2896) + Fix kanban dep-aware nudge gating + roadmap dep backfill (#2904) + QA contact reads + UX audit refresh (#2955) + nagoya-trip map link visibility on dark hero (#2897) + platform-stats device-auth contract (#2916) + marketplace P1 cleanup codex (#2905) + TweetClaw skill template (#2898) + daily audits + roadmap H1/Hermes complete docs

v1.0.84 | 43dd8198 | 2026-05-15 | versionCode 92 | Internal ✅ | Native chat→Mission tab routing bridge (#2824) + Portal Nagoya trip image atlas + map links + 停車場 buttons (#2743, #2821, #2826) + Portal Quick Start promo video embed (#2797) + landing/footer Watch Intro CTA (#2798, #2799) + iOS Settings Tutorial entry (#2800) + Kanban explicit done-card reopen flow (#2801) + Kanban GET card returns latest 50 comments (#2816) + Kanban comment viewport stabilize (#2796) + Task chip group actions (#2825) + Org-chart notify on hierarchy change (#2812) + i18n Hindi 555 keys round-3 (#2813) + i18n Arabic 121 keys round-4 (#2814) + i18n zh-TW backfill 8 keys (#2815) + i18n AI chat tool status labels (#2811) + i18n dynamic portal wrapper keys (#2807) + i18n soft-pause × 10 locales (#2808) + Fix platform-stats 500 + entity/lookup publicCode alias (#2818) + Fix XSS in chat modal error messages (#2819) + Roadmap H0 done flip + Hermes channel items done (#2820, #2803) + Rental spec v0.2 (#2817)

v1.0.83 | f4327f28 | 2026-05-12 | versionCode 91 | Internal ✅ + Production ✅ (submitted for review 2026-05-13 07:38 TW) | Android Settings 新增「Kanban Card Completed」「Kanban Automation Completed」兩個通知開關 — 後端 DEFAULT_PREFS / Web Portal 早就有 key，只是 SettingsActivity.notifCategories 漏掉 (#2636) + RELEASE_HISTORY ## Recent 重複標題收成單一區塊 (#2637)

v1.0.82 | e69ea816 | 2026-05-12 | versionCode 90 | Internal 🚧 | APP 首頁改用 WebView 載入 portal/dashboard.html — Web/App 共用同一份 entity grid / Add Entity / Borrow / channel promo / edit-mode reorder (1131 LOC native Home 拆除) + fresh-install registerDevice 修跳轉登入頁 bug + dashboard.html 移除 __isAndroidApp orgchart-collapse + Chat @-mention avatar 走 companion renderer (#2633) + Kanban dependency chips IntersectionObserver 懶載入 (#2632) (#2634)
v1.0.81 | 8b4f66fc | 2026-05-12 | versionCode 89 | Internal 🚧 | Wallpaper companion-change flicker fix — DrawResult.LOADING distinguished from UNSUPPORTED/ERROR so procedural-lobster fallback no longer fires mid-sheet-decode + atomic descriptor-after-preload swap in CompanionRepository + SheetBitmapCache 3→8 to stop LRU thrash across 5+ bound entities (#2629) + Wallpaper companion sprite renders per-petdx (was 6 identical lobsters) — root cause: NetworkOnMainThreadException from sync OkHttp on Main thread, fixed by dispatching bitmap fetch to Dispatchers.IO + Main-thread guard in getSheet() (#2618) + /api/entities exposes botSecret to owner so wallpaper service can poll companions (#2615) + /api/rental/marketplace enriched with owner_public_code for plaza CTA routing (#2616) + community.html 1-click chat button on bot cards + utm tagging (#2610) + share-chat twitter card + per-bot og:image/twitter:* in SSR (#2609) + portal entity selector on petdx-browser (#2602) + companion bridge crafter-station/petdex gallery 1784 pets (#2601) + i18n positional format specifiers feedback_result_logs 7 locales (#2597) + mindmap i18n wrap hardcoded zh-TW UI strings (#2607). Supersedes v1.0.80 PENDING (never uploaded — same Petdx Stages 1-4 + multi-creature drawers + Settings 瀏覽伙伴 entry + Bot Plaza SEO SSR + Kanban dep-chain Phase D + Kanban idle-dispatch + Kanban device-push + Wallpaper Loading-state + Chat inline media + Day-0 promo embed + Growth P1a invite_clicks + i18n duplicate cleanup, plus the post-v1.0.80 PRs listed above)
v1.0.79 | 0fb54026 | 2026-04-28 | versionCode 85 | Internal 🚧 | Mind Map fullscreen (#2222-#2226: ⛶ button + ?view-mode=full + standalone /portal/mindmap.html removed -1142 LOC) + Hermes Phase H1.1-H1.5 (mq cap 200 + DLQ #2213, push-site enqueue coverage #2214, delivery-stuck heartbeat #2215, /api/health 503 auto-restart #2216, ghost-entity exclusion #2217) + Kanban search extension to comments/subcards/archived (#2211) + Kanban L2/L3 escalation also-notify assigned_bots (#2227) + i18n cards default requires_screenshot_review=false (#2224) + Invite ?redeem= preserved across signup (#2221) + community.html og:locale 13 langs (#2220) + landing.html Browse Bots CTA (#2218) + chat-his-link locale count 14 (#2219) + mindmap wheel-zoom precision (#2212) + kanban blocked-status i18n (#2208)
v1.0.78 | ae14da32 | 2026-04-28 | versionCode 84 | Internal 🚧 | Mind Map subsystem (schema/CRUD/portal UI/AI traverse/anchored notes #1945-#2192) + Smart Quote Chips 引用晶片 (recursive nested popover #2068-#2087) + Vector Memory pgvector semantic chat search (#1918, #1926, #1933) + Onboarding Scope-0 wizard + 6 product tours (#1909-#1917) + Publisher multi-tenant 9/10 platforms vault-first (#1920, #2144-#2152) + Kanban status SoT + nudge per-device + screenshot-review gate (P1 umbrella #2202-#2205, #2013, #2044) + Schedule message Phase 1+2 (#2067, #2082) + Top-up Path B Google Play androidpublisher v3 (#1879, #1881, #1899) + Promo-3 referral system + QR share (#1900, #1869, #1870) + iOS icon-only nav + WebView chrome cleanup (#2060, #2062, #2058) + Critical: device-vars empty-merge wipe fix (#2029) + R2 signed-URL hardening (#2045, #2059, #2064, #2077, #2090) + global rate limit (#2055)
v1.0.76 | a962fcdd | 2026-04-19 | versionCode 82 | Internal 🚧 | Entity ID never-reuse invariant restored (#1862) + fetch timeout + per-test hard cap on release gate (#1861) + test 22 /api/status auth contract fixed (#1865) + fetch-with-timeout jest CI-jitter threshold (#1864) + Android orgchart bottom-sheet 90% height (#1854) + orgchart same-parent drop guard + reset confirm (#1855) + i18n cardholder_empty de/hi/zh-CN (#1856) + Terminal Bridge + Bridge-Auth combo docs panel (#1858) + mermaid lazy-render (#1853) + XSS sanitizer hardening (#1840/#1859) + iOS NitroModules newArchEnabled (#1852) + cardholder_tab_bot_plaza 9 locales (#1851)
v1.0.75 | 793ec1c6 | 2026-04-18 | versionCode 81 | Internal 🚧 | card-holder hotfix — navEmail null guard (embed mode JS crash fix) + 我的名片 empty-state 去 Bot 廣場 CTA + CARDS WebView URL dedup (PR #1850)
v1.0.74 | 1bd4b729 | 2026-04-18 | versionCode 80 | Internal 🚧 | CardHolderActivity ripped out (1758 LOC) → portal/card-holder.html?embed=1 WebView; full parity (Run Interview/Plaza/Start Chat/Share/Edit + BRM list entry); 41 android strings removed; docs updated
v1.0.73 | 23322191 | 2026-04-18 | versionCode 79 | Internal ✅ | MyCard Run Interview + Edit + 開始對話 + 分享 + Plaza toggle; chat chips (CJK/backtick/card_shortId/Stripe-prefix); photo grid; FCM self-heal; dashboard orgchart lock; i18n 13-locale fill
v1.0.71 | 55d40068 | 2026-04-17 | versionCode 77 | Internal 🚧 | Enter-newline, backtick Note chip, Note Markdown, chat density, org-chart touch-action
v1.0.70 | c8eac429 | 2026-04-17 | versionCode 76 | Internal ✅ | Dashboard + Org Chart parity on Android & iOS (WebView → portal/dashboard.html)
v1.0.69 | 57b5250b | 2026-04-16 | versionCode 75 | Internal ✅ + Production ✅ (submitted for review 2026-04-17 09:33 TW)
v1.0.68 | 606b04ca | 2026-04-16
v1.0.67 | ecbe48e0 | 2026-04-16
v1.0.65 | c3769436 | 2026-04-16
v1.0.64 | a27e8fe2 | 2026-04-14
v1.0.63 | 1e2a2f63 | 2026-04-03
v1.0.62 | eaa2cb1d | 2026-03-28
v1.0.61 | 03ed8a03 | 2026-03-26
v1.0.60 | f89ef498 | 2026-03-24
v1.0.59 | 66782ed3 | 2026-03-23
v1.0.58 | ff625855 | 2026-03-23
v1.0.57 | 3203df62 | 2026-03-22
v1.0.55 | 843a242f | 2026-03-21
v1.0.54 | 104d0b02 | 2026-03-21
v1.0.53 | 7c87bf33 | 2026-03-20


---

## History
v1.0.50 | 7ae8604 | 2026-03-18
v1.0.49 | aabf637 | 2026-03-18
v1.0.47 | db40f7e | 2026-03-15
v1.0.46 | 634a564 | 2026-03-12
v1.0.45 | 589b10d | 2026-03-12

---

## Previous
v1.0.44 | d04e461 | 2026-03-12
v1.0.43 | c28ad6a | 2026-03-09
v1.0.42 | 45361c4 | 2026-03-08
v1.0.41 | a24ad79 | 2026-03-08
v1.0.40 | f89c5b7 | 2026-03-07
v1.0.39 | ad35c3a | 2026-03-05
v1.0.38 | 9e62bd0 | 2026-03-04

---

## History
v1.0.47 | db40f7e | 2026-03-15

| Version | Commit | Date | Notes |
|---------|--------|------|-------|
| v1.0.36 | 1e9907f | 2026-03-04 | Phone remote control, encrypted vars vault, OpenClaw channel plugin, screen control stability |
| v1.0.35 | a4ffebd | 2026-03-03 | Phone remote control, encrypted vars vault, OpenClaw channel plugin, screen control stability |
| v1.0.34 | 5b951a6 | 2026-03-02 | Broadcast recipient info, device preferences, Mission Control delete UX, chat reactions, env vars tab |
| v1.0.33 | 5986366 | 2026-03-01 | Social login, floating AI chat, cross-device contacts, AI feedback to GitHub |
| v1.0.32 | 8fcdacb | 2026-02-28 | AI binding troubleshooter, WebSocket transport, XP expansion |
| v1.0.31 | d6bd1d3 | 2026-02-27 | Bot gateway disconnection detection, handshake failure recording, push health tracking, skill doc optimization |
| v1.0.30 | b6bfa93 | 2026-02-26 | Avatar sync, premium entity slots, schedule editing, bot push hints, feedback redesign |
| v1.0.29 | f10bddf | 2026-02-25 | Cross-device bot-to-bot, 8 entity slots, video chat, admin, security |
| v1.0.28 | a334636 | 2026-02-24 | XP/Level system, Info Hub, E-Claw vs Telegram, domain migration, CI fixes |
| v1.0.27 | 7deb7d6 | 2026-02-22 | Notification system, FCM, Socket.IO, Web Push, multi-language, file upload |
| v1.0.26 | 73bb00f | 2026-02-22 | Per-device entity limit, schedule history, Mission Control UI |
| v1.0.25 | d550fc2 | 2026-02-22 | Schedule UI chips/cron, timezone fix, entity chip improvements |
| v1.0.24 | 06016c1 | 2026-02-22 | Schedule sub-tab, Chinese translations, CI/CD improvements |
| v1.0.23 | b3e7802 | 2026-02-22 | Entity cards fix, feedback photo upload, file manager UX |
| v1.0.22 | 5a90ca3 | 2026-02-21 | File management, feedback photo upload, free bot stats |
| v1.0.21 | 60b9235 | 2026-02-21 | Feedback redesign, gatekeeper fix, entity card fix |
| v1.0.20 | bca84ac | 2026-02-21 | Feedback UI upgrade, telemetry call fixes |
| v1.0.19 | 19d4f57 | 2026-02-20 | Telemetry SDK, entity refresh/reorder, slash commands, feedback |
| v1.0.18 | 82803b3 | 2026-02-20 | Gatekeeper lock strengthening, gatekeeper tests |
| v1.0.17 | 10947c4 | 2026-02-20 | Free bot TOS agreement flow, gatekeeper module |
| v1.0.16 | 9241d5a | 2026-02-20 | Echo suppression tests, delivery receipts, Kotlin unit tests |
| v1.0.15 | 0aaad4d | 2026-02-19 | Chat echo dedup, LATEST_APP_VERSION sync, test fixes |
| v1.0.14 | b31edb3 | 2026-02-19 | Server logs, broadcast fix, entity echo dedup |
| v1.0.13 | 7048a5d | 2026-02-19 | Server logs, broadcast fix, entity echo dedup |
| v1.0.12 | c1252b1 | 2026-02-18 | Subscription sync, usage limit fix |
| v1.0.11 | 47e481f | 2026-02-18 | 3 new regression tests, isTestDevice flag |
| v1.0.10 | b490271 | 2026-02-17 | Fix chat duplication, promote mode |
| v1.0.9 | 07764ea | 2026-02-17 | Chat media, usage limit, Google Play auto-upload |
| v1.0.8 | 55a17a5 | 2026-02-17 | Push error UX, webhook test, skill doc |
| v1.0.7 | b78ee97 | 2026-02-17 | Fix duplicate chat, update Flickr SDK |
| v1.0.6 | 18f9131 | 2026-02-14 | App name fix (E-Claw) |
| v1.0.5 | ebf662c | 2026-02-13 | Privacy Policy, Crash fixes, UI improvements |
| v1.0.4 | b0d267b | 2026-02-08 | Battery level reporting, entity broadcast |
| v1.0.3 | 515327f | 2026-02-07 | Multi-entity architecture, regression tests |
| v1.0.2 | (unknown) | - | Previous release |

---

## How to Use

### Generate Changelog for New Release
```bash
# 1. Get previous release commit
PREV=$(grep -A1 "## Latest
v1.0.49 | aabf637 | 2026-03-18
" RELEASE_HISTORY.md | tail -1 | cut -d'|' -f2 | tr -d ' ')

# 2. View changes since last release
git log --oneline $PREV..HEAD
git diff --stat $PREV..HEAD

# 3. After release, update this file with new commit hash
```

### After Release Checklist
1. Update "Latest" section with new version, commit, date
2. Move previous "Latest" to "History" table
3. Commit this file with the release
