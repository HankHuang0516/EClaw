/**
 * safeUpdatedAtToISO unit tests
 *
 * Locks down the permanent fix for the 2026-06-16 RangeError "Invalid time value"
 * incident class. PRs #3422→#3424 (GET handler hotfix), PR #3427→#3432 (POST
 * handler hotfix). See backend/safe-date.js for full RCA.
 *
 * The helper MUST:
 * - return null for any missing/null/undefined/malformed input (never throw)
 * - return an ISO-8601 string for any valid Date-coercible input
 *
 * If this file regresses, the gating CI grep ban (.github/workflows/backend-ci.yml
 * "Ban unguarded new Date..." step) becomes the next line of defense.
 */

const { safeUpdatedAtToISO } = require('../../safe-date');

describe('safeUpdatedAtToISO', () => {
    describe('returns null for missing/null/undefined input', () => {
        test('null row', () => {
            expect(safeUpdatedAtToISO(null)).toBeNull();
        });

        test('undefined row', () => {
            expect(safeUpdatedAtToISO(undefined)).toBeNull();
        });

        test('empty object (no updated_at)', () => {
            expect(safeUpdatedAtToISO({})).toBeNull();
        });

        test('updated_at: null', () => {
            expect(safeUpdatedAtToISO({ updated_at: null })).toBeNull();
        });

        test('updated_at: undefined (explicit)', () => {
            expect(safeUpdatedAtToISO({ updated_at: undefined })).toBeNull();
        });
    });

    describe('returns null for malformed values (never throws)', () => {
        test('updated_at: arbitrary non-date string', () => {
            expect(safeUpdatedAtToISO({ updated_at: 'invalid' })).toBeNull();
        });

        test('updated_at: new Date("invalid") (already-Invalid Date)', () => {
            expect(safeUpdatedAtToISO({ updated_at: new Date('invalid') })).toBeNull();
        });

        test('updated_at: new Date(NaN)', () => {
            expect(safeUpdatedAtToISO({ updated_at: new Date(NaN) })).toBeNull();
        });

        test('updated_at: "banana"', () => {
            expect(safeUpdatedAtToISO({ updated_at: 'banana' })).toBeNull();
        });

        test('updated_at: empty string', () => {
            expect(safeUpdatedAtToISO({ updated_at: '' })).toBeNull();
        });

        test('updated_at: object that throws when coerced (Symbol)', () => {
            // Date(Symbol) throws TypeError; helper must catch and return null.
            expect(safeUpdatedAtToISO({ updated_at: Symbol('x') })).toBeNull();
        });
    });

    describe('returns ISO string for valid inputs', () => {
        test('updated_at: valid Date object', () => {
            const d = new Date('2026-06-16T14:00:00Z');
            expect(safeUpdatedAtToISO({ updated_at: d })).toBe('2026-06-16T14:00:00.000Z');
        });

        test('updated_at: epoch ms (number)', () => {
            // 1750000000000 → 2025-06-15T16:53:20.000Z (sanity-check is a valid ISO)
            const out = safeUpdatedAtToISO({ updated_at: 1750000000000 });
            expect(out).toBe(new Date(1750000000000).toISOString());
            expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        });

        test('updated_at: ISO-8601 string', () => {
            expect(safeUpdatedAtToISO({ updated_at: '2026-06-16T14:00:00Z' }))
                .toBe('2026-06-16T14:00:00.000Z');
        });

        test('updated_at: ISO-8601 string with timezone offset', () => {
            // 2026-06-16T22:00:00+08:00 == 2026-06-16T14:00:00Z
            expect(safeUpdatedAtToISO({ updated_at: '2026-06-16T22:00:00+08:00' }))
                .toBe('2026-06-16T14:00:00.000Z');
        });
    });

    describe('BIGINT epoch-millis returned as a STRING (card_38b6f514)', () => {
        // device_vars.updated_at is BIGINT epoch-millis; node-postgres returns
        // BIGINT (int8) as a STRING (no int8 type-parser is configured). Before
        // the coercion fix, new Date("1750000000000") was an Invalid Date so the
        // helper returned null — which made GET /api/device-vars emit
        // updatedAt:null for every row, so clients could never echo the
        // optimistic-lock token and every non-empty-row vault POST tripped the
        // "[Vars] POST without expectedUpdatedAt" warn. The 409 stale-write
        // check was dead for the same reason.

        test('all-digit string (pg int8 shape) parses as epoch-millis, NOT null', () => {
            const out = safeUpdatedAtToISO({ updated_at: '1750000000000' });
            expect(out).toBe(new Date(1750000000000).toISOString());
            expect(out).not.toBeNull();
        });

        test('string and number forms produce the same ISO', () => {
            const ms = 1782084491324;
            expect(safeUpdatedAtToISO({ updated_at: String(ms) }))
                .toBe(safeUpdatedAtToISO({ updated_at: ms }));
        });

        test('non-digit (ISO) strings still parse and are NOT coerced to a number', () => {
            // Guard the coercion is digit-only: ISO strings must keep working.
            expect(safeUpdatedAtToISO({ updated_at: '2026-06-16T14:00:00Z' }))
                .toBe('2026-06-16T14:00:00.000Z');
        });
    });

    describe('incident-class regression coverage', () => {
        // These mirror the actual shapes the pg driver was returning when the
        // 06-16 incidents fired. If any of these throw, the server is back in
        // restart-loop territory.

        test('does NOT throw on pg-driver Invalid Date (06-16 ~12:36 TW symptom)', () => {
            const malformedRow = { updated_at: new Date('not-a-date') };
            expect(() => safeUpdatedAtToISO(malformedRow)).not.toThrow();
            expect(safeUpdatedAtToISO(malformedRow)).toBeNull();
        });

        test('does NOT throw on missing row (06-16 14:15Z symptom — POST etag check)', () => {
            // The crash happened on the strict-mode no-etag guard when the row
            // existed but updated_at was unexpectedly shaped. Confirm the
            // "no row at all" boundary also doesn't throw.
            expect(() => safeUpdatedAtToISO(undefined)).not.toThrow();
            expect(() => safeUpdatedAtToISO(null)).not.toThrow();
        });
    });
});
