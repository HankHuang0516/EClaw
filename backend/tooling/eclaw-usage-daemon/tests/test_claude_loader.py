"""Unit tests for claude_loader.

Covers:
  * empty directory → empty list
  * happy-path single jsonl with two assistant messages → 1 session,
    summed tokens, dedup by messageId
  * corrupt lines mixed in → loader skips and keeps going
  * usage block missing → entry dropped
  * mtime cutoff → file outside hours_back is skipped without opening
"""

from __future__ import annotations

import json
from pathlib import Path

from claude_loader import ClaudeLoader


def _write(path: Path, *records: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


def test_empty_projects_dir(tmp_path: Path) -> None:
    loader = ClaudeLoader(projects_dir=tmp_path / "projects")
    # Dir doesn't even exist — should still return []
    assert loader.load_sessions(24) == []
    # Empty dir
    (tmp_path / "projects").mkdir()
    assert loader.load_sessions(24) == []


def test_aggregates_two_assistant_messages(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    loader = ClaudeLoader(projects_dir=projects)

    rec_a = {
        "type": "assistant",
        "sessionId": "sess-1",
        "requestId": "req-1",
        "cwd": "/Users/hank/Desktop/Project/EClaw",
        "timestamp": "2026-05-23T12:00:00Z",
        "message": {
            "id": "msg-a",
            "model": "claude-opus-4-7",
            "usage": {
                "input_tokens": 100,
                "output_tokens": 50,
                "cache_creation_input_tokens": 10,
                "cache_read_input_tokens": 5,
            },
        },
    }
    rec_b = dict(rec_a)
    rec_b["timestamp"] = "2026-05-23T12:05:00Z"
    rec_b["requestId"] = "req-2"
    rec_b["message"] = dict(rec_a["message"])
    rec_b["message"]["id"] = "msg-b"
    rec_b["message"]["usage"] = {
        "input_tokens": 200,
        "output_tokens": 80,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
    }
    # Same id+request as A → must dedup
    rec_dup = dict(rec_a)

    _write(projects / "p1" / "sess.jsonl", rec_a, rec_b, rec_dup)

    sessions = loader.load_sessions(hours_back=0)
    assert len(sessions) == 1
    s = sessions[0]
    assert s["session_id"] == "sess-1"
    assert s["project"] == "EClaw"
    assert s["model"] == "claude-opus-4-7"
    assert s["input_tokens"] == 300
    assert s["output_tokens"] == 130
    assert s["cache_creation_tokens"] == 10
    assert s["cache_read_tokens"] == 5
    assert s["messages"] == 2  # dup dropped
    assert s["first_seen"] < s["last_seen"]


def test_corrupt_lines_are_skipped(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    loader = ClaudeLoader(projects_dir=projects)

    good = {
        "type": "assistant",
        "sessionId": "sess-x",
        "requestId": "req-x",
        "timestamp": "2026-05-23T12:00:00Z",
        "message": {
            "id": "msg-x",
            "model": "claude-sonnet-4-6",
            "usage": {"input_tokens": 1, "output_tokens": 1},
        },
    }
    path = projects / "p" / "sess.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        f.write("not-json\n")
        f.write(json.dumps(good) + "\n")
        f.write('{"type": "assistant"}\n')  # no message/usage — drop
        f.write('{"type": "user", "message": {"content": "hi"}}\n')  # wrong type — drop

    sessions = loader.load_sessions(hours_back=0)
    assert len(sessions) == 1
    assert sessions[0]["session_id"] == "sess-x"


def test_zero_token_entries_are_dropped(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    loader = ClaudeLoader(projects_dir=projects)
    rec = {
        "type": "assistant",
        "sessionId": "sess-zero",
        "requestId": "req-0",
        "timestamp": "2026-05-23T12:00:00Z",
        "message": {
            "id": "msg-0",
            "model": "claude-sonnet-4-6",
            "usage": {
                "input_tokens": 0,
                "output_tokens": 0,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0,
            },
        },
    }
    _write(projects / "p" / "s.jsonl", rec)
    assert loader.load_sessions(0) == []


def test_mtime_cutoff_skips_old_files(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    loader = ClaudeLoader(projects_dir=projects)
    rec = {
        "type": "assistant",
        "sessionId": "sess-old",
        "requestId": "req-old",
        "timestamp": "2026-05-23T12:00:00Z",
        "message": {
            "id": "msg-old",
            "model": "claude-sonnet-4-6",
            "usage": {"input_tokens": 10, "output_tokens": 10},
        },
    }
    path = projects / "p" / "old.jsonl"
    _write(path, rec)
    # Force mtime far into the past (epoch 1000).
    import os
    os.utime(path, (1000, 1000))

    # hours_back=1 means we only look at files modified in the last hour.
    sessions = loader.load_sessions(hours_back=1)
    assert sessions == []
    # hours_back=0 disables cutoff
    sessions = loader.load_sessions(hours_back=0)
    assert len(sessions) == 1


def test_load_live_returns_dict_or_none(tmp_path: Path) -> None:
    status = tmp_path / "usage-status.json"
    loader = ClaudeLoader(projects_dir=tmp_path / "projects", status_file=status)
    assert loader.load_live() is None

    status.write_text(json.dumps({"five_hour_pct": 42}), encoding="utf-8")
    live = loader.load_live()
    assert live == {"five_hour_pct": 42}

    status.write_text("not-json", encoding="utf-8")
    assert loader.load_live() is None
