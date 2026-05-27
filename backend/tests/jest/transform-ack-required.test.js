/**
 * Platform-P2: ack_required delivery confirmation
 *
 * Locked scope (Hank @ 2026-05-27 23:15 TW relaying Codex #6):
 *   IN  : high-priority ack + pending table + ack endpoint + timeout notice
 *   OUT : auto-resend, UI changes, retry counter, cross-device fan-out
 *
 * Covers:
 *   - V3 routed-only: rows created only for actually-delivered recipients
 *   - Deadline clamping (60s floor / 1h ceiling / 15min default)
 *   - POST /api/ack happy path + idempotent double-ack + wrong-recipient 403
 *   - Unknown ackId 404; expired row 410
 *   - sweepExpiredAcks: pending → expired (V2 atomic, fire-once)
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app, indexModule, chatPool;

const post = (path) => request(app).post(path).set('Host', 'localhost');

async function registerDevice(id) {
    const secret = `secret-${id}`;
    await post('/api/device/register').send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    return secret;
}

async function bindEntity(deviceId, deviceSecret, entityId = 0) {
    const regRes = await post('/api/device/register')
        .send({ deviceId, deviceSecret, entityId });
    const code = regRes.body.bindingCode;
    if (!code) return undefined;
    const bindRes = await post('/api/bind').send({ code });
    return bindRes.body.botSecret;
}

/**
 * In-memory SQL dispatcher just for the `pending_ack` table.
 * All other queries fall through to the default mock ({ rows: [], rowCount: 0 }).
 */
function installPendingAckStore() {
    const rows = [];  // { ack_id, device_id, sender_entity_id, recipient_entity_id, recipient_public_code, source_msg_id, status, deadline_ms, created_at, acked_at, timed_out_at }
    const defaultResult = { rows: [], rowCount: 0 };

    chatPool.query.mockImplementation(async (sql, params = []) => {
        const s = String(sql);

        // INSERT INTO pending_ack ...
        if (/INSERT INTO pending_ack/i.test(s)) {
            rows.push({
                ack_id: params[0],
                device_id: params[1],
                sender_entity_id: params[2],
                recipient_entity_id: params[3],
                recipient_public_code: params[4],
                source_msg_id: params[5],
                status: 'pending',
                deadline_ms: params[6],
                created_at: new Date(),
                acked_at: null,
                timed_out_at: null,
            });
            return { rows: [], rowCount: 1 };
        }

        // WITH updated AS (UPDATE pending_ack SET status='acked' ... RETURNING ...)
        // SELECT * FROM updated UNION ALL SELECT ... WHERE NOT EXISTS (...)
        // Params: [ackId, recipientEntityId, nowMs]
        if (/WITH updated AS[\s\S]*UPDATE pending_ack[\s\S]*'acked'/i.test(s)) {
            const [ackId, recipientEntityId, nowMs] = params;
            const row = rows.find(r => r.ack_id === ackId);
            if (!row) return { rows: [], rowCount: 0 };
            // Mirror the UPDATE WHERE: status='pending' AND recipient matches AND deadline > now
            if (row.status === 'pending'
                && Number(row.recipient_entity_id) === Number(recipientEntityId)
                && Number(row.deadline_ms) > Number(nowMs)) {
                row.status = 'acked';
                row.acked_at = new Date();
            }
            return { rows: [{ ...row }], rowCount: 1 };
        }

        // UPDATE pending_ack SET status='expired' ...
        if (/UPDATE pending_ack[\s\S]*'expired'/i.test(s)) {
            const nowMs = params[0];
            const flipped = [];
            for (const r of rows) {
                if (r.status === 'pending' && Number(r.deadline_ms) <= Number(nowMs)) {
                    r.status = 'expired';
                    r.timed_out_at = new Date();
                    flipped.push({ ...r });
                }
            }
            return { rows: flipped, rowCount: flipped.length };
        }

        // SELECT ... FROM pending_ack WHERE ack_id = $1
        if (/FROM pending_ack/i.test(s) && /ack_id\s*=\s*\$1/i.test(s)) {
            const ackId = params[0];
            const found = rows.find(r => r.ack_id === ackId);
            return { rows: found ? [{ ...found }] : [], rowCount: found ? 1 : 0 };
        }

        return defaultResult;
    });

    return rows;
}

beforeAll(() => {
    indexModule = require('../../index');
    app = indexModule;
    chatPool = indexModule._chatPool;
});

afterAll(async () => {
    await new Promise(resolve => indexModule.httpServer.close(resolve));
    jest.resetModules();
});

describe('ack_required: deadline clamping (pure unit)', () => {
    const clamp = require('../../index')._clampAckDeadlineMs;
    const MIN = require('../../index')._ACK_MIN_DEADLINE_MS;
    const MAX = require('../../index')._ACK_MAX_DEADLINE_MS;
    const DEF = require('../../index')._ACK_DEFAULT_DEADLINE_MS;

    it('omitted → default (15min)', () => {
        expect(clamp(undefined)).toBe(DEF);
        expect(clamp(null)).toBe(DEF);
        expect(clamp(0)).toBe(DEF);
        expect(clamp(-100)).toBe(DEF);
        expect(clamp('not a number')).toBe(DEF);
    });

    it('below 60s floor → clamped to 60s', () => {
        expect(clamp(10)).toBe(MIN);
        expect(clamp(MIN - 1)).toBe(MIN);
    });

    it('above 1h ceiling → clamped to 1h', () => {
        expect(clamp(MAX + 1)).toBe(MAX);
        expect(clamp(24 * 60 * 60 * 1000)).toBe(MAX);
    });

    it('in-range → returned unchanged', () => {
        expect(clamp(MIN)).toBe(MIN);
        expect(clamp(DEF)).toBe(DEF);
        expect(clamp(MAX)).toBe(MAX);
        expect(clamp(5 * 60 * 1000)).toBe(5 * 60 * 1000);
    });
});

describe('ack_required: helper-level (in-memory store)', () => {
    const { createPendingAckRows, markAckedById, getPendingAckById, sweepExpiredAcks } =
        require('../../index')._pendingAck;

    let store;
    beforeEach(() => { store = installPendingAckStore(); });

    it('createPendingAckRows inserts one row per recipient and returns ackIds', async () => {
        const deadlineMs = Date.now() + 60_000;
        const created = await createPendingAckRows(chatPool, [
            { deviceId: 'd1', senderEntityId: 0, recipientEntityId: 1, recipientPublicCode: 'aaaaaa', sourceMsgId: null, deadlineMs },
            { deviceId: 'd1', senderEntityId: 0, recipientEntityId: 2, recipientPublicCode: 'bbbbbb', sourceMsgId: null, deadlineMs },
        ]);
        expect(created).toHaveLength(2);
        expect(created[0].ackId).toBeTruthy();
        expect(created[1].ackId).toBeTruthy();
        expect(created[0].ackId).not.toBe(created[1].ackId);
        expect(store).toHaveLength(2);
        expect(store[0].status).toBe('pending');
    });

    it('markAckedById flips pending → acked exactly once (idempotent)', async () => {
        const deadlineMs = Date.now() + 60_000;
        const [{ ackId }] = await createPendingAckRows(chatPool, [
            { deviceId: 'd1', senderEntityId: 0, recipientEntityId: 1, recipientPublicCode: 'aaaaaa', deadlineMs },
        ]);

        const r1 = await markAckedById(chatPool, ackId, 1);
        expect(r1).toBeTruthy();
        expect(r1.status).toBe('acked');
        expect(r1.acked_at).toBeTruthy();

        // Second ack: row already 'acked'; returns the existing row, no change.
        const r2 = await markAckedById(chatPool, ackId, 1);
        expect(r2).toBeTruthy();
        expect(r2.status).toBe('acked');
        expect(store[0].status).toBe('acked');
    });

    it('markAckedById refuses when recipient_entity_id mismatches', async () => {
        const deadlineMs = Date.now() + 60_000;
        const [{ ackId }] = await createPendingAckRows(chatPool, [
            { deviceId: 'd1', senderEntityId: 0, recipientEntityId: 1, recipientPublicCode: 'aaaaaa', deadlineMs },
        ]);

        const r = await markAckedById(chatPool, ackId, 99); // wrong recipient
        // CTE returns the still-pending row from the UNION-ALL fallback
        expect(r.status).toBe('pending');
        expect(store[0].status).toBe('pending');
    });

    it('sweepExpiredAcks flips only past-deadline pending rows (V2 fire-once)', async () => {
        const now = Date.now();
        await createPendingAckRows(chatPool, [
            { deviceId: 'd1', senderEntityId: 0, recipientEntityId: 1, recipientPublicCode: 'aaaaaa', deadlineMs: now - 1000 },
            { deviceId: 'd1', senderEntityId: 0, recipientEntityId: 2, recipientPublicCode: 'bbbbbb', deadlineMs: now + 60_000 },
        ]);

        const first = await sweepExpiredAcks(chatPool, now);
        expect(first).toHaveLength(1);
        expect(first[0].recipient_entity_id).toBe(1);
        expect(first[0].status).toBe('expired');

        // Second sweep at the same now → no rows (atomic flip already done).
        const second = await sweepExpiredAcks(chatPool, now);
        expect(second).toHaveLength(0);
    });

    it('getPendingAckById returns the row or null', async () => {
        const deadlineMs = Date.now() + 60_000;
        const [{ ackId }] = await createPendingAckRows(chatPool, [
            { deviceId: 'd1', senderEntityId: 0, recipientEntityId: 1, recipientPublicCode: 'aaaaaa', deadlineMs },
        ]);
        const found = await getPendingAckById(chatPool, ackId);
        expect(found).toBeTruthy();
        expect(found.ack_id).toBe(ackId);

        const missing = await getPendingAckById(chatPool, 'no-such-ack-id');
        expect(missing).toBeNull();
    });
});

describe('POST /api/ack — HTTP layer', () => {
    let deviceId, deviceSecret, botSecret0, botSecret1;
    let store;

    beforeAll(async () => {
        deviceId = 'ack-device-http';
        deviceSecret = await registerDevice(deviceId);
        botSecret0 = await bindEntity(deviceId, deviceSecret, 0);

        const addRes = await post('/api/device/add-entity').send({ deviceId, deviceSecret });
        expect(addRes.status).toBe(200);
        botSecret1 = await bindEntity(deviceId, deviceSecret, 1);
        expect(botSecret1).toBeTruthy();
    });

    beforeEach(() => { store = installPendingAckStore(); });

    async function seedPendingRow(opts = {}) {
        const { createPendingAckRows } = require('../../index')._pendingAck;
        const deadlineMs = opts.deadlineMs ?? (Date.now() + 60_000);
        const [created] = await createPendingAckRows(chatPool, [{
            deviceId,
            senderEntityId: 0,
            recipientEntityId: opts.recipientEntityId ?? 1,
            recipientPublicCode: 'aaaaaa',
            sourceMsgId: null,
            deadlineMs,
        }]);
        return created;
    }

    it('recipient acks with botSecret → 200 success + status=acked', async () => {
        const { ackId } = await seedPendingRow({ recipientEntityId: 1 });
        const res = await post('/api/ack').send({ deviceId, entityId: 1, botSecret: botSecret1, ackId });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.ackId).toBe(ackId);
        expect(res.body.status).toBe('acked');
        expect(res.body.ackedAt).toBeTruthy();
        expect(store[0].status).toBe('acked');
    });

    it('recipient acks with deviceSecret fallback → 200', async () => {
        const { ackId } = await seedPendingRow({ recipientEntityId: 1 });
        const res = await post('/api/ack').send({ deviceId, entityId: 1, deviceSecret, ackId });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('double-ack is idempotent (200 both times)', async () => {
        const { ackId } = await seedPendingRow({ recipientEntityId: 1 });
        const first = await post('/api/ack').send({ deviceId, entityId: 1, botSecret: botSecret1, ackId });
        expect(first.status).toBe(200);
        expect(first.body.status).toBe('acked');

        const second = await post('/api/ack').send({ deviceId, entityId: 1, botSecret: botSecret1, ackId });
        expect(second.status).toBe(200);
        expect(second.body.status).toBe('acked');
    });

    it('wrong botSecret → 403', async () => {
        const { ackId } = await seedPendingRow({ recipientEntityId: 1 });
        const res = await post('/api/ack').send({ deviceId, entityId: 1, botSecret: 'wrong', ackId });
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
    });

    it('ack-er entityId does not match recipient_entity_id → 403', async () => {
        const { ackId } = await seedPendingRow({ recipientEntityId: 1 });
        // Authenticate as entity 0 but try to ack a row addressed to entity 1
        const res = await post('/api/ack').send({ deviceId, entityId: 0, botSecret: botSecret0, ackId });
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toMatch(/not addressed to this entity/i);
    });

    it('unknown ackId → 404', async () => {
        const res = await post('/api/ack').send({ deviceId, entityId: 1, botSecret: botSecret1, ackId: 'no-such-ack' });
        expect(res.status).toBe(404);
    });

    it('expired row → 410 Gone (sender already got the timeout notice)', async () => {
        const past = Date.now() - 1000;
        const { ackId } = await seedPendingRow({ recipientEntityId: 1, deadlineMs: past });
        // Run a sweep so the row flips to 'expired'.
        const { sweepExpiredAcks } = require('../../index')._pendingAck;
        await sweepExpiredAcks(chatPool, Date.now());

        const res = await post('/api/ack').send({ deviceId, entityId: 1, botSecret: botSecret1, ackId });
        expect(res.status).toBe(410);
        expect(res.body.status).toBe('expired');
    });

    it('missing ackId → 400', async () => {
        const res = await post('/api/ack').send({ deviceId, entityId: 1, botSecret: botSecret1 });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/ackId/);
    });

    it('unknown device → 404', async () => {
        const res = await post('/api/ack').send({ deviceId: 'no-such-device', entityId: 1, botSecret: botSecret1, ackId: 'x' });
        expect(res.status).toBe(404);
    });

    it('late-ack race: deadline already passed → 410 (does NOT mark acked)', async () => {
        // Pre-check passes (status='pending') but deadline has slipped. The race-safe
        // markAckedById's UPDATE WHERE deadline_ms > now fails to match; the UNION-ALL
        // fallback returns the row unchanged. Endpoint must return 410.
        const past = Date.now() - 1000;
        const { ackId } = await seedPendingRow({ recipientEntityId: 1, deadlineMs: past });
        // NOTE: no sweep — row is still status='pending', but past deadline.
        const res = await post('/api/ack').send({ deviceId, entityId: 1, botSecret: botSecret1, ackId });
        expect(res.status).toBe(410);
        expect(res.body.status).toBe('expired');
        // Row must NOT have been flipped to 'acked' by the late call
        expect(store[0].status).toBe('pending');
        expect(store[0].acked_at).toBeNull();
    });
});

describe('/api/transform — ack_required row creation (integration)', () => {
    let deviceId, deviceSecret, botSecret0, botSecret1, entity1PublicCode;
    let crossDeviceId, crossDeviceSecret, crossEntity0PublicCode;
    let store;

    beforeAll(async () => {
        // Primary device — two bound entities
        deviceId = 'tx-ack-device';
        deviceSecret = await registerDevice(deviceId);
        botSecret0 = await bindEntity(deviceId, deviceSecret, 0);
        const addRes = await post('/api/device/add-entity').send({ deviceId, deviceSecret });
        expect(addRes.status).toBe(200);
        botSecret1 = await bindEntity(deviceId, deviceSecret, 1);
        expect(botSecret1).toBeTruthy();
        const { devices } = indexModule;
        entity1PublicCode = devices[deviceId].entities[1].publicCode;
        expect(entity1PublicCode).toBeTruthy();

        // Secondary device — used to verify cross-device skip
        crossDeviceId = 'tx-ack-xd-device';
        crossDeviceSecret = await registerDevice(crossDeviceId);
        await bindEntity(crossDeviceId, crossDeviceSecret, 0);
        crossEntity0PublicCode = devices[crossDeviceId].entities[0].publicCode;
        expect(crossEntity0PublicCode).toBeTruthy();
    });

    beforeEach(() => { store = installPendingAckStore(); });

    it('speakTo with numeric "1" + ackRequired creates one pending row keyed by entityId', async () => {
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 0,
            botSecret: botSecret0,
            state: 'IDLE',
            message: '@#1 ack please',
            speakTo: ['1'],
            ackRequired: true,
        });
        expect(res.status).toBe(200);
        expect(res.body.ackInfo).toBeTruthy();
        expect(res.body.ackInfo.required).toBe(true);
        expect(res.body.ackInfo.pending).toHaveLength(1);
        expect(res.body.ackInfo.pending[0].recipientEntityId).toBe(1);
        expect(res.body.ackInfo.pending[0].ackId).toBeTruthy();
        expect(store).toHaveLength(1);
        expect(store[0].device_id).toBe(deviceId);
        expect(store[0].recipient_entity_id).toBe(1);
        expect(store[0].sender_entity_id).toBe(0);
        expect(store[0].status).toBe('pending');
    });

    it('speakTo with "#1" form creates pending row (same as numeric)', async () => {
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 0,
            botSecret: botSecret0,
            state: 'IDLE',
            message: '@#1 ack please',
            speakTo: ['#1'],
            ackRequired: true,
        });
        expect(res.status).toBe(200);
        expect(res.body.ackInfo.pending).toHaveLength(1);
        expect(res.body.ackInfo.pending[0].recipientEntityId).toBe(1);
        expect(store).toHaveLength(1);
        expect(store[0].recipient_entity_id).toBe(1);
    });

    it('speakTo with publicCode creates pending row', async () => {
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 0,
            botSecret: botSecret0,
            state: 'IDLE',
            message: `@${entity1PublicCode} ack please`,
            speakTo: [entity1PublicCode],
            ackRequired: true,
        });
        expect(res.status).toBe(200);
        expect(res.body.ackInfo.pending).toHaveLength(1);
        expect(res.body.ackInfo.pending[0].recipientEntityId).toBe(1);
        expect(res.body.ackInfo.pending[0].recipientPublicCode).toBe(entity1PublicCode);
        expect(store).toHaveLength(1);
    });

    it('cross-device speakTo + ackRequired → no row, warning ACK_REQUIRED_CROSS_DEVICE_SKIPPED', async () => {
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 0,
            botSecret: botSecret0,
            state: 'IDLE',
            message: `@${crossEntity0PublicCode} ack please`,
            speakTo: [crossEntity0PublicCode],
            ackRequired: true,
        });
        expect(res.status).toBe(200);
        expect(store).toHaveLength(0);
        const warnings = res.body.warnings || [];
        expect(warnings.some(w => /^ACK_REQUIRED_CROSS_DEVICE_SKIPPED:/.test(w))).toBe(true);
        // ackInfo absent when no trackable recipients
        expect(res.body.ackInfo).toBeFalsy();
    });

    it('mixed same+cross-device speakTo: only same-device row created, cross gets warning', async () => {
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 0,
            botSecret: botSecret0,
            state: 'IDLE',
            message: `@#1 @${crossEntity0PublicCode} ack`,
            speakTo: ['1', crossEntity0PublicCode],
            ackRequired: true,
        });
        expect(res.status).toBe(200);
        // Only the same-device target gets a pending row
        expect(store).toHaveLength(1);
        expect(store[0].recipient_entity_id).toBe(1);
        expect(store[0].device_id).toBe(deviceId);
        const warnings = res.body.warnings || [];
        expect(warnings.some(w => /^ACK_REQUIRED_CROSS_DEVICE_SKIPPED:/.test(w))).toBe(true);
        expect(res.body.ackInfo.pending).toHaveLength(1);
    });

    it('ackRequired without speakTo/broadcast → no rows created', async () => {
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 0,
            botSecret: botSecret0,
            state: 'IDLE',
            message: 'no delivery requested',
            ackRequired: true,
        });
        expect(res.status).toBe(200);
        expect(store).toHaveLength(0);
        expect(res.body.ackInfo).toBeFalsy();
    });

    it('ackRequired=false (default) does not create rows even with speakTo', async () => {
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 0,
            botSecret: botSecret0,
            state: 'IDLE',
            message: '@#1 no ack needed',
            speakTo: ['1'],
        });
        expect(res.status).toBe(200);
        expect(store).toHaveLength(0);
        expect(res.body.ackInfo).toBeFalsy();
    });
});
