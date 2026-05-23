"""Unit tests for codex_loader."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from codex_loader import CodexLoader


def _write(path: Path, *records: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


def _make_state_db(path: Path, threads: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, model TEXT)")
        conn.executemany(
            "INSERT INTO threads (id, model) VALUES (?, ?)",
            list(threads.items()),
        )


def test_empty_sessions_dir(tmp_path: Path) -> None:
    loader = CodexLoader(
        sessions_dir=tmp_path / "sessions",
        state_db=tmp_path / "missing.sqlite",
    )
    sessions, rate_limits = loader.load(24)
    assert sessions == []
    assert rate_limits is None


def test_token_count_event_aggregates(tmp_path: Path) -> None:
    sessions_dir = tmp_path / "sessions"
    state_db = tmp_path / "state.sqlite"
    _make_state_db(state_db, {"thread-a": "gpt-5-codex"})

    loader = CodexLoader(sessions_dir=sessions_dir, state_db=state_db)

    _write(
        sessions_dir / "2026" / "rollout.jsonl",
        {"type": "session_meta", "payload": {"id": "thread-a", "timestamp": "2026-05-23T12:00:00Z", "cwd": "/Users/hank/Desktop/Project/EClaw"}},
        {
            "type": "event_msg",
            "timestamp": "2026-05-23T12:05:00Z",
            "payload": {
                "type": "token_count",
                "rate_limits": {
                    "primary": {"used_percent": 12.5, "resets_at": 1700000000},
                    "secondary": {"used_percent": 7.0, "resets_at": 1700001000},
                    "plan_type": "pro",
                },
                "info": {
                    "total_token_usage": {
                        "input_tokens": 1000,
                        "output_tokens": 200,
                        "cached_input_tokens": 300,
                        "reasoning_output_tokens": 50,
                    }
                },
            },
        },
    )

    sessions, rl = loader.load(hours_back=0)
    assert len(sessions) == 1
    s = sessions[0]
    assert s["session_id"] == "thread-a"
    assert s["model"] == "gpt-5-codex"
    assert s["project"] == "EClaw"
    # input is total - cached
    assert s["input_tokens"] == 700
    # output is output + reasoning
    assert s["output_tokens"] == 250
    assert s["cached_tokens"] == 300

    assert rl is not None
    assert rl["five_hour_pct"] == 12.5
    assert rl["seven_day_pct"] == 7.0
    assert rl["plan_type"] == "pro"


def test_corrupt_lines_skipped(tmp_path: Path) -> None:
    sessions_dir = tmp_path / "sessions"
    state_db = tmp_path / "state.sqlite"
    _make_state_db(state_db, {})

    loader = CodexLoader(sessions_dir=sessions_dir, state_db=state_db)

    path = sessions_dir / "rollout.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        f.write("not-json\n")
        f.write(json.dumps({"type": "session_meta", "payload": {"id": "t1", "timestamp": "2026-05-23T12:00:00Z", "cwd": "/tmp"}}) + "\n")
        f.write('{"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": 5, "output_tokens": 3}}}, "timestamp": "2026-05-23T12:01:00Z"}\n')
        f.write("\xff invalid utf8?\n")  # OK because we wrote with utf-8; just garbage text

    sessions, _ = loader.load(0)
    assert len(sessions) == 1
    assert sessions[0]["session_id"] == "t1"


def test_zero_token_session_dropped(tmp_path: Path) -> None:
    sessions_dir = tmp_path / "sessions"
    state_db = tmp_path / "state.sqlite"
    _make_state_db(state_db, {})
    loader = CodexLoader(sessions_dir=sessions_dir, state_db=state_db)

    _write(
        sessions_dir / "r.jsonl",
        {"type": "session_meta", "payload": {"id": "tz", "timestamp": "2026-05-23T12:00:00Z", "cwd": "/x"}},
        {
            "type": "event_msg",
            "timestamp": "2026-05-23T12:00:01Z",
            "payload": {
                "type": "token_count",
                "info": {"total_token_usage": {"input_tokens": 0, "output_tokens": 0, "cached_input_tokens": 0}},
            },
        },
    )
    sessions, _ = loader.load(0)
    assert sessions == []


def test_state_db_missing_uses_unknown_model(tmp_path: Path) -> None:
    """Loader must not crash when state_5.sqlite is absent."""
    sessions_dir = tmp_path / "sessions"
    loader = CodexLoader(sessions_dir=sessions_dir, state_db=tmp_path / "absent.sqlite")
    _write(
        sessions_dir / "r.jsonl",
        {"type": "session_meta", "payload": {"id": "no-model", "timestamp": "2026-05-23T12:00:00Z", "cwd": "/y"}},
        {"type": "event_msg", "timestamp": "2026-05-23T12:01:00Z", "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": 5, "output_tokens": 1}}}},
    )
    sessions, _ = loader.load(0)
    assert len(sessions) == 1
    assert sessions[0]["model"] == "unknown"
