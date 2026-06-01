'use strict';

// Use jest mock for the heavy DB-touching modules so we can require index.js
jest.mock('pg');
jest.mock('node-cron', () => ({ schedule: () => ({ stop: jest.fn() }) }));

const { _getSilentTransformSuppressionReason: getReason } = require('../../index');

describe('getSilentTransformSuppressionReason', () => {
    test('bare [SILENT] → silent_token', () => {
        expect(getReason('[SILENT]')).toBe('silent_token');
        expect(getReason('  [SILENT]  ')).toBe('silent_token');
        expect(getReason('[silent]')).toBe('silent_token');
    });

    test('@-mention prefix + [SILENT] → silent_token (bug 2026-06-01)', () => {
        // The visible-mention-prefix rule requires bot replies to start with
        // @#N for routing visibility. That used to push [SILENT] off the
        // start of the string and bypass the filter, causing a no-op echo
        // loop with #6. Stripping leading @-mentions fixes this.
        expect(getReason('@#6 [SILENT]')).toBe('silent_token');
        expect(getReason('@yrt82n [SILENT]')).toBe('silent_token');
        expect(getReason('@all [SILENT]')).toBe('silent_token');
        expect(getReason('@#1 @#6 [SILENT]')).toBe('silent_token');
    });

    test('@-mention prefix + [SILENT] + low-signal trailer → silent_noise', () => {
        // After mention strip, "[SILENT] ..." matches the noise branch when
        // the rest is low-signal (short, ack-like, sign-off FWD echo).
        expect(getReason('@#6 [SILENT] received')).toBe('silent_noise');
        expect(getReason('@#6 [SILENT] ok')).toBe('silent_noise');
        expect(getReason('@#6 [SILENT] #6 sign-off FWD echo'))
            .toBe('silent_noise');
    });

    test('text with [SILENT] mid-content → null (not suppressed)', () => {
        expect(getReason('Hello [SILENT] world')).toBeNull();
        expect(getReason('done [SILENT]')).toBeNull();
    });

    test('substantive messages → null (not suppressed)', () => {
        expect(getReason('@#6 spec amendments committed + PR opened — PR #3083'))
            .toBeNull();
        expect(getReason('Real reply content here')).toBeNull();
    });

    test('falsy / non-string → null', () => {
        expect(getReason(null)).toBeNull();
        expect(getReason(undefined)).toBeNull();
        expect(getReason('')).toBeNull();
        expect(getReason('   ')).toBeNull();
        expect(getReason(42)).toBeNull();
    });
});
