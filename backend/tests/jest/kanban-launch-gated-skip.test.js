'use strict';

/**
 * Regression test — stale-escalation must skip launch_gated backlog cards.
 *
 * Background: Mac_F 2026-05-19 locked the kanban semantic split as
 *   backlog = drafted, awaiting future launch / verification gate
 *   blocked = near-term execution stuck on external dependency
 * The pre-existing checkStaleCards() query treated backlog identically
 * to todo / in_progress / review, so launch-gated backlog cards fired
 * L1 nudges every 3h and would auto-escalate to L2 / L3 (→ blocked),
 * polluting the blocked queue and contradicting Mac_F's lock.
 *
 * Fix: per-card launch_gated flag (settable only on backlog cards via
 * PUT /card/:id/gate). The stale-scan SELECT excludes gated rows, the
 * /move handler auto-clears the flag when status leaves backlog, and
 * serializeCard surfaces launchGated to clients.
 */

const fs = require('fs');
const path = require('path');

const kanbanSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kanban.js'),
    'utf8'
);

function extractFunctionBody(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) throw new Error(`function not found: ${signature}`);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return src.slice(open, i + 1);
        }
    }
    throw new Error(`unterminated function: ${signature}`);
}

describe('checkStaleCards — launch_gated skip filter', () => {
    const body = extractFunctionBody(kanbanSrc, 'async function checkStaleCards()');

    test('SELECT excludes launch_gated cards', () => {
        expect(body).toMatch(
            /launch_gated\s*=\s*FALSE\s+OR\s+launch_gated\s+IS\s+NULL/i
        );
    });

    test('recurring-schedule skip is still present (no regression vs prior fix)', () => {
        expect(body).toMatch(
            /schedule_enabled\s*=\s*false\s+OR\s+schedule_type\s*!=\s*'recurring'\s+OR\s+schedule_enabled\s+IS\s+NULL/
        );
    });
});

describe('serializeCard — launchGated surface', () => {
    test('returns launchGated boolean', () => {
        expect(kanbanSrc).toMatch(/launchGated:\s*!!row\.launch_gated/);
    });
});

describe('POST /card/:id/move — auto-clear launch_gated', () => {
    test('UPDATE clears launch_gated when newStatus is not backlog', () => {
        // CASE expression: keep flag only when staying in backlog,
        // force FALSE for every other transition.
        expect(kanbanSrc).toMatch(
            /launch_gated\s*=\s*CASE\s+WHEN\s+\$1\s*=\s*'backlog'\s+THEN\s+launch_gated\s+ELSE\s+FALSE\s+END/
        );
    });
});

describe('PUT /card/:id/gate — backlog-only enforcement', () => {
    test('endpoint is registered', () => {
        expect(kanbanSrc).toMatch(/router\.put\(['"]\/card\/:id\/gate['"]/);
    });

    test('rejects enable on non-backlog status with GATE_NOT_BACKLOG', () => {
        expect(kanbanSrc).toMatch(/GATE_NOT_BACKLOG/);
        expect(kanbanSrc).toMatch(/launch_gated can only be enabled on backlog cards/);
    });

    test('requires enabled boolean in body', () => {
        expect(kanbanSrc).toMatch(/typeof enabled !== ['"]boolean['"]/);
    });
});
