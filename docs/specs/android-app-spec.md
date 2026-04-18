# Android App Specification — EClawbot

> **Status**: Living document · owner: @HankHuang0516
> **Last updated**: 2026-04-14 (v1.0.64)
> **Purpose**: Canonical reference for the `com.hank.clawlive` Android app — architecture, conventions, features, and release pipeline. Prevents regressions like duplicate string keys, stale product IDs, and parity drift between platforms.

---

## 1. Overview

| Field | Value |
|-------|-------|
| Package name | `com.hank.clawlive` |
| App ID | `com.hank.clawlive` |
| Current version | 1.0.64 (versionCode 70) |
| Language | Kotlin (KTS Gradle) |
| Min SDK | 24 (Android 7.0 Nougat) |
| Target SDK | 35 (Android 15) |
| Compile SDK | 35 |
| JVM target | 1.8 |
| Distribution | Google Play Store (production + internal testing) |

Brand: EClawbot · Repo: `HankHuang0516/EClaw` · Backend: `https://eclawbot.com`

---

## 2. Tech Stack

| Layer | Library |
|-------|---------|
| Language | Kotlin + Coroutines |
| UI | AppCompat, Material Components, View binding |
| DI | Manual (no DI framework) |
| Networking | Retrofit + OkHttp + Gson |
| Real-time | Socket.IO client |
| Local storage | Room, SharedPreferences, EncryptedSharedPreferences |
| Images | Glide |
| Markdown | Markwon |
| Push | Firebase Cloud Messaging |
| Billing | Google Play Billing Library |
| Auth (social) | Credentials Manager + Google Play Services |
| Logging | Timber |
| Crash | Custom file-based (`debug/CrashLogger.kt`) |

All declared in `gradle/libs.versions.toml` — **never hardcode versions in `build.gradle.kts`**.

---

## 3. Architecture

**Activity-based, no MVVM framework.** ViewModels are used only where state complexity demands (AI chat, main).

```
┌───────────────────────────────────────────┐
│ UI Layer (Activities + views + adapters) │
└─────────────────┬─────────────────────────┘
                  │
     ┌────────────┴────────────┐
     │     Repository Layer     │ ChatRepository / StateRepository
     └────────────┬─────────────┘
                  │
     ┌────────────┼─────────────┐
     ▼            ▼             ▼
┌──────────┐  ┌─────────┐  ┌──────────┐
│ Remote   │  │ Local   │  │ FCM /    │
│ Retrofit │  │ Room +  │  │ Socket   │
│ + Socket │  │ Prefs   │  │ push     │
└──────────┘  └─────────┘  └──────────┘
```

### Key principles
- **Keep Activities thin** — delegate to helpers (`*Helper.kt`) or ViewModels
- **All API calls via `ClawApiService`** — no ad-hoc `OkHttpClient` usage
- **All socket logic via `SocketManager`** — single connection per session
- **Persist nothing in Activity fields** that survives config change — use ViewModel or repository

---

## 4. Package Structure

```
com.hank.clawlive/
├── *Activity.kt (16 activities at root)
├── ClawApplication.kt     — app-level init (Timber, FCM, crash logger)
├── billing/               — Google Play Billing (BillingManager)
├── data/
│   ├── local/             — Room, SharedPreferences wrappers
│   │   ├── ChatPreferences, DeviceManager, EntityAvatarManager,
│   │   │   FeedbackPreferences, LayoutPreferences, LocalVarsManager,
│   │   │   UsageManager
│   │   └── database/      — Room DAOs + entities
│   ├── model/             — API DTOs + domain models
│   ├── remote/            — ClawApiService (Retrofit), NetworkModule,
│   │                        SocketManager, TelemetryHelper,
│   │                        TelemetryInterceptor
│   └── repository/        — ChatRepository, StateRepository
├── debug/                 — CrashLogger, DebugLogger
├── engine/                — Claw live wallpaper renderer
├── fcm/                   — ClawFcmService
├── location/              — GPS helper
├── service/               — ClawWallpaperService, ScreenControlService, TtsService
├── ui/                    — Shared views, adapters, helpers, ViewModels
│   ├── chat/              — chat message rendering
│   ├── schedule/          — schedule UI bits
│   ├── AiChat*            — AI chat bottom sheet
│   ├── BottomNavHelper    — bottom nav shared logic
│   ├── EntityCardAdapter, EntityChipHelper,
│   ├── FileCardAdapter, LayoutEditorView,
│   ├── MainViewModel, RecordingIndicatorHelper,
│   └── WallpaperPreviewView
└── widget/                — home-screen widget
```

---

## 5. Activities / Screens Inventory

| Activity | Purpose | Reaches BRM? |
|----------|---------|--------------|
| `MainActivity` | Dashboard, entity cards, bottom nav | ✗ (no direct BRM entry) |
| `ChatActivity` | Real-time chat with entities | ✗ |
| `AiChat*` (bottom sheet) | AI support chat | ✗ |
| `MissionControlActivity` | Mission dashboard + kanban (WebView host) | ✗ |
| `DashboardActivity` | Full Dashboard + Org Chart (WebView → `portal/dashboard.html`) | ✗ |
| `WebViewActivity` (CARDS nav) | Card Holder — **WebView** → `portal/card-holder.html?embed=1` (as of v1.0.74 the native `CardHolderActivity` was removed in favor of the portal embed; the BRM / Bot Plaza tab inside the portal is the entry point) | ✓ (via WebView, BRM accessed here) |
| `SettingsActivity` | Device settings | ✗ |
| `FeedbackActivity` + `FeedbackHistoryActivity` | Feedback submission + history | ✗ |
| `FileManagerActivity` | File manager | ✗ |
| `ScheduleActivity` | Legacy schedule redirect | ✗ |
| `MessageActivity` | Push-notification landing | ✗ |
| `OfficialBorrowActivity` | Official bot borrow + rental demand stub | ✗ (legacy) |
| `PrivacyPolicyActivity` | Privacy policy (WebView) | ✗ |
| `WebViewActivity` | Generic WebView host | ✓ (for arbitrary portal URLs) |
| `WallpaperPreviewActivity` | Live wallpaper preview | ✗ |
| `CrashLogViewerActivity`, `DebugLogViewerActivity` | Debug tools | ✗ |

**Total**: 16 activities · 32 layout files · 9 locales.

---

## 6. Real-time, Push & Services

| System | Component | Notes |
|--------|-----------|-------|
| Socket.IO | `data/remote/SocketManager.kt` | Singleton, reconnects on app foreground |
| FCM | `fcm/ClawFcmService.kt` | Subscribes to `device:{deviceId}` topic on register |
| Live Wallpaper | `service/ClawWallpaperService.kt` + `engine/ClawRenderer` | Custom wallpaper engine |
| Screen Control | `service/ScreenControlService.kt` | Remote screen capture + control |
| TTS | `service/TtsService.kt` | Text-to-speech playback |

---

## 7. API Client

**Single source of truth**: `data/remote/ClawApiService.kt` (~85 endpoints) — Retrofit interface for **every** backend API the app uses.

Conventions:
- Endpoints group by backend prefix (`/api/device/*`, `/api/transform`, `/api/chat/*`, etc.)
- All auth goes via query params (`deviceId`, `deviceSecret` / `botSecret`) — no header-based auth
- All responses wrapped in `ApiResponse<T>` where applicable
- All errors caught, logged via `Timber.e`, surfaced to UI via Toast or dialog

**Adding a new endpoint**:
1. Add method to `ClawApiService` with proper `@GET/@POST` + path
2. Add DTO to `data/model/ApiModels.kt` if complex
3. Call from Activity via `NetworkModule.apiService`
4. Interceptor (`TelemetryInterceptor`) auto-logs it — no extra work

---

## 8. Billing (Google Play)

**File**: `billing/BillingManager.kt`
**Product IDs** (must match Google Play Console exactly):

| Product | ID | Type |
|---------|-----|------|
| Premium subscription (legacy) | `e_claw_premium` | Subscription |
| Starter plan | `eclaw_sub_starter` | Subscription |
| Pro plan | `eclaw_sub_pro` | Subscription |
| Business plan | `eclaw_sub_business` | Subscription |
| E-coin top-up (consumables) | see `subscription.js` on backend | Consumable |

**Rule**: backend `backend/subscription.js` `SUBSCRIPTION_PLANS[].googlePlayProductId` MUST match Google Play Console MUST match `backend/tests/jest/subscription-plans.test.js`. If the three diverge, either the app accepts purchases that never grant entitlement, or the test stays green against fiction. (This bit us in v1.0.64 — see release notes.)

---

## 9. Feature Inventory & Parity

### App-native features
- Entity dashboard (cards, native in `MainActivity`)
- Full Dashboard + Org Chart (WebView in `DashboardActivity`, launched via top-bar `btnDashboard`)
- Real-time chat (native)
- AI chat bottom sheet (native)
- Kanban / Mission Control (WebView inside `MissionControlActivity`)
- Live wallpaper
- Remote screen control
- File manager (native)
- Card Holder (WebView → community.html)
- Feedback (native)
- Settings (native)
- Billing (native)
- Push notifications (native)

### WebView-backed features (not yet native)
- Bot Rental Marketplace (BRM) — via Card Holder → community tab
- Workspace split-view
- Public note pages

### Platform Parity Matrix
See `docs/reports/2026-03-14-platform-pages-features-inventory.md` and `docs/plans/2026-04-14-brm-mobile-parity-gap.md` for detailed gaps and follow-ups.

**Parity Rule** (CLAUDE.md §9): user-facing features must be kept in sync between Web Portal and Android. Exceptions require an accepted-gap doc in `docs/plans/` listing the WebView fallback and a follow-up plan.

---

## 10. Resources Conventions

### `res/values/strings.xml` + per-locale overrides

**Layout**:
```
values/strings.xml          ← canonical English (source of truth)
values-zh-rTW/strings.xml   ← Traditional Chinese
values-zh-rCN/strings.xml   ← Simplified Chinese
values-ja/strings.xml       ← Japanese
values-ko/strings.xml       ← Korean
values-th/strings.xml       ← Thai
values-vi/strings.xml       ← Vietnamese
values-in/strings.xml       ← Indonesian (note: `in`, not `id`)
values-es/strings.xml       ← Spanish
```

### Rules
1. **No duplicate `name=` attributes in any single file** — causes `ResourceException: Found item String/... more than one time` and FAILS the build. Our pre-release check (§14.1) must catch this.
2. **Default locale is the source of truth** — when adding a new string, add to `values/strings.xml` FIRST, then to all 8 locale files.
3. **Never hardcode user-facing text** — always use `@string/` references or `getString(R.string.*)`. CI lint enforces this.
4. **Placeholder format**: `%1$s`, `%1$d` — positional placeholders preferred (translators reorder them).
5. **Keep keys stable** — renaming a key across a release breaks in-flight translations.

### Alphabetical ordering recommended (not enforced) within each file to make diffs readable.

### Missing-key tolerance
Missing keys in a locale silently fall back to `values/strings.xml` (English). This is acceptable short-term but each locale should eventually reach 100% coverage. Tracked in `docs/reports/` i18n audits.

---

## 11. Signing & Keystore

- Production keystore: `app/release-key.jks` (local only, **never commit**)
- Keystore credentials: `keystore.properties` (local, gitignored)
- Fallback: build falls back to debug signing if `keystore.properties` is missing (so CI/fork builds work without secrets)
- Keystore backup location: **OUTSIDE the repo**, in your password manager. Losing it means you cannot publish updates to the same app ID ever again.

---

## 12. Build & Release Pipeline

Authoritative workflow: **`.agent/workflows/release.md`** (11-step pipeline).

Summary:
1. Pull main
2. Docker build sanity check (claude-cli-proxy)
3. Run full backend regression tests (`backend/run_all_tests.js`)
4. **Bump `versionCode` + `versionName`** in `app/build.gradle.kts`
5. Sync `LATEST_APP_VERSION` in `backend/index.js`
6. `./gradlew.bat bundleRelease`
7. Copy AAB to `release_v{VERSION}/` (gitignored)
8. Write bilingual CHANGELOG.md to `release_v{VERSION}/CHANGELOG.md`
9. Update `RELEASE_HISTORY.md` with new entry at "## Latest"
10. Commit, push, `node scripts/upload_to_play.js` (internal testing)
11. After verification: `node scripts/upload_to_play.js --track=production --promote`
12. Publish release notes to 10 external platforms (WordPress ×2, DEV.to, Hashnode, Blogger, Telegraph, Tumblr, Mastodon, Qiita, X)
13. Clean up old `release_v*` folders

---

## 13. CI/CD

- **Android CI** (`.github/workflows/android-ci.yml`): Lint + Kotlin unit tests + debug APK assemble. Instrumented tests disabled by default.
- **Backend CI** (`.github/workflows/backend-ci.yml`): ESLint + Jest (~1500 tests).
- **Semantic Release** auto-generates top-level `CHANGELOG.md` and GitHub releases from conventional commits.
- Railway auto-deploys backend on push to main (`railway.json`).

**Both CIs MUST be green on main before building a release.** If they're red, fix first, then build. See §14.2.

---

## 14. Pre-Release Validation Checklist (MANDATORY)

> Bitter lesson from v1.0.64: I bumped version without running these checks; Android Studio build failed on a duplicate string. **Run every single item below before `gradlew bundleRelease`.**

### 14.1. Android resources sanity

```bash
cd /Users/hank/Desktop/Project/EClaw

# A. Duplicate string keys (build-breaker)
for f in app/src/main/res/values*/strings.xml; do
  DUP=$(awk -F'"' '/string name=/ {print $2}' "$f" | sort | uniq -d)
  [ -n "$DUP" ] && echo "DUP in $f: $DUP"
done
# (must be empty)

# B. XML well-formedness
for f in app/src/main/res/values*/strings.xml; do
  python3 -c "import xml.etree.ElementTree as ET; ET.parse('$f')" 2>&1 \
    | grep -v "^$" && echo "  in $f"
done
# (must be empty)

# C. Missing keys report
DEFAULT=$(awk -F'"' '/string name=/ {print $2}' app/src/main/res/values/strings.xml | sort -u)
for locale in values-in values-ja values-ko values-th values-vi values-zh-rCN values-zh-rTW values-es; do
  LOCALE=$(awk -F'"' '/string name=/ {print $2}' "app/src/main/res/$locale/strings.xml" | sort -u)
  MISSING=$(comm -23 <(echo "$DEFAULT") <(echo "$LOCALE") | wc -l | tr -d ' ')
  EXTRA=$(comm -13 <(echo "$DEFAULT") <(echo "$LOCALE") | wc -l | tr -d ' ')
  echo "$locale: missing=$MISSING extra=$EXTRA"
done
```

### 14.2. CI status

```bash
# Check Android CI + Backend CI on main are both green
gh run list --branch main --limit 5
```

Red CI = release blocked. Fix first.

### 14.3. Backend parity

- `backend/index.js` `LATEST_APP_VERSION` matches `app/build.gradle.kts` `versionName`.
- `backend/subscription.js` `googlePlayProductId` values match Google Play Console.

### 14.4. Dry-run build (recommended)

```bash
./gradlew.bat assembleDebug    # fast (~1 min) — catches resource merge errors early
```

Only proceed to `bundleRelease` if assembleDebug succeeds.

### 14.5. Smoke test against production

- Log in as a test device, send one message, open chat, open Card Holder → Community.
- Verify no 404 in device telemetry (`GET /api/device-telemetry/summary`).

---

## 15. Debugging Tools

| Tool | How to access |
|------|---------------|
| Crash log viewer | Settings → Debug → View Crash Logs (in-app) |
| Debug log viewer | Settings → Debug → View Logs |
| Device telemetry | `GET /api/device-telemetry` (backend) |
| Server logs | `GET /api/logs?deviceId=X&deviceSecret=Y` |
| Debug API endpoints | `backend/index.js` — any `/api/debug/*` or `/api/rental/debug/*` (some blocked in production, see code) |

---

## 16. Known Gaps / Follow-ups

| Item | Tracker |
|------|---------|
| Native BRM UI (currently WebView) | `docs/plans/2026-04-14-brm-mobile-parity-gap.md` |
| i18n coverage gaps (ja/ko/th/vi each missing 19 keys) | Audit in `docs/reports/` |
| Bottom nav redesign (Card Holder → Community is confusing) | No ticket yet |
| Instrumented tests disabled in CI | `android-ci.yml` |
| No DI framework | Manual DI works fine for current scale |
| JVM target still 1.8 | Safe for min SDK 24; bump when min SDK rises |

---

## 17. Things That Have Bitten Us (and how to avoid)

| Incident | Root cause | Prevention |
|----------|------------|------------|
| v1.0.64 Android build failed on `topup_ecoin_title` duplicate | Merge conflict introduced second declaration of same key in `values-in/` | §14.1.A — MUST run before every release |
| v1.0.64 Jest `subscription-plans` test red on main | Test asserted `'ec.sub.starter'` but code had `'eclaw_sub_starter'` post merge conflict | §14.3 — pin product IDs across backend/test/Play Console |
| CDN served stale `entity-utils.js` (v1.109.1) | No Cache-Control header on shared JS | Added explicit `no-cache` headers |
| Owner entity 0 deleted after rental cron expiry (pre-#1748) | Phase 1 reconcile didn't distinguish owner from renter | PR #1748 — Phase 1 joins `bot_listings` for owner slot ID |
| Rental bot chat leaked to owner (pre-#1740) | `saveChatMessage` in transform didn't check `leased_out` | PR #1740 — `isLeasedOut` guard |

Every recurring class of bug → **add to §14 checklist**. If it's not mechanically checkable, add an automated test.

---

## 18. Reference

- **Backend docs**: `CLAUDE.md` (repo root)
- **Release workflow**: `.agent/workflows/release.md`
- **BRM UIUX spec**: `docs/plans/2026-04-12-brm-uiux-rendering-spec.md`
- **Agent message rendering**: `docs/specs/agent-message-rendering-spec.md`
- **Play Store listing copy**: `google_play/` folder

---

## 19. Change Log of This Spec

| Date | Change |
|------|--------|
| 2026-04-14 | Initial draft, covers v1.0.64 state + release v1.0.64 bitter lessons |
