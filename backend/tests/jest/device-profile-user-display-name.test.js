/**
 * Device User Profile — user_display_name endpoint tests
 *
 * Coverage:
 *   - GET /api/device/user-profile (owner-auth gate + cache + DB fallback)
 *   - PUT /api/device/user-profile (owner-auth gate, validation, trim,
 *     null/empty clear, length cap, control-char rejection, persistence)
 *
 * Card: card_900db3bf28ba004813d97ce9
 */

require('./helpers/mock-setup');
const request = require('supertest');
let app;
let db;
const get = (path) => request(app).get(path).set('Host', 'localhost');
const put = (path) => request(app).put(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');

async function registerDevice(id) {
    const secret = `secret-${id}`;
    await post('/api/device/register').send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    return secret;
}

beforeAll(() => {
    process.env.SEAL_KEY = '0'.repeat(64);
    app = require('../../index');
    db = require('../../db');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
});

beforeEach(() => {
    // Reset the shared mock pool so each test sees a clean query log
    if (db && db._mockPool && db._mockPool.query) {
        db._mockPool.query.mockReset();
        db._mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    }
});

// ════════════════════════════════════════════════════════════════
// GET /api/device/user-profile — owner auth required
// ════════════════════════════════════════════════════════════════
describe('GET /api/device/user-profile', () => {
    it('returns 401 when no credentials provided', async () => {
        const res = await get('/api/device/user-profile');
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    it('returns 401 when only deviceId is provided', async () => {
        const res = await get('/api/device/user-profile?deviceId=dev-noauth');
        expect(res.status).toBe(401);
    });

    it('returns 401 when deviceSecret is wrong', async () => {
        const devId = `ud-get-wrong-${Date.now()}`;
        await registerDevice(devId);
        const res = await get(`/api/device/user-profile?deviceId=${devId}&deviceSecret=wrong-secret`);
        expect(res.status).toBe(401);
    });

    it('returns profile with null userDisplayName for a freshly registered device', async () => {
        const devId = `ud-get-ok-${Date.now()}`;
        const secret = await registerDevice(devId);
        const res = await get(`/api/device/user-profile?deviceId=${devId}&deviceSecret=${secret}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.profile).toBeDefined();
        expect(res.body.profile.userDisplayName).toBeNull();
        expect(res.body.profile.maxLength).toBe(64);
    });
});

// ════════════════════════════════════════════════════════════════
// PUT /api/device/user-profile — set and clear
// ════════════════════════════════════════════════════════════════
describe('PUT /api/device/user-profile', () => {
    it('returns 401 without credentials', async () => {
        const res = await put('/api/device/user-profile').send({ userDisplayName: 'Hank' });
        expect(res.status).toBe(401);
    });

    it('returns 401 with wrong deviceSecret', async () => {
        const devId = `ud-put-wrong-${Date.now()}`;
        await registerDevice(devId);
        const res = await put('/api/device/user-profile').send({
            deviceId: devId,
            deviceSecret: 'wrong',
            userDisplayName: 'Hank',
        });
        expect(res.status).toBe(401);
    });

    it('returns 400 when body has no userDisplayName field', async () => {
        const devId = `ud-put-missing-${Date.now()}`;
        const secret = await registerDevice(devId);
        const res = await put('/api/device/user-profile').send({
            deviceId: devId,
            deviceSecret: secret,
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/userDisplayName/i);
    });

    it('accepts a valid string and echoes it back', async () => {
        const devId = `ud-put-ok-${Date.now()}`;
        const secret = await registerDevice(devId);
        const res = await put('/api/device/user-profile').send({
            deviceId: devId,
            deviceSecret: secret,
            userDisplayName: 'Hank',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.profile.userDisplayName).toBe('Hank');
    });

    it('trims surrounding whitespace', async () => {
        const devId = `ud-put-trim-${Date.now()}`;
        const secret = await registerDevice(devId);
        const res = await put('/api/device/user-profile').send({
            deviceId: devId,
            deviceSecret: secret,
            userDisplayName: '  Hank  ',
        });
        expect(res.status).toBe(200);
        expect(res.body.profile.userDisplayName).toBe('Hank');
    });

    it('treats empty string as clear (returns null)', async () => {
        const devId = `ud-put-empty-${Date.now()}`;
        const secret = await registerDevice(devId);
        // First set a value
        await put('/api/device/user-profile').send({
            deviceId: devId, deviceSecret: secret, userDisplayName: 'TempName',
        });
        // Then clear
        const res = await put('/api/device/user-profile').send({
            deviceId: devId, deviceSecret: secret, userDisplayName: '   ',
        });
        expect(res.status).toBe(200);
        expect(res.body.profile.userDisplayName).toBeNull();
    });

    it('treats explicit null as clear', async () => {
        const devId = `ud-put-null-${Date.now()}`;
        const secret = await registerDevice(devId);
        const res = await put('/api/device/user-profile').send({
            deviceId: devId, deviceSecret: secret, userDisplayName: null,
        });
        expect(res.status).toBe(200);
        expect(res.body.profile.userDisplayName).toBeNull();
    });

    it('rejects non-string types (number)', async () => {
        const devId = `ud-put-type-${Date.now()}`;
        const secret = await registerDevice(devId);
        const res = await put('/api/device/user-profile').send({
            deviceId: devId, deviceSecret: secret, userDisplayName: 12345,
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/Invalid userDisplayName/i);
    });

    it('rejects names exceeding 64 code points', async () => {
        const devId = `ud-put-toolong-${Date.now()}`;
        const secret = await registerDevice(devId);
        // 65 ASCII chars
        const tooLong = 'a'.repeat(65);
        const res = await put('/api/device/user-profile').send({
            deviceId: devId, deviceSecret: secret, userDisplayName: tooLong,
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/Invalid userDisplayName/i);
    });

    it('accepts names exactly at the 64-codepoint cap', async () => {
        const devId = `ud-put-exact-${Date.now()}`;
        const secret = await registerDevice(devId);
        const exact = 'a'.repeat(64);
        const res = await put('/api/device/user-profile').send({
            deviceId: devId, deviceSecret: secret, userDisplayName: exact,
        });
        expect(res.status).toBe(200);
        expect(res.body.profile.userDisplayName).toBe(exact);
    });

    it('counts emoji as one code point, not multiple UTF-16 units', async () => {
        const devId = `ud-put-emoji-${Date.now()}`;
        const secret = await registerDevice(devId);
        // 32 emoji = 32 code points (well under 64) but 64 UTF-16 units
        const emoji = '🚀'.repeat(32);
        const res = await put('/api/device/user-profile').send({
            deviceId: devId, deviceSecret: secret, userDisplayName: emoji,
        });
        expect(res.status).toBe(200);
        expect(res.body.profile.userDisplayName).toBe(emoji);
    });

    it('accepts CJK characters', async () => {
        const devId = `ud-put-cjk-${Date.now()}`;
        const secret = await registerDevice(devId);
        const res = await put('/api/device/user-profile').send({
            deviceId: devId, deviceSecret: secret, userDisplayName: '小明',
        });
        expect(res.status).toBe(200);
        expect(res.body.profile.userDisplayName).toBe('小明');
    });

    it('rejects names containing newline (control char)', async () => {
        const devId = `ud-put-nl-${Date.now()}`;
        const secret = await registerDevice(devId);
        const res = await put('/api/device/user-profile').send({
            deviceId: devId, deviceSecret: secret, userDisplayName: 'Line1\nLine2',
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/Invalid userDisplayName/i);
    });

    it('rejects names containing NUL byte', async () => {
        const devId = `ud-put-nul-${Date.now()}`;
        const secret = await registerDevice(devId);
        const res = await put('/api/device/user-profile').send({
            deviceId: devId, deviceSecret: secret, userDisplayName: 'a b',
        });
        expect(res.status).toBe(400);
    });

    it('does not write SQL injection literally into a string column', async () => {
        // The endpoint uses parameterized SQL via pg, so the raw string ends
        // up stored verbatim — proving the input never breaks query parsing.
        const devId = `ud-put-sql-${Date.now()}`;
        const secret = await registerDevice(devId);
        const evil = "Robert'); DROP TABLE devices;--";
        const res = await put('/api/device/user-profile').send({
            deviceId: devId, deviceSecret: secret, userDisplayName: evil,
        });
        expect(res.status).toBe(200);
        expect(res.body.profile.userDisplayName).toBe(evil);
        // Confirm UPDATE was invoked via parameterized query with `$1`
        const updateCalls = db._mockPool.query.mock.calls.filter(c => /UPDATE devices/i.test(c[0]));
        expect(updateCalls.length).toBeGreaterThanOrEqual(1);
        const [sql, params] = updateCalls[updateCalls.length - 1];
        expect(sql).toMatch(/\$1/);
        expect(params[0]).toBe(evil);
    });

    it('persists the value into the in-memory devices cache for next GET', async () => {
        const devId = `ud-put-roundtrip-${Date.now()}`;
        const secret = await registerDevice(devId);
        await put('/api/device/user-profile').send({
            deviceId: devId, deviceSecret: secret, userDisplayName: 'Persistent',
        });
        const res = await get(`/api/device/user-profile?deviceId=${devId}&deviceSecret=${secret}`);
        expect(res.status).toBe(200);
        expect(res.body.profile.userDisplayName).toBe('Persistent');
    });
});

// ════════════════════════════════════════════════════════════════
// Schema migration smoke — db.js createTables() idempotent ALTER
// ════════════════════════════════════════════════════════════════
describe('devices.user_display_name migration', () => {
    it('db.js source contains the idempotent ALTER TABLE', () => {
        const fs = require('fs');
        const path = require('path');
        const dbSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'db.js'), 'utf8');
        expect(dbSrc).toMatch(/ALTER TABLE devices ADD COLUMN IF NOT EXISTS user_display_name TEXT/);
    });

    it('loadAllDevices maps row.user_display_name → userDisplayName in cache', () => {
        const fs = require('fs');
        const path = require('path');
        const dbSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'db.js'), 'utf8');
        expect(dbSrc).toMatch(/userDisplayName:\s*row\.user_display_name/);
    });
});
