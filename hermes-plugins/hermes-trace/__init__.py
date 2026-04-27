"""hermes-trace — JSONL trace of all 7 Hermes lifecycle hooks.

Diagnostic plugin to localise the brain-silence problem (Hermes goes
unresponsive). Writes one JSON line per hook fire to:

    $HERMES_HOME/plugin-data/hermes-trace/trace.jsonl

After 24h of normal operation, replay the trace to determine which layer
silences:

  * `pre_llm_call` without matching `post_llm_call`  -> brain (LLM) hung
  * `pre_gateway_dispatch` without `pre_llm_call`    -> engine queue stalled
  * no `pre_gateway_dispatch` at all                  -> Docker bridge dead

All hooks tolerate missing kwargs (defensive — Hermes adds fields
without notice). Failures inside the plugin must NEVER raise; the
agent's tracebacks are caught upstream but we still skip cleanly.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_HERMES_HOME = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
_LOG_DIR = _HERMES_HOME / "plugin-data" / "hermes-trace"
_LOG_DIR.mkdir(parents=True, exist_ok=True)
_LOG_FILE = _LOG_DIR / "trace.jsonl"
_lock = threading.Lock()


def _emit(event: str, payload: dict) -> None:
    rec = {"ts": time.time(), "event": event, **payload}
    try:
        line = json.dumps(rec, default=str, ensure_ascii=False)
    except Exception as exc:
        line = json.dumps(
            {"ts": time.time(), "event": event, "_serialize_error": str(exc)}
        )
    try:
        with _lock, open(_LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception as exc:
        logger.debug("hermes-trace write failed: %s", exc)


def _safe_len(x: Any) -> int:
    try:
        return len(x) if x is not None else 0
    except Exception:
        return -1


def _on_pre_tool_call(tool_name: str = "", args: Any = None, task_id: str = "",
                      session_id: str = "", **_: Any) -> None:
    _emit("pre_tool_call", {
        "tool": tool_name,
        "task_id": task_id,
        "session_id": session_id,
        "args_keys": list(args.keys()) if isinstance(args, dict) else None,
    })


def _on_post_tool_call(tool_name: str = "", args: Any = None, result: Any = None,
                       task_id: str = "", session_id: str = "",
                       duration_ms: int = -1, **_: Any) -> None:
    _emit("post_tool_call", {
        "tool": tool_name,
        "task_id": task_id,
        "session_id": session_id,
        "duration_ms": duration_ms,
        "result_len": _safe_len(result),
    })


def _on_pre_llm_call(session_id: str = "", user_message: str = "",
                     conversation_history: Any = None, is_first_turn: bool = False,
                     model: str = "", platform: str = "", **_: Any) -> None:
    _emit("pre_llm_call", {
        "session_id": session_id,
        "model": model,
        "platform": platform,
        "is_first_turn": is_first_turn,
        "history_len": _safe_len(conversation_history),
        "user_message_len": _safe_len(user_message),
    })


def _on_post_llm_call(session_id: str = "", user_message: str = "",
                      assistant_response: str = "",
                      conversation_history: Any = None,
                      model: str = "", platform: str = "", **_: Any) -> None:
    _emit("post_llm_call", {
        "session_id": session_id,
        "model": model,
        "platform": platform,
        "response_len": _safe_len(assistant_response),
        "history_len": _safe_len(conversation_history),
    })


def _on_session_start(session_id: str = "", model: str = "",
                      platform: str = "", **_: Any) -> None:
    _emit("on_session_start", {
        "session_id": session_id,
        "model": model,
        "platform": platform,
    })


def _on_session_end(session_id: str = "", completed: bool = True,
                    interrupted: bool = False, model: str = "",
                    platform: str = "", **_: Any) -> None:
    _emit("on_session_end", {
        "session_id": session_id,
        "completed": completed,
        "interrupted": interrupted,
        "model": model,
        "platform": platform,
    })


def _on_pre_gateway_dispatch(event: Any = None, gateway: Any = None,
                             session_store: Any = None, **_: Any) -> None:
    src = getattr(event, "source", None)
    _emit("pre_gateway_dispatch", {
        "text_len": _safe_len(getattr(event, "text", None)),
        "platform": getattr(src, "platform", None),
        "chat_id": getattr(src, "chat_id", None),
        "internal": getattr(event, "internal", None),
    })


def _handle_slash(raw_args: str) -> str:
    argv = raw_args.strip().split()
    sub = argv[0] if argv else "status"

    if sub in ("help", "-h", "--help"):
        return (
            "/hermes-trace — JSONL trace of all 7 lifecycle hooks\n\n"
            "Subcommands:\n"
            "  status    Show trace path, line count, last 3 events\n"
            "  path      Print the trace.jsonl absolute path\n"
            "  rotate    Move current trace to trace-<ts>.jsonl and start fresh\n"
            "  tail [N]  Print last N events (default 10)\n"
        )

    if sub in ("status", ""):
        if not _LOG_FILE.exists():
            return f"[hermes-trace] No trace yet at {_LOG_FILE}"
        try:
            with open(_LOG_FILE, "r", encoding="utf-8") as f:
                lines = f.readlines()
            tail = "".join(lines[-3:]) if lines else "(empty)"
            return (
                f"[hermes-trace] file={_LOG_FILE}\n"
                f"  lines={len(lines)} size={_LOG_FILE.stat().st_size}B\n"
                f"  last 3:\n{tail}"
            )
        except Exception as exc:
            return f"[hermes-trace] read failed: {exc}"

    if sub == "path":
        return str(_LOG_FILE)

    if sub == "rotate":
        if not _LOG_FILE.exists():
            return "[hermes-trace] nothing to rotate"
        archive = _LOG_DIR / f"trace-{int(time.time())}.jsonl"
        try:
            _LOG_FILE.rename(archive)
            return f"[hermes-trace] rotated to {archive}"
        except Exception as exc:
            return f"[hermes-trace] rotate failed: {exc}"

    if sub == "tail":
        n = int(argv[1]) if len(argv) > 1 and argv[1].isdigit() else 10
        if not _LOG_FILE.exists():
            return "[hermes-trace] no trace yet"
        try:
            with open(_LOG_FILE, "r", encoding="utf-8") as f:
                lines = f.readlines()
            return "".join(lines[-n:]) or "(empty)"
        except Exception as exc:
            return f"[hermes-trace] tail failed: {exc}"

    return f"Unknown subcommand: {sub}\nTry /hermes-trace help"


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("post_llm_call", _on_post_llm_call)
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("on_session_end", _on_session_end)
    ctx.register_hook("pre_gateway_dispatch", _on_pre_gateway_dispatch)
    ctx.register_command(
        "hermes-trace",
        handler=_handle_slash,
        description="Inspect the JSONL hook trace for brain-silence diagnosis.",
    )
    _emit("plugin_register", {"version": "1.0.0", "log_file": str(_LOG_FILE)})
