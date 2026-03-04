#!/usr/bin/env python3
"""
Claude CLI Proxy — E-Claw AI Support (Python/FastAPI)
Based on openclaw-claude-proxy by timothy-node, extended for Railway deployment.

Receives binding issue data or chat messages, calls Claude CLI for analysis.
Uses stream-json for full visibility into tool calls & thinking.

HTTP API:
  GET  /health         Health check + Claude CLI version
  POST /analyze        Binding diagnosis (haiku, 55s)
  POST /chat           General AI chat (sonnet, 180s, tools)
  POST /chat?stream=1  NDJSON streaming variant
  GET  /sessions       Session list
  GET  /sessions/{id}  Session detail
  POST /warmup         Pre-warm Claude CLI
  GET  /queue-status   Concurrency info
"""

import asyncio
import base64
import json
import logging
import os
import re
import shutil
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

load_dotenv(Path(__file__).parent / ".env")

# ── Configuration ────────────────────────────
SUPPORT_API_KEY = os.getenv("SUPPORT_API_KEY", "")
PORT = int(os.getenv("PORT", "4000"))
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
DATABASE_URL = os.getenv("DATABASE_URL", "")

CLAUDE_TIMEOUT_MS = 55  # seconds (Haiku binding analysis)
CHAT_TIMEOUT_MS = 180  # seconds (Sonnet general chat with tool access)

MAX_CONCURRENT = 2
MAX_QUEUE = 8

REPO_DIR = Path(os.getenv("HOME", "/root")) / ".claude" / "repo"
REPO_URL = (
    f"https://{GITHUB_TOKEN}@github.com/HankHuang0516/realbot.git"
    if GITHUB_TOKEN
    else "https://github.com/HankHuang0516/realbot.git"
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("claude-proxy")

# Resolve claude binary
CLAUDE_BIN = shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")

# ── Concurrency Queue ────────────────────────
_semaphore = asyncio.Semaphore(MAX_CONCURRENT)
_queue_count = 0
_active_count = 0


class QueueBusyError(Exception):
    """Raised when the concurrency queue is full or timed out."""
    def __init__(self, error: str, message: str, retry_after: int):
        self.error = error
        self.message = message
        self.retry_after = retry_after


async def acquire_slot(timeout: float = 120.0):
    global _queue_count, _active_count
    if _queue_count >= MAX_QUEUE:
        raise QueueBusyError("busy", "AI is busy. Please try again shortly.", 15)
    _queue_count += 1
    try:
        acquired = await asyncio.wait_for(_semaphore.acquire(), timeout=timeout)
        if not acquired:
            raise QueueBusyError("queue_timeout", "AI queue timeout. Please try again.", 10)
    except asyncio.TimeoutError:
        raise QueueBusyError("queue_timeout", "AI queue timeout. Please try again.", 10)
    finally:
        _queue_count -= 1
    _active_count += 1
    log.info(f"[Queue] Slot acquired (active: {_active_count}/{MAX_CONCURRENT}, queued: {_queue_count})")


def release_slot():
    global _active_count
    _semaphore.release()
    _active_count -= 1
    log.info(f"[Queue] Slot released (active: {_active_count}/{MAX_CONCURRENT}, queued: {_queue_count})")


# ── Session Store (in-memory ring buffer) ────
MAX_SESSIONS = 50
SESSION_TTL_MS = 3_600_000  # 1 hour
session_store: deque = deque(maxlen=MAX_SESSIONS)


def create_session(session_type: str, prompt_preview: str) -> dict:
    session = {
        "id": str(uuid.uuid4()),
        "startedAt": int(time.time() * 1000),
        "completedAt": None,
        "type": session_type,
        "status": "running",
        "prompt": (prompt_preview or "")[:200],
        "response": None,
        "events": [],
        "turns": 0,
        "cost_usd": 0,
        "model": None,
        "error": None,
    }
    session_store.appendleft(session)
    return session


def finalize_session(session: dict):
    session["completedAt"] = int(time.time() * 1000)
    # Clean up expired sessions
    cutoff = int(time.time() * 1000) - SESSION_TTL_MS
    while session_store and session_store[-1]["startedAt"] < cutoff:
        session_store.pop()


# ── Claude CLI Stream Runner ─────────────────
async def run_claude_stream(
    prompt: str,
    extra_args: list,
    timeout_s: float,
    cwd: str = None,
    env: dict = None,
    on_event=None,
) -> dict:
    """
    Spawn Claude CLI with stream-json output.
    Parse NDJSON events from stdout.
    Falls back to single-JSON or plain text if no NDJSON lines parsed.
    """
    args = [CLAUDE_BIN, "--verbose", "--print", "--output-format", "stream-json"] + extra_args
    child_env = env or {**os.environ, "HOME": os.environ.get("HOME", "/root")}
    # Ensure IS_SANDBOX is set to bypass root restriction
    child_env["IS_SANDBOX"] = "1"

    events = []
    raw_stdout = ""
    stderr_text = ""
    timed_out = False

    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd or str(Path(__file__).parent),
            env=child_env,
        )

        # Write prompt to stdin and close
        proc.stdin.write(prompt.encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()

        # Read stdout line by line (NDJSON)
        async def read_stdout():
            nonlocal raw_stdout
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace")
                raw_stdout += text
                text = text.strip()
                if not text:
                    continue
                try:
                    event = json.loads(text)
                    event["_ts"] = int(time.time() * 1000)
                    events.append(event)
                    log_stream_event(event)
                    if on_event:
                        await on_event(event) if asyncio.iscoroutinefunction(on_event) else on_event(event)
                except json.JSONDecodeError:
                    pass

        async def read_stderr():
            nonlocal stderr_text
            data = await proc.stderr.read()
            stderr_text = data.decode("utf-8", errors="replace")

        try:
            await asyncio.wait_for(
                asyncio.gather(read_stdout(), read_stderr(), proc.wait()),
                timeout=timeout_s,
            )
        except asyncio.TimeoutError:
            timed_out = True
            try:
                proc.terminate()
            except Exception:
                pass

        return_code = proc.returncode or 0
        log.info(
            f"[Stream] close — code: {return_code}, events: {len(events)}, "
            f"stdout: {len(raw_stdout)} chars, stderr: {len(stderr_text)} chars"
        )

        # Fallback: if no events parsed but stdout has content
        if not events and raw_stdout.strip():
            log.warning("[Stream] No NDJSON events parsed, attempting single-JSON fallback...")
            try:
                parsed = json.loads(raw_stdout.strip())
                fallback_event = {
                    "_ts": int(time.time() * 1000),
                    "_fallback": True,
                    "type": parsed.get("type", "result"),
                    "subtype": parsed.get("subtype", "success" if parsed.get("result") else "unknown"),
                    "result": parsed.get("result", parsed.get("content", "")),
                    "session_id": parsed.get("session_id"),
                    "num_turns": parsed.get("num_turns"),
                    "total_cost_usd": parsed.get("total_cost_usd"),
                    "duration_ms": parsed.get("duration_ms"),
                    "modelUsage": parsed.get("modelUsage"),
                    "is_error": parsed.get("is_error"),
                }
                events.append(fallback_event)
                log.info(f"[Stream] Fallback parsed — type: {fallback_event['type']}, result: {len(str(fallback_event.get('result', '')))} chars")
            except json.JSONDecodeError:
                log.warning(f"[Stream] Fallback JSON parse failed, treating stdout as plain text ({len(raw_stdout)} chars)")
                events.append({
                    "_ts": int(time.time() * 1000),
                    "_fallback": True,
                    "type": "result",
                    "subtype": "success",
                    "result": raw_stdout.strip(),
                })

        return {
            "events": events,
            "rawStdout": raw_stdout,
            "stderr": stderr_text,
            "code": return_code,
            "timedOut": timed_out,
        }

    except Exception as e:
        log.error(f"[Stream] Error: {e}")
        return {
            "events": events,
            "rawStdout": raw_stdout,
            "stderr": stderr_text,
            "code": -1,
            "timedOut": False,
            "error": str(e),
        }


def log_stream_event(event: dict):
    etype = event.get("type")
    if etype == "system":
        log.info(f"[Stream] init — session: {event.get('session_id', '?')}, tools: {len(event.get('tools', []))}")
    elif etype == "assistant":
        for block in event.get("message", {}).get("content", []):
            if block.get("type") == "text":
                text = block.get("text", "")
                preview = text[:100] + ("..." if len(text) > 100 else "")
                log.info(f"[Stream] text ({len(text)} chars): {preview}")
            elif block.get("type") == "tool_use":
                input_str = json.dumps(block.get("input", {}))[:120]
                log.info(f"[Stream] tool_use: {block.get('name')} — {input_str}")
    elif etype == "tool_result":
        content = event.get("content", "")
        content_len = len(content) if isinstance(content, str) else len(json.dumps(content))
        log.info(f"[Stream] tool_result ({content_len} chars)")
    elif etype == "result":
        cost = event.get("total_cost_usd")
        cost_str = f"${cost:.4f}" if cost else "?"
        log.info(f"[Stream] result — subtype: {event.get('subtype')}, turns: {event.get('num_turns')}, cost: {cost_str}")


# ── Event Parsing Helpers ────────────────────
def parse_stream_events(events: list) -> dict:
    result_event = None
    for e in reversed(events):
        if e.get("type") == "result":
            result_event = e
            break

    text_parts = []
    for e in events:
        if e.get("type") == "assistant":
            for block in e.get("message", {}).get("content", []):
                if block.get("type") == "text":
                    text_parts.append(block["text"])

    response_text = result_event.get("result", "") if result_event else ""
    if not response_text and text_parts:
        response_text = "\n".join(text_parts)

    status = result_event.get("subtype", "unknown") if result_event else "unknown"
    model_usage = result_event.get("modelUsage", {}) if result_event else {}

    return {
        "responseText": response_text,
        "status": status,
        "turns": result_event.get("num_turns", 0) if result_event else 0,
        "cost_usd": result_event.get("total_cost_usd", 0) if result_event else 0,
        "model": list(model_usage.keys())[0] if model_usage else "unknown",
        "sessionId": result_event.get("session_id") if result_event else None,
    }


def summarize_event(event: dict) -> dict:
    summary = {"ts": event.get("_ts", int(time.time() * 1000)), "type": event.get("type")}

    if event.get("type") == "system":
        summary["session_id"] = event.get("session_id")
        summary["tools"] = event.get("tools")
    elif event.get("type") == "assistant" and event.get("message", {}).get("content"):
        summary["content"] = []
        for c in event["message"]["content"]:
            if c.get("type") == "text":
                summary["content"].append({"type": "text", "length": len(c["text"]), "preview": c["text"][:300]})
            elif c.get("type") == "tool_use":
                summary["content"].append({
                    "type": "tool_use", "tool": c.get("name"), "id": c.get("id"),
                    "input_preview": json.dumps(c.get("input", {}))[:200],
                })
            else:
                summary["content"].append({"type": c.get("type")})
    elif event.get("type") == "tool_result":
        content = event.get("content", "")
        content_str = content if isinstance(content, str) else json.dumps(content)
        summary["tool_use_id"] = event.get("tool_use_id")
        summary["content_length"] = len(content_str)
        summary["preview"] = content_str[:300]
        summary["is_error"] = event.get("is_error", False)
    elif event.get("type") == "user" and isinstance(event.get("message", {}).get("content"), list):
        summary["content"] = []
        for c in event["message"]["content"]:
            if c.get("type") == "tool_result":
                text = c.get("content", "")
                text = text if isinstance(text, str) else json.dumps(text)
                summary["content"].append({
                    "type": "tool_result", "tool_use_id": c.get("tool_use_id"),
                    "is_error": c.get("is_error", False), "length": len(text), "preview": text[:300],
                })
            else:
                summary["content"].append({"type": c.get("type")})
    elif event.get("type") == "result":
        summary["subtype"] = event.get("subtype")
        summary["num_turns"] = event.get("num_turns")
        summary["cost_usd"] = event.get("total_cost_usd")
        summary["duration_ms"] = event.get("duration_ms")
        summary["model_usage"] = event.get("modelUsage")

    return summary


def build_safe_line(event: dict, turn: int) -> Optional[dict]:
    if event.get("type") == "assistant" and event.get("message", {}).get("content"):
        content = event["message"]["content"]
        tool_use = next((c for c in content if c.get("type") == "tool_use"), None)
        if tool_use:
            return {"type": "status", "event": "tool_use", "tool": tool_use.get("name"), "turn": turn}
        has_text = any(c.get("type") == "text" and c.get("text", "").strip() for c in content)
        if has_text:
            return {"type": "status", "event": "thinking", "tool": None, "turn": turn}
    if event.get("type") == "user" and isinstance(event.get("message", {}).get("content"), list):
        has_tr = any(c.get("type") == "tool_result" for c in event["message"]["content"])
        if has_tr:
            return {"type": "status", "event": "tool_result", "tool": None, "turn": turn}
    return None


def extract_actions(text: str) -> tuple:
    actions = []
    for match in re.finditer(r"<!--ACTION:(.*?)-->", text, re.DOTALL):
        try:
            actions.append(json.loads(match.group(1)))
        except json.JSONDecodeError:
            pass
    clean_text = re.sub(r"<!--ACTION:.*?-->", "", text, flags=re.DOTALL).strip()
    return clean_text, actions


def parse_analysis_text(text: str) -> dict:
    if not text:
        return {"diagnosis": "No response from AI.", "suggested_steps": [], "confidence": 0}
    try:
        json_match = re.search(r"\{[\s\S]*\}", text)
        if json_match:
            parsed = json.loads(json_match.group(0))
            return {
                "diagnosis": parsed.get("diagnosis", "Analysis complete."),
                "suggested_steps": parsed.get("suggested_steps", []) if isinstance(parsed.get("suggested_steps"), list) else [],
                "confidence": parsed.get("confidence", 0.5) if isinstance(parsed.get("confidence"), (int, float)) else 0.5,
            }
    except json.JSONDecodeError:
        pass
    return {"diagnosis": text[:2000], "suggested_steps": [], "confidence": 0.3}


# ── Prompt Builders ──────────────────────────
def build_chat_prompt(message: str, history: list, context: dict, image_paths: list = None) -> str:
    image_paths = image_paths or []
    is_admin = context.get("role") == "admin"

    # Truncate history
    MAX_HISTORY_MSGS = 10
    MAX_MSG_CHARS = 500
    history_lines = []
    for h in (history or [])[-MAX_HISTORY_MSGS:]:
        content = h.get("content", "")
        if len(content) > MAX_MSG_CHARS:
            content = content[:MAX_MSG_CHARS] + "...[truncated]"
        role_label = "User" if h.get("role") == "user" else "Assistant"
        history_lines.append(f"{role_label}: {content}")
    history_text = "\n\n".join(history_lines)

    page_context = f'The user is currently on the "{context.get("page")}" page of the portal.' if context.get("page") else ""

    # Database query block
    has_db = bool(DATABASE_URL)
    db_query_path = str(Path(__file__).parent / "db_query.py")
    db_query_block = ""
    if has_db:
        db_query_block = f"""
DATABASE ACCESS (read-only):
  python {db_query_path} "SELECT ..."
- Only SELECT/WITH allowed. Returns JSON array.
- KEY TABLES:
  * entities (device_id, entity_id, is_bound, name, character, state, message, webhook JSONB, xp, level, avatar, public_code)
  * devices (device_id, device_secret, created_at, paid_borrow_slots)
  * server_logs (id, level, category, message, device_id, entity_id, metadata JSONB, created_at)
    categories: bind, unbind, transform, broadcast, broadcast_push, speakto_push, client_push, entity_poll, push_error, handshake, system
  * handshake_failures (device_id, entity_id, webhook_url, error_type, http_status, error_message, source, created_at)
  * device_telemetry (device_id, ts, type, action, page, input JSONB, output JSONB, duration, meta JSONB)
  * scheduled_messages (device_id, entity_id, message, scheduled_at, repeat_type, status, label)
  * official_bots (bot_id, bot_type, webhook_url, status, assigned_device_id, assigned_entity_id)
  * official_bot_bindings (bot_id, device_id, entity_id, session_key, bound_at)
- COMMON QUERIES:
  Entity status: SELECT entity_id, name, character, is_bound, state, webhook, last_updated FROM entities WHERE device_id='...'
  Recent logs:   SELECT level, category, message, created_at FROM server_logs WHERE device_id='...' ORDER BY created_at DESC LIMIT 30
  Binding hist:  SELECT category, message, created_at FROM server_logs WHERE device_id='...' AND category IN ('bind','unbind') ORDER BY created_at DESC LIMIT 20
  Webhook fails: SELECT error_type, error_message, webhook_url, created_at FROM handshake_failures WHERE device_id='...' ORDER BY created_at DESC LIMIT 10
  App crashes:   SELECT ts, action, meta FROM device_telemetry WHERE device_id='...' AND type='crash' ORDER BY ts DESC LIMIT 10
  App errors:    SELECT ts, action, meta FROM device_telemetry WHERE device_id='...' AND type='error' ORDER BY ts DESC LIMIT 20
  Recent activity: SELECT ts, type, action, page, duration FROM device_telemetry WHERE device_id='...' ORDER BY ts DESC LIMIT 30

CRASH INVESTIGATION:
When a user reports app crash, ALWAYS query device_telemetry for crash data:
  1. Query type='crash' entries — these contain full stack traces in meta.stack_trace and recent debug logs in meta.recent_log
  2. Query type='error' entries — these are non-fatal errors that may show a pattern leading to the crash
  3. Look at meta.message for the exception message, meta.stack_trace for the full trace, meta.thread for the crashing thread
  4. Check the action field — it contains the exception class name (e.g. NullPointerException, IllegalStateException)
  5. Cross-reference with server_logs around the same timestamp to see if a backend API call failed
  6. Report findings: exception type, which method/line crashed, what the user was doing (from recent debug log), and suggested fix
- NEVER expose device_secret, tokens, or raw credentials in your response."""

    if is_admin:
        role_block = f"""ADMIN CAPABILITIES:
You are talking to the E-Claw platform admin/developer.
- Suggest code changes, architecture improvements, or debugging strategies.
- Use Read, Glob, Grep tools to read source code; Bash for commands.
- On request, create GitHub issues via: <!--ACTION:{{"type":"create_issue","title":"...","body":"...","labels":["bug"]}}-->
- Speak as a fellow engineer.{db_query_block}"""
    else:
        role_block = f"""USER CONTEXT:
You are talking to a regular E-Claw user (Device ID: {context.get('deviceId', 'unknown')}).
- Help them use the portal, manage entities, configure bots. Keep language friendly.
- When user reports a bug or suggests a feature, proactively create a GitHub issue: <!--ACTION:{{"type":"create_issue","title":"[Bug/Feature] ...","body":"...","labels":["bug"]}}-->
  Tell user you've recorded their feedback.{db_query_block}"""

    image_block = ""
    if image_paths:
        image_block = f"USER ATTACHED {len(image_paths)} IMAGE(S):\nUse Read tool to view: {', '.join(image_paths)}\n"

    return f"""You are E-Claw AI, assistant for the E-Claw platform — an AI-powered Android live wallpaper app where users bind AI bots (OpenClaw) to entities (Lobster, Pig) on their phone. Web portal: eclawbot.com.
{page_context}

{role_block}

RULES:
- NON-INTERACTIVE mode: use tools directly, no permission prompts.
- Respond in the SAME LANGUAGE as the user (Chinese -> Chinese, English -> English).
- Concise (1-4 paragraphs). Use markdown. Never reveal secrets/tokens/device IDs.
- IMPORTANT: After using tools to gather data, ALWAYS produce a text response summarizing your findings. Never end a turn with only tool calls and no text output.

{image_block}{f"CONVERSATION HISTORY:\n{history_text}\n" if history_text else ""}User: {message}

Respond naturally as E-Claw AI."""


def build_analysis_prompt(problem, errors, logs, failures, context, crashes) -> str:
    is_admin = context.get("role") == "admin" if context else False
    error_list = "\n".join(f"- {e}" for e in (errors or [])) or "(none provided)"

    log_list = "\n".join(
        f"[{l.get('level')}] {l.get('category')}: {l.get('message')} ({l.get('created_at')})"
        for l in (logs or [])[:20]
    ) or "(no recent logs)"

    failure_list = "\n".join(
        f"[{f.get('error_type')}] {f.get('error_message', 'no detail')} | URL: {f.get('webhook_url', '?')} | source: {f.get('source', '?')} ({f.get('created_at')})"
        for f in (failures or [])[:5]
    ) or "(no recent failures)"

    crash_parts = []
    for c in (crashes or [])[:10]:
        meta = c.get("meta", {}) or {}
        ts_val = c.get("ts")
        ts = ""
        if ts_val:
            try:
                from datetime import datetime, timezone
                ts = datetime.fromtimestamp(int(ts_val) / 1000, tz=timezone.utc).isoformat()
            except Exception:
                ts = str(ts_val)
        else:
            ts = c.get("created_at", "?")
        stack = (meta.get("stack_trace") or "")[:500]
        crash_parts.append(f"[{ts}] {c.get('action', 'unknown')}: {meta.get('message', '(no message)')}\n  Stack: {stack}")
    crash_list = "\n\n".join(crash_parts) or "(no recent crashes)"

    if is_admin:
        role_context = """ROLE: You are talking to the E-Claw ADMIN (the developer/owner of the platform).
The admin is testing, training, or debugging the AI support system directly.
- Do NOT assume the admin is an OpenClaw bot — they built this system.
- Speak to them as a fellow engineer. Use technical language freely.
- If they ask a question about the system, answer directly (don't suggest "exec:" commands for them).
- If they describe a hypothetical bot scenario, analyze it but clarify your reasoning.
- You may suggest code changes, architectural improvements, or config fixes."""
    else:
        role_context = """ROLE: You are helping an OpenClaw BOT that encountered a binding/webhook issue.
The bot communicates via exec: commands (shell commands) and HTTP requests.
- Provide actionable steps with exact exec: commands the bot can run.
- Keep instructions simple — the bot follows step-by-step."""

    device_id = context.get("deviceId", "?") if context else "?"
    entity_id = context.get("entityId", "?") if context else "?"
    timestamp = context.get("timestamp", "") if context else ""

    return f"""You are an E-Claw backend support engineer.

{role_context}

DEVICE: {device_id} Entity {entity_id}
TIMESTAMP: {timestamp or time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}

PROBLEM DESCRIPTION:
{problem or '(not provided)'}

{'MESSAGES:' if is_admin else 'ERROR MESSAGES FROM BOT:'}
{error_list}

RECENT SERVER LOGS (newest first):
{log_list}

RECENT HANDSHAKE FAILURES:
{failure_list}

RECENT APP CRASHES & ERRORS (from device telemetry, last 24h):
{crash_list}

KNOWN ERROR TYPES AND THEIR FIXES:
- localhost_rejected: webhook URL points to private IP -> use ZEABUR_WEB_URL env var
- http_401: wrong gateway token or setup_password -> re-read env vars with echo $OPENCLAW_GATEWAY_TOKEN
- tool_not_available: sessions_send blocked -> allow it in gateway config via openclaw CLI
- pairing_required: gateway disconnected -> restart gateway (ask user first)
- connection_failed: DNS/network error -> check URL is public and uses HTTPS
- expired_code: binding code expired after 5 min -> ask device owner for new code
- placeholder_token: token is a variable name, not actual value -> read real token from env

E-CLAW API REFERENCE:
- POST /api/bind {{ code, name? }} — bind to entity
- POST /api/bot/register {{ deviceId, entityId, botSecret, webhook_url, token, session_key, openclaw_version?, setup_username?, setup_password? }} — register webhook
- POST /api/transform {{ deviceId, entityId, botSecret, state, message }} — update entity status

Respond in this EXACT JSON format (no markdown, no code fences, just raw JSON):
{{
  "diagnosis": "Clear, concise explanation",
  "suggested_steps": ["Step 1...", "Step 2...", "Step 3..."],
  "confidence": 0.85
}}

Rules:
- Be concise — max 3-5 steps
- Confidence: 0.0 to 1.0 based on how certain you are
- If you cannot determine the issue, say so and suggest general debugging steps"""


# ── Repo Clone & Sync ────────────────────────
def ensure_repo_clone():
    try:
        git_dir = REPO_DIR / ".git"
        if git_dir.exists():
            log.info("[Repo] Pulling latest...")
            import subprocess
            subprocess.run(["git", "pull", "--ff-only"], cwd=str(REPO_DIR), timeout=30, capture_output=True)
            log.info("[Repo] Updated.")
        else:
            log.info("[Repo] Cloning repository...")
            REPO_DIR.mkdir(parents=True, exist_ok=True)
            import subprocess
            subprocess.run(["git", "clone", "--depth", "50", REPO_URL, str(REPO_DIR)], timeout=120, capture_output=True)
            log.info(f"[Repo] Cloned to {REPO_DIR}")
    except Exception as e:
        log.error(f"[Repo] Git error: {str(e)[:300]}")


# ── Warmup ───────────────────────────────────
_last_warmup_at = 0


async def warmup():
    global _last_warmup_at
    now = time.time()
    if now - _last_warmup_at < 60:
        return
    _last_warmup_at = now

    log.info("[Warmup] Pre-warming Claude CLI...")
    start = time.time()
    try:
        result = await run_claude_stream(
            'Reply with exactly: {"status":"warm"}',
            ["--model", "haiku"],
            15,
        )
        events = result.get("events", [])
        result_event = next((e for e in events if e.get("type") == "result"), None)
        status = result_event.get("subtype", "unknown") if result_event else "unknown"
        log.info(f"[Warmup] Claude CLI warm ({time.time() - start:.1f}s, status: {status})")
    except Exception as e:
        log.warning(f"[Warmup] Failed ({time.time() - start:.1f}s): {str(e)[:200]}")


# ── Auto-restore .claude.json from backup ────
def restore_claude_config():
    home = Path(os.environ.get("HOME", "/root"))
    config_path = home / ".claude.json"
    if not config_path.exists():
        backup_dir = home / ".claude" / "backups"
        try:
            files = sorted(f for f in backup_dir.iterdir() if f.name.startswith(".claude.json.backup."))
            if files:
                latest = files[-1]
                import shutil as _shutil
                _shutil.copy2(str(latest), str(config_path))
                log.info(f"[Startup] Restored {config_path} from backup: {latest.name}")
        except Exception:
            pass


# ── App Lifespan ─────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    restore_claude_config()

    # Write DB config for child processes
    if DATABASE_URL:
        db_config_path = Path(__file__).parent / ".db-config"
        db_config_path.write_text(DATABASE_URL)
        log.info(f"[Startup] DATABASE_URL written to {db_config_path}")

    # Clone/sync repo after short delay
    loop = asyncio.get_event_loop()
    loop.call_later(3, lambda: loop.run_in_executor(None, ensure_repo_clone))

    # Periodic git pull every 30 minutes
    async def periodic_repo_sync():
        while True:
            await asyncio.sleep(30 * 60)
            await asyncio.get_event_loop().run_in_executor(None, ensure_repo_clone)

    repo_task = asyncio.create_task(periodic_repo_sync())

    # Warmup on startup after 8s delay
    async def startup_warmup():
        await asyncio.sleep(8)
        await warmup()

    warmup_task = asyncio.create_task(startup_warmup())

    # Periodic warmup every 5 minutes
    async def periodic_warmup():
        while True:
            await asyncio.sleep(5 * 60)
            await warmup()

    periodic_warmup_task = asyncio.create_task(periodic_warmup())

    yield

    # Shutdown
    repo_task.cancel()
    warmup_task.cancel()
    periodic_warmup_task.cancel()


app = FastAPI(title="eclaw-claude-cli-proxy", version="2.0.0", lifespan=lifespan)


# Return 503 as a plain JSON dict (not wrapped in FastAPI's {"detail": ...})
# so that the backend can read body.retry_after directly
@app.exception_handler(QueueBusyError)
async def queue_busy_handler(_request: Request, exc: QueueBusyError):
    return JSONResponse(
        status_code=503,
        content={"error": exc.error, "message": exc.message, "retry_after": exc.retry_after},
    )


# ── Auth Middleware ───────────────────────────
async def require_auth(request: Request):
    if not SUPPORT_API_KEY:
        raise HTTPException(status_code=500, detail="SUPPORT_API_KEY not configured")
    auth = request.headers.get("authorization", "")
    if auth != f"Bearer {SUPPORT_API_KEY}":
        raise HTTPException(status_code=401, detail="Unauthorized")


# ── Health Check ─────────────────────────────
@app.get("/health")
async def health():
    health_data = {"status": "ok", "service": "eclaw-claude-cli-proxy", "claude_cli": "unknown"}
    try:
        proc = await asyncio.create_subprocess_exec(
            CLAUDE_BIN, "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "HOME": os.environ.get("HOME", "/root")},
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        health_data["claude_cli"] = "available"
        health_data["claude_version"] = stdout.decode().strip()
    except Exception as e:
        health_data["claude_cli"] = "unavailable"
        health_data["claude_error"] = str(e)[:200]
    return health_data


# ── Queue Status ─────────────────────────────
@app.get("/queue-status")
async def queue_status():
    return {"active": _active_count, "max_concurrent": MAX_CONCURRENT, "queued": _queue_count, "max_queue": MAX_QUEUE}


# ── Request Models ───────────────────────────
class AnalyzeRequest(BaseModel):
    problem_description: str = ""
    error_messages: list = []
    logs: list = []
    handshake_failures: list = []
    app_crashes: list = []
    device_context: dict = {}


class ImageData(BaseModel):
    data: str = ""
    mimeType: str = ""


class ChatRequest(BaseModel):
    message: str
    history: list = []
    images: list = []
    device_context: dict = {}


# ── Analysis Endpoint ────────────────────────
@app.post("/analyze")
async def analyze(req: AnalyzeRequest, request: Request):
    await require_auth(request)

    prompt = build_analysis_prompt(
        req.problem_description, req.error_messages, req.logs,
        req.handshake_failures, req.device_context, req.app_crashes,
    )
    device_id = req.device_context.get("deviceId", "?")
    log.info(f"[Analyze] Request for device: {device_id}")

    await acquire_slot(CLAUDE_TIMEOUT_MS)
    session = create_session("analyze", f"Device: {device_id} — {(req.problem_description or '')[:150]}")

    try:
        log.info(f"[Analyze] Calling Claude CLI (prompt: {len(prompt)} chars)...")
        start_time = time.time()

        result = await run_claude_stream(prompt, ["--model", "haiku"], CLAUDE_TIMEOUT_MS)

        latency_ms = int((time.time() - start_time) * 1000)
        parsed = parse_stream_events(result["events"])

        session["events"] = [summarize_event(e) for e in result["events"]]
        session["turns"] = parsed["turns"]
        session["cost_usd"] = parsed["cost_usd"]
        session["model"] = parsed["model"]
        session["response"] = (parsed["responseText"] or "")[:500]

        if result["timedOut"]:
            session["status"] = "timeout"
            session["error"] = "Claude CLI timed out"
            finalize_session(session)
            log.error(f"[Analyze] Timeout ({latency_ms}ms)")
            return {
                "diagnosis": "AI analysis timed out. Please try standard troubleshooting.",
                "suggested_steps": [
                    "Check your webhook URL is reachable from the internet.",
                    "Verify your gateway token with: exec: echo $OPENCLAW_GATEWAY_TOKEN",
                    "If SETUP_PASSWORD is enabled, include it in /api/bot/register.",
                    "Retry POST /api/bot/register with openclaw_version included.",
                ],
                "confidence": 0,
                "session_id": session["id"],
                "debug": {"reason": "timeout", "latency_ms": latency_ms},
            }

        session["status"] = "success" if parsed["status"] == "success" else parsed["status"]
        finalize_session(session)

        log.info(f"[Analyze] Done ({latency_ms}ms, status: {parsed['status']}, turns: {parsed['turns']})")
        if result["stderr"]:
            log.warning(f"[Analyze] stderr: {result['stderr'][:300]}")

        analysis = parse_analysis_text(parsed["responseText"])
        analysis["session_id"] = session["id"]
        analysis["latency_ms"] = latency_ms
        return analysis

    except HTTPException:
        raise
    except Exception as e:
        session["status"] = "error"
        session["error"] = str(e)
        finalize_session(session)
        log.error(f"[Analyze] Error: {e}")
        return {
            "diagnosis": "AI analysis failed. Please try standard troubleshooting.",
            "suggested_steps": [],
            "confidence": 0,
            "session_id": session["id"],
            "debug": {"error": str(e)[:300]},
        }
    finally:
        release_slot()


# ── Chat Endpoint ────────────────────────────
@app.post("/chat")
async def chat(req: ChatRequest, request: Request):
    await require_auth(request)

    if not req.message or not req.message.strip():
        raise HTTPException(status_code=400, detail="message is required")

    await acquire_slot(CHAT_TIMEOUT_MS)

    # Save images to temp files so Claude can Read them
    image_paths = []
    if req.images:
        for i, img in enumerate(req.images[:3]):
            if isinstance(img, dict) and img.get("data") and img.get("mimeType"):
                ext = "png" if img["mimeType"] == "image/png" else "jpg"
                tmp_path = f"/tmp/eclaw_chat_img_{int(time.time())}_{i}.{ext}"
                try:
                    with open(tmp_path, "wb") as f:
                        f.write(base64.b64decode(img["data"]))
                    image_paths.append(tmp_path)
                except Exception as e:
                    log.error(f"[Chat] Failed to write temp image: {e}")

    prompt = build_chat_prompt(req.message, req.history, req.device_context, image_paths)
    role = req.device_context.get("role", "user")
    page = req.device_context.get("page", "?")
    is_admin = role == "admin"
    want_stream = request.query_params.get("stream") == "1"

    log.info(f'[Chat] Request from {role} on page "{page}" (prompt: {len(prompt)} chars, images: {len(image_paths)})')

    session = create_session("chat", f"{role}@{page}: {req.message[:150]}")
    start_time = time.time()

    # Build Claude CLI args
    cli_args = ["--model", "sonnet", "--max-turns", "15"]
    tools = []
    if (REPO_DIR / ".git").exists():
        tools.extend(["Read", "Glob", "Grep"])
    elif image_paths:
        tools.append("Read")
    tools.append("Bash")
    if tools:
        cli_args.extend(["--allowedTools", ",".join(tools)])

    child_cwd = str(REPO_DIR) if REPO_DIR.exists() else str(Path(__file__).parent)
    child_env = {**os.environ, "HOME": os.environ.get("HOME", "/root"), "CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS": "1"}

    # ── Streaming mode: use async generator + StreamingResponse ──
    if want_stream:
        event_queue: asyncio.Queue = asyncio.Queue()

        async def stream_generator():
            stream_turn = 0

            def on_stream_event(event):
                nonlocal stream_turn
                line = build_safe_line(event, stream_turn)
                if line:
                    if event.get("type") == "assistant":
                        stream_turn += 1
                    event_queue.put_nowait(json.dumps(line) + "\n")

            # Run Claude CLI in a background task so we can yield lines as they arrive
            async def run_cli():
                return await run_claude_stream(
                    prompt, cli_args, CHAT_TIMEOUT_MS,
                    cwd=child_cwd, env=child_env, on_event=on_stream_event,
                )

            cli_task = asyncio.create_task(run_cli())

            # Yield status lines as they arrive
            try:
                while not cli_task.done():
                    try:
                        line = await asyncio.wait_for(event_queue.get(), timeout=1.0)
                        yield line
                    except asyncio.TimeoutError:
                        continue

                # Drain any remaining queued events
                while not event_queue.empty():
                    yield event_queue.get_nowait()

                # Process final result
                result = await cli_task
                latency_ms = int((time.time() - start_time) * 1000)
                parsed = parse_stream_events(result["events"])

                session["events"] = [summarize_event(e) for e in result["events"]]
                session["turns"] = parsed["turns"]
                session["cost_usd"] = parsed["cost_usd"]
                session["model"] = parsed["model"]

                if result["timedOut"]:
                    session["status"] = "timeout"
                    session["error"] = "Claude CLI timed out"
                    partial_text = parsed["responseText"] or "Sorry, I was unable to process your request in time. Please try again."
                    session["response"] = partial_text[:500]
                    finalize_session(session)
                    log.error(f"[Chat] Timeout ({latency_ms}ms), partial response: {len(partial_text)} chars")
                    yield json.dumps({"type": "complete", "response": partial_text, "status": "timeout", "session_id": session["id"], "latency_ms": latency_ms}) + "\n"
                    return

                if parsed["status"] == "error_max_turns":
                    session["status"] = "error_max_turns"
                    partial_text = parsed["responseText"]
                    if not partial_text:
                        text_parts = []
                        for e in result["events"]:
                            if e.get("type") == "assistant":
                                for block in e.get("message", {}).get("content", []):
                                    if block.get("type") == "text" and block.get("text"):
                                        text_parts.append(block["text"])
                        partial_text = "\n".join(text_parts) if text_parts else ""
                    if not partial_text:
                        partial_text = "Sorry, this question required more analysis steps than allowed. Could you try asking a more specific question?"
                    session["response"] = partial_text[:500]
                    finalize_session(session)
                    log.warning(f"[Chat] Max turns reached ({parsed['turns']} turns, {latency_ms}ms)")
                    clean_text, actions = extract_actions(partial_text)
                    yield json.dumps({"type": "complete", "response": clean_text, "actions": actions if actions else None, "status": "max_turns", "session_id": session["id"], "latency_ms": latency_ms}) + "\n"
                    return

                session["status"] = "success" if parsed["status"] == "success" else parsed["status"]
                session["response"] = (parsed["responseText"] or "")[:500]
                finalize_session(session)
                log.info(f"[Chat] Done ({latency_ms}ms, status: {parsed['status']}, turns: {parsed['turns']})")

                clean_text, actions = extract_actions(parsed["responseText"] or "")
                response_text = clean_text or "I received your message but had trouble generating a response."
                yield json.dumps({"type": "complete", "response": response_text, "actions": actions if actions else None, "session_id": session["id"], "latency_ms": latency_ms}) + "\n"

            except Exception as e:
                latency_ms = int((time.time() - start_time) * 1000)
                session["status"] = "error"
                session["error"] = str(e)
                finalize_session(session)
                log.error(f"[Chat] Stream error ({latency_ms}ms): {e}")
                yield json.dumps({"type": "complete", "status": "error", "response": "Sorry, I was unable to process your request. Please try again in a moment.", "session_id": session["id"], "latency_ms": latency_ms}) + "\n"
            finally:
                release_slot()
                for p in image_paths:
                    try:
                        os.unlink(p)
                    except Exception:
                        pass

        return StreamingResponse(
            stream_generator(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # ── Non-streaming mode ──
    try:
        result = await run_claude_stream(
            prompt, cli_args, CHAT_TIMEOUT_MS,
            cwd=child_cwd, env=child_env,
        )

        latency_ms = int((time.time() - start_time) * 1000)
        parsed = parse_stream_events(result["events"])

        session["events"] = [summarize_event(e) for e in result["events"]]
        session["turns"] = parsed["turns"]
        session["cost_usd"] = parsed["cost_usd"]
        session["model"] = parsed["model"]

        if result["timedOut"]:
            session["status"] = "timeout"
            session["error"] = "Claude CLI timed out"
            partial_text = parsed["responseText"] or "Sorry, I was unable to process your request in time. Please try again."
            session["response"] = partial_text[:500]
            finalize_session(session)
            log.error(f"[Chat] Timeout ({latency_ms}ms), partial response: {len(partial_text)} chars")
            return {"response": partial_text, "status": "timeout", "session_id": session["id"], "latency_ms": latency_ms}

        if parsed["status"] == "error_max_turns":
            session["status"] = "error_max_turns"
            partial_text = parsed["responseText"]
            if not partial_text:
                text_parts = []
                for e in result["events"]:
                    if e.get("type") == "assistant":
                        for block in e.get("message", {}).get("content", []):
                            if block.get("type") == "text" and block.get("text"):
                                text_parts.append(block["text"])
                partial_text = "\n".join(text_parts) if text_parts else ""
            if not partial_text:
                partial_text = "Sorry, this question required more analysis steps than allowed. Could you try asking a more specific question?"
            session["response"] = partial_text[:500]
            finalize_session(session)
            log.warning(f"[Chat] Max turns reached ({parsed['turns']} turns, {latency_ms}ms), partial response: {len(partial_text)} chars")
            clean_text, actions = extract_actions(partial_text)
            return {"response": clean_text, "actions": actions if actions else None, "status": "max_turns", "session_id": session["id"], "latency_ms": latency_ms}

        session["status"] = "success" if parsed["status"] == "success" else parsed["status"]
        session["response"] = (parsed["responseText"] or "")[:500]
        finalize_session(session)

        log.info(f"[Chat] Done ({latency_ms}ms, status: {parsed['status']}, turns: {parsed['turns']})")
        if result["stderr"]:
            log.warning(f"[Chat] stderr: {result['stderr'][:300]}")

        clean_text, actions = extract_actions(parsed["responseText"] or "")
        response_text = clean_text or "I received your message but had trouble generating a response."
        return {"response": response_text, "actions": actions if actions else None, "session_id": session["id"], "latency_ms": latency_ms}

    except HTTPException:
        raise
    except Exception as e:
        latency_ms = int((time.time() - start_time) * 1000)
        session["status"] = "error"
        session["error"] = str(e)
        finalize_session(session)
        log.error(f"[Chat] Error ({latency_ms}ms): {e}")
        raise HTTPException(status_code=500, detail={
            "response": "Sorry, I was unable to process your request. Please try again in a moment.",
            "session_id": session["id"], "latency_ms": latency_ms,
        })
    finally:
        release_slot()
        for p in image_paths:
            try:
                os.unlink(p)
            except Exception:
                pass


# ── Session Query Endpoints ──────────────────
@app.get("/sessions")
async def get_sessions(request: Request, limit: int = 20, status: str = None, since: int = 0):
    await require_auth(request)
    limit = min(limit, 50)

    filtered = list(session_store)
    if status:
        filtered = [s for s in filtered if s["status"] == status]
    if since > 0:
        filtered = [s for s in filtered if s["startedAt"] >= since]

    result = []
    for s in filtered[:limit]:
        result.append({
            "id": s["id"],
            "startedAt": s["startedAt"],
            "completedAt": s["completedAt"],
            "type": s["type"],
            "status": s["status"],
            "prompt": s["prompt"],
            "response": s["response"],
            "turns": s["turns"],
            "cost_usd": s["cost_usd"],
            "model": s["model"],
            "error": s["error"],
            "event_count": len(s["events"]),
            "duration_ms": s["completedAt"] - s["startedAt"] if s["completedAt"] else None,
        })

    return {"sessions": result, "total": len(filtered)}


@app.get("/sessions/{session_id}")
async def get_session(session_id: str, request: Request):
    await require_auth(request)
    session = next((s for s in session_store if s["id"] == session_id), None)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


# ── Warmup Endpoint ──────────────────────────
@app.post("/warmup")
async def warmup_endpoint():
    asyncio.create_task(warmup())
    return {"status": "warming"}


# ── Main ─────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    log.info(f"[Claude CLI Proxy] Starting on port {PORT}")
    if not SUPPORT_API_KEY:
        log.warning("[Claude CLI Proxy] WARNING: SUPPORT_API_KEY not set — all requests will be rejected")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
