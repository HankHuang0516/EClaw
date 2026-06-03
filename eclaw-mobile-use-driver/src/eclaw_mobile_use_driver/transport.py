"""HTTP transport for the EClaw mobile-use driver.

A thin httpx wrapper that:
- Posts JSON to `/api/device/control` and similar.
- Translates HTTP status codes into the typed exceptions defined in `errors`.
- Applies retry-with-backoff on `EclawRateLimitError` per spec §5.3
  (3 attempts, 200 ms → 600 ms → 1500 ms, jittered).
"""

from __future__ import annotations

import asyncio
import random
from typing import Any

import httpx

from .errors import (
    EclawAuthError,
    EclawControllerError,
    EclawDeviceOfflineError,
    EclawRateLimitError,
    EclawRemoteDisabledError,
    EclawServerError,
)

# Spec §5.3 — retry schedule for 429s.
_RATE_LIMIT_BACKOFFS_MS = (200, 600, 1500)


def _classify(status: int, body: Any) -> type[EclawControllerError] | None:
    if 200 <= status < 300:
        return None
    if status == 401:
        return EclawAuthError
    if status == 403:
        if isinstance(body, dict) and body.get("error") == "remote_control_disabled":
            return EclawRemoteDisabledError
        return EclawControllerError
    if status == 404:
        return EclawDeviceOfflineError
    if status == 429:
        return EclawRateLimitError
    if status in (502, 503, 504) and isinstance(body, dict) and body.get("error") == "device_offline":
        return EclawDeviceOfflineError
    if 500 <= status < 600:
        return EclawServerError
    return EclawControllerError


def _raise_for(status: int, body: Any) -> None:
    cls = _classify(status, body)
    if cls is None:
        return
    msg = body.get("error") if isinstance(body, dict) and body.get("error") else f"HTTP {status}"
    raise cls(str(msg), status_code=status, body=body)


class EclawTransport:
    """Async HTTP transport for the EClaw control + screen-image API."""

    def __init__(
        self,
        base_url: str,
        device_id: str,
        bot_secret: str,
        entity_id: int,
        timeout_seconds: float,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.device_id = device_id
        self.bot_secret = bot_secret
        self.entity_id = entity_id
        self.timeout_seconds = timeout_seconds
        self._client = client
        self._owns_client = client is None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout_seconds)
        return self._client

    @property
    def _auth_payload(self) -> dict[str, Any]:
        return {
            "deviceId": self.device_id,
            "botSecret": self.bot_secret,
            "entityId": self.entity_id,
        }

    async def _parse_body(self, resp: httpx.Response) -> Any:
        if not resp.content:
            return None
        try:
            return resp.json()
        except ValueError:
            return resp.text

    async def control(self, command: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/device/control with retry-on-429 per spec §5.3."""
        body = {**self._auth_payload, "command": command}
        if params is not None:
            body["params"] = params

        last_exc: EclawRateLimitError | None = None
        for attempt_index in range(len(_RATE_LIMIT_BACKOFFS_MS) + 1):
            client = await self._get_client()
            resp = await client.post(f"{self.base_url}/api/device/control", json=body)
            parsed = await self._parse_body(resp)
            try:
                _raise_for(resp.status_code, parsed)
            except EclawRateLimitError as exc:
                last_exc = exc
                if attempt_index >= len(_RATE_LIMIT_BACKOFFS_MS):
                    raise
                base_ms = _RATE_LIMIT_BACKOFFS_MS[attempt_index]
                jitter = random.uniform(0.85, 1.15)
                await asyncio.sleep(base_ms * jitter / 1000.0)
                continue
            assert isinstance(parsed, dict), f"expected JSON object from /api/device/control, got {type(parsed).__name__}"
            return parsed
        # Unreachable — the loop either returns or raises.
        assert last_exc is not None
        raise last_exc

    async def screen_image(self, max_bytes: int = 500_000) -> dict[str, Any]:
        """GET /api/device/screen-image — base64 PNG long-poll."""
        params = {
            **self._auth_payload,
            "maxBytes": max_bytes,
        }
        client = await self._get_client()
        resp = await client.get(f"{self.base_url}/api/device/screen-image", params=params)
        parsed = await self._parse_body(resp)
        _raise_for(resp.status_code, parsed)
        assert isinstance(parsed, dict)
        return parsed

    async def screen_capture(self) -> dict[str, Any]:
        """GET /api/device/screen-capture — UI tree + element list (cheaper than screen-image)."""
        params = self._auth_payload
        client = await self._get_client()
        resp = await client.get(f"{self.base_url}/api/device/screen-capture", params=params)
        parsed = await self._parse_body(resp)
        _raise_for(resp.status_code, parsed)
        assert isinstance(parsed, dict)
        return parsed

    async def aclose(self) -> None:
        if self._client is not None and self._owns_client:
            await self._client.aclose()
            self._client = None


__all__ = ["EclawTransport"]
