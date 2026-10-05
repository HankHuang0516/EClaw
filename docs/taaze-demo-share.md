# Original v5 Demo with lasting, revocable links

The approved TAAZE three-item Sites v5 Demo is available only through a dedicated bearer link. A recipient needs no login; anyone holding or forwarding the link can view it. New links have no automatic expiry and can be revoked at any time. This does not publish a homepage/sitemap entry, grant admin access, change the original Site audience, send mail, or connect a bot.

## Exact original source

The original commit is `5ca4b96da5c81448d8ab81f07686df1b4563bbb0`. Its authorized recovery ZIP is 370,039 bytes, SHA256 `8d945ff62116e8053dc2a9c2a52ffe5aa767a78f36cc843295faa0dd0c69f34b`. The server verifies the actual ZIP bytes and the commit before extracting anything. It imports all 11 files under `original/dist/` without changing their bytes. Hosting configuration, recovery receipt, README and manifest are excluded from delivery. The original material stays outside this public repository and outside `public/`.

The bounded ZIP reader validates central/local records, CRC, sizes, offsets, compression, paths and file types. It rejects encryption, extended overrides, ZIP64, links, traversal, duplicate paths, overlapping/gapped records and decompression over 2 MiB. The source archive and total extracted files are each limited to 2 MiB, with at most 128 entries and 64 served files. Any explicit file mapping must cover the complete dist set and retain original relative paths. A different bundle cannot replace an imported one.

The existing price/condition/stock and display-permission notices, ISBN/source facts, three cover files and illustrative-location warnings remain intact. The only external runtime requests are OpenStreetMap tiles. The original inquiry and display-selection interactions remain previews; they do not send an order or message.

## Normal administrator workflow

Open the existing private dot-progress workspace and expand **TAAZE Demo 分享管理**. Select the recovered original v5 ZIP, then explicitly confirm its import. Selecting a file alone never uploads it. The manager also accepts a prepared source JSON for the API contract below. After import, explicitly create the lasting share link. Its bearer URL is displayed once and held only in the current signed-in page session. Keep it out of public PRs/issues, logs and browser persistence.

The list retains private IDs, creation/expiry/revocation metadata, but cannot recover a bearer URL. If a creation response is lost, retry the same operation. Refresh metadata and revoke newly listed active shares before closing that uncertain attempt and deliberately creating another link. Revoking a link immediately prevents later HTML, script, data and image reads. Already downloaded bytes cannot be recalled.

## API and persistence

All management actions use the existing portal auth/admin middleware and cross-origin checks. Bot/device credentials confer no access. Only an authenticated bundle upload gets the larger 6 MiB JSON parser; the final admin handler retains normal startup/API-rate gates.

- `GET /api/taaze-demo-share`: private bundle metadata and latest 100 share IDs/times, without source bytes or tokens.
- `POST /api/taaze-demo-share/bundle`: `{sourceArchiveBase64,sourceCommit,files?}`. Missing `files` selects the complete original dist set. Identical retries succeed; unrelated input is rejected. Bundle/assets commit atomically.
- `POST /api/taaze-demo-share/shares`: `{requestId}`. Returns `{success:true,share:{id,createdAt,expiresAt:null,path}}`. The server creates 256 random bits and stores only their SHA256. Same administrator/request ID returns 409, never another link. Client-selected token, expiry or identity fields are rejected.
- `POST /api/taaze-demo-share/shares/:id/revoke`: `{}`. Idempotently records server time and existing admin identity.
- Nonproduction/admin `GET /api/debug/taaze-demo-share`: asset/share counts only.

PostgreSQL stores immutable private assets and share metadata across restarts. There is no in-memory production fallback and no automatic upload/issue task. No decision adoption, progress signal or entity operation issues a link.

## Every resource passes the same gate

The terminal public router at `/AiHankApps/taaze-demo` runs before pageview tracking and static delivery. Only `/AiHankApps/taaze-demo/<capability>/<relative-file>` can return a resource. GET and HEAD require a live capability on every request. Missing/wrong/revoked capabilities, invalid paths, excluded metadata, unknown assets and database failures return plain 404 without a static fallback. New NULL-expiry links stay live until revoked; explicitly finite expiry, if present, is still enforced.

Responses use browser/CDN `no-store`, `no-referrer`, `nosniff` and `noindex,nofollow,noarchive`. CSP limits scripts/styles/assets to their required origins, permits only the OpenStreetMap tile host for external images, confines fetches to the protected namespace and disables forms/embedding. The application writes no capability/request-content logs; deployment infrastructure must preserve that privacy boundary.

## Validation

Synthetic tests cover ZIP attacks, metadata exclusion, original mapping, auth/role/origin boundaries, non-expiring links, duplicate/concurrent issuance, atomic rollback, restart persistence, every resource/HEAD gate and revocation. A fresh browser tests the manager with synthetic inputs and no real session. Separate private QA uses the exact recovered ZIP and real disposable PostgreSQL: all 11 delivered files match the original bytes; 390px and 1280px cover search, details, ISBN/notices, map, non-sending inquiries, display decisions/reset and all-resource revocation. Production CI/deployment and anonymous original-flow evidence are recorded with the release. No real Demo bytes or bearer URL is committed.
