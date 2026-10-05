# Private workspace goal Gantt

The goal Gantt stays at the top of the existing authenticated WORKSPACE, with project cards below. It follows the supplied AI layout reference without importing its illustrative projects, counts or times. Fixed goal labels sit beside the time axis; dashed planned bars, solid actual intervals, known-endpoint milestones and the current Taipei time line have distinct labels. Historical details are collapsed initially.

Actual timeline records, their versions/history, project data and push counters are independent and unchanged by every schedule operation. A recorded completed interval does not itself establish that a whole goal is completed. Unknown actual starts remain null and display a known-endpoint milestone without an inferred duration. The status of a persisted plan is explicitly selected by an administrator.

## Planning interactions

Known planned bars can be moved horizontally, resized with their edge handles and reordered with a row handle. Releasing a changed gesture saves the planned board. Pointer cancellation or Escape abandons the gesture without writing. Date/time editing and row up/down controls provide keyboard and mobile alternatives. Actual bars are read only.

The administrator can explicitly add a planned goal or add the missing goal to an unscheduled actual group. Initial actual groups are a read-only derived view until that selected group is explicitly edited; loading and reordering never create plans. Ordering saves only a separate ID list, keeping every persisted row unchanged. Missing objectives are labelled rather than inferred from actions/results. Counts describe loaded actual records, and pagination does not imply complete history when more records remain.

Undo submits the previous planned rows and display order against the current schedule version with a new request ID. It creates a retained planned revision rather than erasing history. Failed saving restores the last confirmed schedule. An uncertain retry retains the exact request ID and payload. A version conflict requires an explicit reload before applying another change; no newer plan is overwritten. Session revalidation conceals and disables the private workspace, cancels gestures and confirms the role before refreshing. Logout, expiry and page departure clear private state and late responses cannot revive it. Private drafts or plans are never stored in localStorage, sessionStorage or browser history.

Cancel editing discards the current unsaved form and its pending retry without an API write; it cannot cancel an already submitted save. Opening an editor explicitly focuses and brings that form into view. Plan-time errors refer only to valid dates/times, chronological spans of at most seven days and overlap with the selected date.

An existing saved plan can be archived and restored from the collapsed archived-plans list. This toggles only its archive flag, preserving its ID, status, timestamps, actual references and display-order position. It does not cancel/archive the underlying project or actual work. Derived unsaved groups cannot be archived. Archived rows retain their actual references, so hiding a plan does not recreate its actual group as a new unsaved row; actual details remain available.

## API contract

All endpoints use the existing administrator session, startup/rate boundaries, origin checks and no-store responses. No credential, role or security setting is added.

- GET `/api/dot-progress/schedule?date=YYYY-MM-DD` returns `{success:true,schedule:{date,version,rows,rowOrder,updatedAt}}`. An absent date board returns version 0, empty rows and an empty order.
- PUT `/api/dot-progress/schedule/:date` takes `requestId`, current `version`, the full `rows` array and optional `rowOrder`. It returns the saved schedule. The date is a strict Taipei calendar date.
- GET `/api/dot-progress/schedule/:date/history?offset=0` returns retained before/after snapshots with `history`, `total`, `limit`, `offset`, and `nextOffset`.

Each planned row has `id`, nullable existing `projectId`, required safe `projectLabel` (160 characters) and explicit `goal` (4000), `plannedStart`, `plannedEnd`, `status` (`planned`, `active`, `waiting`, `done`) and `actualIds`, plus optional boolean `archived`. Only `archived:true` is retained; false/absent have the legacy unarchived canonical shape. A new archived row is rejected, and an archive/unarchive transition must preserve every other row field. Planned timestamps are both null or both known ISO timestamps with timezone; a known span is chronological, at most seven days and overlaps the selected Taipei date. At most 50 rows and 500 total actual references are accepted. Row IDs are unique and an actual record belongs to at most one planned row. Referenced projects and actual records must exist. Text uses the existing private-text safety validation; the existing 256 KiB request-body ceiling also applies.

`rowOrder` contains at most 550 unique valid IDs for supplied saved plans or existing actual records used as derived-group IDs. A newly supplied order is validated without creating row metadata. An omitted order preserves the existing order exactly and stays absent from the request receipt payload for legacy compatibility; explicit `[]` clears ordering. An old client may remove a plan while preserving its old order ID; clients ignore unresolved IDs rather than inventing rows or pruning metadata.

Per-actor request receipts preserve the original successful reply across later edits and restart. Reusing an ID with changed content or sending a stale version returns 409. Rows, revisions and receipts commit atomically under a dedicated schedule lock with the existing transaction pattern; first writes to an absent board serialize as well. The schema adds only independent schedule tables and their display-order column, preserving actual work tables. Protected non-production debug metadata extends the existing diagnostic route, while production remains concealed.

## Validation

Synthetic PostgreSQL and fresh Chrome regression coverage exercises version races, rollback/restart, deduplication, unchanged actual records, dragging, resizing, ordering, Undo, failed/uncertain saving, conflicts, cancellation, logout/revalidation, browser return and 390/desktop layouts. Production checks use anonymous contexts and compare released assets, privacy boundaries and the unchanged completed-result projection. Real administrator acceptance can use the owner's existing normal browser session without credential extraction.

## Earlier ordering revision and recovery

The initial workspace release incorrectly promoted all explicit-goal derived groups into unscheduled saved rows when reordering. That wrote independent schedule rows/revisions only; it did not edit actual timeline, project or push tables. The corrected interface does not automatically change previously saved data, because an intentionally unscheduled plan is indistinguishable from such a promoted row without checking its revision history.

Use the owner's normal administrator session to read the schedule and paginated schedule history. Identify the first ordering revision and compare its `changes.before`/`changes.after` rows by ID; review newly inserted rows, unchanged genuine plans and later edits before proposing recovery. Do not infer candidates merely from null planned times or labels. An available Undo checkpoint restores only the last operation. After refresh or multiple edits, an owner-reviewed historical snapshot can be submitted as a fresh versioned schedule update; retained revisions and original request receipts remain intact, so that recovery is reversible. Never delete revisions, receipt rows or actual work to repair display metadata. This feature performs no production repair or automatic cleanup. Only owner-confirmed isolated QA plans should be archived during acceptance.
