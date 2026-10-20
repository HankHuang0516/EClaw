# Fraud App private problem feedback v1

This is a dedicated ordinary-app feedback contract, not a deployment receipt. Confirm the PR, migration and production verification receipts before enabling a native build. Build20 remains frozen and local-only.

## Exact routes

- POST https://eclawbot.com/api/fraud-app-feedback
- GET https://eclawbot.com/api/admin/fraud-app-feedback?limit=25
- GET https://eclawbot.com/api/admin/fraud-app-feedback/{uuid}

The POST is the same audience model as the existing portfolio ordinary beta-feedback intake: a user deliberately submits a limited report without a personal login, account registration, embedded key, device credential or admin token. This does not authorize any public read. The fixed route is for this app only; arbitrary app/table identifiers are not accepted.

Admin reads retain the existing authModule.authMiddleware and DB-backed authModule.adminMiddleware/user_accounts.is_admin unchanged. They are not native-app requirements. No new account, group, credential or global permission is introduced. No login, refresh or logout flow is added to the game.

## Request

JSON only, exactly six fields: schemaVersion=1, id=UUIDv4, category, description, version, screen.

Categories: operation, rules, dialogue, art, balance, other.

Description is nonblank, at most 2000 Unicode code points and 8000 UTF-8 bytes. Version and screen are nonblank strings of at most 128 code points/512 UTF-8 bytes each, with no control characters. Version is the actual native version/build, not a forced web v-prefix. Screen is a stable screen identifier, not a captured scene/snapshot. Invalid Unicode and extra fields are rejected. The raw JSON body limit is 12288 bytes. Content is never silently truncated.

Do not send delivery=local-only, deviceId, deviceSecret, snapshots, logs, device state, save data, hidden narrative, personal identifiers or credentials. No generic feedback capture, GitHub issue, third-party forwarding or body logging occurs. Only the six deliberate fields, an idempotency hash and a server timestamp are persisted.

Native clients send HTTPS application/json with no account/key header and normally no Origin. Browser writes accept only the two existing production eclawbot origins. Intake is limited to eight requests per ten minutes per IP, with Retry-After on 429. The address is used only by the existing in-memory limiter, not added to the feedback table.

## Receipt and retry

First confirmed insert is HTTP 201. Identical UUID/content retry is HTTP 200 with the same createdAt and duplicate=true. JSON keys may be reordered without changing content. Exact submitted UUID spelling is echoed back. Different content with the same UUID is HTTP 409 and does not overwrite the prior report.

Success has exactly success=true, saved=true, id, createdAt (ISO timestamp), duplicate (boolean). Never delete or mark a local draft sent until all receipt fields validate and id equals the submitted id. SQL acknowledgement loss is HTTP 503 saved=false; retry the same id/content rather than creating another report. Changed content uses a fresh UUID.

Invalid input is 400; untrusted browser Origin is 403; rate limit is 429; unavailable/unconfirmed storage is 503. Every failure keeps the draft unsent. Admin authentication failures follow the unchanged existing 401/403 behavior. Public GET is not supported. All responses are no-store; admin reads vary on existing Cookie/Authorization.

## Persistence and review

An existing backend operator runs scripts/migrate-fraud-app-feedback.js with the existing service DATABASE_URL after normal PR/CI/review/deployment approval. The script creates only fraud_app_feedback_reports and its date index transactionally. No startup/core persistence, existing table or existing report is changed. Neither the native app nor HTTP handlers execute DDL. Missing schema remains 503, not an empty success.

The old local fraud-demo-feedback.js is not the native implementation and must not be remounted. The generic /api/feedback is not an alias: it captures logs/device state and can create GitHub issues. Existing beta feedback remains unchanged; ratings/continuation are not invented to adapt a problem report.

The existing registered admin-auth Jest suite includes synthetic PostgreSQL-emulation tests for write/admin readback, repeat/conflict, retained data across fresh server/pool, SQL acknowledgement loss, DB failure, schema absence, malformed/extra/Unicode/byte-limit input, rate limits and private read denial. These are not production persistence or real-user/browser verification receipts.

Native integration belongs to a subsequent build: add HTTPS transport/Android INTERNET only through its own approved release flow, keep offline play unchanged, and retain drafts on cancellation, timeout, wrong/invalid receipt or process restart. No forced game login is introduced. This backend change adds no launcher/app-icon asset; native icon/release gates remain with the app owner.

## Test adapter qualification

The installed pg-mem adapter returns an existing row for ON CONFLICT DO NOTHING RETURNING, unlike real PostgreSQL. Sequential unit fixtures normalize only that adapter result; no API expectation is relaxed. Its skipped-AST warning on repeated CREATE IF NOT EXISTS is disabled only in the test database. A separate real PostgreSQL temporary-table transaction verified first/duplicate/conflict return counts and repeated creation, then rolled back and confirmed the temporary relation disappeared. This does not replace production HTTP/admin or concurrency verification.
