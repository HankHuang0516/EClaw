"""Claude Code usage loader.

Reads `~/.claude/projects/**/*.jsonl` and aggregates assistant-message token
usage into per-session rows. Direct port of the PoC at
`claude-code-eclaw-channel/poc/usage_daemon_poc.py`, modularized so daemon.py
can swap in a fake projects_dir for tests.

Returned rows match the Phase 1 POST /api/usage/snapshot Claude schema (see
`backend/usage-api.js` sumEngineSessions): each row exposes input_tokens,
output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, etc.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

UTC = timezone.utc

DEFAULT_PROJECTS_DIR = Path(os.path.expanduser("~/.claude/projects"))
DEFAULT_STATUS_FILE = Path(os.path.expanduser("~/.claude/usage-status.json"))


def _parse_ts(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        ts = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return ts.replace(tzinfo=UTC) if ts.tzinfo is None else ts.astimezone(UTC)


def _as_int(v: Any) -> int:
    if isinstance(v, bool) or not isinstance(v, int):
        return 0
    return max(0, int(v))


def _as_str(v: Any) -> str:
    return v if isinstance(v, str) else ""


def _as_dict(v: Any) -> dict[str, Any]:
    return v if isinstance(v, dict) else {}


def _project_from_cwd(cwd: str) -> str:
    if not cwd:
        return "unknown"
    return Path(os.path.expanduser(cwd)).name or "unknown"


class ClaudeLoader:
    """Stateless loader; instances exist mainly so tests can inject paths."""

    def __init__(
        self,
        projects_dir: Path | str | None = None,
        status_file: Path | str | None = None,
    ) -> None:
        self.projects_dir = Path(projects_dir) if projects_dir else DEFAULT_PROJECTS_DIR
        self.status_file = Path(status_file) if status_file else DEFAULT_STATUS_FILE

    def load_live(self) -> dict[str, Any] | None:
        if not self.status_file.exists():
            return None
        try:
            with self.status_file.open(encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            return None
        return data if isinstance(data, dict) else None

    def load_sessions(self, hours_back: int = 24) -> list[dict[str, Any]]:
        if not self.projects_dir.is_dir():
            return []
        cutoff = datetime.now(UTC) - timedelta(hours=hours_back) if hours_back > 0 else None
        cutoff_ts = cutoff.timestamp() if cutoff else None

        sessions: dict[str, dict[str, Any]] = {}
        seen_dedup: set[str] = set()

        for jsonl in self.projects_dir.rglob("*.jsonl"):
            try:
                if cutoff_ts is not None and jsonl.stat().st_mtime < cutoff_ts:
                    continue
            except OSError:
                continue
            self._scan_file(jsonl, cutoff, sessions, seen_dedup)

        return sorted(sessions.values(), key=lambda s: s["last_seen"], reverse=True)

    def _scan_file(
        self,
        path: Path,
        cutoff: datetime | None,
        sessions: dict[str, dict[str, Any]],
        seen_dedup: set[str],
    ) -> None:
        try:
            with path.open(encoding="utf-8") as f:
                for line in f:
                    try:
                        d = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(d, dict) or d.get("type") != "assistant":
                        continue
                    msg = _as_dict(d.get("message"))
                    usage = _as_dict(msg.get("usage"))
                    if not usage:
                        continue
                    ts = _parse_ts(d.get("timestamp"))
                    if ts is None:
                        continue
                    if cutoff is not None and ts < cutoff:
                        continue

                    session_id = _as_str(d.get("sessionId"))
                    message_id = _as_str(msg.get("id"))
                    request_id = _as_str(d.get("requestId"))
                    dedup = (
                        f"m:{message_id}:{request_id}"
                        if (message_id or request_id)
                        else f"e:{session_id}:{ts.isoformat()}"
                    )
                    if dedup in seen_dedup:
                        continue
                    seen_dedup.add(dedup)

                    inp = _as_int(usage.get("input_tokens"))
                    out = _as_int(usage.get("output_tokens"))
                    cc = _as_int(usage.get("cache_creation_input_tokens"))
                    cr = _as_int(usage.get("cache_read_input_tokens"))
                    if inp + out + cc + cr == 0:
                        continue

                    cwd = _as_str(d.get("cwd"))
                    project = _project_from_cwd(cwd) if cwd else "unknown"
                    model = _as_str(msg.get("model")) or "unknown"

                    s = sessions.setdefault(session_id, {
                        "session_id": session_id,
                        "project": project,
                        "model": model,
                        "first_seen": ts.isoformat(),
                        "last_seen": ts.isoformat(),
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "cache_creation_tokens": 0,
                        "cache_read_tokens": 0,
                        "messages": 0,
                        "cost_usd": 0.0,
                    })
                    if ts.isoformat() < s["first_seen"]:
                        s["first_seen"] = ts.isoformat()
                    if ts.isoformat() > s["last_seen"]:
                        s["last_seen"] = ts.isoformat()
                    s["input_tokens"] += inp
                    s["output_tokens"] += out
                    s["cache_creation_tokens"] += cc
                    s["cache_read_tokens"] += cr
                    s["messages"] += 1
                    if project != "unknown":
                        s["project"] = project
                    if model != "unknown":
                        s["model"] = model
        except OSError:
            return
