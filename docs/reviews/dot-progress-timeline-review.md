# Private work timeline review

The existing dot-progress manual substitute applies while simplify is unavailable. This review did not run or claim that skill. Instruction and memory files remain read-only by the user's instruction.

## Reuse, quality and efficiency

- Reuses the existing admin session, current-role middleware, origin guard, locked schema startup, transaction wrapper, safe updated-date helper and UI request/busy/freeze helpers.
- Adds three scoped PostgreSQL tables for intervals, retained versions and immutable retry receipts. Optimistic version checks prevent stale overwrites; one feature advisory lock serializes receipt checks and mutation. Read pagination uses a consistent transaction snapshot.
- Loads the sidebar only on explicit opening. Bounded descriptions, seven-day intervals, safe public evidence, explicit list/history pagination and a bounded local JSON preview keep the surface limited.
- Preserves project cards, push counters, decision/review data, demo shares and existing browser-return geometry. All committed fixtures are synthetic; historical owner records are supplied separately through the private UI.

## Ten-item review

- ✅ A1 Logic trace: fresh admin checks precede every timeline read/write; validated create/update commits interval, revision and receipt atomically. Exact retry returns the committed receipt; different reuse or stale version returns 409. Logout/expiry and generation changes discard late UI responses.
- ✅ A2 Test coverage: timeline 11/11 including real PostgreSQL concurrent create/update, rollback and restart; existing-role integration 9/9. Integrated progress, sharing, route and i18n regressions pass, with the separate existing demo PostgreSQL test intentionally opt-in. New synthetic timeline Chrome checks cover lazy reads, filters, pagination, revisions, optimistic drafts, import retries, locales and session clearance. Existing full UI, demo manager and 50 browser-return/push checks pass.
- ✅ A3 Return shape: successful routes use `{success:true,...}`; failures use short `{success:false,error}` codes. Unavailable storage returns the existing 503 convention without a memory fallback.
- ✅ A4 Scope: future records must be explicitly supplied through the private UI/API. This feature does not infer activity from chats, email, polling or unverified gaps, and does not calculate productivity totals.
- ✅ A5 Security: real auth middleware tests cover missing/tampered/expired cookies and revoked roles. Origin gates, strict milliseconds/calendar/span validation, bounded plain text, rejected obvious secrets/email/private paths, raw exact evidence allowlist and text-node rendering are asserted. The public completed projection and production-disabled debug gate remain intact.
- ✅ B1 API help: zh/en timeline intents and all four endpoints added to the existing protected help category. No real bot credentials were used to invoke help; examples and static syntax were inspected.
- ✅ B2 Docs: root README, progress guide and new timeline contract updated; regression registration recorded in this guide/review. No backend README exists. Existing review receipts remain historical. Instruction/memory files and scheduled tasks are unchanged under the explicit user constraint.
- ✅ B3 i18n: 40 keys across all 14 canonical web locales, including en/zh/zh-CN/ja/ko; shared tables match the scoped source and zh-TW retains its existing alias fallback. Syntax, key-reference and duplicate checks pass.
- ⚠️ B4 Info/promo NO-OP: the portfolio index already links the progress workspace without advertising private features; the portal info surface contains no timeline copy. The requested feature is the admin sidebar.
- ✅ B5 Debug: existing non-production dot-progress debug adds bounded entry/revision/receipt counts without owner summaries, evidence or identity values.

Result: locally validated; release remains subject to the exact-head required PR CI gate, main CI and production checks. Actual signed-in import/readback belongs to the owner's existing authenticated browser session.
