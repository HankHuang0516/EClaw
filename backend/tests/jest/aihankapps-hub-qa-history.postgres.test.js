'use strict';
// Opt-in, disposable LOCAL cluster only. No DATABASE_URL or existing DB is used.
// HUB_QA_TEST_POSTGRES_BIN=/path/to/postgres/bin jest --runInBand --runTestsByPath <this file>
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');
const qa = require('../../aihankapps-hub-qa');
const bin = process.env.HUB_QA_TEST_POSTGRES_BIN;
const suite = bin ? describe : describe.skip;
const legacy = 'timehut-batch01', current = 'timehut-batch02';
const verified = { verify: async () => {} };
function batch(id = legacy, reviewState = 'archived') {
    return { id, app: 'timehut', reviewState, items: Array.from({ length: 10 }, (_, n) => {
        const item = String(n + 1).padStart(2, '0'), sha256 = 'a'.repeat(64);
        return { id: item, revision: 'same-revision', sha256, bytes: 14, mediaKey: qa.mediaKey(item, sha256, id), title: 'Synthetic ' + item, before: 'Before', after: 'After', status: 'Synthetic archived review', releaseStatus: 'No native release' };
    }) };
}
const comment = (batch = legacy) => ({ batch, requestId: '11111111-2222-4333-8444-555555555555', item: '01', revision: 'same-revision', decision: 'comment', body: 'Synthetic local feedback' });
suite('isolated PostgreSQL batch history migration and concurrency', () => {
    let directory, running = false, owner, pool, schema, config, sequence = 0;
    const pg = (name, args) => execFileSync(path.join(bin, name), args, { stdio: 'pipe', timeout: 15000 });
    beforeAll(async () => {
        const cache = path.resolve(__dirname, '../../.cache'); fs.mkdirSync(cache, { recursive: true });
        directory = fs.mkdtempSync(path.join(cache, 'hub-qa-postgres-'));
        const port = await new Promise((resolve, reject) => {
            const server = net.createServer(); server.on('error', reject);
            server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
        });
        pg('initdb', ['-D', path.join(directory, 'data'), '-A', 'trust', '-U', 'qa_history_test', '--no-locale', '--encoding=UTF8']);
        running = true;
        pg('pg_ctl', ['-D', path.join(directory, 'data'), '-l', path.join(directory, 'server.log'), '-o', '-h 127.0.0.1 -p ' + port + ' -k "" -F', '-w', 'start']);
        config = { host: '127.0.0.1', port, user: 'qa_history_test', password: '', database: 'postgres', connectionTimeoutMillis: 3000, statement_timeout: 5000 };
        owner = new Pool(config);
    }, 30000);
    beforeEach(async () => {
        schema = 'qa_history_' + ++sequence;
        await owner.query('CREATE SCHEMA ' + schema);
        pool = new Pool({ ...config, options: '-c search_path=' + schema, max: 6 });
        // Exact old table shapes, including twenty pre-migration result rows.
        await pool.query(`CREATE TABLE aihankapps_hub_qa_batches (id TEXT PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
            CREATE TABLE aihankapps_hub_qa_comments (id BIGSERIAL PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, batch TEXT NOT NULL, item TEXT NOT NULL, revision TEXT NOT NULL, decision TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
            CREATE TABLE aihankapps_hub_qa_results (id BIGSERIAL PRIMARY KEY, result_key TEXT NOT NULL UNIQUE, comment_id BIGINT REFERENCES aihankapps_hub_qa_comments(id), item TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await pool.query('INSERT INTO aihankapps_hub_qa_batches(id,payload) VALUES($1,$2)', [legacy, JSON.stringify(batch())]);
        await pool.query(`INSERT INTO aihankapps_hub_qa_comments(request_id,batch,item,revision,decision,body) VALUES($1,$2,'01','same-revision','comment','Synthetic old feedback')`, [comment().requestId, legacy]);
        await pool.query(`INSERT INTO aihankapps_hub_qa_results(result_key,comment_id,item,body) SELECT 'legacy-' || n, CASE WHEN n=1 THEN 1 ELSE NULL END, lpad((((n-1)%10)+1)::text,2,'0'), 'Synthetic old result ' || n FROM generate_series(1,20) n`);
    });
    afterEach(async () => {
        if (pool) await pool.end();
        if (owner && schema) await owner.query('DROP SCHEMA ' + schema + ' CASCADE');
    });
    afterAll(async () => {
        try { if (owner) await owner.end(); }
        finally {
            try { if (running) pg('pg_ctl', ['-D', path.join(directory, 'data'), '-m', 'immediate', '-w', 'stop']); }
            finally { if (directory) fs.rmSync(directory, { recursive: true, force: true }); }
        }
    });
    test('migrates old rows without changing original payload/IDs/metadata and supports old writer defaults after restart', async () => {
        const beforeBatch = (await pool.query('SELECT * FROM aihankapps_hub_qa_batches')).rows;
        const beforeComments = (await pool.query('SELECT * FROM aihankapps_hub_qa_comments')).rows;
        const beforeResults = (await pool.query('SELECT * FROM aihankapps_hub_qa_results ORDER BY id')).rows;
        await qa.prepare(pool); await qa.publish(pool, batch(current, 'active'), verified);
        expect((await pool.query('SELECT * FROM aihankapps_hub_qa_batches WHERE id=$1', [legacy])).rows).toEqual(beforeBatch);
        expect((await pool.query('SELECT * FROM aihankapps_hub_qa_comments')).rows).toEqual(beforeComments);
        const migrated = (await pool.query('SELECT * FROM aihankapps_hub_qa_results ORDER BY id')).rows;
        expect(migrated).toEqual(beforeResults.map(r => ({ ...r, batch: legacy })));
        await pool.query(`INSERT INTO aihankapps_hub_qa_results(result_key,item,body) VALUES('old-writer','01','Synthetic old operator')`);
        const restarted = new Pool({ ...config, options: '-c search_path=' + schema });
        try {
            const old = await qa.read(restarted, { batch: legacy });
            expect(old.results).toHaveLength(21); expect(old.results.every(r => r.batch === legacy)).toBe(true);
            const next = await qa.read(restarted, { batch: current });
            expect(next.comments).toEqual([]); expect(next.results).toEqual([]); expect(next.activeBatchId).toBe(current);
        } finally { await restarted.end(); }
    });
    test('archived reviews keep their originals while hourly coverage advances without reopening forms', async () => {
        await qa.prepare(pool);
        const original = (await qa.read(pool, { batch: legacy })).batch;
        const originalComments = (await pool.query('SELECT * FROM aihankapps_hub_qa_comments ORDER BY id')).rows;
        const originalResults = (await pool.query('SELECT * FROM aihankapps_hub_qa_results ORDER BY id')).rows;
        const progress = { ...batch(), phaseSummary: 'Synthetic continued E2E', updatedAt: '2026-11-23T02:00:00Z', coverage: { C1: { android: { passed: 14, denominator: 604, percent: 14 / 604 * 100 } } }, coverageNote: 'Synthetic coverage' };
        expect((await qa.publish(pool, progress, verified)).progressOnly).toBe(true);
        const latest = await qa.read(pool);
        expect(latest.activeBatchId).toBeNull(); expect(latest.batch.reviewState).toBe('archived');
        expect(latest.batch.items).toEqual(original.items); expect(latest.batch.coverage).toEqual(progress.coverage);
        await expect(qa.comment(pool, { ...comment(), requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })).rejects.toHaveProperty('code', 'QA_BATCH_ARCHIVED');
        await qa.publish(pool, batch(current, 'active'), verified);
        expect((await qa.publish(pool, { ...progress, phaseSummary: 'Synthetic later E2E' }, verified)).progressOnly).toBe(true);
        expect((await qa.read(pool)).activeBatchId).toBe(current);
        const replaced = structuredClone(progress); replaced.items[0].sha256 = 'b'.repeat(64); replaced.items[0].mediaKey = qa.mediaKey('01', replaced.items[0].sha256);
        await expect(qa.publish(pool, replaced, verified)).rejects.toHaveProperty('code', 'QA_BATCH_ARCHIVED');
        expect((await pool.query('SELECT * FROM aihankapps_hub_qa_comments ORDER BY id')).rows).toEqual(originalComments);
        expect((await pool.query('SELECT * FROM aihankapps_hub_qa_results ORDER BY id')).rows).toEqual(originalResults);
    });
    test('serializes competing active publication and enforces one active even for raw INSERT', async () => {
        const outcomes = await Promise.allSettled([qa.publish(pool, batch(current, 'active'), verified), qa.publish(pool, batch('timehut-batch03', 'active'), verified)]);
        expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.find(r => r.status === 'rejected').reason.code).toBe('QA_ACTIVE_BATCH_CONFLICT');
        await expect(pool.query('INSERT INTO aihankapps_hub_qa_batches(id,payload) VALUES($1,$2)', ['timehut-batch04', JSON.stringify(batch('timehut-batch04', 'active'))])).rejects.toHaveProperty('code', '23505');
        expect((await qa.read(pool)).batches).toHaveLength(2);
    });
    test('rejects stale archive forms with the same item/revision and binds concurrent UUID/result retries to batch', async () => {
        await qa.publish(pool, batch(current, 'active'), verified);
        await expect(qa.comment(pool, comment())).rejects.toHaveProperty('code', 'QA_IDEMPOTENCY_CONFLICT'); // original body differs
        await expect(qa.comment(pool, { ...comment(), requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })).rejects.toHaveProperty('code', 'QA_BATCH_ARCHIVED');
        await expect(qa.comment(pool, comment(current))).rejects.toHaveProperty('code', 'QA_IDEMPOTENCY_CONFLICT');
        const fresh = { ...comment(current), requestId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' };
        const outcomes = await Promise.all([qa.comment(pool, fresh), qa.comment(pool, fresh)]);
        expect(outcomes.filter(r => !r.duplicate)).toHaveLength(1);
        expect(outcomes[0].comment.id).toBe(outcomes[1].comment.id);
        await expect(qa.result(pool, { batch: current, key: 'bad-reference', item: '01', commentId: '1', body: 'Synthetic' })).rejects.toHaveProperty('code', 'QA_RESULT_COMMENT');
        const value = { batch: current, key: 'current-result', item: '01', commentId: outcomes[0].comment.id, body: 'Synthetic result' };
        const results = await Promise.all([qa.result(pool, value), qa.result(pool, value)]);
        expect(results.filter(r => !r.duplicate)).toHaveLength(1);
        await expect(qa.result(pool, { ...value, batch: legacy, commentId: null })).rejects.toHaveProperty('code', 'QA_RESULT_CONFLICT');
    });
    test('archive wins a queued publication/form race; rejected form leaves no row', async () => {
        await qa.publish(pool, batch(current, 'active'), verified);
        const blocker = await pool.connect();
        await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock(20261123, 1)');
        const blocked = async count => {
            for (let n = 0; n < 200; n++) {
                const r = await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted");
                if (r.rows[0].n >= count) return;
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            throw new Error('Local lock queue did not fill');
        };
        let archive, feedback;
        try {
            archive = qa.publish(pool, batch(current, 'archived'), verified);
            await blocked(1);
            feedback = qa.comment(pool, { ...comment(current), requestId: 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa' }).catch(e => e.code);
            await blocked(2);
        } finally { await blocker.query('COMMIT'); blocker.release(); }
        await archive; expect(await feedback).toBe('QA_BATCH_ARCHIVED');
        expect((await qa.read(pool, { batch: current })).comments).toEqual([]);
        expect((await qa.read(pool)).activeBatchId).toBeNull();
    });
    test('pages every old/closed review warning and observes a late plan despite its original acknowledgement age', async () => {
        await pool.query(`CREATE TABLE aihankapps_hub_acks (ref TEXT PRIMARY KEY,title TEXT,plan TEXT,acked_at TIMESTAMPTZ,plan_at TIMESTAMPTZ);
            CREATE TABLE aihankapps_hub_notes (ref TEXT PRIMARY KEY,state TEXT,note TEXT,updated_at TIMESTAMPTZ)`);
        await pool.query(`INSERT INTO aihankapps_hub_acks SELECT 'human-timehut-qa-review-' || lpad(n::text,4,'0'), 'Synthetic old alert', 'Synthetic plan', NOW()-INTERVAL '90 days', NOW()-INTERVAL '90 days' FROM generate_series(1,502) n`);
        await pool.query(`INSERT INTO aihankapps_hub_acks VALUES('other-app','Private other app','Do not include',NOW(),NOW())`);
        const first = await qa.alertReplies(pool), last = await qa.alertReplies(pool, { after: first.nextCursor });
        expect(first.acks).toHaveLength(500); expect(first.hasMore).toBe(true); expect(last.acks).toHaveLength(2); expect(last.hasMore).toBe(false);
        const ref = last.acks[1].id, originalAck = last.acks[1].at;
        await pool.query('UPDATE aihankapps_hub_acks SET plan=$1,plan_at=NOW() WHERE ref=$2', ['Late changed plan', ref]);
        await pool.query(`INSERT INTO aihankapps_hub_notes VALUES($1,'done','Synthetic old response',NOW()-INTERVAL '1 day')`, [ref]);
        const changed = await qa.alertReplies(pool, { after: first.nextCursor });
        expect(changed.acks[1]).toMatchObject({ id: ref, at: originalAck, plan: 'Late changed plan', answered: false, triage: { state: 'done' } });
        expect(JSON.stringify([first, changed])).not.toContain('Do not include');
        const { collectUpdates } = require('../../../tools/aihankapps-hub/qa');
        const response = collectUpdates({}, { qaRead: () => ({ success: true, comments: [], nextCursor: '0', hasMore: false }), alertsRead: () => ({ alerts: [], acks: changed.acks }) });
        expect(response.alertResponses.find(r => r.id === ref)).toMatchObject({ plan: 'Late changed plan', active: false });
    });
    test('same-revision media replacement rolls back; a new revision rejects the prior open form', async () => {
        const original = batch(current, 'active'); await qa.publish(pool, original, verified);
        const before = (await pool.query('SELECT * FROM aihankapps_hub_qa_batches WHERE id=$1', [current])).rows;
        const changed = batch(current, 'active');
        changed.items[0].sha256 = 'b'.repeat(64); changed.items[0].mediaKey = qa.mediaKey('01', changed.items[0].sha256, current);
        await expect(qa.publish(pool, changed, verified)).rejects.toHaveProperty('code', 'QA_REVISION_CONFLICT');
        expect((await pool.query('SELECT * FROM aihankapps_hub_qa_batches WHERE id=$1', [current])).rows).toEqual(before);
        changed.items[0].revision = 'new-media-revision'; await qa.publish(pool, changed, verified);
        const stale = { ...comment(current), requestId: 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb', decision: 'approve' };
        await expect(qa.comment(pool, stale)).rejects.toHaveProperty('code', 'QA_REVISION_CONFLICT');
        expect((await qa.read(pool, { batch: current })).comments).toEqual([]);
    });
});
