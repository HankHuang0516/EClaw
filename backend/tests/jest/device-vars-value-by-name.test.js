/**
 * GET /api/device-vars/value — read ONE vault value BY NAME (Jest + Supertest)
 *
 * Owner-decided spec (card_keyref): a bot/agent reads a single secret value by
 * name so the value never has to appear in a chat message. Auth = botSecret of
 * a bot bound to the device (NO deviceSecret, NO user auth, NO per-key
 * allowlist). The decrypted value travels ONLY in the response body; the audit
 * row (action:'bot_read_value') records the key NAME but never the value.
 *
 * These tests reuse the same harness as device-vars.test.js: a real
 * register→bind flow populates devices[deviceId].entities (so the botSecret is
 * genuinely bound), and db.getDeviceVars is a jest mock we seed per-test. To
 * exercise the real decryptVars path we build a row with the SAME AES-256-GCM
 * scheme index.js uses (encryptVars), keyed by the test SEAL_KEY.
 */

require('./helpers/mock-setup');
const crypto = require('crypto');
const request = require('supertest');
let app;
const get = (path) => request(app).get(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');

const db = require('../../db');

// SEAL_KEY the test app is initialized with (see beforeAll). Mirror the exact
// production encryptVars scheme (backend/index.js:7407) so the row we hand to
// the mocked db.getDeviceVars decrypts cleanly via the real decryptVars.
const TEST_SEAL_KEY = '0'.repeat(64);
function encryptVars(varsObj) {
    const key = Buffer.from(TEST_SEAL_KEY, 'hex');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(JSON.stringify(varsObj), 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag();
    return { encrypted_vars: encrypted, iv: iv.toString('hex'), auth_tag: authTag.toString('hex') };
}

function encryptedRow(varsObj, extra = {}) {
    const enc = encryptVars(varsObj);
    return {
        encrypted_vars: enc.encrypted_vars,
        iv: enc.iv,
        auth_tag: enc.auth_tag,
        var_keys: Object.keys(varsObj),
        var_sources: {},
        is_locked: false,
        updated_at: new Date(),
        ...extra,
    };
}

// Register + bind entity 0 so its botSecret is a genuinely bound entity on the
// device (same flow device-vars.test.js uses for its bot-auth GET case).
async function registerAndBind(id) {
    const secret = `secret-${id}`;
    const regRes = await post('/api/device/register').send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    const bindRes = await post('/api/bind').send({ code: regRes.body.bindingCode });
    return { deviceSecret: secret, botSecret: bindRes.body.botSecret };
}

beforeAll(() => {
    process.env.SEAL_KEY = TEST_SEAL_KEY;
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
});

beforeEach(() => {
    db.logDeviceVarsAudit.mockClear();
    db.getDeviceVars.mockReset();
    db.getDeviceVars.mockResolvedValue(null);
});

describe('GET /api/device-vars/value — validation', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await get('/api/device-vars/value?botSecret=abc&name=KEY');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/deviceId/i);
    });

    it('returns 400 when botSecret is missing', async () => {
        const res = await get('/api/device-vars/value?deviceId=dev1&name=KEY');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/botSecret/i);
    });

    it('returns 400 when name is missing', async () => {
        const { botSecret } = await registerAndBind(`val-noname-${Date.now()}`);
        const devId = `val-noname-${Date.now()}`;
        const res = await get(`/api/device-vars/value?deviceId=${devId}&botSecret=${botSecret}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/name/i);
    });

    it('returns 400 when name is empty/whitespace', async () => {
        const { botSecret } = await registerAndBind(`val-emptyname-${Date.now()}`);
        const res = await get(`/api/device-vars/value?deviceId=dev1&botSecret=${botSecret}&name=%20%20`);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/name/i);
    });

    it('returns 404 for a non-existent device', async () => {
        const res = await get('/api/device-vars/value?deviceId=nonexistent&botSecret=abc&name=KEY');
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
    });
});

describe('GET /api/device-vars/value — auth (same gate as names-only GET)', () => {
    it('returns 403 with a botSecret that does not belong to the device', async () => {
        const devId = `val-auth-${Date.now()}`;
        await registerAndBind(devId);
        const res = await get(`/api/device-vars/value?deviceId=${devId}&botSecret=wrong-secret&name=KEY`);
        expect(res.status).toBe(403);
        // Same error shape as GET /api/device-vars (names-only) bot branch.
        expect(res.body.error).toMatch(/botSecret/i);
    });

    it('returns 403 for a valid botSecret of ANOTHER device (not this one)', async () => {
        const devA = `val-authA-${Date.now()}`;
        const devB = `val-authB-${Date.now()}`;
        await registerAndBind(devA);
        const b = await registerAndBind(devB);
        // devB's botSecret is valid, but not for devA → must be rejected.
        const res = await get(`/api/device-vars/value?deviceId=${devA}&botSecret=${b.botSecret}&name=KEY`);
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/botSecret/i);
    });

    it('does NOT write an audit row when auth fails', async () => {
        const devId = `val-auth-noaudit-${Date.now()}`;
        await registerAndBind(devId);
        await get(`/api/device-vars/value?deviceId=${devId}&botSecret=wrong&name=KEY`);
        expect(db.logDeviceVarsAudit).not.toHaveBeenCalled();
    });
});

describe('GET /api/device-vars/value — lookup', () => {
    it('returns 200 with the decrypted value for a valid botSecret + existing name', async () => {
        const devId = `val-ok-${Date.now()}`;
        const { botSecret } = await registerAndBind(devId);
        db.getDeviceVars.mockResolvedValueOnce(
            encryptedRow({ RAILWAY_TOKEN: 'super-secret-value-123', OTHER: 'x' })
        );
        const res = await get(`/api/device-vars/value?deviceId=${devId}&botSecret=${botSecret}&entityId=0&name=RAILWAY_TOKEN`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.name).toBe('RAILWAY_TOKEN');
        expect(res.body.value).toBe('super-secret-value-123');
    });

    it('works without entityId in the query (falls back to botSecret scan)', async () => {
        const devId = `val-noeid-${Date.now()}`;
        const { botSecret } = await registerAndBind(devId);
        db.getDeviceVars.mockResolvedValueOnce(encryptedRow({ K: 'v-scan' }));
        const res = await get(`/api/device-vars/value?deviceId=${devId}&botSecret=${botSecret}&name=K`);
        expect(res.status).toBe(200);
        expect(res.body.value).toBe('v-scan');
    });

    it('returns 404 not_found when the key does not exist in the vault', async () => {
        const devId = `val-nokey-${Date.now()}`;
        const { botSecret } = await registerAndBind(devId);
        db.getDeviceVars.mockResolvedValueOnce(encryptedRow({ PRESENT: '1' }));
        const res = await get(`/api/device-vars/value?deviceId=${devId}&botSecret=${botSecret}&entityId=0&name=MISSING`);
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('not_found');
    });

    it('returns 404 not_found when the device has no vault row at all', async () => {
        const devId = `val-norow-${Date.now()}`;
        const { botSecret } = await registerAndBind(devId);
        // default mock → getDeviceVars resolves null
        const res = await get(`/api/device-vars/value?deviceId=${devId}&botSecret=${botSecret}&entityId=0&name=ANY`);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('not_found');
    });

    it('returns 403 locked when the owner has locked the vault', async () => {
        const devId = `val-locked-${Date.now()}`;
        const { botSecret } = await registerAndBind(devId);
        db.getDeviceVars.mockResolvedValueOnce(encryptedRow({ K: 'v' }, { is_locked: true }));
        const res = await get(`/api/device-vars/value?deviceId=${devId}&botSecret=${botSecret}&entityId=0&name=K`);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('locked');
    });
});

describe('GET /api/device-vars/value — audit invariants', () => {
    it('writes exactly one audit row with action=bot_read_value + keyName', async () => {
        const devId = `val-audit-${Date.now()}`;
        const { botSecret } = await registerAndBind(devId);
        db.getDeviceVars.mockResolvedValueOnce(encryptedRow({ TARGET: 'value-abc' }));
        const res = await get(`/api/device-vars/value?deviceId=${devId}&botSecret=${botSecret}&entityId=0&name=TARGET`);
        expect(res.status).toBe(200);
        expect(db.logDeviceVarsAudit).toHaveBeenCalledTimes(1);
        const call = db.logDeviceVarsAudit.mock.calls[0][0];
        expect(call.action).toBe('bot_read_value');
        expect(call.keyName).toBe('TARGET');
        expect(call.deviceId).toBe(devId);
        // entityId is recorded via the source field (entity:<id>).
        expect(call.source).toBe('entity:0');
    });

    it('NEVER passes the secret value to the audit helper', async () => {
        const devId = `val-audit-noleak-${Date.now()}`;
        const { botSecret } = await registerAndBind(devId);
        db.getDeviceVars.mockResolvedValueOnce(encryptedRow({ SECRET: 'SENSITIVE-TOKEN-XYZ' }));
        const res = await get(`/api/device-vars/value?deviceId=${devId}&botSecret=${botSecret}&entityId=0&name=SECRET`);
        expect(res.status).toBe(200);
        expect(res.body.value).toBe('SENSITIVE-TOKEN-XYZ'); // value in response body...
        expect(db.logDeviceVarsAudit).toHaveBeenCalled();
        for (const [arg] of db.logDeviceVarsAudit.mock.calls) {
            expect(JSON.stringify(arg)).not.toContain('SENSITIVE-TOKEN-XYZ'); // ...but never in audit
        }
    });

    it('does NOT write an audit row when the key is not found', async () => {
        const devId = `val-audit-nokey-${Date.now()}`;
        const { botSecret } = await registerAndBind(devId);
        db.getDeviceVars.mockResolvedValueOnce(encryptedRow({ PRESENT: '1' }));
        const res = await get(`/api/device-vars/value?deviceId=${devId}&botSecret=${botSecret}&entityId=0&name=MISSING`);
        expect(res.status).toBe(404);
        expect(db.logDeviceVarsAudit).not.toHaveBeenCalled();
    });
});

describe('GET /api/help — vault category documents value-by-name', () => {
    it('lists the /api/device-vars/value endpoint', async () => {
        const devId = `help-val-${Date.now()}`;
        const { botSecret } = await registerAndBind(devId);
        const res = await get(`/api/help?deviceId=${devId}&botSecret=${botSecret}&entityId=0&intent=vault`);
        expect(res.status).toBe(200);
        expect(res.body.matched_category).toBe('vault');
        expect(res.body.curl_examples).toContain('/api/device-vars/value?name=KEY');
    });
});
