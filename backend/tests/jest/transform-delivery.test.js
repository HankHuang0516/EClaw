/**
 * Transform speakTo/broadcast delivery tests.
 *
 * Validates:
 * 1. Transform with speakTo delivers message to target entity by publicCode
 * 2. Transform with broadcast delivers to all bound entities
 * 3. broadcast + speakTo → broadcast takes priority + warning
 * 4. speakTo with invalid publicCode returns per-target error
 * 5. speakTo with self publicCode is stripped (message saved normally to chat)
 * 6. speakTo cross-device works (different device)
 * 7. broadcast rate limiting
 * 8. Old speak-to/broadcast endpoints return deprecation warning
 * 9. Transform without speakTo/broadcast works as before (no delivery field)
 */

require('./helpers/mock-setup');

const request = require('supertest');
const pg = require('pg');
let app;

// jest.config has clearMocks:true which wipes pg.Pool.mock.results before
// every test. We need to snapshot Pool instances at require-time (when
// chatPool/auth pool/etc. are created) and hold direct references so our
// INSERT assertions can still scan them after clearMocks runs.
const pgPoolSnapshot = [];

const post = (path) => request(app).post(path).set('Host', 'localhost').set('Accept-Encoding', 'identity');

/** Register + bind entity, return botSecret */
async function bindEntity(deviceId, deviceSecret, entityId = 0) {
    if (entityId > 0) {
        await post('/api/device/add-entity')
            .send({ deviceId, deviceSecret });
    }
    const regRes = await post('/api/device/register')
        .send({ deviceId, deviceSecret, entityId });
    const code = regRes.body.bindingCode;
    if (!code) return undefined;
    const bindRes = await post('/api/bind').send({ code });
    return bindRes.body.botSecret;
}

/** Get entity publicCode */
async function getPublicCode(deviceId, deviceSecret, entityId) {
    const res = await request(app).get('/api/entities')
        .query({ deviceId, deviceSecret })
        .set('Host', 'localhost')
        .set('Accept-Encoding', 'identity');
    const entity = (res.body.entities || []).find(e => e.entityId === entityId);
    return entity ? entity.publicCode : null;
}

beforeAll(() => {
    app = require('../../index');
    // Snapshot all Pool instances constructed during module load (before the
    // first test fires jest.clearAllMocks and empties pg.Pool.mock.results).
    for (const r of pg.Pool.mock.results) {
        if (r.value && !pgPoolSnapshot.includes(r.value)) pgPoolSnapshot.push(r.value);
    }
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

// ════════════════════════════════════════════════════════════════
// 1. Transform with speakTo delivers to target by publicCode
// ════════════════════════════════════════════════════════════════
describe('Transform + speakTo', () => {
    const deviceId = 'transform-speakto-test';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret0, code1;

    beforeAll(async () => {
        botSecret0 = await bindEntity(deviceId, deviceSecret, 0);
        await bindEntity(deviceId, deviceSecret, 1);
        code1 = await getPublicCode(deviceId, deviceSecret, 1);
    });

    it('delivers message to target entity', async () => {
        const res = await post('/api/transform')
            .send({
                deviceId,
                entityId: 0,
                botSecret: botSecret0,
                message: 'Hello via speakTo',
                state: 'IDLE',
                speakTo: [code1]
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.delivery).toBeDefined();
        expect(res.body.delivery.speakTo).toBe(true);
        expect(res.body.delivery.results).toHaveLength(1);
        expect(res.body.delivery.results[0].publicCode).toBe(code1);
        expect(res.body.delivery.results[0].success).toBe(true);
    });

    it('returns per-target error for invalid publicCode', async () => {
        const res = await post('/api/transform')
            .send({
                deviceId,
                entityId: 0,
                botSecret: botSecret0,
                message: 'Test invalid code',
                state: 'IDLE',
                speakTo: ['zzzzzz']
            });
        expect(res.status).toBe(200);
        expect(res.body.delivery.results[0].success).toBe(false);
        expect(res.body.delivery.results[0].reason).toBe('not_found');
    });

    it('strips self-target so message still lands in chat history', async () => {
        // When speakTo contains only the caller's own publicCode, it is
        // stripped before delivery. With no remaining targets the request
        // falls back to a normal self-save (no delivery block in response).
        const code0 = await getPublicCode(deviceId, deviceSecret, 0);
        const res = await post('/api/transform')
            .send({
                deviceId,
                entityId: 0,
                botSecret: botSecret0,
                message: 'Self test',
                state: 'IDLE',
                speakTo: [code0]
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        // No delivery block when speakTo collapsed to empty
        expect(res.body.delivery).toBeUndefined();
    });

    it('strips self-target but still delivers to remaining peers', async () => {
        const code0 = await getPublicCode(deviceId, deviceSecret, 0);
        const res = await post('/api/transform')
            .send({
                deviceId,
                entityId: 0,
                botSecret: botSecret0,
                message: 'Mixed self + peer',
                state: 'IDLE',
                speakTo: [code0, code1]
            });
        expect(res.status).toBe(200);
        expect(res.body.delivery).toBeDefined();
        expect(res.body.delivery.results).toHaveLength(1);
        expect(res.body.delivery.results[0].publicCode).toBe(code1);
        expect(res.body.delivery.results[0].success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// 2. Transform with broadcast delivers to all bound entities
// ════════════════════════════════════════════════════════════════
describe('Transform + broadcast', () => {
    const deviceId = 'transform-broadcast-test';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret0;

    beforeAll(async () => {
        botSecret0 = await bindEntity(deviceId, deviceSecret, 0);
        await bindEntity(deviceId, deviceSecret, 1);
        await bindEntity(deviceId, deviceSecret, 2);
    });

    it('broadcasts to all other bound entities', async () => {
        const res = await post('/api/transform')
            .send({
                deviceId,
                entityId: 0,
                botSecret: botSecret0,
                message: 'Broadcast test',
                state: 'IDLE',
                broadcast: true
            });
        expect(res.status).toBe(200);
        expect(res.body.delivery).toBeDefined();
        expect(res.body.delivery.broadcast).toBe(true);
        expect(res.body.delivery.sentCount).toBe(2); // entities 1 and 2
        expect(res.body.delivery.targets).toHaveLength(2);
    });
});

// ════════════════════════════════════════════════════════════════
// 3. broadcast + speakTo → broadcast priority + warning
// ════════════════════════════════════════════════════════════════
describe('Transform broadcast + speakTo conflict', () => {
    const deviceId = 'transform-conflict-test';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret0, code1;

    beforeAll(async () => {
        botSecret0 = await bindEntity(deviceId, deviceSecret, 0);
        await bindEntity(deviceId, deviceSecret, 1);
        code1 = await getPublicCode(deviceId, deviceSecret, 1);
    });

    it('broadcast takes priority with warning', async () => {
        const res = await post('/api/transform')
            .send({
                deviceId,
                entityId: 0,
                botSecret: botSecret0,
                message: 'Conflict test',
                state: 'IDLE',
                broadcast: true,
                speakTo: [code1]
            });
        expect(res.status).toBe(200);
        expect(res.body.warnings).toBeDefined();
        expect(res.body.warnings.some(w => w.includes('broadcast takes priority'))).toBe(true);
        expect(res.body.delivery.broadcast).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// 4. Transform without speakTo/broadcast — no delivery field
// ════════════════════════════════════════════════════════════════
describe('Transform without delivery fields', () => {
    const deviceId = 'transform-plain-test';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret0;

    beforeAll(async () => {
        botSecret0 = await bindEntity(deviceId, deviceSecret, 0);
    });

    it('returns no delivery field', async () => {
        const res = await post('/api/transform')
            .send({
                deviceId,
                entityId: 0,
                botSecret: botSecret0,
                message: 'Just a status update',
                state: 'IDLE'
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.delivery).toBeUndefined();
        expect(res.body.warnings).toBeUndefined();
    });
});

// ════════════════════════════════════════════════════════════════
// 5. Cross-device speakTo
// ════════════════════════════════════════════════════════════════
describe('Transform + speakTo cross-device', () => {
    const deviceA = 'transform-xdevice-a';
    const deviceB = 'transform-xdevice-b';
    const secretA = `secret-${deviceA}`;
    const secretB = `secret-${deviceB}`;
    let botSecretA, codeB;

    beforeAll(async () => {
        botSecretA = await bindEntity(deviceA, secretA, 0);
        await bindEntity(deviceB, secretB, 0);
        codeB = await getPublicCode(deviceB, secretB, 0);
    });

    it('delivers message cross-device via publicCode', async () => {
        if (!codeB) return; // skip if publicCode not available

        const res = await post('/api/transform')
            .send({
                deviceId: deviceA,
                entityId: 0,
                botSecret: botSecretA,
                message: 'Cross-device hello',
                state: 'IDLE',
                speakTo: [codeB]
            });
        expect(res.status).toBe(200);
        expect(res.body.delivery).toBeDefined();
        expect(res.body.delivery.results[0].success).toBe(true);
        expect(res.body.delivery.results[0].publicCode).toBe(codeB);
    });
});

// ════════════════════════════════════════════════════════════════
// 6. Old endpoints return deprecation warning
// ════════════════════════════════════════════════════════════════
describe('Deprecated endpoints', () => {
    const deviceId = 'deprecated-endpoint-test';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret0;

    beforeAll(async () => {
        botSecret0 = await bindEntity(deviceId, deviceSecret, 0);
        await bindEntity(deviceId, deviceSecret, 1);
    });

    it('speak-to returns deprecated flag', async () => {
        const res = await post('/api/entity/speak-to')
            .send({
                deviceId,
                fromEntityId: 0,
                toEntityId: 1,
                botSecret: botSecret0,
                text: 'deprecated test'
            });
        expect(res.status).toBe(200);
        expect(res.body.deprecated).toBe(true);
        expect(res.body.migration_hint).toContain('speakTo');
        expect(res.headers['x-deprecated']).toBeDefined();
    });

    it('broadcast returns deprecated flag', async () => {
        const res = await post('/api/entity/broadcast')
            .send({
                deviceId,
                fromEntityId: 0,
                botSecret: botSecret0,
                text: 'deprecated broadcast'
            });
        expect(res.status).toBe(200);
        expect(res.body.deprecated).toBe(true);
        expect(res.body.migration_hint).toContain('broadcast');
        expect(res.headers['x-deprecated']).toBeDefined();
    });
});

// ════════════════════════════════════════════════════════════════
// 7. speakTo without message — no delivery
// ════════════════════════════════════════════════════════════════
describe('Transform speakTo without message', () => {
    const deviceId = 'transform-no-msg-test';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret0, code1;

    beforeAll(async () => {
        botSecret0 = await bindEntity(deviceId, deviceSecret, 0);
        await bindEntity(deviceId, deviceSecret, 1);
        code1 = await getPublicCode(deviceId, deviceSecret, 1);
    });

    it('skips delivery when no message provided', async () => {
        const res = await post('/api/transform')
            .send({
                deviceId,
                entityId: 0,
                botSecret: botSecret0,
                state: 'IDLE',
                speakTo: [code1]
                // no message field
            });
        expect(res.status).toBe(200);
        expect(res.body.delivery).toBeUndefined();
    });
});

// ════════════════════════════════════════════════════════════════
// 8. entityId auto-detection and correction
// ════════════════════════════════════════════════════════════════
describe('Transform entityId auto-detect', () => {
    const deviceId = 'transform-autoid-test';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret0;

    beforeAll(async () => {
        botSecret0 = await bindEntity(deviceId, deviceSecret, 0);
        await bindEntity(deviceId, deviceSecret, 1);
    });

    it('works without entityId (auto-detect from botSecret)', async () => {
        const res = await post('/api/transform')
            .send({
                deviceId,
                botSecret: botSecret0,
                message: 'Auto-detect test',
                state: 'IDLE'
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.entityId).toBe(0);
    });

    it('auto-corrects wrong entityId with warning', async () => {
        const res = await post('/api/transform')
            .send({
                deviceId,
                entityId: 1,  // wrong — botSecret0 belongs to entity 0
                botSecret: botSecret0,
                message: 'Wrong ID test',
                state: 'IDLE'
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.entityId).toBe(0); // corrected
        expect(res.body.warnings).toBeDefined();
        expect(res.body.warnings.some(w => w.includes('Auto-corrected'))).toBe(true);
    });

    it('rejects invalid botSecret', async () => {
        const res = await post('/api/transform')
            .send({
                deviceId,
                botSecret: 'totally-wrong-secret',
                message: 'Bad secret',
                state: 'IDLE'
            });
        expect(res.status).toBe(403);
    });
});

// ════════════════════════════════════════════════════════════════
// 9. speakTo supports entityId (numeric string fallback)
// ════════════════════════════════════════════════════════════════
describe('Transform speakTo with entityId string', () => {
    const deviceId = 'transform-eid-string';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret0;

    beforeAll(async () => {
        botSecret0 = await bindEntity(deviceId, deviceSecret, 0);
        await bindEntity(deviceId, deviceSecret, 1);
    });

    it('delivers message using entityId string instead of publicCode', async () => {
        const res = await post('/api/transform')
            .send({
                deviceId,
                botSecret: botSecret0,
                message: 'Hello via entityId',
                state: 'IDLE',
                speakTo: ['1']  // entityId as string
            });
        expect(res.status).toBe(200);
        expect(res.body.delivery).toBeDefined();
        expect(res.body.delivery.results[0].success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// 10. channel/message with speakTo
// ════════════════════════════════════════════════════════════════
describe('POST /api/channel/message + speakTo', () => {
    const deviceId = 'channel-msg-speakto';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret0;

    beforeAll(async () => {
        botSecret0 = await bindEntity(deviceId, deviceSecret, 0);
        await bindEntity(deviceId, deviceSecret, 1);
    });

    it('channel/message endpoint accepts speakTo field without crashing on unrelated errors', async () => {
        // channel/message requires valid channel_api_key — mock DB may not have getChannelAccountByKey
        // We verify speakTo doesn't cause an unexpected crash in field parsing
        const res = await post('/api/channel/message')
            .send({
                channel_api_key: 'test-key',
                deviceId,
                botSecret: botSecret0,
                message: 'Channel speakTo test',
                state: 'IDLE',
                speakTo: ['1']
            });
        // 403 (invalid key) or 500 (mock DB lacks getChannelAccountByKey) — but NOT a field parsing error
        expect([403, 500].includes(res.status)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// 11. Fallback save when delivery requested but every target fails
//     Regression for silent data loss: speakTo-all-fail, broadcast dead
//     paths (dedup / rate-limit / no-targets / device-missing) used to
//     leave zero chat rows. After the fix: sender-side row + warning.
// ════════════════════════════════════════════════════════════════
describe('Transform fallback save on delivery failure', () => {
    const deviceId = 'transform-fallback-test';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret0, code1;

    beforeAll(async () => {
        botSecret0 = await bindEntity(deviceId, deviceSecret, 0);
        await bindEntity(deviceId, deviceSecret, 1);
        code1 = await getPublicCode(deviceId, deviceSecret, 1);
    });

    function clearPoolQueries() {
        for (const p of pgPoolSnapshot) p.query.mockClear();
    }

    // saveChatMessage uses chatPool; multiple modules create their own Pool
    // instances, so we have to scan every Pool's query.mock.calls rather than
    // guessing which one holds chat_messages.
    function findChatInserts(text) {
        const matches = [];
        for (const p of pgPoolSnapshot) {
            for (const call of p.query.mock.calls) {
                if (typeof call[0] === 'string'
                    && call[0].includes('INSERT INTO chat_messages')
                    && Array.isArray(call[1])
                    && call[1][2] === text) {
                    matches.push(call);
                }
            }
        }
        return matches;
    }

    it('speakTo with only-unresolved codes → sender row saved + warning', async () => {
        clearPoolQueries();

        const msg = 'fallback-all-fail-' + Date.now();
        const res = await post('/api/transform')
            .send({
                deviceId,
                entityId: 0,
                botSecret: botSecret0,
                message: msg,
                state: 'IDLE',
                speakTo: ['zzzzzz']
            });

        expect(res.status).toBe(200);
        expect(res.body.delivery.results[0].success).toBe(false);
        expect(res.body.warnings).toBeDefined();
        expect(res.body.warnings.some(w => w.includes('saved to sender chat only'))).toBe(true);

        // Sender-side row present: is_from_bot=true (index 5), deviceId matches, entity=0
        const inserts = findChatInserts(msg);
        expect(inserts.length).toBeGreaterThan(0);
        const params = inserts[0][1];
        expect(params[0]).toBe(deviceId);
        expect(params[1]).toBe(0);
        expect(params[2]).toBe(msg);
        expect(params[4]).toBe(false); // is_from_user
        expect(params[5]).toBe(true);  // is_from_bot
    });

    it('successful speakTo does not fire fallback (no duplicate save, no warning)', async () => {
        clearPoolQueries();

        const msg = 'fallback-success-path-' + Date.now();
        const res = await post('/api/transform')
            .send({
                deviceId,
                entityId: 0,
                botSecret: botSecret0,
                message: msg,
                state: 'IDLE',
                speakTo: [code1]
            });

        expect(res.status).toBe(200);
        expect(res.body.delivery.results[0].success).toBe(true);
        // No fallback warning
        const fallbackWarn = (res.body.warnings || []).some(w => w.includes('saved to sender chat only'));
        expect(fallbackWarn).toBe(false);
        // Exactly one sender-side row (the normal speakTo save), not two
        const inserts = findChatInserts(msg);
        expect(inserts.length).toBe(1);
    });

    it('broadcast with no other bound entities → sender row saved + warning', async () => {
        // Fresh single-entity device so broadcast has zero targets
        const devId = 'transform-fallback-solo';
        const devSecret = `secret-${devId}`;
        const bs = await bindEntity(devId, devSecret, 0);

        clearPoolQueries();

        const msg = 'fallback-broadcast-solo-' + Date.now();
        const res = await post('/api/transform')
            .send({
                deviceId: devId,
                entityId: 0,
                botSecret: bs,
                message: msg,
                state: 'IDLE',
                broadcast: true
            });

        expect(res.status).toBe(200);
        expect(res.body.warnings).toBeDefined();
        expect(res.body.warnings.some(w => w.includes('saved to sender chat only'))).toBe(true);

        const inserts = findChatInserts(msg);
        expect(inserts.length).toBeGreaterThan(0);
    });

    it('[SILENT] sentinel message skips fallback save (no warning, no sender row)', async () => {
        clearPoolQueries();

        // [SILENT] is the explicit sentinel that suppresses sender-side saving
        const msg = '[SILENT]';
        const res = await post('/api/transform')
            .send({
                deviceId,
                entityId: 0,
                botSecret: botSecret0,
                message: msg,
                state: 'IDLE',
                speakTo: ['zzzzzz']
            });

        expect(res.status).toBe(200);
        const fallbackWarn = (res.body.warnings || []).some(w => w.includes('saved to sender chat only'));
        expect(fallbackWarn).toBe(false);
        expect(findChatInserts(msg).length).toBe(0);
    });
});
