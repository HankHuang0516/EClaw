'use strict';

/**
 * Owner-reported zombie nudge (card_3e95f4c1): the stale-card watcher kept actively
 * re-nudging cards parked in `backlog` — a parked #6 recurring-driver card and a
 * parked daily-E2E card each re-nudged "please continue" every ~17 minutes for 7+
 * hours, spamming the channel. `backlog` means "intentionally parked / not now", so
 * a backlog card must NOT be flood-nudged. This is the same class of zombie nudge
 * that PR #3781 fixed for archived/done parents — here extended to `backlog`.
 *
 * Root cause: checkStaleCards' candidate SELECT scoped to
 *   status IN ('backlog', 'todo', 'in_progress', 'review')
 * so any backlog card past stale_threshold_ms became a stale candidate and (if a
 * device opted backlog into kanban_nudge_statuses) flowed straight into the L1/L2/L3
 * nudge ladder. Fix: drop 'backlog' from the candidate SELECT — the single chokepoint
 * every stale candidate flows through. Only actively-worked statuses
 * (todo / in_progress / review) are eligible; done + archived stay excluded.
 *
 * This test reconstructs the candidate-selection semantics from the REAL SQL literal
 * in kanban.js (parsing the `status IN (...)` list the DB actually filters on) and
 * asserts the behaviour:
 *   (a) a backlog card past the stale threshold  ⇒ NOT a candidate (no nudge)
 *   (b) an in_progress card past the threshold   ⇒ still a candidate (nudge fires)
 *
 * Fail-on-old proof: on pre-fix origin/main the IN-list contains 'backlog', so the
 * backlog card IS selected → case (a) FAILS. After the fix it is dropped → PASS.
 * Case (b) passes on both (unchanged), guarding against an over-broad regression.
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

// Parse the `status IN ('a', 'b', ...)` whitelist out of a function body and return
// a predicate modelling "would the candidate SELECT accept this status?". This reads
// the REAL SQL the watcher runs, so the predicate's behaviour tracks production.
function statusCandidatePredicate(body) {
    const m = body.match(/status IN \(([^)]*)\)/);
    if (!m) throw new Error('status IN (...) clause not found');
    const statuses = m[1]
        .split(',')
        .map(s => s.trim().replace(/^'/, '').replace(/'$/, ''))
        .filter(Boolean);
    return (status) => statuses.includes(status);
}

describe('checkStaleCards — parked backlog cards are not stale-nudge candidates', () => {
    const body = extractFunctionBody(kanbanSrc, 'async function checkStaleCards()');
    const isStaleCandidate = statusCandidatePredicate(body);

    // (a) parked backlog card past threshold → NO nudge (FAILS on pre-fix code).
    test('a backlog card past the stale threshold is NOT a nudge candidate', () => {
        expect(isStaleCandidate('backlog')).toBe(false);
    });

    // (b) actively-worked card past threshold → still nudged (unchanged).
    test('an in_progress card past the stale threshold is still a nudge candidate', () => {
        expect(isStaleCandidate('in_progress')).toBe(true);
    });

    test('todo and review remain nudge candidates (active work)', () => {
        expect(isStaleCandidate('todo')).toBe(true);
        expect(isStaleCandidate('review')).toBe(true);
    });

    test('done and blocked are not nudge candidates (already excluded)', () => {
        expect(isStaleCandidate('done')).toBe(false);
        expect(isStaleCandidate('blocked')).toBe(false);
    });

    test('candidate SELECT also keeps the archived = false guard (done/archived stay out)', () => {
        expect(body).toMatch(/archived\s*=\s*false/);
    });

    test('source no longer lists backlog in the candidate SELECT', () => {
        expect(body).not.toMatch(/status IN \([^)]*'backlog'[^)]*\)/);
    });
});
