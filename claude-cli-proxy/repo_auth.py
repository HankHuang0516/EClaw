"""GitHub repository auth helpers for claude-cli-proxy.

This module is dependency-free so its scope and token-selection rules can be
unit-tested without importing the FastAPI proxy app.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Callable, Mapping, Optional, Sequence


DEFAULT_REPO_HOST_PATH = "github.com/HankHuang0516/realbot.git"
LEGACY_TOKEN_KEYS = ("GIT_HUB2", "GITHUBTOKEN", "GIT")


class RepoScopeError(ValueError):
    """Raised when a configured repo is outside the allowed org scope."""


class RepoAuthError(RuntimeError):
    """Raised when per-request auth resolution fails (vault miss, no creds, etc)."""


@dataclass(frozen=True)
class RepoScope:
    host: str
    org: str
    repo: str
    host_path: str
    url: str


@dataclass(frozen=True)
class ResolvedRepoAuth:
    """Outcome of resolving auth for one request — token + source provenance.

    `source` is one of: 'vault:<key>', 'env', 'anonymous'. `caller_id` is an
    opaque tenant identifier safe to use as a clone-cache key (never raw creds).
    """
    scope: RepoScope
    url: str
    token: Optional[str]
    source: str
    caller_id: str


def env_bool(value: Optional[str], default: bool = False) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def normalize_org_key(org: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9]+", "_", org.strip()).strip("_").upper()
    return normalized or "DEFAULT"


def parse_github_host_path(raw_host_path: str) -> RepoScope:
    value = (raw_host_path or "").strip()
    value = re.sub(r"^https?://", "", value)
    value = value.strip("/")
    match = re.match(r"^(github\.com)/([^/\s]+)/([^/\s]+?)(?:\.git)?$", value, re.I)
    if not match:
        raise RepoScopeError("REPO_GIT_HOST_PATH must look like github.com/<org>/<repo>.git")
    host, org, repo = match.groups()
    host = host.lower()
    host_path = f"{host}/{org}/{repo}.git"
    return RepoScope(host=host, org=org, repo=repo, host_path=host_path, url=f"https://{host_path}")


def allowed_orgs_from_env(value: str, default_org: str) -> set[str]:
    configured = _csv(value or "")
    orgs = configured or [default_org]
    return {org.lower() for org in orgs}


def validate_repo_scope(raw_host_path: str, allowed_orgs: str = "") -> RepoScope:
    scope = parse_github_host_path(raw_host_path)
    allowed = allowed_orgs_from_env(allowed_orgs, scope.org)
    if scope.org.lower() not in allowed:
        allowed_display = ", ".join(sorted(allowed))
        raise RepoScopeError(f"repo org '{scope.org}' is outside REPO_ALLOWED_ORGS ({allowed_display})")
    return scope


def token_key_candidates(org: str, explicit_key: str = "", allow_global: bool = True) -> tuple[str, ...]:
    keys: list[str] = []
    if explicit_key.strip():
        keys.append(explicit_key.strip())

    org_key = normalize_org_key(org)
    keys.extend((
        f"GIT_HUB2_{org_key}",
        f"GITHUB_TOKEN_{org_key}",
        f"GITHUBTOKEN_{org_key}",
        f"GIT_{org_key}",
    ))
    if allow_global:
        keys.extend(LEGACY_TOKEN_KEYS)

    deduped: list[str] = []
    for key in keys:
        if key not in deduped:
            deduped.append(key)
    return tuple(deduped)


def token_from_vars(vars_map: Mapping[str, object], keys: Sequence[str]) -> tuple[Optional[str], Optional[str]]:
    for key in keys:
        value = vars_map.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip(), key
    return None, None


def build_git_auth_env(
    base_env: Mapping[str, str],
    token: Optional[str],
    askpass_path: str,
    expose_cli_token: bool = False,
) -> dict[str, str]:
    env = dict(base_env)
    env["GIT_TERMINAL_PROMPT"] = "0"
    if not token:
        return env

    env.update({
        "GIT_ASKPASS": askpass_path,
        "GIT_ASKPASS_USERNAME": "x-access-token",
        "GIT_ASKPASS_PASSWORD": token,
    })
    if expose_cli_token:
        env["GH_TOKEN"] = token
        env["GITHUB_TOKEN"] = token
    return env


def caller_id_for(device_id: Optional[str], host_path: str) -> str:
    """Stable, opaque tenant key for clone-cache lookups.

    SHA-256 over (deviceId, host_path) so caller secrets never leak into paths
    or logs. Empty deviceId → 'anonymous-<hostpath-hash>' so env-mode boots
    still get a single cache entry without colliding with real tenants.
    """
    if not device_id:
        digest = hashlib.sha256(host_path.encode("utf-8")).hexdigest()[:16]
        return f"anonymous-{digest}"
    payload = f"{device_id}|{host_path}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:16]


# Type alias for the vault-fetch callback so resolve_per_request_auth stays
# dependency-free (the real fetcher lives in proxy.py with urllib).
# The callback receives (device_id, bot_secret, org, keys) when entity_id is
# absent (legacy vault path), or (device_id, bot_secret, entity_id, org, keys)
# when entity_id is set (org-token path with grant-check).
VaultFetcher = Callable[..., "tuple[Optional[str], Optional[str]]"]


def resolve_per_request_auth(
    *,
    repo_host_path: str,
    allowed_orgs: str,
    caller_device_id: Optional[str],
    caller_bot_secret: Optional[str],
    caller_entity_id: Optional[int],
    vault_key: str,
    allow_global_vault: bool,
    require_auth: bool,
    env_token: Optional[str],
    vault_fetcher: Optional[VaultFetcher],
) -> ResolvedRepoAuth:
    """Resolve auth for a single request without touching module globals.

    Resolution order when caller_entity_id is set:
      1. Per-org org-token endpoint — caller_entity_id + deviceId/botSecret +
         org → grant-check + scoped GitHub App installation token
      2. Env token — legacy GITHUB_TOKEN fallback

    Resolution order when caller_entity_id is absent (legacy path):
      1. Per-request vault — caller's deviceId/botSecret + their vault_key
      2. Env token — legacy GITHUB_TOKEN fallback
      3. Anonymous — only if require_auth is False

    Raises RepoScopeError on out-of-scope repo, RepoAuthError when require_auth
    is set and no token can be sourced.
    """
    scope = validate_repo_scope(repo_host_path, allowed_orgs)
    caller_id = caller_id_for(caller_device_id, scope.host_path)

    # When caller_entity_id is set, use the per-org org-token endpoint which
    # performs a grant-check against entity_org_grants.  Falls back to env_token.
    if caller_entity_id and caller_device_id and caller_bot_secret and vault_fetcher is not None:
        token, used_key = vault_fetcher(
            caller_device_id, caller_bot_secret, caller_entity_id, scope.org, (),
        )
        if token:
            return ResolvedRepoAuth(
                scope=scope, url=scope.url, token=token,
                source=f"org-token:{used_key or 'hermes'}",
                caller_id=caller_id,
            )

    # Legacy path: per-request vault (deviceId+botSecret → vault key lookup).
    if caller_device_id and caller_bot_secret and vault_fetcher is not None:
        keys = token_key_candidates(scope.org, explicit_key=vault_key, allow_global=allow_global_vault)
        token, used_key = vault_fetcher(caller_device_id, caller_bot_secret, scope.org, keys)
        if token:
            return ResolvedRepoAuth(
                scope=scope, url=scope.url, token=token,
                source=f"vault:{used_key}", caller_id=caller_id,
            )

    if env_token:
        return ResolvedRepoAuth(
            scope=scope, url=scope.url, token=env_token,
            source="env", caller_id=caller_id,
        )

    if require_auth:
        raise RepoAuthError(
            f"repo auth required for {scope.org}/{scope.repo}, "
            "but no caller vault token and no env fallback"
        )

    return ResolvedRepoAuth(
        scope=scope, url=scope.url, token=None,
        source="anonymous", caller_id=caller_id,
    )
