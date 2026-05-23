"""Credential loader for the usage daemon.

Resolution order — first source that yields a complete credential set wins:
  1. Environment variables (ECLAW_DEVICE_ID, ECLAW_ENTITY_ID, ECLAW_BOT_SECRET
     or ECLAW_DEVICE_ID + ECLAW_DEVICE_SECRET).
  2. ~/.eclaw/credentials.json (chmod 600). Same field names without prefix.
  3. EClaw repo backend/.env (DEVICE_ID + DEVICE_SECRET only — kept for
     manual ops; not the recommended path for the daemon).

`load_credentials()` fatal-exits with an actionable message if no complete
set is found. Secrets are NEVER printed to stdout/stderr — only field names.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

DEFAULT_API_URL = "https://eclawbot.com"
CREDENTIALS_PATH = Path(os.path.expanduser("~/.eclaw/credentials.json"))
ECLAW_ENV_PATH = Path("/Users/hank/Desktop/Project/EClaw/backend/.env")


@dataclass
class Credentials:
    api_url: str
    device_id: str
    device_secret: str | None = None
    entity_id: int | None = None
    bot_secret: str | None = None

    def auth_params(self) -> dict:
        """Return body fields for POST /api/usage/snapshot."""
        out: dict = {"deviceId": self.device_id}
        if self.device_secret:
            out["deviceSecret"] = self.device_secret
        if self.entity_id is not None and self.bot_secret:
            out["entityId"] = self.entity_id
            out["botSecret"] = self.bot_secret
        return out

    def auth_query(self) -> str:
        """Return ?... query string for GET endpoints — used by README curls only."""
        parts = [f"deviceId={self.device_id}"]
        if self.device_secret:
            parts.append(f"deviceSecret={self.device_secret}")
        if self.entity_id is not None and self.bot_secret:
            parts.append(f"entityId={self.entity_id}")
            parts.append(f"botSecret={self.bot_secret}")
        return "&".join(parts)


def _from_env() -> Credentials | None:
    api_url = os.environ.get("ECLAW_API_URL", DEFAULT_API_URL).rstrip("/")
    device_id = os.environ.get("ECLAW_DEVICE_ID", "").strip()
    if not device_id:
        return None
    device_secret = os.environ.get("ECLAW_DEVICE_SECRET", "").strip() or None
    bot_secret = os.environ.get("ECLAW_BOT_SECRET", "").strip() or None
    entity_id_raw = os.environ.get("ECLAW_ENTITY_ID", "").strip()
    entity_id: int | None = None
    if entity_id_raw:
        try:
            entity_id = int(entity_id_raw)
        except ValueError:
            entity_id = None
    if not (device_secret or (entity_id is not None and bot_secret)):
        return None
    return Credentials(api_url, device_id, device_secret, entity_id, bot_secret)


def _from_credentials_file(path: Path = CREDENTIALS_PATH) -> Credentials | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        sys.stderr.write(f"[auth] {path} unreadable: {type(exc).__name__}\n")
        return None
    if not isinstance(data, dict):
        return None
    api_url = str(data.get("apiUrl") or DEFAULT_API_URL).rstrip("/")
    device_id = str(data.get("deviceId") or "").strip()
    if not device_id:
        return None
    device_secret = data.get("deviceSecret") or None
    bot_secret = data.get("botSecret") or None
    entity_id_raw = data.get("entityId")
    entity_id: int | None = None
    if isinstance(entity_id_raw, int):
        entity_id = entity_id_raw
    elif isinstance(entity_id_raw, str) and entity_id_raw.strip():
        try:
            entity_id = int(entity_id_raw)
        except ValueError:
            entity_id = None
    if not (device_secret or (entity_id is not None and bot_secret)):
        return None
    return Credentials(api_url, device_id, device_secret, entity_id, bot_secret)


def _from_eclaw_env(path: Path = ECLAW_ENV_PATH) -> Credentials | None:
    if not path.exists():
        return None
    device_id = ""
    device_secret = ""
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            v = v.strip().strip('"').strip("'")
            if k.strip() == "DEVICE_ID":
                device_id = v
            elif k.strip() == "DEVICE_SECRET":
                device_secret = v
    except OSError:
        return None
    if not device_id or not device_secret:
        return None
    return Credentials(DEFAULT_API_URL, device_id, device_secret, None, None)


def load_credentials() -> Credentials:
    for loader in (_from_env, _from_credentials_file, _from_eclaw_env):
        creds = loader()
        if creds is not None:
            return creds
    sys.stderr.write(
        "[auth] FATAL: no usable credentials.\n"
        "  Tried:\n"
        "    1) env vars (ECLAW_DEVICE_ID + ECLAW_DEVICE_SECRET, or ECLAW_DEVICE_ID + "
        "ECLAW_ENTITY_ID + ECLAW_BOT_SECRET)\n"
        f"    2) {CREDENTIALS_PATH}\n"
        f"    3) {ECLAW_ENV_PATH} (DEVICE_ID + DEVICE_SECRET keys)\n"
        "  Run ./install.sh — it provisions ~/.eclaw/credentials.json from your keychain.\n"
    )
    sys.exit(2)
