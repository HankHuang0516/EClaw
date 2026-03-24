/**
 * Regression test: skill/add and rule/add deduplication
 *
 * Verifies that calling /api/mission/skill/add or /api/mission/rule/add
 * multiple times with the same title/name (simulating concurrent multi-entity
 * mission notify responses) results in a single merged item, not duplicates.
 *
 * Uses the same standalone-mission pattern as mission.test.js (no index.js load).
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
const { Pool } = require('pg');

const DEVICE_ID = 'dedup-test-device-' + Math.random().toString(36).slice(2, 8);

let missionApp;
let mockPoolInstance;

beforeAll(() => {
    // Build a devices map with a valid device for auth bypass
    const devices = {};
    devices[DEVICE_ID] = {
        deviceSecret: 'secret',
        entities: { 0: { name: 'Bot0' }, 1: { name: 'Bot1' }, 2: { name: 'Bot2' } },
    };

    // Load the mission module directly (dependency-injected)
    // This triggers `new Pool()` inside mission.js, which uses our mock
    const missionModule = require('../../mission');
    const { router } = missionModule(devices, { awardEntityXP: jest.fn(), serverLog: jest.fn() });

    // Grab the Pool instance that mission.js created
    mockPoolInstance = Pool.mock.results[0].value;

    missionApp = express();
    missionApp.use(express.json());
    missionApp.use('/api/mission', router);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeClient(sharedData) {
    return {
        query: jest.fn(async (sql, params) => {
            const s = sql.trim();
            if (s.startsWith('BEGIN') || s.startsWith('ROLLBACK')) return { rows: [] };
            if (s.startsWith('SELECT init_mission_dashboard')) return { rows: [] };
            if (s.startsWith('COMMIT')) return { rows: [] };

            if (s.startsWith('SELECT * FROM mission_dashboard')) {
                return { rows: [{ skills: [...(sharedData.skills || [])], rules: [...(sharedData.rules || [])] }] };
            }

            if (s.startsWith('UPDATE mission_dashboard')) {
                // params[1] is JSON.stringify(array) — parse it back
                const parsed = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
                if (s.includes('skills =')) {
                    sharedData.skills = parsed;
                } else if (s.includes('rules =')) {
                    sharedData.rules = parsed;
                }
                return { rows: [{ version: 1 }] };
            }

            return { rows: [] };
        }),
        release: jest.fn(),
    };
}

function setupPool(sharedData) {
    mockPoolInstance.connect.mockImplementation(() => Promise.resolve(makeClient(sharedData)));
}

// ── Skill deduplication ───────────────────────────────────────────────────────

describe('POST /api/mission/skill/add — deduplication', () => {
    const TITLE = 'My Shared Skill';

    test('second call with same title merges assignedEntities, no duplicate', async () => {
        const sharedData = { skills: [], rules: [] };
        setupPool(sharedData);

        const r1 = await request(missionApp)
            .post('/api/mission/skill/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 0, title: TITLE });
        expect(r1.status).toBe(200);
        expect(r1.body.success).toBe(true);

        const r2 = await request(missionApp)
            .post('/api/mission/skill/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 1, title: TITLE });
        expect(r2.status).toBe(200);

        const r3 = await request(missionApp)
            .post('/api/mission/skill/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 2, title: TITLE });
        expect(r3.status).toBe(200);

        expect(sharedData.skills).toHaveLength(1);
        expect(sharedData.skills[0].title).toBe(TITLE);
        const assigned = sharedData.skills[0].assignedEntities;
        expect(assigned).toEqual(expect.arrayContaining(['0', '1', '2']));
        expect(assigned).toHaveLength(3);
    });

    test('different titles each create their own skill', async () => {
        const sharedData = { skills: [], rules: [] };
        setupPool(sharedData);

        await request(missionApp)
            .post('/api/mission/skill/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 0, title: 'Skill Alpha' });
        await request(missionApp)
            .post('/api/mission/skill/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 1, title: 'Skill Beta' });

        expect(sharedData.skills).toHaveLength(2);
        expect(sharedData.skills.map(s => s.title)).toEqual(
            expect.arrayContaining(['Skill Alpha', 'Skill Beta'])
        );
    });

    test('case-insensitive title match prevents duplicate', async () => {
        const sharedData = { skills: [], rules: [] };
        setupPool(sharedData);

        await request(missionApp)
            .post('/api/mission/skill/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 0, title: 'My Skill' });
        await request(missionApp)
            .post('/api/mission/skill/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 1, title: 'MY SKILL' });

        expect(sharedData.skills).toHaveLength(1);
    });

    test('same title but different URL creates separate skill', async () => {
        const sharedData = { skills: [], rules: [] };
        setupPool(sharedData);

        await request(missionApp)
            .post('/api/mission/skill/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 0, title: 'My Tool', url: 'https://example.com/v1' });
        await request(missionApp)
            .post('/api/mission/skill/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 1, title: 'My Tool', url: 'https://example.com/v2' });

        expect(sharedData.skills).toHaveLength(2);
    });
});

// ── Rule deduplication ────────────────────────────────────────────────────────

describe('POST /api/mission/rule/add — deduplication', () => {
    const RULE_NAME = 'My Shared Rule';

    test('second call with same name merges assignedEntities, no duplicate', async () => {
        const sharedData = { skills: [], rules: [] };
        setupPool(sharedData);

        const r1 = await request(missionApp)
            .post('/api/mission/rule/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 0, name: RULE_NAME, description: 'desc', ruleType: 'WORKFLOW' });
        expect(r1.status).toBe(200);

        const r2 = await request(missionApp)
            .post('/api/mission/rule/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 1, name: RULE_NAME, description: 'desc', ruleType: 'WORKFLOW' });
        expect(r2.status).toBe(200);

        const r3 = await request(missionApp)
            .post('/api/mission/rule/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 2, name: RULE_NAME, description: 'desc', ruleType: 'WORKFLOW' });
        expect(r3.status).toBe(200);

        expect(sharedData.rules).toHaveLength(1);
        expect(sharedData.rules[0].name).toBe(RULE_NAME);
        const assigned = sharedData.rules[0].assignedEntities;
        expect(assigned).toEqual(expect.arrayContaining(['0', '1', '2']));
        expect(assigned).toHaveLength(3);
    });

    test('case-insensitive name match prevents duplicate', async () => {
        const sharedData = { skills: [], rules: [] };
        setupPool(sharedData);

        await request(missionApp)
            .post('/api/mission/rule/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 0, name: 'my rule' });
        await request(missionApp)
            .post('/api/mission/rule/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 1, name: 'My Rule' });

        expect(sharedData.rules).toHaveLength(1);
    });

    test('fuzzy description match (>=85%) prevents duplicate', async () => {
        const sharedData = { skills: [], rules: [] };
        setupPool(sharedData);

        await request(missionApp)
            .post('/api/mission/rule/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 0, name: 'Approval Rule', description: 'Require manager approval before deployment' });
        await request(missionApp)
            .post('/api/mission/rule/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 1, name: 'Approval Rule', description: 'Require manager approval before deployment.' });

        expect(sharedData.rules).toHaveLength(1);
    });

    test('same name but clearly different description creates separate rule', async () => {
        const sharedData = { skills: [], rules: [] };
        setupPool(sharedData);

        await request(missionApp)
            .post('/api/mission/rule/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 0, name: 'Auth Rule', description: 'Check user permissions before read access' });
        await request(missionApp)
            .post('/api/mission/rule/add')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'secret', entityId: 1, name: 'Auth Rule', description: 'Validate JWT token and refresh if expired on write ops' });

        expect(sharedData.rules).toHaveLength(2);
    });
});
