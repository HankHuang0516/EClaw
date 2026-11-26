# Stray Map intake — draft v3 with v2 compatibility

**Production disabled; official intake API unverified; terms exception PENDING HANK APPROVAL.** `/v1/public/tips` is a contract proposal, not an implemented production endpoint. The isolated synthetic rehearsal creates no production write, credential, role, terms amendment or patrol/schedule change. Human App use stays unauthenticated; external clues never impersonate an anonymous App device.

The existing animal POST publishes immediately, and its photo queue is not a pending-tip queue. Its device-writing pre-handler is unsuitable for this draft. A historical/runtime file match does not establish the complete rebuild/release provenance needed to activate production intake. No live test pins, real source collection or production HTTP calls are authorized here.

## Versions and stable identity

| Version | Exact request keys | Condition meaning | Derived/public semantics |
| --- | --- | --- | --- |
| v2 | `schemaVersion`, `thirdParty`, `selfWitness`, `source`, `observation`, `animal`, `location`, `display`, `photos`; version exactly 2 | Original `UNKNOWN / ROAMING / INJURED / DECEASED` enum unchanged | `report.type` and `locationMeaning` are `UNSPECIFIED_LEGACY`; custody is UNKNOWN with UNKNOWN Temporal; `mapMarkerEligible: false`. No new sighting is inferred from old text or ROAMING. |
| v3 | The same nine keys plus required `report`; version exactly 3 | Health only: `UNKNOWN / HEALTHY / INJURED / SICK / DECEASED` | Explicit LOST, FOUND or SIGHTING semantics below. Health, report type and animal kind are independent. |

OpenAPI `Tip` is `oneOf: TipV2 / TipV3`. Every request object rejects unknown/missing fields. The v2 accepted payload, canonical payload/hash, `stray-case-v2` fingerprint and original immutable receipt remain unchanged. Legacy report semantics are a projection, never inserted into the old payload/hash. Existing filesystem snapshots stay version 1; absent `sourceState` is derived conservatively and `sourceEvents` is initialized lazily. No bulk rewrite or implicit schema upgrade is required. Compatibility regression inputs and their original payloadHash/candidateFingerprint are pinned in `tools/stray-map-intake/compat-v2-fixtures.json`, extracted with the pure contract at commit `2a722afd3f7bd12520231d6a4246e2a15e4ab34c`. Compare against those fixed values; do not regenerate expected hashes with current code or rewrite existing payloads/receipts to make a test pass.

Three identities remain separate:

- `(publisherId, Idempotency-Key)` controls retries. Same canonical hash replays the original PENDING receipt/time; different content conflicts. A pure RESERVE decision does not write storage.
- `(publisherId, datasetId, recordKey)` uniquely identifies a private source record, independent of URL. An identical record under another retry key reuses its receipt; changed content conflicts rather than overwrites. Independent records/counterparts retain independent receipts.
- Private candidate fingerprints are not confirmed duplicates or animal identities. V2 hashing is retained. V3 uses `stray-case-v3`, kind, **report type**, country, coarse region and observation local calendar date. Unknown time/region, sensitive cases and wildlife have no such fingerprint. Equal hashes never merge cases or verify reunion. DUPLICATE review across different report types, including legacy versus typed reports, is rejected.

## Shared input, policy and privacy

Use JSON UTF-8 with identity encoding and a **16,384-byte actual body limit**, including whitespace. Reject invalid UTF-8/JSON, duplicate keys including escaped duplicates, unknown properties and compressed bodies. The HTTP receiver caps streaming bytes; a pure validator sees only supplied bytes. `thirdParty: true` and `selfWitness: false` are mandatory. Clients cannot submit review/publication controls, device IDs/secrets, precise coordinates, addresses, geohashes or trusted upload/policy records.

| Object | Unchanged v2/v3 rules |
| --- | --- |
| `source` | Exact `publisherId`, `datasetId`, `recordKey`, `url`, `publishedAt`. Publisher/dataset slugs are `[a-z][a-z0-9-]{2,63}`; private record key is `[A-Za-z0-9_-]{16,128}`. Source URL is safe canonical HTTPS or null, never the unique key. Publication uses Temporal. |
| `animal` | Exact `kind`, `count`, `condition`. Kind remains DOG/CAT/OTHER_STRAY/WILDLIFE; count is integer 1–100 or null, never fabricated zero. Condition enum depends on version above. |
| `location` | Exact `countryCode`, nullable `regionCode`, `sensitivity`. Upper-case ISO2 country shape and coarse ISO3166-2 subdivision shape; trusted policy authorizes country/region. Sensitivity remains NONE/UNKNOWN/PROTECTED_SPECIES/NEST/HABITAT. |
| `display` | Exact `locale`, `title`, `description`. Preserve original language; title 1–120 and description 1–1,000 Unicode code points, trimmed and without C0/DEL controls. All text is private/untrusted before review. |
| `photos` | 0–2 exact `uploadId`, `rights`, `caption` objects; original-language caption 1–240 Unicode code points, trimmed and without C0/DEL controls. Empty photos is valid. Existing rights/bytes/safety rules below apply. |

Server-owned `sourcePolicy` is `verified: true`, publisherId, datasetId, canonical origin, reviewed pathPrefix and nonempty `allowedRegions`. It is not a tip field or client authorization. Publisher/dataset must match; a supplied URL must match origin/prefix. A null URL still needs policy and stable record identity. Country must have at least one allowed-region prefix even when region is null; known region must appear in the allowlist and share the country prefix. `TW-TPE` and `US-WA` are examples of reviewed entries, **not a complete global country/subdivision table**.

Locale support remains the canonical BCP47 subset accepted by runtime Intl: two/three-letter lower-case language, optional Titlecase four-letter script, optional upper-case two-letter region. Examples en-US, zh-TW, zh-Hant-TW; no claim of full variant/extension/private-use support. JSON Schema/runtime text lengths both count Unicode code points. Structural/length checks do not prove truth, rights, privacy or language correctness. Keep identifying names/accounts/phones/addresses/faces/plates and sensitive locations out of submissions and synthetic fixtures; never relay unreviewed text or private source keys to logs, Hub or public output. Escape text in any private preview. This service is not emergency rescue or government dispatch.

## Temporal precision, timezone and chronology

Every Temporal has exactly `precision`, `value`, `timeZone`:

| Precision | Value | timeZone |
| --- | --- | --- |
| `INSTANT` | RFC3339 subset with seconds, optional **exactly three** fractional digits, uppercase `T` and `Z` or explicit `±HH:mm` offset. | Valid IANA identifier recognized by runtime Intl, at most 80 UTF-16 code units. The supplied local wallclock must equal that zone's wallclock at the parsed instant; the offset must therefore match, including DST. |
| `DATE` | Real `YYYY-MM-DD` calendar date. Preserve that date; do not invent a clock time or convert it to UTC midnight. | Valid IANA zone, same runtime lookup/length rule. |
| `UNKNOWN` | Exactly `null`. | Exactly `null`. |

Examples: `{ "precision": "INSTANT", "value": "2026-11-26T09:00:00+08:00", "timeZone": "Asia/Taipei" }`; `{ "precision": "DATE", "value": "2026-11-25", "timeZone": "America/Los_Angeles" }`; `{ "precision": "UNKNOWN", "value": null, "timeZone": null }`.

`submittedAt` is server-owned, never a client key. The executable contract compares only what the supplied precision proves: known publication/observation definitely after server time, or observation definitely after publication, is rejected. Instant/instant compares actual instants. For a DATE, the runtime derives its actual interval in the supplied IANA zone for chronology checks only, including DST; an observation is definitely later only when its earliest possible instant exceeds publication's latest possible instant. Nonexistent local calendar days are rejected. The submitted DATE payload remains unchanged. Overlap/UNKNOWN cannot manufacture an exact order or observation time. The canonical admitted Temporal retains its supplied precision, value and timezone. Stale/historical or uncertain times stay subject to review, not automatically promoted to current sightings.

The OpenAPI `Temporal` component is a disjoint oneOf for these three exact objects. Schema format/pattern checks do not look up IANA zones, compare offsets/wallclocks, detect all calendar problems or enforce chronology; the executable contract must do those checks. Extra fractional widths and leap-second forms are outside the current INSTANT implementation.

URL normalization is unchanged: syntactic HTTPS only, no user info, IP literal, non-default port, whitespace/backslash, local hostname suffix or encoded reserved path characters. Lowercase the host via the URL parser, remove default port, fragment and only `utm_*`/`fbclid`/`gclid` tracking parameters; decode unreserved path escapes. Reject other query keys; preserve path case and trailing slash. No DNS lookup, redirect or remote fetch is performed. A normalized URL is not proof of publicness, provenance or privacy. Source adapters requiring semantic query IDs/Unicode paths need an explicit reviewed revision. Null is not normalized to an invented URL.
## V3 report, location meaning and custody

`report` has exactly `type`, `locationMeaning`, `custody`. The type/location pairing is mandatory:

| type | locationMeaning | Custody | Map semantics after all visibility gates |
| --- | --- | --- | --- |
| LOST | LAST_KNOWN | UNKNOWN with UNKNOWN Temporal only | Public lead may describe last-known coarse location; never a new sighting or eligible marker. |
| FOUND | FOUND_AT | UNKNOWN/UNKNOWN, or IN_CARE / NOT_IN_CARE with known Temporal | Public found lead; never a new sighting or eligible marker. Found location is **not** current care location. |
| SIGHTING | OBSERVED_AT | UNKNOWN with UNKNOWN Temporal only | The only report type eligible as a map marker; eligibility alone grants no publication. |

`custody` has exactly `status`, `asOf`. UNKNOWN status requires `{ "precision": "UNKNOWN", "value": null, "timeZone": null }`. Known custody is allowed only for FOUND; asOf must be known DATE/INSTANT, not definitely after publication or server time, and not definitely earlier than the found observation. The existing precision-aware comparator is used: overlapping/unknown bounds do not invent exact ordering or UTC midnight. No custody status proves a person's identity, reunion or care address, and `careLocationInferred` remains false.

Examples are in OpenAPI components: `TaiwanSightingV3ZhTW` (zh-TW exact instant), `USFoundV3EnUS` (en-US date-only, null URL, known care state), `USLostV3EnUS` (last-known date, unknown custody). `TaiwanInstantZhTW` and `USDateOnlyEnUS` retain v2 payloads unchanged. The request example defaults to v3. All examples are fictional and photo-less; no placeholder photo is presented as evidence.

`publicList()` requires no global publication block, APPROVED review, stored `review.publicVisible: true`, safe `mapPolicy`, availability PRESENT and caseStatus other than CLOSED_BY_SOURCE. It includes `report`, `mapMarkerEligible` and `careLocationInferred: false`. Only v3 SIGHTING can have `mapMarkerEligible: true`. V2 legacy, LOST and FOUND may be readable lead records, never inferred new sightings. Wildlife, non-NONE sensitivity and unknown region remain `mapPolicy: NEVER`; even approval can only yield APPROVED_PRIVATE. Rejected, withdrawn, duplicate, pending, unavailable, absent or source-closed rows stay out of the public list.

### Visibility fields in private lookup and review

| Field | Meaning |
| --- | --- |
| Original `receipt.publicVisible` | Always false in the immutable PENDING acceptance receipt, including every replay. It is not current visibility. |
| `review.publicVisible` | The stored review permission. It may remain true after source closure/absence/outage or a global publication block; it must not be read as proof that a record is currently public. |
| `effectivePublicVisible` | Current computed visibility in private `receipt(tipId)` lookup and successful `review()` results. It is true only when the store has no publication block and `publiclyVisible(row)` passes review, mapPolicy and source-state gates. |
| `publicationBlockedReason` | Null normally; SOURCE_EVENT_CAPACITY at the durable event limit, or STORE_UNAVAILABLE for a poisoned/unavailable store. A non-null value makes effectivePublicVisible false. This is a store-level guard, not a case closure. |

The private lookup returns receipt, review, sourceState, effectivePublicVisible and publicationBlockedReason beside its success flag. A successful supervisor review returns review plus the two computed visibility/block fields. `case-semantics.publiclyVisible(row)` also supplies the row filter used by `publicList()` after its global store guard. For example, a source-closed row can retain `review.publicVisible: true` while effectivePublicVisible is false and the row is absent from publicList. Source status changes never rewrite the original receipt or replay value. `mapMarkerEligible` is report semantics, not another approval/visibility override.

These fields describe the private rehearsal lookup/supervisor results only. They are not added to the official PendingReceipt schema or proposed HTTP acceptance response. matchingSuggestions remains private and gains no public route.

Public projection retains coarse country/region, reviewed original-language display, observation and a third-party provenance label. It omits source URL, publisher/dataset/record keys, upload IDs, rights evidence and raw state. Photos are only caption + `simulatedMedia: true` in rehearsal, never real media URLs.

## Private source events and lifecycle

`RehearsalStore.sourceEvent(event, context)` is a synthetic supervisor/fixture method with **no HTTP route**. Its exact event keys are `eventKey`, `publisherId`, `datasetId`, `recordKey`, `type`, `sourceChangedAt`. Event key and record key are opaque strings `[A-Za-z0-9_-]{16,128}`; publisher/dataset must match verified policy and target an existing source record. Types are EXPLICIT_CLOSED, PRESENT, ABSENT, TEMPORARY_FAILURE. Source time is original Temporal or UNKNOWN, never guessed from collection/server time; known definitely future/stale changes are rejected.

Persist event identity `(publisherId, datasetId, eventKey)`: the same event payload replays its immutable receipt, changed content conflicts. Store at most **2,000 events**. A new ABSENT event requires trusted out-of-band `completeSnapshot: true`; partial/missing context cannot establish absence. An already committed identical event can replay without reapplying the transition. The event body itself cannot assert this context. The immutable private event receipt contains `eventId`, server `receivedAt`, `tipId`, `type`, `reunionVerified: false`. Original tip receipts never change.

Private source state defaults to `caseStatus: NOT_CONFIRMED_CLOSED`, `availability: PRESENT`, UNKNOWN sourceChangedAt, receipt-time lastCheckedAt and `reunionStatus: UNVERIFIED`. NOT_CONFIRMED_CLOSED deliberately does not assert that a case is confirmed OPEN. `sourceState.sourceChangedAt` tracks the **latest KNOWN source update**, not closure time. An UNKNOWN event may preserve an older known value in this field; that older point must never be interpreted as the closing timestamp.

Optional private `closureEvidence` is captured on the first EXPLICIT_CLOSED event when absent, with exactly `{ sourceChangedAt, receivedAt, reunionVerified: false }`. Its sourceChangedAt preserves that event's original Temporal and precision, including UNKNOWN, independently of the latest-known source update. Its receivedAt is the separate server receipt time, never a substitute for missing source closure time. Later source events do not overwrite the first evidence or infer reunion. Older snapshots without closureEvidence remain valid; do not manufacture or backfill closure evidence from old sourceChangedAt/lastCheckedAt/server receipt values.

| Event | State effect and limits |
| --- | --- |
| EXPLICIT_CLOSED | Set caseStatus CLOSED_BY_SOURCE and availability PRESENT; preserve the first closureEvidence and its original precision independently of latest-known source time. This is the source's explicit case closure, **not confirmed reunion**. Hide only the targeted source record; independent counterpart receipts are untouched. |
| PRESENT | Set availability PRESENT. Restore readability only if the case is not CLOSED_BY_SOURCE and its existing review/safety gates permit it; never reopen closed/rejected/withdrawn records or reapprove them. |
| ABSENT | With trusted complete snapshot, set availability ABSENT and hide temporarily. Absence is not closure, deletion or reunion. |
| TEMPORARY_FAILURE | Set availability UNAVAILABLE and hide temporarily. Preserve NOT_CONFIRMED_CLOSED/CLOSED_BY_SOURCE and original receipts; outage never proves closure. |

At **2,000 or more persisted sourceEvents**, `publicationBlockReason()` returns SOURCE_EVENT_CAPACITY for the whole store. The block is derived from durable event count and survives restart. `publicList()` and its loopback projection return `{ success: false, error: "REHEARSAL_PUBLICATION_BLOCKED", status: 503 }` with **no items field**, rather than stale records or an apparently successful empty list. A poisoned store is also blocked. Private lookup/successful review reports effectivePublicVisible:false and its publicationBlockedReason; stored review permission may still be true.

Capacity does not fabricate CLOSED_BY_SOURCE or verified reunion, close independent counterparts, alter original tip receipts, or prevent replay of an already committed original tip receipt. No history-deletion or automatic-unblock operation is provided. The capacity guard is independent of private manual matching, which still has no public HTTP route. Treat publication 503 as unavailable, not a measured zero-count dataset.

## Scoped fixture polling

`scheduledPass()` accepts optional **server caller configuration** `sourceScope: { publisherId, datasetId }`, which must match a verified registered policy. It is not supplied by a public tip or an untrusted completeness assertion. Fixture JSON requires `synthetic: true`, records array ≤20 and optional events array ≤20. With sourceScope, every record/event publisher and dataset must match that scope; a mismatched or failed/malformed GET rejects the feed and marks existing rows in that scope UNAVAILABLE, without closing cases or creating tips.

After a valid scoped feed, successfully accepted/replayed source keys become PRESENT. Seen keys whose POST returns refusal become UNAVAILABLE, never mistaken for disappearance. Only trusted `completeSnapshot === true` permits previously stored **unseen** keys to become ABSENT; a partial feed does not infer absence. Explicit fixture events pass through the supervisor method, not an HTTP event endpoint. Date bounds are used only for comparison, never written back as guessed source precision.

Without sourceScope, legacy scheduledPass keeps its prior behavior and does not infer presence/absence/outage status. Explicit validated events supplied by a fixture are still processed; absence inference itself remains scope-bound. Poll slots are persisted before requests. Scoped failure handling intentionally writes availability/event bookkeeping but no new tip or immutable tip receipt; it is not a claim of zero filesystem writes.

The inspected POST-loop transport exhaustion path still propagates before the final availability update. Thus received POST refusals are covered by the UNAVAILABLE rule; the all-attempts-threw path requires its regression/fail-closed handling before that broader guarantee is claimed.

## Private manual matching

`matchingSuggestions()` has no public HTTP route. Only safe, source-visible v3 LOST/FOUND rows with PENDING or APPROVED review status participate. Kind, country and coarse region must match, and the last-known observation must not be definitely later than the found observation. UNKNOWN/overlapping dates remain uncertain, not a scored identity match. Rejected/withdrawn/duplicate, source-closed/unavailable/absent, wildlife and other NEVER rows are excluded.

Return exactly `{ items, manualOnly: true, suggestionLimit: 100, comparisonLimit: 2000, truncated }`. Each item has lostTipId, foundTipId, manualOnly:true, confidence:UNSCORED, reunionVerified:false and reasons `[SAME_KIND, SAME_COARSE_REGION, TIME_NOT_CONTRADICTED]`. At most 100 suggestions and 2,000 pair comparisons are considered; `truncated: true` explicitly marks an incomplete result. Temporal intervals may be cached internally without changing original DATE/INSTANT/UNKNOWN values. Suggestions trigger no automatic pairing, merge, duplicate decision, publication or reunion. LOST/FOUND cannot be merged through cross-report-type DUPLICATE review.

## Photos: existing strict rights, byte and safety requirements

No arbitrary remote image URL, data URL, base64, filesystem path or image bytes are accepted by this tip schema. A photo contains only an opaque `uploadId`, exact `rights` (`license`, `evidenceRef`, `attributionRef`, `permitsRedaction: true`) and the required original-language caption. Preserve the existing candidate licenses `EXPLICIT_PERMISSION`, `CC_BY_4_0`, `CC0_1_0`; they require per-image verification, not automatic approval. Other/unknown/NC/ND/SA variants remain outside this narrow draft policy, which is a product restriction rather than a general legal conclusion.

A future verified uploader receives bounded image bytes separately using existing authorized operator access; it never fetches an arbitrary client URL. Its private safe-upload record must match publisher, dataset, recordKey, canonical sourceUrl **including null**, exact rights metadata and actual sanitized image SHA-256. Same-case matching prevents attributing unrelated photography to a clue. The actual permission/license evidence and non-identifying approved credit are private records behind `evidenceRef`/`attributionRef`. A reference alone proves neither reuse nor consent. Preserve edit/redaction permission, attribution, license link and modification notices; if privacy and required credit cannot both be satisfied, omit the image. No new credential or actual uploader is authorized by this document.

Required trusted flags remain `reuseConsentVerified`, `exifRemoved`, `geoRemoved`, `manualRedactionConfirmed`, `noFacesOrPlates`, `noPersonalData`, `noSensitiveVisualLocation`, `caseMatchConfirmed`, all true. Require human redaction/location confirmation, matching clue and explicit reuse evidence. EXIF removal alone does not remove XMP/IPTC location, visible landmarks, embedded identifying text, faces or plates. A recognizable sensitive location must never become a public pin or photo; omit the unsafe photo and retain the clue privately. Photos are private while pending.

Unchanged limits: 0–2 images; actual sanitized size **1 byte through 5 MiB each**, at most **8 MiB combined**; MIME JPEG/PNG/WebP only; each dimension 1–8,192 and at most **16,000,000 decoded pixels**. Safe decode/re-encode, MIME/signature checks, metadata stripping, animation/polyglot/decompression-bomb rejection and content/privacy scanning belong to the uploader. Pure contract/rehearsal upload metadata is not a real-byte scan, actual consent check, license determination, EXIF/redaction proof or real photography acceptance.

Public visibility alone is not reuse permission. CC BY 4.0 permits sharing/adaptation subject to conditions including appropriate credit, a license link and indicating modifications; other rights can require additional permission. CC0 does not eliminate privacy/publicity concerns. Official sources retained from the draft: [CC BY 4.0 deed](https://creativecommons.org/licenses/by/4.0/), [CC0 1.0 deed](https://creativecommons.org/publicdomain/zero/1.0/) (read 2026-11-26). No new licensing exception is introduced here.
## Isolated rehearsal operation

`rehearsal.js`, `case-semantics.js`, `run-rehearsal.js` and `run-case-rehearsal.js` operate on synthetic sources/state only. Registered publishers use `synthetic-` IDs and `.example.invalid` policy origins. HTTP source/receiver origins must be created and registered by this rehearsal module on 127.0.0.1; existing local tunnels and production hosts are not fixtures. A fake clock drives polling; no Mac patrol, LaunchAgent, cron, Codex daily schedule or production integration is installed.

Local paths remain POST `/synthetic/tips`, GET `/receipts/{tipId}`, GET `/public/tips`. Review, sourceEvent and matchingSuggestions have no HTTP mutation/query routes. Only the supervisor calls review with contentReviewed, localLanguageReviewed, privacyReviewed, sourceVerified, rightsReviewed, locationSafe; synthetic booleans do not constitute real human approval or production authority.

The filesystem design uses private JSON snapshots, exclusive single-writer lock, file fsync, atomic rename and directory fsync. Closed/poisoned writers fail closed. Stale locks require investigation, not automatic breaking. Snapshot version stays 1, old payload/hash/fingerprint/receipt remains intact, and source-event storage is lazy. No exhaustive power-loss or multi-worker guarantee is claimed. Existing test limits are 10 new tips/publisher/hour, 1,000 tips, 2,000 retry keys, 2,000 source events and 16 MiB state; the default fake-clock interval is 15 minutes, minimum one minute.

From this worktree after the storage guard, run with a new absolute evidence directory whose parent exists:

```sh
node tools/stray-map-intake/run-rehearsal.js \
  "/Volumes/ProjectsData/portfolio-private-staging/stray-map-rehearsal-UNUSED-RUN-ID"
```

Replace UNUSED-RUN-ID with an unused run ID. Existing destinations are refused, not overwritten. The CLI dispatches distinct `first` and `restart` child processes and retains `milestone-1-pending.private.json`, `milestone-2-restart-review.private.json`, then `RESULT.private.json` after success. Preserve partial evidence on failure. These are synthetic receipt/review/restart milestones, not proof of a deployed API, real image bytes or real author permissions.

### V3 lifecycle CLI

Use a separate new destination for the v3 lifecycle runner:

```sh
node tools/stray-map-intake/run-case-rehearsal.js \
  "/Volumes/ProjectsData/portfolio-private-staging/stray-map-cases-UNUSED-RUN-ID"
```

It dispatches three distinct child processes, `receive`, `lifecycle`, `verify`, reopening the same private store. Existing destinations and evidence files are not overwritten. Its four v3 records are primary LOST + SIGHTING and peer FOUND + independent FOUND. This is a scoped synthetic controller rehearsal, with no real photo-byte processing or official API connection.

| Phase/evidence | Contract checked by the runner |
| --- | --- |
| `receive` → `receive.private.json` | Four distinct original receipts; all pending/publicly hidden; two private manual-only LOST/FOUND suggestions, never confirmed matches or reunions. |
| `lifecycle` → `lifecycle.private.json` | Persisted poll-skip and same-receipt replay; cross-type DUPLICATE refusal; explicit approval of four readable leads but only one v3 SIGHTING eligible as a marker. Source closure hides only LOST. A complete snapshot missing the independent FOUND yields ABSENT, not closure. Peer HTTP 503 yields UNAVAILABLE, not closure. PRESENT restores already-approved FOUND visibility without refreshing observation/custody time or reopening the source-closed LOST. |
| `verify` → `verify.private.json` | A further process reopens four original unchanged receipts; LOST remains CLOSED_BY_SOURCE, reunion remains unverified; final public projection has three leads and one sighting-eligible record, with no remaining private suggestions after LOST closure. |
| `RESULT.private.json` | Written after all three phases succeed; records simulation, three phases, zero production writes, unchanged terms/patrol, no confirmed reunion and officialApiVerified:false. |

The lifecycle CLI proves only its asserted synthetic fixture path. Do not combine it with the two-process receipt CLI into a single unstated coverage claim. Image bytes use a separate verification suite; mocked fixture metadata, actual byte-processing tests and real author/rights acceptance must be reported separately. No aggregate test total is implied by these examples.

Loopback requests use `Connection: close`. A scheduled record POST has at most one transport/uncertain-success-acknowledgement retry with exactly the same body/key; application refusals, wrong media, size/UTF-8 failures and invalid non-success JSON do not trigger it. Source GET is not retried within the same poll slot. A second failed POST propagates. Receipt replay, not another case insertion, handles acknowledgement loss after durable commit.

## Statistics and release checks

Keep native reports, v2 legacy leads, typed LOST/FOUND/SIGHTING leads, eligible map markers, candidate hashes, manual suggestions, confirmed duplicate decisions, review state and source closure/availability distinct. Candidate equality, source closure and manual suggestions do not establish a reunion. Rehearsal counts never become real external/Hub statistics. `countOrUnknown` keeps zero only for an available measured source; unknown/invalid/unavailable stays null. Include scope/window/timezone, latest successful update, missing stages and sensitive/small-cell suppression. No private source identifiers, match pairs or sensitive locations enter public aggregates.

Run the contract, local HTTP/store/scheduler and Hub regression suites with installed dependencies:

```sh
node backend/node_modules/jest/bin/jest.js --config backend/jest.config.js --runInBand --forceExit=false --detectOpenHandles --coverage=false --runTestsByPath backend/tests/jest/stray-map-intake-contract.test.js backend/tests/jest/stray-map-intake-rehearsal.test.js backend/tests/jest/stray-map-intake-cases.test.js backend/tests/jest/aihankapps-hub-stray-map.test.js
```

Verify both versions against OpenAPI, unchanged v2 hashes/receipts/snapshots, v3 type/custody/time boundaries, source-event replay/conflict/closure/presence/complete-versus-partial/outage isolation and bounded manual matching. Test current source/receiver restart, same-body/key response-loss retry, privacy-safe public projection, role gates and every unsafe NEVER path. Assert that source-hidden rows keep historical review permission but have effectivePublicVisible:false; event-capacity blocks survive restart, return 503 without items, preserve original receipt replay and expose the private block reason. No older green count substitutes for the current revision's results. The lifecycle CLIs use mocked image/rights metadata. Separate image-byte worker results must be verified before reporting their count or combining any totals; actual third-party photo licenses and real moderation remain separate acceptance gates.

The branch workflow `.github/workflows/backend-ci.yml` excludes Railway preview for draft PRs: its preview job requires `pull_request` and `draft == false`. Keep this PR draft while product deployment is prohibited. Lint, i18n and Jest gates remain enabled; this workflow edit is not a deployment, main-branch change or live-schedule update. Official activation/terms approval remains separate from CI results.

Apply `docs/code-review-checklist.md`: A1 guards/state transitions above; A2 current schema/contract/rehearsal/Hub checks; A3 bounded success/machine-code envelopes; A4 unverified complete release source, actual media/rights and production persistence/authorization/abuse controls; A5 synthetic registered origins, private source/event/matching data and no pre-review/sensitive publication. B1 `/api/help`, B3 product i18n, B4 product information and B5 production debug routes are NO-OP because no product endpoint/UI is installed; B2 this draft and OpenAPI stay synchronized. Icon/H review is not applicable to a document-only change.

## Terms clause 4 — narrow exception still PENDING HANK APPROVAL

The source audit identified legal version `v2026-09-14.1`, `/terms?lang=zh-Hant`, clause 4: 「**自動化行為**：使用 bot、爬蟲、模擬器大量張貼、灌票、規避速率限制」. The general prohibition remains unchanged. The following is **proposed wording only**, neither a published amendment nor authorization:

> 第 4 條對一般機器人、模擬使用者與批次發文的禁止維持不變。僅經營運方書面核准，且依另行公告之正式外部線索 API、已核准來源與使用範圍提交之第三方公開線索，得作為例外送入非公開待審佇列；不得模擬 App 匿名裝置識別、規避限流、直接發布或自動取得審核通過。通報須如實標示第三方來源及非本人目擊，提供必要來源／時間與合法影像再利用證據，排除個資與敏感野生動物位置；營運方得拒收、停用來源或要求補正。未經審核之線索及照片不得對外公開；此機制不構成緊急救援或政府派案。

Only explicit approval of this narrow exception and the proven pipeline can authorize later production automated intake. This document grants no general bot permission, source-content license, new credential/role or production write. Synthetic localhost rehearsal does not amend the current terms or enable the official path.
The official activation gate remains closed. This draft does not authorize production intake, new credentials/permissions, actual patrol writes, deployment or terms publication.
