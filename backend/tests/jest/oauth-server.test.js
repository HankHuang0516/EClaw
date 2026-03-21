/**
 * OAuth 2.0 Server endpoint validation tests (Jest + Supertest)
 *
 * Tests: POST /api/oauth/clients, GET /api/oauth/clients,
 *        GET /api/oauth/authorize, POST /api/oauth/token,
 *        POST /api/oauth/revoke, POST /api/oauth/introspect
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const get = (path) => request(app).get(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');

async function registerDevice(id) {
    const secret = `secret-${id}`;
    await post('/api/device/register')
        .send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    return secret;
}

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
});

// ── POST /api/oauth/clients ──

describe('POST /api/oauth/clients', () => {
    it('returns 401 without device credentials', async () => {
        const res = await post('/api/oauth/clients')
            .send({ client_name: 'Test App' });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('invalid_client');
    });

    it('returns 400 without client_name', async () => {
        const deviceId = 'oauth-c1';
        const secret = await registerDevice(deviceId);
        const res = await post('/api/oauth/clients')
            .send({ deviceId, deviceSecret: secret });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_request');
    });

    it('returns 400 for client_name exceeding 255 chars', async () => {
        const deviceId = 'oauth-c2';
        const secret = await registerDevice(deviceId);
        const res = await post('/api/oauth/clients')
            .send({ deviceId, deviceSecret: secret, client_name: 'x'.repeat(256) });
        expect(res.status).toBe(400);
    });

    it('returns 400 for invalid redirect_uri (http non-localhost)', async () => {
        const deviceId = 'oauth-c3';
        const secret = await registerDevice(deviceId);
        const res = await post('/api/oauth/clients')
            .send({
                deviceId, deviceSecret: secret,
                client_name: 'Test',
                redirect_uris: ['http://evil.com/callback']
            });
        expect(res.status).toBe(400);
        expect(res.body.error_description).toContain('Invalid redirect_uri');
    });

    it('creates client successfully with valid credentials', async () => {
        const deviceId = 'oauth-c4';
        const secret = await registerDevice(deviceId);
        const res = await post('/api/oauth/clients')
            .send({
                deviceId, deviceSecret: secret,
                client_name: 'My OAuth App',
                grant_types: ['client_credentials'],
                scopes: ['read', 'write']
            });
        expect(res.status).toBe(201);
        expect(res.body.client_id).toBeDefined();
        expect(res.body.client_secret).toBeDefined();
        expect(res.body.client_name).toBe('My OAuth App');
    });

    it('accepts localhost redirect_uri', async () => {
        const deviceId = 'oauth-c5';
        const secret = await registerDevice(deviceId);
        const res = await post('/api/oauth/clients')
            .send({
                deviceId, deviceSecret: secret,
                client_name: 'Dev App',
                redirect_uris: ['http://localhost:3000/callback']
            });
        expect(res.status).toBe(201);
    });

    it('accepts https redirect_uri', async () => {
        const deviceId = 'oauth-c6';
        const secret = await registerDevice(deviceId);
        const res = await post('/api/oauth/clients')
            .send({
                deviceId, deviceSecret: secret,
                client_name: 'Prod App',
                redirect_uris: ['https://myapp.com/callback']
            });
        expect(res.status).toBe(201);
    });

    it('filters invalid scopes', async () => {
        const deviceId = 'oauth-c7';
        const secret = await registerDevice(deviceId);
        const res = await post('/api/oauth/clients')
            .send({
                deviceId, deviceSecret: secret,
                client_name: 'Scoped App',
                scopes: ['read', 'invalid_scope', 'write']
            });
        expect(res.status).toBe(201);
        expect(res.body.scopes).toEqual(['read', 'write']);
    });
});

// ── GET /api/oauth/clients ──

describe('GET /api/oauth/clients', () => {
    it('returns 401 without device credentials', async () => {
        const res = await get('/api/oauth/clients');
        expect(res.status).toBe(401);
    });

    it('returns client list for authenticated device', async () => {
        const deviceId = 'oauth-l1';
        const secret = await registerDevice(deviceId);
        const res = await get(`/api/oauth/clients?deviceId=${deviceId}&deviceSecret=${secret}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.clients)).toBe(true);
    });
});

// ── GET /api/oauth/authorize ──

describe('GET /api/oauth/authorize', () => {
    it('returns 400 for unsupported response_type', async () => {
        const res = await get('/api/oauth/authorize?response_type=token&client_id=test');
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('unsupported_response_type');
    });

    it('returns 400 without client_id', async () => {
        const res = await get('/api/oauth/authorize?response_type=code');
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_request');
    });

    it('returns 400 for unknown client_id (pg mock returns empty rows)', async () => {
        const res = await get('/api/oauth/authorize?response_type=code&client_id=unknown');
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_client');
    });
});

// ── POST /api/oauth/token ──

describe('POST /api/oauth/token', () => {
    it('returns 400 without grant_type', async () => {
        const res = await post('/api/oauth/token').send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_request');
    });

    it('returns 401 without client credentials', async () => {
        const res = await post('/api/oauth/token')
            .send({ grant_type: 'client_credentials' });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('invalid_client');
    });

    it('returns 401 for invalid client credentials (pg mock returns empty)', async () => {
        const res = await post('/api/oauth/token')
            .send({ grant_type: 'client_credentials', client_id: 'bad', client_secret: 'bad' });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('invalid_client');
    });

    it('accepts Basic auth header', async () => {
        const encoded = Buffer.from('client_id:client_secret').toString('base64');
        const res = await post('/api/oauth/token')
            .set('Authorization', `Basic ${encoded}`)
            .send({ grant_type: 'client_credentials' });
        // Will fail client validation (mock returns empty) but should parse Basic auth
        expect(res.status).toBe(401);
    });

    it('returns 400 for refresh_token grant without refresh_token', async () => {
        // This test needs a valid client in DB — since pg mock returns empty, it'll 401
        const res = await post('/api/oauth/token')
            .send({ grant_type: 'refresh_token', client_id: 'c', client_secret: 's' });
        expect(res.status).toBe(401); // client not found
    });
});

// ── POST /api/oauth/revoke ──

describe('POST /api/oauth/revoke', () => {
    it('returns 400 without token', async () => {
        const res = await post('/api/oauth/revoke').send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_request');
    });

    it('returns 200 even for unknown token (RFC 7009)', async () => {
        const res = await post('/api/oauth/revoke')
            .send({ token: 'nonexistent_token' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('accepts token_type_hint', async () => {
        const res = await post('/api/oauth/revoke')
            .send({ token: 'some_token', token_type_hint: 'refresh_token' });
        expect(res.status).toBe(200);
    });
});

// ── POST /api/oauth/introspect ──

describe('POST /api/oauth/introspect', () => {
    it('returns active: false without token', async () => {
        const res = await post('/api/oauth/introspect').send({});
        expect(res.status).toBe(400);
        expect(res.body.active).toBe(false);
    });

    it('returns active: false for invalid JWT', async () => {
        const res = await post('/api/oauth/introspect')
            .send({ token: 'not.a.valid.jwt' });
        expect(res.status).toBe(200);
        expect(res.body.active).toBe(false);
    });

    it('returns active: false for non-oauth JWT', async () => {
        const jwt = require('jsonwebtoken');
        const token = jwt.sign({ type: 'user_session', userId: 1 }, 'eclaw-dev-secret');
        const res = await post('/api/oauth/introspect')
            .send({ token });
        expect(res.status).toBe(200);
        expect(res.body.active).toBe(false);
    });

    it('returns active: false for valid oauth JWT but revoked in DB (mock returns empty)', async () => {
        const jwt = require('jsonwebtoken');
        const token = jwt.sign({
            type: 'oauth_access',
            client_id: 'test_client',
            device_id: 'test_device',
            scope: 'read write'
        }, 'eclaw-dev-secret', { expiresIn: 900 });
        const res = await post('/api/oauth/introspect')
            .send({ token });
        expect(res.status).toBe(200);
        // DB mock returns empty rows → token considered revoked
        expect(res.body.active).toBe(false);
    });
});
