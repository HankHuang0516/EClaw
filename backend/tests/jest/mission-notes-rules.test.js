/**
 * Regression: GET /api/mission/notes and /api/mission/rules used to read
 * from legacy tables (mission_notes / mission_rules) that receive no writes.
 * All writers target mission_dashboard.{notes,rules} (JSON columns).
 * These tests lock in the fix by asserting:
 *   - the handler queries mission_dashboard, NOT the legacy tables
 *   - query param filters (category / type) still work
 */

jest.mock('pg', () => {
    const state = {
        // Keyed by deviceId so we can simulate a populated dashboard row.
        dashboard: {
            'dev-alpha': {
                notes: [
                    { id: 'n1', title: 'Alpha', content: 'a', category: 'general', updatedAt: 2000 },
                    { id: 'n2', title: 'Beta',  content: 'b', category: 'work',    updatedAt: 3000 },
                    { id: 'n3', title: 'Gamma', content: 'g', category: 'general', updatedAt: 1000 },
                ],
                rules: [
                    { id: 'r1', name: 'Low',  ruleType: 'WORKFLOW',  priority: 1, createdAt: 100 },
                    { id: 'r2', name: 'High', ruleType: 'WORKFLOW',  priority: 10, createdAt: 200 },
                    { id: 'r3', name: 'Mid',  ruleType: 'STYLE',     priority: 5, createdAt: 150 },
                    // Legacy shape: snake_case field name for backwards-compat.
                    { id: 'r4', name: 'Legacy', rule_type: 'STYLE',  priority: 3, createdAt: 50 },
                ],
            },
        },
        lastQuery: null,
    };
    globalThis.__missionState = state;

    function runQuery(sql, params = []) {
        const norm = sql.replace(/\s+/g, ' ').trim();
        if (!/mission_note_card_links/i.test(norm)) state.lastQuery = { sql, params };

        // This is the regression guard: if the handler ever queries the
        // legacy tables again, bail loudly.
        if (/FROM mission_notes\b/i.test(norm)) {
            throw new Error('REGRESSION: /notes handler queried legacy mission_notes table');
        }
        if (/FROM mission_rules\b/i.test(norm)) {
            throw new Error('REGRESSION: /rules handler queried legacy mission_rules table');
        }

        if (/SELECT notes FROM mission_dashboard/i.test(norm)) {
            const row = state.dashboard[params[0]];
            return { rows: row ? [{ notes: row.notes }] : [], rowCount: row ? 1 : 0 };
        }
        if (/SELECT rules FROM mission_dashboard/i.test(norm)) {
            const row = state.dashboard[params[0]];
            return { rows: row ? [{ rules: row.rules }] : [], rowCount: row ? 1 : 0 };
        }
        if (/FROM mission_note_card_links/i.test(norm)) {
            return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
    }

    const mockPool = { query: jest.fn((sql, params) => runQuery(sql, params)) };
    return { Pool: jest.fn(() => mockPool) };
});

describe('mission API: /notes and /rules read from mission_dashboard JSON column', () => {
    let app;
    beforeAll(() => {
        const express = require('express');
        const missionFactory = require('../../mission');
        const devices = {
            'dev-alpha': {
                deviceId: 'dev-alpha',
                deviceSecret: 'device-secret-alpha',
                entities: { 2: { botSecret: 'bot-secret-commander' } },
            },
            'dev-empty': {
                deviceId: 'dev-empty',
                deviceSecret: 'device-secret-empty',
                entities: { 2: { botSecret: 'bot-secret-empty' } },
            },
        };
        const { router } = missionFactory(devices);
        app = express();
        app.use(express.json());
        app.use('/api/mission', router);
    });

    const request = require('supertest');
    const creds = {
        deviceId: 'dev-alpha',
        botSecret: 'bot-secret-commander',
        entityId: 2,
    };

    test('GET /notes returns all notes sorted by updatedAt desc', async () => {
        const res = await request(app).get('/api/mission/notes').query(creds);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.notes.map(n => n.id)).toEqual(['n2', 'n1', 'n3']);
    });

    test('GET /notes filters by category', async () => {
        const res = await request(app).get('/api/mission/notes').query({ ...creds, category: 'general' });
        expect(res.status).toBe(200);
        expect(res.body.notes.map(n => n.id)).toEqual(['n1', 'n3']);
    });

    test('GET /notes returns empty array when device authed but dashboard row missing', async () => {
        const res = await request(app)
            .get('/api/mission/notes')
            .query({ deviceId: 'dev-empty', botSecret: 'bot-secret-empty', entityId: 2 });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.notes).toEqual([]);
    });

    test('GET /notes rejects unknown deviceId (auth fails)', async () => {
        const res = await request(app)
            .get('/api/mission/notes')
            .query({ deviceId: 'dev-ghost', botSecret: 'bot-secret-commander', entityId: 2 });
        expect(res.status).toBe(401);
    });

    test('GET /rules returns all rules sorted by priority desc', async () => {
        const res = await request(app).get('/api/mission/rules').query(creds);
        expect(res.status).toBe(200);
        expect(res.body.rules.map(r => r.id)).toEqual(['r2', 'r3', 'r4', 'r1']);
    });

    test('GET /rules filters by type (covers both ruleType and legacy rule_type)', async () => {
        const res = await request(app).get('/api/mission/rules').query({ ...creds, type: 'STYLE' });
        expect(res.status).toBe(200);
        // r3 has ruleType=STYLE, r4 has snake_case rule_type=STYLE — both must match.
        expect(res.body.rules.map(r => r.id)).toEqual(['r3', 'r4']);
    });

    test('regression: /notes does NOT query the legacy mission_notes table', async () => {
        await request(app).get('/api/mission/notes').query(creds);
        const { sql } = globalThis.__missionState.lastQuery;
        expect(sql).toMatch(/mission_dashboard/);
        expect(sql).not.toMatch(/\bmission_notes\b/);
    });

    test('regression: /rules does NOT query the legacy mission_rules table', async () => {
        await request(app).get('/api/mission/rules').query(creds);
        const { sql } = globalThis.__missionState.lastQuery;
        expect(sql).toMatch(/mission_dashboard/);
        expect(sql).not.toMatch(/\bmission_rules\b/);
    });
});
