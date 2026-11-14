# Wishlist operations in the admin hub

`/AiHankApps/hub/#app-weesh` starts with current listing statistics and two separate rolling-hour workload metrics: completed retail lookups and CP evaluations. These may concern the same product and must never be added into a product total.

The monitor's `work-summary` supplies each metric's `last60Minutes` over actual completion timestamps in `(from, to]`, exactly 3,600,000 ms. The existing operations collector preserves only allowlisted numeric counts, coverage, freshness and bounds inside `workTotals`. Complete known zero remains zero; partial observations display a positive lower bound as `至少 N 件`. Missing or stale windows remain unknown. The moving right edge may not have passed the monitor's settlement interval, so an open window is not an exact count. Do not derive this card from a previous closed hourly bucket or cumulative-total differences.

The hub reuses `ops/ops-view.js`'s `WaveChart` for listing/retail/CP, AI workloads and CPU. Units, null gaps, range zoom, drag, keyboard inspection and cumulative-vs-period modes remain the operations page's behavior. The original public operations page remains functional; it explicitly opts into automatic page mounting. Shared chart instances disconnect resize observers and clear pending loads/gestures when the hub changes route.

The primary quantitative chart stays visible. Additional series, AI workloads, CPU, listing history, account details, infrastructure, store/portfolio statistics, retention and source details default to collapsed. The store date/comparison controls are inside that section, separate from waveform range controls. Opening an accordion is retained across in-page refreshes, without exposing private content outside existing EClaw admin authorization. No new write endpoint or authentication exception is introduced.

Validation covers source window shape, genuine zero versus unknown, lower bounds, stale/offline states, privacy projection, chart disposal and existing hub/operations regressions. Browser QA uses clearly labeled synthetic local data and then the deployed authenticated page. Catalog, guides, H icons and report artifacts are unaffected.
