# Private work timeline

The History Timeline sidebar belongs to the existing AiHankApps dot-progress workspace. It uses the same portal session and current administrator-role check. Anonymous visitors see only the existing completed-result projection. Opening the timeline is explicit; the public page and unopened sidebar make no timeline reads. This feature does not change project fields, push counters, decisions, sharing links or browser-return restoration.

## Reading and writing

Open **歷史時程表** in the administrator toolbar. Desktop uses a sidebar and mobile uses a dismissible drawer. Filter by a Taipei calendar date or an exact saved project label, expand an interval for its actions, result, blockers, next step and optional evidence, and load older entries explicitly. Times always display in `Asia/Taipei`, independently of the device timezone.

The daily Gantt chart uses these same loaded intervals and filters. **今日** selects today's `Asia/Taipei` date and runs the existing date filter. Bars clip intervals to the selected calendar day; zero-duration records have labelled point markers. Work types remain visible as text and color. The chart shows loaded/total counts and makes no statement about unrecorded blank time or work hours. Loading more records updates the chart through the existing pagination; it makes no separate chart API request.

Each interval can retain a separate explicit `goal`, displayed independently from its result. Legacy records without a goal show **目標待補**; neither actions nor results are converted into inferred objectives. Goal text uses the same private-text limits and safety validation, with a 4000-character bound. Omitting it preserves the old request shape and retry receipts. To add a goal after importing an old record, edit that interval with its current version and a fresh update request ID; do not resend the original create ID with changed contents.

When only the completion time is known, select **開始時間不詳**: `startedAt:null` and a required known `endedAt` create a labelled milestone at that endpoint. No start time or duration is inferred. Both unknown timestamps are unsupported. Milestones belong to the Taipei date of their known endpoint; sorting uses the start time or, for milestones, the endpoint, then the record ID. The additive database migration removes only the start-time NOT NULL constraint and preserves existing records and retry receipts.

Create a completed interval with its actual start/end times and one work type: implementation, validation, routine check, waiting or blocked. The optional project ID links an existing card; the required project label snapshots the related item and also supports supplied historical records without a card ID. Updates require the displayed version, retain prior revisions and never modify the associated card. There is no delete or replace-all operation.

The normal sidebar also accepts an owner-supplied JSON file with `{schemaVersion:1,entries:[...]}`. Selecting a file and previewing it do not write anything. Explicit confirmation submits each interval with its supplied stable request ID. A partially interrupted import can be resumed with the same file; confirmed receipts represent records, not newly performed work. Real backfill files stay outside this public repository. Synthetic examples only may be committed.

## API contract

All routes are under `/api/dot-progress`, use `{success:true,...}` on success, and return short machine-readable errors without input, SQL, credential or identity values in logs/errors. Every timeline read/write requires the existing admin session. The existing cross-origin write guard and service startup/rate boundaries still apply.

- `GET /timeline?date=YYYY-MM-DD&project=EXACT_LABEL&offset=0`: returns `entries`, `total`, `limit`, `offset`, `nextOffset`. The date is a Taipei day. For nonzero intervals, overlap means `start < next-day midnight` and `end > day midnight`; an interval ending at midnight belongs to its preceding day. A zero-duration point belongs to its own Taipei date. A null-start milestone uses `day midnight <= end < next-day midnight`.
- `POST /timeline`: accepts `requestId`, `startedAt` (explicit null for unknown-start milestones), `endedAt` (required known timestamp), `projectId` (nullable), `projectLabel`, `workType`, optional explicit `goal`, `actions`, `result`, `blockers`, `nextStep` and optional `evidence`. Returns `entry`.
- `PATCH /timeline/:id`: accepts the same safe interval fields plus its current `version` and a stable update `requestId`. Returns `entry`; a stale version returns 409 without replacing newer data.
- `GET /timeline/:id/history?offset=0`: returns retained `history` and explicit pagination metadata. Prior safe interval snapshots and server-recorded actor/time remain available after edits.

ISO timestamps must include seconds and `Z` or an explicit offset, with at most three fractional digits (milliseconds); finer precision is rejected rather than rounded. The UI converts entered Taipei dates/times using `+08:00` and preserves seconds/milliseconds when editing other fields. End cannot precede start; intervals are bounded to seven days. Work types are `implementation`, `validation`, `routine`, `waiting`, `blocked`. Labels and descriptions are bounded plain text.

Both create and update are idempotent per authenticated actor and request ID. An exact retry returns the original committed receipt, including its original version, even after later edits. Reusing an ID for a different canonical operation returns 409. Data, retained history and the receipt commit together; failures roll back. Pagination avoids hiding older records behind a silent limit.

## Evidence and truthful reporting

Use concise work summaries only. Do not record email bodies, private recipients/messages, secrets, capability links, internal tools or local/private note paths. Evidence is optional and limited to public HTTPS GitHub links for this repository's PRs, Actions runs or commits, without credentials, query strings or fragments. Render text as text nodes and open evidence with no referrer.

Do not count polling as new progress. Routine checks record what was actually checked and what changed, including zero newly qualified items where verified; an unknown total stays unknown. Intervals without work evidence are labelled waiting/no new outcome rather than invented activities or implementation hours. The timeline has no automatic chat/email/account reads, worker callbacks, productivity totals or inferred full-day timesheets. Future records are explicitly supplied through the same UI/API.

## Persistence, privacy and regression

Timeline tables initialize alongside the existing progress schema in its locked transaction. They retain interval revisions and retry receipts in PostgreSQL across app restarts; no browser private storage or memory-only fallback is used. Logout, session failure, page departure and late responses clear private timeline content. Pending admin revalidation conceals and disables the timeline until the role is confirmed.

The existing production-disabled `/api/debug/dot-progress` endpoint exposes bounded timeline counts/diagnostic metadata only. It does not expose work summaries or evidence. The public API continues to allow only completed title, public summary and date.

Regression tests cover admin/anonymous/current-role boundaries, strict timezone/date inputs, midnight and cross-day filtering, create/update retries and conflicts, concurrent writes, atomic rollback, retained revisions/restart, unsafe evidence/text rejection, empty/paged filters, lazy reads, stale responses, desktop/mobile controls, browser Back/Forward and synthetic push counters. Instruction and memory files remain read-only; regression registration is recorded here.
