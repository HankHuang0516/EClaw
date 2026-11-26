# Single isolated scheduled-source → native projection acceptance

**Historical 22-check milestone:** the later [SQL lifecycle/client acceptance](stray-map-release-readiness.md) adds persistent source state, deduplication and photo permissions plus a non-formal browser specimen. The older runner below was not rerun. Its unimplemented SQL lifecycle limitation is superseded only in the new explicitly enabled private runner; production and actual App UI remain unverified.

The private backend path now exercises registered synthetic API GETs through the **existing** 15-minute `scheduledPass` function, PostgreSQL pending receipts, manual review, a native Fastify list projection, the existing `/a/:UUID` sharing route and withdrawal. This is an unsigned reconstruction extension under Draft5527. It is not deployed, does not verify an official intake, and changes no production data, credentials, roles, terms or on-machine patrol. No timer or Mac task is installed; fixture clocks invoke the actual scheduling function.

## Native integration and compatibility

The preparer's 54-file baseline and original 31 compiled outputs remain intact. `build-native-entry.cjs` checks the original emitted entry SHA and creates a new labelled entry under the private generated API workspace. Only relative-import rebasing and an explicit extension bootstrap are added. Its unsigned provenance receipt records both entry hashes and the exact changes. The extension reads the same PostgreSQL pool as the captured native server, while external input/receipts/public content/photo proof live only in `rebuild_external`. **No device, native animal or native sighting rows are seeded or created by this flow.**

The captured App contract requires numeric latitude/longitude, instant `lastSeenAt`, native status/condition enums and a device-based read handler. An external LOST/FOUND with only a region and DATE cannot satisfy that DTO truthfully. The default `GET /v1/animals` and all native mutation/detail/auth/terms handlers are preserved. The explicit opt-in `GET /v1/animals?view=external-origin-v1` returns a new envelope:

```json
{
  "success": true,
  "schemaVersion": 1,
  "view": "external-origin-v1",
  "nativeIncluded": false,
  "externalLeads": [],
  "mapMarkers": []
}
```

This public external-only view completes in a route `onRequest` hook, including HEAD, after existing rate limiting and before device handling. It never reads or returns protected native rows. Legacy callers without this view continue through the original handlers; native POST still requires device identity/current terms. The dedicated synthetic pending endpoint is `/external-rebuild/v1/tips`, outside the original App `/v1` middleware. It does not exempt/reuse the native posting path or pretend an App device submitted an external lead. The formal `/v1/public/tips` draft is not enabled by this test path.

**App source remains unavailable; App UI was not exercised.** The old App cannot be assumed to request/understand the new envelope. The [machine-readable external view schema](stray-map-native-external-view.schema.json) is validated against actual native HTTP output. The actual captured legacy contract is checked: the external DTO intentionally fails legacy AnimalSummary parsing because no numeric position/instant/status is invented. Production adoption therefore includes an explicit versioned client-contract decision, followed by real App integration/QA when source is available. Existing native IDs take precedence on sharing even if deleted or missing a sighting; external projection cannot resurrect/shadow a native record.

## Projection and review boundaries

Each tip receives an independent persisted opaque public UUID, separate from its private source key and immutable pending receipt. The native projection queries only APPROVED, location-safe rows with an explicit reviewed public-content artifact. It revalidates the original payload hash, current registered policy, sanitized self-made pixel proof and reviewed text before list/share/photo reads. DB/query errors fail as errors, not fake empty-source counts. At this historical milestone the SQL scheduler did not implement source closure/outage/matching; the newer release-readiness runner enables those private SQL extensions explicitly.

Private operator review uses an owner-only Unix socket. Mandatory content/language/privacy/source/rights/location checks and current proof validation occur inside the row-locked PG transaction. A separate bounded public-content artifact preserves the reviewed source locale and removes private input from titles/descriptions/captions. Conservative contact/URL/coordinate text checks supplement manual review; they are not universal PII detection. Raw input, publisher/dataset/stable source keys, rights references and unreviewed captions are never used by the native renderer.

The shared external visibility function governs the opt-in native list, existing `/a/:UUID` external share and `/external-media/:publicUUID/:photoUUID`. Sharing uses a separate renderer rather than the legacy renderer's forced point/UTC-time/map/deep-link behavior. Five UI label dictionaries (`en`, `zh-TW`, `zh-CN`, `ja`, `ko`) coexist with the approved original text locale. HTML is escaped, URLs are server-generated, headers are `no-store`/CSP/nosniff/referrer restrictions, and no personal source links are published.

LOST uses LAST_KNOWN; FOUND uses FOUND_AT plus separately source-reported care/asOf; SIGHTING uses OBSERVED_AT. None implies present care location or reunion. DATE remains a date with its declared zone; UNKNOWN stays unknown. Public location has country/coarse region and `coordinates:null`. All current external fixtures have no trusted point, so **all external map pins are absent**, including reviewed safe sightings. No region centroid, `(0,0)` placeholder or UTC midnight is supplied. Pending/rejected/habitat/unknown-region records never appear as public shares/pins. Withdrawal makes old sharing/image GET and HEAD URLs unreadable and leaves original receipts stable.

Photos are locally generated pixels with server-bound synthetic explicit permission and byte hashes, processed by the captured storage provider and actual pinned Sharp codec. Stored files are outside the served native upload folder. The fixture API supplies only an upload reference; an unverified image URL is refused and is never fetched. This does not prove any real author's rights, face/plate/wildlife-location review or production storage moderation.

## Reproduction and evidence

Complete [preparation](../tools/stray-map-rebuild/prepare.md) first. Verify ProjectsData and keep the 20 GiB system reserve; this incremental run has a 1 GiB additional-space budget and uses the already-present PostGIS image without pulls. From the existing worktree:

```sh
python3 /Volumes/ProjectsData/check_storage.py
/Users/hank/.local/bin/project-storage check --required-gib 1
/Volumes/ProjectsData/portfolio-private-staging/20261126-stray-map-isolated-rebuild/toolchain/node-v22.23.3-darwin-arm64/bin/node \
  tools/stray-map-rebuild/run-single-path.cjs \
  /Volumes/ProjectsData/portfolio-private-staging/20261126-stray-map-isolated-rebuild
```

The runner creates only its own labelled synthetic PG container/network and loopback native process, applies all 12 unchanged migrations, inherits no credentials/real HOME/temp path, and enforces the native process's existing environment/loopback guard. New entries, images, records, logs and result files stay private. Only its own resources stop in `finally`; stopped DB/evidence remain for current acceptance.

| Milestone | Actual evidence |
| --- | --- |
| First source round | Two registered fixture API GETs, eight independent pending PG receipts; no list/share/photo visibility. |
| Repeated/early tick | No GET/POST in the same slot or at 14:59.999. |
| New process | PG poll slots suppress a repeated round; original receipts read unchanged. |
| Next 15-minute round | A further process and new fixture-server ports GET the same source keys; native HTTP receiver returns original receipts/replay, no new tips. |
| Review | Missing checks fail; private raw contact/address/caption inputs do not project; four safe reviewed external leads appear through the native view and `/a/:UUID`, with actual sanitized photo bytes. |
| Hidden cases | Pending/rejected/habitat/unknown-region rows have no share or pin. All coarse-only records have null coordinates and zero pins. |
| Withdrawal | LOST/FOUND disappear from native list; both shared URLs and image GET/HEAD return 404; a fresh process at the next 12:30 test-clock slot actually GETs/POSTs the same records and cannot republish them. Native device/animal/sighting counts remain zero. |

Private root: `/Volumes/ProjectsData/portfolio-private-staging/20261126-stray-map-isolated-rebuild/`. Per-run `single-path-<id>/RESULT.private.json` is written only after all checks. `NATIVE_ENTRY_PROVENANCE.private.json`, numbered scheduling/reopen/review milestones and `CLEANUP.private.json` provide reproducible evidence. First actual run: `single-path-2fa5699c`, 19 named checks pass. Final run: `single-path-22f03808`, 22 named checks pass, including actual response-schema validation, native HEAD and a real inherited 429 rate-limit refusal. Three fresh child processes verify PG slots/receipts and the next actual source GET/POST after withdrawal. Native/device/sighting counts stay zero. All owned resources stopped; evidence remains private.

Final local regression: **370/370 tests, nine suites**, forceExit=false/detectOpenHandles: prior six suites 288, PG scheduler 42, native schema 14, native view/privacy/hooks 26. All 16 reconstruction/scheduler JS/CJS files lint with zero errors/warnings. The limited independent review supplied the inherited-auth/HEAD fix and found no further concrete issue; main owns the added tests. Source/receiver caller assertions in the scheduler bridge are private runner ownership assertions, not production authentication.

## Review and formal decision

A1 state/auth/visibility paths traced; A2 shared-mock PG/contract/hook tests plus actual native Fastify/PostGIS/fresh-process flow; A3 bounded success/error envelopes (legacy shapes unchanged); A4 original-source/full-equivalence, real source/photo safety, client adoption/UI and formal authority remain open; A5 no native identity/write impersonation, exact external-only view, private review and shared read suppression. B1 product help and B5 product debug are NO-OP: isolated generated extension only. B2 README/AGENTS/CLAUDE/intake/rebuild docs are updated. B3 five label locales plus original locale retention; B4 no product promotion claim or deployment. H/icon: no applicable product icon/release artifact; no publish occurred. Simplify is optional.

The minimum formal decisions are whether to adopt/review this labelled reconstructable backend plus explicit external-view contract, and authorize the dedicated official intake/reviewer/limited terms exception through the existing release process. This private result does not grant those permissions. Real source/photo/operator acceptance and App integration still need concrete production validation; it is not safe to call the formal scheduled submission complete.

## CI worker memory bound

The first full push/PR jobs for `321bf9c8e` passed the new suites, but different existing suites lost workers after V8 heaps accumulated near 2 GiB. Private logs retain the fatal heap-limit messages and failed-suite lists. CI now uses two workers and recycles an idle worker above a fixed 512 MiB; local defaults are unchanged. The complete test selection and coverage remain enabled. `--showConfig` confirms `maxWorkers:2`, `workerIdleMemoryLimit:536870912`, `collectCoverage:true`; the 370 scoped tests also pass with CI coverage enabled. The installed Jest is 29.7.0; recycling is its [documented worker memory option](https://jestjs.io/docs/29.7/configuration#workeridlememorylimit-numberstring). This test-infrastructure change does not alter native/API runtime behavior or deployment gates.
