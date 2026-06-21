'use strict';

/**
 * Safe row.updated_at → ISO-8601 string conversion.
 *
 * Background (2026-06-16 incident chain):
 * - PR #3422 introduced `new Date(row.updated_at).toISOString()` in the vault
 *   GET handler. When `row.updated_at` was an unexpected shape (pg-driver
 *   returned a string, null, or already-Date in a malformed state), the
 *   construction produced an Invalid Date and `.toISOString()` threw
 *   `RangeError: Invalid time value` (incident ~12:36 TW, hotfix PR #3424).
 * - PR #3427 copy-pasted the same unguarded pattern into the POST handler's
 *   strict-mode no-etag guard at index.js:21075. At 14:15:45Z prod hit the
 *   path, RangeError bubbled to the existing unhandledRejection handler
 *   which called process.exit(1) → restart loop until hotfix PR #3432.
 *
 * Permanent fix (this module, 06-16 RCA PR):
 * - Single defensive helper used at every call site.
 * - CI grep ban in `.github/workflows/backend-ci.yml` forbids
 *   `new Date(...updated_at...).toISOString()` outside this file so the
 *   pattern can't be reintroduced.
 *
 * Returns the ISO-8601 string for `row.updated_at`, or `null` when the row
 * is missing, the field is missing/null/undefined, or the value cannot be
 * coerced to a valid Date. Never throws.
 */
function safeUpdatedAtToISO(row) {
    if (!row || row.updated_at === null || row.updated_at === undefined) return null;
    try {
        let v = row.updated_at;
        // device_vars.updated_at is BIGINT epoch-millis, and node-postgres
        // returns BIGINT (int8) as a STRING. `new Date("1782084491324")` is an
        // Invalid Date — JS treats only a *number* as epoch-millis, not an
        // all-digit string. Coerce an all-digit string to Number so it parses
        // as epoch-millis. Without this, GET /api/device-vars returned
        // updatedAt:null for EVERY row, so clients could never echo the
        // optimistic-lock token and every non-empty-row vault POST tripped the
        // "[Vars] POST without expectedUpdatedAt" warn (card_38b6f514); the 409
        // stale-write check (index.js) was dead for the same reason. ISO /
        // Date-string values (other tables' TIMESTAMPTZ) contain non-digits, so
        // they skip coercion and parse exactly as before.
        if (typeof v === 'string' && /^\d+$/.test(v)) v = Number(v);
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return null;
        return d.toISOString();
    } catch (_) {
        return null;
    }
}

module.exports = { safeUpdatedAtToISO };
