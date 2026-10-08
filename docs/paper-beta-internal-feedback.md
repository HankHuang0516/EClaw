# Paper Flick Soldiers private Beta feedback

The current game source sends HTTPS JSON POST to
`https://eclawbot.com/api/app-portfolio/apps/paper-flick-soldiers/beta-feedback`
(`src/mvp_game.gd:14,665,713` in the read-only game checkout). This is the native
Beta form, not Google Forms or an email submission. Its fields are a random
submission receipt ID, rating 1–5, sequel preference, optional 500-character
comment, app version and platform. Drafts and completed receipts are persisted
locally in `user://paper_flick_progress.cfg`; retries retain the same ID.

The existing website handler `backend/app-portfolio-community.js` validates
these fields, inserts into PostgreSQL `app_portfolio_beta_feedback`, and returns
an existing receipt on the unique `(app_id, submission_id)` conflict. The pool
uses the existing `DATABASE_URL` configuration. No account, player name, email,
device identifier or attachment columns are part of this intake table; optional
free text may still contain information a player chooses to enter and must stay
private. Public portfolio comments use a different table and endpoint.

## Internal display

Existing account administrators see a Paper Beta section in `/portal/admin.html`.
`GET /api/admin/paper-beta-feedback` uses the existing session middleware and
checks the current `user_accounts.is_admin` flag on every request. It returns
401/403 before reading feedback for anonymous/nonadmin callers; failure to verify
the role also fails closed. Every outcome carries `private, no-store` and varies
on Cookie and Authorization. Bot/device credentials alone grant no access.

The reader selects explicit fields from the existing table, fixes the app scope,
and returns aggregate counts, average rating and at most fifty records. Raw
submission IDs, authentication objects, identities and attachments are excluded.
Local-only `/api/debug/paper-beta-feedback` diagnostics reuse this exact reader
and session/admin gates; both the debug namespace and router reject production
or any Railway environment before reading storage. It adds no raw export.
Comments are available only inside the administrator response and are rendered
as text, never HTML. Keyset receipt IDs remain strings even above JS safe integers.
One SQL snapshot produces both summary and page. It creates no table, copy,
cron job, credentials or persistent integration permissions.

Refresh replaces the visible page; a visible tab refreshes its latest page every
60 seconds. Older responses use a bounded keyset page. Failed reads clear the
previous data; 401/403 stop polling. Pagehide clears rows and a bfcache return
fetches again. Nothing is persisted in browser storage. Existing telemetry only
records read success, fixed action names and status; comments and response
payloads are not passed to telemetry. Public support pages contain disclosures,
never feedback records or requests to this private API.

## Verification

- Real existing JWT/session and fresh-role Jest tests cover missing, tampered,
  expired, nonadmin, removed/deleted roles, auth DB failure, minimal response,
  pagination injection/overflow, repeated reads, source updates and storage failure.
- A disposable local PostgreSQL 15 cluster with synthetic rows verified the
  actual intake and read SQL: receipt dedupe, first-write-wins retry, fixed app
  scope, one-source updates, aggregation and disjoint pages. It used a private
  `/tmp` Unix socket, no network listener, and was stopped/deleted afterwards.
- The Chrome component test uses intercepted synthetic URLs and rows. It checks
  XSS text rendering, replacement refresh, updates, cursor selection, stale
  response rejection, 401/403/503 clearing, bfcache handling and 390/1280px layout.
- Shared Web keys are present in all sixteen current dictionary locales; new
  labels were also synchronized to existing eighteen Android XML and sixteen
  iOS JSON files. These label additions do not add a native admin UI.

The anonymous production check on 2026-10-07 found introduction/support HTTP 200
and an existing private admin read HTTP 401. GET on the POST-only Beta submission
path returned 404. No feedback was submitted and no private production record,
production session, credential, table contents or record count was inspected.
These observations do not prove that a particular installed app binary includes
this source code or that the production table currently contains submissions.

On 2026-10-07 at 10:09 UTC, the existing authenticated Railway CLI read-only
channel verified the production service (`Clawdbot`, project
`844a6139-9b8f-43d6-a698-f97db1fa05c0`, service
`12130b67-e57d-466b-a250-632b24cc6e3a`). A `BEGIN READ ONLY` transaction confirmed
the existing Beta table and all expected column types. A `SELECT ... LIMIT 0`
verified that the existing service role can SELECT the reader's columns without
returning feedback rows. At least one existing DB administrator account is
present; no account identity or current user session was inspected. Production
`auth.js` exactly matches the candidate's SHA256 and retains cookie/Bearer
session verification plus the fresh per-request `user_accounts.is_admin` check.
The intake route and existing admin check are mounted; the new panel is not yet
mounted. No schema, grant, credential or role expansion is required. This check
read zero feedback rows, does not prove there are submissions, and does not
establish that the user's current portal session is an administrator.

Additional anonymous HTTP probes returned 403 for both existing admin paths
and the candidate path. These responses alone cannot establish application auth
behavior or whether a route is mounted; runtime source was checked separately.
No alternate authentication or bypass was attempted. The non-secret metadata
receipt remains local at
`.private/publication-preparation-20261007/beta-production-metadata.json`.

Reproducible tests:
`backend/tests/jest/paper-beta-admin.test.js`,
`backend/tests/postgres/paper-beta-admin-source.cjs` (explicit disposable test
socket required), and `backend/tests/browser/paper-beta-admin-smoke.cjs`.

## Before publication

This round is local-only on `codex/paper-beta-internal-feedback-20261007`, based
on main `e9b1deb4` after the merged introduction PR #5199. No commit, remote
branch, PR, merge or deployment is included. Private local receipts/screenshots
are evidence only and must not be committed or published.

On 2026-10-07 at 10:27 UTC, the user explicitly approved the completed
manual review for this website publication and requested removal of the project
rule that required simplify/Claude Code login. AGENTS.md and CLAUDE.md now require
recorded reuse, quality and efficiency review plus applicable tests, without a
mandatory tool/login dependency. No security, secret, PR or CI gate was removed.
The earlier logged-out probe is historical evidence; simplify was not run.
Then complete this feature's PR, actual CI and applicable approval. The existing
configured production database's intake table and service SELECT privilege are
now verified; the reader deliberately returns 503 instead of
creating missing storage or presenting a false empty list. A current portal
account with the DB admin role is required. No new key or environment secret is
needed. After deployment, verify anonymous 401, nonadmin 403, admin rendering
and a real existing receipt (administrator inspection only), plus cache headers,
mobile layout, support redirect and the unchanged QR/store/video links. Do not
create fake production feedback for verification.
