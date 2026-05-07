'use strict';

/**
 * api_kanban_dependencies POST race-window hardening (PR-DCC).
 *
 * Mac_F sign-off 2026-05-07 β′:
 *   - device-scoped pg_advisory_xact_lock(namespace, hashtext(deviceId))
 *     wraps the exists/cycle/INSERT block
 *   - lock acquired BEFORE BFS so concurrent inserts on the same device
 *     serialize through the same key (closes the transitive-cycle hole that
 *     pair-scoped β had: A→B exists; concurrent B→C and C→A)
 *
 * pg-mem CANNOT prove concurrency (no real PG locking semantics). Under
 * pg-mem we verify SQL ordering (BEGIN → lock → … → COMMIT/ROLLBACK) via a
 * client-query spy. Real-PG concurrency proof is gated behind
 * RUN_PG_INTEGRATION=1 and is intentionally a follow-up; the lock SQL itself
 * is a 1-liner whose semantics are documented in PostgreSQL.
 */

const express = require('express');
const request = require('supertest');
const { bootstrap, insertCard, reset } = require('./__fixtures__/kanban-dep-schema');

const DEVICE = 'dev-a';
const ENTITY_ID = 7;
const BOT_SECRET = 'b';
const auth = { deviceId: DEVICE, entityId: ENTITY_ID, botSecret: BOT_SECRET };

describe('api_kanban_dependencies POST race hardening (PR-DCC)', () => {
    let pool;
    let app;
    let queryLog;

    beforeAll(async () => {
        ({ pool } = await bootstrap());
        const origConnect = pool.connect.bind(pool);
        pool.connect = async (...args) => {
            const client = await origConnect(...args);
            const origQuery = client.query.bind(client);
            client.query = (sql, params) => {
                const head = typeof sql === 'string'
                    ? sql.split('\n')[0].trim()
                    : (sql && sql.text ? sql.text.split('\n')[0].trim() : String(sql));
                queryLog.push(head);
                return origQuery(sql, params);
            };
            return client;
        };

        const factory = require('../../api_kanban_dependencies');
        const devices = {
            [DEVICE]: {
                deviceSecret: 's',
                entities: { [ENTITY_ID]: { botSecret: BOT_SECRET } },
            },
        };
        const { router } = factory(devices, { pool });
        app = express();
        app.use(express.json());
        app.use('/api/mission', router);
    });

    beforeEach(async () => {
        await reset(pool);
        for (const id of ['A', 'B', 'C']) await insertCard(pool, id, DEVICE);
        queryLog = [];
    });

    test('happy POST runs BEGIN → lock → INSERT → COMMIT in order', async () => {
        const res = await request(app)
            .post('/api/mission/card/A/dependency')
            .send({ ...auth, dependsOnCardId: 'B' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, created: true });

        const ix = (re) => queryLog.findIndex((s) => re.test(s));
        const beginIdx = ix(/^BEGIN/i);
        const lockIdx = ix(/pg_advisory_xact_lock/);
        const insertIdx = ix(/^INSERT INTO kanban_card_dependencies/);
        const commitIdx = ix(/^COMMIT/i);

        expect(beginIdx).toBeGreaterThanOrEqual(0);
        expect(lockIdx).toBeGreaterThan(beginIdx);
        expect(insertIdx).toBeGreaterThan(lockIdx);
        expect(commitIdx).toBeGreaterThan(insertIdx);
    });

    test('cycle rejection ROLLBACKs the transaction (no commit)', async () => {
        await pool.query(
            `INSERT INTO kanban_card_dependencies (device_id, card_id, depends_on_card_id) VALUES ($1, $2, $3)`,
            [DEVICE, 'A', 'B']
        );
        queryLog = [];
        const res = await request(app)
            .post('/api/mission/card/B/dependency')
            .send({ ...auth, dependsOnCardId: 'A' });
        expect(res.status).toBe(400);
        expect(res.body.cycleDetected).toBe(true);

        const hasLock = queryLog.some((s) => /pg_advisory_xact_lock/.test(s));
        const hasRollback = queryLog.some((s) => /^ROLLBACK/i.test(s));
        const hasCommit = queryLog.some((s) => /^COMMIT/i.test(s));
        expect(hasLock).toBe(true);
        expect(hasRollback).toBe(true);
        expect(hasCommit).toBe(false);
    });

    test('source-card 404 ROLLBACKs after lock acquired (no inserts)', async () => {
        const res = await request(app)
            .post('/api/mission/card/NOPE/dependency')
            .send({ ...auth, dependsOnCardId: 'B' });
        expect(res.status).toBe(404);
        const hasLock = queryLog.some((s) => /pg_advisory_xact_lock/.test(s));
        const hasInsert = queryLog.some((s) => /^INSERT INTO kanban_card_dependencies/.test(s));
        const hasRollback = queryLog.some((s) => /^ROLLBACK/i.test(s));
        expect(hasLock).toBe(true);
        expect(hasInsert).toBe(false);
        expect(hasRollback).toBe(true);
    });

    test('idempotent re-POST (existing edge) still COMMITs the no-op tx', async () => {
        await pool.query(
            `INSERT INTO kanban_card_dependencies (device_id, card_id, depends_on_card_id) VALUES ($1, $2, $3)`,
            [DEVICE, 'A', 'B']
        );
        queryLog = [];
        const res = await request(app)
            .post('/api/mission/card/A/dependency')
            .send({ ...auth, dependsOnCardId: 'B' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, created: false });
        const hasLock = queryLog.some((s) => /pg_advisory_xact_lock/.test(s));
        const hasCommit = queryLog.some((s) => /^COMMIT/i.test(s));
        expect(hasLock).toBe(true);
        expect(hasCommit).toBe(true);
    });
});

// Real-PG concurrency proof — only runs against a real PG instance because
// pg-mem cannot model `pg_advisory_xact_lock` blocking semantics. Set
// RUN_PG_INTEGRATION=1 and DATABASE_URL to enable. Intentionally a placeholder
// scaffold; full harness lives in a follow-up.
const REAL_PG = process.env.RUN_PG_INTEGRATION === '1';
const describeReal = REAL_PG ? describe : describe.skip;

describeReal('api_kanban_dependencies POST concurrent race (real PG only)', () => {
    test.skip('two parallel POSTs creating a transitive cycle: only one wins', () => {
        // Scaffold for follow-up. Expected shape:
        //   1. seed cards A,B,C and edge A→B
        //   2. fire POST B→C and POST C→A in parallel
        //   3. assert exactly one POST returns 200, the other returns
        //      400 cycleDetected, and the final graph contains exactly two edges
        //      (no C→A→B→C cycle).
    });
});
