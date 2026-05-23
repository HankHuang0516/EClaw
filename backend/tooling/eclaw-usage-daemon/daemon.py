#!/usr/bin/env python3
"""EClaw usage daemon — Plan B Phase 2.

Polls Claude Code + Codex CLI local usage data once per INTERVAL (default
60s) and POSTs an aggregated UsageSnapshot to /api/usage/snapshot. Designed
to run under launchd (`com.eclaw.usage-daemon.plist`).

Resilience contract:
  * Loaders catch their own I/O errors and return partial data — a single
    corrupt .jsonl never kills the loop.
  * POST failures retry in-loop with exponential backoff (1/2/4/8/30s cap).
  * After 5 consecutive failures, the snapshot is dropped to a pending
    cache (~/.cache/eclaw-usage-daemon/pending/<ts>.json) and replayed on
    the next successful POST.

Logging never prints botSecret / deviceSecret — only the field names.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import urllib.error
import urllib.request

# Local imports — daemon.py and modules live in the same directory; we add
# the parent dir to sys.path so it works both as `python3 daemon.py` and
# `python3 -m eclaw_usage_daemon.daemon` style invocations.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from auth import load_credentials  # noqa: E402
from claude_loader import ClaudeLoader  # noqa: E402
from codex_loader import CodexLoader  # noqa: E402
import pricing  # noqa: E402

DAEMON_VERSION = "phase2-0.1.0"
DEFAULT_INTERVAL = 60
DEFAULT_HOURS_BACK = 24
SNAPSHOT_TIMEOUT = 10  # seconds
MAX_PENDING_PER_FLUSH = 20
PENDING_DIR = Path(os.path.expanduser("~/.cache/eclaw-usage-daemon/pending"))

UTC = timezone.utc

_BACKOFF_SECONDS = (1, 2, 4, 8, 30)
_FAILURE_THRESHOLD = 5

log = logging.getLogger("eclaw-usage-daemon")


# ---------- snapshot building ----------

def _enrich_claude_costs(sessions: list[dict[str, Any]]) -> None:
    for s in sessions:
        s["cost_usd"] = pricing.claude_cost(
            s.get("model", ""),
            s.get("input_tokens", 0),
            s.get("output_tokens", 0),
            s.get("cache_creation_tokens", 0),
            s.get("cache_read_tokens", 0),
        )


def _enrich_codex_costs(sessions: list[dict[str, Any]]) -> None:
    for s in sessions:
        s["cost_usd"] = pricing.codex_cost(
            s.get("model", ""),
            s.get("input_tokens", 0),
            s.get("output_tokens", 0),
            s.get("cached_tokens", 0),
        )


def build_snapshot(
    claude_loader: ClaudeLoader,
    codex_loader: CodexLoader,
    hours_back: int,
) -> dict[str, Any]:
    claude_sessions = claude_loader.load_sessions(hours_back)
    _enrich_claude_costs(claude_sessions)
    claude_live = claude_loader.load_live()
    codex_sessions, codex_rate_limits = codex_loader.load(hours_back)
    _enrich_codex_costs(codex_sessions)

    return {
        "captured_at": datetime.now(UTC).isoformat(),
        "daemon_version": DAEMON_VERSION,
        "pricing_source": pricing.pricing_source(),
        "claude": {
            "live": claude_live,
            "sessions": claude_sessions,
        },
        "codex": {
            "rate_limits": codex_rate_limits,
            "sessions": codex_sessions,
        },
    }


# ---------- POST + retries ----------

def _post_snapshot(api_url: str, body: dict[str, Any]) -> tuple[int, dict[str, Any] | None]:
    url = f"{api_url}/api/usage/snapshot"
    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json", "User-Agent": f"eclaw-usage-daemon/{DAEMON_VERSION}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=SNAPSHOT_TIMEOUT) as resp:
            status = resp.getcode()
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        try:
            raw = exc.read().decode("utf-8", errors="replace")
        except Exception:
            raw = ""
        return exc.code, _parse_json(raw)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        log.warning("network error: %s", type(exc).__name__)
        return 0, None
    return status, _parse_json(raw)


def _parse_json(raw: str) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        d = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return d if isinstance(d, dict) else None


def _stash_pending(body: dict[str, Any]) -> Path | None:
    try:
        PENDING_DIR.mkdir(parents=True, exist_ok=True)
        # Filename is monotonically sortable; the trailing pid keeps two
        # daemons (e.g., during launchd handoff) from clobbering each other.
        fname = f"{int(time.time() * 1000)}-{os.getpid()}.json"
        path = PENDING_DIR / fname
        path.write_text(json.dumps(body), encoding="utf-8")
        return path
    except OSError as exc:
        log.error("stash failed: %s", type(exc).__name__)
        return None


def _drain_pending(api_url: str) -> int:
    if not PENDING_DIR.is_dir():
        return 0
    drained = 0
    for path in sorted(PENDING_DIR.iterdir())[:MAX_PENDING_PER_FLUSH]:
        if not path.is_file() or path.suffix != ".json":
            continue
        try:
            body = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            # Move bad files aside so we don't spin on them forever.
            try:
                path.rename(path.with_suffix(".json.bad"))
            except OSError:
                pass
            continue
        status, _ = _post_snapshot(api_url, body)
        if 200 <= status < 300:
            try:
                path.unlink()
            except OSError:
                pass
            drained += 1
        else:
            break  # next iteration tries again — preserve order
    if drained:
        log.info("pending drained=%d", drained)
    return drained


# ---------- main loop ----------

def _tick(claude_loader, codex_loader, creds, hours_back, consecutive_failures: int) -> int:
    snapshot = build_snapshot(claude_loader, codex_loader, hours_back)
    body = {**creds.auth_params(), **snapshot}

    _drain_pending(creds.api_url)

    backoff_idx = 0
    while True:
        status, resp = _post_snapshot(creds.api_url, body)
        if 200 <= status < 300:
            received = resp.get("received_at") if resp else None
            c_n = len(snapshot["claude"]["sessions"])
            x_n = len(snapshot["codex"]["sessions"])
            log.info(
                "POST 200 received_at=%s claude_sessions=%d codex_sessions=%d",
                received, c_n, x_n,
            )
            return 0
        log.warning("POST failed status=%s attempt=%d", status, backoff_idx + 1)
        if backoff_idx >= len(_BACKOFF_SECONDS) - 1:
            consecutive_failures += 1
            if consecutive_failures >= _FAILURE_THRESHOLD:
                stashed = _stash_pending(body)
                log.error(
                    "POST giving up after %d failures; stashed=%s",
                    consecutive_failures, stashed.name if stashed else "<no-stash>",
                )
                return consecutive_failures
            return consecutive_failures
        sleep_s = _BACKOFF_SECONDS[backoff_idx] + random.uniform(0, 0.5)
        time.sleep(sleep_s)
        backoff_idx += 1


def run(interval: int, hours_back: int, once: bool = False) -> int:
    creds = load_credentials()
    log.info(
        "starting v%s api=%s deviceId=%s authMode=%s interval=%ds hours_back=%d",
        DAEMON_VERSION,
        creds.api_url,
        creds.device_id,
        "deviceSecret" if creds.device_secret else ("botSecret+entityId" if creds.bot_secret else "none"),
        interval,
        hours_back,
    )

    claude_loader = ClaudeLoader()
    codex_loader = CodexLoader()

    stop = {"flag": False}

    def _sig(_n, _f):
        log.info("signal received; exiting after current tick")
        stop["flag"] = True

    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)

    consecutive_failures = 0
    while not stop["flag"]:
        try:
            consecutive_failures = _tick(claude_loader, codex_loader, creds, hours_back, consecutive_failures)
        except Exception:  # noqa: BLE001 — never let the loop die
            log.exception("unhandled error in tick")
        if once:
            break
        # Sleep in small slices so SIGTERM doesn't wait the full interval.
        for _ in range(interval):
            if stop["flag"]:
                break
            time.sleep(1)
    return 0


def _setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
        stream=sys.stdout,
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="EClaw usage daemon (Plan B Phase 2)")
    ap.add_argument("--interval", type=int, default=DEFAULT_INTERVAL, help="Seconds between snapshots (default 60)")
    ap.add_argument("--hours-back", type=int, default=DEFAULT_HOURS_BACK, help="Lookback window for jsonl scanning")
    ap.add_argument("--once", action="store_true", help="Push one snapshot and exit (smoke test)")
    args = ap.parse_args()
    _setup_logging()
    return run(args.interval, args.hours_back, once=args.once)


if __name__ == "__main__":
    sys.exit(main())
