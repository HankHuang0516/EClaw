# dot progress decisions and project review

The complete available skill catalog and installed skill/plugin directories still do not contain `simplify`. It was not executed. The user explicitly clarified that the existing manual substitute applies to subsequent work on this progress page. This change is reviewed for code reuse, quality and efficiency, with functionality, permission and browser verification. Other UI surfaces retain their existing requirements.

## Code reuse

- Reuse the existing portal authentication/admin role, PostgreSQL pool, transaction wrapper and no-store/cross-origin guards. No new credentials, bindings, callback changes or permission grants.
- Decision records have independent versions, so a decision comment cannot overwrite a project edit. Project row locking serializes cancellation against decision mutations.
- Page modules share safe text rendering, request/epoch handling and submission guards. Private loaded state is cleared with logout and role/session loss.
- Review records are append-only, with the existing request-ID retry convention. The sidebar holds visible work records; it has no connection to assistant internal memory.

## Quality

- Adoption starts off. Server-derived actor/time and the displayed recommendation version are preserved in immutable audit events. Revised content invalidates prior adoption; generic project edits/imports cannot forge these fields.
- Any alternative comment on the current suggestion conservatively requires clarification, invalidates adoption and blocks a conflicting switch. No semantic guess or external execution occurs.
- Stale writes return 409. Drafts remain available and retry requires explicit review of the newest content/version. Duplicate comments are retained once, even after a lost response.
- Cancelled/archived states retain records and audit, are distinct from completion and cannot appear in the public projection. Cancelled projects cannot acquire new decisions or adoption.
- Public output remains the explicit completed title/summary/date allowlist. All new reads/writes require the existing administrator session. Only synthetic fixtures belong in this public repository.
- Review records retain original words, occurrence date, source and scope. Correction comments never rewrite the original record. Supplied occurrence dates are distinct from server storage timestamps.

## Efficiency

- Tables/indexes initialize idempotently in the existing locked transaction; existing progress rows are never re-imported or overwritten.
- Decision and review reads are bounded; clarification checks cover all current-version comments independently of rendering limits.
- Private records are requested only after role confirmation. Mutations update their local view without discarding unrelated project or comment drafts.
- Desktop sidebar and dismissible mobile drawer share one journal. No additional service, daemon or polling of conversations is introduced.
- Generation guards prevent a slow decision/review GET from replacing a newer saved record. Pending mutation controls preserve draft contents; a comment after adoption is saved and moves the suggestion to clarification.

## Verification

- Backend checks: 42 cases across project, decision and review suites, including three disposable PostgreSQL suites for rollback, concurrent creation/comments, adoption/comment/cancellation races and restart persistence. The final date-precision change passed the complete 12-case review suite.
- i18n syntax/assets: 17 cases; fallback chain: 9 cases; strict referenced-key check passes. New page vocabulary is synchronized across 14 canonical Web locales, with zh-TW using the existing canonical zh fallback.
- Fresh synthetic Chrome covers anonymous/nonadmin access, immediate switch and repeated clicks, stale revision recovery, changed-suggestion invalidation, alternative comments after adoption, delayed GET races, frozen submission inputs, retained unrelated drafts, sourced immutable review records and corrections, Escape/backdrop dismissal, cancelled/archived filters, session expiry and open-sidebar logout. Mobile 390 px and desktop 1280 px screenshots were visually reviewed.
- Full backend ESLint: zero errors, nine existing warnings. Source syntax and whitespace checks pass.
- Complete local Node20 run: 498/501 suites and 6776 cases passed together; three unrelated timeout/socket failures passed individually (3 suites, 55 cases). Those original full-run failures remain part of the evidence; no assertion was relaxed. A first restricted run was stopped after EPERM on synthetic HTTP listeners, then rerun in the authorized loopback test environment. Official PR CI remains the merge gate.
- Earlier combined backend trials had one waiting timeout and one non-reproduced memory-fixture 404. The final combined run passed; their exact cause was not diagnosed or claimed fixed. Test-only PostgreSQL statement timeouts bound fixture waits; production settings are unchanged.
- Production checks use a fresh anonymous browser. Existing-record corrections and historical permission entries use the normal authenticated administrator UI, never copied cookies/tokens or committed private data.
- The review sidebar is workspace navigation for a private journal, rather than a chat detail card. It does not copy journal content into browser storage or forward it to chat.
