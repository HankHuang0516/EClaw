"""Per-request multi-tenant auth resolution (H3).

These tests pin the contract that different callers get different tokens
and different cache keys — the proxy must never share a GitHub PAT between
device-owners just because they hit the same instance.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from repo_auth import (
    RepoAuthError,
    RepoScopeError,
    ResolvedRepoAuth,
    caller_id_for,
    resolve_per_request_auth,
)


def _make_fetcher(vault_per_device: dict):
    """Build a fake vault fetcher that returns each device's token from a map.

    vault_per_device: { deviceId: { keyName: token } }
    Records every call so tests can assert nothing crosses tenants.
    """
    calls: list = []

    def fetcher(device_id, bot_secret, org, keys):
        calls.append({"device_id": device_id, "bot_secret": bot_secret, "org": org, "keys": list(keys)})
        device_vars = vault_per_device.get(device_id, {})
        for key in keys:
            if key in device_vars:
                return device_vars[key], key
        return None, None

    fetcher.calls = calls  # type: ignore[attr-defined]
    return fetcher


class CallerIdTests(unittest.TestCase):
    def test_different_devices_get_different_caller_ids(self):
        a = caller_id_for("device-A", "github.com/HankHuang0516/realbot.git")
        b = caller_id_for("device-B", "github.com/HankHuang0516/realbot.git")
        self.assertNotEqual(a, b, "two devices must hash to different caller_ids")

    def test_same_device_different_repos_get_different_ids(self):
        a = caller_id_for("device-A", "github.com/HankHuang0516/realbot.git")
        b = caller_id_for("device-A", "github.com/HankHuang0516/EClaw.git")
        self.assertNotEqual(a, b, "same device on different repos must stay isolated")

    def test_anonymous_device_is_stable_per_repo(self):
        a = caller_id_for(None, "github.com/HankHuang0516/realbot.git")
        b = caller_id_for("", "github.com/HankHuang0516/realbot.git")
        self.assertEqual(a, b, "empty/None deviceId should map to a single anonymous slot per repo")
        self.assertTrue(a.startswith("anonymous-"))

    def test_caller_id_never_contains_raw_secret(self):
        secret = "super-secret-device-id-12345"
        cid = caller_id_for(secret, "github.com/HankHuang0516/realbot.git")
        self.assertNotIn(secret, cid)


class MultiTenantResolveTests(unittest.TestCase):
    HOST_PATH = "github.com/HankHuang0516/realbot.git"
    ALLOWED = "HankHuang0516"

    def test_two_devices_get_their_own_tokens(self):
        fetcher = _make_fetcher({
            "device-hank": {"GIT_HUB2_HANKHUANG0516": "hank-pat-AAA"},
            "device-alice": {"GIT_HUB2_HANKHUANG0516": "alice-pat-BBB"},
        })
        hank = resolve_per_request_auth(
            repo_host_path=self.HOST_PATH, allowed_orgs=self.ALLOWED,
            caller_device_id="device-hank", caller_bot_secret="s1",
            caller_entity_id=None,
            vault_key="", allow_global_vault=True, require_auth=False,
            env_token=None, vault_fetcher=fetcher,
        )
        alice = resolve_per_request_auth(
            repo_host_path=self.HOST_PATH, allowed_orgs=self.ALLOWED,
            caller_device_id="device-alice", caller_bot_secret="s2",
            caller_entity_id=None,
            vault_key="", allow_global_vault=True, require_auth=False,
            env_token=None, vault_fetcher=fetcher,
        )
        self.assertEqual(hank.token, "hank-pat-AAA")
        self.assertEqual(alice.token, "alice-pat-BBB")
        self.assertNotEqual(hank.caller_id, alice.caller_id)
        self.assertEqual(hank.source, "vault:GIT_HUB2_HANKHUANG0516")
        self.assertEqual(alice.source, "vault:GIT_HUB2_HANKHUANG0516")

    def test_vault_fetcher_receives_caller_creds_not_module_globals(self):
        fetcher = _make_fetcher({"device-hank": {"GIT_HUB2_HANKHUANG0516": "tok"}})
        resolve_per_request_auth(
            repo_host_path=self.HOST_PATH, allowed_orgs=self.ALLOWED,
            caller_device_id="device-hank", caller_bot_secret="caller-secret",
            caller_entity_id=None,
            vault_key="", allow_global_vault=True, require_auth=False,
            env_token=None, vault_fetcher=fetcher,
        )
        self.assertEqual(len(fetcher.calls), 1)  # type: ignore[attr-defined]
        self.assertEqual(fetcher.calls[0]["device_id"], "device-hank")  # type: ignore[attr-defined]
        self.assertEqual(fetcher.calls[0]["bot_secret"], "caller-secret")  # type: ignore[attr-defined]

    def test_explicit_vault_key_is_preferred_over_org_scoped(self):
        fetcher = _make_fetcher({
            "device-hank": {
                "MY_CUSTOM_PAT": "custom-tok",
                "GIT_HUB2_HANKHUANG0516": "scoped-tok",
            },
        })
        resolved = resolve_per_request_auth(
            repo_host_path=self.HOST_PATH, allowed_orgs=self.ALLOWED,
            caller_device_id="device-hank", caller_bot_secret="s",
            caller_entity_id=None,
            vault_key="MY_CUSTOM_PAT", allow_global_vault=True, require_auth=False,
            env_token=None, vault_fetcher=fetcher,
        )
        self.assertEqual(resolved.token, "custom-tok")
        self.assertEqual(resolved.source, "vault:MY_CUSTOM_PAT")

    def test_env_token_fallback_when_no_caller_creds(self):
        resolved = resolve_per_request_auth(
            repo_host_path=self.HOST_PATH, allowed_orgs=self.ALLOWED,
            caller_device_id=None, caller_bot_secret=None,
            caller_entity_id=None,
            vault_key="", allow_global_vault=True, require_auth=False,
            env_token="env-pat-XYZ", vault_fetcher=None,
        )
        self.assertEqual(resolved.token, "env-pat-XYZ")
        self.assertEqual(resolved.source, "env")

    def test_per_request_vault_overrides_env_token(self):
        fetcher = _make_fetcher({"device-hank": {"GIT_HUB2_HANKHUANG0516": "vault-tok"}})
        resolved = resolve_per_request_auth(
            repo_host_path=self.HOST_PATH, allowed_orgs=self.ALLOWED,
            caller_device_id="device-hank", caller_bot_secret="s",
            caller_entity_id=None,
            vault_key="", allow_global_vault=True, require_auth=False,
            env_token="env-pat-XYZ", vault_fetcher=fetcher,
        )
        self.assertEqual(resolved.token, "vault-tok",
                         "caller's per-request vault token must beat env fallback")

    def test_entity_scoped_org_token_uses_entity_id_and_org(self):
        calls: list = []

        def fetcher(device_id, bot_secret, entity_id, org, keys):
            calls.append({
                "device_id": device_id,
                "bot_secret": bot_secret,
                "entity_id": entity_id,
                "org": org,
                "keys": tuple(keys),
            })
            return "installation-token", "installation"

        resolved = resolve_per_request_auth(
            repo_host_path=self.HOST_PATH, allowed_orgs=self.ALLOWED,
            caller_device_id="device-hank", caller_bot_secret="s",
            caller_entity_id=6,
            vault_key="", allow_global_vault=True, require_auth=False,
            env_token="env-pat-XYZ", vault_fetcher=fetcher,
        )

        self.assertEqual(resolved.token, "installation-token")
        self.assertEqual(resolved.source, "org-token:installation")
        self.assertEqual(calls, [{
            "device_id": "device-hank",
            "bot_secret": "s",
            "entity_id": 6,
            "org": "HankHuang0516",
            "keys": (),
        }])

    def test_entity_scoped_org_token_denial_does_not_fallback_to_env(self):
        calls: list = []

        def fetcher(*args):
            calls.append(args)
            return None, None

        resolved = resolve_per_request_auth(
            repo_host_path=self.HOST_PATH, allowed_orgs=self.ALLOWED,
            caller_device_id="device-hank", caller_bot_secret="s",
            caller_entity_id=6,
            vault_key="", allow_global_vault=True, require_auth=False,
            env_token="env-pat-XYZ", vault_fetcher=fetcher,
        )

        self.assertIsNone(resolved.token)
        self.assertEqual(resolved.source, "anonymous")
        self.assertEqual(len(calls), 1)

    def test_entity_scoped_org_token_denial_raises_when_auth_required(self):
        def fetcher(*args):
            return None, None

        with self.assertRaises(RepoAuthError):
            resolve_per_request_auth(
                repo_host_path=self.HOST_PATH, allowed_orgs=self.ALLOWED,
                caller_device_id="device-hank", caller_bot_secret="s",
                caller_entity_id=6,
                vault_key="", allow_global_vault=True, require_auth=True,
                env_token="env-pat-XYZ", vault_fetcher=fetcher,
            )

    def test_anonymous_when_no_token_and_auth_not_required(self):
        resolved = resolve_per_request_auth(
            repo_host_path=self.HOST_PATH, allowed_orgs=self.ALLOWED,
            caller_device_id=None, caller_bot_secret=None,
            caller_entity_id=None,
            vault_key="", allow_global_vault=True, require_auth=False,
            env_token=None, vault_fetcher=None,
        )
        self.assertIsNone(resolved.token)
        self.assertEqual(resolved.source, "anonymous")

    def test_raises_when_require_auth_and_no_token(self):
        with self.assertRaises(RepoAuthError):
            resolve_per_request_auth(
                repo_host_path=self.HOST_PATH, allowed_orgs=self.ALLOWED,
                caller_device_id=None, caller_bot_secret=None,
                caller_entity_id=None,
                vault_key="", allow_global_vault=True, require_auth=True,
                env_token=None, vault_fetcher=None,
            )

    def test_repo_scope_validation_still_enforced(self):
        fetcher = _make_fetcher({"device-mallory": {"GIT_HUB2_EVILORG": "stolen-tok"}})
        with self.assertRaises(RepoScopeError):
            resolve_per_request_auth(
                repo_host_path="github.com/EvilOrg/private.git",
                allowed_orgs="HankHuang0516",
                caller_device_id="device-mallory", caller_bot_secret="s",
                caller_entity_id=None,
                vault_key="", allow_global_vault=True, require_auth=False,
                env_token=None, vault_fetcher=fetcher,
            )
        self.assertEqual(len(fetcher.calls), 0,  # type: ignore[attr-defined]
                         "scope check must reject before any vault fetch")

    def test_two_devices_isolated_when_one_has_no_vault_token(self):
        fetcher = _make_fetcher({"device-hank": {"GIT_HUB2_HANKHUANG0516": "hank-tok"}})
        hank = resolve_per_request_auth(
            repo_host_path=self.HOST_PATH, allowed_orgs=self.ALLOWED,
            caller_device_id="device-hank", caller_bot_secret="s1",
            caller_entity_id=None,
            vault_key="", allow_global_vault=True, require_auth=False,
            env_token=None, vault_fetcher=fetcher,
        )
        alice = resolve_per_request_auth(
            repo_host_path=self.HOST_PATH, allowed_orgs=self.ALLOWED,
            caller_device_id="device-alice", caller_bot_secret="s2",
            caller_entity_id=None,
            vault_key="", allow_global_vault=True, require_auth=False,
            env_token=None, vault_fetcher=fetcher,
        )
        self.assertEqual(hank.token, "hank-tok")
        self.assertIsNone(alice.token, "alice without a vault entry must NOT inherit hank's token")
        self.assertEqual(alice.source, "anonymous")


if __name__ == "__main__":
    unittest.main()
