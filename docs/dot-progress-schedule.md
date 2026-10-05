# Private workspace goal Gantt

The goal Gantt stays at the top of the existing authenticated WORKSPACE, with project cards below. It follows the supplied AI layout reference without importing its illustrative projects, counts or times. Fixed goal labels sit beside the time axis; dashed planned bars, solid actual intervals, known-endpoint milestones and the current Taipei time line have distinct labels. Historical details are collapsed initially.

Actual timeline records, their versions/history, project data and push counters are independent and unchanged by every schedule operation. A recorded completed interval does not itself establish that a whole goal is completed. Unknown actual starts remain null and display a known-endpoint milestone without an inferred duration. The status of a persisted plan is explicitly selected by an administrator.

## Planning interactions

Known planned bars can be moved horizontally, resized with their edge handles and reordered with a row handle. Releasing a changed gesture saves the planned board. Pointer cancellation or Escape abandons the gesture without writing. Date/time editing and row up/down controls provide keyboard and mobile alternatives. Actual bars are read only.

The administrator can explicitly add a planned goal or add the missing goal to an unscheduled actual group. Initial actual groups are a read-only derived view until an explicit planning operation; loading does not create plans. Missing objectives are labelled rather than inferred from actions/results. Counts describe loaded actual records, and pagination does not imply complete history when more records remain.

Undo submits the previous planned rows against the current schedule version with a new request ID. It creates a retained planned revision rather than erasing history. Failed saving restores the last confirmed schedule. An uncertain retry retains the exact request ID and payload. A version conflict requires an explicit reload before applying another change; no newer plan is overwritten. Session revalidation conceals and disables the private workspace, cancels gestures and confirms the role before refreshing. Logout, expiry and page departure clear private state and late responses cannot revive it. Private drafts or plans are never stored in localStorage, sessionStorage or browser history.

## API contract

All endpoints use the existing administrator session, startup/rate boundaries, origin checks and no-store responses. No credential, role or security setting is added.

- GET `/api/dot-progress/schedule?date=YYYY-MM-DD` returns `{success:true,schedule:{date,version,rows,updatedAt}}`. An absent date board returns version 0 and no persisted rows.
- PUT `/api/dot-progress/schedule/:date` takes `requestId`, current `version` and the full `rows` array. It returns the saved schedule. The date is a strict Taipei calendar date.
- GET `/api/dot-progress/schedule/:date/history?offset=0` returns retained before/after snapshots with `history`, `total`, `limit`, `offset`, and `nextOffset`.

Each planned row has `id`, nullable existing `projectId`, required safe `projectLabel` (160 characters) and explicit `goal` (4000), `plannedStart`, `plannedEnd`, `status` (`planned`, `active`, `waiting`, `done`) and `actualIds`. Planned timestamps are both null or both known ISO timestamps with timezone; a known span is chronological, at most seven days and overlaps the selected Taipei date. At most 50 rows and 500 total actual references are accepted. Row IDs are unique and an actual record belongs to at most one planned row. Referenced projects and actual records must exist. Text uses the existing private-text safety validation; the existing 256 KiB request-body ceiling also applies.

Per-actor request receipts preserve the original successful reply across later edits and restart. Reusing an ID with changed content or sending a stale version returns 409. Rows, revisions and receipts commit atomically under a dedicated schedule lock with the existing transaction pattern; first writes to an absent board serialize as well. The schema adds only independent schedule tables, preserving actual work tables. Protected non-production debug metadata extends the existing diagnostic route, while production remains concealed.

## Validation

Synthetic PostgreSQL and fresh Chrome regression coverage exercises version races, rollback/restart, deduplication, unchanged actual records, dragging, resizing, ordering, Undo, failed/uncertain saving, conflicts, cancellation, logout/revalidation, browser return and 390/desktop layouts. Production checks use anonymous contexts and compare released assets, privacy boundaries and the unchanged completed-result projection. Real administrator acceptance can use the owner's existing normal browser session without credential extraction.
