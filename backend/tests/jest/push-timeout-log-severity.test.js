'use strict';

// card_52ee8e0c — recurring ErrLog "[Push] ⏳ ... push gateway timeout" and
// "[Push] ✗ Failed to push ... (push_timeout)" cards (×N in backlog + ~8 prior
// status-only closes).
//
// Root cause: a push_timeout is EXPECTED operation, not a failure — after the
// 15s push window the bot may still reply async via /api/transform. The code
// logged it at console.warn, but the prod-log monitor buckets ALL stderr
// (console.warn AND console.error) as ERROR, so a benign async timeout paged as
// an ERROR follow-up card every 6h. Fix: log push_timeout at info (console.log,
// stdout); keep real failures at warn and hard connection errors at error.
//
// The "which bot went silent" signal is preserved independently via
// entity.pushStatus + the entity-status no_reply axis counter, so dropping the
// stderr line loses no observability.

const fs = require('fs');
const path = require('path');

const indexSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');

describe('push_timeout logs at info, real failures stay warn/error (card_52ee8e0c)', () => {
    test('pushToBot timeout (isAbort) branch uses console.log, NOT console.warn', () => {
        // The abort branch line must be console.log now.
        expect(indexSrc).toMatch(
            /if \(isAbort\) \{\s*\n\s*console\.log\(`\[Push\] ⏳ Device \$\{deviceId\} Entity \$\{entity\.entityId\}: push gateway timeout \(no 15s ack\)/
        );
        // And must NOT have reverted to console.warn for that exact line.
        expect(indexSrc).not.toMatch(
            /console\.warn\(`\[Push\] ⏳ Device \$\{deviceId\} Entity \$\{entity\.entityId\}: push gateway timeout/
        );
    });

    test('webhook caller gates push_timeout → console.log + serverLog(info)', () => {
        expect(indexSrc).toMatch(
            /\} else if \(pushResult\.reason === 'push_timeout'\) \{[\s\S]{0,400}?console\.log\(`\[Push\] ⏳ Device \$\{deviceId\} Entity \$\{eId\}: push timeout/
        );
        expect(indexSrc).toMatch(
            /serverLog\('info', 'client_push', `Entity \$\{eId\} push timeout \(async-uncertain\)`/
        );
    });

    test('channel caller gates push_timeout → console.log + serverLog(info)', () => {
        expect(indexSrc).toMatch(
            /serverLog\('info', 'client_push', `Entity \$\{eId\} channel push timeout \(async-uncertain\)`/
        );
    });

    test('real (non-timeout) push failures still log at warn', () => {
        // The else branches that fire for non-push_timeout reasons must remain warn.
        expect(indexSrc).toMatch(/console\.warn\(`\[Push\] ✗ Failed to push to Device \$\{deviceId\} Entity \$\{eId\}: \$\{pushResult\.reason\}`/);
        expect(indexSrc).toMatch(/console\.warn\(`\[Push\] ✗ Channel push failed for Device \$\{deviceId\} Entity \$\{eId\}: \$\{pushResult\.reason\}`/);
    });

    test('hard connection errors (non-abort) still log at console.error + serverLog(error)', () => {
        // The isAbort=false branch must keep error-level severity for real failures.
        expect(indexSrc).toMatch(/console\.error\(`\[Push\] ✗ Device \$\{deviceId\} Entity \$\{entity\.entityId\}: Push error:`/);
        expect(indexSrc).toMatch(/serverLog\('error', 'push_error', `Entity \$\{entity\.entityId\} push exception/);
    });
});
