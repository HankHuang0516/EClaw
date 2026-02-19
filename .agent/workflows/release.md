---
description: Automate the release process: increment version, build AAB, and organize output with version suffix.
---

# Pre-release Checks
> [!IMPORTANT]
> **Google Play Console Setup**
> Ensure the following are configured in Google Play Console before release:
> - **Product ID**: `e_claw_premium` (Must match `BillingManager.kt` exactly)
> - **Name**: E Claw Premium

## Store Listing Info (Subscription Benefits)
Add these up to 4 benefits in **Monetize > Products > Subscriptions > User Benefits**:

1.  **Unlimited AI Chat** (無限暢聊)
    *   Remove the daily 15-message limit and chat freely.
2.  **Premium Badge** (尊爵徽章)
    *   Exclusive premium status indicator in app settings.
3.  **Support Development** (支持開發)
    *   Directly support the continuous improvement of E-Claw.
4.  **Future Access** (未來功能)
    *   Get priority access to upcoming premium features.

## Documentation Check (High Priority)
- `backend/realbot_mcp_skill.md` MUST be in **English**.
- Verify that the `skills_documentation` field in the Bot Binding JSON is in English to ensure compatibility.

## 0. Pull Latest Main Branch

// turbo
```bash
git pull origin main
```

---

## 0.5. Run Regression Tests (REQUIRED)

> [!CAUTION]
> **All tests must pass before release. Do NOT proceed if any test fails.**
> **UX Coverage must be >= 98% - No 404 or timeout errors allowed.**

// turbo
```bash
cd backend && node run_all_tests.js
```

**Required Output:**
```
✅ ALL TESTS PASSED - Ready for release!
```

**Test Suite (14 tests in `backend/tests/`, ~5 minutes):**

| # | Test | Description |
|---|------|-------------|
| 1 | `test_ux_coverage.js` | **UX/UI >= 98%**: All endpoints respond (no 404/timeout) |
| 2 | `test_ux_improvements.js` | API structure, isBound field |
| 3 | `test_device_isolation.js` | Multi-device entity isolation |
| 4 | `test_messaging.js` | Broadcast & entity-to-entity |
| 5 | `test_webhook.js` | Webhook push mode |
| 6 | `test_entity_delete.js` | 40 entities stress test |
| 7 | `test_widget_ux.js` | Widget chat dialog flow, broadcast |
| 8 | `test_chat_monitoring.js` | Multi-entity speak-to, broadcast, dedup, rate limit |
| 9 | `test_usage_limit.js` | 15-message limit, premium bypass |
| 10 | `test_mission_publish.js` | TODO/RULE CRUD, incremental notify, delta publish |
| 11 | `test_entity_name_preservation.js` | Entity name persistence across rebind |
| 12 | `test_entity_echo_bug.js` | Echo deduplication regression |
| 13 | `test-broadcast.js` | **Credential**: Broadcast delivery + delivered_to append |
| 14 | `test-bot-api-response.js` | **Credential**: Bot API response rate >= 90% |

> [!NOTE]
> Tests 13-14 require credentials in `backend/.env` (see `.env.example`).
> They are skipped gracefully if credentials are missing, but **must pass** for a full release.

**UX Coverage Requirement:**
- All backend endpoints used by Android app must return valid responses
- 404 errors = endpoint missing = **RELEASE BLOCKED**
- Timeout errors = backend hung = **RELEASE BLOCKED**
- Coverage < 98% = **RELEASE BLOCKED**

**If tests fail:**
1. Fix the failing code
2. Re-run tests until all pass
3. Then proceed to step 1

---

## 1. Check and Increment Version
- Open `app/build.gradle.kts`.
- Find `versionCode` and `versionName`.
- **Action**: Increment `versionCode` by 1.
- **Action**: Increment `versionName` (e.g., 1.0.13 -> 1.0.14).
- Save the file.
- **Action**: Sync `LATEST_APP_VERSION` in `backend/index.js` to match the new `versionName`.
  - Find `const LATEST_APP_VERSION = "..."` and update it to the new version.

## 2. Build Release Bundle
// turbo
Run the following command to build the signed AAB:
```bash
./gradlew.bat bundleRelease
```

## 3. Organize Release Artifacts
    - Identify the current version name from `app/build.gradle.kts`.
    - Create a new folder named `release_v<versionName>` in the project root.
    - Copy the generated AAB to this folder.

    // turbo
    ```powershell
    # Extract version name
    $gradleContent = Get-Content "app/build.gradle.kts" -Raw
    if ($gradleContent -match 'versionName = "(.*?)"') {
        $versionName = $matches[1]
        Write-Host "Detected version: $versionName"

        # Create versioned release directory
        $releaseDir = "release_v$versionName"
        New-Item -ItemType Directory -Force -Path $releaseDir

        # Copy artifact
        $source = "app/build/outputs/bundle/release/app-release.aab"
        if (Test-Path $source) {
            Copy-Item -Path $source -Destination "$releaseDir/app-release.aab"
            Write-Host "SUCCESS: Release copied to $releaseDir/app-release.aab"
            Invoke-Item $releaseDir
        } else {
            Write-Error "Build artifact not found at $source"
        }
    } else {
        Write-Error "Could not parse versionName from build.gradle.kts"
    }
    ```

---

## 4. Commit All Changes Before Release

> [!CAUTION]
> **Commit all pending changes BEFORE generating changelog!**

// turbo
```bash
git status
git add .
git commit -m "Pre-release: prepare for v{VERSION}

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## 5. Generate Release Notes (Changelog)

> [!IMPORTANT]
> **Generate bilingual (中/英) release notes based on git diff from last release.**

### Step 5.1: Get previous release commit
// turbo
```bash
# Read last release commit from RELEASE_HISTORY.md
cat RELEASE_HISTORY.md | grep -A1 "## Latest" | tail -1
```

### Step 5.2: List ALL commits since last release
// turbo
```bash
# List every commit between PREV_COMMIT and HEAD (no -5, no --limit)
# PREV_COMMIT = commit hash from RELEASE_HISTORY.md "## Latest" line
git log --oneline PREV_COMMIT..HEAD
```

### Step 5.3: Write Release Notes

> [!CAUTION]
> **The changelog MUST cover every commit from Step 5.2. Read the commit titles and summarize ALL of them into the changelog below.**

Based on the commit list, create release notes in this format:

```markdown
# Release v{VERSION} - {DATE}

## What's New / 更新內容

### English
- [Feature] Description of new feature
- [Fix] Description of bug fix
- [Improve] Description of improvement

### 繁體中文
- [新功能] 新功能描述
- [修復] 錯誤修復描述
- [改進] 改進描述

## Technical Changes
- Backend: ...
- Android: ...
- Tests: ...
```

Save to: `release_v{VERSION}/CHANGELOG.md`

---

## 6. Update Release History & Final Commit

> [!CAUTION]
> **MUST update RELEASE_HISTORY.md and commit!**

// turbo
```bash
# Get current commit hash
git rev-parse HEAD
```

Update `RELEASE_HISTORY.md`:
```markdown
## Latest
v{VERSION} | {COMMIT_HASH} | {DATE}

## History
v{PREV_VERSION} | {PREV_COMMIT} | {PREV_DATE}
...
```

// turbo
```bash
git add RELEASE_HISTORY.md release_v{VERSION}/
git commit -m "Release v{VERSION}

## What's New / 更新內容
- [English changelog summary]
- [中文更新摘要]

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## 7. Push to Remote

> [!IMPORTANT]
> **Push all commits to remote repository.**

// turbo
```bash
git push origin main
```

---

## 8. Upload AAB to Google Play Internal Testing

> [!IMPORTANT]
> **Automatically upload the signed AAB to Google Play Console internal testing track.**
> Requires `play-service-account.json` in project root.

// turbo
```bash
node scripts/upload_to_play.js
```

**Expected Output:**
```
=== SUCCESS ===
Version code XX → Internal Testing (內部測試)
```

---

## 9. (Optional) Submit to Production for Review

> [!CAUTION]
> **Only run this after internal testing is verified!**
> This submits the AAB to Google for production review.
> Google will review the app before it goes live on Play Store.

**Ask user before running this step.** Do NOT auto-execute.

```bash
node scripts/upload_to_play.js --track=production --promote
```

> Uses `--promote` to move the already-uploaded internal version to production (no re-upload needed).

**Expected Output:**
```
=== SUCCESS ===
Version code XX → Production (正式版 - 提交審查)
Google will review your app. Check status in Google Play Console.
```

---

## Troubleshooting (upload_to_play.js)

| Error | Cause | Fix |
|-------|-------|-----|
| `403 Forbidden` | Service account lacks permissions | Google Play Console → 使用者和權限 → 設定權限 |
| `APK/AAB not found` | AAB not built | Run `./gradlew.bat bundleRelease` first |
| `Invalid package name` | Package mismatch | Check `PACKAGE_NAME` in script = `applicationId` |
| `This Edit has been deleted` | API timeout | Re-run the script |
| `Version code already used` | Duplicate versionCode | Increment `versionCode` in `build.gradle.kts` |
