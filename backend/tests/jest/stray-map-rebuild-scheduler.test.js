require('./helpers/mock-setup');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { Pool } = require('pg');
const { PgSchedulerBridge, withPgScheduledPass, INTERVAL_MS } = require('../../../tools/stray-map-rebuild/pg-scheduler.cjs');
const { scheduledPass, startLoopback, readJSON } = require('../../../tools/stray-map-intake/rehearsal');
const f = require('../../../tools/stray-map-intake/synthetic-fixtures');
const cases = require('../../../tools/stray-map-intake/case-fixtures');
const clone = value => JSON.parse(JSON.stringify(value));
let closers;
beforeEach(() => { closers = []; });
afterEach(async () => { await Promise.all(closers.map(close => close())); });
function setup(shared = new Map()) {
    const pool = new Pool(), clients = []; let clock = f.SUBMITTED;
    pool.connect.mockImplementation(async () => {
        const client = { release: jest.fn(), query: jest.fn(async (sql, params) => {
            if (sql.includes('SELECT slot_start,next_poll_at')) {
                const rows = shared.get(JSON.stringify(params)) || []; return { rows: rows.length ? [rows.at(-1)] : [] };
            }
            if (sql.includes('INSERT INTO rebuild_external.poll_slots')) {
                const [publisher, dataset, start, job] = params, key = JSON.stringify([publisher, dataset]);
                const rows = shared.get(key) || [];
                rows.push({ publisher, dataset, slot_start: start, next_poll_at: new Date(Date.parse(start) + INTERVAL_MS), job_id: job });
                shared.set(key, rows);
            }
            return { rows: [] };
        }) };
        clients.push(client); return client;
    });
    const options = { pool, sourcePolicies: [f.policy, f.peerPolicy], now: () => clock, syntheticDatabase: true };
    return { pool, clients, shared, options, setClock: value => { clock = value; }, bridge: new PgSchedulerBridge(options) };
}
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
async function fixture(body, onGet = () => {}) {
    const value = await startLoopback((req, res) => { onGet(req); json(res, 200, body); });
    closers.push(value.close); return value;
}
async function native(handler) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise(resolve => server.close(resolve)));
    return { url: `http://127.0.0.1:${server.address().port}`, server };
}
async function pending({ loseFirstAck = false, alwaysDrop = false, status = 202 } = {}) {
    const requests = [], receipts = new Map();
    const server = await native(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString(), key = req.headers['idempotency-key'];
        requests.push({ method: req.method, path: req.url, key, body });
        if (!receipts.has(key)) receipts.set(key, { success: true, tipId: 'tip_synthetic00000001', status: 'PENDING', publicVisible: false, submittedAt: f.SUBMITTED });
        if (alwaysDrop || (loseFirstAck && requests.length === 1)) { res.destroy(); return; }
        json(res, status, status === 202 ? { success: true, receipt: receipts.get(key), status: 202 } : { success: false, error: 'SYNTHETIC_REFUSAL' });
    });
    return { ...server, requests, receipts };
}
const pass = (bridge, source, receiver, extra = {}) => withPgScheduledPass({ bridge, sourceURL: source.url,
    receiverURL: receiver.url, sourceScope: f.policy, nativeReceiverVerified: true, ...extra });

describe('PG immutable per-source poll slots', () => {
    test('creates only the isolated schedule table with 15-minute database constraint', async () => {
        const { bridge, pool } = setup(); await bridge.init();
        expect(pool.query).toHaveBeenCalledTimes(1);
        const sql = pool.query.mock.calls[0][0]; expect(sql).toContain('rebuild_external.poll_slots');
        expect(sql).toContain('PRIMARY KEY(publisher,dataset,slot_start)'); expect(sql).toContain("interval '15 minutes'");
        expect(sql).not.toMatch(/\b(?:animals|devices|photos|requests|tips)\s*\(/i);
    });
    test('persists 15-minute gate across fresh bridges; another job cannot bypass the same source slot', async () => {
        const s = setup(); await s.bridge.init();
        expect(await s.bridge.reservePoll(f.policy, 'synthetic-first')).toBe(true);
        const before = clone([...s.shared]);
        const fresh = new PgSchedulerBridge(s.options); await fresh.init();
        s.setClock('2026-11-26T12:14:59.999Z'); expect(await fresh.reservePoll(f.policy, 'synthetic-new-job')).toBe(false);
        expect(clone([...s.shared])).toEqual(before);
        s.setClock('2026-11-26T12:15:00.000Z'); expect(await fresh.reservePoll(f.policy, 'synthetic-new-job')).toBe(true);
        expect([...s.shared.values()][0]).toHaveLength(2);
        for (const client of s.clients) {
            const sql = client.query.mock.calls.map(([q]) => q);
            expect(sql[0]).toBe('BEGIN'); expect(sql[1]).toContain('pg_advisory_xact_lock');
            expect(sql[2]).toContain('WHERE publisher=$1 AND dataset=$2'); expect(sql.at(-1)).toBe('COMMIT');
            expect(sql.join(' ')).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE)\b/i); expect(client.release).toHaveBeenCalledTimes(1);
        }
    });
    test('publisher/dataset scope is separate and a backwards test clock cannot create a new slot', async () => {
        const s = setup(); await s.bridge.init(); await s.bridge.reservePoll(f.policy, 'synthetic-first');
        expect(await s.bridge.reservePoll(f.peerPolicy, 'synthetic-first')).toBe(true);
        s.setClock('2026-11-26T11:00:00.000Z'); expect(await s.bridge.reservePoll(f.policy, 'synthetic-first')).toBe(false);
        expect(s.shared.size).toBe(2);
    });
    test.each([false, undefined])('requires runner-verified synthetic pool %j', syntheticDatabase => {
        const s = setup(); expect(() => new PgSchedulerBridge({ ...s.options, syntheticDatabase })).toThrow('VERIFIED_SYNTHETIC_POOL_REQUIRED');
    });
    test.each([{ ...f.policy, publisherId: 'real-publisher' }, { ...f.policy, datasetId: 'real-dataset' },
        { ...f.policy, verified: false }, { ...f.policy, origin: 'https://public.example.com' }])('rejects untrusted policy %#', policy => {
        const s = setup(); expect(() => new PgSchedulerBridge({ ...s.options, sourcePolicies: [policy] })).toThrow('SYNTHETIC_SCHEDULER_CONTEXT_REQUIRED');
    });
    test('rejects uninitialized store, unregistered scope, interval changes and invalid clocks before connecting', async () => {
        const s = setup(); await expect(s.bridge.reservePoll(f.policy, 'synthetic-job')).rejects.toThrow('SCHEDULER_INIT_REQUIRED');
        await s.bridge.init();
        await expect(s.bridge.reservePoll({ publisherId: 'synthetic-unknown' }, 'synthetic-job')).rejects.toThrow('UNREGISTERED_SYNTHETIC_SOURCE');
        await expect(s.bridge.reservePoll(f.policy, 'synthetic-job', 60000)).rejects.toThrow('INVALID_SYNTHETIC_SCHEDULE');
        await expect(s.bridge.reservePoll(f.policy, 'x')).rejects.toThrow('INVALID_SYNTHETIC_SCHEDULE');
        s.setClock('not-a-clock'); await expect(s.bridge.reservePoll(f.policy, 'synthetic-job')).rejects.toThrow('INVALID_SCHEDULER_CLOCK');
        expect(s.pool.connect).not.toHaveBeenCalled();
    });
    test('rolls back/release on PG insert failure and does not claim the slot', async () => {
        const s = setup(); await s.bridge.init();
        const client = { release: jest.fn(), query: jest.fn().mockResolvedValue({ rows: [] }) };
        client.query.mockImplementation(async sql => { if (sql.includes('INSERT INTO')) throw Error('SYNTHETIC_PG_FAILURE'); return { rows: [] }; });
        s.pool.connect.mockResolvedValue(client);
        await expect(s.bridge.reservePoll(f.policy, 'synthetic-job')).rejects.toThrow('SYNTHETIC_PG_FAILURE');
        expect(client.query.mock.calls.at(-1)[0]).toBe('ROLLBACK'); expect(client.release).toHaveBeenCalledTimes(1); expect(s.shared.size).toBe(0);
    });
    test('failed DDL cannot enable poll reservation', async () => {
        const s = setup(); s.pool.query.mockRejectedValue(Error('SYNTHETIC_DDL_FAILURE'));
        await expect(s.bridge.init()).rejects.toThrow('SYNTHETIC_DDL_FAILURE');
        await expect(s.bridge.reservePoll(f.policy, 'synthetic-job')).rejects.toThrow('SCHEDULER_INIT_REQUIRED');
        expect(s.pool.connect).not.toHaveBeenCalled();
    });
    test('invalid persisted timestamp fails closed and releases connection', async () => {
        const s = setup(); await s.bridge.init();
        s.shared.set(JSON.stringify([f.policy.publisherId, f.policy.datasetId]), [{ next_poll_at: 'invalid' }]);
        await expect(s.bridge.reservePoll(f.policy, 'synthetic-job')).rejects.toThrow('INVALID_PERSISTED_POLL_SLOT');
        expect(s.clients[0].query.mock.calls.at(-1)[0]).toBe('ROLLBACK'); expect(s.clients[0].release).toHaveBeenCalled();
    });
});

describe('actual existing scheduledPass over registered fixture HTTP and direct pending HTTP', () => {
    test('GET → native pending POST; new bridge skips; 15-minute next slot resends same key/body/receipt', async () => {
        const s = setup(); await s.bridge.init(); const gets = jest.fn();
        const source = await fixture({ synthetic: true, records: [cases.caseTip('SIGHTING')] }, gets), receiver = await pending();
        const first = await pass(s.bridge, source, receiver);
        expect(first).toMatchObject({ success: true, skipped: false, simulation: true, sourceLifecycleImplemented: false,
            scheduler: 'EXISTING_REHEARSAL_SCHEDULED_PASS', pollState: 'PG_APPEND_ONLY_SLOTS' });
        expect(first.availability).toMatchObject({ applied: false, reason: 'SOURCE_LIFECYCLE_NOT_IMPLEMENTED_BY_SCHEDULER' });
        expect(receiver.requests[0]).toMatchObject({ method: 'POST', path: '/external-rebuild/v1/tips' });
        const p = cases.caseTip('SIGHTING').source;
        expect(receiver.requests[0].key).toBe(createHash('sha256').update(JSON.stringify([p.publisherId, p.datasetId, p.recordKey])).digest('hex'));
        const fresh = new PgSchedulerBridge(s.options); await fresh.init();
        expect(await pass(fresh, source, receiver)).toMatchObject({ success: true, skipped: true, requests: 0 });
        expect(gets).toHaveBeenCalledTimes(1); expect(receiver.requests).toHaveLength(1);
        s.setClock('2026-11-26T12:15:00.000Z'); const next = await pass(fresh, source, receiver);
        expect(next.results[0].body.receipt).toEqual(first.results[0].body.receipt);
        expect(receiver.requests[1]).toEqual(receiver.requests[0]); expect(receiver.receipts.size).toBe(1);
        await expect(readJSON(`${receiver.url}/v1/public/tips`)).rejects.toThrow('SYNTHETIC_LOOPBACK_ONLY');
    });
    test('awaits PG COMMIT before GET and POST', async () => {
        const s = setup(); await s.bridge.init(); let releaseCommit;
        const committed = new Promise(resolve => { releaseCommit = resolve; });
        const client = { release: jest.fn(), query: jest.fn(async sql => { if (sql === 'COMMIT') await committed; return { rows: [] }; }) };
        s.pool.connect.mockResolvedValue(client);
        const gets = jest.fn(), source = await fixture({ synthetic: true, records: [cases.caseTip('SIGHTING')] }, gets), receiver = await pending();
        const running = pass(s.bridge, source, receiver);
        await new Promise(resolve => setImmediate(resolve)); expect(gets).not.toHaveBeenCalled(); expect(receiver.requests).toHaveLength(0);
        releaseCommit(); await running; expect(gets).toHaveBeenCalledTimes(1); expect(receiver.requests).toHaveLength(1);
    });
    test('lost acknowledgement retries same body/key exactly once', async () => {
        const s = setup(); await s.bridge.init(); const gets = jest.fn();
        const source = await fixture({ synthetic: true, records: [cases.caseTip('SIGHTING')] }, gets), receiver = await pending({ loseFirstAck: true });
        const result = await pass(s.bridge, source, receiver);
        expect(result.success).toBe(true); expect(gets).toHaveBeenCalledTimes(1); expect(receiver.requests).toHaveLength(2);
        expect(receiver.requests[1]).toEqual(receiver.requests[0]); expect(receiver.receipts.size).toBe(1);
    });
    test('exhausted POST retry preserves poll reservation and prevents a new immediate GET', async () => {
        const s = setup(); await s.bridge.init(); const gets = jest.fn();
        const source = await fixture({ synthetic: true, records: [cases.caseTip('SIGHTING')] }, gets), receiver = await pending({ alwaysDrop: true });
        await expect(pass(s.bridge, source, receiver)).rejects.toThrow(); expect(receiver.requests).toHaveLength(2);
        await expect(readJSON(`${receiver.url}/v1/public/tips`)).rejects.toThrow('SYNTHETIC_LOOPBACK_ONLY');
        const fresh = new PgSchedulerBridge(s.options); await fresh.init();
        expect(await pass(fresh, source, receiver)).toMatchObject({ skipped: true }); expect(gets).toHaveBeenCalledTimes(1);
    });
    test('application refusal never retries or claims accepted result', async () => {
        const s = setup(); await s.bridge.init(); const source = await fixture({ synthetic: true, records: [cases.caseTip('SIGHTING')] }), receiver = await pending({ status: 409 });
        expect(await pass(s.bridge, source, receiver)).toMatchObject({ success: false }); expect(receiver.requests).toHaveLength(1);
    });
    test.each([{ synthetic: false, records: [] }, { synthetic: true, records: [cases.caseTip('FOUND')] },
        { synthetic: true, records: [], events: [{ type: 'EXPLICIT_CLOSED' }] }, { synthetic: true, records: Array(21).fill(cases.caseTip('SIGHTING')) }])('rejects non-synthetic/mismatched/unsupported fixture %#', async payload => {
        const s = setup(); await s.bridge.init(); const source = await fixture(payload), receiver = await pending();
        await expect(pass(s.bridge, source, receiver)).rejects.toThrow('INVALID_SYNTHETIC_DATASET'); expect(receiver.requests).toHaveLength(0);
    });
    test.each(['https://example.invalid', 'http://localhost:1234', 'http://127.0.0.1:1234/path',
        'http://127.0.0.1:1234/?query=1', 'http://127.0.0.1:1234/#fragment', 'http://synthetic@127.0.0.1:1234/'])('rejects receiver %s before PG reservation', async receiverURL => {
        const s = setup(); await s.bridge.init();
        await expect(withPgScheduledPass({ bridge: s.bridge, sourceURL: 'unused', receiverURL, sourceScope: f.policy, nativeReceiverVerified: true })).rejects.toThrow('SYNTHETIC_NATIVE_LOOPBACK_ONLY');
        expect(s.pool.connect).not.toHaveBeenCalled();
    });
    test('requires receiver attestation and refuses an unregistered local source before PG reservation', async () => {
        const s = setup(); await s.bridge.init(); const receiver = await pending();
        await expect(pass(s.bridge, receiver, receiver, { nativeReceiverVerified: false })).rejects.toThrow('VERIFIED_SYNTHETIC_NATIVE_RECEIVER_REQUIRED');
        await expect(pass(s.bridge, receiver, receiver)).rejects.toThrow('SYNTHETIC_LOOPBACK_ONLY'); expect(s.pool.connect).not.toHaveBeenCalled();
    });
    test('PG reservation failure cannot issue GET or POST', async () => {
        const s = setup(); await s.bridge.init(); s.pool.connect.mockRejectedValue(Error('SYNTHETIC_PG_UNAVAILABLE'));
        const gets = jest.fn(), source = await fixture({ synthetic: true, records: [] }, gets), receiver = await pending();
        await expect(pass(s.bridge, source, receiver)).rejects.toThrow('SYNTHETIC_PG_UNAVAILABLE');
        expect(gets).not.toHaveBeenCalled(); expect(receiver.requests).toHaveLength(0);
    });
    test('rejects non-bridge input without accessing a pool', async () => {
        await expect(withPgScheduledPass({ bridge: {} })).rejects.toThrow('PG_SCHEDULER_BRIDGE_REQUIRED');
    });
    test.each(['/v1/public/tips', '/external-rebuild/v1/tips?query=1', '//v1/public/tips', '/other', '/synthetic/tips/'])('existing scheduler rejects arbitrary receiver path %s', async receiverPath => {
        const reservePoll = jest.fn(); await expect(scheduledPass({ store: { reservePoll }, receiverPath })).rejects.toThrow('INVALID_RECEIVER_PATH');
        expect(reservePoll).not.toHaveBeenCalled();
    });
    test('legacy synchronous stores still work and async source events are strictly sequential', async () => {
        const order = [], source = await fixture({ synthetic: true, records: [], events: [{ id: 1 }, { id: 2 }] }), receiver = await fixture({});
        const store = { reservePoll: () => true, sourceEvent: async event => { order.push(`start${event.id}`); await new Promise(resolve => setImmediate(resolve)); order.push(`end${event.id}`); return { success: true }; } };
        expect((await scheduledPass({ store, sourceURL: source.url, receiverURL: receiver.url })).success).toBe(true);
        expect(order).toEqual(['start1', 'end1', 'start2', 'end2']);
    });
    test.each([true, false])('awaits async source availability on successful/failed fixture success=%s', async success => {
        const source = await fixture({ synthetic: success, records: [] }), receiver = await fixture({}); let finished = false;
        const store = { policies: [f.policy], reservePoll: () => true, sourceAvailability: async () => {
            await new Promise(resolve => setImmediate(resolve)); finished = true; return { success: true };
        } };
        const running = scheduledPass({ store, sourceURL: source.url, receiverURL: receiver.url, sourceScope: f.policy });
        if (success) expect((await running).success).toBe(true); else await expect(running).rejects.toThrow('INVALID_SYNTHETIC_DATASET');
        expect(finished).toBe(true);
    });
    test.each([{ synthetic: false, purpose: 'STRAY_MAP_ISOLATED_NATIVE' }, { synthetic: true, purpose: 'OTHER' },
        { synthetic: true, purpose: 'STRAY_MAP_ISOLATED_NATIVE', extra: true }])('cannot register receiver with invalid attestation %#', async invalid => {
        const source = await fixture({ synthetic: true, records: [] }), receiver = await pending(), reservePoll = jest.fn();
        await expect(scheduledPass({ store: { reservePoll }, sourceURL: source.url, receiverURL: receiver.url,
            receiverPath: '/external-rebuild/v1/tips', receiverRegistration: { origin: receiver.url, ...invalid } })).rejects.toThrow('INVALID_RECEIVER_REGISTRATION');
        expect(reservePoll).not.toHaveBeenCalled();
        await expect(readJSON(receiver.url)).rejects.toThrow('SYNTHETIC_LOOPBACK_ONLY');
    });
});
