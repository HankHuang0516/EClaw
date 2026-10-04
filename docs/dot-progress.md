# dot project progress

`/AiHankApps/dot-progress/` is linked beside APP 趨勢 in the portfolio. This portfolio-only page uses the existing EClaw portal session and server admin role. It does not create accounts, change admin configuration, connect entities, or ingest all Codex conversations. Entity #14 stays paused.

Only explicitly completed public titles, short summaries and dates are returned by `GET /api/dot-progress/public`. Private goals, blockers, next steps, comments, IDs and edit history never belong in that projection or static public assets. Public summary fields are separate from internal text and require completion plus a date. Changing a task to completed keeps its history; publishing a summary is an explicit admin choice.

`GET /api/dot-progress/session` returns only authenticated/admin flags. All routes below require the existing `authMiddleware` and `adminMiddleware`; bot/device credentials grant no access:

| Method/path | Contract |
| --- | --- |
| GET `/api/dot-progress/projects` | Private rows with optimistic versions |
| PATCH `/api/dot-progress/projects/:id` | Changed fields plus current integer `version`; stale version returns 409 |
| GET `/api/dot-progress/projects/:id/comments` | Persisted comments |
| POST `/api/dot-progress/projects/:id/comments` | `body`, unique `requestId`; identical retry returns the existing comment |
| GET `/api/dot-progress/projects/:id/history` | Versioned before/after history |
| POST `/api/dot-progress/import` | `{mode:"preview"|"apply", data:{projects:[...]}}`; preview never writes |

PostgreSQL tables `dot_progress_projects`, `dot_progress_comments`, and `dot_progress_history` initialize lazily in a locked transaction. The public repository seed contains only the three approved completed summaries. Private initial tasks must be imported through an authenticated admin session from an owner-only file outside the repository. Initial seed IDs are inserted only when absent; restarts never overwrite edits. Missing/unavailable storage returns 503, without an in-memory fallback. Project updates and their history are atomic. Imports validate bounds, deduplicate IDs, require existing versions and commit all rows/comments atomically.

An import project contains `id`, `title`, `status` (`active`, `blocked`, `paused`, `completed`), `summary`, `blockers`, `nextStep`, `publicTitle`, `publicSummary`, `completedAt` (YYYY-MM-DD or empty), and optionally `version` and `comments` (`body`, `requestId`). Use the current version for an existing project; a new project may omit version or use zero. The old private Site has not been read or altered, and its previous comments/edits are not claimed to be migrated. A user-provided local export can be previewed and applied here.

Responses use `Cache-Control: no-store`. The page clears private memory/DOM at logout and session revalidation; 401/403 returns the login/access gate. Rendering uses text nodes for user content. Login accepts only the exact progress return path, preserving the existing portal redirect behavior.

`GET /api/debug/dot-progress` is mounted behind the existing production-disabled debug namespace and additionally requires the same admin session. It exposes bounded counts and recent history metadata for local diagnostics. It never returns task text, comments, identity, or credentials.

This feature is scoped to the AiHankApps portfolio; Android/iOS entity-management features and their navigation remain outside this request. Initial records reflect only tasks visible in the source dot. Never import secrets, sensitive health/financial information, chat transcripts, or merchant-private details.
