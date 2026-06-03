"""Exception hierarchy for the EClaw mobile-use driver.

Spec: docs/specs/mobile-use-integration.md §5.3
"""

from __future__ import annotations


class EclawControllerError(Exception):
    """Base error for all EclawController failures."""

    def __init__(self, message: str, *, status_code: int | None = None, body: object = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class EclawAuthError(EclawControllerError):
    """401 — bad deviceId/botSecret/entityId triple."""


class EclawDeviceOfflineError(EclawControllerError):
    """404 + 'device not connected', or 503 from /screen-image when no socket."""


class EclawRateLimitError(EclawControllerError):
    """429 — rate-limited by the per-device cool-down."""


class EclawServerError(EclawControllerError):
    """5xx from eclawbot.com."""


class EclawRemoteDisabledError(EclawControllerError):
    """403 with `remote_control_disabled` — owner has not enabled remote control in app Settings."""


__all__ = [
    "EclawControllerError",
    "EclawAuthError",
    "EclawDeviceOfflineError",
    "EclawRateLimitError",
    "EclawServerError",
    "EclawRemoteDisabledError",
]
