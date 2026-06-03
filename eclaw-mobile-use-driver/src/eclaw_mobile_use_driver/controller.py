"""EclawController — a MobileDeviceController implementation backed by EClawbot.

Implements the upstream `MobileDeviceController` Protocol so a LangGraph agent
in `minitap-ai/mobile-use` can drive any EClaw-connected device by deviceSecret.

Spec: docs/specs/mobile-use-integration.md §5
"""

from __future__ import annotations

import base64
import time
from typing import TYPE_CHECKING, Any

from .errors import EclawControllerError
from .transport import EclawTransport

if TYPE_CHECKING:
    # Upstream types are only used for type hints; we don't want a hard import
    # at module load time so unit tests can run without the full mobile-use
    # install. Runtime callers will already have mobile-use available.
    from minitap.mobile_use.controllers.device_controller import (  # pragma: no cover
        MobileDeviceController,
        ScreenDataResponse,
    )
    from minitap.mobile_use.controllers.types import (  # pragma: no cover
        Bounds,
        CoordinatesSelectorRequest,
        TapOutput,
    )
    from minitap.mobile_use.utils.video import VideoRecordingResult  # pragma: no cover


def _coerce_xy(obj: Any) -> tuple[int, int]:
    """Accept either a pydantic CoordinatesSelectorRequest or a plain {x,y} mapping."""
    if obj is None:
        raise ValueError("coordinates required")
    if hasattr(obj, "x") and hasattr(obj, "y"):
        return int(obj.x), int(obj.y)
    if isinstance(obj, dict):
        return int(obj["x"]), int(obj["y"])
    raise TypeError(f"unsupported coordinate type: {type(obj).__name__}")


class _BoundsShim:
    """Lightweight Bounds substitute used when upstream `mobile_use` is not installed.

    Matches the duck-typed surface upstream `UnifiedMobileController.tap_element()`
    needs: a `.get_center()` that returns something `tap()`'s `_coerce_xy` can read.
    """

    __slots__ = ("x1", "y1", "x2", "y2")

    def __init__(self, x1: int, y1: int, x2: int, y2: int) -> None:
        self.x1 = int(x1)
        self.y1 = int(y1)
        self.x2 = int(x2)
        self.y2 = int(y2)

    def get_center(self) -> dict[str, int]:
        return {"x": (self.x1 + self.x2) // 2, "y": (self.y1 + self.y2) // 2}

    def __eq__(self, other: object) -> bool:
        if isinstance(other, _BoundsShim):
            return (
                self.x1 == other.x1
                and self.y1 == other.y1
                and self.x2 == other.x2
                and self.y2 == other.y2
            )
        if isinstance(other, dict):
            return {"x1": self.x1, "y1": self.y1, "x2": self.x2, "y2": self.y2} == other
        return NotImplemented

    def __repr__(self) -> str:
        return f"_BoundsShim(x1={self.x1}, y1={self.y1}, x2={self.x2}, y2={self.y2})"


def _success(body: dict[str, Any]) -> bool:
    return bool(body.get("success", False))


class EclawController:
    """A `MobileDeviceController` driving an EClaw device over HTTPS.

    Construct with the same `(deviceId, botSecret, entityId)` triple the device's
    bot uses for other EClaw API calls. iOS targets are supported only via the
    portal WebView shim per spec §4.2 v1; native iOS apps will raise
    `NotImplementedError` on launch_app/terminate_app until M3.
    """

    # We're a structural subtype of MobileDeviceController; we don't inherit
    # the Protocol class directly to keep upstream a soft dep at test time.
    # `isinstance(c, MobileDeviceController)` still returns True because Protocol
    # uses structural typing.

    def __init__(
        self,
        device_id: str,
        bot_secret: str,
        entity_id: int = 2,
        base_url: str = "https://eclawbot.com",
        timeout_seconds: float = 8.0,
        prefer_image_screenshot: bool = True,
        transport: EclawTransport | None = None,
    ) -> None:
        if not device_id:
            raise ValueError("device_id required")
        if not bot_secret:
            raise ValueError("bot_secret required")
        if entity_id is None or int(entity_id) < 1:
            raise ValueError("entity_id must be >= 1")
        self.prefer_image_screenshot = prefer_image_screenshot
        self._transport = transport or EclawTransport(
            base_url=base_url,
            device_id=device_id,
            bot_secret=bot_secret,
            entity_id=int(entity_id),
            timeout_seconds=timeout_seconds,
        )

    # ---------------------------------------------------------------- pointer

    async def tap(
        self,
        coords: Any,
        long_press: bool = False,
        long_press_duration: int = 1000,
    ) -> "TapOutput":
        x, y = _coerce_xy(coords)
        if long_press:
            body = await self._transport.control(
                "long_press",
                {"x": x, "y": y, "durationMs": int(long_press_duration)},
            )
        else:
            body = await self._transport.control("tap", {"x": x, "y": y})
        return self._build_tap_output(body)

    async def swipe(
        self,
        start: Any,
        end: Any,
        duration: int = 400,
    ) -> str | None:
        sx, sy = _coerce_xy(start)
        ex, ey = _coerce_xy(end)
        body = await self._transport.control(
            "swipe",
            {
                "startX": sx,
                "startY": sy,
                "endX": ex,
                "endY": ey,
                "durationMs": int(duration),
            },
        )
        if _success(body):
            return None
        return str(body.get("error") or "swipe failed")

    # ---------------------------------------------------------------- text

    async def input_text(self, text: str) -> bool:
        body = await self._transport.control("type", {"text": text})
        return _success(body)

    async def erase_text(self, nb_chars: int | None = None) -> bool:
        # No native erase primitive on EClaw — synthesize via ime_action backspaces.
        # mobile-use callers that need a precise erase can pass nb_chars; we send
        # that many `back`-key presses (Android maps DEL via ime_action).
        count = 1 if nb_chars is None else max(0, int(nb_chars))
        all_ok = True
        for _ in range(count):
            body = await self._transport.control("ime_action", {"action": "delete"})
            all_ok = all_ok and _success(body)
        return all_ok

    # ---------------------------------------------------------------- nav keys

    async def press_back(self) -> bool:
        body = await self._transport.control("back")
        return _success(body)

    async def press_home(self) -> bool:
        body = await self._transport.control("home")
        return _success(body)

    async def press_enter(self) -> bool:
        body = await self._transport.control("ime_action", {"action": "done"})
        return _success(body)

    # ---------------------------------------------------------------- apps / urls

    async def launch_app(self, package_or_bundle_id: str) -> bool:
        if not package_or_bundle_id:
            raise ValueError("package_or_bundle_id required")
        # Heuristic: bundleId for iOS is reverse-dns with at least two dots
        # AND no underscore. EClaw's M1 backend accepts either packageName
        # (Android) or bundleId (iOS) and routes based on the connected
        # device's platform — we forward whichever the caller gave under
        # both keys so the backend can pick.
        body = await self._transport.control(
            "launch_app",
            {
                "packageName": package_or_bundle_id,
                "bundleId": package_or_bundle_id,
            },
        )
        return _success(body)

    async def terminate_app(self, package_or_bundle_id: str | None) -> bool:
        if not package_or_bundle_id:
            raise ValueError("package_or_bundle_id required")
        body = await self._transport.control(
            "stop_app",
            {
                "packageName": package_or_bundle_id,
                "bundleId": package_or_bundle_id,
            },
        )
        return _success(body)

    async def open_url(self, url: str) -> bool:
        if not url:
            raise ValueError("url required")
        # Android intent path per spec §5.2; iOS uses the WebView shim and the
        # backend rejects intentUrl for native iOS devices, surfaced as 4xx.
        body = await self._transport.control(
            "launch_app",
            {"intentUrl": url},
        )
        return _success(body)

    # ---------------------------------------------------------------- screen

    async def screenshot(self) -> str:
        if self.prefer_image_screenshot:
            body = await self._transport.screen_image()
            image = body.get("image")
            if not image:
                raise EclawControllerError(
                    "screen-image response missing 'image'",
                    body=body,
                )
            return str(image)
        # Fall back to UI-tree screen-capture; that endpoint also returns a
        # base64 PNG plus elements list. Newer routes call it `image`; keep
        # both keys for forward-compat.
        body = await self._transport.screen_capture()
        image = body.get("image") or body.get("base64") or body.get("screenshot")
        if not image:
            raise EclawControllerError(
                "screen-capture response missing image payload",
                body=body,
            )
        return str(image)

    async def get_screen_data(self) -> "ScreenDataResponse":
        # Use screen-capture to obtain elements+base64+width+height+platform.
        body = await self._transport.screen_capture()
        payload = {
            "base64": body.get("image") or body.get("base64") or "",
            "elements": list(body.get("elements") or []),
            "width": int(body.get("width") or 0),
            "height": int(body.get("height") or 0),
            "platform": str(body.get("platform") or "unknown"),
        }
        return self._build_screen_data(payload)

    async def get_ui_hierarchy(self) -> list[dict]:
        data = await self.get_screen_data()
        elements = getattr(data, "elements", None)
        if elements is None and isinstance(data, dict):
            elements = data.get("elements", [])
        return list(elements or [])

    def find_element(
        self,
        ui_hierarchy: list[dict],
        resource_id: str | None = None,
        text: str | None = None,
        index: int = 0,
    ):  # noqa: ANN201 — return type uses upstream-only types when present.
        # Upstream contract: (node, bounds, error_message). Upstream
        # `UnifiedMobileController.tap_element()` does `if error or not bounds:
        # return error`, then calls `bounds.get_center()`. So on success the
        # third slot MUST be None and `bounds` MUST expose `.get_center()`.
        if not resource_id and not text:
            return None, None, "no selector provided (resource_id or text required)"
        matches: list[dict] = []
        for node in ui_hierarchy or []:
            if resource_id and node.get("resource-id") != resource_id and node.get("resourceId") != resource_id:
                continue
            if text and (node.get("text") or "") != text:
                continue
            matches.append(node)
        if not matches:
            return None, None, "no element matches selector"
        if index < 0 or index >= len(matches):
            return None, None, f"index {index} out of range ({len(matches)} matches)"
        node = matches[index]
        bounds = self._extract_bounds(node)
        if bounds is None:
            return None, None, "matched node has no parseable bounds"
        return node, bounds, None

    # ---------------------------------------------------------------- video / misc

    async def start_video_recording(self, max_duration_seconds: int = 900):  # type: ignore[override]
        raise NotImplementedError(
            "EClaw does not support video_recording in M2 v1 — spec §5.2. "
            "The planner should pick a screenshot-loop fallback."
        )

    async def stop_video_recording(self):  # type: ignore[override]
        raise NotImplementedError(
            "EClaw does not support video_recording in M2 v1 — spec §5.2."
        )

    def get_compressed_b64_screenshot(self, image_base64: str, quality: int = 50) -> str:
        # Spec §3.2: app-side already downscales the PNG to fit maxBytes.
        # The planner only calls this to shrink an already-fetched image when
        # passing to a cheap vision model; we keep this client-side and avoid a
        # round-trip. PIL is an optional dep — degrade gracefully if absent.
        try:
            import io

            from PIL import Image  # type: ignore[import-not-found]
        except ImportError:
            return image_base64
        try:
            raw = base64.b64decode(image_base64)
            with Image.open(io.BytesIO(raw)) as img:
                buf = io.BytesIO()
                img.convert("RGB").save(buf, format="JPEG", quality=int(quality))
                return base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception:
            return image_base64

    async def cleanup(self) -> None:
        await self._transport.aclose()

    # ---------------------------------------------------------------- helpers

    def _build_tap_output(self, body: dict[str, Any]):
        try:
            from minitap.mobile_use.controllers.types import TapOutput  # type: ignore[import-not-found]
        except ImportError:
            return {"error": None if _success(body) else str(body.get("error") or "tap failed")}
        if _success(body):
            return TapOutput(error=None)
        return TapOutput(error=str(body.get("error") or "tap failed"))

    def _build_screen_data(self, payload: dict[str, Any]):
        try:
            from minitap.mobile_use.controllers.device_controller import (  # type: ignore[import-not-found]
                ScreenDataResponse,
            )
        except ImportError:
            return payload
        return ScreenDataResponse(**payload)

    @staticmethod
    def _extract_bounds(node: dict[str, Any]):
        # Return upstream `Bounds` when available (so isinstance checks pass);
        # otherwise return a small shim that exposes the same `.get_center()`
        # contract upstream `UnifiedMobileController.tap_element()` relies on.
        b = node.get("bounds")
        if b is None:
            return None
        coords: dict[str, int] | None = None
        if isinstance(b, dict) and all(k in b for k in ("x1", "y1", "x2", "y2")):
            try:
                coords = {
                    "x1": int(b["x1"]),
                    "y1": int(b["y1"]),
                    "x2": int(b["x2"]),
                    "y2": int(b["y2"]),
                }
            except (ValueError, TypeError):
                coords = None
        elif isinstance(b, str) and b.startswith("[") and "][" in b:
            try:
                left, right = b.replace("[", "").split("]")[:2]
                x1, y1 = (int(v) for v in left.split(","))
                x2, y2 = (int(v) for v in right.split(","))
                coords = {"x1": x1, "y1": y1, "x2": x2, "y2": y2}
            except (ValueError, TypeError):
                coords = None
        if coords is None:
            return None
        try:
            from minitap.mobile_use.controllers.types import Bounds  # type: ignore[import-not-found]
            return Bounds(**coords)
        except ImportError:
            return _BoundsShim(**coords)
        except Exception:
            return _BoundsShim(**coords)


__all__ = ["EclawController"]


# Compile-time sanity: ensure the public method set matches the upstream
# protocol when mobile-use is installed. Runs at import time only if the
# upstream package is on sys.path, so it's a no-op in lean test envs.
def _verify_protocol_shape() -> None:  # pragma: no cover - exercised at runtime only
    try:
        from minitap.mobile_use.controllers.device_controller import (  # type: ignore[import-not-found]
            MobileDeviceController,
        )
    except ImportError:
        return
    required = {
        name
        for name in dir(MobileDeviceController)
        if not name.startswith("_") and callable(getattr(MobileDeviceController, name))
    }
    have = {n for n in dir(EclawController) if not n.startswith("_")}
    missing = required - have
    if missing:
        raise RuntimeError(
            f"EclawController is missing MobileDeviceController methods: {sorted(missing)}"
        )


_verify_protocol_shape()
# `time` kept for future use (debug timing) — silence unused warning.
_ = time
