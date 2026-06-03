# eclaw-mobile-use-driver

`EclawController` is a [`MobileDeviceController`](https://github.com/minitap-ai/mobile-use/blob/main/minitap/mobile_use/controllers/device_controller.py) implementation that drives [EClawbot](https://eclawbot.com)-connected devices from [`minitap-ai/mobile-use`](https://github.com/minitap-ai/mobile-use). The LangGraph agent in mobile-use can now plan-and-execute tasks against any Android/iOS device that has the EClaw app installed and `remote_control_enabled` toggled on by its owner.

This is **M2** of the integration plan. The companion M1 backend work shipped to `eclawbot.com` in [EClaw PR #3125](https://github.com/HankHuang0516/EClaw/pull/3125) and added the `/api/device/control` primitives (`swipe`, `long_press`, `launch_app`, `stop_app`) plus the new `/api/device/screen-image` endpoint that this driver consumes.

Authoritative spec — [`docs/specs/mobile-use-integration.md`](../docs/specs/mobile-use-integration.md) §5.

## Install

```bash
pip install eclaw-mobile-use-driver
# Optional — installs the upstream mobile-use agent runtime alongside the driver
pip install "eclaw-mobile-use-driver[mobile-use]"
```

The driver depends only on `httpx`. The upstream `mobile-use` package is an
optional install so unit tests and standalone curl-style automation can run
without pulling in LangGraph + multiple LLM SDKs.

## Quick start

```python
import asyncio
from eclaw_mobile_use_driver import EclawController

async def main():
    ctrl = EclawController(
        device_id="480def4c-2183-4d8e-afd0-b131ae89adcc",
        bot_secret="********",
        entity_id=2,
    )
    await ctrl.launch_app("com.android.settings")
    image = await ctrl.screenshot()        # base64 PNG
    await ctrl.tap({"x": 540, "y": 1200})
    await ctrl.cleanup()

asyncio.run(main())
```

To drive it from mobile-use:

```python
from minitap.mobile_use import run_task
from eclaw_mobile_use_driver import EclawController

ctrl = EclawController(device_id="...", bot_secret="...")
run_task("Open Settings and tell me my battery level", controller=ctrl)
```

## Method mapping

| `MobileDeviceController` method | EClaw call |
|---|---|
| `tap(coords)` | `POST /api/device/control {command:"tap", params:{x,y}}` |
| `tap(coords, long_press=True)` | `POST /api/device/control {command:"long_press", ...}` |
| `swipe(start, end, duration)` | `POST /api/device/control {command:"swipe", params:{startX, startY, endX, endY, durationMs}}` |
| `input_text(text)` | `POST /api/device/control {command:"type", params:{text}}` |
| `press_back()` / `press_home()` / `press_enter()` | `POST /api/device/control {command:"back"\|"home"\|"ime_action"}` |
| `launch_app(id)` | `POST /api/device/control {command:"launch_app", params:{packageName, bundleId}}` |
| `terminate_app(id)` | `POST /api/device/control {command:"stop_app", params:{packageName, bundleId}}` |
| `open_url(url)` | `POST /api/device/control {command:"launch_app", params:{intentUrl}}` (Android) |
| `screenshot()` | `GET /api/device/screen-image` (or `/screen-capture` if `prefer_image_screenshot=False`) |
| `get_screen_data()` / `get_ui_hierarchy()` | `GET /api/device/screen-capture` |
| `erase_text(n)` | sequence of `{command:"ime_action", params:{action:"delete"}}` |
| `find_element` | client-side linear scan over `screen-capture.elements` |
| `start_video_recording` / `stop_video_recording` | `NotImplementedError` (planner re-plans with screenshot loop) |
| `get_compressed_b64_screenshot` | client-side Pillow JPEG re-encode (degrades to no-op if Pillow absent) |

## Errors

```python
from eclaw_mobile_use_driver import (
    EclawControllerError,
    EclawAuthError,            # 401 — bad creds
    EclawDeviceOfflineError,   # 404 / 5xx with device_offline body
    EclawRateLimitError,       # 429 — auto-retried 3× with backoff (200/600/1500 ms)
    EclawServerError,          # 5xx
    EclawRemoteDisabledError,  # 403 — owner has not enabled remote control
)
```

Rate-limited calls retry transparently per spec §5.3. Other errors bubble so the
mobile-use orchestrator can re-plan.

## iOS limitation (v1)

Per spec §4.2, EClaw v1 supports iOS only through the portal WebView shim. That
means `launch_app` / `terminate_app` work for Android packages immediately, but
on iOS they currently target the in-app WebView. Native iOS apps (Settings,
Mail, Safari shell, etc.) are out of scope for M2; M3 will adopt
`idb-companion` (or equivalent) once Apple-private SPI access is sorted.

## Auth

The driver passes the `deviceId` / `botSecret` / `entityId` triple in the JSON
body of every `POST` and in query params for `GET`s — identical to every other
EClaw API call. No new API keys, no environment-variable global flags. The
per-user `remote_control_enabled` device preference is the only gate; toggle it
from Settings inside the EClaw app.

## Testing

```bash
pip install -e ".[dev]"
pytest -q tests/test_controller_unit.py
```

The unit suite has 30+ cases and runs in under a second; it does not require
the upstream `mobile-use` install (the controller soft-imports upstream types).

## License

MIT — see [LICENSE](LICENSE). Upstream `mobile-use` is Apache-2.0; see
[NOTICE](NOTICE).
