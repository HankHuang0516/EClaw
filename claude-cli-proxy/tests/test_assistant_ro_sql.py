"""The assistant's database login must not be able to read a credential.

sql/assistant_ro.sql defines the only relations that login can read. These tests
pin what the views leave out, the key-name rule of `redact`, and that the chat
prompt describes the views rather than the base tables.
"""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

SQL = (ROOT / "sql" / "assistant_ro.sql").read_text(encoding="utf-8")
PROXY = (ROOT / "proxy.py").read_text(encoding="utf-8")


def strip_comments(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def view_bodies() -> dict:
    body = strip_comments(SQL)
    found = {}
    for match in re.finditer(r"CREATE VIEW assistant_ro\.(\w+) AS\s+(SELECT.*?);", body, re.S):
        found[match.group(1)] = match.group(2)
    return found


VIEWS = view_bodies()

# A column that may appear only as "(<column> IS NOT NULL) AS has_…".
PRESENCE_ONLY = {"fcm_token", "apns_token", "callback_token"}
# Columns that must not be selected at all.
FORBIDDEN = {
    "devices": {"device_secret", "prompt_policy"},
    "entities": {"bot_secret", "parts", "identity", "agent_card"},
    "channel_accounts": {"channel_api_secret", "callback_username", "callback_password"},
    "server_logs": {"ip_address", "user_id"},
    "handshake_failures": {"request_payload", "response_body"},
    "device_telemetry": {"input"},
    "official_bots": {"token", "session_key_template", "bot_secret", "setup_username", "setup_password"},
    "official_bot_bindings": {"session_key"},
}


class ViewsTest(unittest.TestCase):
    def test_every_table_the_prompt_names_has_a_view(self):
        self.assertEqual(
            set(VIEWS),
            {"devices", "entities", "channel_accounts", "server_logs", "handshake_failures",
             "device_telemetry", "scheduled_messages", "official_bots", "official_bot_bindings"},
        )

    def test_no_view_selects_everything(self):
        for name, body in VIEWS.items():
            self.assertNotRegex(body, r"SELECT\s+\*|\.\*", name)

    def test_credential_columns_are_left_out(self):
        for name, columns in FORBIDDEN.items():
            words = set(re.findall(r"[a-z_]+", VIEWS[name]))
            self.assertEqual(words & columns, set(), name)

    def test_tokens_appear_only_as_presence_flags(self):
        for name, body in VIEWS.items():
            for column in PRESENCE_ONLY:
                for match in re.finditer(rf"\b{column}\b", body):
                    after = body[match.end():match.end() + 16]
                    self.assertTrue(after.strip().startswith("IS NOT NULL"), f"{name}.{column}")

    def test_webhook_json_is_never_exposed_whole(self):
        entities = VIEWS["entities"]
        self.assertNotRegex(entities, r"\bwebhook\s*,")
        self.assertNotRegex(entities, r"'(token|sessionKey|setupUsername|setupPassword)'")
        self.assertNotRegex(entities, r"\bmessage_queue\s*,")

    def test_channel_api_key_is_masked(self):
        self.assertIn("left(channel_api_key, 12) || '…' || right(channel_api_key, 6) AS channel_api_key",
                      VIEWS["channel_accounts"])
        self.assertNotRegex(VIEWS["channel_accounts"], r",\s*channel_api_key\s*,")

    def test_json_columns_go_through_redact(self):
        self.assertIn("assistant_ro.redact(metadata) AS metadata", VIEWS["server_logs"])
        self.assertIn("assistant_ro.redact(output) AS output", VIEWS["device_telemetry"])
        self.assertIn("assistant_ro.redact(meta)   AS meta", VIEWS["device_telemetry"])


class RedactRuleTest(unittest.TestCase):
    def setUp(self):
        match = re.search(r"WHERE key !~\* '([^']+)'", SQL)
        self.assertIsNotNone(match)
        self.rule = re.compile(match.group(1), re.I)

    def test_drops_credential_keys(self):
        for key in ("deviceSecret", "botSecret", "password", "fcmToken", "token", "channel_api_key",
                    "apiKey", "session_key", "sessionKey", "Authorization", "cookie", "callback_token"):
            self.assertIsNotNone(self.rule.search(key), key)

    def test_keeps_diagnostic_keys(self):
        for key in ("tokenPrefix", "path", "reason", "webhookUrl", "status", "channelAccountId",
                    "stack_trace", "message", "secretCount"):
            self.assertIsNone(self.rule.search(key), key)


class PrivilegesTest(unittest.TestCase):
    def test_role_is_a_plain_login_with_read_only_defaults(self):
        self.assertIn("CREATE ROLE eclaw_assistant_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT", SQL)
        self.assertIn("SET default_transaction_read_only = on", SQL)
        self.assertIn("SET search_path = assistant_ro", SQL)

    def test_only_the_view_schema_is_granted(self):
        grants = re.findall(r"^GRANT .*$", strip_comments(SQL), re.M)
        self.assertEqual(sorted(grants), sorted([
            "GRANT USAGE ON SCHEMA assistant_ro TO eclaw_assistant_ro;",
            "GRANT SELECT ON ALL TABLES IN SCHEMA assistant_ro TO eclaw_assistant_ro;",
            "GRANT EXECUTE ON FUNCTION assistant_ro.redact(jsonb) TO eclaw_assistant_ro;",
        ]))

    def test_no_password_is_stored_in_the_file(self):
        self.assertNotRegex(strip_comments(SQL), r"(?i)\bPASSWORD\s+'")


class PromptTest(unittest.TestCase):
    def setUp(self):
        start = PROXY.index("DATABASE ACCESS (read-only):")
        self.block = PROXY[start:PROXY.index("CRASH INVESTIGATION:", start)]

    def test_prompt_lists_view_columns_not_secrets(self):
        for word in ("channel_api_secret", "device_secret", "callback_token", "session_key", "webhook JSONB", "input JSONB"):
            self.assertNotIn(word, self.block)
        self.assertIn("has_webhook, webhook_url", self.block)
        self.assertIn("sanitized views", self.block)

    def test_every_column_the_prompt_names_exists_in_its_view(self):
        for table, columns in re.findall(r"^\s+\* (\w+) \(([^)]*)\)", self.block, re.M):
            body = VIEWS[table]
            for column in columns.split(","):
                name = column.strip().split(" ")[0]
                self.assertRegex(body, rf"\b{name}\b", f"{table}.{name}")


if __name__ == "__main__":
    unittest.main()
