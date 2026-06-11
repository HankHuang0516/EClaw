# Hermes Per-Org Credential Scope — Spec (H3 t2)

> Card: `card_1242aaa56221c42a1fe5ef87` ([Hermes/P2] H3 t2)
> Roadmap: 🤖 Hermes Channel — H3 Private Repo Support (roadmap.html L682)
> Status: DRAFT — pending #6 sign-off
> Author: #2 LOBSTER, 2026-06-12. Facts below verified against
> `HankHuang0516/hermes-eclaw-channel@main` (2026-06-11 22:25 TW code read;
> Hermes consult unanswered 3×, self-answered per card comment).

## Problem

Hermes (claude-cli-proxy / hermes-eclaw-channel daemon) authenticates every
git operation with ONE master PAT read from env (`HERMES_GH_PAT`). Any entity
that can route a file-edit task to Hermes gets the PAT's full repo reach.
Target: per-org scoped tokens + deny-by-default cross-org access.

## Current state (verified)

| Fact | Where |
|---|---|
| Single PAT, read per file-edit task (NOT cached at boot) | `daemon/hermes_worker.py` `_github_pat()` called at L325 inside clone-and-PR flow |
| Clone target hardcoded to one repo | `HERMES_PR_REPO_URL` env, default `HankHuang0516/EClaw.git` (L67), used at L344 |
| Token injected via env + askpass shim | `_pr_env()` L311 sets `HERMES_GH_PAT`/`GH_TOKEN`/`GITHUB_TOKEN` |
| Webhook body has NO entity_id contract | `daemon/hermes_daemon.py` `/chat` accepts free-form JSON (L153) |
| No GitHub App logic anywhere in daemon | grep 0 hits |

Implication: **full scope** — both EClaw-side and proxy-side work needed.
The per-task credential read is good news: swapping in a per-op token fetch
is a single-point change at `_github_pat()`.

## Design

### 1. EClaw backend (new)

**Migration** `entity_org_grants`:

```sql
CREATE TABLE entity_org_grants (
  id SERIAL PRIMARY KEY,
  device_id TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  org_login TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by TEXT,                       -- audit: who/what created the grant
  UNIQUE (device_id, entity_id, org_login)
);
```

`device_id` included (board is device-wide but grants must not leak across
devices — multi-tenant rule).

**Route** `GET /api/hermes/org-token?orgLogin=X&entityId=N`

- Auth: `deviceId` + the calling entity's `botSecret` (same plane as
  `/api/chat/history`; the proxy already holds its entity botSecret for
  channel traffic). NOT deviceSecret — proxy must not hold owner creds.
- Flow: validate botSecret → look up `(device_id, entity_id, org_login)` in
  `entity_org_grants` → miss ⇒ `403 {error:"org_not_granted"}` + row in
  audit log → hit ⇒ mint **GitHub App installation token** scoped to that
  org's installation and return `{token, expiresAt}` (1h GitHub TTL).
- The master PAT (`GIT_HUB2`) is never returned by this route.

**GitHub App dependency (verify before implementation):** card says
"Hank already has HankHuang0516 connected — extend pattern". Implementer
must confirm the App private key + app_id are already in vault/env
(no-new-keys rule: if a NEW App key would be required, STOP and surface to
Hank instead of creating one).

### 2. Proxy side (hermes-eclaw-channel)

- `_github_pat()` → `_org_token(org_login)`: resolve org from the repo URL
  about to be cloned/pushed; `GET /api/hermes/org-token`; on 403, abort the
  task with `#hermes_BLOCKED reason=org_not_granted` (no clone attempted).
- Allow-list enforcement point: repo-URL resolution just before L344 clone
  and inside `_pr_env()` — the only two places credentials meet a remote.
  Git credential helper unchanged.
- Audit log line (JSON, aligns with H2 t6 Part A):
  `{event:"org_token_denied", device_id, entity_id, org_login, ts}` —
  `device_id` required because `entity_id` is only unique within a device.
- Hermes-side wiring (per #6 review, PR #3301): the dispatch path is
  `plugin/eclaw_bridge.py` → `daemon/hermes_daemon.py` /chat — NOT the
  EClaw-repo bridge.ts. The daemon's token fetch authenticates with the
  full trust tuple `deviceId + entityId + botSecret`, read from the
  daemon's shared env (same source as its channel credentials) or threaded
  through the /chat request body; a bare `entity_id` is never sufficient.

### 3. Tests

- EClaw Jest: route 200 (granted) / 403 (not granted) / 401 (bad botSecret);
  grants are device-scoped (same entity_id on another device ⇒ 403).
- Acceptance test per card: entity-A allowed org-X, blocked org-Y.
- Proxy pytest: `_org_token` 403 path aborts before any git subprocess.

## Rollout

1. Migration + route behind env flag `HERMES_ORG_TOKEN_ENABLED` (default off).
2. Proxy falls back to `HERMES_GH_PAT` when the flag is off (zero-downtime).
3. Seed grant for the current single-org reality (`HankHuang0516`), flip
   flag, observe one full file-edit task, then remove PAT fallback in a
   follow-up PR.

## Out of scope (per card)

GitHub App marketplace listing; org-admin self-service grant UI (Phase 4).
