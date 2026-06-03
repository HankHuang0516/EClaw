"""Unit tests for EclawController — spec AC2.1 (>= 20 cases, mocked HTTP).

These run without the `mobile_use` upstream package installed; the controller
soft-imports its types so we can validate the adapter logic in isolation.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest

# Make the in-repo src/ importable when the package isn't pip-installed.
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent / "src"))

from eclaw_mobile_use_driver import (  # noqa: E402  (path setup above)
    EclawAuthError,
    EclawController,
    EclawControllerError,
    EclawDeviceOfflineError,
    EclawRateLimitError,
    EclawRemoteDisabledError,
    EclawServerError,
    EclawTransport,
)


# ---------------------------------------------------------------- fixtures

class _RouteSpec:
    __slots__ = ("status", "body", "method", "path", "expected_json_match")

    def __init__(
        self,
        *,
        status: int,
        body: Any,
        method: str = "POST",
        path: str = "/api/device/control",
        expected_json_match: dict[str, Any] | None = None,
    ) -> None:
        self.status = status
        self.body = body
        self.method = method.upper()
        self.path = path
        self.expected_json_match = expected_json_match


class _MockTransportClient:
    """Drop-in for httpx.AsyncClient — yields each scripted response in order."""

    def __init__(self, routes: list[_RouteSpec]) -> None:
        self._routes = list(routes)
        self.requests: list[tuple[str, str, dict[str, Any] | None, dict[str, Any] | None]] = []

    async def post(self, url: str, json: dict[str, Any] | None = None) -> httpx.Response:  # type: ignore[override]
        return self._record("POST", url, json_body=json)

    async def get(
        self,
        url: str,
        params: dict[str, Any] | None = None,
    ) -> httpx.Response:  # type: ignore[override]
        return self._record("GET", url, params=params)

    def _record(
        self,
        method: str,
        url: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> httpx.Response:
        self.requests.append((method, url, json_body, params))
        if not self._routes:
            raise AssertionError(f"No scripted response for {method} {url}")
        spec = self._routes.pop(0)
        assert method == spec.method, f"expected {spec.method} {spec.path}, got {method}"
        assert url.endswith(spec.path), f"expected path {spec.path}, got {url}"
        if spec.expected_json_match is not None:
            for k, v in spec.expected_json_match.items():
                assert (json_body or {}).get(k) == v, (
                    f"json field {k!r}: expected {v!r}, got {(json_body or {}).get(k)!r}"
                )
        content = json.dumps(spec.body).encode()
        return httpx.Response(
            spec.status,
            content=content,
            headers={"content-type": "application/json"},
        )

    async def aclose(self) -> None:
        return None


def _make_controller(routes: list[_RouteSpec]) -> tuple[EclawController, _MockTransportClient]:
    client = _MockTransportClient(routes)
    transport = EclawTransport(
        base_url="https://eclawbot.com",
        device_id="dev-uuid",
        bot_secret="hex32",
        entity_id=2,
        timeout_seconds=1.0,
        client=client,  # type: ignore[arg-type]
    )
    ctrl = EclawController(
        device_id="dev-uuid",
        bot_secret="hex32",
        entity_id=2,
        transport=transport,
    )
    return ctrl, client


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def _new_event_loop():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    yield
    loop.close()


# ---------------------------------------------------------------- construction

def test_constructor_rejects_empty_device_id():
    with pytest.raises(ValueError):
        EclawController(device_id="", bot_secret="x", entity_id=2)


def test_constructor_rejects_empty_bot_secret():
    with pytest.raises(ValueError):
        EclawController(device_id="d", bot_secret="", entity_id=2)


def test_constructor_rejects_entity_id_zero():
    with pytest.raises(ValueError):
        EclawController(device_id="d", bot_secret="s", entity_id=0)


def test_constructor_defaults():
    ctrl = EclawController(device_id="d", bot_secret="s")
    assert ctrl.prefer_image_screenshot is True


# ---------------------------------------------------------------- tap

def test_tap_short_press():
    ctrl, mock = _make_controller([
        _RouteSpec(
            status=200,
            body={"success": True, "dispatched": "tap"},
            expected_json_match={"command": "tap"},
        )
    ])
    out = _run(ctrl.tap({"x": 100, "y": 200}))
    # When upstream isn't installed, _build_tap_output returns a dict.
    assert getattr(out, "error", out.get("error") if isinstance(out, dict) else None) is None
    assert mock.requests[0][2]["params"] == {"x": 100, "y": 200}


def test_tap_long_press_uses_long_press_command():
    ctrl, mock = _make_controller([
        _RouteSpec(
            status=200,
            body={"success": True, "dispatched": "long_press"},
            expected_json_match={"command": "long_press"},
        )
    ])
    _run(ctrl.tap({"x": 50, "y": 60}, long_press=True, long_press_duration=900))
    sent = mock.requests[0][2]
    assert sent["params"] == {"x": 50, "y": 60, "durationMs": 900}


def test_tap_failure_returns_error_string():
    ctrl, _ = _make_controller([
        _RouteSpec(status=200, body={"success": False, "error": "tap missed"})
    ])
    out = _run(ctrl.tap({"x": 1, "y": 2}))
    err = getattr(out, "error", out.get("error") if isinstance(out, dict) else None)
    assert err == "tap missed"


# ---------------------------------------------------------------- swipe

def test_swipe_maps_coordinates_and_duration():
    ctrl, mock = _make_controller([
        _RouteSpec(
            status=200,
            body={"success": True},
            expected_json_match={"command": "swipe"},
        )
    ])
    err = _run(ctrl.swipe({"x": 1, "y": 2}, {"x": 3, "y": 4}, duration=350))
    assert err is None
    sent = mock.requests[0][2]
    assert sent["params"] == {
        "startX": 1, "startY": 2, "endX": 3, "endY": 4, "durationMs": 350,
    }


def test_swipe_failure_returns_error_message():
    ctrl, _ = _make_controller([
        _RouteSpec(status=200, body={"success": False, "error": "out of bounds"})
    ])
    err = _run(ctrl.swipe({"x": 0, "y": 0}, {"x": 1, "y": 1}))
    assert err == "out of bounds"


# ---------------------------------------------------------------- input / keys

def test_input_text_uses_type_command():
    ctrl, mock = _make_controller([
        _RouteSpec(status=200, body={"success": True}, expected_json_match={"command": "type"})
    ])
    ok = _run(ctrl.input_text("hello"))
    assert ok is True
    assert mock.requests[0][2]["params"] == {"text": "hello"}


def test_press_back_home_enter_emit_correct_commands():
    ctrl, mock = _make_controller([
        _RouteSpec(status=200, body={"success": True}, expected_json_match={"command": "back"}),
        _RouteSpec(status=200, body={"success": True}, expected_json_match={"command": "home"}),
        _RouteSpec(status=200, body={"success": True}, expected_json_match={"command": "ime_action"}),
    ])
    assert _run(ctrl.press_back()) is True
    assert _run(ctrl.press_home()) is True
    assert _run(ctrl.press_enter()) is True
    assert mock.requests[2][2]["params"] == {"action": "done"}


def test_erase_text_sends_n_ime_actions():
    ctrl, mock = _make_controller([
        _RouteSpec(status=200, body={"success": True}, expected_json_match={"command": "ime_action"}),
        _RouteSpec(status=200, body={"success": True}),
        _RouteSpec(status=200, body={"success": True}),
    ])
    ok = _run(ctrl.erase_text(3))
    assert ok is True
    assert len(mock.requests) == 3
    assert all(r[2]["params"] == {"action": "delete"} for r in mock.requests)


def test_erase_text_default_one_char():
    ctrl, mock = _make_controller([
        _RouteSpec(status=200, body={"success": True}),
    ])
    _run(ctrl.erase_text())
    assert len(mock.requests) == 1


# ---------------------------------------------------------------- apps / urls

def test_launch_app_sends_both_package_and_bundle():
    ctrl, mock = _make_controller([
        _RouteSpec(status=200, body={"success": True}, expected_json_match={"command": "launch_app"})
    ])
    _run(ctrl.launch_app("com.android.settings"))
    sent = mock.requests[0][2]["params"]
    assert sent["packageName"] == "com.android.settings"
    assert sent["bundleId"] == "com.android.settings"


def test_terminate_app_uses_stop_app():
    ctrl, mock = _make_controller([
        _RouteSpec(status=200, body={"success": True}, expected_json_match={"command": "stop_app"})
    ])
    _run(ctrl.terminate_app("com.example"))
    assert mock.requests[0][2]["params"]["packageName"] == "com.example"


def test_open_url_uses_launch_app_with_intent_url():
    ctrl, mock = _make_controller([
        _RouteSpec(status=200, body={"success": True}, expected_json_match={"command": "launch_app"})
    ])
    _run(ctrl.open_url("https://example.com"))
    assert mock.requests[0][2]["params"] == {"intentUrl": "https://example.com"}


def test_launch_app_rejects_empty_id():
    ctrl, _ = _make_controller([])
    with pytest.raises(ValueError):
        _run(ctrl.launch_app(""))


# ---------------------------------------------------------------- screen

def test_screenshot_uses_screen_image_by_default():
    ctrl, mock = _make_controller([
        _RouteSpec(
            method="GET",
            path="/api/device/screen-image",
            status=200,
            body={"success": True, "image": "BASE64PNG", "byteSize": 1234},
        )
    ])
    img = _run(ctrl.screenshot())
    assert img == "BASE64PNG"


def test_screenshot_falls_back_to_screen_capture_when_prefer_image_false():
    ctrl, mock = _make_controller([
        _RouteSpec(
            method="GET",
            path="/api/device/screen-capture",
            status=200,
            body={"success": True, "image": "TREEPNG", "elements": []},
        )
    ])
    ctrl.prefer_image_screenshot = False
    img = _run(ctrl.screenshot())
    assert img == "TREEPNG"


def test_screenshot_missing_image_raises():
    ctrl, _ = _make_controller([
        _RouteSpec(
            method="GET",
            path="/api/device/screen-image",
            status=200,
            body={"success": True},
        )
    ])
    with pytest.raises(EclawControllerError):
        _run(ctrl.screenshot())


def test_get_screen_data_returns_payload_dict_when_upstream_absent():
    ctrl, _ = _make_controller([
        _RouteSpec(
            method="GET",
            path="/api/device/screen-capture",
            status=200,
            body={
                "success": True,
                "image": "B",
                "elements": [{"text": "OK"}],
                "width": 1080,
                "height": 2400,
                "platform": "android",
            },
        )
    ])
    data = _run(ctrl.get_screen_data())
    # Without upstream pydantic, controller returns a plain dict.
    elements = getattr(data, "elements", None) or data["elements"]
    assert elements == [{"text": "OK"}]


def test_find_element_by_text_returns_error_none_and_centered_bounds():
    # Successful match: upstream contract is `(node, bounds, None)`. Bounds
    # must expose `.get_center()` because `UnifiedMobileController.tap_element()`
    # does `bounds.get_center()` after the error-None check.
    ctrl, _ = _make_controller([])
    nodes = [
        {"resource-id": "r1", "text": "Settings", "bounds": "[0,0][100,40]"},
        {"resource-id": "r2", "text": "Wifi", "bounds": "[0,40][100,80]"},
    ]
    node, bounds, err = ctrl.find_element(nodes, text="Wifi")
    assert err is None
    assert node is not None and node["resource-id"] == "r2"
    assert bounds is not None and hasattr(bounds, "get_center")
    center = bounds.get_center()
    cx = center["x"] if isinstance(center, dict) else center.x
    cy = center["y"] if isinstance(center, dict) else center.y
    assert (cx, cy) == (50, 60)


def test_find_element_no_match_returns_descriptive_error():
    ctrl, _ = _make_controller([])
    node, bounds, err = ctrl.find_element([{"text": "X"}], text="Y")
    assert node is None
    assert bounds is None
    assert err and "no element matches" in err


def test_find_element_no_selector_returns_error():
    ctrl, _ = _make_controller([])
    node, bounds, err = ctrl.find_element([{"text": "X"}])
    assert (node, bounds) == (None, None)
    assert err and "no selector" in err


def test_find_element_index_out_of_range_returns_error():
    ctrl, _ = _make_controller([])
    nodes = [{"text": "T", "bounds": "[0,0][10,10]"}]
    node, bounds, err = ctrl.find_element(nodes, text="T", index=2)
    assert (node, bounds) == (None, None)
    assert err and "out of range" in err


def test_find_element_parses_android_bounds_string():
    ctrl, _ = _make_controller([])
    nodes = [{"resource-id": "r", "text": "T", "bounds": "[10,20][30,40]"}]
    _, bounds, err = ctrl.find_element(nodes, text="T")
    assert err is None
    assert bounds is not None
    # The shim compares equal to the legacy dict shape for backward-compat
    # callers that don't yet use `.get_center()`.
    assert bounds == {"x1": 10, "y1": 20, "x2": 30, "y2": 40}
    assert bounds.get_center() == {"x": 20, "y": 30}


# ---------------------------------------------------------------- error mapping

def test_401_raises_auth_error():
    ctrl, _ = _make_controller([
        _RouteSpec(status=401, body={"success": False, "error": "bad creds"})
    ])
    with pytest.raises(EclawAuthError):
        _run(ctrl.input_text("hi"))


def test_403_remote_disabled_raises_specific_error():
    ctrl, _ = _make_controller([
        _RouteSpec(status=403, body={"success": False, "error": "remote_control_disabled"})
    ])
    with pytest.raises(EclawRemoteDisabledError):
        _run(ctrl.press_home())


def test_404_raises_device_offline():
    ctrl, _ = _make_controller([
        _RouteSpec(status=404, body={"error": "device not connected"})
    ])
    with pytest.raises(EclawDeviceOfflineError):
        _run(ctrl.press_home())


def test_500_raises_server_error():
    ctrl, _ = _make_controller([
        _RouteSpec(status=500, body={"error": "internal"})
    ])
    with pytest.raises(EclawServerError):
        _run(ctrl.press_home())


def test_429_retries_then_succeeds(monkeypatch):
    # Patch asyncio.sleep so the test doesn't actually wait.
    sleeps: list[float] = []

    async def _no_sleep(seconds):
        sleeps.append(seconds)

    import eclaw_mobile_use_driver.transport as transport_mod
    monkeypatch.setattr(transport_mod.asyncio, "sleep", _no_sleep)
    ctrl, mock = _make_controller([
        _RouteSpec(status=429, body={"error": "rate limit"}),
        _RouteSpec(status=429, body={"error": "rate limit"}),
        _RouteSpec(status=200, body={"success": True}),
    ])
    ok = _run(ctrl.press_home())
    assert ok is True
    assert len(sleeps) == 2  # two backoffs before the success on attempt 3
    assert len(mock.requests) == 3


def test_429_exhausts_retries_and_raises(monkeypatch):
    async def _no_sleep(seconds):
        return None

    import eclaw_mobile_use_driver.transport as transport_mod
    monkeypatch.setattr(transport_mod.asyncio, "sleep", _no_sleep)
    ctrl, mock = _make_controller([
        _RouteSpec(status=429, body={"error": "rate"}),
        _RouteSpec(status=429, body={"error": "rate"}),
        _RouteSpec(status=429, body={"error": "rate"}),
        _RouteSpec(status=429, body={"error": "rate"}),
    ])
    with pytest.raises(EclawRateLimitError):
        _run(ctrl.press_home())
    assert len(mock.requests) == 4  # initial + 3 retries


# ---------------------------------------------------------------- video / cleanup

def test_video_recording_not_implemented():
    ctrl, _ = _make_controller([])
    with pytest.raises(NotImplementedError):
        _run(ctrl.start_video_recording())
    with pytest.raises(NotImplementedError):
        _run(ctrl.stop_video_recording())


def test_get_compressed_b64_screenshot_returns_input_when_pillow_missing():
    ctrl, _ = _make_controller([])
    if "PIL" in sys.modules:
        pytest.skip("Pillow installed — degrade path is not exercisable")
    out = ctrl.get_compressed_b64_screenshot("AAAA")
    assert out == "AAAA"


def test_cleanup_does_not_close_injected_client():
    ctrl, mock = _make_controller([])
    _run(ctrl.cleanup())
    # MockTransportClient has no closed state — just assert no exception.
    assert isinstance(mock, _MockTransportClient)


# ---------------------------------------------------------------- get_ui_hierarchy

def test_get_ui_hierarchy_proxies_screen_capture():
    ctrl, _ = _make_controller([
        _RouteSpec(
            method="GET",
            path="/api/device/screen-capture",
            status=200,
            body={
                "success": True,
                "image": "",
                "elements": [{"text": "Home"}],
                "width": 1, "height": 1, "platform": "android",
            },
        )
    ])
    hier = _run(ctrl.get_ui_hierarchy())
    assert hier == [{"text": "Home"}]
