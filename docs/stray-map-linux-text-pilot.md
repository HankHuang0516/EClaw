# Linux/amd64 text/coarse-region candidate — two separate decisions

The later [joint patrol test](stray-map-patrol-joint-test.md) gives Hank and dot a rerunnable anonymous-source → pending receipt workflow against this exact candidate. It records the deployment authorization and the still-unverified existing official intake binding separately.

Draft5527 now has an unsigned, privately built **Linux x64 backend candidate**, an independent text-only pending plugin and actual isolated PostgreSQL acceptance. The candidate is closed by default and has **no production source/reviewer binding**. Its enabled behavior was exercised through an external test entry and test identities that are not packaged. It is not a deployed official API, original source restoration, mobile App, map layer or photo feature.

| Level | Evidence and decision boundary |
| --- | --- |
| Build can enter the next review stage | Linux x64 Node/codec/startup and repeated clean compilation pass; candidate contents are inventoried; default-closed and local explicit activation/rollback pass. Hank can decide whether to adopt this labelled reconstruction and its new text contract for the existing release process. This does not authorize deployment or submissions. |
| Formal writing / public reading | **HOLD.** No production verifier, source scope or reviewer mapping is wired; no terms exception or formal deployment/write is authorized. Public read is a separate default-off gate. The existing patrol remains public-API-only/read-only/no Codex. |

## Host and build evidence

The Docker host is Linux arm64 (Docker Desktop on the Mac). The actual build and API processes run the official public Node **22.23.3 Linux/amd64** userspace through emulation, glibc **2.36**. This is an x64 Linux execution, not a Darwin build relabelled as Linux, and not the Railway host/kernel/network/storage environment.

The public `docker.io/library/node:22.23.3-bookworm-slim` index selected amd64 digest `sha256:bbf39cb344bb33c1f2eedb3b45b4a890eecfbac91a4f7bac020a95d4e4ea147e`. Registry digest matching was recorded; signature verification was not performed. No paid service, new login, privilege expansion or image push was used. The existing PostGIS 17 image provides an isolated arm64 PostgreSQL server; this is not an all-amd64 production-stack claim.

The preparer reads only the existing checked baseline and sanitized dependency metadata through read-only mounts. A new Linux reconstruction lock pins the captured production selections and documented development selections. Two clean `npm ci --ignore-scripts` installs and TypeScript builds produced **31 identical outputs** and an unchanged lock; those compiled JS hashes also match the previous Darwin compilation. Native dependency equivalence is not inferred from JS equality. Actual Linux Sharp **0.35.4 / libvips 8.18.6** encoded and decoded self-made 3×2 pixels. The installed comparison is **195/199 matches, zero unknown missing/version mismatches**; three optional entries are omitted and one development TypeScript selection differs, as documented previously. Model inference is not tested. The actual nsfwjs Node-engine warning remains recorded and its declaration is not rewritten.

Original root lock, Dockerfile, base compiler configuration, full original source/Git and exact original build pipeline remain unverified. The root configuration and reconstruction manifests/lock are labelled rewrites. Nothing overwrites or restores the damaged source. Original runtime/source files stay in the existing private evidence area; no runtime capture/source/package/image is uploaded or committed to Git.

## Candidate contents and activation boundary

`linux-build.cjs` creates an exact allowed set: selected unchanged compiled native API/contracts (excluding nine application test files, the migration runner and Flickr authorization CLI), required legal/content files, selected package manifests/lock and a fresh production-only `npm ci --omit=dev --ignore-scripts`, plus:

- `integrations/stray-map-pilot/pilot.cjs` and `store.cjs`;
- the existing pure `stray-map-intake/contract.js` validator, with an explicit CommonJS scope manifest;
- a new labelled native entry that installs the plugin before the unchanged native device hook, rebasing only relative imports. Root/API package scripts are rewritten to start only that entry; dependency declarations stay unchanged.

The candidate contains no synthetic service, fixture data/receipts/database, scheduler rehearsal, Unix socket controller, client specimen, test entry, test identity adapter, migration runner, seed or live environment file. The complete file inventory and original/extended entry hashes remain private. Dependency packages are ordinary locked registry contents; test-tool exclusion refers to our application/tooling, not a claim that upstream packages never contain examples/tests. No application migration runs on default startup. The new entry supplies only the existing pool; it supplies no identity/configuration binding, so every pilot operation stays closed.

The only extra plugin dependencies are its store and the pure contract helper. It does not import `PendingService`, `rebuild_external`, any synthetic service or captured credential transport. Its callbacks/configuration have no environment lookup, test fallback, self-asserted user identity or new credential/role. The build's pure lock helpers now lazy-load acquisition transport only for explicit acquisition; ordinary Linux reproduction does not contact Railway.

The formal integration seam, after a separate adoption decision, is:

```js
await install(app, { pool, configuration, bindings, now });
```

`configuration()` may enable only exact `profile:'TEXT_COARSE_PENDING_V1'` and boolean `intake`, `review`, `publicRead`, with bounded server-owned limits. Missing/wrong profile, unknown configuration, absent verifiers, invalid policies or verifier failure stays closed. Defaults are all false. `bindings.sourcePolicies` is a server-owned allowlist; `verifySource(request)` must return an authorized publisher/dataset; `verifyReviewer(request)` must return an authorized reviewer principal with explicit review permission. A payload claiming a publisher or a public URL is not identity evidence. These verifier functions are **not implemented for production here**.

An explicitly bounded pool is required before DDL: acquisition timeout up to 3 s, server statement timeout up to 5 s, and a larger client timeout up to 6 s. Transactions additionally set server lock/statement timeouts; failed rollback discards the connection. This does not mutate the legacy pool. The formal adapter must provide its legitimate existing DB configuration and bounded pool through the approved integration; no DB permission is expanded by this draft.

## Narrow JSON contract

All paths are separate from native `/v1/*`, with 16 KiB bodies and no-store bounded success/error envelopes:

| Path | Gate and access |
| --- | --- |
| `POST /external-intake/v1/tips` | intake + authorized source scope; v3 third-party text, null source URL, no photos, non-sensitive domestic animal and country-qualified coarse region only. |
| `GET /external-intake/v1/receipts/:id` | intake + same authorized source scope; immutable original pending receipt plus current review state. |
| `POST /external-intake/v1/review/:id` | review + authorized reviewer; mandatory manual checks and separate reviewed original-language public display for approval. Rejection/withdrawal cannot become approval by replay. |
| `GET /external-intake/v1/cards` | independent publicRead gate; anonymous JSON of approved public artifacts only, never raw source keys/IDs, photos or points. |

These are candidate paths, not verified official production endpoints. The older formal `/v1/public/tips` draft remains disabled; adopting the new dedicated path is an explicit contract/routing decision. Native middleware, device identity, DTO and legacy list/share/mutations are not exempted or replaced. There is no text webpage in this candidate and no App or pin/image compatibility claim.

The new store uses its own `stray_text_pilot` schema, lazily initialized only after open gates and verified bindings. It atomically commits fresh receipts, respects `(publisher,key)` idempotency across datasets, independent stable source-case keys, queue/request capacity and persistent per-source hourly admission limits. Original receipts do not change after review. Public cards retain DATE/INSTANT/UNKNOWN, original locale, LOST last-known / FOUND found-at / SIGHTING observed-at semantics and separate care/asOf, with `coordinates:null`, `photos:[]`, marker eligibility false. No source URL, private key, current care position, instant or reunion is invented. Conservative text rejection supplements mandatory human privacy review; it is not universal personal-data detection.

This candidate intentionally does not package polling, the earlier synthetic source lifecycle/dedup implementation, photo moderation, an automatic matching workflow or a map adapter. The optional first formal scope is **pending text intake only**; original-source update/closure handling and human case verification must be mapped to the chosen legitimate source workflow before any public-read authorization. Earlier synthetic lifecycle evidence is retained but does not prove those production integrations.

## Actual isolated acceptance

Private root: `/Volumes/ProjectsData/portfolio-private-staging/20261126-stray-map-isolated-rebuild/linux-amd64-20261127/`. `acceptance-d64ad8ec` passed **15 named checks**, plus separate default-closed and fresh-process persistence probes:

- Official-image x64 native server health; four selected native GET/negative-write response comparisons match original entry vs closed candidate. No pilot DDL is created by default or by test bindings alone. This is limited legacy compatibility, not a full authenticated native App regression.
- Three generated text cases enter actual PostgreSQL with independent pending receipts; retry/new request key retains original receipt, dataset switching with the same publisher/key conflicts. A fourth new case is actually rate limited. Photo/URL/point/wildlife, oversized and unsupported MIME input is rejected.
- Pending records stay absent with publicRead on; an unverified source, unauthorized reviewer, missing checklist or unsafe public text cannot publish. Approved English DATE/care records preserve their precision; no photo/point or private source key projects. A separate Traditional Chinese instant case is rejected, not represented as a public card.
- Actual SQL advisory-lock contention plus a saturated dedicated two-connection pool returns bounded 503s; all waiting queries terminate and no delayed tip is inserted. This is server cancellation/timeout evidence, not just a timed-out JavaScript promise.
- Turning all three local test gates off closes intake/receipt/review/public reads without changing the three stored cases/receipts. Intake-only reactivation replays the original receipt with public read still off. Withdrawal/rejection remains hidden; replay cannot reopen it.
- A fresh process re-reads all three original receipts and terminal states. Native devices/animals/sightings stay **0/0/0**. Candidate files were mounted read-only; exact packaged plugin bytes match the tested source. All owned containers stop; generated records and evidence are retained. No host port, formal DB or external network is used during runtime acceptance.

The original native bootstrap reads environment files and starts deletion/push/photo-review/mail jobs. Test isolation is applied **before** native import: credential-free explicit test environment, empty application DB, no-network namespace and an external loopback/environment guard. None of that test guard or activation driver is in the candidate. Baseline migrations run only in the separate empty-DB test driver; their data/terms updates are not put into candidate startup. PostGIS's three built-in metadata relations are allowed when asserting the DB has no application tables. The first incorrect zero-table assertion is retained as `acceptance-07b701a3`, not counted as a pass.

The baseline's DB TLS setting (`rejectUnauthorized:false` for some non-local connections), background jobs, real storage/model behavior, production trust proxy/limits and full native user flows still require release review. Passing this private candidate does not certify those existing behaviors. No App source rescan, reverse engineering, signing, Keychain, support contact, account/access/terms change, production deployment or test pin occurred. H review is not a formal release pass: no product artifact was published; the actual adopted release must still complete applicable H checks.

## Reproduction and next operations

Verify `python3 /Volumes/ProjectsData/check_storage.py` and the existing project-storage reserve before starting. This run budgeted 4 GiB additional space, retaining the separate 20 GiB system reserve. Reuse the private checked baseline/metadata and pinned official image; do not reacquire source or read damaged archives. The private `BUILD_COMMAND.private.json` records the exact Docker argv/mounts/user/security settings. Run `linux-build.cjs /inputs /output compile` under that x64 image with only the listed baseline/metadata and tooling mounted read-only, then its `candidate` phase with the two plugin files and pure validator mounted read-only. It refuses existing build/candidate directories. The original failed helper-import attempt is retained; pure helper transport loading was corrected without contacting a source service. An earlier candidate package inadvertently retained compiled application tests/operations CLIs; it is retained as `candidate-rejected-allowlist-v1` with a HOLD receipt. The corrected packager excludes those eleven files, performs another clean production install and validates the final candidate separately. The 31-file compiler reproducibility evidence remains unchanged; the runtime candidate uses the needed 20 compiled files.

Run pinned Node with `tools/stray-map-rebuild/run-linux-pilot.cjs /absolute/private/linux-root`. It uses the existing PostGIS image, creates only labelled no-network resources, mounts candidate read-only, and keeps all test entry/identity/gate/receipt files outside `candidate/`. No on-machine schedule is installed. Regressions are all 14 `*stray-map*.test.js` suites with the existing Jest config; the new candidate module suite contains 43 tests.

The reviewable first-stage option is to adopt the labelled candidate, then wire **legitimate existing** source/reviewer bindings and a bounded DB pool through the existing approved release flow, keeping `review:false` and `publicRead:false` until their own acceptance. Do not ship the external test entry or substitute it for those bindings. Accept only authorized scoped pending submissions with immutable retry receipts; preserve the original native behavior. Formal scheduled submission can be authorized only after the actual official route/auth/receipt checks pass. Public JSON cards are a later explicit permission; they do not replace the original App.

Final local regression is **522 tests / 14 suites passing**, `forceExit=false/detectOpenHandles`, with no open handles; all 27 reconstruction/pilot/client JS/CJS files lint with zero errors/warnings. The new candidate suite supplies 43 tests. Independent limited review found and resolved exact-profile activation, publisher/key idempotency and bounded PG waits; the last issue is also exercised with actual PostgreSQL contention. This does not promote the draft or replace current-head full CI.

Questions Hank can decide without disclosing secret values:

1. Adopt this unsigned reconstruction/new Linux lock/configuration and candidate contract for the next review stage, acknowledging it is not recovered original source?
2. Which **existing** patrol/service/operator principal may submit which publisher/dataset scopes, pending-only? Which existing administrator may view/review/withdraw the queue?
3. May the chosen existing mechanism be explicitly mapped to those roles, and is a narrowly API-only exception to section 4's bot/batch prohibition approved? Current terms remain unchanged until confirmed. A new credential is not presumed necessary; if existing access cannot legitimately cover a role, that exact new access becomes a separate owner decision.

Static source evidence shows native `requireAdmin` compares `x-admin-token` with `ADMIN_TOKEN`, disabled when unset. It covers existing photo/report/admin actions, has no external source/dataset role, uses a shared `admin` principal and is not exported. This is a possible authorized review-access choice, not proof that it is configured or authorized for the new queue. No value was read or reused. Importing the entire server merely to get that function would start background jobs and is not a valid binding method.

Rollback is to stop/drain the newly authorized intake, close review/publicRead as applicable, and retain all pending/terminal cases, immutable receipts and audit history. Never delete the schema/queue or rewrite original receipts as rollback. The local sequential gate transition is tested; an actual deployment must specify writer drain/restart and how the previously reviewed native artifact is restored. No production rollout/rollback was performed. With these decisions outstanding, further synthetic experiments do not authorize formal writes; this draft stops at the concrete adoption/identity/rule gate.
