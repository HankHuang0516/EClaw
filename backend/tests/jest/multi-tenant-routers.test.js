'use strict';

/**
 * Compliance Part B Slice 1 — multi-tenant isolation for modular routers.
 * Card: card_25021d746bfdc31e29a167ef (Slice 1 of Strategic compliance B).
 *
 * Asserts that the entity-scoped helpers in entity-status.js and the
 * episode ingestion in agent-improvement.js correctly partition data by
 * (deviceId, entityId). A pool-mock stores rows and replays the actual
 * WHERE filter logic so the helpers' SQL is exercised end-to-end.
 *
 * Why this layer: index.js routes (/api/transform, /api/client/speak,
 * /api/mission/cards) aren't router-modularized, so they get exercised
 * by Playwright in Slice 2. Slice 1 covers the modular code paths.
 */

const entityStatus = require('../../entity-status');
const agentImprovement = require('../../agent-improvement');
const { PAIN_TAXONOMY } = require('../../agent-improvement/episode-schema');

function makeOperationLogPool() {
    let nextId = 1;
    const rows = [];
    return {
        rows,
        async query(sql, params) {
            const s = sql.replace(/\s+/g, ' ').trim();
            if (s.startsWith('INSERT INTO entity_operation_log')) {
                rows.push({
                    id: nextId++,
                    device_id: params[0],
                    entity_id: params[1],
                    event_type: params[2],
                    event_summary: params[3],
                    event_payload: typeof params[4] === 'string' ? JSON.parse(params[4]) : params[4],
                    occurred_at: new Date(),
                });
                return { rows: [] };
            }
            if (s.includes('FROM entity_operation_log') && s.includes('WHERE device_id = $1 AND entity_id = $2')) {
                const [deviceId, entityId, maybeBefore, maybeLimit] = params;
                const limit = params[params.length - 1];
                const matching = rows
                    .filter(r => r.device_id === deviceId && r.entity_id === Number(entityId))
                    .filter(r => {
                        if (s.includes('AND id < $3')) return r.id < maybeBefore;
                        return true;
                    })
                    .sort((a, b) => b.id - a.id);
                const sliced = matching.slice(0, limit);
                if (s.includes('AND id = $3')) {
                    const target = matching.find(r => r.id === Number(params[2]));
                    return { rows: target ? [target] : [] };
                }
                return { rows: sliced };
            }
            return { rows: [] };
        },
    };
}

function makeEpisodePool() {
    const rows = [];
    let nextId = 1;
    return {
        rows,
        async query(sql, params) {
            const s = sql.replace(/\s+/g, ' ').trim();
            if (s.startsWith('INSERT INTO agent_improvement_episodes')) {
                const row = {
                    id: nextId++,
                    device_id: params[0],
                    card_id: params[1],
                    entity_id: params[2],
                    task_type: params[3],
                    pain_tags: typeof params[4] === 'string' ? JSON.parse(params[4]) : params[4],
                    deliverable: params[5],
                    user_visible_result: params[6],
                    evidence: typeof params[7] === 'string' ? JSON.parse(params[7]) : params[7],
                    missed_checks: typeof params[8] === 'string' ? JSON.parse(params[8]) : params[8],
                    user_feedback: params[9],
                    severity: params[10],
                    occurred_at: params[11],
                };
                rows.push(row);
                return { rows: [{ id: row.id }] };
            }
            return { rows: [] };
        },
    };
}

describe('entity-status multi-tenant isolation', () => {
    let pool;
    const DEVICE = 'multi-tenant-device';

    beforeEach(() => {
        pool = makeOperationLogPool();
        entityStatus.initTable(pool);
    });

    test('logOperation persists rows with their entity_id', async () => {
        await entityStatus.logOperation(DEVICE, 2, 'message_sent', 'entity 2 sent', { kind: 'chat' });
        await entityStatus.logOperation(DEVICE, 5, 'message_sent', 'entity 5 sent', { kind: 'chat' });
        expect(pool.rows).toHaveLength(2);
        expect(pool.rows.find(r => r.entity_id === 2)).toMatchObject({ event_summary: 'entity 2 sent' });
        expect(pool.rows.find(r => r.entity_id === 5)).toMatchObject({ event_summary: 'entity 5 sent' });
    });

    test('getOperationLog for entity 2 returns only entity 2 rows', async () => {
        await entityStatus.logOperation(DEVICE, 2, 'a', 'two-a', {});
        await entityStatus.logOperation(DEVICE, 5, 'a', 'five-a', {});
        await entityStatus.logOperation(DEVICE, 2, 'b', 'two-b', {});

        const out2 = await entityStatus.getOperationLog(DEVICE, 2);
        expect(out2.items.map(i => i.eventSummary).sort()).toEqual(['two-a', 'two-b']);

        const out5 = await entityStatus.getOperationLog(DEVICE, 5);
        expect(out5.items.map(i => i.eventSummary)).toEqual(['five-a']);
    });

    test('getLogRowById refuses cross-entity reads', async () => {
        await entityStatus.logOperation(DEVICE, 2, 'a', 'two-secret', {});
        await entityStatus.logOperation(DEVICE, 5, 'b', 'five-secret', {});
        // The entity_id=5 row has id=2 in this fake. Asking as entity 2 must NOT return it.
        const fiveRow = pool.rows.find(r => r.entity_id === 5);
        const cross = await entityStatus.getLogRowById(DEVICE, 2, String(fiveRow.id));
        expect(cross).toBeNull();
        // Same row asked as entity 5 returns it.
        const ownRow = await entityStatus.getLogRowById(DEVICE, 5, String(fiveRow.id));
        expect(ownRow && ownRow.eventSummary).toBe('five-secret');
    });

    test('getOperationLog on a different deviceId returns nothing', async () => {
        await entityStatus.logOperation(DEVICE, 2, 'a', 'only-on-this-device', {});
        const cross = await entityStatus.getOperationLog('OTHER-DEVICE', 2);
        expect(cross.items).toEqual([]);
    });
});

describe('agent-improvement multi-tenant isolation', () => {
    let pool;
    const DEVICE = 'multi-tenant-device';

    beforeEach(() => {
        pool = makeEpisodePool();
    });

    test('ingestEpisode stores entity_id from the episode payload (deviceId comes from route, not caller)', async () => {
        const baseEp = {
            _deviceId: DEVICE,                            // route-injected, never trusted from caller
            cardId: 'card_two',
            entityId: 2,
            taskType: 'feature_impl',
            painTags: ['ux_feedback'],
            deliverable: 'entity 2 deliverable',
            userVisibleResult: 'entity 2 saw this',
            evidence: [],
            missedChecks: [],
            severity: 'P2',
            occurredAt: new Date().toISOString(),
        };
        const ep5 = { ...baseEp, entityId: 5, cardId: 'card_five', deliverable: 'entity 5 deliverable' };

        await agentImprovement.ingestEpisode(baseEp, pool);
        await agentImprovement.ingestEpisode(ep5, pool);

        expect(pool.rows).toHaveLength(2);
        const ent2Row = pool.rows.find(r => r.entity_id === 2);
        const ent5Row = pool.rows.find(r => r.entity_id === 5);
        expect(ent2Row.deliverable).toBe('entity 2 deliverable');
        expect(ent5Row.deliverable).toBe('entity 5 deliverable');
        // No cross-entity bleed in stored rows.
        expect(ent2Row.deliverable).not.toContain('entity 5');
        expect(ent5Row.deliverable).not.toContain('entity 2');
    });

    test('ingestEpisode rejects unknown painTags (taxonomy is closed)', async () => {
        const bad = {
            _deviceId: DEVICE,
            cardId: 'card_x',
            entityId: 2,
            taskType: 'feature_impl',
            painTags: ['totally_made_up_tag'],
            deliverable: 'x',
            userVisibleResult: 'x',
            evidence: [],
            missedChecks: [],
            severity: 'P2',
            occurredAt: new Date().toISOString(),
        };
        await expect(agentImprovement.ingestEpisode(bad, pool)).rejects.toThrow(/painTags contains unknown tag/);
        expect(pool.rows).toHaveLength(0);
    });

    test('PAIN_TAXONOMY exposes the canonical 8 tags', () => {
        expect(PAIN_TAXONOMY).toHaveLength(8);
        expect(PAIN_TAXONOMY).toEqual(expect.arrayContaining([
            'delivery_reliability', 'auth_session', 'redirect_deeplink',
            'ux_feedback', 'agent_ownership', 'task_context',
            'test_coverage', 'scope_completeness',
        ]));
    });
});
