require('./helpers/mock-setup');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const createAuth = jest.requireActual('../../auth');
const { createRouter, createDebugRouter, READ_SQL } = require('../../paper-beta-admin');

describe('private Paper beta reader uses real portal authentication', () => {
    let app, auth, source, pool;
    const token = (options = { expiresIn: '1h' }) => jwt.sign({ userId: 'synthetic-admin',
        deviceId: 'synthetic-device', isAdmin: true }, process.env.JWT_SECRET, options);
    const get = (suffix = '') => request(app).get('/api/admin/paper-beta-feedback' + suffix);
    const signedGet = suffix => get(suffix).set('Cookie', 'eclaw_session=' + token());
    beforeEach(() => {
        auth = createAuth({ 'synthetic-device': { deviceSecret: 'private-auth-secret' } }, () => ({}));
        auth.pool.query.mockResolvedValue({ rows: [{ is_admin: true }] });
        source = { total: '1', average: '4.00', yes: '1', maybe: '0', no: '0', items: [{
            receiptId: '81', rating: 4, continuation: 'yes', comment: '<img src=x onerror=alert(1)>',
            version: 'synthetic-1', platform: 'Android', createdAt: '2040-01-01T00:00:00Z',
            submissionId: 'excluded', deviceId: 'excluded', email: 'excluded', playerName: 'excluded', attachment: 'excluded'
        }] };
        pool = { query: jest.fn(async () => ({ rows: [source] })) };
        app = express(); app.use(cookieParser());
        app.use('/api/admin/paper-beta-feedback', createRouter(() => pool, auth.authMiddleware, auth.adminMiddleware));
    });
    test.each(['missing', 'tampered', 'expired'])('%s session cannot query private feedback', async kind => {
        const call = get();
        if (kind !== 'missing') call.set('Cookie', 'eclaw_session=' + (kind === 'expired' ? token({ expiresIn: -60 }) : 'invalid'));
        const response = await call;
        expect(response.status).toBe(401); expect(pool.query).not.toHaveBeenCalled();
        expect(response.headers['cache-control']).toContain('no-store');
        expect(response.headers.vary).toContain('Cookie'); expect(response.headers.vary).toContain('Authorization');
        expect(JSON.stringify(response.body)).not.toContain('synthetic-1');
    });
    test.each([false, undefined])('nonadmin or deleted account cannot use a claimed JWT role (%s)', async role => {
        auth.pool.query.mockResolvedValue({ rows: role === undefined ? [] : [{ is_admin: role }] });
        const response = await signedGet();
        expect(response.status).toBe(403); expect(pool.query).not.toHaveBeenCalled();
        expect(response.headers['cache-control']).toContain('no-store');
    });
    test('bot/device credential-shaped parameters do not replace the portal session', async () => {
        const response = await get('?deviceId=synthetic&botSecret=synthetic&entityId=14');
        expect(response.status).toBe(401); expect(pool.query).not.toHaveBeenCalled();
    });
    test('revoking admin stops the next request and auth DB errors fail closed', async () => {
        expect((await signedGet()).status).toBe(200);
        auth.pool.query.mockResolvedValue({ rows: [{ is_admin: false }] });
        expect((await signedGet()).status).toBe(403);
        const log = jest.spyOn(console, 'error').mockImplementation(() => {});
        auth.pool.query.mockRejectedValue(new Error('synthetic auth outage'));
        expect((await signedGet()).status).toBe(500); log.mockRestore();
        expect(pool.query).toHaveBeenCalledTimes(1);
    });
    test('returns only the fixed app, approved fields and private summary', async () => {
        const response = await signedGet(); expect(response.status).toBe(200);
        expect(response.body.summary).toEqual({ total: '1', averageRating: 4, continuation: { yes: '1', maybe: '0', no: '0' } });
        expect(Object.keys(response.body.items[0]).sort()).toEqual(['receiptId','rating','continuation','comment','version','platform','createdAt'].sort());
        expect(JSON.stringify(response.body)).not.toMatch(/excluded|private-auth-secret/);
        expect(pool.query).toHaveBeenCalledWith(READ_SQL, ['paper-flick-soldiers', null, 51]);
        expect(READ_SQL).not.toMatch(/SELECT\s+\*|INSERT|UPDATE|DELETE|CREATE/);
        expect(READ_SQL).toContain('WHERE app_id = $1');
    });
    test.each(['?before=0','?before=-1','?before=9223372036854775808','?before=1%20OR%201=1','?before=1&before=2','?appId=eclawbot'])('rejects malformed or scope-changing query %s', async suffix => {
        expect((await signedGet(suffix)).status).toBe(400); expect(pool.query).not.toHaveBeenCalled();
    });
    test('bounded keyset paging preserves bigint cursor and does not expose the extra row', async () => {
        source.items = Array.from({ length: 51 }, (_, i) => ({ ...source.items[0], receiptId: String(9223372036854775807n - BigInt(i)) }));
        const response = await signedGet('?before=9223372036854775807');
        expect(response.body.items).toHaveLength(50);
        expect(response.body.nextCursor).toBe('9223372036854775758');
        expect(pool.query.mock.calls[0][1]).toEqual(['paper-flick-soldiers', '9223372036854775807', 51]);
    });
    test('repeat reads never write or duplicate rows; later reads reflect source changes', async () => {
        const first = (await signedGet()).body;
        expect((await signedGet()).body).toEqual(first);
        source.items[0].rating = 5; source.average = '5.00';
        const refreshed = (await signedGet()).body;
        expect(refreshed.items).toHaveLength(1); expect(refreshed.items[0].rating).toBe(5);
        expect(refreshed.summary.averageRating).toBe(5);
        expect(pool.query.mock.calls.every(([sql]) => sql === READ_SQL)).toBe(true);
    });
    test('missing storage is an unavailable error, not empty feedback or leaked SQL', async () => {
        pool.query.mockRejectedValue(new Error('private connection details'));
        const response = await signedGet(); expect(response.status).toBe(503);
        expect(response.body).toEqual({ success: false, error: 'beta_feedback_unavailable' });
    });
    test.each(['production', 'railway'])('debug reader is absent in %s before any source read', async environment => {
        const savedNode = process.env.NODE_ENV, savedRailway = process.env.RAILWAY_ENVIRONMENT;
        try {
            process.env.NODE_ENV = environment === 'production' ? 'production' : 'test';
            if (environment === 'railway') process.env.RAILWAY_ENVIRONMENT = 'synthetic-environment';
            else delete process.env.RAILWAY_ENVIRONMENT;
            app.use('/api/debug/paper-beta-feedback', createDebugRouter(() => pool, auth.authMiddleware, auth.adminMiddleware));
            const reply = await request(app).get('/api/debug/paper-beta-feedback').set('Cookie', 'eclaw_session=' + token());
            expect(reply.status).toBe(404); expect(pool.query).not.toHaveBeenCalled();
        } finally {
            process.env.NODE_ENV = savedNode;
            if (savedRailway === undefined) delete process.env.RAILWAY_ENVIRONMENT; else process.env.RAILWAY_ENVIRONMENT = savedRailway;
        }
    });
    test('local debug reader retains session/admin gates and the existing minimal projection', async () => {
        const savedNode = process.env.NODE_ENV, savedRailway = process.env.RAILWAY_ENVIRONMENT;
        try {
            process.env.NODE_ENV = 'test'; delete process.env.RAILWAY_ENVIRONMENT;
            app.use('/api/debug/paper-beta-feedback', createDebugRouter(() => pool, auth.authMiddleware, auth.adminMiddleware));
            expect((await request(app).get('/api/debug/paper-beta-feedback')).status).toBe(401);
            auth.pool.query.mockResolvedValue({ rows: [{ is_admin: false }] });
            expect((await request(app).get('/api/debug/paper-beta-feedback').set('Cookie', 'eclaw_session=' + token())).status).toBe(403);
            expect(pool.query).not.toHaveBeenCalled();
            auth.pool.query.mockResolvedValue({ rows: [{ is_admin: true }] });
            const reply = await request(app).get('/api/debug/paper-beta-feedback').set('Cookie', 'eclaw_session=' + token());
            expect(reply.status).toBe(200); expect(JSON.stringify(reply.body)).not.toMatch(/excluded|private-auth-secret/);
            expect(reply.headers['cache-control']).toContain('no-store');
        } finally {
            process.env.NODE_ENV = savedNode;
            if (savedRailway === undefined) delete process.env.RAILWAY_ENVIRONMENT; else process.env.RAILWAY_ENVIRONMENT = savedRailway;
        }
    });
});
