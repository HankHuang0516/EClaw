'use strict';

/**
 * Regression test — stall-escalation severity gate on backend/kanban.js
 * (card_22ab8c3b80ae01b923ce73f7 path #2; sibling of PR #3564 which fixed
 * backend/agent-improvement/heartbeat.js path #1).
 *
 * Two gates pinned here:
 *   A. fireBlockEscalation — P0 cards must NOT be auto-moved to `blocked`.
 *      Auto-blocking a P0 hides the highest-severity item from the active
 *      board; instead we fire a heightened L1 nudge + supervisor notify and
 *      leave status untouched.
 *   B. fireLevelTwoEscalation — P3 + status='backlog' cards must NOT be
 *      auto-upgraded to P2. These are design-first drafts awaiting launch;
 *      a clock-based bump corrupts triage.
 *
 * Pre-existing PRIORITY_UPGRADE P0→P0 no-op stays intact.
 *
 * Mix of source-grep invariants (same style as kanban-stale-dep-gating /
 * kanban-stale-skip-recurring) plus a Function-constructor behavioural
 * smoke that exercises the gate branches end-to-end with a mock pool.
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

describe('fireBlockEscalation — P0 severity gate (no auto-block)', () => {
    const body = extractFunctionBody(
        kanbanSrc,
        'async function fireBlockEscalation(card, recipientIds = null)'
    );

    test('gate triggers on card.priority === \'P0\'', () => {
        expect(body).toMatch(/card\.priority\s*===\s*'P0'/);
    });

    test('P0 branch does NOT issue UPDATE ... status = \'blocked\'', () => {
        // The gate runs BEFORE the legacy UPDATE that flips status to 'blocked'.
        const gateIdx = body.indexOf("card.priority === 'P0'");
        const blockUpdateIdx = body.indexOf("status = 'blocked'");
        expect(gateIdx).toBeGreaterThan(-1);
        expect(blockUpdateIdx).toBeGreaterThan(-1);
        expect(gateIdx).toBeLessThan(blockUpdateIdx);
        // P0 branch returns before reaching the block-update.
        const p0Slice = body.slice(gateIdx, blockUpdateIdx);
        expect(p0Slice).toMatch(/return\s*;/);
    });

    test('P0 branch still records last_stale_nudge_at (so cadence dedupe works)', () => {
        // Without this the heightened nudge would re-fire on every cron tick.
        const gateIdx = body.indexOf("card.priority === 'P0'");
        const returnIdx = body.indexOf('return;', gateIdx);
        const p0Slice = body.slice(gateIdx, returnIdx);
        expect(p0Slice).toMatch(/last_stale_nudge_at\s*=\s*NOW\(\)/);
    });

    test('P0 branch surfaces a \'P0 stalled\' system comment + notify', () => {
        const gateIdx = body.indexOf("card.priority === 'P0'");
        const returnIdx = body.indexOf('return;', gateIdx);
        const p0Slice = body.slice(gateIdx, returnIdx);
        expect(p0Slice).toMatch(/P0 stalled/);
        expect(p0Slice).toMatch(/addSystemComment/);
        expect(p0Slice).toMatch(/notifyEntities/);
    });

    test('non-P0 path preserved: still updates status to \'blocked\'', () => {
        // Defense-in-depth — make sure the refactor didn't accidentally kill
        // the original P1/P2/P3 auto-block behavior.
        expect(body).toMatch(/UPDATE kanban_cards SET status = 'blocked'/);
    });
});

describe('fireLevelTwoEscalation — P3 backlog gate (no auto-bump)', () => {
    const body = extractFunctionBody(
        kanbanSrc,
        'async function fireLevelTwoEscalation(card, recipientIds = null)'
    );

    test('gate triggers on priority === \'P3\' && status === \'backlog\'', () => {
        expect(body).toMatch(
            /card\.priority\s*===\s*'P3'\s*&&\s*card\.status\s*===\s*'backlog'\s*\)\s*return\s+false/
        );
    });

    test('gate runs BEFORE PRIORITY_UPGRADE lookup', () => {
        const gateIdx = body.indexOf("card.priority === 'P3'");
        const upgradeIdx = body.indexOf('PRIORITY_UPGRADE');
        expect(gateIdx).toBeGreaterThan(-1);
        expect(upgradeIdx).toBeGreaterThan(-1);
        expect(gateIdx).toBeLessThan(upgradeIdx);
    });

    test('existing P0→P0 no-op still present (PRIORITY_UPGRADE table unchanged)', () => {
        expect(body).toMatch(/PRIORITY_UPGRADE\s*=\s*\{[^}]*P0:\s*'P0'/);
        expect(body).toMatch(/if \(newPriority === card\.priority\) return false/);
    });
});

describe('fireBlockEscalation + fireLevelTwoEscalation — behavioural smoke', () => {
    // Reconstruct the functions in isolation by capturing their bodies and
    // wiring synthetic pool/addSystemComment/notifyEntities/serverLog stubs.
    const blockSrc = extractFunctionBody(
        kanbanSrc,
        'async function fireBlockEscalation(card, recipientIds = null)'
    );
    const l2Src = extractFunctionBody(
        kanbanSrc,
        'async function fireLevelTwoEscalation(card, recipientIds = null)'
    );

    const makeBlock = (deps) =>
        // eslint-disable-next-line no-new-func
        new Function(
            'pool', 'addSystemComment', 'notifyEntities', 'serverLog', 'buildEscalationRecipients',
            `return async function fireBlockEscalation(card, recipientIds = null) ${blockSrc}`
        )(deps.pool, deps.addSystemComment, deps.notifyEntities, deps.serverLog, deps.buildEscalationRecipients);

    const makeL2 = (deps) =>
        // eslint-disable-next-line no-new-func
        new Function(
            'pool', 'addSystemComment', 'notifyEntities', 'serverLog', 'buildEscalationRecipients', 'require',
            `return async function fireLevelTwoEscalation(card, recipientIds = null) ${l2Src}`
        )(deps.pool, deps.addSystemComment, deps.notifyEntities, deps.serverLog, deps.buildEscalationRecipients,
          () => ({ incrementCounter: () => {} }));

    function makeDeps() {
        const queries = [];
        const comments = [];
        const notifies = [];
        return {
            queries, comments, notifies,
            pool: { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } },
            addSystemComment: async (cardId, deviceId, text) => { comments.push({ cardId, deviceId, text }); },
            notifyEntities: (deviceId, recipients, msg, extra) => { notifies.push({ deviceId, recipients, msg, extra }); },
            serverLog: () => {},
            buildEscalationRecipients: () => [],
        };
    }

    function makeCard(overrides) {
        const thirteenHoursAgo = new Date(Date.now() - 13 * 3600 * 1000).toISOString();
        return {
            id: 'card_test_x',
            device_id: 'dev1',
            title: 'test card',
            priority: 'P2',
            status: 'in_progress',
            status_changed_at: thirteenHoursAgo,
            ...overrides,
        };
    }

    test('P0 in_progress 13h elapsed → no auto-block, heightened L1 fires (recipients notified)', async () => {
        const deps = makeDeps();
        const fn = makeBlock(deps);
        const card = makeCard({ priority: 'P0' });
        await fn(card, [1, 2]);
        // No status='blocked' UPDATE.
        const blockUpdates = deps.queries.filter(q => /status = 'blocked'/.test(q.sql));
        expect(blockUpdates.length).toBe(0);
        // last_stale_nudge_at is recorded (cadence dedupe).
        const nudgeUpdates = deps.queries.filter(q => /last_stale_nudge_at\s*=\s*NOW\(\)/.test(q.sql));
        expect(nudgeUpdates.length).toBe(1);
        // System comment carries the P0-stalled prefix.
        expect(deps.comments.length).toBe(1);
        expect(deps.comments[0].text).toMatch(/P0 stalled/);
        // Supervisor / assignees notified.
        expect(deps.notifies.length).toBe(1);
        expect(deps.notifies[0].recipients).toEqual([1, 2]);
    });

    test('P2 in_progress 13h elapsed → auto-block fires (no regression)', async () => {
        const deps = makeDeps();
        const fn = makeBlock(deps);
        const card = makeCard({ priority: 'P2' });
        await fn(card, [3]);
        const blockUpdates = deps.queries.filter(q => /status = 'blocked'/.test(q.sql));
        expect(blockUpdates.length).toBe(1);
        expect(deps.comments[0].text).toMatch(/自動封鎖/);
    });

    test('P1 in_progress 13h elapsed → auto-block fires (no regression)', async () => {
        const deps = makeDeps();
        const fn = makeBlock(deps);
        const card = makeCard({ priority: 'P1' });
        await fn(card, [4]);
        const blockUpdates = deps.queries.filter(q => /status = 'blocked'/.test(q.sql));
        expect(blockUpdates.length).toBe(1);
    });

    test('P3 backlog 7h elapsed → fireLevelTwoEscalation returns false (no priority change)', async () => {
        const deps = makeDeps();
        const fn = makeL2(deps);
        const sevenHoursAgo = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
        const card = makeCard({
            priority: 'P3',
            status: 'backlog',
            status_changed_at: sevenHoursAgo,
        });
        const fired = await fn(card, [5]);
        expect(fired).toBe(false);
        // No UPDATE on kanban_cards.
        expect(deps.queries.length).toBe(0);
        // No system comment, no notify.
        expect(deps.comments.length).toBe(0);
        expect(deps.notifies.length).toBe(0);
    });

    test('P3 in_progress 7h elapsed → P3→P2 upgrade still fires (gate is backlog-only)', async () => {
        const deps = makeDeps();
        const fn = makeL2(deps);
        const sevenHoursAgo = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
        const card = makeCard({
            priority: 'P3',
            status: 'in_progress',
            status_changed_at: sevenHoursAgo,
        });
        const fired = await fn(card, [6]);
        expect(fired).toBe(true);
        const upgradeUpdates = deps.queries.filter(q => /SET priority =/.test(q.sql));
        expect(upgradeUpdates.length).toBe(1);
        expect(upgradeUpdates[0].params[0]).toBe('P2');
    });

    test('P2 in_progress 7h elapsed → P2→P1 upgrade still fires (no regression)', async () => {
        const deps = makeDeps();
        const fn = makeL2(deps);
        const sevenHoursAgo = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
        const card = makeCard({
            priority: 'P2',
            status: 'in_progress',
            status_changed_at: sevenHoursAgo,
        });
        const fired = await fn(card, [7]);
        expect(fired).toBe(true);
        const upgradeUpdates = deps.queries.filter(q => /SET priority =/.test(q.sql));
        expect(upgradeUpdates[0].params[0]).toBe('P1');
    });

    test('P0 at L2 → still no-op (existing PRIORITY_UPGRADE P0→P0 preserved)', async () => {
        const deps = makeDeps();
        const fn = makeL2(deps);
        const sevenHoursAgo = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
        const card = makeCard({
            priority: 'P0',
            status: 'in_progress',
            status_changed_at: sevenHoursAgo,
        });
        const fired = await fn(card, [8]);
        expect(fired).toBe(false);
        // No UPDATE on kanban_cards.
        const upgradeUpdates = deps.queries.filter(q => /SET priority =/.test(q.sql));
        expect(upgradeUpdates.length).toBe(0);
    });
});
