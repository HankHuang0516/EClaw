'use strict';

/**
 * Companion API — POST /api/companion/select source-of-truth tests.
 *
 * Spec: docs/specs/petdx-uiux-spec-amendment-2026-05-31-phase-0-4a.md §0.4a.
 *
 * PR-B (SoT refactor): companion_select_log is the single source of truth.
 * /api/companion/select is now a single INSERT (origin='user-selected') with
 * no per-entity PETDX_*_<id> vault mirror and no cross-pool tx. These tests
 * cover:
 *
 *   1. Happy path — one companion_select_log INSERT; the response echoes the
 *      resolved avatarUrl + origin. No vault writes happen.
 *   2. INSERT failure — response is 500 {error:'query_failed'}.
 *   3. Avatar URL resolution — the avatarUrl echoed in the response comes from
 *      companions.avatar_url first, then descriptor.avatar.url, then the
 *      static-path fallback.
 *   4. device-secret auth (entityId=null) — the log row carries a null
 *      entity_id and the same single-INSERT path is used.
 */

jest.mock('pg', () => {
    const mockQuery = jest.fn();
    const mockClientQuery = jest.fn();
    const mockRelease = jest.fn();
    const Pool = jest.fn().mockImplementation(() => ({
        query: mockQuery,
        connect: jest.fn().mockResolvedValue({
            query: mockClientQuery,
            release: mockRelease,
        }),
        end: jest.fn(),
    }));
    return {
        Pool,
        __mockQuery: mockQuery,
        __mockClientQuery: mockClientQuery,
        __mockRelease: mockRelease,
    };
});

const express = require('express');
const request = require('supertest');
const { __mockQuery, __mockClientQuery } = require('pg');
const companionFactory = require('../../companion-api');

const DEVICE = 'dev-vault-test';
const ENTITY = 7;
const SECRET = 'good-secret';

function makeApp() {
    const app = express();
    app.use(express.json());
    const authBot = (d, e, s) => d === DEVICE && e === ENTITY && s === SECRET;
    const authDevOrBot = ({ deviceId, botSecret, entityId }) =>
        deviceId === DEVICE && botSecret === SECRET && entityId === ENTITY;
    const mod = companionFactory({
        authenticateBot: authBot,
        authenticateDeviceOrBot: authDevOrBot,
    });
    app.use('/api/companion', mod.router);
    return app;
}

const COMPANION_ROW_PUBLISHED = {
    id: 'petdx-zoro', status: 'published', scope: 'community',
    device_id: null, author_entity_id: null,
    avatar_url: 'https://r2.example/zoro/avatar.png',
    descriptor: { avatar: { url: 'https://r2.example/zoro/descriptor.png' } },
};

beforeEach(() => {
    __mockQuery.mockReset();
    __mockClientQuery.mockReset();
});

describe('POST /api/companion/select — §0.4a companion_select_log SoT', () => {
    test('happy path: single log INSERT; response echoes avatarUrl + origin; no vault', async () => {
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 1, rows: [COMPANION_ROW_PUBLISHED] }) // companion lookup
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });                       // INSERT

        const res = await request(makeApp())
            .post('/api/companion/select')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ companionId: 'petdx-zoro', source: 'app' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.selection.companionId).toBe('petdx-zoro');
        expect(res.body.selection.source).toBe('app');
        expect(res.body.selection.origin).toBe('user-selected');
        expect(res.body.selection.avatarUrl).toBe('https://r2.example/zoro/avatar.png');

        // Single INSERT via pool.query — no tx, no pool.connect.
        const insert = __mockQuery.mock.calls[1];
        expect(insert[0]).toMatch(/INSERT INTO companion_select_log/);
        expect(insert[0]).toMatch(/origin/);
        expect(insert[1]).toEqual([
            DEVICE, ENTITY, 'petdx-zoro', expect.any(Number), 'app', 'user-selected',
        ]);
        expect(__mockClientQuery).not.toHaveBeenCalled();
    });

    test('INSERT failure → response 500 {error:query_failed}', async () => {
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 1, rows: [COMPANION_ROW_PUBLISHED] })
            .mockRejectedValueOnce(new Error('insert disk full'));

        const res = await request(makeApp())
            .post('/api/companion/select')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ companionId: 'petdx-zoro', source: 'app' });

        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('query_failed');
        expect(__mockClientQuery).not.toHaveBeenCalled();
    });

    test('avatar URL preference: avatar_url column wins over descriptor.avatar.url', async () => {
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 1, rows: [{
                id: 'petdx-x', status: 'published', scope: 'system',
                device_id: null, author_entity_id: null,
                avatar_url: '/explicit/avatar.png',
                descriptor: { avatar: { url: '/from/descriptor.png' } },
            }] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });

        const res = await request(makeApp())
            .post('/api/companion/select')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ companionId: 'petdx-x', source: 'app' });

        expect(res.status).toBe(200);
        expect(res.body.selection.avatarUrl).toBe('/explicit/avatar.png');
    });

    test('avatar URL preference: descriptor.avatar.url wins when avatar_url column is null', async () => {
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 1, rows: [{
                id: 'petdx-x', status: 'published', scope: 'system',
                device_id: null, author_entity_id: null,
                avatar_url: null,
                descriptor: { avatar: { url: '/from/descriptor.png' } },
            }] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });

        const res = await request(makeApp())
            .post('/api/companion/select')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ companionId: 'petdx-x', source: 'app' });

        expect(res.body.selection.avatarUrl).toBe('/from/descriptor.png');
    });

    test('avatar URL preference: static-path fallback when both are missing', async () => {
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 1, rows: [{
                id: 'petdx-lobster-default', status: 'published', scope: 'system',
                device_id: null, author_entity_id: null,
                avatar_url: null,
                descriptor: { description: 'procedural-only, no avatar shape' },
            }] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });

        const res = await request(makeApp())
            .post('/api/companion/select')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ companionId: 'petdx-lobster-default', source: 'app' });

        expect(res.body.selection.avatarUrl)
            .toBe('/static/companions/petdx-lobster-default/avatar.png');
    });

    test('device-secret auth (entityId=null) writes a log row with null entity_id', async () => {
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 1, rows: [COMPANION_ROW_PUBLISHED] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });

        const app = express();
        app.use(express.json());
        const mod = companionFactory({
            authenticateBot: (d, e, s) => false,
            authenticateDeviceOrBot: ({ deviceId, deviceSecret }) =>
                deviceId === DEVICE && deviceSecret === 'dev-secret',
        });
        app.use('/api/companion', mod.router);

        const res = await request(app)
            .post('/api/companion/select')
            .query({ deviceId: DEVICE, deviceSecret: 'dev-secret' })  // no entityId
            .send({ companionId: 'petdx-zoro', source: 'app' });

        expect(res.status).toBe(200);
        expect(res.body.selection.companionId).toBe('petdx-zoro');
        const insert = __mockQuery.mock.calls[1];
        expect(insert[0]).toMatch(/INSERT INTO companion_select_log/);
        expect(insert[1]).toEqual([
            DEVICE, null, 'petdx-zoro', expect.any(Number), 'app', 'user-selected',
        ]);
        expect(__mockClientQuery).not.toHaveBeenCalled();
    });
});
