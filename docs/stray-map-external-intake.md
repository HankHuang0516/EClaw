# Stray Map external intake — CONTRACT DRAFT, disabled

Status: **BLOCKED: not deployed, official Stray Map API/source not verified, Hank terms approval pending** (2026-11-26). This is a source-independent proposal and executable pure contract, inside the existing EClaw worktree. It neither recovers the lost Stray Map source nor substitutes EClaw for its production backend. No credentials, permissions, scheduler, production terms or map records are changed here. Dot's hourly patrol remains read-only.

The separate source audit reports runtime TypeScript/dist and migrations but missing Git provenance, Dockerfile, lockfile and `tsconfig.base`; there is no proven repository/commit release lineage. Its private report remains outside this public repository. The reported existing `POST /v1/animals` publishes immediately; its photo queue is not a tip-review queue. The reported `/v1/*` pre-handler UPSERTs devices even on valid-device GETs. Therefore do not adapt either route, perform device probes, invent UUIDs or issue live POSTs from this draft. There is **no production route to wire**. Read-only PostgreSQL collection through the existing Railway channel and the admin Hub are separate work; external metrics remain unknown/null until a real approved intake exists.

The proposed `POST /v1/public/tips` is **disabled by default**. `tools/stray-map-intake/contract.js` exports frozen draft metadata with `enabled: false` and `officialApiVerified: false`; it contains no route, networking, persistence or activation mechanism. Its successful validation means only “this synthetic/private input satisfies the draft checks,” never “accepted by the official API.” The companion OpenAPI is a proposal with an `example.invalid` server, not a discoverable live service.

## Experience and trust boundary

Keep the existing human app experience unauthenticated. The proposed external intake is independent: no app login, anonymous-device impersonation, `deviceId`, `deviceSecret` or client publication controls. All external submissions are labelled **third-party public clues, not self-witnessed**. They enter private `PENDING` review with `publicVisible: false`; there is no anonymous publication path. A client cannot choose `APPROVED`, `PUBLISHED`, a map ID, moderation outcome or precise location. This is neither emergency rescue nor government dispatch.

The publisher registry is trusted server context, provisioned only after source audit and approval. `publisherId`, public URL and client assertions do not authenticate a person or prove a post's truth. The registry restricts exact HTTPS origin and reviewed path prefix; reviewers must independently check provenance, original publication/observation dates, rights and location sensitivity. Nothing here authorizes scraping a site's terms or obtaining a new credential. Do not reproduce source text, names, social handles, phones, addresses or private attribution in public output.

## Wire proposal and executable boundary

Use JSON UTF-8 only, maximum **16,384 actual bytes**, including whitespace; `Content-Length` alone is insufficient. Reject compressed bodies (identity only), malformed UTF-8, invalid JSON, duplicate keys including escaped duplicates, unknown/missing properties and non-JSON media types. The future HTTP adapter must enforce the cap while streaming, before full allocation or JSON parsing, plus header/body/time limits and content-encoding guards. The pure function can check only bytes already supplied to it.

Require `Idempotency-Key: [A-Za-z0-9_-]{16,128}`; production keys should be randomly generated, retained by the sender and never used as authorization. Request fields, all required:

| Field | Draft rule |
| --- | --- |
| `schemaVersion`, `thirdParty`, `selfWitness` | Exactly `1`, `true`, `false`. |
| `source` | Only `publisherId`, `url`, `publishedAt`. Registry publisher matches exactly; lower-case ID, 3–64 characters. |
| `source.url` | HTTPS, ≤1,024 characters, no user info, IP literals, non-default port, whitespace/backslash, local host suffix or encoded reserved path characters. Exact approved origin and path prefix, with a post path following the prefix. |
| `source.publishedAt` | A real UTC date, `YYYY-MM-DDTHH:mm:ss[.SSS]Z`. |
| `observedAt` | Same date format or `null` when observation time is unknown. Never substitute publication time as an observation. |
| `animal` | Only `kind`, `count`, `condition`. Kind: `DOG`, `CAT`, `OTHER_STRAY`, `WILDLIFE`; condition: `UNKNOWN`, `ROAMING`, `INJURED`, `DECEASED`; count: integer 1–100 or `null` for unknown, never a fabricated zero. |
| `location` | Only `regionCode`, `sensitivity`. Region: one of 22 county/city codes enumerated in OpenAPI, or `null`. No district, coordinates, address, geohash, landmark, nest/species name or free text. Sensitivity: `NONE`, `UNKNOWN`, `PROTECTED_SPECIES`, `NEST`, `HABITAT`. |
| `photos` | Array, 0–2 opaque verified-upload references with rights metadata below. Empty is valid; never invent or substitute a photo. |

`submittedAt` is injected by the server, never accepted from a client. Require `observedAt ≤ publishedAt ≤ submittedAt` when observation time is known; unknown observation time remains null. No future clock allowance, inferred dates or age-based automatic rejection in this draft. Stale historical tips require review and must not appear as current sightings. Reviewers verify dates against private source evidence; chronology alone is not proof.

Canonicalization lowercases the HTTPS host via the URL parser, removes default port, removes fragments and only `utm_*`/`fbclid`/`gclid` tracking parameters, decodes unreserved path escapes, and normalizes UTC timestamps to milliseconds. Any other query parameter is rejected, rather than risking personal data or silently discarding a source's identity. Path case/trailing slash remain significant. Sources requiring semantic query IDs or Unicode paths need a separately reviewed contract revision. URL normalization is syntactic only; **no DNS, redirects or fetching**, including images, is performed. It does not verify a URL is public, truthful or free of personal information. The source URL is private review evidence and is never automatically relayed to public clients.

Every `WILDLIFE` tip, any sensitivity other than `NONE`, or unknown region yields `mapPolicy: NEVER`, even if the client calls it harmless. Such records must never produce a public pin, exact timestamp/location projection or revealing photo through this contract. Ordinary stray tips with a known coarse region yield `REVIEW_REQUIRED`, which still grants no map visibility. A reviewer may reject or retain privately; this draft has no approval implementation. Later publication requires a separately authorized server-side projection and existing moderation, with sensitive wildlife excluded. Suppress small identifying aggregate cells rather than exposing sensitive regions through Hub statistics.

## Photographs: private references, explicit reuse evidence

The request accepts **no image URL, data URL, base64, file path, image bytes or remote-fetch instruction**. Each photo has only:

```json
{
  "uploadId": "up_synthetic001",
  "rights": {
    "license": "EXPLICIT_PERMISSION",
    "evidenceRef": "ev_synthetic001",
    "attributionRef": "credit_synthetic001",
    "permitsRedaction": true
  }
}
```

An opaque reference is not evidence by itself. The future uploader must receive bounded bytes separately through a verified operator workflow using existing authorized access, never fetch arbitrary submitted URLs. Its private safe-upload record must bind the ID, publisher, canonical source URL, same-case confirmation and exact rights metadata to the actual sanitized image digest. It must verify explicit permission or the exact applicable reuse terms, preserve original permission/license evidence privately, and prepare a non-identifying approved credit. `attributionRef` points to that reviewed credit, not a name/social handle supplied in the tip. Never erase attribution obligations to avoid a privacy conflict: omit the photo if both cannot be satisfied. No uploader or new credential is implemented or authorized here.

Draft policy accepts only `EXPLICIT_PERMISSION`, `CC_BY_4_0`, `CC0_1_0` as **candidates for human rights verification**, not legal proof or automatic permission. Others, including unknown, NC, ND and SA variants, are outside this narrow draft policy; that is a product restriction, not a claim about their general legality. CC BY 4.0 permits sharing/adaptation subject to conditions including appropriate credit, a license link and indicating modifications. Its deed also warns other rights may require permissions. CC0 does not eliminate privacy/publicity concerns. Consult the official [CC BY 4.0 deed](https://creativecommons.org/licenses/by/4.0/) and [CC0 1.0 deed](https://creativecommons.org/publicdomain/zero/1.0/) (read 2026-11-26). A publicly viewable post is not a reuse grant. Store evidence of the license applying to **this specific image**, permission for required edits, and the reviewed attribution/modification record.

The trusted safe-upload record must have all of these true: `reuseConsentVerified`, `exifRemoved`, `geoRemoved`, `manualRedactionConfirmed`, `noFacesOrPlates`, `noPersonalData`, `noSensitiveVisualLocation`, `caseMatchConfirmed`. `permitsRedaction` is required even when no edit is ultimately needed; any edits/credit changes must remain recorded in the evidence. EXIF removal alone does not remove visible landmarks, embedded text, XMP/IPTC location or faces. A human must confirm redaction, matching case and non-identifying visual context after safe decode/re-encode. If a sensitive location remains recognizable, omit the image and retain the clue privately with `mapPolicy: NEVER`.

The sanitized records also require a SHA-256 digest, actual byte size 1–5 MiB each, at most 8 MiB combined, MIME `image/jpeg`, `image/png` or `image/webp`, dimensions 1–8,192 each and ≤16,000,000 decoded pixels. The uploader must enforce these limits on bytes and decoded output, reject polyglots/animation/unsupported types/decompression bombs, scan safety, strip all identifying metadata, validate file signatures and private ownership, and keep originals/evidence out of public storage. **The pure validator checks supplied trusted metadata, not actual image bytes, licenses, consent, redaction, EXIF or content.** The absence of that future verified record rejects the photo. A photo-less tip can still proceed to pending review.

## Idempotency and suspected duplicates

Hash the canonical payload with sorted object keys, ordered photo arrays, canonical source URL and UTC dates. All admitted semantic fields, including photo evidence/attribution references, are included. Server receipt/time, review outcome and candidate signal are excluded. Scope the idempotency key by publisher: `(publisherId, key)`.

`decideIdempotency` returns `RESERVE` for no stored row; it **does not persist a reservation**. Same scoped key and payload hash replays an exact copy of the original private acceptance receipt, with the original `tipId`, `submittedAt`, `PENDING` and `publicVisible: false`. That immutable receipt is not current moderation status. Same key with another canonical payload returns `409 IDEMPOTENCY_CONFLICT`; never overwrite. Different publishers use independent scopes. The future store must atomically commit tip + receipt + key under a unique constraint, handle concurrent reservations/in-progress retries, never acknowledge failed writes, and maintain a documented retention window (proposal: at least 90 days, with explicit expiry behavior before activation). Do not turn storage failure into an empty/new key. Lookup/replay must not expose whether another publisher's key exists. These durability, concurrency and expiry guarantees are **unimplemented**, not demonstrated by pure decisions.

Private `candidateFingerprint` hashes version `stray-case-v1`, kind, county/city and the UTC **observation day**; it deliberately excludes publisher and source URL, so different sources can produce a review candidate. It is null for unknown observation time/region, sensitive records or wildlife. It is coarse and fallible: distinct animals can collide and the same case can cross a day/region boundary. Candidate equality is **not a merge, rejection, unique constraint or deduplicated-case count**. Keep every source and receipt; only a separately audited human review may link cases. Treat the fingerprint as private location-derived data, not anonymization or public identity.

## Future HTTP/review controls — required before activation

Activation requires proven production source/revision + Hank's terms approval + review/storage/uploader/rate-limit/security acceptance. Keep disabled when any prerequisite or dependency is absent. No source audit result is asserted here. Before parsing, impose per-IP and global rate limits; after a verified source match, add publisher and review-queue budgets. A proposed starting ceiling is 5 requests/minute and 30/hour per IP, 30/hour per publisher, plus a bounded global/private queue. These numbers require operational approval/load testing and must use the proven service's existing abuse controls, trusted proxy configuration and moderation process. Return `429` with `Retry-After`; request limits do not replace source validation. No limiter is installed by these files.

Proposed response convention is `{ success: true, tipId, status: "PENDING", publicVisible: false, submittedAt }` on durable `202`, including replay; errors are `{ success: false, error: "SHORT_CODE" }`. The pure functions additionally carry `status` to propose HTTP mapping and return private evaluation data; **do not send a whole validator result as a response**. Use `400` invalid input/timeline, `403` unverified source, `409` payload conflict, `413` size, `415` media/encoding, `429` quota, `503` disabled/dependency unavailable and `500` unexpected internal context/state errors. Do not echo rejected values, URLs, identities, keys or photos in errors/logs. Reviewer/admin access stays under existing roles; pending photos, source/rights evidence, case candidates and raw records stay private. Build an authorized status/appeal and retention/removal process before real ingestion; this draft adds no public GET, debug route, auth path or broadened access.

Required integration tests after the source is proven: streaming caps, actual media sanitization/content review and uploader ownership; moderation visibility via every public list/map/photo/cache route; trusted time and abuse limits; atomic duplicate races and crash/restart retries; role isolation; downstream aggregate privacy; disabled/unavailable source behavior. Use isolated synthetic data only, never production pins or live POSTs.

## Aggregate semantics for the separately implemented Hub

This module collects no statistics. `countOrUnknown(value, { sourceAvailable })` preserves a real non-negative integer zero **only for an available source**; missing, malformed or unavailable values remain `null`. Never substitute zero for missing tables, unavailable API, unknown observation/count or an unimplemented dedup/review stage. Cached historical data may be shown only as explicitly stale with its original observation/update time.

For each authenticated Hub aggregate, keep native map reports and external tips separate. Report input clues, suspected candidate groups, human-confirmed deduplicated cases, pending, rejected and actually published records as distinct measures with their own backend lineage and availability. Replays are not new inputs, candidate hashes are not confirmed cases, and pending is never “on map.” Scope/window/timezone, latest successful update, coverage/missing stages, available trend/type/coarse-region data and small-cell/sensitive suppression must accompany values. Preserve existing Hub roles/mobile style; expose no private source identities or wildlife locations. The OpenAPI `NullableCount` is an illustrative reusable component, not a deployed statistics endpoint. Hub HTTP/UI/empty/outage checks belong to the separate collector/UI change.

## Terms section 4 — proposed narrow exception, PENDING HANK APPROVAL

The separate audit identifies current legal version `v2026-09-14.1`, `/terms?lang=zh-Hant`, clause 4: 「**自動化行為**：使用 bot、爬蟲、模擬器大量張貼、灌票、規避速率限制」. This provenance is the supplied audit result, not an independent legal/source verification by this pure-contract change. The proposed exception below leaves that general restriction intact.

**Draft wording only; do not publish or use as authorization:**

> 第 4 條對一般機器人、模擬使用者與批次發文的禁止維持不變。僅經營運方書面核准，且依另行公告之正式外部線索 API、已核准來源與使用範圍提交之第三方公開線索，得作為例外送入非公開待審佇列；不得模擬 App 匿名裝置識別、規避限流、直接發布或自動取得審核通過。通報須如實標示第三方來源及非本人目擊，提供必要來源／時間與合法影像再利用證據，排除個資與敏感野生動物位置；營運方得拒收、停用來源或要求補正。未經審核之線索及照片不得對外公開；此機制不構成緊急救援或政府派案。

This exception requires Hank's explicit approval of the wording and approved pipeline before any production auto-write. It grants no general bot/bulk permission, new credentials, additional roles or implicit license to any source content. Current terms are unchanged.

## Synthetic verification and checklist

Run from the existing worktree, using the already installed dependencies; no installation, database or network is required:

```sh
node backend/node_modules/jest/bin/jest.js --config backend/jest.config.js --runInBand --runTestsByPath backend/tests/jest/stray-map-intake-contract.test.js --no-cache --coverage=false
```

Tests compare the executable structural rules with the draft OpenAPI, and exercise source/time/field limits, default-disabled metadata, pending-only output, sensitive handling, photo metadata rejection, deterministic replays/conflicts, different-source candidates and unknown/zero counts. Fixtures and URLs are synthetic `example.invalid`. Tests do not make HTTP requests, create pins, collect sources, prove rights, sanitize image bytes, connect to the official API, test review/storage or validate Hub rendering.

Local verification on 2026-11-26: **139/139 Jest tests passed**; targeted ESLint on `tools/stray-map-intake/contract.js` passed with `--max-warnings=0`; `node --check` passed for the contract and test file; all four files passed whitespace/final-newline checks. The existing Jest config uses `forceExit`; its standard force-exit advisory is not evidence of HTTP/storage integration testing. No dependency installation was needed. Lightweight test space budget was 0.1 GiB including margin; project-storage reported more than 37 GiB local free with the separate 20 GiB reserve intact.

Self-review against `docs/code-review-checklist.md` (contract component; production activation remains blocked):

- A1 ✅ Logic trace: bounded decode → exact structure/source/time/animal/location → trusted photo references → private pending result; idempotency decisions never mutate storage. Failures return only bounded codes.
- A2 ✅ Test coverage: `backend/tests/jest/stray-map-intake-contract.test.js`, 139/139 passed. No DB calls/mocks are needed for this pure module; the existing shared `helpers/mock-setup.js` is used, no alternate mock infrastructure.
- A3 ✅ Return shape: `success` convention, machine-readable errors; private validator/decision data is intentionally distinct from the proposed HTTP receipt. `413/415/429/503` are explicit protocol-specific additions.
- A4 ⚠️ Gaps: official source, HTTP/stream/rate limits, uploader/content/rights checks, moderation/storage/concurrency, role isolation, public projections, Hub UI, production terms and all integration acceptance remain separate work.
- A5 ✅ Security: strict fields/no client publication or device impersonation; exact registered source; no I/O or remote fetch; photos require trusted evidence and bounded metadata; pending/sensitive invariants and no value echo covered by tests. No mutating endpoint exists to receive device/bot secrets.
- B1 ⚠️ `/api/help` NO-OP — no new endpoint, only a disabled contract proposal.
- B2 ✅ Related docs: this draft plus companion OpenAPI. The integrated Hub references are in README, AGENTS.md, CLAUDE.md and backend/AIHANKAPPS_HUB.md. Current Stray Map endpoints, terms and patrol behavior are unchanged.
- B3 ⚠️ i18n NO-OP — pure contract/docs/tests, no user-facing UI strings.
- B4 ⚠️ Info page NO-OP — feature not surfaced to end users.
- B5 ⚠️ Debug endpoint NO-OP — no deployed endpoint or persisted state; do not expose private evidence through a new route.

Result: reviewable contract draft; **needs follow-up before implementation/activation**, not production-ready. H icon review not applicable: no icon, UI or release artifact changed or published.
