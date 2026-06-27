/**
 * Server-authoritative entity ACTIVITY state machine — endpoint wiring.
 *
 * Verifies the send/inbound endpoints feed the deterministic evaluator:
 *   #4 POST /api/transform with a message and NO explicit state → entity is
 *      ACTIVE (BUSY) within the idle grace, then IDLE after IDLE_AFTER with no
 *      further send.
 *   #5 POST /api/client/speak → pendingWork (queued inbound) blocks sleep even
 *      far past SLEEP_AFTER.
 *
 * FAIL-ON-OLD: drives `_runEntityActivityEvaluation`, which old index.js does
 * not export (call → TypeError) — and old code had no lastSendAt/lastActivityAt
 * plumbing nor a deterministic evaluator, so these assertions cannot hold there.
 */

require('./helpers/mock-setup');

const request = require('supertest');

let app;
let devices;
let runEval;
let ACTIVITY;

const post = (path) => request(app).post(path).set('Host', 'localhost').set('Accept-Encoding', 'identity');

async function bindEntity(deviceId, deviceSecret, entityId = 0) {
    if (entityId > 0) {
        await post('/api/device/add-entity').send({ deviceId, deviceSecret });
    }
    const regRes = await post('/api/device/register').send({ deviceId, deviceSecret, entityId });
    const code = regRes.body.bindingCode;
    const bindRes = await post('/api/bind').send({ code });
    return bindRes.body.botSecret;
}

beforeAll(() => {
    const mod = require('../../index');
    app = mod;
    devices = mod.devices;
    runEval = mod._runEntityActivityEvaluation;
    ACTIVITY = mod._entityActivity.ACTIVITY;
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

test('the activity evaluation hook is exported (fails on old code)', () => {
    expect(typeof runEval).toBe('function');
    expect(ACTIVITY).toMatchObject({ ACTIVE: 'BUSY', IDLE: 'IDLE', SLEEPING: 'SLEEPING' });
});

// ── #4 transform (message, no state) → ACTIVE within grace, then IDLE ──
test('POST /api/transform with a message + no state → ACTIVE, then IDLE after IDLE_AFTER', async () => {
    const deviceId = 'fsm-dev-transform';
    const deviceSecret = 'fsm-secret-transform';
    const botSecret = await bindEntity(deviceId, deviceSecret, 0);
    expect(botSecret).toBeTruthy();

    const res = await post('/api/transform').send({
        deviceId, entityId: 0, botSecret, message: 'hello world', // NOTE: no `state`
    });
    expect(res.status).toBe(200);

    const entity = devices[deviceId].entities[0];
    // Immediate wake: a delivered message marks the entity ACTIVE (BUSY).
    expect(entity.state).toBe(ACTIVITY.ACTIVE);
    expect(typeof entity.lastSendAt).toBe('number');
    expect(typeof entity.lastActivityAt).toBe('number');

    const sentAt = entity.lastSendAt;
    const opts = { idleAfterMs: 60 * 1000, sleepAfterMs: 20 * 60 * 1000 };

    // Within the idle grace → still ACTIVE.
    runEval(sentAt + 30 * 1000, opts);
    expect(entity.state).toBe(ACTIVITY.ACTIVE);

    // Past IDLE_AFTER with no further send and no pending work → IDLE.
    runEval(sentAt + 61 * 1000, opts);
    expect(entity.state).toBe(ACTIVITY.IDLE);

    // Still well within SLEEP_AFTER → must NOT be sleeping.
    expect(entity.state).not.toBe(ACTIVITY.SLEEPING);
});

test('POST /api/transform declaring an expressive state → TTL overlay that reverts', async () => {
    const deviceId = 'fsm-dev-overlay';
    const deviceSecret = 'fsm-secret-overlay';
    const botSecret = await bindEntity(deviceId, deviceSecret, 0);

    const res = await post('/api/transform').send({
        deviceId, entityId: 0, botSecret, message: 'yay!', state: 'EXCITED',
    });
    expect(res.status).toBe(200);

    const entity = devices[deviceId].entities[0];
    expect(entity.state).toBe('EXCITED');
    expect(entity.overlayState).toBe('EXCITED');
    expect(entity.overlayUntil).toBeGreaterThan(entity.lastSendAt);

    // While overlay TTL is live, evaluation keeps the pose.
    runEval(entity.lastSendAt + 5 * 1000, { idleAfterMs: 60 * 1000, sleepAfterMs: 20 * 60 * 1000 });
    expect(entity.state).toBe('EXCITED');

    // After the overlay TTL expires it reverts to the derived activity base
    // (here: past idle grace, within sleep window → IDLE) and never gets stuck.
    runEval(entity.overlayUntil + 61 * 1000, { idleAfterMs: 60 * 1000, sleepAfterMs: 20 * 60 * 1000 });
    expect(entity.state).not.toBe('EXCITED');
    expect(entity.overlayState).toBeNull();
});

// ── #5 client/speak inbound → pendingWork blocks sleep ──
test('POST /api/client/speak queues inbound → pendingWork blocks sleep forever', async () => {
    const deviceId = 'fsm-dev-speak';
    const deviceSecret = 'fsm-secret-speak';
    await bindEntity(deviceId, deviceSecret, 0);

    const res = await post('/api/client/speak').send({
        deviceId, deviceSecret, entityId: 0, text: 'please do this task',
    });
    expect(res.status).toBe(200);

    const entity = devices[deviceId].entities[0];
    // Inbound enqueued → pendingWork true; dormant entity woken immediately.
    expect(entity.messageQueue.length).toBeGreaterThan(0);
    expect(entity.state).not.toBe(ACTIVITY.SLEEPING);

    // Even far past SLEEP_AFTER with tiny thresholds, pending work forbids sleep.
    const farFuture = Date.now() + 24 * 60 * 60 * 1000;
    for (let i = 0; i < 100; i++) {
        runEval(farFuture, { idleAfterMs: 1, sleepAfterMs: 1 });
        expect(entity.state).toBe(ACTIVITY.ACTIVE);
        expect(entity.state).not.toBe(ACTIVITY.SLEEPING);
        expect(entity.state).not.toBe(ACTIVITY.IDLE);
    }

    // Drain the queue (simulate the daemon polling) → pending clears → with the
    // tiny thresholds the entity is now allowed to decay to SLEEPING.
    entity.messageQueue = [];
    runEval(farFuture, { idleAfterMs: 1, sleepAfterMs: 1 });
    expect(entity.state).toBe(ACTIVITY.SLEEPING);
});
