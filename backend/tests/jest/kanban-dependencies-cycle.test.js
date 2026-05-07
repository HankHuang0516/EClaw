'use strict';

/**
 * kanban-dependencies-cycle.test.js (PR-DCA — refactored in PR-DCB to use shared fixture)
 *
 * Real SQL execution via pg-mem against the shared MINIMAL_SCHEMA fixture
 * in backend/tests/jest/__fixtures__/kanban-dep-schema.js.
 *
 * Mac_F sign-off 2026-05-07 explicitly allowed this fallback shape:
 *   "if pg-mem cannot faithfully run the recursive CTE/function, do not
 *    fake a green test … keep pg-mem for route/idempotency tests".
 */

const { detectDependencyCycle } = require('../../kanban-dependencies');
const { bootstrap, insertCard, insertEdge, reset } = require('./__fixtures__/kanban-dep-schema');

const DEVICE = 'test-dev';

describe('detectDependencyCycle (PR-DCA)', () => {
    let pool;

    beforeAll(async () => {
        ({ pool } = await bootstrap());
    });

    beforeEach(async () => {
        await reset(pool);
        for (const id of ['A', 'B', 'C', 'D', 'E']) {
            await insertCard(pool, id, DEVICE);
        }
    });

    test('self-reference (A→A) is always a cycle', async () => {
        await expect(detectDependencyCycle(pool, DEVICE, 'A', 'A')).resolves.toBe(true);
    });

    test('direct: A→B exists; adding B→A is rejected', async () => {
        await insertEdge(pool, DEVICE, 'A', 'B');
        await expect(detectDependencyCycle(pool, DEVICE, 'B', 'A')).resolves.toBe(true);
    });

    test('transitive: A→B and B→C exist; adding C→A is rejected', async () => {
        await insertEdge(pool, DEVICE, 'A', 'B');
        await insertEdge(pool, DEVICE, 'B', 'C');
        await expect(detectDependencyCycle(pool, DEVICE, 'C', 'A')).resolves.toBe(true);
    });

    test('parallel chains (A→B, A→C, B→D, C→D): adding E→A is NOT a cycle', async () => {
        await insertEdge(pool, DEVICE, 'A', 'B');
        await insertEdge(pool, DEVICE, 'A', 'C');
        await insertEdge(pool, DEVICE, 'B', 'D');
        await insertEdge(pool, DEVICE, 'C', 'D');
        await expect(detectDependencyCycle(pool, DEVICE, 'E', 'A')).resolves.toBe(false);
    });

    test('happy path: empty graph, adding A→B is NOT a cycle', async () => {
        await expect(detectDependencyCycle(pool, DEVICE, 'A', 'B')).resolves.toBe(false);
    });

    test('cross-device isolation: edges in another device do not bleed across', async () => {
        await insertEdge(pool, DEVICE, 'A', 'B');
        await expect(detectDependencyCycle(pool, 'other-dev', 'B', 'A')).resolves.toBe(false);
    });

    test('rejects missing required args', async () => {
        await expect(detectDependencyCycle(pool, DEVICE, 'A', null)).rejects.toThrow(/required/);
        await expect(detectDependencyCycle(null, DEVICE, 'A', 'B')).rejects.toThrow(/required/);
    });
});
