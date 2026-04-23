# Code Review Checklist (EClaw)

Every PR — whether opened by the commander or by a sub-agent (U##) — must pass this checklist before merge. Self-review comments on a PR must list each item with ✅ / ⚠️ NO-OP / ❌ + reason.

**Ownership:** This checklist is authoritative. If a PR author or reviewer encounters ambiguity, they follow this file rather than ad-hoc judgment. Updates to the checklist are themselves PRs and require the same checklist compliance.

---

## Part A — Core review (5 items)

### A1. Logic trace
Walk the happy path and the key failure paths end-to-end. For every new branch, state the guard condition and what state the system is in after the branch runs.

### A2. Test coverage
- Unit test for every new code path (success + failure).
- Jest tests live under `backend/tests/jest/`. Use `helpers/mock-setup.js` — do not add a second mock style.
- If the change touches a DB schema or query, include a test that exercises the mocked `db.*` shape.
- Never ship with test suite red. `npx jest <file>` must print green on the new/updated suite.

### A3. Return shape
- Every new API response follows the existing `{ success: true, ... }` convention unless it intentionally breaks that contract (state the reason).
- Error paths return `{ success: false, error: '<short-machine-readable-code>', message?: '<human>' }`.
- Status codes: `400` input, `403` auth, `404` not found, `409` conflict, `500` server.

### A4. What this does NOT fix
List adjacent bugs / classes of bugs that remain open after this PR lands. This surfaces regressions early and keeps scope honest. If none, write "none identified".

### A5. Security review
- Auth check present on every mutation (`botSecret` for bot-side, `deviceSecret` for owner-side).
- No value leakage to logs, audit rows, or error messages (keys are fine; values are not).
- Rate-limit / guard for destructive operations (delete, wipe, replace-all).
- Input validated at the boundary (type, length, enum).
- If the PR is security-sensitive, add a test that directly asserts the security invariant (e.g. "never passes secret values to logDeviceVarsAudit").

---

## Part B — Extended review (5 items, added 2026-04-23)

### B1. `/api/help` update
Any **new REST endpoint** must be discoverable via `/api/help?intent=…`. Concretely:

- Add the endpoint to the appropriate `INTENT_MAP` category in `backend/index.js` (`app.get('/api/help'…)`). If no category fits, add a new category and keyword list (zh/en at minimum).
- Add a `{ title, curl }` entry to the `APIS` block for that category so bots receive a runnable example.
- Cross-check: `curl -s "https://eclawbot.com/api/help?intent=<keyword>&…"` returns the new endpoint.

If the PR **modifies** an existing endpoint's shape, update its existing entry.

### B2. Related docs
Update every doc file that references the affected surface. Checklist:

- `README.md` (root + `backend/`) — feature lists, API tables.
- `CLAUDE.md` (root) — architecture pointers, env vars, invariants.
- `docs/*.md` — spec docs, guide docs.
- Inline comments on the changed endpoint/function describing the contract.
- `~/.claude/scheduled-tasks/<name>/SKILL.md` — if a scheduled task exercises the surface.

Grep rule: `rg '<old-endpoint-name>|<old-field-name>' docs/ README.md backend/ --files-with-matches` — every hit either gets updated or gets an explicit "N/A, kept for historical reference" note in the PR body.

### B3. i18n audit
- If the PR adds user-facing strings (frontend HTML, React, mobile), list every new key with at minimum `en`, `zh-TW`, `zh-CN`, `ja`, `ko`. Missing locales → a follow-up kanban card titled `i18n TODO: <PR-title>` with the orphan keys listed.
- If the PR is pure backend / JSON / admin-only with no user-facing strings, write **"i18n NO-OP — <reason>"** in the review comment. Never leave i18n blank; forcing the explicit NO-OP prevents silent drift.
- Run `node i18n-check.js` (or equivalent) before merge if strings changed.

### B4. Info / promo page check
EClaw has user-facing marketing / info pages (`/features`, `/info`, promo landing pages, portal help panels). When a PR changes user-visible behavior or adds a shippable feature:

- Grep `frontend/public/` and `portal/public/` for mentions of the affected surface.
- Update the info page in the same PR (or file a companion kanban card if the copy requires translation work → route via `feedback_i18n_delegate.md`).
- If no info page refers to this feature, write **"Info page NO-OP — feature not surfaced to end users"**.

### B5. Debug endpoint (flag-gated)
New security/data logic needs a corresponding `/api/debug/<feature>` endpoint so future incidents can inspect raw state without SSH to Railway.

- Path convention: `GET /api/debug/<feature-name>` under the existing `/api/debug/*` namespace.
- **Gate**: the whole `/api/debug/*` namespace is already `NODE_ENV !== 'production' || RAILWAY_ENVIRONMENT === 'debug'` guarded. Do NOT attempt to expose it in prod — use the audit endpoint (owner-secret gated) for prod introspection instead.
- Response: raw rows / state, never redacted values unless the redaction itself is what's being tested.
- Pair every new audit row type with a debug endpoint that can dump the last N rows for any device.

---

## Self-review comment template

Paste this into the PR review comment (or `gh pr comment` body) and fill every line:

```
## Code review — PR #<N>

### Core
- A1. Logic trace: <one sentence>
- A2. Test coverage: <jest file + test count + green-confirm>
- A3. Return shape: <confirm convention>
- A4. What this does NOT fix: <list or "none identified">
- A5. Security: <invariants asserted + test names>

### Extended
- B1. /api/help: <✅ updated / ⚠️ NO-OP: no new endpoint>
- B2. Related docs: <files touched, or "NO-OP — <reason>">
- B3. i18n: <✅ keys added: N / ⚠️ NO-OP: backend-only>
- B4. Info/promo page: <✅ updated / ⚠️ NO-OP: <reason>>
- B5. Debug endpoint: <✅ added /api/debug/<feat> / ⚠️ NO-OP: <reason>>

Result: merge-ready / needs-followup
```

---

## How sub agents (U##) use this file

Every `claude` dispatch prompt that asks a sub-agent to implement something **must** include:

> Before pushing your PR, open `/Users/hank/Desktop/Project/EClaw/docs/code-review-checklist.md` and apply every Part A + Part B item. Your self-review comment must use the template at the bottom of that file, filled line-by-line. If any item is NO-OP, state the reason.

The dispatch preamble template in `~/.claude/projects/-Users-hank-Desktop-Project-claude-code-eclaw-channel/memory/reference_dispatch_template.md` will be updated to include this pointer so future dispatches inherit it automatically.

---

## Why this exists

- **2026-04-23 vault-wipe incident** — `/api/device-vars` had a legacy replace-all path that silently wiped a non-empty vault when called with `vars:{}`. The fix (PR #1995/#1996/#1997) was technically correct but the first two PRs shipped without updating `/api/help`, docs, or debug tooling. Hank had to point each gap out. This checklist exists so no future security-sensitive PR ships without those downstream surfaces being updated in the same commit.
