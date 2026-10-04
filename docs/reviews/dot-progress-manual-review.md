# dot progress manual code review

The `simplify` skill was unavailable in the complete skill catalog and installed skill/plugin directories. It was not executed. The user explicitly approved a one-time replacement with manual code reuse, quality and efficiency review plus functionality/permission tests before commit, PR and deployment.

## Code reuse

- Reuse existing portal cookie/session and server admin middleware. No authentication configuration, new token, admin grant, entity registration or callback changes.
- Reuse the existing PostgreSQL pool and static AiHankApps routing/cache policy. No new service or browser storage of private records.
- Shared request, safe text-node, form, busy-button and transaction helpers cover edits, comments, history and import.
- Dedicated page vocabulary avoids loading the large portal dictionary on a public portfolio page. The same 70 keys are covered in every existing Web locale for strict repository i18n checks; zh-TW inherits the identical canonical zh values.

## Quality

- Public projection is an explicit title/short-summary/date allowlist, independent of private goal text.
- Public Git repository contains only approved completed seed records and synthetic test fixtures. Private initial import is owner-only, outside the repository, and requires the existing admin UI.
- Strict body/object/date/enum/size validation returns scoped machine errors. SQL/query details and enriched authentication fields do not escape.
- Optimistic versions and atomic before/after history preserve edit safety. Comment request IDs deduplicate retries. Imports preview before one atomic apply.
- Review corrections: malformed JSON/body returns 400; publication field bounds match the API; logout suppresses session checks while pending and clears private state afterward; file selection changes invalidate pending import previews; conflict recovery retains the draft and displays the latest version before explicit retry.
- Existing debug namespace disables diagnostics in production, with an additional admin check and counts/recent metadata only.

## Efficiency

- Locked lazy schema initialization runs once per pool, inserts seed IDs only when absent and never replaces edits on restart.
- Private content is requested only after fresh admin role verification. No polling of all Codex conversations or entities.
- API responses are no-store. Browser request timeout and epoch guards reject stale responses. Submitted controls disable repeat writes while pending.
- No full-history payload in initial page load; comments/history load on demand and are bounded. Import/project/text limits are checked at the boundary.

## Evidence and limits

- Progress backend: 19 tests, including disposable real PostgreSQL failed-import rollback, concurrent version conflict/comment deduplication and new-router persistence.
- Real existing auth integration, public assets, exact login return path and i18n syntax: 25 tests.
- Fresh synthetic browser: anonymous/nonadmin boundaries, safe text rendering, 390 px layouts, admin edits, repeat click, retained 409 draft, comment readback, before/after history, import preview/apply and selection race, explicit publication, expiry, delayed logout/focus/refresh, locale switch.
- ESLint: no errors; existing warnings remain. Strict i18n reference check passes.
- Full local suite: 494 of 497 suites passed together; three transient socket/timeout suites passed individually on retry (42 tests). Initial in-band attempt hit its heap limit after 217 passing suites; the bounded worker run completed. Required PR CI must still pass before merge.
- Production admin operations and initial private import require a normal existing authenticated UI session. No cookie/token values are retrieved for this workflow. Previous private Site history has not been exported or claimed migrated.

- PR CI found a redundant zh-TW override expansion that violated the established small-override invariant. Removed identical new overrides and reused canonical zh fallback; the guard was kept intact.
