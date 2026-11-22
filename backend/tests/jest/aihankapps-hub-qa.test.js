'use strict';
const express = require('express');
const supertest = require('./helpers/local-supertest');
const qa = require('../../aihankapps-hub-qa');
const { createRouters } = require('../../aihankapps-hub');
const input = { requestId: '11111111-2222-4333-8444-555555555555', item: '01', revision: 'r1984-01', decision: 'comment', body: '請保留原閱讀位置' };
function batch() { return { id: 'timehut-batch01', app: 'timehut', items: Array.from({ length: 10 }, (_, n) => { const id = String(n + 1).padStart(2, '0'), sha256 = 'a'.repeat(64); return { id, revision: 'r1984-' + id, sha256, bytes: 14, mediaKey: qa.mediaKey(id, sha256), title: id, before: 'Before', after: 'After', status: 'Approved; regression incomplete', releaseStatus: 'Pending integration' }; }) }; }
function pool() {
    const b = batch(), batches = [b], rows = [], results = [], calls = [];
    const p = { b, batches, rows, results, calls, connect: async () => ({ query: p.query, release: () => {} }), query: async (sql, v) => {
        calls.push({ sql, v });
        if (/^(CREATE|ALTER|BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory)/.test(sql)) return { rows: [] };
        if (sql.startsWith('SELECT payload')) return { rows: (v ? batches.filter(b => b.id === v[0]) : [...batches].sort((a, b) => Number(a.reviewState === 'archived') - Number(b.reviewState === 'archived'))).map(payload => ({ payload })) };
        if (sql.startsWith('SELECT id FROM aihankapps_hub_qa_batches')) return { rows: batches.filter(b => b.id !== v[0] && b.reviewState !== 'archived').map(b => ({ id: b.id })) };
        if (sql.includes('FROM aihankapps_hub_qa_comments WHERE request_id')) return { rows: rows.filter(r => r.request_id === v[0]) };
        if (sql.includes('INSERT INTO aihankapps_hub_qa_comments')) {
            const current = batches.find(b => b.id === v[1]);
            const i = current && current.items.find(x => x.id === v[2] && x.revision === v[3]);
            if (!i || current.reviewState === 'archived' || rows.some(r => r.request_id === v[0])) return { rows: [] };
            const r = { id: String(rows.length + 1), request_id: v[0], batch: v[1], item: v[2], revision: v[3], decision: v[4], body: v[5], created_at: new Date() }; rows.push(r); return { rows: [r] };
        }
        if (sql.includes('AND id>$2')) return { rows: rows.filter(r => (!v[0] || r.batch === v[0]) && BigInt(r.id) > BigInt(v[1])).slice(0, v[2]) };
        if (sql.startsWith('SELECT item FROM')) return { rows: rows.filter(r => r.id === v[0] && r.batch === v[1]).map(r => ({ item: r.item })) };
        if (sql.startsWith('SELECT item,comment_id')) return { rows: results.filter(r => r.result_key === v[0]) };
        if (sql.startsWith('INSERT INTO aihankapps_hub_qa_results')) {
            if (results.some(r => r.result_key === v[0])) return { rows: [] };
            const r = { id: String(results.length + 1), result_key: v[0], comment_id: v[1], item: v[2], body: v[3], batch: v[4] }; results.push(r); return { rows: [r] };
        }
        if (sql.includes('FROM aihankapps_hub_qa_results')) return { rows: results.filter(r => !v[0] || r.batch === v[0]) };
        if (sql.startsWith('INSERT INTO aihankapps_hub_qa_batches')) { const old = batches.findIndex(b => b.id === v[0]); if (old < 0) batches.push(JSON.parse(v[1])); else batches[old] = JSON.parse(v[1]); return { rows: [] }; }
        throw new Error('Unexpected SQL: ' + sql);
    } };
    return p;
}
test.each([null, {}, { ...input, item: '../' }, { ...input, requestId: 'bad' }, { ...input, decision: 'done' }, { ...input, body: ' ' }, { ...input, body: 'x'.repeat(4001) }, { ...input, revision: '<script>' }])('invalid comment is rejected before SQL: %p', async v => { const p = pool(); await expect(qa.comment(p, v)).rejects.toHaveProperty('code'); expect(p.calls).toHaveLength(0); });
test('append, retry idempotently, reject UUID reuse with different text, retain original', async () => {
    const p = pool(); const first = await qa.comment(p, input); expect(first.comment.id).toBe('1');
    expect((await qa.comment(p, input)).duplicate).toBe(true);
    await expect(qa.comment(p, { ...input, body: 'changed' })).rejects.toHaveProperty('code', 'QA_IDEMPOTENCY_CONFLICT');
    expect(p.rows).toHaveLength(1); expect(p.rows[0].body).toBe(input.body);
    expect(p.calls.find(c => c.sql.includes('INSERT INTO aihankapps_hub_qa_comments')).sql).toContain("i->>'revision'=$4");
});
test('stale or absent GIF cannot receive an approval', async () => {
    const p = pool(); await expect(qa.comment(p, { ...input, revision: 'old', decision: 'approve' })).rejects.toHaveProperty('code', 'QA_REVISION_CONFLICT');
    p.b.items = []; await expect(qa.comment(p, input)).rejects.toHaveProperty('code', 'QA_ITEM_MISSING'); expect(p.rows).toHaveLength(0);
});
test('read paginates comments and hides all private storage keys', async () => {
    const p = pool(); await qa.comment(p, input); const a = await qa.read(p, { limit: 1 });
    expect(a.comments).toHaveLength(1); expect(a.hasMore).toBe(true); expect(a.nextCursor).toBe('1');
    expect(JSON.stringify(a.batch)).not.toContain('mediaKey'); expect(p.b.items[0].mediaKey).toBeDefined();
    const b = await qa.read(p, { after: a.nextCursor }); expect(b.comments).toEqual([]); expect(b.hasMore).toBe(false);
    await expect(qa.read(p, { after: '1;DROP' })).rejects.toHaveProperty('code', 'QA_CURSOR');
});
test('operator publishes exactly ten bounded GIFs only after all originals verify', async () => {
    const p = pool(), verify = jest.fn(async () => {}); await qa.publish(p, batch(), { verify }); expect(verify).toHaveBeenCalledTimes(10);
    const q = pool(); await expect(qa.publish(q, batch(), { verify: async () => { throw new Error('media failure'); } })).rejects.toThrow('media failure'); expect(q.calls).toEqual([]);
    expect(() => qa.validateBatch({ ...batch(), items: [] })).toThrow('QA_BATCH');
    const b = batch(); b.items[0].mediaKey = 'files/another-owner/private.gif'; expect(() => qa.validateBatch(b)).toThrow('QA_BATCH_ITEM');
});
test('operator results append, tie to exact comment/item and cannot overwrite history', async () => {
    const p = pool(); await qa.comment(p, input); const v = { key: 'result-1', item: '01', commentId: '1', body: '已定位根因，實機驗證仍待。' };
    expect((await qa.result(p, v)).duplicate).toBe(false); expect((await qa.result(p, v)).duplicate).toBe(true);
    await expect(qa.result(p, { ...v, body: 'different' })).rejects.toHaveProperty('code', 'QA_RESULT_CONFLICT');
    await expect(qa.result(p, { ...v, key: 'bad-item', item: '02' })).rejects.toHaveProperty('code', 'QA_RESULT_COMMENT'); expect(p.results).toHaveLength(1);
});
async function app(p) {
    const a = express(), no = (req, res, next) => req.get('x-test-auth') === 'admin' ? next() : res.status(401).json({ success: false });
    const routers = createRouters({ authMiddleware: no, adminMiddleware: (req, res, next) => next(), getPool: () => p, getAuthPool: () => p, isReady: () => true });
    a.use('/api/aihankapps/hub', routers.api); a.use('/AiHankApps/hub', routers.page); return supertest(a);
}
test('real hub router protects reviews, scripts, GIFs and every mutation', async () => {
    const p = pool(), a = await app(p), base = '/api/aihankapps/hub/qa/timehut';
    for (const route of [base, base + '/media/01', '/AiHankApps/hub/hub-qa.js', '/AiHankApps/hub/hub-qa.css']) expect((await a.get(route)).status).toBe(401);
    for (const origin of ['', 'https://evil.example']) { const r = await a.post(base + '/comments').set('x-test-auth', 'admin').set('Origin', origin).send(input); expect(r.status).toBe(403); }
    expect((await a.post(base + '/comments').set('Origin', 'https://eclawbot.com').send(input)).status).toBe(401);
    expect((await a.get(base).set('x-test-auth', 'admin')).headers['cache-control']).toContain('private, no-store');
    expect((await a.post(base + '/comments').set('x-test-auth', 'admin').set('Origin', 'https://eclawbot.com').send(input)).status).toBe(200);
    expect((await a.post(base + '/comments').set('x-test-auth', 'admin').set('Origin', 'https://eclawbot.com').send({ ...input, revision: 'other' })).status).toBe(409);
    expect((await a.post(base + '/publish').set('x-test-auth', 'admin').set('Origin', 'https://eclawbot.com').send(batch())).status).toBe(405);
    expect((await a.delete(base + '/comments/1').set('x-test-auth', 'admin').set('Origin', 'https://eclawbot.com')).status).toBe(405);
});


test('diagnostic is admin-only in debug and 404 before DB access in production', async () => {
    const p = pool(), a = express(), auth = (req,res,next) => req.get('x-admin') ? next() : res.status(401).json({ success:false });
    qa.mountDebug(a, { auth, admin: auth, headers: (_req,_res,next) => next(), getPool: () => p });
    const before = process.env.NODE_ENV, railway = process.env.RAILWAY_ENVIRONMENT;
    try {
        process.env.NODE_ENV = 'production'; delete process.env.RAILWAY_ENVIRONMENT;
        expect((await (await supertest(a)).get('/api/debug/aihankapps-hub-qa').set('x-admin','1')).status).toBe(404); expect(p.calls).toHaveLength(0);
        process.env.RAILWAY_ENVIRONMENT = 'debug';
        expect((await (await supertest(a)).get('/api/debug/aihankapps-hub-qa')).status).toBe(401);
        expect((await (await supertest(a)).get('/api/debug/aihankapps-hub-qa').set('x-admin','1')).status).toBe(200);
    } finally { process.env.NODE_ENV = before; if (railway === undefined) delete process.env.RAILWAY_ENVIRONMENT; else process.env.RAILWAY_ENVIRONMENT = railway; }
});

describe('private R2 publication', () => {
    const { Readable } = require('stream');
    const bytes = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(8)]);
    const sha = require('crypto').createHash('sha256').update(bytes).digest('hex');
    let client, previous;
    beforeEach(() => {
        previous = { ...process.env };
        for (const key of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) process.env[key] = 'SYNTHETIC';
        client = { send: jest.fn(async () => ({ ContentType: 'image/gif', ContentLength: bytes.length, Body: Readable.from([bytes]) })), destroy: jest.fn() };
        jest.doMock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(() => client), PutObjectCommand: jest.fn(v => v), GetObjectCommand: jest.fn(v => v) }));
        jest.doMock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn(async () => 'https://synthetic.r2.cloudflarestorage.com/private-capability') }));
    });
    afterEach(() => { process.env = previous; jest.dontMock('@aws-sdk/client-s3'); jest.dontMock('@aws-sdk/s3-request-presigner'); });
    const ready = () => { const b = batch(); for (const i of b.items) { i.sha256 = sha; i.mediaKey = qa.mediaKey(i.id, sha); } return b; };
    test('upload capability is bounded; publication streams and verifies all ten original GIFs', async () => {
        const signed = await qa.prepareMedia({ item: '01', sha256: sha, size: bytes.length }); expect(signed.key).toContain(sha); expect(signed.url).toMatch(/^https:/);
        const p = pool(); p.b.items = ready().items;
        await qa.publish(p, ready()); expect(client.send).toHaveBeenCalledTimes(10); expect(client.destroy).toHaveBeenCalledTimes(11);
        await expect(qa.prepareMedia({ item: '01', sha256: sha, size: 100000000 })).rejects.toHaveProperty('code', 'QA_MEDIA_SIZE');
        delete process.env.R2_SECRET_ACCESS_KEY;
        await expect(qa.prepareMedia({ item: '01', sha256: sha, size: bytes.length })).rejects.toHaveProperty('code', 'QA_MEDIA_UNAVAILABLE');
    });
    test.each(['type', 'length', 'magic', 'digest'])('a mismatched cloud GIF blocks publication before DB writes: %s', async kind => {
        const data = kind === 'magic' ? Buffer.alloc(14) : kind === 'digest' ? Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(8, 1)]) : bytes;
        client.send.mockImplementation(async () => ({ ContentType: kind === 'type' ? 'text/html' : 'image/gif', ContentLength: kind === 'length' ? 15 : 14, Body: Readable.from([data]) }));
        const p = pool(); await expect(qa.publish(p, ready())).rejects.toHaveProperty('code'); expect(p.calls).toEqual([]); expect(client.destroy).toHaveBeenCalled();
    });
    test('administrator media is proxied as private GIF bytes, not a signed URL', async () => {
        const p = pool(); p.b.items = ready().items;
        const r = await (await app(p)).get('/api/aihankapps/hub/qa/timehut/media/01').set('x-test-auth', 'admin');
        expect(r.status).toBe(200); expect(r.headers['content-type']).toContain('image/gif'); expect(r.body).toEqual(bytes); expect(r.headers.location).toBeUndefined(); expect(r.headers['cache-control']).toContain('private, no-store');
    });
    test('upload, publication and proxy use the explicit batch; legacy media still fetches the archived original', async () => {
        const p = pool(); p.b.items = ready().items; p.b.reviewState = 'archived';
        const b = ready(); b.id = 'timehut-batch02';
        for (const i of b.items) i.mediaKey = qa.mediaKey(i.id, i.sha256, b.id);
        const signed = await qa.prepareMedia({ batch: b.id, item: '01', sha256: sha, size: bytes.length });
        expect(signed.key).toBe(qa.mediaKey('01', sha, b.id));
        await qa.publish(p, b);
        expect(client.send.mock.calls.slice(0, 10).every(([command]) => command.Key.includes('/timehut-batch02/'))).toBe(true);
        const a = await app(p), base = '/api/aihankapps/hub/qa/timehut/media/01';
        expect((await a.get(base + '?batch=' + b.id).set('x-test-auth', 'admin')).body).toEqual(bytes);
        expect(client.send.mock.calls.at(-1)[0].Key).toBe(b.items[0].mediaKey);
        expect((await a.get(base).set('x-test-auth', 'admin')).body).toEqual(bytes);
        expect(client.send.mock.calls.at(-1)[0].Key).toBe(p.b.items[0].mediaKey);
        expect((await a.get(base + '?batch=timehut-batch03').set('x-test-auth', 'admin')).status).toBe(404);
    });
});


test('archived batches reject stale open-page submissions without deleting history', async () => {
    const p = pool(); await qa.comment(p,input); p.b.reviewState='archived';
    expect((await qa.comment(p,input)).duplicate).toBe(true);
    const next={...input,requestId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'};
    await expect(qa.comment(p,next)).rejects.toHaveProperty('code','QA_BATCH_ARCHIVED');
    expect(p.rows).toHaveLength(1); expect((await qa.read(p)).batch.reviewState).toBe('archived');
    const r=await (await app(p)).post('/api/aihankapps/hub/qa/timehut/comments').set('x-test-auth','admin').set('Origin','https://eclawbot.com').send(next);
    expect(r.status).toBe(409); expect(r.body.error).toBe('QA_BATCH_ARCHIVED');
    expect(()=>qa.validateBatch({...batch(),reviewState:'deleted'})).toThrow('QA_BATCH_STATE');
});

function nextBatch(id = 'timehut-batch02') {
    const b = batch(); b.id = id;
    for (const i of b.items) i.mediaKey = qa.mediaKey(i.id, i.sha256, id);
    return b;
}
const verified = { verify: async () => {} };
test.each(['timehut-batch00', 'timehut-batch000000', 'timehut-batch1', 'timehut-batch1234567', '../timehut-batch02', '', null, [], 2])('invalid batch identity fails before database or storage access: %p', async id => {
    const p = pool();
    await expect(qa.comment(p, { ...input, batch: id })).rejects.toHaveProperty('code', 'QA_BATCH_INVALID');
    await expect(qa.read(p, { batch: id })).rejects.toHaveProperty('code', 'QA_BATCH_INVALID');
    await expect(qa.prepareMedia({ item: '01', sha256: 'a'.repeat(64), size: 14, batch: id })).rejects.toHaveProperty('code', 'QA_BATCH_INVALID');
    expect(p.calls).toHaveLength(0);
});
test('new active review preserves the archived original ten items, comments and twenty results', async () => {
    const p = pool(); await qa.comment(p, input);
    for (let n = 0; n < 20; n++) await qa.result(p, { key: 'original-' + n, item: String(n % 10 + 1).padStart(2, '0'), body: 'Synthetic original result ' + n });
    p.b.reviewState = 'archived';
    const original = JSON.stringify({ b: p.b, comments: p.rows, results: p.results });
    const verify = jest.fn(async () => {}), b = nextBatch();
    expect((await qa.publish(p, b, { verify })).published).toBe(b.id);
    expect(verify).toHaveBeenCalledWith(b.items[0], b.id);
    const read = await qa.read(p);
    expect(read.activeBatchId).toBe(b.id); expect(read.batch.id).toBe(b.id);
    expect(read.batches.map(b => b.id)).toEqual([b.id, p.b.id]);
    expect(JSON.stringify(read.batches)).not.toContain('mediaKey');
    expect(JSON.stringify({ b: p.b, comments: p.rows, results: p.results })).toBe(original);
    const old = await qa.read(p, { batch: p.b.id });
    expect(old.batch.id).toBe(p.b.id); expect(old.results).toHaveLength(20); expect(old.comments).toHaveLength(1);
    const current = await qa.read(p, { batch: b.id });
    expect(current.results).toEqual([]); expect(current.comments).toEqual([]);
});
test('only one active batch; frozen archived reviews allow ongoing coverage progress and retry safely', async () => {
    const p = pool();
    await expect(qa.publish(p, nextBatch(), verified)).rejects.toHaveProperty('code', 'QA_ACTIVE_BATCH_CONFLICT');
    const changed = { ...batch(), reviewState: 'archived' }; changed.items[0].title = 'Replacement';
    await expect(qa.publish(p, changed, verified)).rejects.toHaveProperty('code', 'QA_ARCHIVE_CONFLICT');
    const archived = { ...batch(), reviewState: 'archived', phaseSummary: 'Synthetic next phase' };
    await qa.publish(p, archived, verified); await qa.publish(p, nextBatch(), verified);
    p.calls.length = 0;
    expect((await qa.publish(p, archived, verified)).duplicate).toBe(true);
    expect(p.calls.some(c => c.sql.startsWith('INSERT'))).toBe(false);
    const progress = { ...archived, phaseSummary: 'Further automated E2E', updatedAt: '2026-11-23T02:00:00Z', coverage: { C1: { android: { passed: 14, denominator: 604, percent: 14 / 604 * 100 } } }, coverageNote: 'Synthetic progress only' };
    expect((await qa.publish(p, progress, verified)).progressOnly).toBe(true);
    expect((await qa.read(p, { batch: archived.id })).batch.coverage).toEqual(progress.coverage);
    expect((await qa.read(p)).activeBatchId).toBe('timehut-batch02');
    const replaced = structuredClone(progress); replaced.items[0].before = 'Different proposed behavior';
    await expect(qa.publish(p, replaced, verified)).rejects.toHaveProperty('code', 'QA_BATCH_ARCHIVED');
    await expect(qa.comment(p, { ...input, requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })).rejects.toHaveProperty('code', 'QA_BATCH_ARCHIVED');
    await expect(qa.publish(p, batch(), verified)).rejects.toHaveProperty('code', 'QA_BATCH_ARCHIVED');
});
test('identical item/revision labels cannot redirect stale legacy forms or UUID retries to batch02', async () => {
    const p = pool(); await qa.comment(p, input); p.b.reviewState = 'archived';
    await qa.publish(p, nextBatch(), verified);
    await expect(qa.comment(p, { ...input, batch: 'timehut-batch02' })).rejects.toHaveProperty('code', 'QA_IDEMPOTENCY_CONFLICT');
    expect((await qa.comment(p, input)).duplicate).toBe(true);
    const fresh = { ...input, requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
    await expect(qa.comment(p, fresh)).rejects.toHaveProperty('code', 'QA_BATCH_ARCHIVED');
    expect((await qa.comment(p, { ...fresh, batch: 'timehut-batch02' })).comment.batch).toBe('timehut-batch02');
    expect(p.rows.map(r => r.batch)).toEqual(['timehut-batch01', 'timehut-batch02']);
});
test('result idempotency and exact comment references are bound to the batch', async () => {
    const p = pool(); await qa.comment(p, input); p.b.reviewState = 'archived'; await qa.publish(p, nextBatch(), verified);
    const original = { key: 'original-response', item: '01', body: 'Synthetic response' };
    await qa.result(p, original);
    await expect(qa.result(p, { ...original, batch: 'timehut-batch02' })).rejects.toHaveProperty('code', 'QA_RESULT_CONFLICT');
    await expect(qa.result(p, { ...original, key: 'cross-reference', batch: 'timehut-batch02', commentId: '1' })).rejects.toHaveProperty('code', 'QA_RESULT_COMMENT');
    await expect(qa.result(p, { ...original, key: 'missing-batch', batch: 'timehut-batch03' })).rejects.toHaveProperty('code', 'QA_ITEM_MISSING');
    await qa.result(p, { ...original, key: 'current-response', batch: 'timehut-batch02' });
    expect((await qa.read(p, { batch: 'timehut-batch01' })).results.map(r => r.result_key)).toEqual(['original-response']);
    expect((await qa.read(p, { batch: 'timehut-batch02' })).results.map(r => r.result_key)).toEqual(['current-response']);
});
test('active media replacement requires a new revision and makes old forms stale', async () => {
    const p = pool(); await qa.comment(p, input);
    const changed = batch(), original = JSON.stringify(p.b);
    changed.items[0].sha256 = 'b'.repeat(64); changed.items[0].mediaKey = qa.mediaKey('01', changed.items[0].sha256);
    await expect(qa.publish(p, changed, verified)).rejects.toHaveProperty('code', 'QA_REVISION_CONFLICT');
    expect(JSON.stringify(p.b)).toBe(original);
    expect(p.calls.some(c => c.sql.startsWith('INSERT INTO aihankapps_hub_qa_batches'))).toBe(false);
    changed.items[0].revision = 'new-media-revision'; await qa.publish(p, changed, verified);
    await expect(qa.comment(p, { ...input, requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', decision: 'approve' })).rejects.toHaveProperty('code', 'QA_REVISION_CONFLICT');
    expect((await qa.read(p)).comments[0].revision).toBe(input.revision);
});
test('global pagination includes late historical replies after newer-batch comments', async () => {
    const p = pool(); p.b.reviewState = 'archived'; await qa.publish(p, nextBatch(), verified);
    for (let n = 1; n <= 502; n++) p.rows.push({ id: String(n), batch: n === 502 ? 'timehut-batch01' : 'timehut-batch02', item: '01' });
    const first = await qa.read(p), second = await qa.read(p, { after: first.nextCursor });
    expect(first.comments).toHaveLength(500); expect(first.hasMore).toBe(true);
    expect(second.comments.map(c => c.id)).toEqual(['501', '502']);
    expect(second.comments[1].batch).toBe('timehut-batch01'); expect(second.hasMore).toBe(false);
});
test('malformed HTTP batch selectors are rejected and protected just like legacy routes', async () => {
    const p = pool(), a = await app(p), base = '/api/aihankapps/hub/qa/timehut';
    for (const suffix of ['?batch=../bad', '?batch[]=timehut-batch02', '/media/01?batch=../bad']) {
        expect((await a.get(base + suffix)).status).toBe(401);
        const response = await a.get(base + suffix).set('x-test-auth', 'admin');
        expect(response.status).toBe(400); expect(response.headers['cache-control']).toContain('private, no-store');
    }
    expect(p.calls).toEqual([]);
});

describe('operator-only Timehut alert reply history', () => {
    test.each([{ after: '../bad' }, { after: 12 }, { after: 'human-timehut-qa-review-' + 'x'.repeat(200) }, { limit: 0 }, { limit: 501 }, { limit: '5' }])('rejects invalid bounded cursors before SQL: %p', async options => {
        const p = { query: jest.fn() };
        await expect(qa.alertReplies(p, options)).rejects.toHaveProperty('code', 'QA_ALERT_CURSOR'); expect(p.query).not.toHaveBeenCalled();
    });
    test('missing Hub confirmation table is an empty read, never a schema write', async () => {
        const p = { query: jest.fn(async () => ({ rows: [{ acks: null, notes: null }] })) };
        expect(await qa.alertReplies(p)).toEqual({ success: true, acks: [], nextCursor: '', hasMore: false }); expect(p.query).toHaveBeenCalledTimes(1);
    });
    test.each([true, false])('reads old plans without age cutoff and retains safe triage metadata when notes exist: %s', async notes => {
        const ref = 'human-timehut-qa-review-batch01';
        const p = { query: jest.fn().mockResolvedValueOnce({ rows: [{ acks: 'exists', notes: notes ? 'exists' : null }] }).mockResolvedValueOnce({ rows: [{ ref, title: 'Synthetic alert', plan: 'New late reply', acked_at: '2020-01-01', plan_at: '2026-11-23', ...(notes ? { state: 'done', note: 'Synthetic response', note_at: '2026-11-24' } : {}) }] }) };
        const answer = await qa.alertReplies(p, { after: '', limit: 1 });
        expect(answer).toMatchObject({ success: true, hasMore: true, nextCursor: ref, acks: [{ id: ref, plan: 'New late reply', answered: notes }] });
        expect(answer.acks[0].triage).toEqual(notes ? { state: 'done', note: 'Synthetic response', at: new Date('2026-11-24').getTime() } : null);
        expect(p.query.mock.calls.every(([sql]) => sql.trim().startsWith('SELECT'))).toBe(true);
        const [sql, params] = p.query.mock.calls[1];
        expect(sql).toContain("a.ref LIKE 'human-timehut-qa-review-%'"); expect(sql).not.toContain('acked_at >='); expect(params).toEqual(['', 1]);
    });
});
