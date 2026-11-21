"""Is the database the assistant can read the one the backend writes to?

The chat assistant answers "does my key / entity / log exist in the backend?" by
running db_query.py against DATABASE_URL. When that URL points at a database the
backend has stopped writing to, every lookup for a recent device comes back empty
and the assistant reports the emptiness as fact. That happened in feedback #1547:
the proxy was still reading a pre-migration database that had been frozen for
months, and told a user that the channel keys they had just made did not exist.

A live database gets `server_logs` rows all day, so the age of its newest row
tells a live database from a frozen copy. When the copy is stale the prompt
withdraws database access instead of offering lookups that cannot be right.
"""
import os
import threading
import time
from typing import Callable, Optional

LIVE = "live"
STALE = "stale"
UNKNOWN = "unknown"  # no database configured, or the check itself failed

DEFAULT_MAX_AGE_HOURS = 24.0
DEFAULT_CACHE_SECONDS = 600.0
AGE_SQL = "SELECT EXTRACT(EPOCH FROM (now() - max(created_at))) FROM server_logs"


def max_age_hours_from_env() -> float:
    try:
        value = float(os.environ.get("DB_FRESH_MAX_AGE_HOURS", ""))
    except ValueError:
        return DEFAULT_MAX_AGE_HOURS
    return value if value > 0 else DEFAULT_MAX_AGE_HOURS


def classify(age_seconds: Optional[float], max_age_hours: float = DEFAULT_MAX_AGE_HOURS) -> str:
    """An empty server_logs table (age None) is as unusable as an old one."""
    if age_seconds is None:
        return STALE
    return STALE if age_seconds > max_age_hours * 3600 else LIVE


def fetch_newest_log_age(database_url: str) -> Optional[float]:
    """Seconds since the newest server_logs row; None when the table is empty."""
    import psycopg2  # imported here so the pure functions test without a driver

    conn = psycopg2.connect(database_url, connect_timeout=5)
    try:
        with conn.cursor() as cur:
            cur.execute(AGE_SQL)
            row = cur.fetchone()
        return None if not row or row[0] is None else float(row[0])
    finally:
        conn.close()


class FreshnessCheck:
    """Caches the check so a chat request never waits on it more than once per window."""

    def __init__(
        self,
        database_url: str,
        fetch_age: Callable[[str], Optional[float]] = fetch_newest_log_age,
        max_age_hours: Optional[float] = None,
        cache_seconds: float = DEFAULT_CACHE_SECONDS,
        clock: Callable[[], float] = time.time,
    ):
        self._database_url = database_url
        self._fetch_age = fetch_age
        self._max_age_hours = max_age_hours if max_age_hours is not None else max_age_hours_from_env()
        self._cache_seconds = cache_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._status = {"state": UNKNOWN, "ageHours": None, "checkedAt": None, "error": None}

    def cached(self) -> dict:
        """The last result, without touching the database."""
        return dict(self._status)

    def status(self) -> dict:
        """The current result, re-checking when the cached one has expired. Blocking."""
        if not self._database_url:
            return self.cached()
        with self._lock:
            checked_at = self._status["checkedAt"]
            if checked_at is not None and self._clock() - checked_at < self._cache_seconds:
                return dict(self._status)
            try:
                age = self._fetch_age(self._database_url)
                self._status = {
                    "state": classify(age, self._max_age_hours),
                    "ageHours": None if age is None else round(age / 3600, 1),
                    "checkedAt": self._clock(),
                    "error": None,
                }
            except Exception as exc:  # a failed check must never take the chat down
                self._status = {
                    "state": UNKNOWN,
                    "ageHours": None,
                    "checkedAt": self._clock(),
                    "error": type(exc).__name__,
                }
            return dict(self._status)


def stale_prompt_block(status: dict) -> str:
    """What the assistant is told in place of the database instructions."""
    age_hours = status.get("ageHours")
    if age_hours is None:
        since = "it holds no server logs at all"
    else:
        since = f"its newest server log is about {max(1, round(age_hours / 24))} day(s) old"
    return f"""
DATABASE ACCESS: unavailable.
- The only database you could read is a stale copy ({since}). It does not contain recent devices, API keys, entities or logs.
- Do NOT run db_query.py, and do NOT state that something does or does not exist in the backend or database.
- If the user's question needs backend state, say you could not check it. In a GitHub issue, write "backend state not verified"."""
