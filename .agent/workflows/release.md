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

## 0.3. Verify Docker Build (REQUIRED)

> [!CAUTION]
> **Must pass before release. Catches Dockerfile/dependency errors before Railway deploy.**

// turbo
```bash
docker build -f claude-cli-proxy/Dockerfile claude-cli-proxy/
```

**Expected Output:**
```
=> exporting to image
=> => writing image sha256:...
```

**If build fails:** Fix the Dockerfile or dependency files before proceeding.

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

## 5.5. Update Web Portal Release Notes

> [!IMPORTANT]
> **Every release MUST update the web portal release notes page so users can see the latest changes.**

### Files to update:
1. **`backend/public/portal/release-notes.html`** — Add a new version card at the top of the release list
2. **`backend/public/shared/i18n.js`** — Add i18n keys for the new version's features (all 8 languages)

### Steps:
1. Read the existing release notes page to understand the HTML structure
2. Add a new version section at the top (move the `rn_badge_latest` badge to the new version)
3. Add i18n keys following the pattern `rn_{VERSION_NO_DOTS}_{N}` (e.g., `rn_1110_1` for v1.11.0 feature 1)
4. Translate feature descriptions into all 8 languages (en, zh, zh-CN, ja, ko, th, vi, id)

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

## 7.5. Publish npm Plugin (if channel-api changed)

> [!NOTE]
> **Only needed when `backend/channel-api.js` or `openclaw-channel-eclaw/src/` has changed.**
> Skip this step if only Android or unrelated backend code changed.

### 判斷是否需要發佈

// turbo
```bash
git diff PREV_COMMIT..HEAD --name-only | grep -E "channel-api|openclaw-channel-eclaw/src"
```

如果有輸出 → 需要發佈 npm；如果無輸出 → 跳過此步驟。

### ⚠️ 發佈前必做：版本對齊檢查（避免踩坑！）

> [!CAUTION]
> **曾經因為跳過這步，導致發佈了錯誤的版本號（1.1.0 > 1.0.19），浪費了多次發佈機會。**
>
> **發佈前必須確認：**
> 1. **Pull 插件 repo 最新版本**：`cd openclaw-channel-eclaw && git pull origin main`
>    - 遠端 repo 可能已有更新，local 與 remote 不一致會導致衝突或覆蓋正確版本
> 2. **查看 npm 當前最高版本**：`npm view @eclaw/openclaw-channel version`
>    - 你的新版本號必須 **大於** npm 上的最高版本
>    - 若 npm 是 1.1.2，你的版本必須是 1.1.3 或更高
> 3. **永遠使用 `npm version` 指令**，不要手動編輯 `package.json` 的版本號
>    - `npm version patch` 自動 +0.0.1，且會建立 git commit + tag
>    - 手動修改容易產生 git tag 缺失、版本號不一致等問題
> 4. **發佈後同步更新 README 版本引用**（見下方步驟）

### 發佈步驟

// turbo
```bash
cd openclaw-channel-eclaw

# 0. 同步遠端最新（必做！）
git pull origin main

# 0.5 確認 npm 最高版本（必做！）
npm view @eclaw/openclaw-channel version

# 1. 更新版本號（patch = bug fix, minor = 新功能, major = breaking change）
#    確保新版本 > npm 最高版本
npm version patch

# 2. 發佈（prepublishOnly 會自動 build）
npm publish --access public

# 3. 推到獨立 GitHub repo
git push origin main
```

> [!IMPORTANT]
> Token 已設定在 `~/.npmrc`，不需要重新登入。
> 如果遇到 E403，執行：
> `npm set //registry.npmjs.org/:_authToken YOUR_AUTOMATION_TOKEN`

**驗證發佈成功：**
```
+ @eclaw/openclaw-channel@x.x.x
```

### 發佈後：更新版本引用

> [!IMPORTANT]
> **每次發佈後，必須更新所有含有版本號的文件，避免用戶使用過時的升級腳本！**

檢查以下位置是否有舊版本號需要更新：
1. `openclaw-channel-eclaw/README.md` — 升級腳本中的 `@X.Y.Z`（搜尋 `openclaw plugins install`）
2. `openclaw-channel-eclaw/KNOW-HOW.md` — 如有版本號引用
3. `openclaw-channel-eclaw/CHANGELOG.md` — 新增本次修復的說明

// turbo
```bash
# 搜尋所有版本引用
grep -r "openclaw-channel@" openclaw-channel-eclaw/ --include="*.md"
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

## 10. Clean Up Old Release Folders

> [!IMPORTANT]
> **Delete all `release_v*` folders except the current version to free up disk space.**
> Run this after both internal testing and production uploads succeed.

// turbo
```bash
# List all release folders (to review before deleting)
ls release_v*/

# Delete all except the current version (replace X.X.XX with current versionName)
ls -d release_v* | grep -v "release_vX.X.XX" | xargs rm -rf
```

**Example for v1.0.46:**
```bash
ls -d release_v* | grep -v "release_v1.0.46" | xargs rm -rf
```

**Expected result:** Only `release_v{CURRENT}/` remains in the project root.

> [!NOTE]
> The AAB is already uploaded to Google Play — local copies are not needed after release.
> The CHANGELOG.md inside the release folder is committed to git, so it is never lost.

---

## Troubleshooting (upload_to_play.js)

| Error | Cause | Fix |
|-------|-------|-----|
| `403 Forbidden` | Service account lacks permissions | Google Play Console → 使用者和權限 → 設定權限 |
| `APK/AAB not found` | AAB not built | Run `./gradlew.bat bundleRelease` first |
| `Invalid package name` | Package mismatch | Check `PACKAGE_NAME` in script = `applicationId` |
| `This Edit has been deleted` | API timeout | Re-run the script |
| `Version code already used` | Duplicate versionCode | Increment `versionCode` in `build.gradle.kts` |
