# Daily Gantt follow-up review

This completes the requested daily visualization using the merged private timeline. The existing manual reuse/quality/efficiency substitute applies; simplify was not run. Instruction/memory files remain read-only.

- ✅ A1 Logic: the Today control selects the current Taipei date through the existing filtered load. Bars use loaded records only, clip to the day and label zero-duration points. Mutations, page loads and locale changes repaint the chart without replacing drafts. Clearing the session removes chart content.
- ✅ A2 Tests: 87 synthetic browser checks pass for today selection, clipping, point markers, partial/empty days, text escaping, locale/privacy, mobile layout and separate goals. Assets/i18n 19/19 pass. Timeline 14/14 including actual PostgreSQL tests verify the old-schema migration, null-start conversion and known-endpoint filtering, retain goals through edits/restart and preserve legacy canonical receipts; existing safety validation rejects unsafe goals.
- ✅ A3 Shape: the existing safe interval contract gains an optional explicit `goal` and explicit null-start milestones with a required known endpoint; absent legacy goals are omitted rather than defaulted so old retry receipts remain exact. The chart performs no separate request and uses existing JSON persistence/history.
- ✅ A4 Scope: unrecorded gaps and work-hour totals are not inferred. Loaded/total counts explicitly describe partial data.
- ✅ A5 Security: chart remains inside the existing concealed admin workspace; labels are text nodes and layout numbers come from validated interval timestamps. Logout/expiry clears chart content.
- ✅ B1 API help: existing timeline example documents the optional explicit goal and null-start milestone; no new endpoint.
- ✅ B2 Docs: the timeline guide now describes Today, clipping, points and partial data.
- ✅ B3 i18n: eight additional keys in all 14 canonical locales with shared-table parity; zh-TW keeps its alias fallback.
- ⚠️ B4 Info/promo NO-OP: private admin visualization; generic portfolio entry remains accurate.
- ⚠️ B5 Debug NO-OP: existing protected non-production timeline counts still cover the same records; no new raw-data debug surface is added.

Result: release requires green targeted browser/assets checks, exact-head required PR CI gate, normal merge, main CI and production verification.
