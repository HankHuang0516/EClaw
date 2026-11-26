# Stray Map external intake — draft v2 and isolated rehearsal

**Production BLOCKED and disabled; no official intake API verified; narrow terms exception PENDING HANK APPROVAL.** This proposal stays in the existing EClaw worktree. It creates no production route, credential, role, approved terms change or permission to write to the official map. `DRAFT.enabled` and `DRAFT.officialApiVerified` remain false. Human app use remains unauthenticated; external tips never impersonate an anonymous App device. Dot/Mac patrol remains read-only; Codex daily schedules are unchanged.

Runtime files matching a historical inventory do not supply the missing complete rebuild/provenance chain. The source audit found an existing `POST /v1/animals` that publishes immediately, a photo queue rather than a pending-tip queue, and device UPSERT side effects in the `/v1/*` pre-handler. Do not wire this proposal to those routes, invent UUIDs, issue live test pins or reconstruct a production backend from partial extracts. The proposed `POST /v1/public/tips` remains an **unimplemented official contract**, with an `example.invalid` OpenAPI server. The separate `rehearsal.js` loopback endpoints below are synthetic test infrastructure, not that official route.

## Exact v2 input and trusted context

The only top-level keys are `schemaVersion`, `thirdParty`, `selfWitness`, `source`, `observation`, `animal`, `location`, `display`, `photos`. Every key is required, and unknown/missing properties are rejected at each request object. V1 `observedAt` and a string-valued publication time are no longer valid. Require JSON UTF-8, identity encoding, at most **16,384 actual bytes including whitespace**, valid UTF-8/JSON and no duplicate JSON keys, including escaped duplicates. A receiver must cap streaming bytes before full allocation/parsing, rather than trust Content-Length. The pure validator can check only bytes already supplied to it.

| Object/field | Implemented v2 contract |
| --- | --- |
| `schemaVersion`, `thirdParty`, `selfWitness` | Exactly `2`, `true`, `false`. All external clues are third-party public leads, not personal sightings. |
| `source` | Exactly `publisherId`, `datasetId`, `recordKey`, `url`, `publishedAt`. |
| `publisherId`, `datasetId` | Reviewed slugs, 3–64 characters, pattern `[a-z][a-z0-9-]{2,63}`. Both must match server policy. |
| `recordKey` | Private opaque stable record identifier, 16–128 characters `[A-Za-z0-9_-]`. Never a person identifier, public case ID or URL. |
| `source.url` | Canonical HTTPS source URL or `null`. When supplied, maximum 1,024 characters and registered exact origin/post-path prefix. It is private evidence, not the unique record key. |
| `source.publishedAt`, `observation` | Both use the exact `Temporal` object described below. Neither is replaced with the other's time. |
| `animal` | Exactly `kind`, `count`, `condition`. Kind: `DOG`, `CAT`, `OTHER_STRAY`, `WILDLIFE`; condition: `UNKNOWN`, `ROAMING`, `INJURED`, `DECEASED`; count: integer 1–100 or `null` for unknown, never zero. |
| `location` | Exactly `countryCode`, `regionCode`, `sensitivity`. Upper-case ISO2 country shape; nullable coarse ISO3166-2 region shape `CC-XXX` (1–3 alphanumeric subdivision characters), matched to country and server `allowedRegions`. Sensitivity: `NONE`, `UNKNOWN`, `PROTECTED_SPECIES`, `NEST`, `HABITAT`. |
| `display` | Exactly `locale`, `title`, `description`. Preserve original language; title 1–120 and description 1–1,000 Unicode code points. Both must be trimmed and contain no C0/DEL controls. They remain private/untrusted before review. |
| `photos` | Array of 0–2 objects, each exactly `uploadId`, `rights`, `caption`. Caption is trimmed original-language text, 1–240 Unicode code points, no C0/DEL controls; keep private before review. Empty photos is valid. |

`display.locale` currently supports a **canonical BCP47 subset**: lower-case two/three-letter language, optional Titlecase four-letter script, optional upper-case two-letter region; it must equal `Intl.getCanonicalLocales` output. Examples: `en-US`, `zh-TW`, `zh-Hant-TW`. Variants, extensions, private-use and numeric-region tags are not implemented. JSON Schema maxLength and the executable `boundedText` both count Unicode code points, preserving astral characters without rewriting the text. These are implementation limits, not a claim to support every BCP47 tag or every RFC3339 spelling.

`sourcePolicy` is server-owned context with `verified: true`, `publisherId`, `datasetId`, `origin`, `pathPrefix`, `allowedRegions`. It is **not an accepted tip field** or proof supplied by an anonymous client. The registry permits exact publisher/dataset identity; a non-null URL must also satisfy its origin/prefix. A null URL still requires the verified dataset and opaque record key. `origin` and `pathPrefix` remain required policy fields even when a record URL is null. Country must have at least one entry in `allowedRegions`, and a known region must appear there and share the country prefix. Even an unknown/null region does not bypass the country check.

For example, an approved synthetic policy may list `allowedRegions: ["TW-TPE", "US-WA"]`; this is a small explicit allowlist, **not a complete global region/country registry**. The two-letter/region patterns alone do not verify all ISO assignments. No fixed Taiwan enum is exported or used to authorize v2 regions; the trusted allowlist is authoritative. OpenAPI includes a `SourcePolicy` component for documenting trusted context, separate from the request schema.

Text length/structure, publisher registration and caller assertions do not prove content truth, source identity, privacy, copyright, language correctness or safety. Keep names, social accounts, phone numbers, addresses, faces, plates and identifying/sensitive locations out of real submissions and all synthetic fixtures. Do not copy unreviewed display/captions into public output, logs, the Hub or browser storage. Any future private preview must escape untrusted text. This is not emergency rescue or government dispatch.

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

## Synthetic examples in their original language

The Taiwan exact-time example is the OpenAPI request example. Its trusted synthetic policy is publisher `synthetic-a`, dataset `synthetic-tw`, origin `https://news.example.invalid`, prefix `/public-tips/`, with `TW-TPE` allowed. It has no photograph:

```json
{
  "schemaVersion": 2,
  "thirdParty": true,
  "selfWitness": false,
  "source": {
    "publisherId": "synthetic-a",
    "datasetId": "synthetic-tw",
    "recordKey": "synthetic_tw_record_0001",
    "url": "https://news.example.invalid/public-tips/synthetic001",
    "publishedAt": {
      "precision": "INSTANT",
      "value": "2026-11-26T10:00:00+08:00",
      "timeZone": "Asia/Taipei"
    }
  },
  "observation": {
    "precision": "INSTANT",
    "value": "2026-11-26T09:00:00+08:00",
    "timeZone": "Asia/Taipei"
  },
  "animal": {
    "kind": "DOG",
    "count": null,
    "condition": "ROAMING"
  },
  "location": {
    "countryCode": "TW",
    "regionCode": "TW-TPE",
    "sensitivity": "NONE"
  },
  "display": {
    "locale": "zh-TW",
    "title": "合成演練：犬隻公開線索",
    "description": "僅供隔離演練的虛構第三方線索，非本人目擊。沒有真實動物、個資或精確位置；照片留空。"
  },
  "photos": []
}
```

The US-WA example retains **date-only precision** in `America/Los_Angeles`, original `en-US` text, and a null source URL. Its trusted synthetic context is publisher `synthetic-b`, dataset `synthetic-us`, origin `https://us.example.invalid`, prefix `/public-tips/`, `allowedRegions: ["US-WA"]`. Identity comes from the dataset record, not URL. It is also stored in OpenAPI `components.examples.USDateOnlyEnUS`:

```json
{
  "schemaVersion": 2,
  "thirdParty": true,
  "selfWitness": false,
  "source": {
    "publisherId": "synthetic-b",
    "datasetId": "synthetic-us",
    "recordKey": "synthetic_us_record_0001",
    "url": null,
    "publishedAt": {
      "precision": "DATE",
      "value": "2026-11-25",
      "timeZone": "America/Los_Angeles"
    }
  },
  "observation": {
    "precision": "DATE",
    "value": "2026-11-25",
    "timeZone": "America/Los_Angeles"
  },
  "animal": {
    "kind": "CAT",
    "count": null,
    "condition": "UNKNOWN"
  },
  "location": {
    "countryCode": "US",
    "regionCode": "US-WA",
    "sensitivity": "NONE"
  },
  "display": {
    "locale": "en-US",
    "title": "Rehearsal: synthetic cat tip",
    "description": "A fictional third-party clue for an isolated rehearsal, not a personal sighting. The source provides only a calendar date. No real animal, person, precise location or photograph is included."
  },
  "photos": []
}
```

Both are fictional, contain no real sighting/person/precise location and use no reused/placeholder animal photograph. A missing usable photo stays missing; do not fabricate or mismatch imagery.

## Photos: existing strict rights, byte and safety requirements

No arbitrary remote image URL, data URL, base64, filesystem path or image bytes are accepted by this tip schema. A photo contains only an opaque `uploadId`, exact `rights` (`license`, `evidenceRef`, `attributionRef`, `permitsRedaction: true`) and the required original-language caption. Preserve the existing candidate licenses `EXPLICIT_PERMISSION`, `CC_BY_4_0`, `CC0_1_0`; they require per-image verification, not automatic approval. Other/unknown/NC/ND/SA variants remain outside this narrow draft policy, which is a product restriction rather than a general legal conclusion.

A future verified uploader receives bounded image bytes separately using existing authorized operator access; it never fetches an arbitrary client URL. Its private safe-upload record must match publisher, dataset, recordKey, canonical sourceUrl **including null**, exact rights metadata and actual sanitized image SHA-256. Same-case matching prevents attributing unrelated photography to a clue. The actual permission/license evidence and non-identifying approved credit are private records behind `evidenceRef`/`attributionRef`. A reference alone proves neither reuse nor consent. Preserve edit/redaction permission, attribution, license link and modification notices; if privacy and required credit cannot both be satisfied, omit the image. No new credential or actual uploader is authorized by this document.

Required trusted flags remain `reuseConsentVerified`, `exifRemoved`, `geoRemoved`, `manualRedactionConfirmed`, `noFacesOrPlates`, `noPersonalData`, `noSensitiveVisualLocation`, `caseMatchConfirmed`, all true. Require human redaction/location confirmation, matching clue and explicit reuse evidence. EXIF removal alone does not remove XMP/IPTC location, visible landmarks, embedded identifying text, faces or plates. A recognizable sensitive location must never become a public pin or photo; omit the unsafe photo and retain the clue privately. Photos are private while pending.

Unchanged limits: 0–2 images; actual sanitized size **1 byte through 5 MiB each**, at most **8 MiB combined**; MIME JPEG/PNG/WebP only; each dimension 1–8,192 and at most **16,000,000 decoded pixels**. Safe decode/re-encode, MIME/signature checks, metadata stripping, animation/polyglot/decompression-bomb rejection and content/privacy scanning belong to the uploader. Pure contract/rehearsal upload metadata is not a real-byte scan, actual consent check, license determination, EXIF/redaction proof or real photography acceptance.

Public visibility alone is not reuse permission. CC BY 4.0 permits sharing/adaptation subject to conditions including appropriate credit, a license link and indicating modifications; other rights can require additional permission. CC0 does not eliminate privacy/publicity concerns. Official sources retained from the draft: [CC BY 4.0 deed](https://creativecommons.org/licenses/by/4.0/), [CC0 1.0 deed](https://creativecommons.org/publicdomain/zero/1.0/) (read 2026-11-26). No new licensing exception is introduced here.

## Separate retry, source-record and suspected-case identity

`Idempotency-Key` remains `[A-Za-z0-9_-]{16,128}`, scoped by publisher, not authorization. Hash the canonical admitted v2 payload with sorted object keys and ordered photo arrays. Include original text/locale/captions, temporal precision/value/zone, source dataset/record key and all rights references; server submittedAt/receipt and review outcome are excluded. Only source URL normalization changes the admitted source URL; equivalent-looking time/text values are not silently rewritten into new precision or language.

Three separate mechanisms must remain distinct:

- **Retry key:** `(publisherId, Idempotency-Key)`. Same key+same hash replays the original immutable PENDING receipt/time; changed hash conflicts with 409. A pure RESERVE decision does not persist anything.
- **Source stable record key:** `(publisherId, datasetId, recordKey)`, separately unique, independent of URL. In the rehearsal, exact content with a new retry key reuses the original receipt without creating a tip; changed content conflicts with 409 rather than overwrite. Different datasets/records remain independent inputs. A changed URL is not permission to create another copy of the same source record.
- **Candidate fingerprint:** private version `stray-case-v2`, kind + country + coarse region + known observation **local calendar date**. DATE keeps its supplied date; INSTANT derives that date in its supplied IANA zone; UNKNOWN/unknown region/sensitive/wildlife yields null. Equality is only a suspected-case review signal, never automatic merge, rejection, unique constraint or confirmed deduplicated count. Distinct animals can collide; a real case can cross day/region boundaries. Keep all provenance/receipts; only the supervisor's explicit synthetic DUPLICATE decision links rehearsal cases.

Every accepted external record starts `PENDING`, `publicVisible: false`; clients cannot submit review/publication, device IDs/secrets, precise coordinates, district/address/geohash or trusted-policy/upload records. `mapPolicy` is `NEVER` for wildlife, non-NONE sensitivity or unknown region; otherwise only `REVIEW_REQUIRED`. Even an approval cannot make NEVER records public. Hashes/fingerprints are private location-derived data, not anonymization. Production needs a separately approved atomic/durable store, retention policy, review/role gates and privacy-safe publication projection; rehearsal state is not the production store.

## Localhost synthetic schedule rehearsal

`tools/stray-map-intake/rehearsal.js` is the main-owned local implementation; `tools/stray-map-intake/run-rehearsal.js` is its reproducible two-process CLI. Validation, transport retry and test results remain version-scoped. It is not imported by the production server, collector, Mac patrol or a Codex daily schedule. Fixture source and receiver URLs are restricted to HTTP **127.0.0.1 with an explicit local port**; the registered policies require `synthetic-` publisher IDs and `.example.invalid` origins. No external source collection, public host, production API, live pin, real person/media, new credential or standing schedule is part of this rehearsal. A **fake clock supplied through `now`** drives scheduled passes; no Mac LaunchAgent, cron, automation or Codex daily schedule is created or changed.

Local receiver paths are `POST /synthetic/tips`, `GET /receipts/{tipId}`, `GET /public/tips`. They are loopback-only test paths, not implementations of the disabled `/v1/public/tips` proposal. There is **no HTTP review route**. Only the synthetic supervisor calls `review()` with explicit action and the six checks `contentReviewed`, `localLanguageReviewed`, `privacyReviewed`, `sourceVerified`, `rightsReviewed`, `locationSafe`. Boolean supervisor attestations in synthetic fixtures do not constitute actual human moderation or production authorization.

The store design uses a private synthetic JSON snapshot, exclusive single-writer lock, file fsync, atomic rename and parent-directory fsync. A stale lock fails closed; this document authorizes no lock breaking or automatic recovery. Replays/source uniqueness, local pending/rejected/withdrawn/duplicate states, simulated restart/durable write behavior and failure handling need main's integration tests. The observed design is not a claim that every durability/concurrency/crash boundary has passed. Main reports adding a closed-writer guard and receiver-restart fix after document review; the final main-owned tests must cover those boundaries. Use the final tested implementation, not this document as a release attestation.

`publicList()` exposes only supervisor-approved ordinary safe records with coarse country/region, reviewed original-language display, observation, third-party provenance label and simulated photo captions. It omits source URLs, publisher/dataset/record keys, upload IDs, evidence/attribution references and raw private state. Photo projection contains `caption` and `simulatedMedia: true`, not real media URLs. Pending/rejected/withdrawn/duplicate rows stay hidden; wildlife/sensitive/unknown-region records can at most become `APPROVED_PRIVATE` and never enter this list. No precise coordinates are accepted anywhere in the tip contract.

`scheduledPass()` persists a fake-clock poll slot before reading a bounded JSON fixture dataset (at most 20 records and 256 KiB response), then submits each record to the local receiver using a stable derived retry key. The default minimum interval is 15 minutes, configurable with a one-minute lower bound; these are rehearsal controls, not Mac patrol frequency. A source failure consumes its reserved slot; a later fake-clock-due pass exercises recovery. The current local intake caps new records at 10/publisher/hour, 1,000 stored tips, 2,000 retry keys and 16 MiB state. These local test ceilings are not production capacity or a deployed limiter.

### Reproducible two-process CLI

Run from this existing worktree after its normal storage guard, using a **new, unused absolute evidence-directory path** whose parent already exists:

```sh
node tools/stray-map-intake/run-rehearsal.js \
  "/Volumes/ProjectsData/portfolio-private-staging/stray-map-rehearsal-UNUSED-RUN-ID"
```

Replace `UNUSED-RUN-ID` with an unused run identifier. The public CLI takes exactly one absolute destination. It creates that root privately and refuses an existing destination; it does not overwrite prior evidence. Internal `--phase first` / `--phase restart` execution is dispatched by the CLI into **distinct child processes**, with a bounded timeout, so milestone 2 verifies a different process reopening the existing synthetic store. No timer, Mac patrol, Codex daily schedule or production connection is installed. On a failed run, preserve the partial evidence; choose a fresh destination for any later full run.

| Phase/evidence | Executed assertions in the runner |
| --- | --- |
| `first` → `milestone-1-pending.private.json` | Accept five different receipts: US date-only, Taiwan exact time with caption metadata, independent US record, peer-source suspected duplicate and wildlife/habitat record. All five remain absent from the synthetic public list; an immediate repeated fake-clock tick skips without another fixture-source request. |
| `restart` → `milestone-2-restart-review.private.json` | A different process reopens the store, preserves all five original receipts and the poll-skip state, advances fake time, and replays those exact receipts without new tips. Equal candidate fingerprints preserve the independent US record; a peer duplicate is linked only by explicit supervisor review. Missing review checks fail closed. Approving three ordinary records produces three public items; wildlife becomes APPROVED_PRIVATE, never public. Withdrawing Taiwan leaves two public US items. A newly accepted sixth record is rejected and stays hidden; an unlicensed-photo request is rejected. Original locale/date precision/caption and absence of private keys are asserted. |
| Outage portion of restart | A later fake-clock source outage creates no new intake records, receipts or public items; six stored tips remain after the deliberately added rejected record. The poll reservation is still persisted before that failed source read, and an immediate retry tick skips. Thus the runner's `sourceOutageNoWrites` marker means **no new intake-data writes**, not that no scheduling-state/file write occurred. |
| `RESULT.private.json` | Written only after both child phases succeed; identifies `simulation: true`, `officialApiVerified: false`, `productionWrites: 0`, no deployment and no Mac patrol change, plus the two milestone filenames. |

The image case uses **mocked trusted upload/image metadata**, a synthetic digest, rights flags and caption. The public photo item is only a `simulatedMedia` caption marker. Neither this CLI nor its milestone proves real photo-byte decoding, sanitation/EXIF removal, real image rights or an official API integration. Synthetic supervisor review is not human moderation acceptance.

### Bounded local transport retry

`readJSON()` accepts only origins created by this rehearsal module; an existing local tunnel cannot be used as a fixture. It requests those loopback responses with `Connection: close`. `scheduledPass()` constructs one POST options/body/key per record. A fetch failure, interrupted response stream or unusable JSON in a successful acknowledgement triggers **at most one retry with the same serialized body and Idempotency-Key**. This covers acknowledgement loss after a durable commit; the receiver replays the original receipt. Application JSON refusals, wrong media, size/UTF-8 failures and invalid JSON on non-success responses do not trigger retry. Source GETs are never retried within the poll slot. A failed second POST propagates; this is not an unbounded retry loop or an installed patrol policy.

The HTTP regression suite drops a response after durable acceptance and verifies that the bounded retry returns the same receipt without inserting another case.

The future official protocol still needs streaming/time/header bounds, proven abuse controls, per-IP/global/source/queue limits, storage and review authorization. Rehearsal success cannot open the production activation gate. Proposed official success remains `{ success: true, tipId, status: "PENDING", publicVisible: false, submittedAt }` after durable acceptance; the local harness wraps that receipt with synthetic replay/status metadata. Do not send a whole private validator/store result as an official public response. Errors are bounded `success:false` machine codes, without source/key/text/photo values. Use 400 input, 403 source/review gate, 409 conflict, 413 bytes, 415 encoding/media, 429 quota, 503 disabled/unavailable/full and 500 unexpected internal failure as applicable. Error-name examples are not an exhaustive versioned registry.

## Hub semantics remain separate

This patch collects no real statistics or changes to Hub access/UI. `countOrUnknown` preserves a genuine non-negative integer zero only for an available source; missing/invalid/unavailable stays null. Separate native map reports from external clues; input count, candidate groups, confirmed deduplicated cases, pending/rejected and actually public records are different metrics. Replays are not new clues and candidate hashes are not confirmed cases. Report scope/window/timezone, latest successful update, missing stages, stale status and available trends/types/coarse regions; suppress sensitive/small identifying cells. Rehearsal/synthetic counts are never imported as real external statistics. Until approved production intake exists, unavailable external stages remain null rather than fabricated zero.

## Terms clause 4 — narrow exception still PENDING HANK APPROVAL

The source audit identified legal version `v2026-09-14.1`, `/terms?lang=zh-Hant`, clause 4: 「**自動化行為**：使用 bot、爬蟲、模擬器大量張貼、灌票、規避速率限制」. This is supplied audit provenance, not independent verification by this document patch. The general prohibition remains unchanged. The following is **proposed wording only**, neither a published amendment nor authorization:

> 第 4 條對一般機器人、模擬使用者與批次發文的禁止維持不變。僅經營運方書面核准，且依另行公告之正式外部線索 API、已核准來源與使用範圍提交之第三方公開線索，得作為例外送入非公開待審佇列；不得模擬 App 匿名裝置識別、規避限流、直接發布或自動取得審核通過。通報須如實標示第三方來源及非本人目擊，提供必要來源／時間與合法影像再利用證據，排除個資與敏感野生動物位置；營運方得拒收、停用來源或要求補正。未經審核之線索及照片不得對外公開；此機制不構成緊急救援或政府派案。

Only explicit approval of this narrow exception and the proven pipeline can authorize later production automated intake. This document grants no general bot permission, source-content license, new credential/role or production write. Synthetic localhost rehearsal does not amend the current terms or enable the official path.

## Verification and release boundary

Run the v2 contract, local HTTP/store/scheduler and existing Hub regression suites with installed dependencies:

```sh
node backend/node_modules/jest/bin/jest.js --config backend/jest.config.js --runInBand --forceExit=false --detectOpenHandles --coverage=false --runTestsByPath backend/tests/jest/stray-map-intake-contract.test.js backend/tests/jest/stray-map-intake-rehearsal.test.js backend/tests/jest/aihankapps-hub-stray-map.test.js
```

The suites cover source-record uniqueness, immutable receipts across process restart and response loss, independent/cross-source review candidates, date-only/UNKNOWN/DST/offset behavior, region policies, original local language/captions, rights revocation, unsafe-photo refusal, pending invisibility, supervisor-only review, withdrawal/rejection and persisted scheduling quotas/outage behavior. The two-process CLI separately retains disk-backed milestone evidence. Earlier v1 test counts are not v2 evidence. Real photo-byte processing, true author permissions, production moderation and official API acceptance remain unverified here.

Self-review follows `docs/code-review-checklist.md`: A1 input → trusted policy/time/text/photo checks → fsync receipt → private review → safe projection; A2 the above suites and two-process CLI; A3 bounded success/machine-code envelopes; A4 missing verified full source, official pending intake, real media/rights checks, production persistence/auth/abuse controls and approved terms exception; A5 synthetic-only publishers/loopback, no source credentials/device impersonation, mandatory review and NEVER-sensitive projection. B1 `/api/help`, B3 product i18n, B4 product info and B5 production debug endpoints are NO-OP because no product route/UI is installed; B2 README/AGENTS/CLAUDE and the OpenAPI draft are synchronized. Original language preservation is tested as data rather than new UI translation keys.

This is a reviewable synthetic implementation, not a production release or completed real scheduled submission. H review is not applicable: no icon, UI or product release artifact is changed. Stale single-writer locks require manual investigation, and no crash/power-loss or multi-worker recovery guarantee is claimed. The official activation gate remains blocked; real image/license/sensitive-location review, narrow terms approval and the verified existing release path are still required.
