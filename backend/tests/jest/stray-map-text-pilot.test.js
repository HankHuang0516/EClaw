require('./helpers/mock-setup');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { install, PROFILE } = require('../../../tools/stray-map-pilot/pilot.cjs');
const NOW = '2026-11-27T12:00:00.000Z', PREFIX = '/external-intake/v1';
const copy = x => JSON.parse(JSON.stringify(x));
const policy = { verified: true, publisherId: 'publisher-a', datasetId: 'dataset-a', origin: 'https://provider.example.invalid', pathPrefix: '/tips/', allowedRegions: ['TW-TPE'] };
const checks = { contentReviewed: true, localLanguageReviewed: true, privacyReviewed: true, sourceVerified: true, locationSafe: true };
function payload(record = 'private_record_key_0001') {
    return { schemaVersion: 3, thirdParty: true, selfWitness: false,
        source: { publisherId: policy.publisherId, datasetId: policy.datasetId, recordKey: record, url: null,
            publishedAt: { precision: 'INSTANT', value: NOW, timeZone: 'UTC' } },
        observation: { precision: 'DATE', value: '2026-11-26', timeZone: 'Asia/Taipei' },
        animal: { kind: 'DOG', count: 1, condition: 'UNKNOWN' }, location: { countryCode: 'TW', regionCode: 'TW-TPE', sensitivity: 'NONE' },
        display: { locale: 'zh-TW', title: '來源犬隻線索', description: '來源文字僅供私人審核。' }, photos: [],
        report: { type: 'SIGHTING', locationMeaning: 'OBSERVED_AT', custody: { status: 'UNKNOWN', asOf: { precision: 'UNKNOWN', value: null, timeZone: null } } } };
}
function database(shared = { tips: [], keys: [] }) {
    const pool = new Pool(), clients = [];
    pool.options = { connectionTimeoutMillis: 3000, statement_timeout: 5000, query_timeout: 6000 };
    pool.connect.mockImplementation(async () => {
        let snapshot;
        const client = { release: jest.fn(), query: jest.fn(async (sql, p = []) => {
            if (shared.beforeQuery) await shared.beforeQuery(sql, p);
            if (shared.fail && sql.includes(shared.fail)) throw Error('private database detail must not escape');
            if (sql === 'ROLLBACK' && shared.failRollback) throw Error('private rollback failure');
            if (sql === 'BEGIN') snapshot = copy({ tips: shared.tips, keys: shared.keys });
            if (sql === 'ROLLBACK' && snapshot) { shared.tips = snapshot.tips; shared.keys = snapshot.keys; }
            let rows = [];
            if (sql.includes('pilot:replay')) {
                const k = shared.keys.find(k => k.publisher === p[0] && k.key === p[1]);
                if (k) {
                    const tip = shared.tips.find(t => t.id === k.id);
                    rows = [{ ...k, receipt: tip.receipt, first_decision: tip.first_decision }];
                }
            }
            else if (sql.includes('pilot:prior')) rows = shared.tips.filter(t => t.publisher === p[0] && t.dataset === p[1] && t.record_key === p[2]);
            else if (sql.includes('pilot:counts')) rows = [{ cases: shared.tips.length, pending: shared.tips.filter(t => t.review === 'PENDING').length, requests: shared.keys.length,
                recent: shared.tips.filter(t => t.publisher === p[0] && t.dataset === p[1] && Date.parse(t.created_at) > Date.parse(p[2]) - 3600000).length }];
            else if (sql.includes('pilot:insert')) {
                // Simulate JSONB's persisted key order from the first acknowledgement onward.
                const receipt = Object.fromEntries(Object.entries(p[6]).sort(([a], [b]) => a.localeCompare(b)));
                const first_decision = JSON.parse(p[9])[0]?.decision;
                shared.tips.push({ id: p[0], publisher: p[1], dataset: p[2], record_key: p[3], payload_hash: p[4], payload: copy(p[5]),
                    receipt, review: p[8], public_content: null, created_at: p[7], first_decision }); rows = [{ receipt, first_decision }];
            } else if (sql.includes('pilot:key')) shared.keys.push({ publisher: p[0], dataset: p[1], key: p[2], payload_hash: p[3], id: p[4] });
            else if (sql.includes('pilot:receipt')) rows = shared.tips.filter(t => t.id === p[0] && t.publisher === p[1] && t.dataset === p[2]);
            else if (sql.includes('pilot:review-row')) rows = shared.tips.filter(t => t.id === p[0]);
            else if (sql.includes('pilot:review-update')) { const row = shared.tips.find(t => t.id === p[0]); row.review = p[1]; row.public_content = copy(p[2]); }
            else if (sql.includes('pilot:cards')) rows = shared.tips.filter(t => t.review === 'APPROVED' && t.public_content && p[0].includes(`${t.publisher}:${t.dataset}`)).slice(0, p[1]);
            return { rows };
        }) };
        clients.push(client); return client;
    });
    pool.query.mockImplementation(async (...args) => (await pool.connect()).query(...args));
    return { pool, clients, shared };
}
function app() {
    const routes = [], parsers = [], scope = { route: r => routes.push(r), removeContentTypeParser: t => parsers.push(t), addContentTypeParser: jest.fn(),
        setErrorHandler: handler => { scope.errorHandler = handler; } };
    return { routes, parsers, scope, register: async fn => fn(scope),
        async inject({ method = 'GET', url, body, headers = {} }) {
            const u = new URL(url, 'http://localhost'), r = routes.find(r => r.method === method && new RegExp('^' + r.url.replace(':id', '[^/]+') + '$').test(u.pathname));
            if (!r) return { status: 404, body: null };
            const req = { method, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.isBuffer(body) ? body : body === undefined ? undefined : Buffer.from(JSON.stringify(body)),
                params: { id: u.pathname.split('/').at(-1) }, query: Object.fromEntries(u.searchParams) };
            const reply = { status: 200, sent: false, body: null, header: () => reply, code: n => { reply.status = n; return reply; }, send: b => { reply.body = b; reply.sent = true; return reply; } };
            await r.onRequest(req, reply);
            if (!reply.sent && req.body?.length > r.bodyLimit) scope.errorHandler({ statusCode: 413, message: 'raw body must not escape' }, req, reply);
            if (!reply.sent) await r.handler(req, reply);
            return { status: reply.status, body: reply.body };
        } };
}
async function setup({ flags, shared, configuration, bindings, poolOptions } = {}) {
    const db = database(shared), server = app();
    let config = flags || { profile: PROFILE, intake: true, review: true, publicRead: true };
    let source = { publisherId: policy.publisherId, datasetId: policy.datasetId }, reviewer = { reviewerId: 'existing-reviewer', canReview: true };
    const b = bindings || { sourcePolicies: [copy(policy)], verifySource: jest.fn(async () => source), verifyReviewer: jest.fn(async () => reviewer) };
    if (poolOptions !== undefined) db.pool.options = poolOptions;
    await install(server, { pool: db.pool, configuration: configuration || (() => config), bindings: b, now: () => NOW });
    return { ...db, server, bindings: b, setConfig: c => { config = c; }, setSource: s => { source = s; }, setReviewer: r => { reviewer = r; } };
}
const post = (s, p = payload(), key = 'request_key_00000001') => s.server.inject({ method: 'POST', url: `${PREFIX}/tips`, body: p, headers: { 'idempotency-key': key } });
async function approve(s, id, override = {}) {
    return s.server.inject({ method: 'POST', url: `${PREFIX}/review/${id}`, body: { decision: 'APPROVE', checks,
        display: { locale: 'zh-TW', title: '經審核犬隻線索', description: '僅顯示城市層級區域。' }, ...override } });
}

describe('closed-by-default independent text candidate', () => {
    test('bootstrap without bindings/config never touches schema, pool or native routes', async () => {
        const db = database(), server = app(); await install(server, { pool: db.pool });
        for (const url of [`${PREFIX}/cards`, `${PREFIX}/receipts/tip_${'a'.repeat(32)}`]) expect((await server.inject({ url })).status).toBe(503);
        expect(db.pool.connect).not.toHaveBeenCalled(); expect(db.pool.query).not.toHaveBeenCalled(); expect(server.routes).toHaveLength(4);
        expect(server.routes.every(r => r.url.startsWith(PREFIX))).toBe(true); expect(server.parsers).toEqual(['application/json']);
    });
    test.each([{ intake: true }, { review: true }, { publicRead: true }, { profile: PROFILE, intake: 'true' },
        { profile: 'OTHER', intake: true }, { profile: PROFILE, intake: true, unknown: true }])('invalid/missing explicit profile config stays closed %#', async flags => {
        const s = await setup({ flags }); expect((await post(s)).status).toBe(503); expect((await s.server.inject({ url: `${PREFIX}/cards` })).status).toBe(503); expect(s.pool.connect).not.toHaveBeenCalled();
    });
    test('all missing flags default false even with valid bindings', async () => {
        const s = await setup({ flags: {} }); expect((await post(s)).status).toBe(503); expect(s.pool.connect).not.toHaveBeenCalled();
    });
    test.each(['verifySource','verifyReviewer','sourcePolicies'])('missing %s binding stays closed before DDL', async name => {
        const b = { sourcePolicies: [policy], verifySource: async () => ({}), verifyReviewer: async () => ({}) }; delete b[name];
        const s = await setup({ bindings: b }); expect((await post(s)).status).toBe(503); expect(s.pool.connect).not.toHaveBeenCalled();
    });
    test.each([{}, { connectionTimeoutMillis: 0, statement_timeout: 5000, query_timeout: 6000 },
        { connectionTimeoutMillis: 3001, statement_timeout: 5000, query_timeout: 6000 },
        { connectionTimeoutMillis: 3000, statement_timeout: 5001, query_timeout: 6000 },
        { connectionTimeoutMillis: 3000, statement_timeout: 5000, query_timeout: 5000 }])('unbounded pool closed before DDL %#', async poolOptions => {
        const s = await setup({ poolOptions }); expect((await post(s)).status).toBe(503); expect(s.pool.connect).not.toHaveBeenCalled();
    });
    test('wrong MIME and oversize retain bounded scope status/error shapes', async () => {
        const s = await setup(); expect((await s.server.inject({ method: 'POST', url: `${PREFIX}/tips`, body: 'x', headers: { 'content-type': 'text/plain' } })).status).toBe(415);
        const large = await post(s, Buffer.alloc(16385)); expect(large).toEqual({ status: 413, body: { success: false, error: 'PAYLOAD_TOO_LARGE' } });
        const reply = { code: jest.fn().mockReturnThis(), header: jest.fn().mockReturnThis(), send: jest.fn() };
        s.server.scope.errorHandler({ statusCode: 500, message: 'private-secret' }, {}, reply); expect(reply.code).toHaveBeenCalledWith(503); expect(reply.send).toHaveBeenCalledWith({ success: false, error: 'PILOT_UNAVAILABLE' });
        expect(s.pool.connect).not.toHaveBeenCalled();
    });
});
describe('actual SQL-shaped immutable pending queue and private review', () => {
    test('automatic private intake preserves legacy receipts and cannot produce public cards', async () => {
        const s = await setup({ flags: { profile: PROFILE, intake: true } });
        s.bindings.allowPayload = value => value.animal.kind === 'DOG';
        const legacy = await post(s);
        s.setConfig({ profile: PROFILE, intake: true, autoAcceptPrivate: true });
        const second = payload('private_record_key_0002');
        const accepted = await post(s, second, 'request_key_00000002');
        expect(accepted.status).toBe(202);
        expect(accepted.body.receipt).toMatchObject({ status: 'ACCEPTED_PRIVATE', publicVisible: false });
        const url = `${PREFIX}/receipts/${accepted.body.receipt.tipId}`;
        expect((await s.server.inject({ url })).body).toEqual({ success: true, review: 'ACCEPTED_PRIVATE', receipt: accepted.body.receipt });
        for (const key of ['request_key_00000002', 'request_key_00000003']) {
            expect((await post(s, second, key)).body).toEqual({ ...accepted.body, replay: true });
        }
        expect((await post(s)).body.receipt).toEqual(legacy.body.receipt);
        expect(s.shared.tips).toHaveLength(2);
        const invalid = payload('private_record_key_0003');
        invalid.animal.kind = 'CAT';
        expect((await post(s, invalid, 'request_key_00000004')).body.error).toBe('SOURCE_PAYLOAD_NOT_AUTHORIZED');
        expect((await approve(s, accepted.body.receipt.tipId)).status).toBe(503);
        expect((await s.server.inject({ url: `${PREFIX}/cards` })).status).toBe(503);
        s.setConfig({ profile: PROFILE, intake: true, autoAcceptPrivate: true, publicRead: true });
        expect((await s.server.inject({ url })).status).toBe(503);
        s.setConfig({ profile: PROFILE, intake: false, review: true, publicRead: true });
        expect((await s.server.inject({ url: `${PREFIX}/cards` })).body.cards).toEqual([]);
        expect((await approve(s, accepted.body.receipt.tipId)).body.error).toBe('REVIEW_TERMINAL');
    });
    test('pending hidden, scoped receipt, manual artifact, withdrawal and immutable replay survive fresh install', async () => {
        const s = await setup(), first = await post(s), id = first.body.receipt.tipId;
        expect(first.status).toBe(202); expect(first.body.receipt).toMatchObject({ status: 'PENDING', publicVisible: false });
        expect((await s.server.inject({ url: `${PREFIX}/cards` })).body.cards).toEqual([]);
        expect((await s.server.inject({ url: `${PREFIX}/receipts/${id}` })).body.receipt).toEqual(first.body.receipt);
        expect((await approve(s, id)).body.status).toBe('APPROVED');
        const card = (await s.server.inject({ url: `${PREFIX}/cards` })).body.cards[0];
        expect(card).toMatchObject({ photos: [], coordinates: null, mapMarkerEligible: false, display: { locale: 'zh-TW', title: '經審核犬隻線索' }, observation: payload().observation });
        expect(JSON.stringify(card)).not.toMatch(/private_record|publisher-a|dataset-a|來源文字/);
        await s.server.inject({ method: 'POST', url: `${PREFIX}/review/${id}`, body: { decision: 'WITHDRAW' } });
        expect((await s.server.inject({ url: `${PREFIX}/cards` })).body.cards).toEqual([]);
        const fresh = await setup({ shared: s.shared }), replay = await post(fresh);
        expect(replay.body.receipt).toEqual(first.body.receipt); expect(replay.body.replay).toBe(true); expect(s.shared.tips).toHaveLength(1);
    });
    test('same publisher/key across datasets conflicts; same case/new key replays; changed payload conflicts', async () => {
        const s = await setup(), first = await post(s);
        expect((await post(s, payload(), 'request_key_00000002')).body.receipt).toEqual(first.body.receipt);
        const changed = payload(); changed.display.title = '不同內容'; expect((await post(s, changed)).status).toBe(409);
        s.bindings.sourcePolicies.push({ ...policy, datasetId: 'dataset-b' }); s.setSource({ publisherId: policy.publisherId, datasetId: 'dataset-b' });
        const other = payload(); other.source.datasetId = 'dataset-b'; expect((await post(s, other)).status).toBe(409);
        expect(s.shared.tips).toHaveLength(1);
    });
    test('closed/reopened mutable configuration retains records and original receipt', async () => {
        const s = await setup(), first = await post(s); s.setConfig({ profile: PROFILE, intake: false, review: false, publicRead: false });
        expect((await post(s)).status).toBe(503); expect((await s.server.inject({ url: `${PREFIX}/cards` })).status).toBe(503); expect(s.shared.tips).toHaveLength(1);
        s.setConfig({ profile: PROFILE, intake: true, review: false, publicRead: false }); expect((await post(s)).body.receipt).toEqual(first.body.receipt);
    });
    test('closing configuration before commit rolls back new receipt and key', async () => {
        const s = await setup();
        s.shared.beforeQuery = async sql => { if (sql.includes('pilot:insert')) s.setConfig({ profile: PROFILE, intake: false, review: false, publicRead: false }); };
        expect((await post(s)).status).toBe(503); expect(s.shared.tips).toHaveLength(0); expect(s.shared.keys).toHaveLength(0);
        expect(s.clients.at(-1).query.mock.calls.at(-1)[0]).toBe('ROLLBACK');
    });
    test('public read rechecks mutable flag after SQL and cannot send a newly closed card', async () => {
        const s = await setup(), r = await post(s); await approve(s, r.body.receipt.tipId);
        s.shared.beforeQuery = async sql => { if (sql.includes('pilot:cards')) s.setConfig({ profile: PROFILE, intake: true, review: true, publicRead: false }); };
        const read = await s.server.inject({ url: `${PREFIX}/cards` }); expect(read.status).toBe(503); expect(read.body).not.toHaveProperty('cards'); expect(s.shared.tips).toHaveLength(1);
    });
    test('independent flags do not expose approved cards when publicRead is off', async () => {
        const s = await setup(), r = await post(s); s.setConfig({ profile: PROFILE, intake: false, review: true, publicRead: false });
        expect((await approve(s, r.body.receipt.tipId)).body.publicVisible).toBe(false); expect((await s.server.inject({ url: `${PREFIX}/cards` })).status).toBe(503);
        s.setConfig({ profile: PROFILE, intake: false, review: false, publicRead: true }); expect((await s.server.inject({ url: `${PREFIX}/cards` })).body.cards).toHaveLength(1);
    });
    test('per-source rate=3 rejects fourth new case while original replay stays available', async () => {
        const s = await setup({ flags: { profile: PROFILE, intake: true, limits: { perSourceHour: 3 } } });
        for (let i = 1; i <= 3; i++) expect((await post(s, payload(`private_record_key_000${i}`), `request_key_0000000${i}`)).status).toBe(202);
        expect((await post(s, payload('private_record_key_0004'), 'request_key_00000004')).status).toBe(429);
        expect((await post(s)).status).toBe(202); expect(s.shared.tips).toHaveLength(3);
    });
    test.each(['maxPending','maxCases','maxRequests'])('bounded %s capacity rejects additional record', async limit => {
        const s = await setup({ flags: { profile: PROFILE, intake: true, limits: { [limit]: 1 } } }); await post(s);
        expect((await post(s, payload('private_record_key_0002'), 'request_key_00000002')).status).toBe(503); expect(s.shared.tips).toHaveLength(1);
    });
    test.each(['photos','point','url','unknown','wildlife','sensitive','unknown-region','v2','text-url'])('rejects forbidden %s profile without SQL', async kind => {
        const s = await setup(), p = payload();
        if (kind === 'photos') p.photos = [{}]; if (kind === 'point') p.location.latitude = 25;
        if (kind === 'url') p.source.url = 'https://provider.example.invalid/tips/one'; if (kind === 'unknown') p.extra = true;
        if (kind === 'wildlife') p.animal.kind = 'WILDLIFE'; if (kind === 'sensitive') p.location.sensitivity = 'NEST';
        if (kind === 'unknown-region') p.location.regionCode = null; if (kind === 'v2') { p.schemaVersion = 2; delete p.report; }
        if (kind === 'text-url') p.display.description = 'https://provider.example.invalid/tips/one';
        expect((await post(s, p)).status).toBeGreaterThanOrEqual(400); expect(s.pool.connect).not.toHaveBeenCalled();
    });
    test('source binding identity cannot be replaced by payload or access another source receipt', async () => {
        const s = await setup(), first = await post(s), id = first.body.receipt.tipId;
        s.bindings.sourcePolicies.push({ ...policy, publisherId: 'publisher-b', datasetId: 'dataset-b' }); s.setSource({ publisherId: 'publisher-b', datasetId: 'dataset-b' });
        expect((await post(s)).status).toBe(403); expect((await s.server.inject({ url: `${PREFIX}/receipts/${id}` })).status).toBe(404);
        s.setSource(null); expect((await post(s)).status).toBe(403);
    });
    test('review requires actual reviewer permission, checklist, separate display and original locale', async () => {
        const s = await setup(), r = await post(s), id = r.body.receipt.tipId;
        s.setReviewer({ reviewerId: 'reviewer', canReview: false }); expect((await approve(s, id)).status).toBe(403);
        s.setReviewer({ reviewerId: 'reviewer', canReview: true }); expect((await approve(s, id, { checks: {} })).status).toBe(403);
        expect((await approve(s, id, { display: undefined })).status).toBe(403);
        expect((await approve(s, id, { display: { locale: 'en-US', title: 'Reviewed', description: 'Coarse region only.' } })).status).toBe(403);
        expect((await approve(s, id, { display: { locale: 'zh-TW', title: '審核', description: '聯絡 @private_account' } })).status).toBe(403);
        expect(s.shared.tips[0].review).toBe('PENDING');
    });
    test('reject and withdraw cannot be approved again and never become cards', async () => {
        const s = await setup(), r = await post(s), id = r.body.receipt.tipId;
        expect((await s.server.inject({ method: 'POST', url: `${PREFIX}/review/${id}`, body: { decision: 'REJECT' } })).body.status).toBe('REJECTED');
        expect((await approve(s, id)).status).toBe(409); expect((await s.server.inject({ url: `${PREFIX}/cards` })).body.cards).toEqual([]);
    });
    test('duplicate review JSON keys cannot authorize publication', async () => {
        const s = await setup(), r = await post(s), id = r.body.receipt.tipId;
        const body = Buffer.from('{"decision":"REJECT","decision":"APPROVE","checks":{},"display":{}}');
        expect((await s.server.inject({ method: 'POST', url: `${PREFIX}/review/${id}`, body })).status).toBe(400); expect(s.shared.tips[0].review).toBe('PENDING');
    });
    test('DDL and transaction queries have real server timeouts; query errors rollback and never echo values', async () => {
        const s = await setup(); s.shared.fail = 'pilot:insert';
        const r = await post(s); expect(r).toEqual({ status: 503, body: { success: false, error: 'PILOT_STORE_UNAVAILABLE' } }); expect(s.shared.tips).toHaveLength(0);
        for (const client of s.clients) { const sql = client.query.mock.calls.map(([q]) => q); expect(sql[0]).toBe('BEGIN'); expect(sql[1]).toContain('SET LOCAL lock_timeout'); expect(sql[1]).toContain('SET LOCAL statement_timeout'); expect(client.release).toHaveBeenCalled(); }
        expect(s.clients.at(-1).query.mock.calls.at(-1)[0]).toBe('ROLLBACK');
    });
    test('failed rollback discards client instead of returning unknown transaction state to pool', async () => {
        const s = await setup(); s.shared.fail = 'pilot:insert'; s.shared.failRollback = true;
        expect((await post(s)).status).toBe(503);
        const error = s.clients.at(-1).release.mock.calls[0][0]; expect(error).toBeInstanceOf(Error); expect(error.message).toBe('PILOT_CONNECTION_DISCARDED');
    });
    test('artifact dependency closure has no fixture/rebuild/service/credential imports', () => {
        for (const file of ['pilot.cjs','store.cjs']) {
            const text = fs.readFileSync(path.resolve(__dirname, '../../../tools/stray-map-pilot', file), 'utf8');
            const imports = [...text.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
            expect(imports.every(p => p.startsWith('node:') || p === '../stray-map-intake/contract' || p === './store.cjs')).toBe(true);
            expect(text).not.toContain('process.env'); expect(text).not.toMatch(/\b(?:INSERT INTO|UPDATE|DELETE FROM) (?:animals|devices)\b/);
        }
    });
});
