# GitHub PR Merged Webhook → Kanban Auto-Update

## Status
Draft — pending LOBSTER (#2) sign-off

## Background

When a PR is merged, the corresponding kanban card (identified by `card_<id>` in
the merge commit message) should automatically move to `done` and receive a
`shipped` comment with the PR URL.

The logic lives in the EClaw backend (Railway prod), not in Hermes, because:
- EClaw backend already has kanban write permissions and is always reachable
- Hermes is an "executor" — kanban mutations belong on the host platform
- A single webhook endpoint in the backend handles all agents uniformly

## Target APIs

| Action | Endpoint | Auth |
|--------|----------|------|
| Move card to done | `POST /api/mission/card/:cardId/move` | `deviceId` + `botSecret` + `entityId` |
| Add shipped comment | `POST /api/mission/card/:cardId/comment` | same |

Both already exist in `backend/kanban.js` (lines ~1507 and ~1726).

## New Endpoint

```
POST /api/github/pr-merged-webhook
Content-Type: application/json
X-Hub-Signature-256: sha256=<HMAC>
X-GitHub-Event: pull_request
```

### HMAC Verification

The `X-Hub-Signature-256` header is verified using a shared secret stored in
`process.env.GITHUB_WEBHOOK_SECRET`.  The HMAC is computed over the raw request
body using SHA-256 in HMAC mode:

```
expected = 'sha256=' + HMAC-SHA256(secret, rawBody).hex()
```

Comparison uses a constant-time function (`crypto.timingSafeEqual`) to prevent
timing attacks.

If verification fails → `401 Unauthorized`.

### Request Body (GitHub pull_request event)

```json
{
  "action": "closed",
  "pull_request": {
    "merged": true,
    "html_url": "https://github.com/owner/repo/pull/123",
    "merge_commit_sha": "abc123def456..."
  }
}
```

### Card ID Extraction

The merge commit subject (field not directly available in the webhook payload;
use the `pull_request.merge_commit_sha` to fetch via GitHub API OR include
`card_<id>` in the PR title/body — simpler: scan all `card_[a-z0-9_]+` patterns
in `pull_request.title` + `pull_request.body`).

> **Alternative** (more reliable): Require the card ID in the PR title as
> `card_<id>` or in a designated label. For now, scan title + body.

### Response

| Scenario | Status | Body |
|----------|--------|------|
| Success | `200 OK` | `{ "ok": true, "cards": ["card_xxx", ...] }` |
| No card found | `200 OK` | `{ "ok": true, "cards": [] }` |
| Bad signature | `401 Unauthorized` | `{ "error": "bad signature" }` |
| Server error | `500` | `{ "error": "..." }` |

## Implementation Plan

### Step 1 — New file: `backend/api_github_webhook.js`

```js
// api_github_webhook.js
// POST /api/github/pr-merged-webhook
// - Verifies HMAC-SHA256 signature
// - On pull_request merged: extracts card_<id> from PR title/body
// - Calls POST /api/mission/card/:cardId/move { newStatus: 'done' }
// - Calls POST /api/mission/card/:cardId/comment { text: 'Shipped: <PR URL>' }
// - Both kanban calls use ECLAW_SYSTEM_DEVICE credentials (env vars)
```

Auth for internal kanban calls: read from env vars
`ECLAW_SYSTEM_DEVICE_ID` + `ECLAW_SYSTEM_BOT_SECRET` + `ECLAW_SYSTEM_ENTITY_ID`
(to be created; owned by admin).

### Step 2 — Wire into `backend/index.js`

```js
const githubWebhook = require('./api_github_webhook')({ devices, kanbanModule });
app.use('/api/github', githubWebhook.router);
```

The `kanbanModule` reference gives the webhook direct in-process access to the
kanban router — no HTTP overhead.

### Step 3 — Env vars

| Variable | Purpose |
|----------|---------|
| `GITHUB_WEBHOOK_SECRET` | HMAC shared secret (set in GitHub repo settings) |
| `ECLAW_SYSTEM_DEVICE_ID` | deviceId for internal kanban mutations |
| `ECLAW_SYSTEM_BOT_SECRET` | botSecret for same |
| `ECLAW_SYSTEM_ENTITY_ID` | entityId for same |

### Step 4 — GitHub Repo Settings (by Hank)

Add webhook pointing to `https://eclawbot.com/api/github/pr-merged-webhook`
with:
- Content type: `application/json`
- Secret: `GITHUB_WEBHOOK_SECRET` value
- Events: **Pull requests** (send me the individual events: "Pull requests" → "Let me select individual events" → check **Pull requests**)

## Open Questions

1. **PR body vs. commit message** — Should we also scan the merge commit's subject
   line for `card_<id>`? The GitHub webhook payload does not directly include it,
   but we can GET the commit via `https://api.github.com/repos/:owner/:repo/commits/:sha`
   using a GitHub token. Is a GitHub token available in the backend, or should we
   require the card ID to be in the PR title?

   **Proposed: require `card_<id>` in PR title.** Simpler, no external API calls
   needed. The card ID can also be in the body as a fallback.

2. **Multiple cards per PR** — Loop over all found card IDs and update each.

3. **What if card already done?** — The kanban move endpoint already returns
   `{ success: false, error: 'Done cards cannot be moved' }`. The webhook
   handler should treat a `done` result as non-fatal (log and continue).

4. **Retry on transient failure?** — No. Webhook delivery is GitHub's
   responsibility; if the first attempt fails GitHub will retry with
   exponential back-off.
