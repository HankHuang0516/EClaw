'use strict';
// Private QA review records. Only an operator may publish snapshots/results/media;
// the existing administrator session may append feedback, never replace history.
const crypto = require('crypto');
const APP = 'timehut', BATCH = 'timehut-batch01';
const ITEM = /^(0[1-9]|10)$/;
const REV = /^[a-zA-Z0-9._-]{1,80}$/;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const prepared = new WeakMap();
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function prepare(pool) {
    if (!prepared.has(pool)) prepared.set(pool, (async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS aihankapps_hub_qa_batches (id TEXT PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await pool.query(`CREATE TABLE IF NOT EXISTS aihankapps_hub_qa_comments (id BIGSERIAL PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, batch TEXT NOT NULL, item TEXT NOT NULL, revision TEXT NOT NULL, decision TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await pool.query(`CREATE TABLE IF NOT EXISTS aihankapps_hub_qa_results (id BIGSERIAL PRIMARY KEY, result_key TEXT NOT NULL UNIQUE, comment_id BIGINT REFERENCES aihankapps_hub_qa_comments(id), item TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    })().catch(e => { prepared.delete(pool); throw e; }));
    return prepared.get(pool);
}
function validateComment(v) {
    if (!v || typeof v.requestId !== 'string' || typeof v.item !== 'string' || typeof v.revision !== 'string' || !UUID.test(v.requestId || '') || !ITEM.test(v.item || '') || !REV.test(v.revision || '') || !['comment', 'changes', 'approve'].includes(v.decision)) fail('QA_COMMENT_INVALID');
    if (typeof v.body !== 'string' || !v.body.trim() || v.body.length > 4000) fail('QA_COMMENT_TEXT');
    return { requestId: v.requestId, item: v.item, revision: v.revision, decision: v.decision, body: v.body.trim() };
}
async function snapshot(pool) {
    await prepare(pool);
    const r = await pool.query('SELECT payload, updated_at FROM aihankapps_hub_qa_batches WHERE id=$1', [BATCH]);
    return r.rows[0] ? r.rows[0].payload : null;
}
async function read(pool, { after = '0', limit = 500 } = {}) {
    if (!/^\d{1,18}$/.test(String(after)) || !Number.isInteger(limit) || limit < 1 || limit > 500) fail('QA_CURSOR');
    const batch = await snapshot(pool);
    const comments = await pool.query('SELECT id::text, request_id, item, revision, decision, body, created_at FROM aihankapps_hub_qa_comments WHERE batch=$1 AND id>$2::bigint ORDER BY id LIMIT $3', [BATCH, String(after), limit]);
    const results = await pool.query('SELECT id::text, result_key, comment_id::text, item, body, created_at FROM aihankapps_hub_qa_results ORDER BY id');
    // Never expose storage keys/capability URLs in the browser's JSON.
    const visible = batch ? JSON.parse(JSON.stringify(batch)) : null;
    if (visible) visible.items.forEach(i => { delete i.mediaKey; });
    return { success: true, batch: visible, comments: comments.rows, results: results.rows, nextCursor: comments.rows.length ? comments.rows[comments.rows.length - 1].id : String(after), hasMore: comments.rows.length === limit };
}
function sameComment(row, v) { return row.item === v.item && row.revision === v.revision && row.decision === v.decision && row.body === v.body; }
async function comment(pool, input) {
    const v = validateComment(input);
    await prepare(pool);
    const previous = await pool.query('SELECT id::text, item, revision, decision, body, created_at FROM aihankapps_hub_qa_comments WHERE request_id=$1', [v.requestId]);
    if (previous.rows[0]) {
        if (!sameComment(previous.rows[0], v)) fail('QA_IDEMPOTENCY_CONFLICT');
        return { success: true, comment: previous.rows[0], duplicate: true };
    }
    const b = await snapshot(pool), i = b && b.items.find(x => x.id === v.item);
    if (!i) fail('QA_ITEM_MISSING');
    if (b.reviewState === 'archived') fail('QA_BATCH_ARCHIVED');
    if (i.revision !== v.revision) fail('QA_REVISION_CONFLICT');
    // Bind the comment to the CURRENT snapshot in one SQL statement, including
    // a concurrent operator revision. A stale approval cannot approve new GIFs.
    const r = await pool.query(`INSERT INTO aihankapps_hub_qa_comments (request_id,batch,item,revision,decision,body)
        SELECT $1,$2,$3,$4,$5,$6 FROM aihankapps_hub_qa_batches b
        WHERE b.id=$2 AND COALESCE(b.payload->>'reviewState','active') <> 'archived' AND EXISTS (SELECT 1 FROM jsonb_array_elements(b.payload->'items') i WHERE i->>'id'=$3 AND i->>'revision'=$4)
        ON CONFLICT(request_id) DO NOTHING RETURNING id::text,item,revision,decision,body,created_at`, [v.requestId, BATCH, v.item, v.revision, v.decision, v.body]);
    if (!r.rows[0]) {
        const concurrent = await pool.query('SELECT id::text,item,revision,decision,body,created_at FROM aihankapps_hub_qa_comments WHERE request_id=$1', [v.requestId]);
        if (concurrent.rows[0] && sameComment(concurrent.rows[0], v)) return { success: true, comment: concurrent.rows[0], duplicate: true };
        fail(concurrent.rows[0] ? 'QA_IDEMPOTENCY_CONFLICT' : 'QA_REVISION_CONFLICT');
    }
    return { success: true, comment: r.rows[0], duplicate: false };
}
function mediaKey(item, sha) {
    if (!ITEM.test(item) || !SHA.test(sha)) fail('QA_MEDIA_INVALID');
    return `aihankapps-hub/qa/${APP}/${BATCH}/${item}-${sha}.gif`;
}
function storage() {
    const { S3Client } = require('@aws-sdk/client-s3');
    if (!['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].every(k => process.env[k])) fail('QA_MEDIA_UNAVAILABLE');
    return { client: new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } }), bucket: process.env.R2_BUCKET_NAME || 'eclaw-files' };
}
async function prepareMedia(v) {
    const key = mediaKey(v.item, v.sha256);
    if (!Number.isInteger(v.size) || v.size < 14 || v.size > 20 * 1024 * 1024) fail('QA_MEDIA_SIZE');
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const { client, bucket } = storage();
    try { return { key, url: await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: 'image/gif', ContentLength: v.size, Metadata: { sha256: v.sha256 } }), { expiresIn: 600 }) }; } finally { client.destroy(); }
}
async function verifyMedia(item) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { client, bucket } = storage();
    try {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: mediaKey(item.id, item.sha256) }));
        if (r.ContentType !== 'image/gif' || r.ContentLength !== item.bytes) fail('QA_MEDIA_METADATA');
        const hash = crypto.createHash('sha256'); let n = 0, magic = Buffer.alloc(0);
        for await (const chunk of r.Body) { n += chunk.length; if (n > 20 * 1024 * 1024) fail('QA_MEDIA_SIZE'); hash.update(chunk); if (magic.length < 6) magic = Buffer.concat([magic, chunk]).subarray(0, 6); }
        if (n !== item.bytes || !/^GIF8[79]a$/.test(magic.toString('ascii')) || hash.digest('hex') !== item.sha256) fail('QA_MEDIA_CONTENT');
    } finally { client.destroy(); }
}
function validateBatch(b) {
    if (b && b.reviewState !== undefined && !['active','archived'].includes(b.reviewState)) fail('QA_BATCH_STATE');
    if (b && b.phaseSummary !== undefined && (typeof b.phaseSummary !== 'string' || b.phaseSummary.length > 3000)) fail('QA_BATCH_TEXT');
    if (!b || b.id !== BATCH || b.app !== APP || !Array.isArray(b.items) || b.items.length !== 10 || new Set(b.items.map(i => i.id)).size !== 10) fail('QA_BATCH');
    for (const i of b.items) {
        if (!ITEM.test(i.id) || !REV.test(i.revision) || !SHA.test(i.sha256) || i.mediaKey !== mediaKey(i.id, i.sha256) || !Number.isInteger(i.bytes) || i.bytes < 14 || i.bytes > 20 * 1024 * 1024) fail('QA_BATCH_ITEM');
        for (const k of ['title', 'before', 'after', 'status', 'releaseStatus']) if (typeof i[k] !== 'string' || !i[k] || i[k].length > 2000) fail('QA_BATCH_TEXT');
    }
    if (Buffer.byteLength(JSON.stringify(b)) > 100000) fail('QA_BATCH_SIZE');
    return b;
}
async function publish(pool, input, { verify = verifyMedia } = {}) {
    const b = validateBatch(input);
    for (const i of b.items) await verify(i);
    await prepare(pool);
    await pool.query('INSERT INTO aihankapps_hub_qa_batches(id,payload) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=NOW()', [BATCH, JSON.stringify(b)]);
    return { success: true, published: BATCH, items: 10 };
}
async function result(pool, v) {
    if (!v || !REV.test(v.key || '') || !ITEM.test(v.item || '') || (v.commentId != null && !/^\d{1,18}$/.test(String(v.commentId))) || typeof v.body !== 'string' || !v.body.trim() || v.body.length > 6000) fail('QA_RESULT');
    await prepare(pool);
    if (v.commentId != null) {
        const c = await pool.query('SELECT item FROM aihankapps_hub_qa_comments WHERE id=$1 AND batch=$2', [String(v.commentId), BATCH]);
        if (!c.rows[0] || c.rows[0].item !== v.item) fail('QA_RESULT_COMMENT');
    }
    const r = await pool.query('INSERT INTO aihankapps_hub_qa_results(result_key,comment_id,item,body) VALUES($1,$2,$3,$4) ON CONFLICT(result_key) DO NOTHING RETURNING id::text', [v.key, v.commentId || null, v.item, v.body.trim()]);
    if (!r.rows[0]) {
        const old = await pool.query('SELECT item,comment_id::text,body FROM aihankapps_hub_qa_results WHERE result_key=$1', [v.key]);
        const row = old.rows[0];
        if (!row || row.item !== v.item || row.comment_id !== (v.commentId == null ? null : String(v.commentId)) || row.body !== v.body.trim()) fail('QA_RESULT_CONFLICT');
    }
    return { success: true, duplicate: !r.rows.length };
}
function mount(api, { getPool, limited }) {
    const express = require('express');
    const error = (res, e) => {
        const code = /^QA_[A-Z_]+$/.test(e.code || '') ? e.code : 'QA_UNAVAILABLE';
        return res.status(code.includes('CONFLICT') || code === 'QA_BATCH_ARCHIVED' ? 409 : code === 'QA_ITEM_MISSING' ? 404 : code === 'QA_UNAVAILABLE' || code === 'QA_MEDIA_UNAVAILABLE' ? 503 : 400).json({ success: false, error: code });
    };
    api.get('/qa/timehut', async (req, res) => { try { res.json(await read(getPool(), { after: req.query.after || '0' })); } catch (e) { error(res, e); } });
    api.post('/qa/timehut/comments', express.json({ limit: '20kb' }), async (req, res) => {
        if (limited(req)) return res.status(429).set('Retry-After', '60').json({ success: false, error: 'QA_RATE_LIMIT' });
        try { res.json(await comment(getPool(), req.body)); } catch (e) { error(res, e); }
    });
    api.get('/qa/timehut/media/:item', async (req, res) => {
        let client;
        try {
            if (!ITEM.test(req.params.item)) fail('QA_ITEM_MISSING');
            const b = await snapshot(getPool()), i = b && b.items.find(x => x.id === req.params.item);
            if (!i) fail('QA_ITEM_MISSING');
            const { GetObjectCommand } = require('@aws-sdk/client-s3'), s = storage(); client = s.client;
            const object = await client.send(new GetObjectCommand({ Bucket: s.bucket, Key: mediaKey(i.id, i.sha256) }));
            res.type('image/gif').set('Content-Length', String(object.ContentLength));
            object.Body.on('error', () => res.destroy());
            res.on('close', () => { object.Body.destroy(); client.destroy(); });
            object.Body.pipe(res);
        } catch (e) { if (client) client.destroy(); if (!res.headersSent) error(res, e); else res.destroy(); }
    });
}
function mountDebug(app, { auth, admin, headers, getPool }) {
    app.get('/api/debug/aihankapps-hub-qa', headers, (req, res, next) => {
        if (process.env.NODE_ENV === 'production' && process.env.RAILWAY_ENVIRONMENT !== 'debug') return res.status(404).json({ success: false, error: 'Not found' });
        next();
    }, auth, admin, async (_req, res) => {
        try { res.json(await read(getPool())); } catch (_e) { res.status(503).json({ success: false, error: 'QA_UNAVAILABLE' }); }
    });
}
module.exports = { prepare, read, comment, publish, result, prepareMedia, mediaKey, validateBatch, validateComment, mount, mountDebug };
