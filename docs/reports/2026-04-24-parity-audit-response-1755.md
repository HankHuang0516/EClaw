# Issue #1755 Parity Audit — Response & Findings

**Date:** 2026-04-24
**Issue:** [#1755 — \[Parity\] 4 features missing cross-platform support after weekly audit](https://github.com/HankHuang0516/realbot/issues/1755)
**Auditor:** bot audit (entity #2, device `480def4c…`)
**Response by:** U32 sub-agent

---

## Summary

Re-verified all 9 claims in the weekly parity audit. **Seven of nine are false positives** caused by the audit tool probing endpoints with the wrong HTTP method, wrong path, or no auth params. **Zero actual code changes are required.** The remaining two (Scheduler 410, deprecated rows) are intentional.

No parity gaps remain. The root cause is a bug in the audit tool's probe strategy, not in the product surface.

---

## Per-claim verification

### Section 1 — "API-only (no Web Portal page)"

| # | Claim | Verdict | Evidence |
|---|-------|---------|----------|
| 1 | Publisher: no `/portal/publisher.html` | ❌ FALSE | `backend/public/portal/publisher.html` and `publisher-setup.html` both exist and are listed in `CLAUDE.md` under "Web Portal Pages". |

### Section 2 — "API missing entirely"

| # | Claim | Verdict | Evidence |
|---|-------|---------|----------|
| 2 | `POST /api/chat/history` → 404 | ❌ FALSE | Route exists at `backend/index.js:16193` as **`GET /api/chat/history`**. Auditor used wrong HTTP method. |
| 3 | `GET /api/notifications/vapid-key` → 404 | ❌ FALSE | VAPID key endpoint lives at **`GET /api/push/vapid-public-key`** (`backend/index.js:15222`). Auditor used wrong path. |
| 4 | No AI support API | ❌ FALSE | `/api/ai-support/*` mounted at `backend/index.js:14649` (bot chat + `/api/ai-support/admin-chat` admin-guarded). Backed by `backend/ai-support.js` module. |
| 5 | No screen control API or Web Portal page | ❌ FALSE | `POST /api/device/screen-capture` exists at `backend/index.js:14943`; portal page at `backend/public/portal/screen-control.html`; Jest suite `tests/jest/screen-control.test.js`. |

### Section 3 — "Web-only (no working API)"

| # | Claim | Verdict | Evidence |
|---|-------|---------|----------|
| 6 | `GET /api/schedules` → 410 Gone | ✅ TRUE but intentional | Legacy schedule system removed in v1.362 (see CLAUDE.md "Recent Features (v1.211.x – v1.362.x)"). Replaced by Kanban. The 410 is the documented contract, not a parity gap. |
| 7 | `GET /api/feedback` → 400 | ⚠️ TRUE but auth-required | Endpoint works when called with required `deviceId` + `deviceSecret` query params. The 400 is from input validation, not missing route. |
| 8 | `GET /api/device-telemetry/summary` → 400 | ⚠️ TRUE but auth-required | Same pattern — needs `deviceId` + `deviceSecret`. |
| 9 | `GET /api/mission/dashboard` → 401 | ⚠️ TRUE but auth-required | Needs `deviceId` + `botSecret` + `entityId`. The 401 confirms the route exists and is guarded. |

---

## Root cause

The parity audit prober appears to hit each endpoint with a fixed default request (no query params, default HTTP method GET). It then classifies anything that doesn't return 200 as "missing". This produces false positives in three ways:

1. **Wrong HTTP verb** — e.g. probing `POST /api/chat/history` when only `GET` exists.
2. **Wrong path** — e.g. `notifications/vapid-key` vs the actual `push/vapid-public-key`.
3. **Auth-required routes flagged as missing** — endpoints that return 400/401 because required query params weren't supplied get classified as "web-only / no API".

A well-formed probe must:
- Include `deviceId` + appropriate secret (`deviceSecret` for owner routes, `botSecret` + `entityId` for bot routes).
- Use the correct HTTP verb from the route table.
- Treat **403/404** as "missing" but **400/401** as "auth-required, probably exists."

## Recommended action

- **Close #1755** (no parity work required).
- **Open a follow-up issue** against the parity audit bot to fix its probe strategy so future audits don't re-file these same false positives.

## Does-NOT-fix list

This PR intentionally does **not**:
- Change any endpoint signatures.
- Add or remove portal pages.
- Modify the legacy Scheduler 410 response.
- Alter the audit prober (that belongs in the bot's codebase / mission config, not in this repo).
