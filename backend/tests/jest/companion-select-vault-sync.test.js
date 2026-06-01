'use strict';

/**
 * Companion API — POST /api/companion/select atomic vault-sync tests.
 *
 * Spec: docs/specs/petdx-uiux-spec-amendment-2026-05-31-phase-0-4a.md §0.4a.
 *
 * The §0.4a invariant is "no partial success". This file covers the four
 * spec-mandated cases:
 *
 *   1. Happy path — both the companion_select_log row (with
 *      origin='user-selected') AND the three PETDX_*_<id> vault keys are
 *      written. The response echoes the resolved avatarUrl.
 *   2. Vault write throws — the log tx ROLLBACKs and no log row lands;
 *      response is 500 {layer:'vault'}.
 *   3. Log COMMIT throws — the prior vault values are restored; response
 *      is 500 {layer:'log'}.
 *   4. Descriptor URL resolution — the avatar URL written into the vault
 *      comes from companions.avatar_url first, then descriptor.avatar.url,
 *      then the static-path fallback.
 *
 * The pg mock here is richer than the one in companion-api.test.js because
 * the §0.4a path uses pool.connect() + tx semantics.
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
const { __mockQuery, __mockClientQuery, __mockRelease } = require('pg');
const companionFactory = require('../../companion-api');

const DEVICE = 'dev-vault-test';
const ENTITY = 7;
const SECRET = 'good-secret';

function makeIoMock(initialVars = {}) {
    const vars = { ...initialVars };
    const writes = [];
    return {
        vars,
        writes,
        instance: {
            async getDeviceVar(_deviceId, key) {
                return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : null;
            },
            async setDeviceVars(_deviceId, entries) {
                writes.push({ ...entries });
                for (const [k, v] of Object.entries(entries)) vars[k] = v;
            },
            log: () => {},
            appendCompanionSelectLog: async () => {},
        },
    };
}

function makeApp({ ioMock, ioFactoryFails = false } = {}) {
    const app = express();
    app.use(express.json());
    const authBot = (d, e, s) => d === DEVICE && e === ENTITY && s === SECRET;
    const authDevOrBot = ({ deviceId, botSecret, entityId }) =>
        deviceId === DEVICE && botSecret === SECRET && entityId === ENTITY;
    const mod = companionFactory({
        authenticateBot: authBot,
        authenticateDeviceOrBot: authDevOrBot,
        createPetdxPhase0Io: ioFactoryFails
            ? () => { throw new Error('factory boom'); }
            : () => ioMock.instance,
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
    __mockRelease.mockReset();
});

describe('POST /api/companion/select — §0.4a atomic vault sync', () => {
    test('happy path: log row + 3 vault keys written; response echoes avatarUrl + origin', async () => {
        const ioMock = makeIoMock();
        __mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [COMPANION_ROW_PUBLISHED] }); // companion lookup
        __mockClientQuery
            .mockResolvedValueOnce({})  // BEGIN
            .mockResolvedValueOnce({})  // INSERT
            .mockResolvedValueOnce({}); // COMMIT

        const res = await request(makeApp({ ioMock }))
            .post('/api/companion/select')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ companionId: 'petdx-zoro', source: 'app' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.selection.companionId).toBe('petdx-zoro');
        expect(res.body.selection.source).toBe('app');
        expect(res.body.selection.origin).toBe('user-selected');
        expect(res.body.selection.avatarUrl).toBe('https://r2.example/zoro/avatar.png');

        // tx ordering: BEGIN, INSERT, COMMIT
        expect(__mockClientQuery.mock.calls[0][0]).toBe('BEGIN');
        expect(__mockClientQuery.mock.calls[1][0]).toMatch(/INSERT INTO companion_select_log/);
        expect(__mockClientQuery.mock.calls[1][0]).toMatch(/origin/);
        expect(__mockClientQuery.mock.calls[1][1]).toEqual([
            DEVICE, ENTITY, 'petdx-zoro', expect.any(Number), 'app', 'user-selected',
        ]);
        expect(__mockClientQuery.mock.calls[2][0]).toBe('COMMIT');

        // vault: one batched setDeviceVars with the three keys
        expect(ioMock.writes).toHaveLength(1);
        expect(ioMock.writes[0]).toEqual({
            [`PETDX_CURRENT_${ENTITY}`]: 'petdx-zoro',
            [`PETDX_AVATAR_${ENTITY}`]:  'https://r2.example/zoro/avatar.png',
            [`PETDX_SOURCE_${ENTITY}`]:  'user-selected',
        });
        // client released exactly once
        expect(__mockRelease).toHaveBeenCalledTimes(1);
    });

    test('vault write throws → ROLLBACK log tx, response 500 {layer:vault}', async () => {
        const ioMock = makeIoMock({
            [`PETDX_CURRENT_${ENTITY}`]: 'petdx-lobster-default',
            [`PETDX_AVATAR_${ENTITY}`]: '/static/companions/petdx-lobster-default/avatar.png',
            [`PETDX_SOURCE_${ENTITY}`]: 'phase0-backfill',
        });
        // Override setDeviceVars to throw on the FIRST call only (so restore
        // path doesn't run — there's nothing to restore yet).
        let writeCount = 0;
        ioMock.instance.setDeviceVars = async () => {
            writeCount++;
            throw new Error('vault disk full');
        };

        __mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [COMPANION_ROW_PUBLISHED] });
        __mockClientQuery
            .mockResolvedValueOnce({})  // BEGIN
            .mockResolvedValueOnce({})  // INSERT
            .mockResolvedValueOnce({}); // ROLLBACK

        const res = await request(makeApp({ ioMock }))
            .post('/api/companion/select')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ companionId: 'petdx-zoro', source: 'app' });

        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.layer).toBe('vault');

        // Last client query MUST be ROLLBACK
        const last = __mockClientQuery.mock.calls[__mockClientQuery.mock.calls.length - 1];
        expect(last[0]).toBe('ROLLBACK');
        // Never COMMITted
        expect(__mockClientQuery.mock.calls.every(c => c[0] !== 'COMMIT')).toBe(true);
        expect(writeCount).toBe(1);
        expect(__mockRelease).toHaveBeenCalledTimes(1);
    });

    test('log COMMIT throws → prior vault values restored, response 500 {layer:log}', async () => {
        const PRIOR = {
            [`PETDX_CURRENT_${ENTITY}`]: 'petdx-lobster-default',
            [`PETDX_AVATAR_${ENTITY}`]: '/static/companions/petdx-lobster-default/avatar.png',
            [`PETDX_SOURCE_${ENTITY}`]: 'phase0-backfill',
        };
        const ioMock = makeIoMock(PRIOR);

        __mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [COMPANION_ROW_PUBLISHED] });
        __mockClientQuery
            .mockResolvedValueOnce({})                                          // BEGIN
            .mockResolvedValueOnce({})                                          // INSERT
            .mockRejectedValueOnce(new Error('connection lost during commit')); // COMMIT throws

        const res = await request(makeApp({ ioMock }))
            .post('/api/companion/select')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ companionId: 'petdx-zoro', source: 'app' });

        expect(res.status).toBe(500);
        expect(res.body.layer).toBe('log');

        // Vault: two writes — the forward write, then the restore back to prior.
        expect(ioMock.writes).toHaveLength(2);
        expect(ioMock.writes[1]).toEqual(PRIOR);
        // And the in-memory vault state is back at prior values:
        expect(ioMock.vars).toEqual(PRIOR);
        expect(__mockRelease).toHaveBeenCalledTimes(1);
    });

    test('avatar URL preference: avatar_url column wins over descriptor.avatar.url', async () => {
        const ioMock = makeIoMock();
        __mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{
            id: 'petdx-x', status: 'published', scope: 'system',
            device_id: null, author_entity_id: null,
            avatar_url: '/explicit/avatar.png',
            descriptor: { avatar: { url: '/from/descriptor.png' } },
        }] });
        __mockClientQuery
            .mockResolvedValueOnce({})  // BEGIN
            .mockResolvedValueOnce({})  // INSERT
            .mockResolvedValueOnce({}); // COMMIT

        const res = await request(makeApp({ ioMock }))
            .post('/api/companion/select')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ companionId: 'petdx-x', source: 'app' });

        expect(res.status).toBe(200);
        expect(ioMock.vars[`PETDX_AVATAR_${ENTITY}`]).toBe('/explicit/avatar.png');
    });

    test('avatar URL preference: descriptor.avatar.url wins when avatar_url column is null', async () => {
        const ioMock = makeIoMock();
        __mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{
            id: 'petdx-x', status: 'published', scope: 'system',
            device_id: null, author_entity_id: null,
            avatar_url: null,
            descriptor: { avatar: { url: '/from/descriptor.png' } },
        }] });
        __mockClientQuery
            .mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({});

        await request(makeApp({ ioMock }))
            .post('/api/companion/select')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ companionId: 'petdx-x', source: 'app' });

        expect(ioMock.vars[`PETDX_AVATAR_${ENTITY}`]).toBe('/from/descriptor.png');
    });

    test('avatar URL preference: static-path fallback when both are missing', async () => {
        const ioMock = makeIoMock();
        __mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{
            id: 'petdx-lobster-default', status: 'published', scope: 'system',
            device_id: null, author_entity_id: null,
            avatar_url: null,
            descriptor: { description: 'procedural-only, no avatar shape' },
        }] });
        __mockClientQuery
            .mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({});

        await request(makeApp({ ioMock }))
            .post('/api/companion/select')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ companionId: 'petdx-lobster-default', source: 'app' });

        expect(ioMock.vars[`PETDX_AVATAR_${ENTITY}`])
            .toBe('/static/companions/petdx-lobster-default/avatar.png');
    });

    test('device-secret auth (entityId=null) skips vault write but still fills log + origin', async () => {
        const ioMock = makeIoMock();
        // No __mockClientQuery responses — should never be called.
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 1, rows: [COMPANION_ROW_PUBLISHED] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // legacy INSERT via pool.query

        // Override the auth predicate so deviceSecret-only succeeds with entityId=null.
        const app = express();
        app.use(express.json());
        const mod = companionFactory({
            authenticateBot: (d, e, s) => false,
            authenticateDeviceOrBot: ({ deviceId, deviceSecret }) =>
                deviceId === DEVICE && deviceSecret === 'dev-secret',
            createPetdxPhase0Io: () => ioMock.instance,
        });
        app.use('/api/companion', mod.router);

        const res = await request(app)
            .post('/api/companion/select')
            .query({ deviceId: DEVICE, deviceSecret: 'dev-secret' })  // no entityId
            .send({ companionId: 'petdx-zoro', source: 'app' });

        expect(res.status).toBe(200);
        expect(res.body.selection.companionId).toBe('petdx-zoro');
        // Vault must NOT be touched.
        expect(ioMock.writes).toHaveLength(0);
        // Log INSERT used the legacy pool.query path.
        expect(__mockClientQuery).not.toHaveBeenCalled();
        const insert = __mockQuery.mock.calls[1];
        expect(insert[0]).toMatch(/INSERT INTO companion_select_log/);
        // entityId column gets null since none was provided.
        expect(insert[1]).toEqual([
            DEVICE, null, 'petdx-zoro', expect.any(Number), 'app', 'user-selected',
        ]);
    });

    test('factory-not-injected fallback: legacy log-only INSERT (origin still written, no vault writes)', async () => {
        // No createPetdxPhase0Io passed → legacy code path.
        const app = (() => {
            const a = express();
            a.use(express.json());
            const mod = companionFactory({
                authenticateBot: (d, e, s) => d === DEVICE && e === ENTITY && s === SECRET,
                authenticateDeviceOrBot: ({ deviceId, botSecret, entityId }) =>
                    deviceId === DEVICE && botSecret === SECRET && entityId === ENTITY,
            });
            a.use('/api/companion', mod.router);
            return a;
        })();

        __mockQuery
            .mockResolvedValueOnce({ rowCount: 1, rows: [COMPANION_ROW_PUBLISHED] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });

        const res = await request(app)
            .post('/api/companion/select')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ companionId: 'petdx-zoro', source: 'app' });

        expect(res.status).toBe(200);
        // Legacy path uses pool.query, NOT pool.connect; the second
        // pool.query call is the INSERT (origin column included).
        const insert = __mockQuery.mock.calls[1];
        expect(insert[0]).toMatch(/INSERT INTO companion_select_log/);
        expect(insert[0]).toMatch(/origin/);
        expect(insert[1]).toEqual([
            DEVICE, ENTITY, 'petdx-zoro', expect.any(Number), 'app', 'user-selected',
        ]);
        // No client.connect calls in legacy path.
        expect(__mockClientQuery).not.toHaveBeenCalled();
    });
});
