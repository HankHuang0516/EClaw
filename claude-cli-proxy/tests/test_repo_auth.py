import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from repo_auth import (
    RepoScopeError,
    parse_github_host_path,
    token_from_vars,
    token_key_candidates,
    validate_repo_scope,
)


class RepoAuthTests(unittest.TestCase):
    def test_parse_github_host_path_normalizes_https_url(self):
        scope = parse_github_host_path("https://github.com/HankHuang0516/EClaw")
        self.assertEqual(scope.host_path, "github.com/HankHuang0516/EClaw.git")
        self.assertEqual(scope.url, "https://github.com/HankHuang0516/EClaw.git")
        self.assertEqual(scope.org, "HankHuang0516")

    def test_validate_repo_scope_rejects_unassigned_org(self):
        with self.assertRaises(RepoScopeError):
            validate_repo_scope("github.com/OtherOrg/private.git", "HankHuang0516")

    def test_token_candidates_prefer_org_scoped_keys(self):
        keys = token_key_candidates("Hank-Huang 0516")
        self.assertEqual(keys[:4], (
            "GIT_HUB2_HANK_HUANG_0516",
            "GITHUB_TOKEN_HANK_HUANG_0516",
            "GITHUBTOKEN_HANK_HUANG_0516",
            "GIT_HANK_HUANG_0516",
        ))
        self.assertIn("GIT_HUB2", keys)

    def test_token_candidates_can_disable_global_fallback(self):
        keys = token_key_candidates("HankHuang0516", allow_global=False)
        self.assertNotIn("GIT_HUB2", keys)
        self.assertIn("GIT_HUB2_HANKHUANG0516", keys)

    def test_token_from_vars_returns_first_scoped_key(self):
        keys = token_key_candidates("HankHuang0516")
        token, key = token_from_vars(
            {
                "GIT_HUB2": "legacy",
                "GIT_HUB2_HANKHUANG0516": "scoped",
            },
            keys,
        )
        self.assertEqual((token, key), ("scoped", "GIT_HUB2_HANKHUANG0516"))


if __name__ == "__main__":
    unittest.main()
