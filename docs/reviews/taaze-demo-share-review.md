# Prepared Demo share review

Status: local preparation only, awaiting the authorized original Sites v5 export. No real Demo bytes, bearer link, private project prose or credential is committed. This branch must remain undeployed until the original source and full anonymous flow are verified.

## Reuse, access and data

Existing portal auth/admin middleware and cross-origin checks protect every management action. A bounded archive parser runs only after those checks; the admin router retains startup/rate gates. The terminal public router precedes pageview tracking and static fallthrough. The actual archive SHA and source commit are pinned; mappings can select only original archive bytes. PostgreSQL transactions retain immutable assets, hashed capabilities, server expiry and revocation across restarts. Duplicate issue IDs cannot silently create another link.

## UI quality and efficiency

The existing dot-progress manual substitute applies to the manager in that workspace; simplify was not run or claimed. The manager starts collapsed, loads metadata only on demand, disables issuance without an imported source, and keeps a new link only in session memory. Lost creation responses retain the original request ID for explicit retry and require revocation/acknowledgement before a fresh intent. Session epochs and cleanup prevent stale metadata or links from reappearing after logout. Existing private requests, busy helpers and canonical translations are reused. Six content-versioned resources update together.

## Checked locally

- Final focused backend: 9 passed, with the optional real-PG case skipped in this final run. The earlier separate real-PG run passed concurrency, rollback and new-pool persistence before its disposable server was stopped.
- Synthetic manager browser: 41 assertions; existing A UI regression: 104 assertions.
- Assets and i18n: 18 tests; strict i18n passed. Node syntax and diff checks passed. Targeted lint has no errors; existing index unused-argument warning remains.
- Synthetic 390px and 1280px manager screenshots inspected without overflow.
- API help documents private metadata/import/issue/revoke; nonproduction admin debug exposes counts only. No homepage or sitemap entry is added.

## Open release checks

Obtain the authorized exact original archive or review a new source delivery with version proof; inspect original notices, assets and relative paths/CSP compatibility; run normal PR/CI/review; import and issue via the existing authenticated UI; verify real anonymous HTML/data/images/full flow and revocation/expiry. The current source download error is `file could not be authorized or resolved`; downloads stopped without a bypass. Deployment, actual source import and real-link creation have not happened.
