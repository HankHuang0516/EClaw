# Progress workflow and push review

The existing dot-progress manual substitute applies while simplify is unavailable. This review did not run or claim the skill.

## Reuse and quality

The change retains existing admin/session/cross-origin gates, private request epoch checks, project editors, decision audit and PostgreSQL transaction helpers. Push counters and actor/request receipts are independent of editable project JSON and optimistic versions. A locked project transaction commits one atomic increment and its deduplication receipt; a repeated actor/project/request ID returns current persisted totals. Closed projects can receive a signal without reopening or publishing.

Workflow cards show the explicit project status, completed work, blockers, next step and decision controls. Older rows have no inferred completed work. Short previews retain full original values in expandable detail and editors; historical before/after values include explicit completed work. Decision adoption remains separate from work approval or execution.

## Efficiency and interaction

Every deliberate click receives its own in-memory UUID queue entry. Transport failure keeps that original operation ID for an explicit retry; later clicks remain distinct. Scalar receipts update current card nodes in place without erasing edit/comment drafts. Per-project monotonic counters survive UI rerenders and prevent stale reads from decreasing displayed totals. Logout/expiry clear private queue and DOM; no browser persistence stores private records.

Six content-versioned resource URLs refresh together, retaining the existing no-store HTML policy. New vocabulary follows every existing canonical locale and zh-TW fallback. Existing unrelated sources and processes are untouched.

## Validation

Owner receipt: focused Jest (including optional disposable PostgreSQL concurrency, rollback and restart), fresh synthetic Chrome at 390px and desktop, strict i18n, syntax/lint and required official CI. Exact totals and production results are recorded with the PR and task-local evidence. Fixtures are synthetic; no real task prose or Demo data is committed.
