# Report synchronization and release policy

## Required daily path

Run `zsh scripts/run-daily-report.zsh` from the canonical portfolio. It collects
the full store inventories and review snapshots, synchronizes the catalog,
downloads Google/Apple/AdMob history, runs report regression tests, then prepares
an immutable private report release. Do not call the old standalone builder or
manually fabricate an API response when a required step fails.

- Use only publisher `pub-7927361926882871`. Credentials are resolved at runtime
  from the existing Keychain/private credential references; never publish them.
- Every raw run and historical snapshot is append-only. Keep legacy USD files;
  TWD replacement must cover every historical date before a TWD-only aggregate
  can be released. Snapshot ranking uses explicit collection provenance first.
- Apple plain/gzip pairs are the same logical report, not extra downloads.
  Updates, redownloads and IAP are not first downloads. Google monthly overview
  snapshots replace prior versions, rather than being summed together.
- An explicit official report-not-published response is unavailable, not zero.
  Authentication errors, incomplete responses, wrong schemas and corrupted files
  stop publication. Missing crash-rate or ANR-rate rows mean the official sample threshold was not met; they never mean zero.
- All canonical catalog apps appear in reports, including newly added apps with
  unknown metrics. Keep names, categories and community IDs identical.
- Google user installs, Apple first-download units and crash/ANR events have
  different definitions. Never combine them into a unique-person statistic.
- AdMob legacy ID 3214882892 belongs to typeforge-twin-cities, confirmed from
  word-civilization-td/Assets/GoogleMobileAds/Resources/GoogleMobileAdsSettings.asset
  and ProjectSettings/ProjectSettings.asset on 2026-09-08. Unrecognized future IDs
  remain in explicit unallocated revenue, never fuzzy-matched or discarded.

## Daily versus weekly history

Daily collection refreshes current/previous Google months and the past 35 days
of Apple/AdMob reports so delayed reports are retried. Monday collection requests
Google history from 2023-01, Apple from 2026-08-01, AdMob from 2026-01-01, the
configured historical windows. Retain older already-stored data indefinitely.
These are collected-history totals, not a claim of complete lifetime coverage.

## Stability-rate and trend presentation

- Public stability metrics use Google Play Developer Reporting API crash rate and ANR rate, expressed as percentages of distinct users. Legacy crash/ANR event counts remain private migration history only.
- Vitals responses are stored as append-only dated snapshots. Empty API rows are preserved as sample-insufficient evidence and are never converted to zero.
- Daily stability queries end at D-3 because Google rejects an inclusive end date equal to its D-2 freshness boundary; later dates are a fail-closed scheduling error, not a zero-rate observation.
- Summary cards with no current official value are hidden. Per-app tables retain the field and explain why it is unavailable.
- Google user installs and Apple first downloads may be combined only as an explicitly labeled cross-platform visual trend. Their definitions differ, missing source dates are not zero-filled, and the result must not be described as unique people.
- Chart time range is controlled directly by zoom and drag. Granularity automatically switches among day, week, month, quarter, and year.

## Public APP trends experience

- The user-facing report name is `APP 趨勢`; it is refreshed by the daily 09:00
  Asia/Taipei synchronization rather than presented as a weekly-only report.
- Historical charts expose separate daily-change and per-APP cumulative views.
  Never combine Google user installs and Apple first-download units into one
  people count. The selected metric remains explicit.
- Time controls live on the chart: wheel zoom and horizontal range selection
  update the visible window. Display granularity changes automatically between
  daily, weekly, monthly, quarterly and yearly buckets. Start and end dates are
  derived read-only labels, not manual inputs.
- Missing values must explain their cause. Use `不適用` for a platform the APP
  does not support, a source-specific pending label for delayed/absent official
  reports, and numeric zero only when an official observation confirms zero.

## Release sequence

1. Complete the daily path; retain the returned private release directory.
2. Follow GUIDE_SYNC_POLICY.md and merge current registered guide sources.
   Preserve all recovered original introduction/guide content. Publish changed
   standalone guides first and perform the existing real guide freshness checks.
3. Run `node scripts/report-release.mjs --apply RELEASE_DIRECTORY`. It validates
   the catalog and every artifact hash, then applies the identical report bundle
   to root reports, public/reports and the EClaw deployment route. A copy error
   rolls back every touched target. Rebuild if the catalog changed in step 2.
4. Run `node scripts/report-release.mjs --check`, the guide prepublish gate and
   the normal build. Required CI must pass before merge/deployment.
5. Deploy both existing sites from the exact validated source. Compare their
   public reports/release.json plus data.js, index.html and report-view.js hashes.
   Do not claim both deployments succeeded from only one successful deployment.
6. Announce concrete new information and public URLs for every deployment.

Keep the previously published release when preparation, checks, CI or deployment
fails. Never bypass a gate, publish an empty replacement or erase history to make
the next run green. Public release.json contains only aggregate artifact hashes;
source-audit.json and collection logs stay private.

## Current integration status

The full daily path completed successfully on 2026-09-08. Private legacy
wrappers and existing 09:00 automation app now use the canonical scripts.
All report regression tests and local release-integrity checks passed.
Public CI, merge and deployment are still pending; this is not deployment evidence.
