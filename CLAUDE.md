# Claude Code Instructions

## Git Workflow

- **Direct merge to main**: When work is complete, commit and merge directly to `main` branch. Do NOT create PRs or wait for approval — the user reviews all changes in real-time during the session.
- **Workflow**: develop on feature branch → commit → merge to main → push

## GitHub Authentication

When interacting with the GitHub API via `gh` CLI, read the token from the `.env` file:

```
export GH_TOKEN=$(grep GH_TOKEN .env | cut -d'=' -f2)
```

The `.env` file is gitignored and must be configured locally.

## Feature Parity Rule

**All user-facing features must be kept in sync between the Web Portal and the Android App.**
When implementing or modifying any feature on one platform, ensure the other platform is updated to match. This includes UI elements, API fields sent, string resources, and behavior.

## Debugging Server Issues

When investigating backend bugs (broadcast failure, push not delivered, etc.):

1. **Query server logs FIRST** via `GET /api/logs`
   - Requires `deviceId` + `deviceSecret` (ask user if not available)
   - Filters: `category`, `level` (info/warn/error), `since` (timestamp ms), `filterDevice`, `limit`
   - Categories: `bind`, `unbind`, `transform`, `broadcast`, `broadcast_push`, `speakto_push`, `client_push`
   - Example: `curl -s "https://eclaw.up.railway.app/api/logs?deviceId=DEVICE_ID&deviceSecret=DEVICE_SECRET&category=broadcast_push&limit=50"`

2. **Check credentials**: Look in `backend/.env` (local only, gitignored). If not available, ask user for a valid deviceId+deviceSecret pair.

## Regression Tests

- **Bot API response rate**: `node backend/tests/test-bot-api-response.js`
  - Verifies bots call POST /api/transform via exec+curl (target: 90%+)
  - Requires `TEST_DEVICE_ID` in `backend/.env` or `--device` flag
- **Broadcast flow**: `node backend/tests/test-broadcast.js`
  - Tests broadcast delivery, delivered_to tracking, speak-to, chat history
  - Requires `BROADCAST_TEST_DEVICE_ID` + `BROADCAST_TEST_DEVICE_SECRET` in `backend/.env`

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
