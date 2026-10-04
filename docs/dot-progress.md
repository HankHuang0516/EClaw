# dot project progress

`/AiHankApps/dot-progress/` is linked beside APP 趨勢 in the portfolio. This portfolio-only page uses the existing EClaw portal session and server admin role. It does not create accounts, change admin configuration, connect entities, or ingest all Codex conversations. Entity connections are managed separately from progress records.

HTML uses the existing no-store browser/CDN policy. Its six local scripts/styles share a content-derived bundle version in their URLs, so a normal reload fetches the current release even when older unversioned files remain in the browser cache. When any bundle asset changes, refresh the version in all six HTML references; the public-assets regression verifies it against the SHA-256 digest of sorted asset names and bytes, each followed by a NUL separator (first 16 hex characters).

Only explicitly completed public titles, short summaries and dates are returned by `GET /api/dot-progress/public`. Private goals, blockers, next steps, decisions, comments, IDs, actor records and edit history never belong in that projection or static public assets. Public summary fields are separate from internal text and require completion plus a date. Changing a task to completed keeps its history; publishing a summary is an explicit admin choice. `cancelled` and `archived` are private terminal states, distinct from completion. Moving out of completion clears the public summary; records, comments and history remain available to administrators.

`GET /api/dot-progress/session` returns only authenticated/admin flags. All routes below require the existing `authMiddleware` and `adminMiddleware`; bot/device credentials grant no access:

| Method/path | Contract |
| --- | --- |
| GET `/api/dot-progress/projects` | Private rows with optimistic versions |
| PATCH `/api/dot-progress/projects/:id` | Changed fields plus current integer `version`; stale version returns 409 |
| GET `/api/dot-progress/projects/:id/comments` | Persisted comments |
| POST `/api/dot-progress/projects/:id/comments` | `body`, unique `requestId`; identical retry returns the existing comment |
| GET `/api/dot-progress/projects/:id/history` | Versioned before/after history |
| POST `/api/dot-progress/import` | `{mode:"preview"|"apply", data:{projects:[...]}}`; preview never writes |
| GET `/api/dot-progress/projects/:id/decisions` | Explicit private questions, suggestions, versions, comments and bounded audit events |
| POST `/api/dot-progress/projects/:id/decisions` | `question`, `recommendation`, unique `requestId`; adoption starts off |
| PATCH `/api/dot-progress/projects/:id/decisions/:decisionId` | Current decision `version` plus changed question/recommendation; content changes invalidate old adoption |
| POST `/api/dot-progress/projects/:id/decisions/:decisionId/adoption` | Current `version`, displayed `recommendationVersion`, boolean `adopted`; server records actor and time |
| POST `/api/dot-progress/projects/:id/decisions/:decisionId/comments` | Current `version`, `recommendationVersion`, alternative `body`, unique `requestId`; identical retry retains the same comment |
| GET `/api/dot-progress/review` | Private sourced project review records with correction comments, bounded latest entries |
| POST `/api/dot-progress/review` | `kind` (`permission`, `decision`, `change`), `title`, original `body`, `occurredAt`, `source`, `scope`, unique `requestId` |
| POST `/api/dot-progress/review/:reviewId/comments` | Append a correction `body` and unique `requestId`; original record remains unchanged |

PostgreSQL tables `dot_progress_projects`, `dot_progress_comments`, and `dot_progress_history` initialize lazily in a locked transaction. The public repository seed contains only the three approved completed summaries. Private initial tasks must be imported through an authenticated admin session from an owner-only file outside the repository. Initial seed IDs are inserted only when absent; restarts never overwrite edits. Missing/unavailable storage returns 503, without an in-memory fallback. Project updates and their history are atomic. Imports validate bounds, deduplicate IDs, require existing versions and commit all rows/comments atomically.

The same initialization adds `dot_progress_decisions`, `dot_progress_decision_comments`, `dot_progress_decision_events`, `dot_progress_review`, and `dot_progress_review_comments` idempotently. It creates no historical permission records or decisions automatically. Existing production data requires no re-import. Decision reads use a consistent database snapshot; mutations lock the project before the decision, so cancellation and adoption cannot race around the closed-project guard.

An import project contains `id`, `title`, `status` (`active`, `blocked`, `paused`, `completed`, `cancelled`, `archived`), `summary`, `blockers`, `nextStep`, `publicTitle`, `publicSummary`, `completedAt` (YYYY-MM-DD or empty), and optionally `version` and `comments` (`body`, `requestId`). Use the current version for an existing project; a new project may omit version or use zero. Decision adoption and audit metadata cannot be imported or forged through generic project PATCH. The old private Site has not been read or altered, and its previous comments/edits are not claimed to be migrated. A user-provided local export can be previewed and applied here.

Pending decisions are explicitly created only when a user choice blocks progress. Ordinary unperformed work and blockers do not create them. Each suggestion begins with an off adoption switch. The server derives the actor from the existing authenticated account and the time from storage; neither is accepted from a client. Question or suggestion changes increment `recommendationVersion` and invalidate prior adoption. Immutable events preserve earlier content, adoption/withdrawal, operator, time and recommendation version.

Alternative comments are preserved with their recommendation version. Any current-version alternative is conservatively treated as needing clarification, clears adoption and blocks adopting that version. There is no automatic semantic or AI interpretation of contradictory text: revise the suggestion to address the alternative, then explicitly adopt the newly displayed version. Previous comments and events remain visible. Decision mutations use row locking and independent optimistic versions; retries cannot silently apply an old switch choice to a new suggestion. Cancelled/archived project decisions remain readable for audit and cannot be newly adopted.

This is a decision journal. A checked suggestion does not execute work, grant credentials, bypass safety checks or authorize new external actions. No decision endpoint calls another service or entity. Private decisions and comments are excluded from public output regardless of project completion.

The administrator-only Project Review sidebar is a separate, append-only work journal. It holds visible permission questions/answers, decided items and important changes with their original words, occurrence date, source and scope. Corrections are comments, so the original record remains available for comparison. The server records the authenticated author and storage time separately from the supplied occurrence date. It does not read assistant internal memory, hidden instructions, chat credentials or private notes. Records must be explicitly supplied through the authenticated UI; ordinary blockers are not treated as decisions. Desktop uses a sidebar and mobile a dismissible drawer. Logout/expiry clears its loaded records and drafts together with the other private UI.

Responses use `Cache-Control: no-store`. The page clears private memory/DOM at logout and session revalidation; 401/403 returns the login/access gate. Rendering uses text nodes for user content. Login accepts only the exact progress return path, preserving the existing portal redirect behavior.

`GET /api/debug/dot-progress` is mounted behind the existing production-disabled debug namespace and additionally requires the same admin session. It exposes bounded counts and recent history metadata for local diagnostics. It never returns task text, comments, identity, or credentials.

This feature is scoped to the AiHankApps portfolio; Android/iOS entity-management features and their navigation remain outside this request. Initial records reflect only tasks visible in the source dot. Never import secrets, sensitive health/financial information, chat transcripts, or merchant-private details.
