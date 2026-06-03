"""eclaw-mobile-use-driver — `EclawController(MobileDeviceController)` plugin
for `minitap-ai/mobile-use`.

Spec: docs/specs/mobile-use-integration.md §5 (EClaw repo).
"""

from .controller import EclawController
from .errors import (
    EclawAuthError,
    EclawControllerError,
    EclawDeviceOfflineError,
    EclawRateLimitError,
    EclawRemoteDisabledError,
    EclawServerError,
)
from .transport import EclawTransport

__all__ = [
    "EclawController",
    "EclawTransport",
    "EclawControllerError",
    "EclawAuthError",
    "EclawDeviceOfflineError",
    "EclawRateLimitError",
    "EclawServerError",
    "EclawRemoteDisabledError",
]

__version__ = "0.1.0"
