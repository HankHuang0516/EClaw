"""Codex CLI usage loader.

Reads `~/.codex/sessions/**/*.jsonl` and joins per-session token usage with
the `threads.model` column from `~/.codex/state_5.sqlite`. Also extracts the
most recent `rate_limits` block from any token_count event. Direct port of
the PoC at `claude-code-eclaw-channel/poc/usage_daemon_poc.py`.
"""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

UTC = timezone.utc

DEFAULT_SESSIONS_DIR = Path(os.path.expanduser("~/.codex/sessions"))
DEFAULT_STATE_DB = Path(os.path.expanduser("~/.codex/state_5.sqlite"))


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


def _as_float(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


def _is_valid_rate_limits(v: Any) -> bool:
    rl = _as_dict(v)
    if not rl:
        return False
    primary = _as_dict(rl.get("primary"))
    secondary = _as_dict(rl.get("secondary"))
    if not primary or not secondary:
        return False
    if _as_float(primary.get("window_minutes")) == 0:
        return False
    return (
        _as_float(primary.get("used_percent")) is not None
        and _as_float(secondary.get("used_percent")) is not None
    )


def _project_from_cwd(cwd: str) -> str:
    if not cwd:
        return "unknown"
    return Path(os.path.expanduser(cwd)).name or "unknown"


class CodexLoader:
    def __init__(
        self,
        sessions_dir: Path | str | None = None,
        state_db: Path | str | None = None,
    ) -> None:
        self.sessions_dir = Path(sessions_dir) if sessions_dir else DEFAULT_SESSIONS_DIR
        self.state_db = Path(state_db) if state_db else DEFAULT_STATE_DB

    def thread_models(self) -> dict[str, str]:
        if not self.state_db.exists():
            return {}
        try:
            with sqlite3.connect(f"file:{self.state_db}?mode=ro", uri=True) as conn:
                rows = conn.execute(
                    "SELECT id, model FROM threads WHERE model IS NOT NULL"
                ).fetchall()
        except (OSError, sqlite3.Error):
            return {}
        return {
            tid: m
            for tid, m in rows
            if isinstance(tid, str) and isinstance(m, str) and m
        }

    def load(
        self, hours_back: int = 24
    ) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
        if not self.sessions_dir.is_dir():
            return [], None

        cutoff = (
            datetime.now(UTC) - timedelta(hours=hours_back) if hours_back > 0 else None
        )
        cutoff_ts = cutoff.timestamp() if cutoff else None
        models = self.thread_models()

        paths_sorted: list[tuple[float, Path]] = []
        for path in self.sessions_dir.rglob("*.jsonl"):
            try:
                paths_sorted.append((path.stat().st_mtime, path))
            except OSError:
                continue
        paths_sorted.sort(key=lambda x: x[0], reverse=True)

        sessions: list[dict[str, Any]] = []
        seen: set[str] = set()
        latest_rate_limits: dict[str, Any] | None = None
        latest_rate_limits_ts = ""

        for mtime, path in paths_sorted:
            if cutoff_ts is not None and mtime < cutoff_ts:
                if latest_rate_limits is not None:
                    break

            parsed = self._scan_file(path)
            if parsed is None:
                continue

            session_id, session_ts, cwd, first_ts, last_usage_ts, last_usage, file_rate_limits, file_rate_limits_ts = parsed

            if latest_rate_limits is None and file_rate_limits is not None:
                latest_rate_limits = file_rate_limits
                latest_rate_limits_ts = file_rate_limits_ts

            if session_id in seen or not session_id or last_usage is None:
                continue
            ts = _parse_ts(last_usage_ts) or _parse_ts(session_ts)
            if ts is None:
                continue
            if cutoff is not None and ts < cutoff:
                continue

            cached = _as_int(last_usage.get("cached_input_tokens"))
            inp = max(0, _as_int(last_usage.get("input_tokens")) - cached)
            out = _as_int(last_usage.get("output_tokens")) + _as_int(
                last_usage.get("reasoning_output_tokens")
            )
            if inp == 0 and out == 0:
                continue

            seen.add(session_id)
            sessions.append({
                "session_id": session_id,
                "project": _project_from_cwd(cwd),
                "model": models.get(session_id, "unknown"),
                "first_seen": (_parse_ts(first_ts) or ts).isoformat(),
                "last_seen": ts.isoformat(),
                "input_tokens": inp,
                "output_tokens": out,
                "cached_tokens": cached,
                "cost_usd": 0.0,
            })

        sessions.sort(key=lambda s: s["last_seen"], reverse=True)

        rate_limits_out: dict[str, Any] | None = None
        if latest_rate_limits is not None:
            primary = _as_dict(latest_rate_limits.get("primary"))
            secondary = _as_dict(latest_rate_limits.get("secondary"))
            rate_limits_out = {
                "five_hour_pct": _as_float(primary.get("used_percent")),
                "five_hour_resets_at": _as_float(primary.get("resets_at")),
                "seven_day_pct": _as_float(secondary.get("used_percent")),
                "seven_day_resets_at": _as_float(secondary.get("resets_at")),
                "plan_type": _as_str(latest_rate_limits.get("plan_type")) or None,
                "updated_at": latest_rate_limits_ts,
            }

        return sessions, rate_limits_out

    def _scan_file(self, path: Path):
        session_id = ""
        session_ts = ""
        cwd = ""
        last_usage: dict[str, Any] | None = None
        last_usage_ts = ""
        first_ts = ""
        file_rate_limits: dict[str, Any] | None = None
        file_rate_limits_ts = ""

        try:
            with path.open(encoding="utf-8") as f:
                for line in f:
                    try:
                        d = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(d, dict):
                        continue
                    if d.get("type") == "session_meta":
                        p = _as_dict(d.get("payload"))
                        session_id = _as_str(p.get("id"))
                        session_ts = _as_str(p.get("timestamp"))
                        cwd = _as_str(p.get("cwd"))
                        continue
                    if d.get("type") != "event_msg":
                        continue
                    payload = _as_dict(d.get("payload"))
                    if payload.get("type") != "token_count":
                        continue

                    rl = _as_dict(payload.get("rate_limits"))
                    if _is_valid_rate_limits(rl):
                        file_rate_limits = rl
                        file_rate_limits_ts = _as_str(d.get("timestamp"))

                    info = _as_dict(payload.get("info"))
                    usage = _as_dict(info.get("total_token_usage"))
                    if usage:
                        last_usage = usage
                        last_usage_ts = _as_str(d.get("timestamp"))
                        if not first_ts:
                            first_ts = last_usage_ts
        except OSError:
            return None

        return (
            session_id,
            session_ts,
            cwd,
            first_ts,
            last_usage_ts,
            last_usage,
            file_rate_limits,
            file_rate_limits_ts,
        )
