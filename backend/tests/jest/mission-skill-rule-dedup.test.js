/**
 * Mission skill/add and rule/add — deprecated (→ Kanban)
 *
 * These endpoints now return 410 Gone to redirect users to the Kanban board.
 * The deduplication logic is preserved but unreachable.
 */

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        connect: jest.fn().mockResolvedValue({
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

const express = require('express');
const request = require('supertest');

const DEVICE_ID = 'dedup-test-device-' + Math.random().toString(36).slice(2, 8);

let missionApp;

beforeAll(() => {
    const devices = {};
    devices[DEVICE_ID] = {
        deviceSecret: 'secret',
        entities: { 0: { name: 'Bot0' }, 1: { name: 'Bot1' }, 2: { name: 'Bot2' } },
    };

    const missionModule = require('../../mission');
    const { router } = missionModule(devices, { awardEntityXP: jest.fn(), serverLog: jest.fn() });

    missionApp = express();
    missionApp.use(express.json());
    missionApp.use('/api/mission', router);
});

describe('POST /api/mission/skill/add — deprecated', () => {
    test('returns 410 with kanban redirect', async () => {
        const res = await request(missionApp)
            .post('/api/mission/skill/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 0, title: 'Test' });
        expect(res.status).toBe(410);
        expect(res.body.deprecated).toBe(true);
        expect(res.body.redirect).toBe('kanban');
    });
});

describe('POST /api/mission/rule/add — deprecated', () => {
    test('returns 410 with kanban redirect', async () => {
        const res = await request(missionApp)
            .post('/api/mission/rule/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 0, name: 'Test', ruleType: 'WORKFLOW' });
        expect(res.status).toBe(410);
        expect(res.body.deprecated).toBe(true);
        expect(res.body.redirect).toBe('kanban');
    });
});
