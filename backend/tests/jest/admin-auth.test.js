/**
 * Admin endpoint authorization tests (Jest + Supertest)
 *
 * Verifies that admin-only endpoints reject unauthenticated requests.
 * This is a P1 security test — admin endpoints must not leak data to unauthorized users.
 */

// ── Same mocks as health.test.js ──
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

jest.mock('../../db', () => ({
    initDatabase: jest.fn().mockResolvedValue(true),
    saveDeviceData: jest.fn().mockResolvedValue(true),
    saveAllDevices: jest.fn().mockResolvedValue(true),
    loadAllDevices: jest.fn().mockResolvedValue({}),
    deleteDevice: jest.fn().mockResolvedValue(true),
    getStats: jest.fn().mockResolvedValue({}),
    closeDatabase: jest.fn().mockResolvedValue(undefined),
    saveOfficialBot: jest.fn().mockResolvedValue(true),
    loadOfficialBots: jest.fn().mockResolvedValue({}),
    deleteOfficialBot: jest.fn().mockResolvedValue(true),
    saveOfficialBinding: jest.fn().mockResolvedValue(true),
    removeOfficialBinding: jest.fn().mockResolvedValue(true),
    getOfficialBinding: jest.fn().mockResolvedValue(null),
    getDeviceOfficialBindings: jest.fn().mockResolvedValue([]),
    updateSubscriptionVerified: jest.fn().mockResolvedValue(true),
    loadAllOfficialBindings: jest.fn().mockResolvedValue([]),
    getExpiredPersonalBindings: jest.fn().mockResolvedValue([]),
    getPaidBorrowSlots: jest.fn().mockResolvedValue(0),
    incrementPaidBorrowSlots: jest.fn().mockResolvedValue(true),
    saveFeedback: jest.fn().mockResolvedValue({ id: 1 }),
}));

jest.mock('../../flickr', () => ({
    initFlickr: jest.fn(),
    uploadPhoto: jest.fn().mockResolvedValue(null),
    isAvailable: jest.fn().mockReturnValue(false),
}));

jest.mock('../../scheduler', () => ({
    init: jest.fn(),
    createSchedule: jest.fn().mockResolvedValue({ id: 1 }),
    updateSchedule: jest.fn().mockResolvedValue(true),
    deleteSchedule: jest.fn().mockResolvedValue(true),
    getSchedules: jest.fn().mockResolvedValue([]),
    getSchedule: jest.fn().mockResolvedValue(null),
    getSchedulesForBot: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../device-telemetry', () => ({
    initTelemetryTable: jest.fn().mockResolvedValue(undefined),
    appendEntries: jest.fn().mockResolvedValue(undefined),
    captureApiCall: jest.fn().mockResolvedValue(undefined),
    getEntries: jest.fn().mockResolvedValue([]),
    getSummary: jest.fn().mockResolvedValue({}),
    clearEntries: jest.fn().mockResolvedValue(undefined),
    createMiddleware: jest.fn().mockReturnValue((_req, _res, next) => next()),
    sanitize: jest.fn().mockImplementation((v) => v),
    MAX_BUFFER_BYTES: 1024 * 1024,
    MAX_ENTRIES: 500,
}));

jest.mock('../../device-feedback', () => ({
    initFeedbackTable: jest.fn().mockResolvedValue(undefined),
    initFeedbackPhotosTable: jest.fn().mockResolvedValue(undefined),
    captureLogSnapshot: jest.fn().mockResolvedValue([]),
    captureDeviceState: jest.fn().mockResolvedValue({}),
    autoTriage: jest.fn().mockResolvedValue('low'),
    generateAiPrompt: jest.fn().mockReturnValue(''),
    saveFeedback: jest.fn().mockResolvedValue({ id: 1 }),
    getFeedbackList: jest.fn().mockResolvedValue([]),
    getMiniGameSubmissions: jest.fn().mockResolvedValue({ summary: {}, submissions: [] }),
    getMiniGameAnalytics: jest.fn().mockResolvedValue({ summary: {}, errorStats: [], gameStats: [], recentErrors: [] }),
    getFeedbackById: jest.fn().mockResolvedValue(null),
    updateFeedback: jest.fn().mockResolvedValue(true),
    createGithubIssue: jest.fn().mockResolvedValue(null),
    getPendingDebugFeedback: jest.fn().mockResolvedValue([]),
    saveDebugResult: jest.fn().mockResolvedValue(true),
    setMark: jest.fn().mockResolvedValue(undefined),
    getMark: jest.fn().mockResolvedValue(null),
    clearMark: jest.fn().mockResolvedValue(undefined),
    LOG_WINDOW_MS: 60000,
    MAX_PHOTOS_PER_FEEDBACK: 10,
    MAX_PHOTO_SIZE: 5 * 1024 * 1024,
    saveFeedbackPhoto: jest.fn().mockResolvedValue({ id: 1 }),
    getFeedbackPhotos: jest.fn().mockResolvedValue([]),
    getFeedbackPhoto: jest.fn().mockResolvedValue(null),
    deleteFeedbackPhotos: jest.fn().mockResolvedValue(undefined),
    cleanupResolvedFeedbackPhotos: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../gatekeeper', () => ({
    detectMaliciousMessage: jest.fn().mockReturnValue({ isMalicious: false }),
    detectAndMaskLeaks: jest.fn().mockImplementation((text) => text),
    initGatekeeperTable: jest.fn().mockResolvedValue(undefined),
    loadBlockedDevices: jest.fn().mockResolvedValue(undefined),
    recordViolation: jest.fn().mockResolvedValue(undefined),
    isDeviceBlocked: jest.fn().mockReturnValue(false),
    getStrikeInfo: jest.fn().mockResolvedValue({ strikes: 0, blocked: false }),
    getFreeBotTOS: jest.fn().mockResolvedValue(null),
    hasAgreedToTOS: jest.fn().mockResolvedValue(false),
    recordTOSAgreement: jest.fn().mockResolvedValue(undefined),
    setServerLog: jest.fn(),
    MAX_STRIKES: 3,
    FREE_BOT_TOS_VERSION: '1.0',
}));

jest.mock('../../mission', () => {
    const express = jest.requireActual('express');
    return jest.fn().mockReturnValue({
        router: express.Router(),
        initMissionDatabase: jest.fn().mockResolvedValue(undefined),
        setNotifyCallback: jest.fn(),
        setPushToBot: jest.fn(),
        setPushToChannelCallback: jest.fn(),
    });
});

jest.mock('../../auth', () => {
    const express = jest.requireActual('express');
    // Auth middleware that rejects (no cookie → 401)
    const authMiddleware = (req, res, next) => {
        const token = req.cookies && req.cookies.eclaw_session;
        if (!token) {
            return res.status(401).json({ success: false, error: 'Not authenticated' });
        }
        // Minimal decode: just check for admin flag
        req.user = { userId: 1 };
        next();
    };
    // Admin middleware that rejects non-admin users
    const adminMiddleware = (req, res, next) => {
        if (!req.user || !req.user.isAdmin) {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }
        next();
    };
    return jest.fn().mockReturnValue({
        router: express.Router(),
        authMiddleware,
        softAuthMiddleware: (_req, _res, next) => next(),
        adminMiddleware,
        initAuthDatabase: jest.fn().mockResolvedValue(undefined),
        setOnEmailVerified: jest.fn(),
        pool: {
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        },
    });
});

jest.mock('../../subscription', () => {
    const express = jest.requireActual('express');
    return jest.fn().mockReturnValue({
        router: express.Router(),
        loadPremiumStatus: jest.fn().mockResolvedValue(undefined),
    });
});

const fs = require('fs');
const path = require('path');
const request = require('supertest');
let app;

const get = (path) => request(app).get(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');
const del = (path) => request(app).delete(path).set('Host', 'localhost');
const patch = (path) => request(app).patch(path).set('Host', 'localhost');

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

// ════════════════════════════════════════════════════════════════
// Admin-device gate must prove possession of deviceSecret
// (card_bb9f0e5c — deviceId is not a secret; allowlist membership
// alone must never authenticate an admin endpoint)
// ════════════════════════════════════════════════════════════════
describe('requireAdmin — deviceSecret proof required', () => {
    const adminDeviceId = 'jest-admin-device';
    const adminDeviceSecret = 'jest-admin-device-secret';
    let originalAdminDeviceIds;

    const makeReq = ({ query = {}, body = {}, headers = {} } = {}) => ({
        query,
        body,
        headers,
    });

    beforeEach(() => {
        originalAdminDeviceIds = process.env.ADMIN_DEVICE_IDS;
        process.env.ADMIN_DEVICE_IDS = adminDeviceId;
        app.devices[adminDeviceId] = {
            deviceSecret: adminDeviceSecret,
            entities: {},
        };
    });

    afterEach(() => {
        if (originalAdminDeviceIds === undefined) {
            delete process.env.ADMIN_DEVICE_IDS;
        } else {
            process.env.ADMIN_DEVICE_IDS = originalAdminDeviceIds;
        }
        delete app.devices[adminDeviceId];
    });

    it('rejects an allowlisted deviceId without deviceSecret', () => {
        const gate = app._requireAdmin(makeReq({
            query: { deviceId: adminDeviceId },
        }));

        expect(gate).toMatchObject({
            ok: false,
            status: 401,
            error: 'deviceSecret required for admin-gated endpoint',
        });
    });

    it('rejects an allowlisted deviceId with the wrong deviceSecret', () => {
        const gate = app._requireAdmin(makeReq({
            query: { deviceId: adminDeviceId, deviceSecret: 'wrong-secret' },
        }));

        expect(gate).toMatchObject({
            ok: false,
            status: 401,
            error: 'invalid credentials',
        });
    });

    it('rejects an allowlisted deviceId whose device record is missing (no oracle)', () => {
        delete app.devices[adminDeviceId];
        const gate = app._requireAdmin(makeReq({
            query: { deviceId: adminDeviceId, deviceSecret: adminDeviceSecret },
        }));

        expect(gate).toMatchObject({ ok: false, status: 401, error: 'invalid credentials' });
    });

    it('accepts only the matching deviceSecret for an allowlisted deviceId', () => {
        const gate = app._requireAdmin(makeReq({
            headers: {
                'x-device-id': adminDeviceId,
                'x-device-secret': adminDeviceSecret,
            },
        }));

        expect(gate).toEqual({ ok: true, deviceId: adminDeviceId });
    });

    it('still rejects non-allowlisted deviceIds with 403 even with a secret', () => {
        const gate = app._requireAdmin(makeReq({
            query: { deviceId: 'not-an-admin', deviceSecret: 'whatever' },
        }));

        expect(gate).toMatchObject({ ok: false, status: 403 });
    });

    it('opts.verifyDeviceSecret:false skips only the secret step (rental-health layers its own proof)', () => {
        const gate = app._requireAdmin(
            makeReq({ query: { deviceId: adminDeviceId } }),
            { verifyDeviceSecret: false }
        );

        expect(gate).toEqual({ ok: true, deviceId: adminDeviceId });
    });

    it('compares deviceSecret with safeEqual (constant-time) in the requireAdmin gate', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');
        const start = src.indexOf('function requireAdmin');
        const end = src.indexOf('const app = express()', start);
        const requireAdminBody = src.slice(start, end);

        // The secret proof must go through the timing-safe helper — a plain
        // `===` compare here would be a timing-oracle regression.
        expect(requireAdminBody).toMatch(/safeEqual\(device\.deviceSecret,\s*deviceSecret\)/);
        expect(requireAdminBody).not.toMatch(/device\.deviceSecret\s*===/);
    });
});

// ════════════════════════════════════════════════════════════════
// Admin endpoints must reject unauthenticated requests
// ════════════════════════════════════════════════════════════════
describe('Admin endpoints — unauthenticated access blocked', () => {

    it('GET /api/admin/stats rejects without auth', async () => {
        const res = await get('/api/admin/stats');
        expect(res.status).toBe(401);
    });

    it('GET /api/admin/bindings rejects without auth', async () => {
        const res = await get('/api/admin/bindings');
        expect(res.status).toBe(401);
    });

    it('GET /api/admin/users rejects without auth', async () => {
        const res = await get('/api/admin/users');
        expect(res.status).toBe(401);
    });

    it('GET /api/admin/bots rejects without auth', async () => {
        const res = await get('/api/admin/bots');
        expect(res.status).toBe(401);
    });

    it('GET /api/admin/minigame-submissions rejects without auth', async () => {
        const res = await get('/api/admin/minigame-submissions');
        expect(res.status).toBe(401);
    });

    it('GET /api/admin/minigame-analytics rejects without auth', async () => {
        const res = await get('/api/admin/minigame-analytics');
        expect(res.status).toBe(401);
    });

    it('POST /api/admin/gatekeeper/reset rejects without auth', async () => {
        const res = await post('/api/admin/gatekeeper/reset')
            .send({ deviceId: 'test' });
        expect(res.status).toBe(401);
    });

    it('POST /api/admin/push-update rejects without auth', async () => {
        const res = await post('/api/admin/push-update')
            .send({ title: 'test', message: 'test' });
        expect(res.status).toBe(401);
    });

    it('POST /api/admin/bots/create rejects without auth', async () => {
        const res = await post('/api/admin/bots/create')
            .send({ botName: 'test' });
        expect(res.status).toBe(401);
    });

    it('PATCH /api/admin/bots/:botId/metadata rejects without auth', async () => {
        const res = await patch('/api/admin/bots/anybot/metadata')
            .send({ modelName: 'gpt-5' });
        expect(res.status).toBe(401);
    });

    it('DELETE /api/admin/official-bot/test rejects without auth', async () => {
        const res = await del('/api/admin/official-bot/test');
        expect(res.status).toBe(401);
    });
});

// ════════════════════════════════════════════════════════════════
// Admin endpoints must reject non-admin authenticated users
// ════════════════════════════════════════════════════════════════
describe('Admin endpoints — non-admin access blocked', () => {
    // Set a fake session cookie (not admin)
    const cookie = 'eclaw_session=fake-non-admin-token';

    it('GET /api/admin/stats rejects non-admin', async () => {
        const res = await get('/api/admin/stats').set('Cookie', cookie);
        expect(res.status).toBe(403);
    });

    it('GET /api/admin/bindings rejects non-admin', async () => {
        const res = await get('/api/admin/bindings').set('Cookie', cookie);
        expect(res.status).toBe(403);
    });

    it('GET /api/admin/users rejects non-admin', async () => {
        const res = await get('/api/admin/users').set('Cookie', cookie);
        expect(res.status).toBe(403);
    });

    it('POST /api/admin/gatekeeper/reset rejects non-admin', async () => {
        const res = await post('/api/admin/gatekeeper/reset')
            .set('Cookie', cookie)
            .send({ deviceId: 'test' });
        expect(res.status).toBe(403);
    });

    it('POST /api/admin/bots/create rejects non-admin', async () => {
        const res = await post('/api/admin/bots/create')
            .set('Cookie', cookie)
            .send({ botName: 'test' });
        expect(res.status).toBe(403);
    });

    it('PATCH /api/admin/bots/:botId/metadata rejects non-admin', async () => {
        const res = await patch('/api/admin/bots/anybot/metadata')
            .set('Cookie', cookie)
            .send({ modelName: 'gpt-5' });
        expect(res.status).toBe(403);
    });

    it('DELETE /api/admin/official-bot/test rejects non-admin', async () => {
        const res = await del('/api/admin/official-bot/test')
            .set('Cookie', cookie);
        expect(res.status).toBe(403);
    });
});

// ════════════════════════════════════════════════════════════════
// Audit logs — auth required
// ════════════════════════════════════════════════════════════════
describe('GET /api/audit-logs — auth required', () => {
    it('rejects without auth cookie', async () => {
        const res = await get('/api/audit-logs');
        expect(res.status).toBe(401);
    });

    it('rejects non-admin', async () => {
        const res = await get('/api/audit-logs')
            .set('Cookie', 'eclaw_session=fake-non-admin-token');
        expect(res.status).toBe(403);
    });
});

// ════════════════════════════════════════════════════════════════
// Debug endpoints — /api/debug/devices must always send a response
// Regression: Issue #1595 — this route previously called
// verifyAdmin(req, res) but the function only takes (req) and never
// sent any body on failure, so unauthorized callers got no HTTP
// response (hanging / empty 200) instead of a proper 403. Verify the
// route now always resolves with a structured JSON body.
// Note: supertest connects from 127.0.0.1 which verifyAdmin treats as
// trusted localhost, so the body is the device list — the regression
// we guard against is the "no response sent" bug, not the localhost
// allow-list. Non-localhost 403 behavior is covered by integration
// tests.
// ════════════════════════════════════════════════════════════════
describe('GET /api/debug/devices — no silent hang (Issue #1595)', () => {
    it('always resolves with a JSON body', async () => {
        const res = await get('/api/debug/devices');
        expect([200, 403]).toContain(res.status);
        expect(res.body).toBeDefined();
        // A silent "return;" used to leave res.body === ''
        expect(typeof res.body).toBe('object');
    });
});


describe('Private admin demo runtime', () => {
    const express = require('express');
    const http = require('supertest');
    const runtime = require('../../admin-demo-runtime');
    const { readInput } = require('../../scripts/import-admin-demo-runtime');
    const { Readable } = require('stream');
    const localFs = require('fs');
    const localPath = require('path');
    const prefix = '/AiHankApps/admin-demos';
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([8, 0, 0, 0]), Buffer.from('WAVE')]);
    const fixtures = [
        ['demo-a/index.html', Buffer.from('<!doctype html><title>Demo A</title><script type="module" src="app.mjs"></script><script>void 0;</script>')],
        ['demo-a/app.mjs', Buffer.from('export const demo = 1;')],
        ['demo-b/index.html', Buffer.from('<!doctype html><title>Demo B</title>')],
        ['demo-b/app.mjs', Buffer.from('export const demo = 2;')],
        ['style.css', Buffer.from('body { color: #123; }')],
        ['rules.mjs', Buffer.from('export const limit = 1;')],
        ['experience.mjs', Buffer.from('export const stage = 1;')],
        ['assets/one.png', png], ['assets/two.png', png], ['audio/sample.wav', wav],
    ];
    // Transport-only ZIP signature fixture; archive extraction is an operator responsibility.
    const archive = Buffer.concat([Buffer.from([80, 75, 3, 4]), Buffer.alloc(22)]);
    const record = bytes => ({ data: bytes.toString('base64'), sha256: runtime.sha256(bytes), bytes: bytes.length });
    const payload = () => ({ schemaVersion: 1, archive: record(archive),
        assets: fixtures.map(([path, data]) => ({ path, ...record(data) })),
        entries: [{ title: 'Demo A', path: 'demo-a/index.html' }, { title: 'Demo B', path: 'demo-b/index.html' }] });
    function fakePool() {
        const db = { releases: new Map(), assets: new Map(), queries: [], released: 0, failure: null };
        let snapshot;
        db.query = async (sql, values = []) => {
            db.queries.push(sql);
            if (db.failure && sql.includes(db.failure)) throw new Error('Synthetic storage failure');
            if (sql === 'BEGIN') { snapshot = { releases: new Map(db.releases), assets: new Map(db.assets) }; return { rows: [] }; }
            if (sql === 'ROLLBACK') { db.releases = snapshot.releases; db.assets = snapshot.assets; return { rows: [] }; }
            if (sql === 'COMMIT' || sql.startsWith('SELECT pg_advisory') || sql.startsWith('CREATE TABLE')) return { rows: [] };
            if (sql.startsWith('INSERT INTO aihank_admin_demo_releases')) {
                db.releases.set(values[0], { id: values[0], descriptor: JSON.parse(values[1]), archive_bytes: values[2], archive_sha256: values[3], created_at: '2026-01-01T00:00:00Z' });
                return { rows: [] };
            }
            if (sql.startsWith('INSERT INTO aihank_admin_demo_assets')) {
                db.assets.set(values[0] + '/' + values[1], { release_id: values[0], path: values[1], content_type: values[2], sha256: values[3], byte_length: values[4], content_bytes: values[5] });
                return { rows: [] };
            }
            if (sql.includes('FROM aihank_admin_demo_releases')) {
                const row = values.length ? db.releases.get(values[0]) : [...db.releases.values()].at(-1);
                return { rows: row ? [row] : [] };
            }
            if (sql.includes('FROM aihank_admin_demo_assets')) {
                const rows = [...db.assets.values()].filter(row => row.release_id === values[0] && (values.length < 2 || row.path === values[1]));
                return { rows };
            }
            throw new Error('Unexpected synthetic SQL');
        };
        db.connect = async () => ({ query: db.query, release: () => { db.released += 1; } });
        return db;
    }
    function mount(pool, ready = true) {
        const app = express();
        const stats = { publicRequests: 0 };
        const authMiddleware = (req, res, next) => {
            if (!['admin', 'member'].includes(req.get('x-test-user'))) return res.status(401).json({ error: 'Unauthorized' });
            req.user = { id: 1, isAdmin: req.get('x-test-user') === 'admin' };
            next();
        };
        const adminMiddleware = (req, res, next) => req.user.isAdmin ? next() : res.status(403).json({ error: 'Forbidden' });
        app.use(prefix, runtime.createRouter({ authMiddleware, adminMiddleware, getPool: () => pool, isReady: () => ready }));
        app.use((_req, res) => { stats.publicRequests += 1; res.status(200).send('public fallback'); });
        return { app, stats };
    }
    const binary = (response, callback) => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
        response.on('error', callback);
    };
    let pool, app, stats, release, paths;
    beforeEach(async () => {
        pool = fakePool();
        release = await runtime.importRelease(pool, payload());
        ({ app, stats } = mount(pool));
        paths = fixtures.map(([path, data]) => ({ path, data, url: prefix + '/r/' + release.id + '/' + path }));
        paths.push({ path: 'download.zip', data: archive, url: prefix + '/r/' + release.id + '/download.zip' });
        pool.queries = [];
    });
    test.each([...fixtures.map(([path]) => path), 'download.zip'])('protects and hashes %s for every audience', async path => {
        const item = paths.find(entry => entry.path === path);
        expect((await http(app).get(item.url)).status).toBe(401);
        expect((await http(app).get(item.url).set('x-test-user', 'member')).status).toBe(403);
        expect(pool.queries).toHaveLength(0);
        const response = await http(app).get(item.url).set('x-test-user', 'admin').buffer(true).parse(binary);
        expect(response.status).toBe(200);
        expect(runtime.sha256(response.body)).toBe(runtime.sha256(item.data));
        expect(response.headers.etag).toBe('"' + runtime.sha256(item.data) + '"');
        expect(response.headers['cache-control']).toBe('private, no-store, max-age=0');
        expect(response.headers['cdn-cache-control']).toBe('no-store');
        expect(response.headers['cloudflare-cdn-cache-control']).toBe('no-store');
        expect(response.headers.vary).toEqual(expect.stringContaining('Cookie'));
        expect(response.headers.vary).toEqual(expect.stringContaining('Authorization'));
        expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
        expect(stats.publicRequests).toBe(0);
    });
    test('metadata is private and returns only authenticated release links', async () => {
        expect((await http(app).get(prefix + '/')).status).toBe(401);
        expect((await http(app).get(prefix + '/').set('x-test-user', 'member')).status).toBe(403);
        const response = await http(app).get(prefix + '/').set('x-test-user', 'admin');
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ releaseId: release.id, assetCount: 10, archiveSHA256: runtime.sha256(archive) });
        expect(response.body.entries).toHaveLength(2);
        expect(response.body.entries.every(entry => entry.url.startsWith(prefix + '/r/' + release.id + '/'))).toBe(true);
        expect(response.body.downloadUrl).toBe(paths.at(-1).url);
    });
    test('HEAD and audio byte ranges are protected and never return unrequested bytes', async () => {
        const audio = paths.find(item => item.path === 'audio/sample.wav');
        expect((await http(app).head(audio.url)).status).toBe(401);
        const head = await http(app).head(audio.url).set('x-test-user', 'admin');
        expect(head.status).toBe(200);
        expect(head.text).toBeUndefined();
        expect(head.headers['content-length']).toBe(String(wav.length));
        const part = await http(app).get(audio.url).set('x-test-user', 'admin').set('Range', 'bytes=0-3').buffer(true).parse(binary);
        expect(part.status).toBe(206);
        expect(part.body.equals(wav.subarray(0, 4))).toBe(true);
        expect(part.headers['content-range']).toBe('bytes 0-3/' + wav.length);
        const suffix = await http(app).get(audio.url).set('x-test-user', 'admin').set('Range', 'bytes=-4').buffer(true).parse(binary);
        expect(suffix.status).toBe(206);
        expect(suffix.body.equals(wav.subarray(-4))).toBe(true);
        expect((await http(app).get(audio.url).set('x-test-user', 'admin').set('Range', 'bytes=999-')).status).toBe(416);
        expect((await http(app).get(audio.url).set('Range', 'bytes=0-3')).status).toBe(401);
    });
    test('ZIP stays an authenticated attachment and HTML uses exact inline script hashes', async () => {
        const zip = await http(app).get(paths.at(-1).url).set('x-test-user', 'admin');
        expect(zip.headers['content-disposition']).toBe('attachment; filename="private-runtime.zip"');
        const html = await http(app).get(paths[0].url).set('x-test-user', 'admin');
        const inlineHash = require('crypto').createHash('sha256').update('void 0;').digest('base64');
        expect(html.headers['content-security-policy']).toContain("'sha256-" + inlineHash + "'");
        expect(html.headers['content-security-policy']).toContain("script-src-attr 'none'");
        expect(html.headers['content-security-policy']).toContain("worker-src 'none'");
        expect(html.headers['content-security-policy']).toContain("connect-src 'none'");
    });
    test.each(['missing.html', '%2e%2e%2fstyle.css', 'assets%2f..%2fstyle.css', 'secret.env'])('never falls back publicly for %s', async path => {
        const response = await http(app).get(prefix + '/r/' + release.id + '/' + path).set('x-test-user', 'admin');
        expect(response.status).toBe(404);
        expect(stats.publicRequests).toBe(0);
    });
    test('is read-only and rejects cross-origin access', async () => {
        expect((await http(app).post(paths[0].url).set('x-test-user', 'admin')).status).toBe(405);
        expect((await http(app).get(paths[0].url).set('x-test-user', 'admin').set('Origin', 'https://example.test')).status).toBe(403);
        expect((await http(app).get(paths[0].url).set('x-test-user', 'admin').set('Origin', 'https://eclawbot.com')).status).toBe(200);
    });
    test('storage, readiness and integrity failures are closed, not empty success', async () => {
        const unavailable = mount(pool, false);
        expect((await http(unavailable.app).get(paths[0].url).set('x-test-user', 'admin')).status).toBe(503);
        expect(unavailable.stats.publicRequests).toBe(0);
        expect((await http(mount(null).app).get(paths[0].url).set('x-test-user', 'admin')).status).toBe(503);
        pool.failure = 'SELECT';
        const failure = await http(app).get(paths[0].url).set('x-test-user', 'admin');
        expect(failure.status).toBe(503);
        expect(JSON.stringify(failure.body)).not.toContain('Synthetic');
        pool.failure = null;
        pool.assets.get(release.id + '/' + paths[0].path).content_bytes = Buffer.from('tampered');
        expect((await http(app).get(paths[0].url).set('x-test-user', 'admin')).status).toBe(503);
    });
    test('empty private storage has a real 404 and creation does not query or initialize DB', async () => {
        const empty = fakePool();
        const server = mount(empty);
        expect(empty.queries).toHaveLength(0);
        expect((await http(server.app).get(prefix + '/').set('x-test-user', 'admin')).status).toBe(404);
        expect(empty.queries.every(sql => !/CREATE|INSERT|DELETE|UPDATE/.test(sql))).toBe(true);
    });
    test('imports atomically, verifies bytes, and is idempotent', async () => {
        const second = await runtime.importRelease(pool, payload());
        expect(second).toMatchObject({ id: release.id, unchanged: true, verifiedStoredBytes: true });
        expect(pool.assets.size).toBe(10);
        const failing = fakePool();
        failing.failure = 'INSERT INTO aihank_admin_demo_assets';
        await expect(runtime.importRelease(failing, payload())).rejects.toThrow('Synthetic storage failure');
        expect(failing.queries).toContain('ROLLBACK');
        expect(failing.releases.size).toBe(0);
        expect(failing.assets.size).toBe(0);
        expect(failing.released).toBe(1);
    });
    test.each([
        ['base64', value => { value.assets[0].data = '@@@@'; }],
        ['checksum', value => { value.assets[0].sha256 = '0'.repeat(64); }],
        ['traversal', value => { value.assets[0].path = '../index.html'; }],
        ['duplicate', value => { value.assets.push(value.assets[0]); }],
        ['unknown entry', value => { value.entries[0].path = 'missing.html'; }],
        ['extension', value => { value.assets[0].path = 'entry.exe'; }],
        ['oversize', value => { value.assets[0].bytes = 999999999; }],
        ['invalid UTF-8', value => { value.assets[0] = { path: 'demo-a/index.html', ...record(Buffer.from([255])) }; }],
        ['private local path', value => { value.assets[0] = { path: 'demo-a/index.html', ...record(Buffer.from('/Users/private/file')) }; }],
        ['binary signature', value => { value.assets[7] = { path: 'assets/one.png', ...record(Buffer.from('not a png')) }; }],
    ])('rejects invalid envelope: %s', (_name, mutate) => {
        const value = payload(); mutate(value);
        expect(() => runtime.validatePayload(value)).toThrow('Invalid private runtime payload');
    });
    test('bounded stdin is parsed without contacting production', async () => {
        const value = await readInput(Readable.from([JSON.stringify(payload())]));
        expect(value.assets).toHaveLength(10);
        await expect(readInput(Readable.from([Buffer.alloc(runtime.MAX_PAYLOAD_BYTES + 1)]))).rejects.toMatchObject({ code: 'PRIVATE_IMPORT_TOO_LARGE' });
    });
    test('production mount is before public tracking/static and binds existing DB-admin auth', () => {
        const source = localFs.readFileSync(localPath.join(__dirname, '../../index.js'), 'utf8');
        const reserved = source.indexOf("app.use('/AiHankApps/admin-demos'");
        expect(reserved).toBeGreaterThan(0);
        expect(reserved).toBeLessThan(source.indexOf('app.use(sitePageviews.pageviewMiddleware())'));
        expect(reserved).toBeLessThan(source.indexOf("app.use('/AiHankApps', express.static"));
        expect(source).toContain('adminDemoRuntimeSlot.router = privateDemoRuntime.createRouter({');
        expect(source).toContain('authMiddleware: adminAuth, adminMiddleware: adminCheck,');
        expect(source).toContain('getPool: () => chatPool, isReady: () => persistenceReady,');
        expect(source).toContain("const adminCheck = authModule.adminMiddleware;");
    });
});


describe('Ordinary Fraud App feedback contract', () => {
    const express = require('express');
    const http = require('supertest');
    const { newDb } = require('pg-mem');
    const crypto = require('crypto');
    const localFs = require('fs');
    const localPath = require('path');
    const service = require('../../fraud-app-feedback');
    const intake = '/api/fraud-app-feedback';
    const admin = '/api/admin/fraud-app-feedback';
    const fixture = () => ({ schemaVersion: 1, id: crypto.randomUUID(), category: 'operation',
        description: 'Synthetic contract test only', version: 'native-build20-test', screen: 'feedback' });
    function mount(pool, ready = true) {
        const app = express();
        const stats = { fallback: 0 };
        const routers = service.createRouters({ getPool: () => pool, isReady: () => ready,
            authMiddleware: (req, res, next) => {
                if (!req.get('x-test-user')) return res.status(401).json({ success: false });
                req.user = { isAdmin: req.get('x-test-user') === 'admin' }; next();
            },
            adminMiddleware: (req, res, next) => req.user.isAdmin ? next() : res.status(403).json({ success: false }),
        });
        app.use(intake, routers.intake);
        app.use(admin, routers.admin);
        app.use((_req, res) => { stats.fallback += 1; res.status(200).send('unrelated route'); });
        return { app, stats };
    }
    let pool, app, stats, Pool;
    beforeEach(async () => {
        const memory = newDb({ noAstCoverageCheck: true });
        const MemoryPool = memory.adapters.createPg().Pool;
        // pg-mem returns the existing row for ON CONFLICT DO NOTHING RETURNING.
        // Normalize that adapter discrepancy to independently checked PostgreSQL
        // semantics. This sequential fixture is not a concurrency/deploy proof.
        Pool = function TestPool() {
            const value = new MemoryPool();
            const query = value.query.bind(value);
            value.query = async (sql, values) => {
                const doNothing = sql.startsWith('INSERT INTO fraud_app_feedback_reports ')
                    && sql.includes('ON CONFLICT (id) DO NOTHING RETURNING');
                const prior = doNothing ? await query('SELECT id FROM fraud_app_feedback_reports WHERE id = $1', [values[0]]) : null;
                const result = await query(sql, values);
                return prior && prior.rows.length ? { ...result, rows: [], rowCount: 0 } : result;
            };
            return value;
        };
        pool = new Pool();
        await service.migrateSchema(pool);
        ({ app, stats } = mount(pool));
    });
    afterEach(async () => { await pool.end(); });
    test('ordinary no-login write returns a durable UUID receipt; only admin can read it', async () => {
        const body = fixture();
        const posted = await http(app).post(intake).send(body);
        expect(posted.status).toBe(201);
        expect(posted.body).toMatchObject({ success: true, saved: true, id: body.id, duplicate: false });
        expect(Number.isFinite(Date.parse(posted.body.createdAt))).toBe(true);
        expect(Object.keys(posted.body).sort()).toEqual(['createdAt', 'duplicate', 'id', 'saved', 'success']);
        expect((await http(app).get(admin + '/' + body.id)).status).toBe(401);
        expect((await http(app).get(admin + '/' + body.id).set('x-test-user', 'member')).status).toBe(403);
        const detail = await http(app).get(admin + '/' + body.id).set('x-test-user', 'admin');
        expect(detail.status).toBe(200);
        expect(detail.body.report).toMatchObject(body);
        expect(detail.body.report.createdAt).toBe(posted.body.createdAt);
        expect(detail.headers['cache-control']).toContain('no-store');
        expect(detail.headers.vary).toContain('Cookie');
        expect(detail.body.report).not.toHaveProperty('payload_hash');
        expect(stats.fallback).toBe(0);
    });
    test('same UUID/content is idempotent with key reordering and original timestamp', async () => {
        const body = fixture();
        const first = await http(app).post(intake).send(body);
        const reordered = Object.fromEntries(Object.entries(body).reverse());
        const second = await http(app).post(intake).send(reordered);
        expect(first.status).toBe(201);
        expect(second.status).toBe(200);
        expect(second.body).toEqual({ ...first.body, duplicate: true });
        const rows = await pool.query('SELECT id FROM fraud_app_feedback_reports');
        expect(rows.rows).toHaveLength(1);
    });
    test('receipt preserves exact submitted UUID spelling', async () => {
        const body = { ...fixture(), id: crypto.randomUUID().toUpperCase() };
        const response = await http(app).post(intake).send(body);
        expect(response.status).toBe(201);
        expect(response.body.id).toBe(body.id);
    });
    test.each(['description', 'version', 'category'])('same UUID with changed %s conflicts without replacing data', async key => {
        const body = fixture();
        expect((await http(app).post(intake).send(body)).status).toBe(201);
        const changed = { ...body, [key]: key === 'category' ? 'rules' : 'changed' };
        const response = await http(app).post(intake).send(changed);
        expect(response.status).toBe(409);
        expect(response.body).toEqual({ success: false, saved: false, error: 'report_id_conflict' });
        const detail = await http(app).get(admin + '/' + body.id).set('x-test-user', 'admin');
        expect(detail.body.report[key]).toBe(body[key]);
    });
    test('stored feedback survives a fresh server and pool, not an in-process receipt cache', async () => {
        const body = fixture();
        const receipt = await http(app).post(intake).send(body);
        const other = new Pool();
        try {
            const independent = mount(other).app;
            const read = await http(independent).get(admin + '/' + body.id).set('x-test-user', 'admin');
            expect(read.status).toBe(200);
            expect(read.body.report.description).toBe(body.description);
            expect(read.body.report.createdAt).toBe(receipt.body.createdAt);
        } finally { await other.end(); }
    });
    test('lost database acknowledgement returns unsaved; same-ID retry discovers saved data', async () => {
        let loseAck = true;
        const uncertain = { query: async (...args) => {
            const result = await pool.query(...args);
            if (args[0].startsWith('INSERT') && loseAck) { loseAck = false; throw new Error('synthetic lost acknowledgement'); }
            return result;
        } };
        const server = mount(uncertain).app;
        const body = fixture();
        const first = await http(server).post(intake).send(body);
        expect(first.status).toBe(503);
        expect(first.body.saved).toBe(false);
        const retry = await http(server).post(intake).send(body);
        expect(retry.status).toBe(200);
        expect(retry.body).toMatchObject({ success: true, saved: true, duplicate: true, id: body.id });
    });
    test('DB failure, missing pool, not-ready and missing schema are never success', async () => {
        const failing = { query: async () => { throw new Error('private synthetic backend diagnostic'); } };
        for (const server of [mount(failing).app, mount(null).app, mount(pool, false).app]) {
            const response = await http(server).post(intake).send(fixture());
            expect(response.status).toBe(503);
            expect(response.body).toEqual({ success: false, saved: false, error: 'storage_unavailable' });
            expect(JSON.stringify(response.body)).not.toContain('diagnostic');
        }
        const empty = newDb();
        const EmptyPool = empty.adapters.createPg().Pool;
        const emptyPool = new EmptyPool();
        try {
            const response = await http(mount(emptyPool).app).post(intake).send(fixture());
            expect(response.status).toBe(503);
            expect(() => empty.public.getTable('fraud_app_feedback_reports')).toThrow();
        } finally { await emptyPool.end(); }
    });
    test('a missing conflict row is unconfirmed, not a fabricated duplicate', async () => {
        const server = mount({ query: async () => ({ rows: [] }) }).app;
        const response = await http(server).post(intake).send(fixture());
        expect(response.status).toBe(503);
        expect(response.body.saved).toBe(false);
    });
    test.each([
        ['schema', body => { body.schemaVersion = 2; }],
        ['id', body => { body.id = 'not-a-uuid'; }],
        ['v1 UUID', body => { body.id = '00000000-0000-1000-8000-000000000000'; }],
        ['category', body => { body.category = 'unknown'; }],
        ['empty', body => { body.description = '  \n'; }],
        ['too long', body => { body.description = 'a'.repeat(2001); }],
        ['invalid Unicode', body => { body.description = '\ud800'; }],
        ['control', body => { body.description = 'bad\0text'; }],
        ['version', body => { body.version = ''; }],
        ['screen', body => { body.screen = { snapshot: true }; }],
        ['snapshot', body => { body.snapshot = {}; }],
        ['device identifier', body => { body.deviceId = 'synthetic-device'; }],
        ['credential', body => { body.deviceSecret = 'synthetic-not-a-secret'; }],
        ['local delivery marker', body => { body.delivery = 'local-only'; }],
    ])('rejects invalid/extra %s without a stored report', async (_name, mutate) => {
        const body = fixture(); mutate(body);
        const response = await http(app).post(intake).send(body);
        expect(response.status).toBe(400);
        expect(response.body.saved).toBe(false);
        expect((await pool.query('SELECT id FROM fraud_app_feedback_reports')).rows).toHaveLength(0);
    });
    test('accepts 2000 four-byte Unicode characters without truncating', async () => {
        const body = { ...fixture(), description: '\ud83d\ude42'.repeat(2000) };
        expect(service.validate(body)).toBe(true);
        expect((await http(app).post(intake).send(body)).status).toBe(201);
        const detail = await http(app).get(admin + '/' + body.id).set('x-test-user', 'admin');
        expect(detail.body.report.description).toBe(body.description);
    });
    test('malformed, non-JSON and over-limit wire bodies return 400 unsaved', async () => {
        for (const text of ['{', ' '.repeat(service.MAX_BYTES) + JSON.stringify(fixture())]) {
            const response = await http(app).post(intake).set('Content-Type', 'application/json').send(text);
            expect(response.status).toBe(400);
            expect(response.body.saved).toBe(false);
        }
        expect((await http(app).post(intake).type('form').send({ anything: 'invalid' })).status).toBe(400);
    });
    test('limits ordinary submissions without creating an account/key', async () => {
        const body = fixture();
        for (let count = 0; count < 8; count += 1) expect([200, 201]).toContain((await http(app).post(intake).send(body)).status);
        const limited = await http(app).post(intake).send(body);
        expect(limited.status).toBe(429);
        expect(limited.body.saved).toBe(false);
        expect(limited.headers['retry-after']).toBeDefined();
    });
    test('public GET, unknown write paths and untrusted browser origins disclose no report', async () => {
        expect((await http(app).get(intake)).status).toBe(404);
        expect((await http(app).get(intake + '/' + crypto.randomUUID())).status).toBe(404);
        expect((await http(app).post(intake + '/other').send(fixture())).status).toBe(404);
        expect((await http(app).post(intake).set('Origin', 'https://example.test').send(fixture())).status).toBe(403);
        expect(stats.fallback).toBe(0);
    });
    test('private admin lists validate limits and missing IDs', async () => {
        expect((await http(app).get(admin)).status).toBe(401);
        expect((await http(app).get(admin).set('x-test-user', 'member')).status).toBe(403);
        expect((await http(app).get(admin).set('x-test-user', 'admin')).body.reports).toEqual([]);
        expect((await http(app).get(admin + '?limit=101').set('x-test-user', 'admin')).status).toBe(400);
        expect((await http(app).get(admin + '/bad').set('x-test-user', 'admin')).status).toBe(400);
        expect((await http(app).get(admin + '/' + crypto.randomUUID()).set('x-test-user', 'admin')).status).toBe(404);
        const unavailable = mount({ query: async () => { throw new Error('synthetic'); } }).app;
        expect((await http(unavailable).get(admin).set('x-test-user', 'admin')).status).toBe(503);
    });
    test('schema migration is operator-only and repeatable', async () => {
        expect(await service.migrateSchema(pool)).toEqual({ schemaVersion: 1, table: 'fraud_app_feedback_reports' });
        const queries = [];
        mount({ query: async sql => { queries.push(sql); return { rows: [] }; } });
        expect(queries).toHaveLength(0);
    });
    test('production mount is before global JSON parsing and reuses existing admin guards', () => {
        const index = localFs.readFileSync(localPath.join(__dirname, '../../index.js'), 'utf8');
        const at = index.indexOf("app.use('/api/fraud-app-feedback'");
        expect(at).toBeGreaterThan(0);
        expect(at).toBeLessThan(index.indexOf('app.use(express.json({'));
        expect(index).toContain("app.use('/api/admin/fraud-app-feedback', cookieParser(), dispatchFraudAppFeedback('admin'))");
        expect(index).toContain('authMiddleware: adminAuth, adminMiddleware: adminCheck,');
        const source = localFs.readFileSync(localPath.join(__dirname, '../../fraud-app-feedback.js'), 'utf8');
        expect(source).not.toMatch(/captureLogSnapshot|captureDeviceState|createGithubIssue|console\.(log|error)|fetch\(/);
        expect(source).not.toContain("require('./feedback')");
        expect(source).not.toContain('fraud-demo');
    });
});
