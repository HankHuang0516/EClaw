# Skill Contribution Auto-Approve + Admin Dashboard Design

**Date:** 2026-03-07
**Status:** Approved by user

---

## Scope

Four changes in one delivery:

1. **Auto-approve pipeline** — verify GitHub URL asynchronously, auto-approve/reject with duplicate guard
2. **Admin contribution log** — new API + admin.html tab to view all contribution history
3. **Bot schedule docs** — add Chapter 12 to E-claw_mcp_skill.md for `/api/bot/schedules`
4. **Fix entity 4 schedule** — delete wrong Mission Rule, notify entity 4 to set real cron via `/api/bot/schedules`

---

## A. Backend: Auto-Approve Pipeline

### Flow

```
POST /api/skill-templates/contribute
    │
    ├── Auth: deviceId + botSecret + entityId (validate bound entity)
    ├── Field validation: id, title, url, steps required
    │
    ├── Duplicate ID check (against skill-templates.json)
    │       └── exists → 409 immediate response
    │               "Skill id \"X\" already exists. Choose a different id."
    │               serverLog category=skill_contribute level=warn
    │
    ├── Save to contributions log (status: 'verifying')
    ├── Respond immediately: { success: true, message: "Submitted. Auto-verifying..." }
    │
    └── ASYNC: GitHub URL verification
            ├── Extract owner/repo from url
            ├── GET https://api.github.com/repos/:owner/:repo
            │
            ├── HTTP 200 → AUTO-APPROVE
            │       ├── Push to skill-templates.json (in-memory + write file)
            │       ├── Update contribution log: status='approved', verifiedAt, stars, description
            │       └── serverLog category=skill_approve
            │
            └── non-200 → AUTO-REJECT
                    ├── Update contribution log: status='rejected', rejectedReason='github_404'
                    └── serverLog category=skill_contribute level=warn
```

### Contribution Log Format (`data/skill-contributions-log.json`)

```json
[
  {
    "pendingId": "uuid",
    "id": "arxiv-digest",
    "label": "arxiv-digest",
    "icon": "📚",
    "title": "arXiv Digest Skill",
    "url": "https://github.com/Starsclaw0301/arxiv-digest",
    "author": "Starsclaw0301",
    "requiredVars": [],
    "steps": "...",
    "submittedBy": {
      "deviceId": "480def4c-...",
      "entityId": 4,
      "entityName": "荷官eclaw_rai_0"
    },
    "submittedAt": "2026-03-07T10:54:22Z",
    "status": "approved",
    "verifiedAt": "2026-03-07T10:54:24Z",
    "verificationResult": {
      "githubStatus": 200,
      "stars": 0,
      "description": "Daily cs.RO arXiv digest skill for OpenClaw"
    }
  }
]
```

Statuses: `verifying` → `approved` | `rejected`
File is gitignored (runtime data). Created on first write if missing.

### Remove Obsolete Pending System

The old `skill-templates-pending.json` + manual approve/reject endpoints are replaced by this auto pipeline.
Remove: `GET/POST/DELETE /api/skill-templates/pending` endpoints + pending file.

---

## B. Admin Backend API + UI

### New Endpoints

```
GET    /api/skill-templates/contributions   Admin: full contribution history (all statuses)
DELETE /api/skill-templates/:id             Admin: revoke an approved skill from registry
```

`GET /api/skill-templates/contributions` response:
```json
{
  "success": true,
  "count": 2,
  "contributions": [
    { "pendingId": "...", "id": "arxiv-digest", "status": "approved", "verifiedAt": "...", ... },
    { "pendingId": "...", "id": "bat-cat",       "status": "rejected", "rejectedReason": "github_404", ... }
  ]
}
```

### admin.html: "Skill Contributions" Tab

New tab in existing admin panel. Columns:

| Skill ID | Title | Submitted By | Status | GitHub | Date | Actions |
|----------|-------|--------------|--------|--------|------|---------|
| arxiv-digest | arXiv Digest Skill | 荷官eclaw_rai_0 (e4) | ✅ approved | ★0 Daily digest | 2026-03-07 | [Revoke] |
| bat-cat | bat-cat - Better cat | 荷官eclaw_rai_0 (e4) | ❌ rejected (github_404) | — | 2026-03-07 | — |

- Filter by status (all / approved / rejected)
- "Revoke" calls `DELETE /api/skill-templates/:id` and refreshes list
- All strings via i18n keys

---

## C. E-claw_mcp_skill.md: Chapter 12 — Bot Schedule API

Add new chapter at end of file:

```markdown
## 12. Bot Schedule API

Bots can create, list, and delete schedules using their botSecret.
No deviceSecret required.

### POST /api/bot/schedules — Create schedule
Body: { deviceId, entityId, botSecret, message, repeatType, cronExpr, label, timezone }
repeatType: 'once' (needs scheduledAt) | 'cron' (needs cronExpr)

### GET /api/bot/schedules — List your schedules
Query: ?deviceId=&entityId=&botSecret=

### DELETE /api/bot/schedules/:id — Delete a schedule
Body: { deviceId, entityId, botSecret }
```

Include a complete curl example for `cronExpr: "0 * * * *"` (hourly).

---

## D. Fix Entity 4 Schedule

Sequential steps (after backend deployed):

1. Use entity 0 botSecret to speak-to entity 4:
   - Delete the `Hourly Skill Hunter` Mission Rule via `POST /api/mission/rule/delete`
   - Call `POST /api/bot/schedules` with `cronExpr: "0 * * * *"` and message describing the skill-search task

2. Verify via `GET /api/bot/schedules?deviceId=...&entityId=4&botSecret=...`

---

## Implementation Order

1. Backend: auto-approve pipeline (replaces pending system) + contributions log + new admin API
2. admin.html: Skill Contributions tab
3. E-claw_mcp_skill.md: Chapter 12
4. Deploy (commit + push)
5. Fix entity 4 schedule via speak-to
