# EClaw ↔ minitap-ai/mobile-use integration spec

| | |
|---|---|
| Card | `card_7579f20522a8276240736c7d` |
| Linked prev | `card_aa15ed2618c9246d11a0f6b1` (research) |
| Linked next | `card_f693378a99739c82776c1978` (M1 impl) → `card_4331b6d7e31bcb808bfc1733` (M2 impl) |
| Status | Spec / P1 |
| Date | 2026-06-03 |
| Author | #2 (LOBSTER) |

## 1. Motivation

The research card `card_aa15ed26` ([report](../research/2026-06-03-mobile-use-comparison.md)) shows that EClaw and minitap-ai/mobile-use solve the same surface problem (LLM agent drives mobile UI) from opposite directions:

- **EClaw** is a stateless device-control relay. Backend has no agent loop; any external caller decides next action. 6 action primitives. Strong in multi-tenancy + iOS real-device + worldwide reach.
- **mobile-use** is a full-stack LangGraph mobile agent. 8 specialised agents (planner/cortex/executor/orchestrator/contextor/outputter/summarizer/video_analyzer). 13+ action primitives. Strong in agent-driven task decomposition + multi-LLM, but assumes developer-host adb/idb access.

By exposing EClaw as a `DeviceController` subclass that mobile-use's LangGraph can drive, we get:

1. **mobile-use users gain real-device + iOS support** they don't have today, via EClaw's worldwide installed base.
2. **EClaw users gain an off-the-shelf agent loop** without writing planner/executor code.
3. **Both keep their architectural strengths** — EClaw stays stateless, mobile-use stays platform-agnostic.

This spec covers two milestones:
- **M1** — EClaw control API expands to match mobile-use's primitive set + adds screen-image.
- **M2** — Python `EclawController(DeviceController)` ships as a mobile-use plugin (upstream PR or fork-as-extension).

## 1.1 Non-goals (v1)

- Driving EClaw devices from mobile-use **without** the user already owning an EClaw deviceSecret. Auth is unchanged.
- mobile-use planner / cortex modifications. Plugin only.
- Browser / web target. mobile-use's mobile focus is preserved.
- Replacing EClaw's existing 6 primitives. They stay, M1 only adds.

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Caller machine (mac / linux / cloud)                           │
│                                                                  │
│   $ python -m mobile_use "Open Settings, tell me battery level" │
│                          │                                       │
│                          ▼                                       │
│   ┌──────────────────────────────────────┐                      │
│   │  mobile-use LangGraph                │                      │
│   │  ┌──────────┐  ┌──────────┐  ┌─────┐ │                      │
│   │  │ planner  │→ │ cortex   │→ │exec │ │                      │
│   │  └──────────┘  └──────────┘  └──┬──┘ │                      │
│   └─────────────────────────────────┼────┘                      │
│                                     │ controller.tap(x,y)        │
│                                     │ controller.screenshot()    │
│                                     ▼                            │
│   ┌──────────────────────────────────────┐                      │
│   │  EclawController(DeviceController)   │  ← M2 deliverable    │
│   │  - HTTP POST /api/device/control     │                      │
│   │  - HTTP POST /api/device/screen-image│                      │
│   └─────────────────────────────────────┬┘                      │
└─────────────────────────────────────────┼─────────────────────────┘
                                          │  HTTPS
                                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  eclawbot.com (Railway)                                          │
│                                                                  │
│   ┌──────────────────────────────────────┐                      │
│   │  backend/index.js                    │                      │
│   │  /api/device/control   ◄── M1 expand│  swipe/long_press/   │
│   │  /api/device/screen-image ◄── M1 new│  launch_app/stop_app │
│   │  Socket.IO relay                     │                      │
│   └─────────────────────────────────────┬┘                      │
└─────────────────────────────────────────┼─────────────────────────┘
                                          │  Socket.IO
                                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  User device (Android / iOS) running EClaw app                  │
│                                                                  │
│   ┌──────────────────────────────────────┐                      │
│   │  AndroidAccessibilityService /        │ ← M1 native handlers │
│   │  iOS XCUITest helpers / WebView shim  │                      │
│   │  + MediaProjection screen-image       │                      │
│   └──────────────────────────────────────┘                      │
└─────────────────────────────────────────────────────────────────┘
```

Key contract: EclawController is a **thin adapter**. It does not maintain any agent state — that lives in the LangGraph. EClaw backend remains a stateless relay. The only persistent state is the user's existing `deviceSecret` ↔ device binding.

## 3. M1 — Backend API contract

### 3.1 `/api/device/control` — expanded command set

Existing commands (unchanged): `tap`, `type`, `scroll`, `back`, `home`, `ime_action`.

New commands:

| command | params | semantics |
|---|---|---|
| `swipe` | `{startX, startY, endX, endY, durationMs?}` | Single-finger swipe. Default duration 200ms. |
| `long_press` | `{x, y, durationMs?}` | Long press at point. Default duration 800ms. |
| `launch_app` | `{packageName}` (Android) or `{bundleId}` (iOS) | Launch by app id. Fails if not installed. |
| `stop_app` | `{packageName}` / `{bundleId}` | Force-stop the named app. |

Request body (POST JSON):
```json
{
  "deviceId": "<uuid>",
  "botSecret": "<32-hex>",
  "entityId": 2,
  "command": "swipe",
  "params": {"startX": 100, "startY": 800, "endX": 100, "endY": 200, "durationMs": 250}
}
```

Response:
```json
{"success": true, "dispatched": "swipe", "ackedAt": 1780486200000}
```

Error model: `400` on missing/invalid params; `401` on bad creds; `404` if device not connected; `429` if rate-limit exceeded; `500` on Socket.IO relay failure.

### 3.2 `/api/device/screen-image` — new endpoint

Long-poll capture of a raw screen image (PNG). Coexists with the existing `/api/device/screen-capture` which returns UI tree + element list.

Request:
```
GET /api/device/screen-image?deviceId=<uuid>&botSecret=<hex>&entityId=2&maxBytes=500000
```

Response (success):
```json
{
  "success": true,
  "image": "<base64 PNG>",
  "width": 1080,
  "height": 2400,
  "byteSize": 184230,
  "timestamp": 1780486201000
}
```

Compression: app-side downscales to fit `maxBytes` (default 500 KB) using Android Bitmap.compress() / iOS JPEG fallback. mobile-use's vision agent token cost scales with image bytes; 500 KB ≈ 2-3k tokens for Claude Sonnet vision, acceptable per task step.

Rate-limit: same 500 ms minimum between captures as `/screen-capture`. Both endpoints share a single per-device cool-down counter.

### 3.3 Gating — per-user, not global

The M1 commands + `/screen-image` are always available on the API surface, exactly like the existing 6 primitives. Per-user opt-in is the existing `remote_control_enabled` device preference (toggled by the user in app Settings, persisted via `/api/device-preferences`). No global env flag gates the feature for the whole platform.

This is a hard rule from `feedback_platform_user_rule_compliance`: EClawbot is a global agent-collab platform and a single env var on Railway must not decide behaviour for every user worldwide. (Earlier drafts of this spec had an `ECLAW_MOBILE_USE_API_ENABLED` global flag; that was reverted in `card_f03617476ab053d54384ae79` before any production user reached the endpoints.)

## 4. M1 — Native handler contract

### 4.1 Android

Action primitives dispatched via Socket.IO event `device:control-command` with shape `{command, params}`.

```kotlin
// app/.../control/ControlDispatcher.kt
when (command) {
  "swipe" -> accessibilityService.dispatchGesture(buildSwipe(params))
  "long_press" -> accessibilityService.dispatchGesture(buildLongPress(params))
  "launch_app" -> startActivity(packageManager.getLaunchIntentForPackage(params.packageName))
  "stop_app" -> activityManager.killBackgroundProcesses(params.packageName)
  // existing commands unchanged
}
```

Screen image capture: existing `MediaProjection` flow reused; new path returns full-frame Bitmap via `Bitmap.compress(PNG, quality=85, stream)`, base64-encoded into the Socket.IO ACK.

### 4.2 iOS

iOS v1 has no XCUITest runtime in shipped app. Three options ranked by effort:

1. **WebView shim only (v1 default)**: implement `swipe`/`long_press` via JS dispatched into the active WebView for portal-page-driven tests. Native apps (Settings, etc.) NOT reachable.
2. **Accessibility query + tap** (v1.5): use UIAccessibilityElement queries to locate then synthesise tap events. Works for accessibility-flagged apps only.
3. **EClaw app sideloads idb-companion** (v2): adopt fb-idb's idb-companion approach. Heavy; needs Apple-private SPI. Out of scope for M1.

M1 ships option 1; M2 documents iOS limitation in EclawController docstring.

## 5. M2 — `EclawController(DeviceController)` Python class

### 5.1 Class signature

```python
from mobile_use.controllers.device_controller import DeviceController

class EclawController(DeviceController):
    def __init__(
        self,
        device_id: str,
        bot_secret: str,
        entity_id: int = 2,
        base_url: str = "https://eclawbot.com",
        timeout_seconds: float = 8.0,
        prefer_image_screenshot: bool = True,
    ):
        ...
```

`prefer_image_screenshot=True` calls `/api/device/screen-image`; `False` calls `/api/device/screen-capture` for UI tree only (cheaper).

### 5.2 Method mapping

| mobile-use abstract method | EClaw call |
|---|---|
| `tap(x, y)` | POST /api/device/control `{command:"tap", params:{x,y}}` |
| `swipe(x1, y1, x2, y2, duration)` | POST /api/device/control `{command:"swipe", params:{startX, startY, endX, endY, durationMs}}` |
| `long_press(x, y, duration)` | POST /api/device/control `{command:"long_press", params:{x, y, durationMs}}` |
| `input_text(text)` | POST /api/device/control `{command:"type", params:{text}}` |
| `press_key(key)` | POST /api/device/control `{command:"home" \| "back" \| "ime_action"}` (mapped) |
| `launch_app(name)` | POST /api/device/control `{command:"launch_app", params:{packageName \| bundleId}}` |
| `stop_app(name)` | POST /api/device/control `{command:"stop_app", params:{packageName \| bundleId}}` |
| `screenshot()` | GET /api/device/screen-image (or /screen-capture if not preferred) |
| `back()` | POST /api/device/control `{command:"back"}` |
| `open_link(url)` | POST /api/device/control `{command:"launch_app", params:{intentUrl: url}}` — Android only v1; iOS via WebView shim |
| `wait_for_delay(ms)` | client-side `time.sleep(ms/1000)` — no server call |
| `video_recording` | **not supported v1**; raises `NotImplementedError` |
| `focus_and_clear_text` / `focus_and_input_text` / `erase_one_char` | client-side: combo of tap + ime_action + type |

mobile-use primitives not in EClaw's M1 set are **polyfilled client-side** (sequences of M1 calls) where possible; otherwise the controller raises `NotImplementedError` with a clear message so the planner can re-plan.

### 5.3 Error model

```python
class EclawControllerError(Exception): pass
class EclawAuthError(EclawControllerError): pass        # 401
class EclawDeviceOfflineError(EclawControllerError): pass # 404 + 'device not connected'
class EclawRateLimitError(EclawControllerError): pass     # 429
class EclawServerError(EclawControllerError): pass        # 5xx
```

mobile-use's executor retries on `EclawRateLimitError` with jittered backoff (3 attempts, 200 ms → 600 ms → 1500 ms). Other errors bubble to the orchestrator which can re-plan.

### 5.4 Package layout (fork-as-extension recommended)

```
eclaw-mobile-use-driver/        # standalone PyPI package, MIT-licensed
├── README.md
├── LICENSE                     # MIT (or Apache-2.0 if matching upstream)
├── NOTICE                      # cites minitap-ai/mobile-use as the parent abstraction
├── pyproject.toml
├── src/eclaw_mobile_use_driver/
│   ├── __init__.py
│   ├── controller.py           # EclawController(DeviceController)
│   ├── transport.py            # HTTP client + retries
│   └── errors.py
└── tests/
    ├── test_controller_unit.py # mock HTTP
    └── test_integration.py     # against EClaw staging
```

Why fork-as-extension over upstream PR:
- Upstream churns fast (10 releases since 2025; latest Jan 2026). Bundling our adapter inside their tree adds release coordination overhead.
- mobile-use's `DeviceController` is a stable Python interface; extensions can ship out-of-tree.
- Hank's `feedback_no_new_api_keys` constraint is easier to enforce in our own repo.

If upstream interest is high (will probe via GitHub issue), an upstream PR can follow as a wrapper.

## 6. Acceptance criteria

### 6.1 M1 acceptance (card_f693378a99739c82776c1978)

- **AC1.1** — `jest` tests: 4 new commands + screen-image endpoint each pass authentication, param validation, rate-limit (`backend/tests/jest/screen-control.test.js` extends to ≥ 25 cases total).
- **AC1.2** — Live probe: a bash script on this Mac drives a real Android emulator through all 4 new commands; expected screen changes confirmed via accessibility tree before/after.
- **AC1.3** — `/api/device/screen-image` returns base64 PNG ≤ 500 KB; decoded image header is valid PNG.
- **AC1.4** — Per-user gate: `remote_control_enabled=false` on a device → all 4 new commands + screen-image return `403 {error: "remote_control_disabled"}` exactly like the existing 6 primitives. No global env flag involved.
- **AC1.5** — `/api/help?intent=mobile-use` returns curl examples for all new endpoints.
- **AC1.6** — Spec PR cites this doc section.

### 6.2 M2 acceptance (card_4331b6d7e31bcb808bfc1733)

- **AC2.1** — `pytest -q` runs all unit tests in `tests/test_controller_unit.py` green (≥ 20 cases, mocked HTTP).
- **AC2.2** — Live integration: run `mobile-use "Open Settings, tell me my battery level"` against EClaw Android emu via `EclawController`. LangGraph console screenshot attached. Battery level extracted matches emulator state.
- **AC2.3** — License attribution: NOTICE cites mobile-use Apache-2.0 + minitap-ai author; LICENSE file in driver repo is permissive (MIT or Apache-2.0).
- **AC2.4** — README documents M1 dependency + EclawController constructor + iOS limitation (option 1 only).
- **AC2.5** — If upstream PR: URL in card comment; if fork-as-extension: PyPI / GitHub repo URL in card comment.

## 7. Rollback

M1: revert PR. Endpoint set returns to 6 commands. (No env flag exists; per-user `remote_control_enabled` gate keeps the existing surface unchanged.)

M2: driver lives in its own repo / PyPI package. Removing the user's `pip install eclaw-mobile-use-driver` reverts.

No EClaw DB migration. No mobile-use upstream change in v1 (extension model). Risk surface is contained to:
- A few hundred lines in `backend/index.js` (M1)
- A few hundred lines in Python driver (M2)
- App-side gesture / image capture handlers (M1)

## 8. References

- Research card: `card_aa15ed2618c9246d11a0f6b1` → [report](../research/2026-06-03-mobile-use-comparison.md)
- minitap-ai/mobile-use: https://github.com/minitap-ai/mobile-use (Apache-2.0, v3.3.0 Jan 2026, 2.6k stars)
- EClaw remote-control inventory: `backend/index.js` `/api/device/*`, `backend/public/portal/screen-control.html`, `app/.../ChatJsBridge.java`
- Memory: `feedback_spec_first`, `feedback_planning_via_macf`, `feedback_no_new_api_keys`, `feedback_link_card_full_e2e_required`
