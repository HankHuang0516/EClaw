# Fraud Empire Demo-only private reports

This is a temporary Demo feature, not an account, cloud-save, analytics or formal-game feature.

- Intake: `POST /api/fraud-empire/demo/reports`.
- Private storage: existing EClaw PostgreSQL pool, dedicated `fraud_empire_demo_reports` table.
- Private reads: `/api/admin/fraud-empire-demo-reports` and `/:id`, behind the existing session authentication and administrator check. No public report read endpoint.
- Diagnostics: `/api/debug/fraud-empire-demo-reports` and `/:id` reuse the same private read router and administrator checks. They return 404 in production unless the existing Railway environment is explicitly `debug`; the production admin read path remains available to authorized maintainers.
- Discovery: `/api/help?intent=fraud-demo-feedback` describes the explicit-submit intake and both protected read paths. Examples use local payload/cookie files, never embedded credentials or report content.
- Do not reuse `/api/feedback`: it captures unrelated logs/device data and may create GitHub issues.
- Freeze the whitelist snapshot when opening the form. Preview the capture timestamp and submitted fields. Do not dump model state, undiscovered branches, story flags, browser storage, credentials, cookies, tokens, other pages or desktop screenshots.
- Description, category and snapshot become immutable for the same report ID at its first valid send. Retry that exact payload and ID. The server confirms a real database row before success. Conflicting payloads under one ID are rejected.
- Closing, cancelling, typing, previewing and sending do not invoke task exit, failure, settlement, reward or clock handlers. Unknown or uninitialized values stay explicit.
- No automatic GitHub issue, broad log capture, device capture or report-content logging. Historical private reports are not subject to Demo removal.

## Required delivery acceptance

Desktop keyboard and mobile touch; empty description; cancel without state/clock/value change; double click; offline retry with the same ID; cross-scene frozen snapshot; actual server save followed by authorized same-ID readback; unauthenticated and non-admin access denial. Verify the real existing private read capability used by the maintainer before claiming reports are usable for research. Mock-only success or local storage does not meet this gate.

## Mandatory formal-game release checklist

- Remove the settings/report entry and its markup, not just its CSS visibility.
- Exclude `demo-feedback.js`, `demo-feedback-model.js`, `demo-feedback.css`, all imports and all report transmission code from the actual formal artifact.
- Inspect the actual formal artifact and its network behavior, not only source settings or an older build.
- Retain existing private report rows for development; do not delete history when removing the Demo feature.
- No formal-game artifact exists in this website release. This checklist is a future release gate, not a claim that a formal build was inspected.

No new credentials, role grants, paid service or public report repository is authorized by this feature.

The intentionally anonymous Demo intake is an explicit user-submitted feedback channel, not an owner/account mutation. It has a strict payload whitelist and an eight-request-per-ten-minute IP limit. Private reads require the existing authenticated administrator role. Storage failures return 503 without a saved receipt; invalid payloads return 400 and conflicting reuse of one ID returns 409.

Visible media IDs include the currently rendered HTML img and SVG image references, checked against the release media registry. An ID identifies the reference, not a claim that it decoded successfully; artwork reports retain known references even when an image is loading or broken. Off-screen or hidden candidate resources and arbitrary URLs are excluded.

Native Demo dialogs provide a temporary report entry. The top visible source dialog is captured rather than the inert background. Expanded proposal images retain their rendered candidate/frame provenance; image-only references never borrow another game model. Closing or cancelling the report must preserve the underlying source dialog and game state. These injected entries, the observer, imports and transmission code are all excluded from formal artifacts.

The reporter retains at most 12 action-attempt IDs per current Demo context in an in-memory, bounded ring. It does not record text input, cookies, browser storage, network logs or other pages, and sends nothing before explicit submission. Disclosed current selection IDs and the available raw piece-rotation scalar are allowed; null is unavailable/not selected, never inferred zero. Attempts do not claim successful game commits or rewards.
