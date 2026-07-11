/**
 * Regression: the "returned 0 bound entities" entity_poll warn must be
 * throttled per device. Unbound devices poll every few seconds; before the
 * throttle this single warn was ~89% of the warn channel volume (observed
 * 2026-07-12 audit: 89/100 warn entries), drowning real warnings at the
 * query limit.
 */

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');

describe('entity_poll zero-bound warn throttle', () => {
    test('throttle map + interval constant exist', () => {
        expect(src).toMatch(/ZERO_ENTITY_POLL_WARN_INTERVAL_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/);
        expect(src).toMatch(/zeroEntityPollWarnAt\s*=\s*new Map\(\)/);
    });

    test('the zero-bound warn is gated by the throttle', () => {
        // The serverLog('warn', 'entity_poll', `... 0 bound entities ...`)
        // call must sit inside the throttle window check.
        const warnIdx = src.indexOf('returned 0 bound entities (device exists');
        expect(warnIdx).toBeGreaterThan(-1);
        const windowBefore = src.slice(Math.max(0, warnIdx - 600), warnIdx);
        expect(windowBefore).toContain('zeroEntityPollWarnAt.get(');
        expect(windowBefore).toContain('ZERO_ENTITY_POLL_WARN_INTERVAL_MS');
        expect(windowBefore).toContain('zeroEntityPollWarnAt.set(');
    });
});
