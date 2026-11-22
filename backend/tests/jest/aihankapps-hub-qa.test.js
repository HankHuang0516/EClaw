'use strict';
const express = require('express');
const supertest = require('supertest');
const qa = require('../../aihankapps-hub-qa');
const { createRouters } = require('../../aihankapps-hub');
const input = { requestId: '11111111-2222-4333-8444-555555555555', item: '01', revision: 'r1984-01', decision: 'comment', body: '請保留原閱讀位置' };
function batch() { return { id: 'timehut-batch01', app: 'timehut', items: Array.from({ length: 10 }, (_, n) => { const id = String(n + 1).padStart(2, '0'), sha256 = 'a'.repeat(64); return { id, revision: 'r1984-' + id, sha256, bytes: 14, mediaKey: qa.mediaKey(id, sha256), title: id, before: 'Before', after: 'After', status: 'Approved; regression incomplete', releaseStatus: 'Pending integration' }; }) }; }
function pool() {
    const b = batch(), rows = [], results = [], calls = [];
    return { b, rows, results, calls, query: async (sql, v) => {
        calls.push({ sql, v });
        if (sql.startsWith('CREATE')) return { rows: [] };
        if (sql.startsWith('SELECT payload')) return { rows: [{ payload: b }] };
        if (sql.includes('FROM aihankapps_hub_qa_comments WHERE request_id')) return { rows: rows.filter(r => r.request_id === v[0]) };
        if (sql.includes('INSERT INTO aihankapps_hub_qa_comments')) {
            const i = b.items.find(x => x.id === v[2] && x.revision === v[3]);
            if (!i || b.reviewState === 'archived' || rows.some(r => r.request_id === v[0])) return { rows: [] };
            const r = { id: String(rows.length + 1), request_id: v[0], item: v[2], revision: v[3], decision: v[4], body: v[5], created_at: new Date() }; rows.push(r); return { rows: [r] };
        }
        if (sql.includes('WHERE batch=$1 AND id>')) return { rows: rows.filter(r => BigInt(r.id) > BigInt(v[1])).slice(0, v[2]) };
        if (sql.startsWith('SELECT item FROM')) return { rows: rows.filter(r => r.id === v[0]).map(r => ({ item: r.item })) };
        if (sql.startsWith('SELECT item,comment_id')) return { rows: results.filter(r => r.result_key === v[0]) };
        if (sql.startsWith('INSERT INTO aihankapps_hub_qa_results')) {
            if (results.some(r => r.result_key === v[0])) return { rows: [] };
            const r = { id: String(results.length + 1), result_key: v[0], comment_id: v[1], item: v[2], body: v[3] }; results.push(r); return { rows: [r] };
        }
        if (sql.includes('FROM aihankapps_hub_qa_results')) return { rows: results };
        if (sql.startsWith('INSERT INTO aihankapps_hub_qa_batches')) return { rows: [] };
        throw new Error('Unexpected SQL: ' + sql);
    } };
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
function app(p) {
    const a = express(), no = (req, res, next) => req.get('x-test-auth') === 'admin' ? next() : res.status(401).json({ success: false });
    const routers = createRouters({ authMiddleware: no, adminMiddleware: (req, res, next) => next(), getPool: () => p, getAuthPool: () => p, isReady: () => true });
    a.use('/api/aihankapps/hub', routers.api); a.use('/AiHankApps/hub', routers.page); return supertest(a);
}
test('real hub router protects reviews, scripts, GIFs and every mutation', async () => {
    const p = pool(), a = app(p), base = '/api/aihankapps/hub/qa/timehut';
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
        expect((await supertest(a).get('/api/debug/aihankapps-hub-qa').set('x-admin','1')).status).toBe(404); expect(p.calls).toHaveLength(0);
        process.env.RAILWAY_ENVIRONMENT = 'debug';
        expect((await supertest(a).get('/api/debug/aihankapps-hub-qa')).status).toBe(401);
        expect((await supertest(a).get('/api/debug/aihankapps-hub-qa').set('x-admin','1')).status).toBe(200);
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
        await qa.publish(pool(), ready()); expect(client.send).toHaveBeenCalledTimes(10); expect(client.destroy).toHaveBeenCalledTimes(11);
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
        const r = await app(p).get('/api/aihankapps/hub/qa/timehut/media/01').set('x-test-auth', 'admin');
        expect(r.status).toBe(200); expect(r.headers['content-type']).toContain('image/gif'); expect(r.body).toEqual(bytes); expect(r.headers.location).toBeUndefined(); expect(r.headers['cache-control']).toContain('private, no-store');
    });
});


test('archived batches reject stale open-page submissions without deleting history', async () => {
    const p = pool(); await qa.comment(p,input); p.b.reviewState='archived';
    expect((await qa.comment(p,input)).duplicate).toBe(true);
    const next={...input,requestId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'};
    await expect(qa.comment(p,next)).rejects.toHaveProperty('code','QA_BATCH_ARCHIVED');
    expect(p.rows).toHaveLength(1); expect((await qa.read(p)).batch.reviewState).toBe('archived');
    const r=await app(p).post('/api/aihankapps/hub/qa/timehut/comments').set('x-test-auth','admin').set('Origin','https://eclawbot.com').send(next);
    expect(r.status).toBe(409); expect(r.body.error).toBe('QA_BATCH_ARCHIVED');
    expect(()=>qa.validateBatch({...batch(),reviewState:'deleted'})).toThrow('QA_BATCH_STATE');
});
