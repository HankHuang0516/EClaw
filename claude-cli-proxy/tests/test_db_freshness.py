"""The assistant must not answer from a database the backend stopped writing to.

Regression for feedback #1547: the proxy's DATABASE_URL still pointed at a
pre-migration database, so the assistant reported "0 rows in channel_accounts"
for a device whose keys were in the live database.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from db_freshness import (  # noqa: E402
    LIVE,
    STALE,
    UNKNOWN,
    FreshnessCheck,
    classify,
    stale_prompt_block,
)

HOUR = 3600.0


class ClassifyTest(unittest.TestCase):
    def test_recent_log_is_live(self):
        self.assertEqual(classify(5 * 60), LIVE)

    def test_log_older_than_the_limit_is_stale(self):
        self.assertEqual(classify(25 * HOUR), STALE)
        self.assertEqual(classify(23 * HOUR), LIVE)

    def test_a_database_frozen_for_months_is_stale(self):
        self.assertEqual(classify(212 * 24 * HOUR), STALE)

    def test_empty_log_table_is_stale(self):
        self.assertEqual(classify(None), STALE)

    def test_limit_is_configurable(self):
        self.assertEqual(classify(30 * HOUR, max_age_hours=48), LIVE)


class FreshnessCheckTest(unittest.TestCase):
    def _check(self, ages, **kwargs):
        calls = []
        now = [1000.0]

        def fetch(url):
            calls.append(url)
            value = ages[min(len(calls) - 1, len(ages) - 1)]
            if isinstance(value, Exception):
                raise value
            return value

        check = FreshnessCheck("postgresql://example", fetch_age=fetch, max_age_hours=24,
                               cache_seconds=600, clock=lambda: now[0], **kwargs)
        return check, calls, now

    def test_reports_stale_with_the_age(self):
        check, _, _ = self._check([212 * 24 * HOUR])
        status = check.status()
        self.assertEqual(status["state"], STALE)
        self.assertEqual(status["ageHours"], 212 * 24)

    def test_result_is_cached_for_the_window(self):
        check, calls, now = self._check([60.0, 90 * HOUR])
        self.assertEqual(check.status()["state"], LIVE)
        now[0] += 599
        self.assertEqual(check.status()["state"], LIVE)
        self.assertEqual(len(calls), 1)
        now[0] += 2
        self.assertEqual(check.status()["state"], STALE)
        self.assertEqual(len(calls), 2)

    def test_a_failed_check_is_unknown_and_names_only_the_error_type(self):
        check, _, _ = self._check([RuntimeError("password=hunter2 rejected")])
        status = check.status()
        self.assertEqual(status["state"], UNKNOWN)
        self.assertEqual(status["error"], "RuntimeError")
        self.assertNotIn("hunter2", repr(status))

    def test_no_database_never_queries(self):
        calls = []
        check = FreshnessCheck("", fetch_age=lambda url: calls.append(url))
        self.assertEqual(check.status()["state"], UNKNOWN)
        self.assertEqual(calls, [])

    def test_cached_does_not_query(self):
        check, calls, _ = self._check([60.0])
        self.assertEqual(check.cached()["state"], UNKNOWN)
        self.assertEqual(calls, [])


class StalePromptBlockTest(unittest.TestCase):
    def test_tells_the_assistant_not_to_query_or_assert(self):
        block = stale_prompt_block({"state": STALE, "ageHours": 212 * 24})
        self.assertIn("DATABASE ACCESS: unavailable", block)
        self.assertIn("212 day(s) old", block)
        self.assertIn("Do NOT run db_query.py", block)
        self.assertIn("backend state not verified", block)
        self.assertNotIn("python ", block)

    def test_empty_table_wording(self):
        self.assertIn("no server logs at all", stale_prompt_block({"state": STALE, "ageHours": None}))


class ChatPromptWiringTest(unittest.TestCase):
    """proxy.py needs FastAPI, so the wiring is pinned from its source."""

    def setUp(self):
        self.source = (Path(__file__).resolve().parents[1] / "proxy.py").read_text(encoding="utf-8")

    def test_stale_database_withdraws_the_query_instructions(self):
        self.assertIn('db_status["state"] == STALE', self.source)
        self.assertIn("stale_prompt_block(db_status)", self.source)

    def test_chat_refreshes_the_check_off_the_event_loop(self):
        self.assertIn("run_in_executor(None, DB_FRESHNESS.status)", self.source)

    def test_prompt_states_that_channel_auth_is_key_only(self):
        self.assertIn("API key only", self.source)
        self.assertIn("An empty result is not proof", self.source)


if __name__ == "__main__":
    unittest.main()
