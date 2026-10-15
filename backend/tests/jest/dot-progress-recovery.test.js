require('./helpers/mock-setup');
const express = require('express');
const request = require('supertest');
const { newDb, DataType } = require('pg-mem');
const progress = require('../../dot-progress');
const base = '/api/dot-progress'; const day = '2040-07-19'; let sequence = 0;
const admin = call => call.set('x-test-role', 'admin');
const token = () => `synthetic-recovery-${++sequence}`;
function setup(override) {
    const db = newDb({ noAstCoverageCheck: true });
    db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: [DataType.integer], returns: DataType.integer, implementation: () => 1 });
    db.public.registerFunction({ name: 'clock_timestamp', args: [], returns: DataType.timestamptz, impure: true, implementation: () => new Date() });
    const { Pool } = db.adapters.createPg(); const memory = new Pool(); const connect = memory.connect.bind(memory);
    memory.connect = async () => { const client = await connect(); const query = client.query.bind(client); client.query = (sql, params) => sql.startsWith('SET TRANSACTION') ? Promise.resolve({ rows: [] }) : query(sql, params); return client; };
    const pool = override === undefined ? memory : override;
    const auth = {
        authMiddleware(req, res, next) { if (!req.get('x-test-role')) return res.status(401).json({ success: false, error: 'unauthenticated' }); req.user = { userId: 'synthetic-admin' }; next(); },
        adminMiddleware(req, res, next) { if (req.get('x-test-role') !== 'admin') return res.status(403).json({ success: false, error: 'admin_required' }); next(); }
    };
    const app = express(); app.use(base, progress.createRouter(() => pool, auth)); return { app, pool };
}
async function put(app, version, rows, date = day, extra = {}) {
    const result = await admin(request(app).put(`${base}/schedule/${date}`)).send({ version, requestId: token(), rows, ...extra });
    expect({ status: result.status, body: result.body }).toMatchObject({ status: 200 }); return result.body.schedule;
}
async function sourceFixture(app, date = day, options = {}) {
    const entries = [];
    for (let i = 0; i < (options.count || 2); i++) {
        const body = { requestId: token(), startedAt: null, endedAt: `${options.actualDate || date}T10:00:00+08:00`, projectId: null, projectLabel: `Synthetic project ${i}`, goal: `Synthetic explicit goal ${i}`, workType: 'validation', actions: 'Synthetic check.', result: 'Synthetic passed.' };
        const result = await admin(request(app).post(`${base}/timeline`)).send(body); expect(result.status).toBe(200); let entry = result.body.entry;
        if (options.correctBeforeSource && i === 0) {
            const corrected = await admin(request(app).patch(`${base}/timeline/${entry.id}`)).send({ version: 1, requestId: token(), goal: 'Synthetic corrected before source.' }); expect(corrected.status).toBe(200); entry = corrected.body.entry;
        }
        entries.push(entry);
    }
    const kept = { id: 'synthetic-existing-plan', projectId: null, projectLabel: 'Synthetic existing project', goal: 'Synthetic intentional goal.', plannedStart: null, plannedEnd: null, status: 'waiting', actualIds: [] };
    await put(app, 0, [kept], date);
    const rows = entries.map(entry => ({ id: entry.id, projectId: entry.projectId, projectLabel: entry.projectLabel, goal: entry.goal, plannedStart: null, plannedEnd: null, status: 'planned', actualIds: [entry.id] }));
    const source = await put(app, 1, [kept, ...rows], date, { rowOrder: [rows[1].id, kept.id, rows[0].id] });
    return { entries, rows, source, kept };
}
async function preview(app, revision = 2, date = day) {
    return admin(request(app).get(`${base}/schedule/${date}/recovery-preview?revision=${revision}`));
}
const recovery = (fixture, delta = {}) => ({ requestId: token(), version: fixture.source.version, sourceRevision: fixture.source.version, removeIds: [fixture.rows[0].id], ...delta });
async function actualSnapshots(pool) {
    return Promise.all(['dot_progress_timeline', 'dot_progress_timeline_revisions', 'dot_progress_timeline_requests', 'dot_progress_projects', 'dot_progress_history', 'dot_progress_push_state', 'dot_progress_push_requests'].map(table => pool.query(`SELECT * FROM ${table} ORDER BY 1`).then(result => result.rows)));
}

describe('explicit private schedule recovery', () => {
    test('preview exact source-added IDs and source-time actual snapshots; selected subset keeps archives/order/actuals and exact receipts', async () => {
        const { app, pool } = setup(); const fixture = await sourceFixture(app);
        const archived = await put(app, 2, fixture.source.rows.map(row => row.id === fixture.kept.id ? { ...row, archived: true } : row));
        const before = await actualSnapshots(pool); const result = await preview(app);
        expect({ status: result.status, body: result.body }).toMatchObject({ status: 200 });
        expect(result.body.preview).toMatchObject({ currentVersion: 3, addedIds: fixture.rows.map(row => row.id), eligible: fixture.rows.map(row => ({ id: row.id, row })), protected: [], laterChanges: [], historyChecked: { count: 1, limit: 1000, complete: true } });
        expect(result.body.preview.source).toMatchObject({ version: 2, actorId: 'synthetic-admin', changes: { after: fixture.source } });
        const body = recovery(fixture, { version: 3 });
        const applied = await admin(request(app).post(`${base}/schedule/${day}/recovery`)).send(body);
        expect(applied.status).toBe(200); expect(applied.body.schedule.rows).toEqual(archived.rows.filter(row => row.id !== body.removeIds[0]));
        expect(applied.body.schedule.rowOrder).toEqual(archived.rowOrder);
        expect(await actualSnapshots(pool)).toEqual(before);
        expect((await admin(request(app).post(`${base}/schedule/${day}/recovery`)).send(body)).body.schedule).toEqual(applied.body.schedule);
        const undone = await put(app, 4, archived.rows, day, { rowOrder: archived.rowOrder }); expect(undone.rows).toEqual(archived.rows);
        const restarted = setup(pool); expect((await admin(request(restarted.app).post(`${base}/schedule/${day}/recovery`)).send(body)).body.schedule).toEqual(applied.body.schedule);
        expect((await preview(restarted.app)).body.preview.protected.find(row => row.id === body.removeIds[0]).reasons).toContain('row_changed');
    });

    test('sorting positions alone stays eligible; edit-then-restore and remove/rebuild stay protected', async () => {
        const { app } = setup(); const fixture = await sourceFixture(app);
        const sorted = await put(app, 2, [...fixture.source.rows].reverse(), day, { rowOrder: [] });
        expect((await preview(app)).body.preview.eligible).toHaveLength(2);
        const edited = await put(app, 3, sorted.rows.map(row => row.id === fixture.rows[0].id ? { ...row, status: 'active' } : row));
        const restored = await put(app, 4, edited.rows.map(row => row.id === fixture.rows[0].id ? fixture.rows[0] : row));
        await put(app, 5, restored.rows.filter(row => row.id !== fixture.rows[1].id));
        await put(app, 6, restored.rows);
        const result = await preview(app); expect(result.status).toBe(200); expect(result.body.preview.eligible).toEqual([]);
        expect(result.body.preview.protected.every(row => row.reasons.includes('row_changed'))).toBe(true);
        expect(result.body.preview.laterChanges.map(change => change.fields)).toEqual([['status'], ['status'], ['removed'], ['added']]);
    });

    test('actual edits and restored content protect derived plans; absent explicit source goal and manual null plans never qualify', async () => {
        const { app } = setup(); const fixture = await sourceFixture(app); const entry = fixture.entries[0];
        for (const [version, goal] of [[1, 'Synthetic revised goal.'], [2, entry.goal]]) expect((await admin(request(app).patch(`${base}/timeline/${entry.id}`)).send({ version, requestId: token(), goal })).status).toBe(200);
        const result = await preview(app); expect(result.status).toBe(200); expect(result.body.preview.protected[0].reasons).toContain('actual_changed'); expect(result.body.preview.eligible).toHaveLength(1);
        expect((await admin(request(app).post(`${base}/schedule/${day}/recovery`)).send(recovery(fixture))).body.error).toBe('recovery_not_eligible');
        const addedManual = { ...fixture.kept, id: 'synthetic-manual-null' };
        await put(app, 2, [...fixture.source.rows, addedManual]);
        const manual = await preview(app, 3); expect(manual.body.preview.protected[0].reasons).toContain('source_not_derived');
        const outside = setup(); await sourceFixture(outside.app, day, { actualDate: '2040-07-18' });
        const outsidePreview = await preview(outside.app); expect(outsidePreview.body.preview.eligible).toEqual([]);
        expect(outsidePreview.body.preview.protected.every(row => row.reasons.includes('actual_source_mismatch'))).toBe(true);
        const noGoal = setup();
        const noGoalBody = { requestId: token(), startedAt: null, endedAt: `${day}T10:00:00+08:00`, projectId: null, projectLabel: 'Synthetic no-goal project', workType: 'validation', actions: 'Synthetic check.', result: 'Synthetic passed.' };
        const noGoalEntry = (await admin(request(noGoal.app).post(`${base}/timeline`)).send(noGoalBody)).body.entry;
        await put(noGoal.app, 0, [{ id: noGoalEntry.id, projectId: null, projectLabel: noGoalEntry.projectLabel, goal: 'Synthetic unsupported guessed goal.', plannedStart: null, plannedEnd: null, status: 'planned', actualIds: [noGoalEntry.id] }]);
        expect((await preview(noGoal.app, 1)).body.preview.protected[0].reasons).toContain('actual_source_mismatch');
    });

    test('strict selection/auth/origin/version/source checks and action-scoped receipts reject unsafe removals', async () => {
        const { app } = setup(); const fixture = await sourceFixture(app); const body = recovery(fixture);
        for (const removeIds of [[], null, ['bad id'], [fixture.rows[0].id, fixture.rows[0].id]]) expect((await admin(request(app).post(`${base}/schedule/${day}/recovery`)).send({ ...body, removeIds })).status).toBe(400);
        expect((await admin(request(app).post(`${base}/schedule/${day}/recovery`)).send({ ...body, removeIds: [fixture.kept.id] })).body.error).toBe('recovery_not_eligible');
        expect((await admin(request(app).post(`${base}/schedule/${day}/recovery`)).send({ ...body, version: 1 })).body.error).toBe('version_conflict');
        expect((await preview(app, 99)).body.error).toBe('source_revision_not_found');
        expect((await preview(app, 0)).status).toBe(400);
        for (const [method, path] of [['get', `/schedule/${day}/recovery-preview?revision=2`], ['post', `/schedule/${day}/recovery`]]) {
            expect((await request(app)[method](`${base}${path}`).send(method === 'post' ? body : undefined)).status).toBe(401);
            expect((await request(app)[method](`${base}${path}`).set('x-test-role', 'member').send(method === 'post' ? body : undefined)).status).toBe(403);
        }
        expect((await admin(request(app).post(`${base}/schedule/${day}/recovery`)).set('Origin', 'https://synthetic-other.invalid').send(body)).status).toBe(403);
        const sourceReceipt = (await admin(request(app).put(`${base}/schedule/${day}`)).send({ version: 2, requestId: body.requestId, rows: fixture.source.rows })).body.schedule;
        expect(sourceReceipt.version).toBe(3);
        expect((await admin(request(app).post(`${base}/schedule/${day}/recovery`)).send(body)).body.error).toBe('request_id_conflict');
        expect(JSON.stringify((await request(app).get(`${base}/public`)).body)).not.toMatch(/Synthetic|removeIds|sourceRevision/);
    });

    test('all later revisions are checked past100; gaps, malformed snapshots and >1000 histories fail closed', async () => {
        const { app, pool } = setup(); const fixture = await sourceFixture(app); let last = fixture.source;
        for (let version = 3; version <= 104; version++) {
            const next = { ...last, version, rows: version === 103 ? last.rows.map(row => row.id === fixture.rows[0].id ? { ...row, status: 'active' } : row) : last.rows };
            await pool.query('INSERT INTO dot_progress_schedule_revisions(date,version,actor_id,changes) VALUES ($1,$2,$3,$4::jsonb)', [day, version, 'synthetic-later-admin', JSON.stringify({ before: last, after: next })]); last = next;
        }
        await pool.query('UPDATE dot_progress_schedule SET rows=$2::jsonb,version=$3 WHERE date=$1', [day, JSON.stringify(last.rows), last.version]);
        const result = await preview(app); expect(result.status).toBe(200); expect(result.body.preview.historyChecked.count).toBe(102);
        expect(result.body.preview.protected[0].laterChanges[0]).toMatchObject({ version: 103, fields: ['status'] });
        await pool.query('DELETE FROM dot_progress_schedule_revisions WHERE date=$1 AND version=50', [day]);
        expect((await preview(app)).body.error).toBe('recovery_history_incomplete');
        const malformed = setup(); await sourceFixture(malformed.app);
        await malformed.pool.query('UPDATE dot_progress_schedule_revisions SET changes=$2::jsonb WHERE date=$1 AND version=2', [day, JSON.stringify({ before: {}, after: {} })]);
        expect((await preview(malformed.app)).body.error).toBe('recovery_history_incomplete');
        const limited = setup(); const source = await sourceFixture(limited.app);
        for (let version = 3; version <= 1003; version++) await limited.pool.query('INSERT INTO dot_progress_schedule_revisions(date,version,actor_id,changes) VALUES ($1,$2,$3,$4::jsonb)', [day, version, 'synthetic-admin', JSON.stringify({ before: source.source, after: source.source })]);
        expect((await preview(limited.app)).body.error).toBe('recovery_history_limit');
    });
});

const realPg = process.env.DOT_PROGRESS_TEST_PG === '1' ? test : test.skip;
realPg('actual PostgreSQL source-time native timestamps, recovery races/receipts/rollback/restart and unchanged actuals', async () => {
    const { Pool } = jest.requireActual('pg'); const name = `dot_recovery_test_${process.pid}_${Date.now()}`;
    const config = { host: '127.0.0.1', port: 55414, database: 'postgres', user: 'progress_test', connectionTimeoutMillis: 2000, statement_timeout: 4000 };
    const owner = new Pool(config); await owner.query(`CREATE SCHEMA ${name}`); const pool = new Pool({ ...config, options: `-c search_path=${name}` });
    try {
        const { app } = setup(pool); const fixture = await sourceFixture(app); const before = await actualSnapshots(pool);
        expect((await preview(app)).body.preview.eligible).toHaveLength(2);
        const body = recovery(fixture); const repeated = await Promise.all([1, 2].map(() => admin(request(app).post(`${base}/schedule/${day}/recovery`)).send(body)));
        expect(repeated.map(result => result.status)).toEqual([200, 200]); expect(repeated[0].body.schedule).toEqual(repeated[1].body.schedule);
        const restarted = setup(pool); expect((await admin(request(restarted.app).post(`${base}/schedule/${day}/recovery`)).send(body)).body.schedule).toEqual(repeated[0].body.schedule);
        const otherDay = '2040-07-20'; const second = await sourceFixture(app, otherDay);
        const race = await Promise.all(second.rows.map(row => admin(request(app).post(`${base}/schedule/${otherDay}/recovery`)).send(recovery(second, { removeIds: [row.id] }))));
        expect(race.map(result => result.status).sort()).toEqual([200, 409]);
        const thirdDay = '2040-07-21'; const third = await sourceFixture(app, thirdDay);
        const failed = recovery(third, { requestId: 'synthetic-failed-recovery' });
        await pool.query("ALTER TABLE dot_progress_schedule_requests ADD CONSTRAINT synthetic_recovery_failure CHECK (request_id <> 'synthetic-failed-recovery')");
        expect((await admin(request(app).post(`${base}/schedule/${thirdDay}/recovery`)).send(failed)).status).toBe(503);
        expect((await admin(request(app).get(`${base}/schedule?date=${thirdDay}`))).body.schedule).toEqual(third.source);
        expect((await admin(request(app).get(`${base}/schedule/${thirdDay}/history`))).body.total).toBe(2);
        await pool.query('ALTER TABLE dot_progress_schedule_requests DROP CONSTRAINT synthetic_recovery_failure');
        expect((await admin(request(app).post(`${base}/schedule/${thirdDay}/recovery`)).send(failed)).status).toBe(200);
        // Millisecond parsers would lose this ordering; the SQL source comparison must not.
        const fourthDay = '2040-07-22'; const fourth = await sourceFixture(app, fourthDay);
        await pool.query("UPDATE dot_progress_schedule_revisions SET created_at='2040-01-01T00:00:00.000100Z' WHERE date=$1 AND version=2", [fourthDay]);
        await pool.query("UPDATE dot_progress_timeline_revisions SET created_at='2040-01-01T00:00:00.000900Z' WHERE timeline_id=$1", [fourth.rows[0].id]);
        expect((await preview(app, 2, fourthDay)).body.preview.protected.find(row => row.id === fourth.rows[0].id).reasons).toContain('actual_source_missing');
        // Recovery modified no actual/project/push data present before the extra synthetic cases.
        const after = await actualSnapshots(pool);
        const firstIds = new Set(fixture.entries.map(entry => entry.id));
        expect(after[0].filter(row => firstIds.has(row.id))).toEqual(before[0]);
        expect(after[1].filter(row => firstIds.has(row.timeline_id))).toEqual(before[1]);
        expect(after[2].filter(row => firstIds.has(row.response_entry.id))).toEqual(before[2]);
        for (let i = 3; i < before.length; i++) expect(after[i]).toEqual(before[i]);

        const bulkDay = '2040-07-23'; const bulk = await sourceFixture(app, bulkDay, { count: 20, correctBeforeSource: true });
        expect((await preview(app, 2, bulkDay)).body.preview.eligible).toHaveLength(20);
        const secondQa = { ...bulk.kept, id: 'synthetic-second-qa', goal: 'Synthetic second QA goal.' };
        const withQa = await put(app, 2, [...bulk.source.rows, secondQa], bulkDay);
        const archivedQa = await put(app, 3, withQa.rows.map(row => [bulk.kept.id, secondQa.id].includes(row.id) ? { ...row, archived: true } : row), bulkDay);
        const bulkBefore = await actualSnapshots(pool);
        const bulkPreview = await preview(app, 2, bulkDay); expect(bulkPreview.body.preview.eligible).toHaveLength(20);
        const selected = bulk.rows.slice(0, 3).map(row => row.id);
        const bulkBody = recovery(bulk, { version: 4, removeIds: selected });
        const bulkApplied = await admin(request(app).post(`${base}/schedule/${bulkDay}/recovery`)).send(bulkBody);
        expect(bulkApplied.status).toBe(200);
        expect(bulkApplied.body.schedule.rows).toEqual(archivedQa.rows.filter(row => !selected.includes(row.id)));
        expect(bulkApplied.body.schedule.rowOrder).toEqual(archivedQa.rowOrder);
        expect(bulkApplied.body.schedule.rows.filter(row => row.archived)).toHaveLength(2);
        expect(await actualSnapshots(pool)).toEqual(bulkBefore);
        const bulkUndo = await put(app, 5, archivedQa.rows, bulkDay, { rowOrder: archivedQa.rowOrder }); expect(bulkUndo.rows).toEqual(archivedQa.rows);
        expect((await admin(request(app).post(`${base}/schedule/${bulkDay}/recovery`)).send(bulkBody)).body.schedule).toEqual(bulkApplied.body.schedule);
        const correctedAfter = bulk.entries[4];
        expect((await admin(request(app).patch(`${base}/timeline/${correctedAfter.id}`)).send({ version: 1, requestId: token(), goal: 'Synthetic corrected after source.' })).status).toBe(200);
        expect((await preview(app, 2, bulkDay)).body.preview.protected.find(row => row.id === correctedAfter.id).reasons).toContain('actual_changed');
        const waitingDay = '2040-07-24'; const waiting = await sourceFixture(app, waitingDay);
        await pool.query("UPDATE dot_progress_schedule_revisions SET created_at='2040-01-01T00:00:00.000100Z' WHERE date=$1 AND version=2", [waitingDay]);
        await pool.query("UPDATE dot_progress_timeline_revisions SET created_at='2040-01-01T00:00:00.000000Z' WHERE timeline_id=$1", [waiting.rows[0].id]);
        await pool.query("UPDATE dot_progress_timeline SET updated_at='2040-01-01T00:00:00.000900Z' WHERE id=$1", [waiting.rows[0].id]);
        expect((await preview(app, 2, waitingDay)).body.preview.protected.find(row => row.id === waiting.rows[0].id).reasons).toContain('actual_changed');
    } finally { await pool.end(); await owner.query(`DROP SCHEMA ${name} CASCADE`); await owner.end(); }
}, 20000);
