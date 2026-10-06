require('./helpers/mock-setup');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const createAuth = jest.requireActual('../../auth');
const { createRouter } = require('../../dot-progress');

describe('progress uses real existing portal auth and fresh admin role checks', () => {
    let app, auth;
    beforeEach(() => {
        auth = createAuth({ 'synthetic-device': { deviceSecret: 'synthetic-hidden-value' } }, () => ({}));
        auth.pool.query.mockResolvedValue({ rows: [{ is_admin: true }] });
        app = express();
        app.use(cookieParser());
        app.use('/api/dot-progress', createRouter(() => auth.pool, auth));
    });
    const token = options => jwt.sign({ userId: 'synthetic-user', deviceId: 'synthetic-device' }, process.env.JWT_SECRET, options || { expiresIn: '1h' });
    test('valid existing cookie returns only role flags, never auth-enriched secrets', async () => {
        const response = await request(app).get('/api/dot-progress/session').set('Cookie', 'eclaw_session=' + token());
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true, authenticated: true, isAdmin: true });
    });
    test('a removed admin role denies private reads despite a valid session', async () => {
        auth.pool.query.mockResolvedValue({ rows: [{ is_admin: false }] });
        const response = await request(app).get('/api/dot-progress/projects').set('Cookie', 'eclaw_session=' + token());
        expect(response.status).toBe(403);
        expect(response.body.success).toBe(false);
    });
    test.each(['missing', 'tampered', 'expired'])('%s session cannot read private records', async kind => {
        const call = request(app).get('/api/dot-progress/projects');
        if (kind !== 'missing') call.set('Cookie', 'eclaw_session=' + (kind === 'expired' ? token({ expiresIn: -60 }) : 'invalid-session'));
        const response = await call;
        expect(response.status).toBe(401);
        expect(response.body.success).toBe(false);
    });
    test.each([
        ['get','/timeline'],['post','/timeline'],['patch','/timeline/synthetic-entry'],['get','/timeline/synthetic-entry/history'],
        ['get','/schedule-period?date=2040-07-19&view=week'],
        ['get','/search?query=synthetic'],['get','/search-item?kind=timeline&id=synthetic-entry'],
        ['get','/timeline/synthetic-entry'],['get','/review/synthetic-entry'],
        ['get','/schedule/2040-07-19/recovery-preview?revision=1'],['post','/schedule/2040-07-19/recovery']
    ])('private work %s %s requires the existing session and current admin role', async (method, suffix) => {
        const pathname='/api/dot-progress'+suffix;
        expect((await request(app)[method](pathname).send({})).status).toBe(401);
        expect((await request(app)[method](pathname).set('Cookie','eclaw_session=invalid-session').send({})).status).toBe(401);
        expect((await request(app)[method](pathname).set('Cookie','eclaw_session='+token({expiresIn:-60})).send({})).status).toBe(401);
        auth.pool.query.mockResolvedValue({rows:[{is_admin:false}]});
        const revoked=await request(app)[method](pathname).set('Cookie','eclaw_session='+token()).send({});
        expect(revoked.status).toBe(403);expect(revoked.body.success).toBe(false);
    });
});
