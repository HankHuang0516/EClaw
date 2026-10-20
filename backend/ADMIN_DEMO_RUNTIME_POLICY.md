# Existing-admin private runtime delivery

This feature is independent of the portfolio catalog/report collector. It does not add public portfolio cards, registered introductions, app-store availability or report data. Those integrations retain their existing freshness and publication gates.

## Access boundary

- Reserve /AiHankApps/admin-demos/ before anonymous pageview tracking and public static serving. Uninitialized handlers fail closed; no request falls back to a public file.
- Use the existing authModule.authMiddleware and authModule.adminMiddleware unchanged. The audience is the existing authenticated user_accounts.is_admin group, not ADMIN_DEVICE_IDS. No account, role, membership, credential or global security setting is changed.
- Require the existing persistenceReady state. Every metadata, HTML, module, CSS, image, audio, HEAD, Range and ZIP request passes the same authentication and database admin check.
- Responses are private/no-store, same-origin resources with restricted CSP. Runtime imports are relative; reviewed inline script bodies receive CSP hashes. There is no HTTP publication or upload endpoint.
- The current root push service worker does not cache fetch responses. The private prefix is handled before the public pageview tracker, so verification does not create public traffic events.

## Private persistence and operator import

The EClaw repository is public. Never commit runtime content, complete plans, art, audio, release payloads, manifests containing private material, raw QA, credentials or local source paths. A directory named private inside a public Git repository is not confidential.

An existing Railway operator imports a private JSON envelope on stdin into the existing DATABASE_URL database. The script never prints or exports credentials. It creates only dedicated aihank_admin_demo_releases and aihank_admin_demo_assets tables, inside the import transaction. Startup persistence, existing tables and global auth are not modified. Immutable releases are content-addressed, append-only and idempotent. A failed import rolls back; no current release is partially replaced.

Run the deployed backend/scripts/import-admin-demo-runtime.js through the existing approved operational channel. Do not create credentials, services, groups or alternate publishers. If that channel is unavailable, report the exact import gap; do not place the payload in Git or use a public object URL.

Envelope schemaVersion is 1. archive has canonical base64 data, byte length and SHA-256. assets contains path/data/bytes/sha256 records; entries contains title/path records referring to included HTML. Paths, file types, UTF-8, binary signatures, per-file limits and total size are checked. No filesystem extraction occurs on the server. The operator must build assets and the archive from the same independently reviewed immutable ZIP; checksum binding does not itself perform semantic ZIP extraction. The importer verifies all stored bytes before committing.

## Verification

Use isolated synthetic fixtures in the existing admin-auth Jest suite. Cover anonymous 401, non-admin 403, each runtime type and ZIP, private cache headers, HEAD/Range, unknown/traversal paths, not-ready/storage failure, no public fallthrough, payload validation, rollback and idempotency.

After approved PR/CI/deployment, verify the real protected URLs anonymously and with an already available authorized admin browser session. Do not collect tokens/passwords or create an account for QA. If no such session exists, report the positive-verification gap. Capture runtime response hashes through normal authorized resource/download access without exporting credentials. Real operator import receipts are not a substitute for the browser access check.

This delivery is a correctly labeled plan and first-day demonstration, not a complete commercial game or native app release. No installer, launcher or app-icon asset is added by the generic read-only service; existing icon and native-release requirements remain unchanged.
