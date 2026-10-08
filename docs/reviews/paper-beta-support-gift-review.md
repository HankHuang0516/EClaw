# Remaining Paper Beta and support integration review

This candidate builds on main `910e4eda9d152c8b5072aae804819798dd4682d4`.
It gives existing account administrators a private view of the original Paper
Beta feedback table, consolidates support into the existing introduction URL,
and aligns portfolio, catalog and report display names with 元素戰機350 /
Elemental Fighter 350. Internal IDs and URLs stay compatible.

The official Paper trailer was already released in PR #5202; the portfolio gift
sidebar and verified celebration announcement were already released in PR #5203.
This integration preserves the trailer section, all three published gift assets,
the existing gift regression test and the celebration announcement. The older
campaign's linked display name is aligned with the catalog; its quota, contents,
dates, public status reader and fulfillment behavior are unchanged. No reward
dispatch code or recipient data is part of this candidate.

The owner explicitly approved publication of the existing report statistics and
inventoried management and engineering documents, with unchanged numbers and
without credentials or real player records. Report changes are display names
and matching release fingerprints; installation, download, advertising revenue
and error measurements are not altered.

## Reuse, quality and efficiency

- Reuse: existing cookie/Bearer session middleware, fresh database admin-role
  checks, the original PostgreSQL intake table, admin page and i18n dictionaries.
  No key, account, role, grant, table or feedback replication is introduced.
- Quality: fixed app scope and explicit response projection omit submission
  identifiers and identities. Bigint cursor bounds, no-store headers, text-only
  rendering, error clearance, bfcache refetch and stale-response rejection protect
  private feedback. Support, store links and the original review video remain.
- Efficiency: bounded 50-row keyset reads and a single SQL snapshot; existing
  public gift readers and native disclosure behavior remain in their published
  files. Traditional Chinese uses canonical zh through the existing zh-TW fallback.

## Core review

- A1 Logic: session → fresh admin role → fixed-app source → bounded projection.
  Malformed queries reject before reads; storage and browser errors fail closed.
  Support redirects preserve query parameters and supported navigation anchors.
- A2 Tests: auth and SQL regressions use synthetic fixtures; browser checks cover
  XSS text rendering, refresh/update, pagination, stale responses, denied reads,
  telemetry privacy and bfcache. A disposable PostgreSQL cluster verifies intake
  dedupe, source updates, aggregate scope and disjoint paging. Exact current test
  results and visual evidence belong to the release handoff receipt.
- A3 Return shape: existing envelopes and middleware behavior are retained;
  the new private reader uses machine-readable error identifiers.
- A4 Limits: no native binary/store release, unrelated role change, future-player
  reward automation or raw-feedback export. Guide snapshots remain historical;
  unavailable source is not represented as freshly verified.
- A5 Security: anonymous, expired and spoofed sessions, revoked/deleted roles,
  auth storage failures, oversized/injected cursors, unexpected fields and unsafe
  HTML are covered. Bot/device credentials cannot authorize private Beta reads.

## Extended review

- B1 API discovery: the protected reader and local diagnostic intent are
  documented in /api/help and OpenAPI without credential examples.
- B2 Docs: README, Beta/support documentation, project instruction parity and
  this review describe the remaining implementation. Local receipts, test logs,
  private reward snapshots and the transfer-only manifest are excluded from Git.
- B3 i18n: 24 new keys are supplied to Android's 18 locales through separate
  resource files and to all 16 iOS dictionaries. Android configuration strings
  remain byte-identical. Existing iOS fallback gaps are not expanded.
  Web dictionaries include the keys, with zh-TW resolving through canonical zh.
  Support prose is explicitly bilingual; game brands remain proper names.
- B4 Public surfaces: the existing introduction contains support/privacy/review
  material, while old support links redirect. Private feedback is not embedded
  in or fetched by the public support section.
- B5 Diagnostics: /api/debug/paper-beta-feedback reuses the protected reader and
  returns 404 before storage access in production or Railway.

## Publication controls

Legacy literal bot credentials were removed from the instruction documents;
runtime configuration, bindings and callbacks are untouched. The owner also
approved replacing the simplify login dependency with recorded manual reuse,
quality and efficiency review. Simplify was not run and is not claimed here.
PR-first publication, required CI, branch protection and production verification
remain required. This preparation round does not open a PR, merge or deploy.
