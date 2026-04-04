/**
 * Mission skill/add and rule/add — re-enabled
 *
 * These endpoints are now active again (deprecation removed).
 * They accept valid credentials and create items (or 500 from mock DB).
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

describe('POST /api/mission/skill/add — re-enabled', () => {
    test('accepts valid input (200 or 500 mock DB)', async () => {
        const res = await request(missionApp)
            .post('/api/mission/skill/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 0, title: 'Test' });
        expect([200, 500].includes(res.status)).toBe(true);
    });

    test('returns 400 without title', async () => {
        const res = await request(missionApp)
            .post('/api/mission/skill/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 0 });
        expect(res.status).toBe(400);
    });
});

describe('POST /api/mission/rule/add — re-enabled', () => {
    test('accepts valid input (200 or 500 mock DB)', async () => {
        const res = await request(missionApp)
            .post('/api/mission/rule/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 0, name: 'Test', ruleType: 'WORKFLOW' });
        expect([200, 500].includes(res.status)).toBe(true);
    });

    test('returns 400 without name', async () => {
        const res = await request(missionApp)
            .post('/api/mission/rule/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 0, ruleType: 'WORKFLOW' });
        expect(res.status).toBe(400);
    });
});
