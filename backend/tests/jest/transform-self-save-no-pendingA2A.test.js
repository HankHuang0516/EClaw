/**
 * /api/transform self-save chatSource regression — pendingA2A no longer
 * leaks into the chat row's source field (PR #2292 / extends #2290).
 *
 * Before PR #2292: when a bot transformed without speakTo/broadcast/@-mention
 * AND its messageQueue had a pending A2A entry from entity X, the self-save
 * wrote `entity:N:CHAR->X delivered=false`. The chat UI then rendered this
 * as "Sent to Entity X" — completely misleading because:
 *   - the bot didn't actually route the reply anywhere
 *   - X is whoever sat at the head of messageQueue (often unrelated)
 *   - delivery never happened (delivered=false, delivered_to=null)
 *
 * Production case from his_873e8f44-... 2026-05-02 21:53:
 *   sender: entity 2 (Claude)
 *   message: "兩張審核的卡都收完了..." (no @-mention, no speakTo)
 *   pendingA2A on #2's queue: from entity 3 (Mac_E)
 *   Pre-fix row: source=entity:2:LOBSTER->3 (rendered "Sent to Mac_E (#3)")
 *   Post-fix row: source=entity.name (rendered as own status, no fake target)
 */

require('./helpers/mock-setup');

const request = require('supertest');
const pg = require('pg');
let app;

const post = (path) => request(app).post(path).set('Host', 'localhost');

let chatInserts = [];

beforeAll(() => {
    const originalPool = pg.Pool;
    pg.Pool = jest.fn().mockImplementation(() => ({
        query: jest.fn().mockImplementation(async (sql, params) => {
            const sqlStr = typeof sql === 'string' ? sql : (sql && sql.text) || '';
            if (/^\s*INSERT INTO chat_messages/i.test(sqlStr)) {
                chatInserts.push({
                    deviceId: params?.[0],
                    entityId: params?.[1],
                    text: params?.[2],
                    source: params?.[3],
                });
                return { rows: [{ id: `mock-${chatInserts.length}` }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        }),
        connect: jest.fn().mockResolvedValue({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() }),
        end: jest.fn().mockResolvedValue(undefined),
    }));
    app = require('../../index');
    pg.Pool = originalPool;
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
});

beforeEach(() => { chatInserts = []; });

async function registerDevice(id) {
    const secret = `secret-${id}`;
    await post('/api/device/register').send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    return secret;
}

async function bindEntity(deviceId, deviceSecret, entityId = 0) {
    const regRes = await post('/api/device/register').send({ deviceId, deviceSecret, entityId });
    const code = regRes.body.bindingCode;
    if (!code) return undefined;
    const bindRes = await post('/api/bind').send({ code });
    return bindRes.body.botSecret;
}

function rowsForProbe(tag) {
    return chatInserts.filter(r => (r.text || '').includes(tag));
}

describe('POST /api/transform — self-save chatSource never leaks pendingA2A (#2292)', () => {
    let deviceId, deviceSecret, botSecret2;

    beforeAll(async () => {
        deviceId = 'self-save-clean';
        deviceSecret = await registerDevice(deviceId);
        await bindEntity(deviceId, deviceSecret, 0);
        await post('/api/device/add-entity').send({ deviceId, deviceSecret });
        await bindEntity(deviceId, deviceSecret, 1);
        await post('/api/device/add-entity').send({ deviceId, deviceSecret });
        botSecret2 = await bindEntity(deviceId, deviceSecret, 2);

        // Inject pendingA2A from entity 0 onto entity 2's messageQueue. Pre-fix
        // this would cause every subsequent transform from #2 (without speakTo
        // / @-mention) to be saved as `entity:2:LOBSTER->0`.
        const { devices } = require('../../index');
        devices[deviceId].entities[2].messageQueue.push({
            text: 'priming A2A from entity 0',
            from: 'entity:0:LOBSTER',
            fromEntityId: 0,
            timestamp: Date.now(),
            crossDevice: false,
        });
    });

    it('plain status update with pendingA2A in queue → source has NO ->X arrow', async () => {
        const tag = `STATUS-${Date.now()}`;
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 2,
            botSecret: botSecret2,
            state: 'IDLE',
            message: `${tag} pure status, no @, no speakTo`,
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const rows = rowsForProbe(tag);
        expect(rows).toHaveLength(1);
        // Critical: chatSource must NOT pretend a target was reached.
        expect(/->\d+$/.test(rows[0].source)).toBe(false);
        // chatSource is the plain entity name (or fallback "Entity N")
        expect(rows[0].source).toMatch(/^(.+|Entity \d+)$/);
    });

    it('multiple status updates leave NO trailing arrows', async () => {
        const tag = `STATUS-MULTI-${Date.now()}`;
        for (let i = 0; i < 3; i++) {
            await post('/api/transform').send({
                deviceId,
                entityId: 2,
                botSecret: botSecret2,
                state: 'IDLE',
                message: `${tag} round ${i}`,
            });
        }
        const rows = rowsForProbe(tag);
        expect(rows).toHaveLength(3);
        for (const r of rows) {
            expect(/->\d+$/.test(r.source)).toBe(false);
        }
    });
});
