# EClaw administration in the AiHankApps Hub

The account-administrator data view is `/AiHankApps/hub/#app-eclawbot`.
After its existing login/admin check, `/portal/admin.html` redirects there.
`/portal/admin.html?operations=1` retains the original Bot create/edit/remove,
template revoke, push-update and AI support test workflows. The Hub links to
that explicit operations entry; it never invokes mutations while displaying data.
Native Android/iOS features and their administration permissions are unchanged.

## Data coverage

This moves the display of the original data, without copying databases or
rewriting account, wallet, binding or contribution records. The Timehut pattern
is reused: summary cells, actionable insights, search/filter/sort, 25-row local
pages and a private detail panel with a short quote-to-chat action.

| Hub section | Original source | Preserved scope |
| --- | --- | --- |
| Overview and expandable trend tables | `/api/admin/stats` | All nine original counters, entity total, App version, seven-day signups and Bot conversations, platform and Bot type/status counts |
| Users and devices | `/api/admin/users` | All returned records; registered accounts capped at 2,000 by the existing API, plus APP devices. Includes wallet/held balances, subscription expiry and test-device flag in detail |
| Official Bots and activity | `/api/admin/bots?readOnly=1` | Names/types/stored assignments, all original 24-hour and five-hour activity numbers, binding counts and assigned users in detail |
| Active bindings | `/api/admin/bindings` | Existing verified-user, still-bound, non-test scope; deliberately differs from total bindings |
| Skill, soul and rule contributions | `/api/{skill,soul,rule}-templates/contributions` | All returned history, descriptions, verification/status and provenance fields; local pagination does not truncate the fetched history |
| Arena feedback | `/api/arena/feedback?limit=50` | Latest 50, the same scope as the old page; no historical cursor is available |
| Paper Beta feedback | `/api/admin/paper-beta-feedback` | Original summary and 50-row cursor pages; “older” and “latest” controls preserve bigint cursors as strings |
| MiniGame submissions | `/api/admin/minigame-submissions?limit=50` | Original summary and fields, including full message in detail; “older” uses the existing offset API |
| MiniGame analytics | `/api/admin/minigame-analytics?hours=24&limit=25` | All original summary metrics, error signatures, gameplay and recent-error samples, with separate selectors |

Counts are not forced to agree across sources with different definitions.
Missing numbers remain `—`. Original stats date buckets retain their original
API semantics; rendered instants use `Asia/Taipei`. This does not backfill
historical logs, remove the users cap or change the older MiniGame helpers'
existing behavior when their backing store is unavailable.

## Access and lifecycle

The new JS/CSS assets live outside `public/` and are served only by the Hub's
existing authenticated, administrator-only allowlist with private/no-store
headers. Requests use the current same-origin session, `cache: no-store`, a
20-second abort and explicit response-shape validation. No credential is
embedded in the Hub or copied into an import, log, telemetry or browser store.

`readOnly=1` is an optional mode on the existing Bot endpoint. It retains both
original auth middlewares, excludes credential columns from SQL and JSON,
disables stale-assignment cleanup, and sends private/no-store cache headers.
Requests without that exact string preserve legacy behavior.

A failed source clears its previous snapshot and offers a retry without hiding
other available sections. Any 401/403 immediately clears the entire EClaw view
and stops polling. Leaving the view aborts pending work and removes listeners;
pagehide clears private rows, and a bfcache return fetches a new snapshot.
Generation checks prevent delayed responses from replacing a newer view.

Visible, idle views refresh once per minute while the Hub's auto-update toggle
is enabled. Searching, an open detail, focused controls or older local pages
pause refresh to preserve the interaction. Records are held only in memory.
QA hiding is scoped to the users table and is a local convenience, not deletion
or a change to the original global counters. The label follows the API test
flag or a conservative reserved test-account prefix.

Detail and search use explicit field lists; no API-object JSON dump is rendered.
All inserted values are HTML-escaped. Quotes contain at most three status/count
fields, not emails, device identifiers, comments or log text. The existing
`eclaw_quote` protocol is used with exact same-origin postMessage targets;
top-level quotes use the existing `eclaw_pending_quote` handoff to Portal chat.
The quote never sends a chat message automatically.

## Validation

`backend/tests/jest/aihankapps-hub-eclaw.test.js` exercises source coverage,
projection, escape/null/zero/date handling, interactions, partial failure,
revoked access, cursor paging and lifecycle. `admin-bots-readonly.test.js`
checks the real route handler's SQL/response and no-mutation invariants, legacy
behavior and cache headers. Existing Hub tests cover private asset serving,
permission failures, origins and CSP. Run under a worktree with:

```sh
cd backend
npx jest --runInBand --testPathIgnorePatterns=/node_modules/ --runTestsByPath tests/jest/aihankapps-hub-eclaw.test.js tests/jest/admin-bots-readonly.test.js tests/jest/aihankapps-hub.test.js
```

The local browser preview uses synthetic data only. Actual production parity,
health and the old-URL redirect must be rechecked after an authorized merge and
Railway deployment. Historical March/April admin reports and design plans remain
historical references, not the current routing specification.
