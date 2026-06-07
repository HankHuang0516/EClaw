/**
 * Phase 1 #3b — auto-fire preflight on kanban move→in_progress.
 * Card: card_6dcaa492b063d0d79041158b
 *
 * The hook in backend/kanban.js POST /card/:id/move is an inline async IIFE
 * inside a closure that captures pool + addSystemComment. We can't unit-test
 * the IIFE in isolation without spinning up the whole router. Instead this
 * file tests the composition we wired in — the SAME sequence of calls the
 * hook makes — against a mocked pool + addSystemComment shim, exercising:
 *   1. classifyPainTags fires on the card text
 *   2. SELECT against agent_improvement_episodes uses pain_tags ?| $2::text[]
 *   3. selectSimilarEpisodes ranks down to top-5
 *   4. composePreflightComment receives the right shape
 *   5. addSystemComment is called with the composed text
 *   6. Trigger fires ONLY on oldStatus !== 'in_progress' && newStatus === 'in_progress'
 *   7. Composer/SELECT throw does NOT propagate (failure-isolated)
 *
 * This is the exact same algorithm the kanban.js IIFE uses, copy-faithful;
 * the test guards regression on the algorithm even if someone refactors the
 * IIFE later.
 */
'use strict';

const ai = require('../../agent-improvement');

/**
 * Reproduces the OODA-R hook body verbatim — the inline IIFE in kanban.js.
 * Kept in sync with that body manually; if the IIFE changes, this changes.
 * Returns the promise of the side-effect so tests can await completion.
 */
async function runPreflightHook({ pool, addSystemComment, card, deviceId, cardId, oldStatus, newStatus }) {
    if (oldStatus === 'in_progress' || newStatus !== 'in_progress') return { fired: false };
    try {
        const taxonomy = ai.classifyPainTags(
            `${card.title || ''}\n\n${card.description || ''}`,
            undefined,
        );
        const r = await pool.query(
            `SELECT ... FROM agent_improvement_episodes WHERE device_id = $1 AND pain_tags ?| $2::text[] ORDER BY occurred_at DESC LIMIT 100`,
            [deviceId, taxonomy],
        );
        const similar = ai.selectSimilarEpisodes(taxonomy, r.rows, 5);
        const text = ai.composePreflightComment({
            cardTitle: card.title || '',
            cardDescription: card.description || '',
            similarEpisodes: similar,
        });
        await addSystemComment(cardId, deviceId, text);
        return { fired: true, taxonomy, similarCount: similar.length, text };
    } catch (e) {
        return { fired: true, error: e.message };
    }
}

function makePool(rows = []) {
    return {
        query: jest.fn(async () => ({ rows })),
    };
}

describe('OODA-R preflight auto-fire hook (Phase 1 #3b)', () => {
    test('fires on todo→in_progress', async () => {
        const pool = makePool([]);
        const addSystemComment = jest.fn(async () => {});
        const result = await runPreflightHook({
            pool, addSystemComment,
            card: { title: '帳號莫名要重新登入', description: '修 session refresh' },
            deviceId: 'dev1', cardId: 'card_test',
            oldStatus: 'todo', newStatus: 'in_progress',
        });
        expect(result.fired).toBe(true);
        expect(result.taxonomy).toContain('auth_session');
        expect(addSystemComment).toHaveBeenCalledTimes(1);
        const [cid, did, text] = addSystemComment.mock.calls[0];
        expect(cid).toBe('card_test');
        expect(did).toBe('dev1');
        expect(text).toMatch(/本任務如何避免過往同類錯誤/);
        expect(text).toMatch(/Required checklist/);
    });

    test('fires on backlog→in_progress', async () => {
        const pool = makePool([]);
        const addSystemComment = jest.fn(async () => {});
        const result = await runPreflightHook({
            pool, addSystemComment,
            card: { title: 'x', description: '' },
            deviceId: 'd', cardId: 'c',
            oldStatus: 'backlog', newStatus: 'in_progress',
        });
        expect(result.fired).toBe(true);
        expect(addSystemComment).toHaveBeenCalled();
    });

    test('does NOT fire on in_progress→in_progress (no-op self-loop already rejected upstream, double-safety here)', async () => {
        const pool = makePool([]);
        const addSystemComment = jest.fn(async () => {});
        const result = await runPreflightHook({
            pool, addSystemComment,
            card: { title: 'x' },
            deviceId: 'd', cardId: 'c',
            oldStatus: 'in_progress', newStatus: 'in_progress',
        });
        expect(result.fired).toBe(false);
        expect(addSystemComment).not.toHaveBeenCalled();
    });

    test('does NOT fire on in_progress→review', async () => {
        const pool = makePool([]);
        const addSystemComment = jest.fn(async () => {});
        const result = await runPreflightHook({
            pool, addSystemComment,
            card: { title: 'x' },
            deviceId: 'd', cardId: 'c',
            oldStatus: 'in_progress', newStatus: 'review',
        });
        expect(result.fired).toBe(false);
        expect(addSystemComment).not.toHaveBeenCalled();
    });

    test('does NOT fire on todo→backlog', async () => {
        const pool = makePool([]);
        const addSystemComment = jest.fn(async () => {});
        const result = await runPreflightHook({
            pool, addSystemComment,
            card: { title: 'x' },
            deviceId: 'd', cardId: 'c',
            oldStatus: 'todo', newStatus: 'backlog',
        });
        expect(result.fired).toBe(false);
    });

    test('SELECT query receives taxonomy as PG text[] param', async () => {
        const pool = makePool([]);
        const addSystemComment = jest.fn(async () => {});
        await runPreflightHook({
            pool, addSystemComment,
            card: { title: '一旦斷線訊息就被阻擋' },
            deviceId: 'd', cardId: 'c',
            oldStatus: 'todo', newStatus: 'in_progress',
        });
        expect(pool.query).toHaveBeenCalledTimes(1);
        const [, params] = pool.query.mock.calls[0];
        expect(params[0]).toBe('d');
        expect(Array.isArray(params[1])).toBe(true);
        expect(params[1]).toContain('delivery_reliability');
    });

    test('failure isolation: pool error returns fired:true with error, does NOT throw', async () => {
        const pool = { query: jest.fn(async () => { throw new Error('db blew up'); }) };
        const addSystemComment = jest.fn(async () => {});
        const result = await runPreflightHook({
            pool, addSystemComment,
            card: { title: 'x' },
            deviceId: 'd', cardId: 'c',
            oldStatus: 'todo', newStatus: 'in_progress',
        });
        expect(result.fired).toBe(true);
        expect(result.error).toMatch(/db blew up/);
        expect(addSystemComment).not.toHaveBeenCalled();
    });

    test('failure isolation: addSystemComment error does NOT throw', async () => {
        const pool = makePool([]);
        const addSystemComment = jest.fn(async () => { throw new Error('comment insert failed'); });
        const result = await runPreflightHook({
            pool, addSystemComment,
            card: { title: 'x' },
            deviceId: 'd', cardId: 'c',
            oldStatus: 'todo', newStatus: 'in_progress',
        });
        expect(result.fired).toBe(true);
        expect(result.error).toMatch(/comment insert failed/);
    });

    test('passes similarEpisodes through composer (top-5 ranking applied)', async () => {
        const fakeRows = Array.from({ length: 7 }, (_, i) => ({
            cardId: `card_${i}`, entityId: 2, taskType: 'bugfix',
            painTags: ['ux_feedback'],
            deliverable: 'd', userVisibleResult: 'u',
            evidence: [], missedChecks: [`lesson ${i}`],
            severity: 'P1',
            occurredAt: `2026-06-0${i + 1}T00:00:00Z`,
        }));
        const pool = makePool(fakeRows);
        const addSystemComment = jest.fn(async () => {});
        const result = await runPreflightHook({
            pool, addSystemComment,
            card: { title: '使用者回饋差', description: '' },
            deviceId: 'd', cardId: 'c',
            oldStatus: 'todo', newStatus: 'in_progress',
        });
        expect(result.similarCount).toBe(5);
        // newest 5 of 7 should be cited
        expect(result.text).toMatch(/lesson 6/);
        expect(result.text).toMatch(/lesson 2/);
        expect(result.text).not.toMatch(/lesson 0/);
        expect(result.text).not.toMatch(/lesson 1/);
    });
});
