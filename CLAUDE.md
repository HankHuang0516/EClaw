# Claude Code Instructions

## Workflow Orchestration Rules

1. **Plan Mode Default** — 收到新任務時，先進入 Plan Mode（只讀 + 搜索），產出一份 step-by-step 計畫並讓使用者確認後才動手寫程式碼。

2. **Subagent Strategy** — 遇到需要大量搜索或分析的子任務，使用 Task tool 派出 subagent（Explore / Plan / Bash）並行處理，減少主對話的 context 消耗。

3. **Self-Improvement Loop** — 每次 session 結束前，把學到的 codebase 知識、常見陷阱、偏好寫回 CLAUDE.md，讓下一個 session 的 Claude 不必從零開始。

4. **Verification Before Done** — 修改程式碼後必須跑 lint / type-check / test；若任何一步失敗就修到通過為止，不把破損的 code commit。

5. **Demand Elegance (Balanced)** — 在保持 minimal change 的前提下，追求可讀、一致的程式風格；不為了「漂亮」而過度重構，但也不容忍明顯的 code smell 在新增的程式碼中出現。

6. **Autonomous Bug Fixing** — 當執行過程中遇到錯誤（build fail、test fail、runtime error），不要立刻停下來問使用者，先自行分析 log 並嘗試修復，連續失敗 3 次才 escalate。

7. **Task Management**
   - 所有多步驟工作都使用 TodoWrite 追蹤，讓使用者隨時可見進度
   - 完成一項立即標記 completed，不批量更新
   - 同時只有一個 task 可以是 in_progress

8. **Core Principles**
   - 安全第一（不引入 OWASP Top-10 漏洞）
   - 不臆測（先讀再改）
   - 最小驚訝原則（行為與命名一致）
   - DRY but not premature abstraction
   - 優先使用專用工具（Read > cat, Edit > sed, Grep > grep）

## Git Workflow

- **Direct merge to main**: When work is complete, commit and merge directly to `main` branch. Do NOT create PRs or wait for approval — the user reviews all changes in real-time during the session.
- **Workflow**: develop on feature branch → commit → merge to main → push

## GitHub PR Creation

在雲端環境（Claude Code remote）中無法訪問外網，不要嘗試用 `gh` CLI 或 GitHub REST API 建立 PR。
當需要提供 PR 連結時，直接給出 compare URL：
```
https://github.com/HankHuang0516/realbot/compare/main...<branch-name>
```

## Feature Parity Rule

**All user-facing features must be kept in sync between the Web Portal and the Android App.**
When implementing or modifying any feature on one platform, ensure the other platform is updated to match. This includes UI elements, API fields sent, string resources, and behavior.

## Debugging Server Issues

When investigating backend bugs (broadcast failure, push not delivered, etc.):

1. **Query server logs FIRST** via `GET /api/logs`
   - Requires `deviceId` + `deviceSecret` (ask user if not available)
   - Filters: `category`, `level` (info/warn/error), `since` (timestamp ms), `filterDevice`, `limit`
   - Categories: `bind`, `unbind`, `transform`, `broadcast`, `broadcast_push`, `speakto_push`, `client_push`, `entity_poll`
   - Example: `curl -s "https://eclaw.up.railway.app/api/logs?deviceId=DEVICE_ID&deviceSecret=DEVICE_SECRET&category=broadcast_push&limit=50"`

2. **Check credentials**: Look in `backend/.env` (local only, gitignored). If not available, ask user for a valid deviceId+deviceSecret pair.

## Regression Tests

- **Bot API response rate**: `node backend/tests/test-bot-api-response.js`
  - Verifies bots call POST /api/transform via exec+curl (target: 90%+)
  - Requires `TEST_DEVICE_ID` in `backend/.env` or `--device` flag
- **Broadcast flow**: `node backend/tests/test-broadcast.js`
  - Tests broadcast delivery, delivered_to tracking, speak-to, chat history
  - Requires `BROADCAST_TEST_DEVICE_ID` + `BROADCAST_TEST_DEVICE_SECRET` in `backend/.env`

## Git Workflow

工作完成後直接 commit 並 merge 到 main，不建立 PR、不等待額外批准。

## Deployment

- Railway auto-deploys from `backend/` folder on push to main
- `railway.json` sets `startCommand: "node index.js"` (root dir = `backend/`)
- Changes to root files do NOT trigger deployment — must change files under `backend/`

## Key Architecture

- Backend: `backend/index.js` — Express server on Railway
- API Base: `https://eclaw.up.railway.app`
- 4 entity slots per device (0-3), each independently bindable
- Bots use OpenClaw platform (Zeabur), communicate via webhook push + exec+curl
- Push notifications use instruction-first format with pre-filled curl templates

## Device Telemetry (AI Debug Buffer)

Every device has a structured telemetry buffer (~1 MB cap) at `POST/GET/DELETE /api/device-telemetry`.
This buffer is the **primary data source for AI-automated debugging**.

### Auto-captured (no action needed)
- **Backend middleware** auto-logs every device-scoped API call (endpoint, params, response, duration)
- **Web `telemetry.js`** auto-tracks page views + wraps `apiCall()` for all portal pages
- **Android `TelemetryInterceptor`** auto-logs all OkHttp requests via interceptor

### When adding new features — MUST DO:
1. **New backend endpoint**: If it accepts `deviceId`, the middleware captures it automatically. No action needed.
2. **New web portal page**: Include `<script src="../shared/telemetry.js"></script>` AFTER `auth.js`. Page view auto-tracked.
3. **New Android Activity**: Call `TelemetryHelper.trackPageView(context, "page_name")` in `onResume()`.
4. **New user-facing action** (button click, dialog, etc.): Call `telemetry.trackAction()` (web) or `TelemetryHelper.trackAction()` (Android).
5. **Error handling**: Call `telemetry.trackError()` / `TelemetryHelper.trackError()` in catch blocks for user-visible errors.

### Querying telemetry for debugging
```bash
# Get summary (usage, type breakdown)
curl "https://eclaw.up.railway.app/api/device-telemetry/summary?deviceId=ID&deviceSecret=SECRET"

# Get all entries (newest 500)
curl "https://eclaw.up.railway.app/api/device-telemetry?deviceId=ID&deviceSecret=SECRET"

# Filter by type
curl "https://eclaw.up.railway.app/api/device-telemetry?deviceId=ID&deviceSecret=SECRET&type=api_req"

# Filter by time range
curl "https://eclaw.up.railway.app/api/device-telemetry?deviceId=ID&deviceSecret=SECRET&since=TIMESTAMP_MS"
```

### Key files
- Backend module: `backend/device-telemetry.js`
- Web SDK: `backend/public/shared/telemetry.js`
- Android interceptor: `app/.../data/remote/TelemetryInterceptor.kt`
- Android helper: `app/.../data/remote/TelemetryHelper.kt`
