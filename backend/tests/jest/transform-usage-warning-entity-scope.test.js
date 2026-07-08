/**
 * transform-usage-warning-entity-scope.test.js — card_2f6a565982885f34b0cd3ed9
 *
 * REAL-control-path regression for the usage-warning entity-attribution bug:
 * #2 (Claude) and #6 (Codex) share one device; the latest usage_snapshots row
 * belonged to entity 2 (Claude 7d used 100%), and the old device-only lookup
 * in getWarningPrefix() prefixed #2's quota warning onto #6's heartbeat.
 *
 * These tests boot the actual Express app and POST /api/transform:
 *   1. entity 6 speaks while the only (latest) snapshot row is entity 2's
 *      breach → NO warning prefix may be attached.        [FAILS on old code]
 *   2. entity 2 speaks → the warning prefix IS attached.  [guards the feature]
 *
 * The fake usage_snapshots emulation is faithful to SQL semantics for BOTH
 * query shapes (device-only vs entity-scoped), so it does not hardcode the
 * fix — old code genuinely goes red on test 1.
 */

require('./helpers/mock-setup');

const request = require('supertest');
const pg = require('pg');
const usageWarning = require('../../lib/usage-warning');
// mock-setup stubs device-preferences with getPrefs → {} — opt this device in
// to usage warnings (spec defaults) so the transform gate opens.
const devicePrefs = require('../../device-preferences');

let app;

// jest.config has clearMocks:true which wipes pg.Pool.mock.results before
// every test — snapshot Pool instances at require-time (see transform-delivery).
const pgPools = [];

const post = (path) => request(app).post(path).set('Host', 'localhost').set('Accept-Encoding', 'identity');

const DEVICE_ID = 'dev-usage-scope-e2e';
const DEVICE_SECRET = 'secret-usage-scope-e2e';

/**
 * In-memory usage_snapshots table. Emulates both lookup shapes:
 *   params [deviceId]        → latest by captured_at            (old code path)
 *   params [deviceId, eid]   → entity_id = eid OR NULL,
 *                              ORDER BY (entity_id = eid) DESC, captured_at DESC
 */
const SNAPSHOT_ROWS = [];
function usageSnapshotsQueryImpl(sql, params) {
    const text = typeof sql === 'string' ? sql : (sql && sql.text) || '';
    if (/FROM\s+usage_snapshots/i.test(text) && /SELECT/i.test(text)) {
        let cand = SNAPSHOT_ROWS.filter(r => r.device_id === params[0]);
        if (params && params.length >= 2) {
            const eid = params[1];
            cand = cand
                .filter(r => r.entity_id === eid || r.entity_id == null)
                .sort((a, b) =>
                    ((b.entity_id === eid) - (a.entity_id === eid)) ||
                    (Date.parse(b.captured_at) - Date.parse(a.captured_at)));
        } else {
            cand = cand.slice().sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at));
        }
        return Promise.resolve({ rows: cand.slice(0, 1), rowCount: Math.min(1, cand.length) });
    }
    // Everything else keeps the mock-setup default (empty result set).
    return Promise.resolve({ rows: [], rowCount: 0 });
}

function installQueryImpl() {
    for (const pool of pgPools) {
        pool.query.mockImplementation(usageSnapshotsQueryImpl);
    }
}

/** Register + bind an entity slot, return its botSecret. */
async function bindEntity(entityId) {
    const regRes = await post('/api/device/register')
        .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, entityId });
    const code = regRes.body.bindingCode;
    expect(code).toBeTruthy();
    const bindRes = await post('/api/bind').send({ code });
    expect(bindRes.body.botSecret).toBeTruthy();
    return bindRes.body.botSecret;
}

let botSecret2;
let botSecret6;

beforeAll(async () => {
    app = require('../../index');
    for (const r of pg.Pool.mock.results) {
        if (r.value && !pgPools.includes(r.value)) pgPools.push(r.value);
    }
    installQueryImpl();

    // Create the device with entity 0, then add slots 1..6 so entity ids 2
    // and 6 exist (mirrors the real multi-entity device 480def4c…).
    await bindEntity(0);
    for (let i = 1; i <= 6; i++) {
        const addRes = await post('/api/device/add-entity')
            .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(addRes.body.success).toBe(true);
    }
    botSecret2 = await bindEntity(2);
    botSecret6 = await bindEntity(6);
});

beforeEach(() => {
    // clearMocks:true wipes call history but keeps implementations; re-install
    // defensively anyway, and reset the in-memory warning cooldown so each
    // test starts from "never warned".
    installQueryImpl();
    devicePrefs.getPrefs.mockResolvedValue({
        usage_warning_config: { enabled: true, threshold_5h_pct: 15, threshold_7d_pct: 5 },
    });
    usageWarning._resetCooldownState();
    SNAPSHOT_ROWS.length = 0;
    // Latest (and only) snapshot row: ENTITY 2's Claude usage — 7d used 100%
    // → remaining 0 ≤ default threshold 5 → breach. This is the exact prod
    // shape from the card RCA (2026-07-07: entityId=2, seven_day_used_pct=100).
    SNAPSHOT_ROWS.push({
        device_id: DEVICE_ID,
        entity_id: 2,
        captured_at: new Date(Date.now() - 60_000).toISOString(),
        claude_json: { live: { five_hour_pct: 10, seven_day_pct: 100 } },
        codex_json: null,
    });
});

describe('POST /api/transform — usage warning entity attribution (card_2f6a5659)', () => {
    const HEARTBEAT = 'Codex #6 status heartbeat: all lanes nominal.';

    test('entity 6 heartbeat gets NO warning prefix when the breaching snapshot belongs to entity 2', async () => {
        const res = await post('/api/transform').send({
            deviceId: DEVICE_ID,
            entityId: 6,
            botSecret: botSecret6,
            state: 'IDLE',
            message: HEARTBEAT,
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        const delivered = res.body.currentState.message;
        expect(delivered).toBe(HEARTBEAT);
        expect(delivered).not.toContain('System notice');
        expect(delivered).not.toContain('系統訊息');
        expect(delivered).not.toContain('⚠️');
    });

    test('entity 2 (owner of the breaching snapshot) still gets the warning prefix', async () => {
        const MSG = 'PR #3901 merged, kanban card closed.';
        const res = await post('/api/transform').send({
            deviceId: DEVICE_ID,
            entityId: 2,
            botSecret: botSecret2,
            state: 'IDLE',
            message: MSG,
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        const delivered = res.body.currentState.message;
        expect(delivered).toContain('System notice');
        expect(delivered.endsWith(MSG)).toBe(true);
        expect(delivered.startsWith('⚠️')).toBe(true);
    });

    test('order-independence: after #2 was warned, #6 is STILL clean (per-entity cooldown, not device-wide)', async () => {
        const res2 = await post('/api/transform').send({
            deviceId: DEVICE_ID, entityId: 2, botSecret: botSecret2,
            state: 'IDLE', message: 'first send from #2',
        });
        expect(res2.body.currentState.message).toContain('System notice');

        const res6 = await post('/api/transform').send({
            deviceId: DEVICE_ID, entityId: 6, botSecret: botSecret6,
            state: 'IDLE', message: HEARTBEAT,
        });
        expect(res6.status).toBe(200);
        expect(res6.body.currentState.message).toBe(HEARTBEAT);
    });
});
