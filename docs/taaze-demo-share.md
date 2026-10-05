# One-demo, lasting capability sharing

This feature is limited to the explicitly approved TAAZE three-item Sites v5 demo. It does not publish the demo on the portfolio homepage or sitemap, change the original Site audience, send mail, create credentials, or grant admin access. A holder can forward a working capability URL. The content must retain the original price/condition/stock verification notices, illustrative map flow and unsent-order behavior.

## Original source and import boundary

The approved source is Sites project `appgprj_6abdc3c122208191be8ff9e9353294bf`, version `appgprj_6abdc3c122208191be8ff9e9353294bf~appgver_f19cee434a28819194ccf708990fe28b`, commit `5ca4b96da5c81448d8ab81f07686df1b4563bbb0`. The original TAR SHA256 is `eb5bd290c3fcbf087e077631560e4ba946988160ff546ff929152e74995d1cd9` (522240 bytes, reported 12 files).

The original archive is not checked into this public repository. It must arrive through an authorized export/download. No token, logged-in browser profile or protected Site scraping is an alternative. The importer verifies the actual TAR bytes against the pinned SHA before extracting files. A supplied file mapping selects original archive entries; the request cannot provide replacement bytes. A checksum-valid ordinary TAR is required; links, traversal, duplicate paths, device/sparse files and extended path overrides are rejected. If the original archive is source-only or uses unsupported metadata, stop the import and arrange a reviewed build/source delivery rather than treating an archive receipt as proof of unrelated uploaded content.

Limits: original archive and total selected assets each at most 2 MiB, 64 selected files, 128 archive entries, selected `index.html` required. Public paths are relative safe ASCII paths. HTML, JavaScript, CSS, JSON, common images, WOFF2 and plain text are allowed by extension. No files are written to `public/` or local disk. PostgreSQL holds the immutable bundle/assets privately; a different bundle cannot overwrite an existing imported v5.

## Existing-admin API contract

Only the bundle POST installs a guarded 6 MiB parser before global JSON, using cookieParser and the existing auth/admin plus shared cross-origin checks first. The actual admin router remains after normal startup and global API rate limits; all operations retain those existing gates. The new router uses the existing portal session; it requires no API key, OAuth or payment setup.

- `GET /api/taaze-demo-share/`: bundle metadata and latest 100 share IDs, creation/expiry/revocation times. No token, source bytes or demo content.
- `POST /api/taaze-demo-share/bundle`: `{sourceArchiveBase64, sourceCommit, files:[{path, archivePath}]}`. Verified archive entries are stored transactionally. Same bundle retry succeeds; different content returns 409.
- `POST /api/taaze-demo-share/shares`: `{requestId}` (8–100 ASCII alphanumeric/underscore/hyphen). Requires the verified bundle. Returns `{success:true,share:{id,createdAt,expiresAt,path}}`. `path` contains the only disclosure of a new 256-bit random capability. The database stores its SHA256, not the capability. A repeated request ID returns `share_already_issued` 409, so network retry cannot silently create another share. A lost creation response requires a deliberate new request; revoke the previous listed ID if needed.
- `POST /api/taaze-demo-share/shares/:id/revoke`: `{}`. Idempotent revocation records server time and existing admin identity.

No client may choose the expiry, source identity, token or actor. New shares have expiresAt null: no automatic expiry. Every resource still checks revocation on the server. Admin metadata survives restarts. There is no automatic issue/upload task and no connection to decisions, bot binding, progress approval or messaging.

## Every resource is checked by the server

Mount the terminal `publicRouter` at `/AiHankApps/taaze-demo` **before** pageview tracking, static assets and telemetry. This prevents a capability-bearing `index.html` path from entering application analytics and prevents a failed check from falling through to static content. Lazy pool/auth closures can reference the existing modules after application startup.

The only public resource shape is `/AiHankApps/taaze-demo/<capability>/<relative-asset>`; a trailing slash selects `index.html`. GET and HEAD both join the asset with a live, unrevoked, unexpired hashed capability. HTML, script, data and image requests all perform this check. Missing/wrong/expired/revoked capabilities, missing resources, invalid paths and unavailable databases return the same plain 404; no redirect or protected-file metadata is returned. There is no tokenless data/image URL or SPA/static fallback.

All responses use browser/CDN `no-store`, `no-referrer`, robots `noindex,nofollow,noarchive`, and `nosniff`. HTML inline script bodies receive exact SHA256 CSP allowances; external scripts/images are limited to same-origin. Network fetches are confined to the protected demo namespace, and forms/embedding are blocked. The original static source must work using relative asset paths; real-source browser verification is required before issuing the usable link. A recipient's already downloaded bytes cannot be recalled, but each later server request is denied after expiry/revocation. Platform/proxy request logs must also avoid retaining capability URLs; the feature writes no request/token logs itself.

## Verification and remaining release gates

`tests/jest/taaze-demo-share.test.js` uses only synthetic TAR/content and a test-only crypto mock for the approved-archive receipt; production has no request, environment or factory option to bypass the pinned SHA. Tests cover source validation and TAR attacks, private import, no automatic expiry, hashed-token storage, duplicate issue IDs, admin/member/anonymous/cross-origin access, correct/wrong/missing capabilities, HTML/data/script/image/HEAD checks, expiration, withdrawal, no static fallthrough, immutability, restart persistence and unavailable-database failure.

Before delivering an actual link: obtain and inspect the authorized original export; verify path mapping and original notices; import via the normal admin UI; issue one lasting link; perform a fresh anonymous full demo flow and direct-asset checks; verify homepage/sitemap exclusion; exercise invalid/expired/revoked synthetic links without publishing synthetic assets. No email is sent by this feature.

The existing admin workspace contains a collapsed Demo manager for the prepared original-export JSON, explicit lasting issuance and revocation. It never issues a link while source import is missing. Nonproduction/admin-only `GET /api/debug/taaze-demo-share` exposes asset/share counts, without tokens, source bytes or private IDs.

Latest user requirement (2026-10-05): long-term, no-login, dedicated link with immediate revocation. The earlier seven-day default is superseded. New database shares explicitly store NULL expiry; manager copy and uncertain-issuance handling follow this policy. Source acquisition and actual link delivery are still pending; no source-retrieval credential has been created.
