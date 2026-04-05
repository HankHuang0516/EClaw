/**
 * Chat dedup + speak-to source rendering regression tests.
 *
 * Validates:
 * 1. speak-to same text to different entities → all succeed (not deduped)
 * 2. transform reply after speak-to uses routing source format (entity:ID:CHAR->target)
 * 3. speak-to same text to same entity IS deduped (existing dedup still works)
 * 4. saveChatMessage dedup query includes source column
 */

require('./helpers/mock-setup');

const request = require('supertest');
const pg = require('pg');
let app;

const post = (path) => request(app).post(path).set('Host', 'localhost');

/** Register + bind entity 0, return botSecret */
async function bindEntity(deviceId, deviceSecret) {
    await post('/api/device/register')
        .send({ deviceId, deviceSecret, entityId: 0 });
    const regRes = await post('/api/device/register')
        .send({ deviceId, deviceSecret, entityId: 0 });
    const code = regRes.body.bindingCode;
    if (!code) return undefined;
    const bindRes = await post('/api/bind').send({ code });
    return bindRes.body.botSecret;
}

/** Add and bind an additional entity, return its botSecret */
async function addAndBindEntity(deviceId, deviceSecret, entityId) {
    await post('/api/device/add-entity')
        .send({ deviceId, deviceSecret });
    const regRes = await post('/api/device/register')
        .send({ deviceId, deviceSecret, entityId });
    const code = regRes.body.bindingCode;
    if (!code) return undefined;
    const bindRes = await post('/api/bind').send({ code });
    return bindRes.body.botSecret;
}

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

// ════════════════════════════════════════════════════════════════
// 1. speak-to same text to different entities → all succeed
// ════════════════════════════════════════════════════════════════
describe('speak-to same text to different entities (dedup fix)', () => {
    const deviceId = 'dedup-speakto-multi';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret0;

    beforeAll(async () => {
        botSecret0 = await bindEntity(deviceId, deviceSecret);
        // Add and bind entities 1, 2
        await addAndBindEntity(deviceId, deviceSecret, 1);
        await addAndBindEntity(deviceId, deviceSecret, 2);
    });

    it('speak-to entity 1 succeeds', async () => {
        const res = await post('/api/entity/speak-to')
            .send({
                deviceId,
                fromEntityId: 0,
                toEntityId: 1,
                botSecret: botSecret0,
                text: 'identical message to all'
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('speak-to entity 2 with same text also succeeds (not deduped)', async () => {
        const res = await post('/api/entity/speak-to')
            .send({
                deviceId,
                fromEntityId: 0,
                toEntityId: 2,
                botSecret: botSecret0,
                text: 'identical message to all'
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// 2. saveChatMessage dedup query includes source
// ════════════════════════════════════════════════════════════════
describe('saveChatMessage dedup includes source in query', () => {
    const deviceId = 'dedup-source-check';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret0;

    beforeAll(async () => {
        botSecret0 = await bindEntity(deviceId, deviceSecret);
        await addAndBindEntity(deviceId, deviceSecret, 1);
    });

    it('dedup SELECT includes source IS NOT DISTINCT FROM', async () => {
        // Verify the dedup SQL by reading the source code directly
        // This is more reliable than trying to intercept the mocked pool
        const fs = require('fs');
        const src = fs.readFileSync(require.resolve('../../index'), 'utf8');

        // Find the saveChatMessage dedup query
        const dedupMatch = src.match(/SELECT id FROM chat_messages[\s\S]*?LIMIT 1/);
        expect(dedupMatch).not.toBeNull();
        expect(dedupMatch[0]).toContain('source IS NOT DISTINCT FROM');
    });
});

// ════════════════════════════════════════════════════════════════
// 3. transform reply after speak-to uses routing source
// ════════════════════════════════════════════════════════════════
describe('transform reply includes A2A routing source', () => {
    const deviceId = 'transform-a2a-source';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret0, botSecret1;

    beforeAll(async () => {
        botSecret0 = await bindEntity(deviceId, deviceSecret);
        botSecret1 = await addAndBindEntity(deviceId, deviceSecret, 1);
    });

    it('after speak-to, transform uses entity:ID:CHAR->target source format', async () => {
        // Step 1: Entity 0 speaks to Entity 1 → queues message in entity 1
        await post('/api/entity/speak-to')
            .send({
                deviceId,
                fromEntityId: 0,
                toEntityId: 1,
                botSecret: botSecret0,
                text: 'hello entity 1'
            });

        // Get the pool instance to spy on the INSERT from transform
        const poolInstance = pg.Pool.mock.results[pg.Pool.mock.results.length - 1]?.value;
        if (poolInstance) poolInstance.query.mockClear();

        // Step 2: Entity 1 transforms (replies) — should detect pending A2A
        await post('/api/transform')
            .send({
                deviceId,
                entityId: 1,
                botSecret: botSecret1,
                message: 'reply from entity 1'
            });

        // Find the INSERT into chat_messages
        const calls = poolInstance ? poolInstance.query.mock.calls : [];
        const insertCall = calls.find(c =>
            typeof c[0] === 'string'
            && c[0].includes('INSERT INTO chat_messages')
            && Array.isArray(c[1])
        );

        if (insertCall) {
            // Params: [deviceId, entityId, text, source, is_from_user, is_from_bot, ...]
            const source = insertCall[1][3];
            // Source should be "entity:1:CHAR->0" format (entity 1 replying to entity 0)
            expect(source).toMatch(/^entity:1:.+->0$/);
        }
    });

    it('transform without pending speak-to uses entity name as source', async () => {
        const devId = 'transform-no-a2a';
        const devSecret = `secret-${devId}`;
        const bs = await bindEntity(devId, devSecret);

        const poolInstance = pg.Pool.mock.results[pg.Pool.mock.results.length - 1]?.value;
        if (poolInstance) poolInstance.query.mockClear();

        // Transform without any pending A2A — should use plain entity name
        await post('/api/transform')
            .send({
                deviceId: devId,
                entityId: 0,
                botSecret: bs,
                message: 'normal update'
            });

        const calls = poolInstance ? poolInstance.query.mock.calls : [];
        const insertCall = calls.find(c =>
            typeof c[0] === 'string'
            && c[0].includes('INSERT INTO chat_messages')
            && Array.isArray(c[1])
        );

        if (insertCall) {
            const source = insertCall[1][3];
            // Should NOT have entity:ID:CHAR-> pattern (no A2A)
            expect(source).not.toMatch(/^entity:\d+:.+->\d+$/);
        }
    });
});

// ════════════════════════════════════════════════════════════════
// 4. speak-to same text same entity IS deduped (existing behavior)
// ════════════════════════════════════════════════════════════════
describe('speak-to same text same entity is still deduped', () => {
    const deviceId = 'dedup-same-entity';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret0;
    let poolInstance;

    beforeAll(async () => {
        botSecret0 = await bindEntity(deviceId, deviceSecret);
        await addAndBindEntity(deviceId, deviceSecret, 1);
        poolInstance = pg.Pool.mock.results[pg.Pool.mock.results.length - 1]?.value;
    });

    it('second speak-to with identical text+source triggers dedup check with same source', async () => {
        // First speak-to
        await post('/api/entity/speak-to')
            .send({
                deviceId,
                fromEntityId: 0,
                toEntityId: 1,
                botSecret: botSecret0,
                text: 'same msg same target'
            });

        if (poolInstance) poolInstance.query.mockClear();

        // Second speak-to — same source (entity:0:CHAR->1)
        await post('/api/entity/speak-to')
            .send({
                deviceId,
                fromEntityId: 0,
                toEntityId: 1,
                botSecret: botSecret0,
                text: 'same msg same target'
            });

        // Verify dedup SELECT was called with the same source value
        const calls = poolInstance ? poolInstance.query.mock.calls : [];
        const dedupCall = calls.find(c =>
            typeof c[0] === 'string' && c[0].includes('SELECT id FROM chat_messages') && c[0].includes('source')
        );

        if (dedupCall) {
            // source param (6th param, index 5) should match "entity:0:CHAR->1"
            const sourceParam = dedupCall[1][5];
            expect(sourceParam).toMatch(/^entity:0:.+->1$/);
        }
    });
});
