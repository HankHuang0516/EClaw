'use strict';
// Private QA review records. Only an operator may publish snapshots/results/media;
// the existing administrator session may append feedback, never replace history.
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const APP = 'timehut', BATCH = 'timehut-batch01';
const BATCH_ID = /^timehut-batch[0-9]{2,6}$/;
const ITEM = /^(0[1-9]|10)$/;
const REV = /^[a-zA-Z0-9._-]{1,80}$/;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const prepared = new WeakMap();
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function batchId(value = BATCH) {
    if (typeof value !== 'string' || !BATCH_ID.test(value) || Number(value.slice(13)) < 1) fail('QA_BATCH_INVALID');
    return value;
}
// Publication and feedback share one transaction lock, including across operator
// processes. A form cannot slip into an archived snapshot during publication.
async function locked(pool, work) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(20261123, 1)');
        const answer = await work(client);
        await client.query('COMMIT');
        return answer;
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
}
function prepare(pool) {
    if (!prepared.has(pool)) prepared.set(pool, locked(pool, async client => {
        await client.query(`CREATE TABLE IF NOT EXISTS aihankapps_hub_qa_batches (id TEXT PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await client.query(`CREATE TABLE IF NOT EXISTS aihankapps_hub_qa_comments (id BIGSERIAL PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, batch TEXT NOT NULL, item TEXT NOT NULL, revision TEXT NOT NULL, decision TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await client.query(`CREATE TABLE IF NOT EXISTS aihankapps_hub_qa_results (id BIGSERIAL PRIMARY KEY, result_key TEXT NOT NULL UNIQUE, comment_id BIGINT REFERENCES aihankapps_hub_qa_comments(id), item TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        // Existing IDs, keys, bodies and foreign keys stay intact. The default
        // also supports an old operator binary during the deployment window.
        await client.query(`ALTER TABLE aihankapps_hub_qa_results ADD COLUMN IF NOT EXISTS batch TEXT NOT NULL DEFAULT 'timehut-batch01'`);
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS aihankapps_hub_qa_one_active ON aihankapps_hub_qa_batches ((1)) WHERE COALESCE(payload->>'reviewState','active') = 'active'`);
    }).catch(e => { prepared.delete(pool); throw e; }));
    return prepared.get(pool);
}
function validateComment(v) {
    if (!v || typeof v.requestId !== 'string' || typeof v.item !== 'string' || typeof v.revision !== 'string' || !UUID.test(v.requestId || '') || !ITEM.test(v.item || '') || !REV.test(v.revision || '') || !['comment', 'changes', 'approve'].includes(v.decision)) fail('QA_COMMENT_INVALID');
    if (typeof v.body !== 'string' || !v.body.trim() || v.body.length > 4000) fail('QA_COMMENT_TEXT');
    return { batch: batchId(v.batch), requestId: v.requestId, item: v.item, revision: v.revision, decision: v.decision, body: v.body.trim() };
}
async function snapshot(pool, id = BATCH) {
    const r = await pool.query('SELECT payload, updated_at FROM aihankapps_hub_qa_batches WHERE id=$1', [id]);
    return r.rows[0] ? r.rows[0].payload : null;
}
async function read(pool, { after = '0', limit = 500, batch: selected } = {}) {
    if (!/^\d{1,18}$/.test(String(after)) || !Number.isInteger(limit) || limit < 1 || limit > 500) fail('QA_CURSOR');
    if (selected !== undefined) batchId(selected);
    await prepare(pool);
    const snapshots = await pool.query(`SELECT payload, updated_at FROM aihankapps_hub_qa_batches ORDER BY (COALESCE(payload->>'reviewState','active') = 'active') DESC, updated_at DESC, id DESC`);
    const active = snapshots.rows.find(r => r.payload.reviewState !== 'archived');
    const batch = selected === undefined ? (active || snapshots.rows[0]) : snapshots.rows.find(r => r.payload.id === selected);
    // The default cursor is GLOBAL: a late reply on an older batch must never
    // disappear when the active review changes. Explicit batch reads are scoped.
    const comments = await pool.query('SELECT id::text, request_id, batch, item, revision, decision, body, created_at FROM aihankapps_hub_qa_comments WHERE ($1::text IS NULL OR batch=$1) AND id>$2::bigint ORDER BY id LIMIT $3', [selected || null, String(after), limit]);
    const results = await pool.query('SELECT id::text, result_key, batch, comment_id::text, item, body, created_at FROM aihankapps_hub_qa_results WHERE ($1::text IS NULL OR batch=$1) ORDER BY id', [selected || null]);
    // Never expose storage keys/capability URLs in the browser's JSON.
    const visible = row => {
        const value = JSON.parse(JSON.stringify(row.payload));
        value.items.forEach(i => { delete i.mediaKey; });
        return value;
    };
    return { success: true, batch: batch ? visible(batch) : null, batches: snapshots.rows.map(visible), activeBatchId: active ? active.payload.id : null, comments: comments.rows, results: results.rows, nextCursor: comments.rows.length ? comments.rows[comments.rows.length - 1].id : String(after), hasMore: comments.rows.length === limit };
}
// Operator-only supplement to the general Hub alert snapshot. That snapshot's
// recent-confirmation window uses the FIRST acknowledgement time, so it misses
// a new plan on an older cleared warning. Page this small family without an age
// cutoff; signatures in qa.js decide whether the response still needs handling.
async function alertReplies(pool, { after = '', limit = 500 } = {}) {
    if (typeof after !== 'string' || (after !== '' && (!/^human-timehut-qa-review-[A-Za-z0-9._@:-]+$/.test(after) || after.length > 200)) || !Number.isInteger(limit) || limit < 1 || limit > 500) fail('QA_ALERT_CURSOR');
    const exists = await pool.query("SELECT to_regclass('aihankapps_hub_acks') AS acks, to_regclass('aihankapps_hub_notes') AS notes");
    if (!exists.rows[0] || !exists.rows[0].acks) return { success: true, acks: [], nextCursor: after, hasMore: false };
    const notes = !!exists.rows[0].notes;
    const rows = await pool.query(`SELECT a.ref, a.title, a.plan, a.acked_at, a.plan_at${notes ? ', n.state, n.note, n.updated_at AS note_at' : ''}
        FROM aihankapps_hub_acks a${notes ? ' LEFT JOIN aihankapps_hub_notes n ON n.ref=a.ref' : ''}
        WHERE a.ref LIKE 'human-timehut-qa-review-%' AND a.ref>$1 ORDER BY a.ref LIMIT $2`, [after, limit]);
    const ms = value => { const time = value == null ? NaN : new Date(value).getTime(); return Number.isFinite(time) ? time : null; };
    const acks = rows.rows.map(r => ({ id: r.ref, title: r.title || null, plan: r.plan || null, at: ms(r.acked_at), planAt: ms(r.plan_at),
        triage: r.note_at ? { state: r.state, note: r.note, at: ms(r.note_at) } : null,
        answered: !!(r.plan && ms(r.note_at) !== null && ms(r.plan_at) !== null && ms(r.note_at) >= ms(r.plan_at)) }));
    return { success: true, acks, nextCursor: acks.length ? acks[acks.length - 1].id : after, hasMore: acks.length === limit };
}
function sameComment(row, v) { return row.batch === v.batch && row.item === v.item && row.revision === v.revision && row.decision === v.decision && row.body === v.body; }
async function comment(pool, input) {
    const v = validateComment(input);
    await prepare(pool);
    return locked(pool, async client => {
        const previous = await client.query('SELECT id::text, batch, item, revision, decision, body, created_at FROM aihankapps_hub_qa_comments WHERE request_id=$1', [v.requestId]);
        if (previous.rows[0]) {
            if (!sameComment(previous.rows[0], v)) fail('QA_IDEMPOTENCY_CONFLICT');
            return { success: true, comment: previous.rows[0], duplicate: true };
        }
        const b = await snapshot(client, v.batch), i = b && b.items.find(x => x.id === v.item);
        if (!i) fail('QA_ITEM_MISSING');
        if (b.reviewState === 'archived') fail('QA_BATCH_ARCHIVED');
        if (i.revision !== v.revision) fail('QA_REVISION_CONFLICT');
        // Bind the comment to the CURRENT snapshot in one SQL statement, including
        // a concurrent operator revision. A stale approval cannot approve new GIFs.
        const r = await client.query(`INSERT INTO aihankapps_hub_qa_comments (request_id,batch,item,revision,decision,body)
            SELECT $1,$2,$3,$4,$5,$6 FROM aihankapps_hub_qa_batches b
            WHERE b.id=$2 AND COALESCE(b.payload->>'reviewState','active') <> 'archived' AND EXISTS (SELECT 1 FROM jsonb_array_elements(b.payload->'items') i WHERE i->>'id'=$3 AND i->>'revision'=$4)
            ON CONFLICT(request_id) DO NOTHING RETURNING id::text,batch,item,revision,decision,body,created_at`, [v.requestId, v.batch, v.item, v.revision, v.decision, v.body]);
        if (!r.rows[0]) {
            const concurrent = await client.query('SELECT id::text,batch,item,revision,decision,body,created_at FROM aihankapps_hub_qa_comments WHERE request_id=$1', [v.requestId]);
            if (concurrent.rows[0] && sameComment(concurrent.rows[0], v)) return { success: true, comment: concurrent.rows[0], duplicate: true };
            fail(concurrent.rows[0] ? 'QA_IDEMPOTENCY_CONFLICT' : 'QA_REVISION_CONFLICT');
        }
        return { success: true, comment: r.rows[0], duplicate: false };
    });
}
function mediaKey(item, sha, batch = BATCH) {
    batchId(batch);
    if (typeof item !== 'string' || typeof sha !== 'string' || !ITEM.test(item) || !SHA.test(sha)) fail('QA_MEDIA_INVALID');
    return `aihankapps-hub/qa/${APP}/${batch}/${item}-${sha}.gif`;
}
function storage() {
    const { S3Client } = require('@aws-sdk/client-s3');
    if (!['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].every(k => process.env[k])) fail('QA_MEDIA_UNAVAILABLE');
    return { client: new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } }), bucket: process.env.R2_BUCKET_NAME || 'eclaw-files' };
}
async function prepareMedia(v) {
    if (!v) fail('QA_MEDIA_INVALID');
    const key = mediaKey(v.item, v.sha256, v.batch);
    if (!Number.isInteger(v.size) || v.size < 14 || v.size > 20 * 1024 * 1024) fail('QA_MEDIA_SIZE');
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const { client, bucket } = storage();
    try { return { key, url: await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: 'image/gif', ContentLength: v.size, Metadata: { sha256: v.sha256 } }), { expiresIn: 600 }) }; } finally { client.destroy(); }
}
async function verifyMedia(item, batch) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { client, bucket } = storage();
    try {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: mediaKey(item.id, item.sha256, batch) }));
        if (r.ContentType !== 'image/gif' || r.ContentLength !== item.bytes) fail('QA_MEDIA_METADATA');
        const hash = crypto.createHash('sha256'); let n = 0, magic = Buffer.alloc(0);
        for await (const chunk of r.Body) { n += chunk.length; if (n > 20 * 1024 * 1024) fail('QA_MEDIA_SIZE'); hash.update(chunk); if (magic.length < 6) magic = Buffer.concat([magic, chunk]).subarray(0, 6); }
        if (n !== item.bytes || !/^GIF8[79]a$/.test(magic.toString('ascii')) || hash.digest('hex') !== item.sha256) fail('QA_MEDIA_CONTENT');
    } finally { client.destroy(); }
}
function validateBatch(b) {
    if (b && b.reviewState !== undefined && !['active','archived'].includes(b.reviewState)) fail('QA_BATCH_STATE');
    if (b && b.phaseSummary !== undefined && (typeof b.phaseSummary !== 'string' || b.phaseSummary.length > 3000)) fail('QA_BATCH_TEXT');
    if (!b || typeof b.id !== 'string' || b.app !== APP || !Array.isArray(b.items) || b.items.length !== 10 || b.items.some(i => !i || typeof i !== 'object') || new Set(b.items.map(i => i.id)).size !== 10) fail('QA_BATCH');
    batchId(b.id);
    for (const i of b.items) {
        if (typeof i.id !== 'string' || typeof i.revision !== 'string' || typeof i.sha256 !== 'string' || !ITEM.test(i.id) || !REV.test(i.revision) || !SHA.test(i.sha256) || i.mediaKey !== mediaKey(i.id, i.sha256, b.id) || !Number.isInteger(i.bytes) || i.bytes < 14 || i.bytes > 20 * 1024 * 1024) fail('QA_BATCH_ITEM');
        for (const k of ['title', 'before', 'after', 'status', 'releaseStatus']) if (typeof i[k] !== 'string' || !i[k] || i[k].length > 2000) fail('QA_BATCH_TEXT');
    }
    if (Buffer.byteLength(JSON.stringify(b)) > 100000) fail('QA_BATCH_SIZE');
    return b;
}
async function publish(pool, input, { verify = verifyMedia } = {}) {
    const b = validateBatch(input);
    for (const i of b.items) await verify(i, b.id);
    await prepare(pool);
    return locked(pool, async client => {
        const old = await snapshot(client, b.id);
        if (old && old.reviewState === 'archived') {
            // Completed review material stays frozen while the hourly E2E
            // journal can still advance when there is no new review batch.
            const identity = value => {
                const copy = { ...value };
                for (const key of ['coverage', 'coverageNote', 'phaseSummary', 'updatedAt']) delete copy[key];
                return copy;
            };
            if (!isDeepStrictEqual(identity(old), identity(b))) fail('QA_BATCH_ARCHIVED');
            if (isDeepStrictEqual(old, b)) return { success: true, published: b.id, items: 10, duplicate: true };
            await client.query('INSERT INTO aihankapps_hub_qa_batches(id,payload) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=NOW()', [b.id, JSON.stringify(b)]);
            return { success: true, published: b.id, items: 10, duplicate: false, progressOnly: true };
        }
        if (old) {
            for (const item of b.items) {
                const previous = old.items.find(i => i.id === item.id);
                if (previous && previous.revision === item.revision && (previous.sha256 !== item.sha256 || previous.bytes !== item.bytes || previous.mediaKey !== item.mediaKey)) fail('QA_REVISION_CONFLICT');
            }
        }
        if (old && b.reviewState === 'archived') {
            const retained = value => { const copy = { ...value }; for (const key of ['reviewState', 'phaseSummary', 'updatedAt']) delete copy[key]; return copy; };
            if (!isDeepStrictEqual(retained(old), retained(b))) fail('QA_ARCHIVE_CONFLICT');
        }
        if (b.reviewState !== 'archived') {
            const current = await client.query(`SELECT id FROM aihankapps_hub_qa_batches WHERE id<>$1 AND COALESCE(payload->>'reviewState','active') = 'active'`, [b.id]);
            if (current.rows.length) fail('QA_ACTIVE_BATCH_CONFLICT');
        }
        await client.query('INSERT INTO aihankapps_hub_qa_batches(id,payload) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=NOW()', [b.id, JSON.stringify(b)]);
        return { success: true, published: b.id, items: 10, duplicate: false };
    });
}
async function result(pool, v) {
    if (!v || typeof v.key !== 'string' || typeof v.item !== 'string' || !REV.test(v.key || '') || !ITEM.test(v.item || '') || (v.commentId != null && !/^\d{1,18}$/.test(String(v.commentId))) || typeof v.body !== 'string' || !v.body.trim() || v.body.length > 6000) fail('QA_RESULT');
    const batch = batchId(v.batch);
    await prepare(pool);
    return locked(pool, async client => {
        const b = await snapshot(client, batch);
        if (!b || !b.items.some(i => i.id === v.item)) fail('QA_ITEM_MISSING');
        if (v.commentId != null) {
            const c = await client.query('SELECT item FROM aihankapps_hub_qa_comments WHERE id=$1 AND batch=$2', [String(v.commentId), batch]);
            if (!c.rows[0] || c.rows[0].item !== v.item) fail('QA_RESULT_COMMENT');
        }
        const r = await client.query('INSERT INTO aihankapps_hub_qa_results(result_key,comment_id,item,body,batch) VALUES($1,$2,$3,$4,$5) ON CONFLICT(result_key) DO NOTHING RETURNING id::text', [v.key, v.commentId == null ? null : String(v.commentId), v.item, v.body.trim(), batch]);
        if (!r.rows[0]) {
            const old = await client.query('SELECT item,comment_id::text,body,batch FROM aihankapps_hub_qa_results WHERE result_key=$1', [v.key]);
            const row = old.rows[0];
            if (!row || row.batch !== batch || row.item !== v.item || row.comment_id !== (v.commentId == null ? null : String(v.commentId)) || row.body !== v.body.trim()) fail('QA_RESULT_CONFLICT');
        }
        return { success: true, duplicate: !r.rows.length };
    });
}
function mount(api, { getPool, limited }) {
    const express = require('express');
    const error = (res, e) => {
        const code = /^QA_[A-Z_]+$/.test(e.code || '') ? e.code : 'QA_UNAVAILABLE';
        return res.status(code.includes('CONFLICT') || code === 'QA_BATCH_ARCHIVED' ? 409 : code === 'QA_ITEM_MISSING' ? 404 : code === 'QA_UNAVAILABLE' || code === 'QA_MEDIA_UNAVAILABLE' ? 503 : 400).json({ success: false, error: code });
    };
    api.get('/qa/timehut', async (req, res) => { try { res.json(await read(getPool(), { after: req.query.after || '0', batch: req.query.batch })); } catch (e) { error(res, e); } });
    api.post('/qa/timehut/comments', express.json({ limit: '20kb' }), async (req, res) => {
        if (limited(req)) return res.status(429).set('Retry-After', '60').json({ success: false, error: 'QA_RATE_LIMIT' });
        try { res.json(await comment(getPool(), req.body)); } catch (e) { error(res, e); }
    });
    api.get('/qa/timehut/media/:item', async (req, res) => {
        let client;
        try {
            if (!ITEM.test(req.params.item)) fail('QA_ITEM_MISSING');
            const batch = batchId(req.query.batch), pool = getPool();
            await prepare(pool);
            const b = await snapshot(pool, batch), i = b && b.items.find(x => x.id === req.params.item);
            if (!i) fail('QA_ITEM_MISSING');
            const { GetObjectCommand } = require('@aws-sdk/client-s3'), s = storage(); client = s.client;
            const object = await client.send(new GetObjectCommand({ Bucket: s.bucket, Key: mediaKey(i.id, i.sha256, batch) }));
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
module.exports = { prepare, read, alertReplies, comment, publish, result, prepareMedia, mediaKey, validateBatch, validateComment, mount, mountDebug };
