/**
 * Regression: telemetry buffer permanently drops entries once full.
 *
 * Root cause (found 2026-07-12 audit): pruneIfNeeded() reassigned
 * sizeCache[deviceId] to a NEW object after deleting old rows, but
 * appendEntries() still held a reference to the OLD object. Its
 * post-prune capacity check therefore read the stale full-buffer
 * numbers and dropped every new entry — production buffers sat at
 * 100% for weeks with newest entry frozen in time.
 *
 * The fix mutates the cached object in place so the reference held
 * by appendEntries observes the pruned totals.
 */

const telemetry = require('../../device-telemetry');

function makeFakePool({ fullBytes, prunedBytes }) {
    let sumCalls = 0;
    const queries = [];
    return {
        queries,
        query: jest.fn(async (sql) => {
            queries.push(sql);
            if (sql.includes('SUM(size_bytes)')) {
                sumCalls++;
                // 1st SUM = ensureSizeCache (buffer full);
                // later SUMs = post-prune recalc (buffer freed)
                const total = sumCalls === 1 ? fullBytes : prunedBytes;
                return { rows: [{ total: String(total), cnt: sumCalls === 1 ? '100' : '50' }] };
            }
            if (sql.startsWith('DELETE')) return { rowCount: 200 };
            if (sql.includes('INSERT INTO device_telemetry')) return { rowCount: 1 };
            return { rows: [] };
        })
    };
}

describe('device-telemetry prune stale-cache regression', () => {
    test('entry is ACCEPTED after prune frees space (was dropped via stale cache ref)', async () => {
        const pool = makeFakePool({
            fullBytes: telemetry.MAX_BUFFER_BYTES, // exactly at cap → any new entry overflows
            prunedBytes: 1000
        });
        const deviceId = 'prune-stale-cache-test-device';

        const res = await telemetry.appendEntries(pool, deviceId, [
            { ts: 1720000000000, type: 'api_req', action: 'test', meta: { k: 'v' } }
        ]);

        expect(res.accepted).toBe(1);
        expect(res.dropped).toBe(0);
        // prune must actually have run
        expect(pool.queries.some(q => q.startsWith('DELETE'))).toBe(true);
        // and the insert must have landed
        expect(pool.queries.some(q => q.includes('INSERT INTO device_telemetry'))).toBe(true);
        // bufferUsed must reflect the pruned total + new entry, not the stale full value
        expect(res.bufferUsed).toBeLessThan(telemetry.MAX_BUFFER_BYTES);
    });

    test('entry is still dropped when prune cannot free enough space', async () => {
        const pool = makeFakePool({
            fullBytes: telemetry.MAX_BUFFER_BYTES,
            prunedBytes: telemetry.MAX_BUFFER_BYTES // prune "ran" but freed nothing
        });
        const deviceId = 'prune-stale-cache-test-device-2';

        const res = await telemetry.appendEntries(pool, deviceId, [
            { ts: 1720000000000, type: 'api_req', action: 'test' }
        ]);

        expect(res.accepted).toBe(0);
        expect(res.dropped).toBe(1);
    });
});
