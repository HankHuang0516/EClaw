"""GitHub repository auth helpers for claude-cli-proxy.

This module is dependency-free so its scope and token-selection rules can be
unit-tested without importing the FastAPI proxy app.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Mapping, Optional, Sequence


DEFAULT_REPO_HOST_PATH = "github.com/HankHuang0516/realbot.git"
LEGACY_TOKEN_KEYS = ("GIT_HUB2", "GITHUBTOKEN", "GIT")


class RepoScopeError(ValueError):
    """Raised when a configured repo is outside the allowed org scope."""


@dataclass(frozen=True)
class RepoScope:
    host: str
    org: str
    repo: str
    host_path: str
    url: str


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
