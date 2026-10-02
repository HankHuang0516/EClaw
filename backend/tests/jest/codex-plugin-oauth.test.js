require('./helpers/mock-setup');

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { newDb } = require('pg-mem');
const dbMock = require('../../db');
const realAuth = jest.requireActual('../../auth');
const { createCodexPluginOAuth } = require('../../codex-plugin-oauth');

const BASE = 'https://eclaw.example';
const RESOURCE = `${BASE}/mcp`;
const MOUNT = '/api/codex/oauth';
const CALLBACK = 'https://client.example/callback?existing=1';
const VERIFIER = 'a'.repeat(43);
const CHALLENGE = crypto.createHash('sha256').update(VERIFIER).digest('base64url');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const session = (deviceId = 'owner-a', extra = {}) => jwt.sign({ deviceId, ...extra }, process.env.JWT_SECRET, { expiresIn: 3600 });
const bearer = token => ({ headers: { authorization: `Bearer ${token}` } });

let memory, sqlPool, pool, devices, oauth, app, ownerCookie, serverLog, connections;

beforeEach(async () => {
    // pg-mem's AST coverage checker rejects repeated IF NOT EXISTS clauses;
    // disable that checker while retaining execution of the real table schema.
    memory = newDb({ noAstCoverageCheck: true });
    const { Pool } = memory.adapters.createPg();
    sqlPool = new Pool();
    // Reuse the repository's injected db._mockPool shape; SQL is executed rather
    // than returning canned success rows. pg-mem has no PostgreSQL row locking:
    // serialize mock transactions and verify the actual locking SQL separately.
    pool = dbMock._getPool();
    const execute = (sql, values) => sqlPool.query(sql.replace(/FOR UPDATE OF t, g/g, 'FOR UPDATE'), values);
    // pg-mem parses FOR UPDATE but not its OF list. Recorded SQL retains the
    // production clause; PostgreSQL locking is not claimed by these mock tests.
    pool.query.mockReset().mockImplementation(execute);
    connections = [];
    let tail = Promise.resolve();
    pool.connect = jest.fn(async () => {
        const waitForPrevious = tail;
        let unlock;
        tail = new Promise(resolve => { unlock = resolve; });
        await waitForPrevious;
        let backup;
        const connection = {
            query: jest.fn(async (sql, values) => {
                if (sql === 'BEGIN') { backup = memory.backup(); return { rows: [] }; }
                if (sql === 'ROLLBACK') { backup.restore(); return { rows: [] }; }
                if (sql === 'COMMIT') return { rows: [] };
                return pool.query(sql, values);
            }),
            release: jest.fn(() => unlock())
        };
        connections.push(connection);
        return connection;
    });
    devices = { 'owner-a': { deviceSecret: 'private-owner-value' }, 'owner-b': { deviceSecret: 'private-other-value' } };
    ownerCookie = `eclaw_session=${session()}`;
    serverLog = jest.fn();
    // Exercise EClaw's real cookie middleware, not a substitute auth scheme.
    const authMiddleware = realAuth(devices).authMiddleware;
    oauth = createCodexPluginOAuth({ pool, devices, authMiddleware, baseUrl: BASE, serverLog });
    await oauth.initDatabase();
    app = express();
    app.use(MOUNT, oauth.router);
});

async function register(overrides = {}) {
    const result = await request(app).post(`${MOUNT}/register`).send({
        client_name: 'Test application', redirect_uris: [CALLBACK], ...overrides
    });
    expect(result.status).toBe(201);
    return result.body;
}

function authorization(client, overrides = {}) {
    return { client_id: client.client_id, response_type: 'code', redirect_uri: CALLBACK,
        resource: RESOURCE, scope: 'codex:read codex:manage', code_challenge: CHALLENGE,
        code_challenge_method: 'S256', state: 'opaque-client-state', ...overrides };
}

async function consent(client, overrides = {}, cookie = ownerCookie) {
    const response = await request(app).get(`${MOUNT}/authorize`).query(authorization(client, overrides)).set('Cookie', cookie);
    expect(response.status).toBe(200);
    const csrf = response.text.match(/name="csrf_token" value="([A-Za-z0-9_-]+)"/);
    expect(Boolean(csrf)).toBe(true);
    return { csrf: csrf[1], response };
}

function decision(csrf, value = 'approve', cookie = ownerCookie) {
    return request(app).post(`${MOUNT}/authorize`).set('Cookie', cookie).type('form')
        .send({ csrf_token: csrf, decision: value });
}

async function codeFor(client, overrides = {}) {
    const { csrf } = await consent(client, overrides);
    const response = await decision(csrf);
    expect(response.status).toBe(303);
    const url = new URL(response.headers.location);
    expect(url.searchParams.get('iss')).toBe(BASE);
    expect(url.searchParams.get('state')).toBe('opaque-client-state');
    return url.searchParams.get('code');
}

function exchange(client, code, overrides = {}) {
    return request(app).post(`${MOUNT}/token`).type('form').send({ grant_type: 'authorization_code',
        client_id: client.client_id, code, code_verifier: VERIFIER, redirect_uri: CALLBACK, resource: RESOURCE, ...overrides });
}

async function tokensFor(client, overrides = {}) {
    const code = await codeFor(client, overrides);
    const response = await exchange(client, code);
    expect(response.status).toBe(200);
    return response.body;
}

function refresh(client, token, overrides = {}) {
    return request(app).post(`${MOUNT}/token`).send({ grant_type: 'refresh_token',
        client_id: client.client_id, refresh_token: token, resource: RESOURCE, ...overrides });
}

function revoke(client, token, overrides = {}) {
    return request(app).post(`${MOUNT}/revoke`).send({ client_id: client.client_id, token, ...overrides });
}

async function rows(table) {
    // Table names are fixed test literals, never request values.
    return (await sqlPool.query(`SELECT * FROM ${table}`)).rows;
}

describe('factory, discovery and persistence', () => {
    test('exports exactly the requested named factory and methods', () => {
        expect(Object.keys(require('../../codex-plugin-oauth'))).toEqual(['createCodexPluginOAuth']);
        expect(Object.keys(oauth)).toEqual(['router', 'metadata', 'authenticateBearer', 'initDatabase']);
        expect(oauth.metadata).toMatchObject({ issuer: BASE, authorization_endpoint: `${BASE}${MOUNT}/authorize`,
            token_endpoint: `${BASE}${MOUNT}/token`, registration_endpoint: `${BASE}${MOUNT}/register`,
            revocation_endpoint: `${BASE}${MOUNT}/revoke`, code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'], grant_types_supported: ['authorization_code', 'refresh_token'],
            scopes_supported: ['codex:read', 'codex:manage'], authorization_response_iss_parameter_supported: true });
        expect(Object.isFrozen(oauth.metadata)).toBe(true);
    });

    test('requires the environment secret and HTTPS configuration without fallbacks', () => {
        const secret = process.env.JWT_SECRET;
        const args = { pool, devices, authMiddleware: realAuth(devices).authMiddleware, baseUrl: BASE };
        try {
            delete process.env.JWT_SECRET;
            expect(() => createCodexPluginOAuth(args)).toThrow('JWT_SECRET is required');
            process.env.JWT_SECRET = ' ';
            expect(() => createCodexPluginOAuth(args)).toThrow('JWT_SECRET is required');
        } finally { process.env.JWT_SECRET = secret; }
        expect(() => createCodexPluginOAuth({ ...args, baseUrl: 'http://eclaw.example' })).toThrow('HTTPS');
        expect(() => createCodexPluginOAuth({ ...args, pool: {} })).toThrow('dependencies');
        expect(() => createCodexPluginOAuth({ ...args, baseUrl: `${BASE}/ignored/path` })).toThrow('HTTPS');
        const trailingSlash = createCodexPluginOAuth({ ...args, baseUrl: `${BASE}/` });
        expect(trailingSlash.metadata.issuer).toBe(BASE);
        expect(trailingSlash.metadata.token_endpoint).toBe(`${BASE}${MOUNT}/token`);
    });

    test('initialization uses only additive CREATE TABLE IF NOT EXISTS and preserves clients', async () => {
        await register();
        pool.query.mockClear();
        await oauth.initDatabase();
        expect(await rows('codex_plugin_oauth_clients')).toHaveLength(1);
        expect(pool.query.mock.calls).toHaveLength(5);
        for (const [sql] of pool.query.mock.calls) {
            expect(sql.replace(/--[^\n]*/g, '').trim()).toMatch(/^CREATE TABLE IF NOT EXISTS codex_plugin_oauth_/);
            expect(sql).not.toMatch(/\b(ALTER|DROP|DELETE|TRUNCATE|CREATE INDEX)\b/i);
        }
        expect(require('pg').Pool).not.toHaveBeenCalled();
    });

    test('initialization rejects with sanitized errors for readiness gates', async () => {
        pool.query.mockRejectedValueOnce(new Error('private-database-value'));
        await expect(oauth.initDatabase()).rejects.toThrow('Public-plugin OAuth database initialization failed');
        expect(serverLog).toHaveBeenCalledWith('error', 'codex_plugin', 'OAuth operation failed');
        expect(serverLog.mock.calls[0]).toHaveLength(3); // static event only; no owner/request metadata
        expect(JSON.stringify(serverLog.mock.calls)).not.toContain('private-database-value');
    });

    test('accepts the existing auth mock query-only pool at startup but never mints without connect', async () => {
        const queryOnlyPool = { query: pool.query };
        const instance = createCodexPluginOAuth({ pool: queryOnlyPool, devices,
            authMiddleware: realAuth(devices).authMiddleware, baseUrl: BASE });
        await expect(instance.initDatabase()).resolves.toBeUndefined();
        const client = await register();
        const code = await codeFor(client);
        const isolated = express();
        isolated.use(MOUNT, instance.router);
        const response = await request(isolated).post(`${MOUNT}/token`).send({ grant_type: 'authorization_code',
            client_id: client.client_id, code, code_verifier: VERIFIER, redirect_uri: CALLBACK, resource: RESOURCE });
        expect(response.status).toBe(500);
        expect(await rows('codex_plugin_oauth_tokens')).toHaveLength(0);
        expect((await rows('codex_plugin_oauth_codes'))[0].consumed_at).toBeNull();
    });
});

describe('dynamic public-client registration', () => {
    test('returns a public client with an exact HTTPS URI allowlist and no secret', async () => {
        const client = await register();
        expect(client.token_endpoint_auth_method).toBe('none');
        expect(client.client_secret).toBeUndefined();
        expect(client.redirect_uris).toEqual([CALLBACK]);
        expect(client.grant_types).toEqual(['authorization_code', 'refresh_token']);
        expect(client.scope).toBe('codex:read codex:manage');
    });

    test.each(['http://client.example/cb', 'http://localhost/cb', 'javascript:alert(1)',
        'https://user:pass@client.example/cb', 'https://client.example/cb#fragment', 'https://client.example/cb#',
        'https://client.example/cb ', 'https://client.example/\\evil', 'not-a-url'])('rejects unsafe callback %s', async callback => {
        const response = await request(app).post(`${MOUNT}/register`).send({ client_name: 'Test', redirect_uris: [callback] });
        expect(response.status).toBe(400);
        expect(response.body.error).toBe('invalid_client_metadata');
        expect(await rows('codex_plugin_oauth_clients')).toHaveLength(0);
    });

    test.each([
        { grant_types: ['client_credentials'] }, { grant_types: ['authorization_code', 'admin'] },
        { grant_types: ['authorization_code', 'authorization_code'] }, { token_endpoint_auth_method: 'client_secret_basic' },
        { response_types: ['token'] }, { scope: 'admin' }, { scope: 'read write' },
        { scope: 'codex:read admin' }, { scope: ['codex:read'] }, { redirect_uris: [] },
        { redirect_uris: [CALLBACK, CALLBACK] }, { client_name: 'x'.repeat(201) },
        { client_name: { untrusted: 'object' } }, { client_name: 'name\nheader' }, { unknown_admin_field: true }
    ])('rejects unrestricted grants/scopes and invalid metadata (%j)', async override => {
        const response = await request(app).post(`${MOUNT}/register`).send({ client_name: 'Test', redirect_uris: [CALLBACK], ...override });
        expect(response.status).toBe(400);
        expect(await rows('codex_plugin_oauth_clients')).toHaveLength(0);
    });

    test('enforces registration rate limits even in test mode', async () => {
        for (let i = 0; i < 10; i++) await register();
        const response = await request(app).post(`${MOUNT}/register`).send({ client_name: 'Test', redirect_uris: [CALLBACK] });
        expect(response.status).toBe(429);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(await rows('codex_plugin_oauth_clients')).toHaveLength(10);
    });

    test('bounds JSON, form parameters, already-parsed bodies and malformed input', async () => {
        const oversized = await request(app).post(`${MOUNT}/register`).send({ client_name: 'x'.repeat(17000) });
        expect(oversized.status).toBe(413);
        expect(oversized.headers['cache-control']).toBe('no-store');
        const malformed = await request(app).post(`${MOUNT}/register`).set('Content-Type', 'application/json').send('{bad');
        expect(malformed.status).toBe(400);
        expect(malformed.text).not.toContain('{bad');
        const array = await request(app).post(`${MOUNT}/register`).send([]);
        expect(array.status).toBe(400);
        const form = await request(app).post(`${MOUNT}/register`).type('form')
            .send(new URLSearchParams(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])).toString());
        expect(form.status).toBe(400);
        const parent = express();
        parent.use(express.json({ limit: '100kb' }));
        parent.use(MOUNT, oauth.router);
        const parsed = await request(parent).post(`${MOUNT}/register`).send({ client_name: 'x'.repeat(17000) });
        expect(parsed.status).toBe(400);
    });
});

describe('owner session and visible consent', () => {
    test('GET never auto-approves; POST with session CSRF is required, and untrusted names are escaped', async () => {
        const client = await register({ client_name: '<img src=x onerror=alert(1)> & "quoted"' });
        const { response, csrf } = await consent(client);
        expect(response.text).toContain('&lt;img');
        expect(response.text).not.toContain('<img');
        expect(response.text).toContain('&amp; &quot;quoted&quot;');
        expect(response.text).toContain('Allow access');
        expect(response.text).toContain('codex:manage');
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
        expect(response.text).not.toContain(devices['owner-a'].deviceSecret);
        expect(await rows('codex_plugin_oauth_codes')).toHaveLength(0);
        expect(await rows('codex_plugin_oauth_tokens')).toHaveLength(0);
        expect((await decision(csrf)).status).toBe(303);
        expect(await rows('codex_plugin_oauth_codes')).toHaveLength(1);
        expect((await decision(csrf)).status).toBe(403);
    });

    test('signed-out page keeps authorize URL open, opens portal in a new tab and polls the owner session', async () => {
        const client = await register();
        const response = await request(app).get(`${MOUNT}/authorize`).query(authorization(client));
        expect(response.status).toBe(200);
        expect(response.headers.location).toBeUndefined();
        expect(response.text).toContain('href="/portal/" target="_blank" rel="noopener noreferrer"');
        expect(response.text).toContain("fetch('/api/auth/me', {credentials: 'same-origin', cache: 'no-store'})");
        expect(response.text).toContain('window.location.reload()');
        expect(response.text).not.toContain('name="csrf_token"');
        expect(response.headers['content-security-policy']).toMatch(/script-src 'nonce-/);
        expect(await rows('codex_plugin_oauth_consents')).toHaveLength(0);
        await consent(client);
    });

    test('real auth middleware rejects forged/expired cookies, bearer-only owners and missing devices', async () => {
        const client = await register();
        const forged = await request(app).get(`${MOUNT}/authorize`).query(authorization(client)).set('Cookie', 'eclaw_session=forged');
        expect(forged.text).toContain('Sign in to EClaw');
        const expired = jwt.sign({ deviceId: 'owner-a', exp: 1 }, process.env.JWT_SECRET);
        const expResponse = await request(app).get(`${MOUNT}/authorize`).query(authorization(client)).set('Cookie', `eclaw_session=${expired}`);
        expect(expResponse.text).toContain('Sign in to EClaw');
        const bearerOnly = await request(app).get(`${MOUNT}/authorize`).query(authorization(client)).set('Authorization', `Bearer ${session()}`);
        expect(bearerOnly.text).toContain('Sign in to EClaw');
        const unknown = await request(app).get(`${MOUNT}/authorize`).query(authorization(client)).set('Cookie', `eclaw_session=${session('not-owned')}`);
        expect(unknown.status).toBe(403);
        const post = await request(app).post(`${MOUNT}/authorize`).send({ decision: 'approve' });
        expect(post.status).toBe(401);
    });

    test.each([
        { response_type: 'token' }, { client_id: 'unknown' }, { redirect_uri: `${CALLBACK}&other=1` },
        { resource: `${BASE}/another` }, { resource: undefined }, { scope: 'admin' }, { scope: 'codex:read codex:read' },
        { code_challenge_method: 'plain' }, { code_challenge: 'short' }, { code_challenge: undefined },
        { code_challenge: ['x', 'y'] }, { state: 'x'.repeat(1025) }, { lang: 'not-supported' }, { deviceId: 'owner-b' }
    ])('rejects authorization input without creating state (%j)', async override => {
        const client = await register();
        const response = await request(app).get(`${MOUNT}/authorize`).query(authorization(client, override)).set('Cookie', ownerCookie);
        expect([400, 401]).toContain(response.status);
        expect(response.headers.location).toBeUndefined();
        expect(await rows('codex_plugin_oauth_consents')).toHaveLength(0);
    });

    test('registered scopes constrain authorization and default consent to read', async () => {
        const client = await register({ scope: 'codex:read' });
        const response = await request(app).get(`${MOUNT}/authorize`).query(authorization(client)).set('Cookie', ownerCookie);
        expect(response.body.error).toBe('invalid_scope');
        const { response: readOnly } = await consent(client, { scope: undefined });
        expect(readOnly.text).toContain('codex:read');
        expect(readOnly.text).not.toContain('codex:manage');
    });

    test.each([
        ['en', 'Allow access', 'Invalid permissions.'], ['zh-TW', '允許存取', '權限無效。'],
        ['zh-CN', '允许访问', '权限无效。'], ['ja', 'アクセスを許可', '無効な権限です。'], ['ko', '접근 허용', '잘못된 권한입니다.'],
        ['th', 'อนุญาตการเข้าถึง', 'สิทธิ์ไม่ถูกต้อง'], ['vi', 'Cho phép truy cập', 'Quyền không hợp lệ.'],
        ['id', 'Izinkan akses', 'Izin tidak valid.'], ['fr', 'Autoriser l’accès', 'Autorisations invalides.'],
        ['es', 'Permitir acceso', 'Permisos no válidos.'], ['de', 'Zugriff erlauben', 'Ungültige Berechtigungen.'],
        ['ms', 'Benarkan akses', 'Kebenaran tidak sah.'], ['hi', 'पहुंच की अनुमति दें', 'अमान्य अनुमतियां।'],
        ['ar', 'السماح بالوصول', 'أذونات غير صالحة.']
    ])('translates every consent and error locale (%s)', async (lang, label, errorText) => {
        const client = await register();
        const { response } = await consent(client, { lang });
        expect(response.text).toContain(`<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">`);
        expect(response.text).toContain(label);
        expect(response.text).not.toContain('undefined');
        const invalid = await request(app).get(`${MOUNT}/authorize`).set('Accept-Language', lang)
            .query(authorization(client, { scope: 'admin' }));
        expect(invalid.body.error_description).toBe(errorText);
    });

    test('all server translation keys have nonempty entries across the full repository locale set', () => {
        const source = fs.readFileSync(path.join(__dirname, '../../codex-plugin-oauth.js'), 'utf8');
        const dictionary = vm.runInNewContext(`(${source.match(/const TEXT = (\{[\s\S]*?\n\});/)[1]})`);
        expect(Object.keys(dictionary).sort()).toEqual(['en', 'zh-TW', 'zh-CN', 'ja', 'ko', 'th', 'vi', 'id', 'fr', 'es', 'de', 'ms', 'hi', 'ar'].sort());
        for (const entries of Object.values(dictionary)) {
            expect(Object.keys(entries).sort()).toEqual(Object.keys(dictionary.en).sort());
            expect(Object.values(entries).every(value => typeof value === 'string' && value.length > 0)).toBe(true);
            expect(entries.title).toContain('EClawbot');
            expect(entries.login).toContain('EClawbot');
            expect(entries.read).toContain('EClawbot');
            expect(entries.manage).toContain('Codex');
        }
        expect(dictionary.en.read).toBe('Read your EClawbot Codex profile, entities, configuration and connection logs.');
        expect(dictionary.en.manage).toBe('Create and configure Codex entities; approve or disconnect their local runtime.');
    });

    test('legacy zh links select Traditional Chinese, and mobile/RTL UI keeps clear readable actions', async () => {
        const client = await register({ client_name: 'A'.repeat(200) });
        const zh = await consent(client, { lang: 'zh' });
        expect(zh.response.text).toContain('<html lang="zh-TW"');
        const arabic = await consent(client, { lang: 'ar' });
        expect(arabic.response.text).toContain('dir="rtl"');
        expect(arabic.response.text).toContain('<bdi dir="ltr">');
        expect(arabic.response.text).toContain('overflow-wrap:anywhere');
        expect(arabic.response.text).toContain('min-height:44px');
        expect(arabic.response.text).toContain(':focus-visible');
    });

    test('CSRF is owner/session-bound, origin-checked and rejects tampered forms', async () => {
        const client = await register();
        const { csrf } = await consent(client);
        const otherOwner = await decision(csrf, 'approve', `eclaw_session=${session('owner-b')}`);
        expect(otherOwner.status).toBe(403);
        const renewed = await decision(csrf, 'approve', `eclaw_session=${session('owner-a', { jti: 'another-session' })}`);
        expect(renewed.status).toBe(403);
        const crossOrigin = await decision(csrf).set('Origin', 'https://evil.example');
        expect(crossOrigin.status).toBe(403);
        const crossReferer = await decision(csrf).set('Referer', 'https://evil.example/');
        expect(crossReferer.status).toBe(403);
        const wrong = await decision('b'.repeat(43));
        expect(wrong.status).toBe(403);
        const tamper = await request(app).post(`${MOUNT}/authorize`).set('Cookie', ownerCookie)
            .send({ csrf_token: csrf, decision: 'approve', scope: 'admin' });
        expect(tamper.status).toBe(400);
        expect(await rows('codex_plugin_oauth_codes')).toHaveLength(0);
        const ok = await decision(csrf).set('Origin', BASE);
        expect(ok.status).toBe(303);
    });

    test('expired consent is rejected and cancellation echoes state and issuer without issuing a code', async () => {
        const client = await register();
        const { csrf } = await consent(client);
        await sqlPool.query('UPDATE codex_plugin_oauth_consents SET expires_at = $1', [new Date(0)]);
        expect((await decision(csrf)).status).toBe(403);
        const another = await consent(client);
        const denial = await decision(another.csrf, 'deny');
        expect(denial.status).toBe(303);
        const redirect = new URL(denial.headers.location);
        expect(redirect.searchParams.get('error')).toBe('access_denied');
        expect(redirect.searchParams.get('iss')).toBe(BASE);
        expect(redirect.searchParams.get('state')).toBe('opaque-client-state');
        expect(redirect.searchParams.has('code')).toBe(false);
        expect(await rows('codex_plugin_oauth_codes')).toHaveLength(0);
    });
});

describe('PKCE, token persistence and one-time codes', () => {
    test('valid S256 exchange authenticates only the device principal and never stores raw credentials', async () => {
        const client = await register();
        const code = await codeFor(client);
        const response = await exchange(client, code);
        expect(response.status).toBe(200);
        const tokens = response.body;
        expect(tokens.token_type).toBe('Bearer');
        expect(tokens.expires_in).toBe(900);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(jwt.decode(tokens.access_token)).toMatchObject({ iss: BASE, aud: RESOURCE, sub: 'owner-a', type: 'codex_plugin_access' });
        expect(await oauth.authenticateBearer(bearer(tokens.access_token), ['codex:manage'])).toEqual({
            deviceId: 'owner-a', scopes: ['codex:read', 'codex:manage'], clientId: client.client_id
        });
        const persisted = JSON.stringify(await rows('codex_plugin_oauth_tokens'));
        for (const raw of [code, tokens.access_token, tokens.refresh_token, ownerCookie, devices['owner-a'].deviceSecret]) {
            expect(persisted.includes(raw)).toBe(false);
        }
        expect((await rows('codex_plugin_oauth_codes'))[0].code_hash === digest(code)).toBe(true);
        const stored = (await rows('codex_plugin_oauth_tokens'))[0];
        expect(stored.access_hash === digest(tokens.access_token)).toBe(true);
        expect(stored.refresh_hash === digest(tokens.refresh_token)).toBe(true);
        const update = pool.query.mock.calls.find(([sql]) => /UPDATE codex_plugin_oauth_codes/.test(sql))[0];
        for (const predicate of ['client_id = $2', 'redirect_uri = $3', 'resource = $4', 'code_challenge = $5', 'consumed_at IS NULL', 'expires_at > NOW()']) {
            expect(update).toContain(predicate);
        }
    });

    test('wrong PKCE, redirect, resource or client cannot consume the code; correct exchange succeeds only once', async () => {
        const client = await register();
        const other = await register();
        const code = await codeFor(client);
        for (const override of [{ code_verifier: 'b'.repeat(43) }, { redirect_uri: `${CALLBACK}&x=1` },
            { resource: `${BASE}/wrong` }, { client_id: other.client_id }]) {
            const response = await exchange(client, code, override);
            expect(response.status).toBe(400);
            expect((await rows('codex_plugin_oauth_codes'))[0].consumed_at).toBeNull();
        }
        expect((await exchange(client, code)).status).toBe(200);
        expect((await exchange(client, code)).body.error).toBe('invalid_grant');
        expect(await rows('codex_plugin_oauth_tokens')).toHaveLength(1);
    });

    test('concurrent code exchanges have exactly one winner', async () => {
        const client = await register();
        const code = await codeFor(client);
        const responses = await Promise.all([exchange(client, code), exchange(client, code)]);
        expect(responses.map(r => r.status).sort()).toEqual([200, 400]);
        expect(await rows('codex_plugin_oauth_tokens')).toHaveLength(1);
        expect(connections.every(connection => connection.release.mock.calls.length === 1)).toBe(true);
    });

    test('a different URI in the same client allowlist cannot exchange a code', async () => {
        const otherCallback = 'https://client.example/other-callback';
        const client = await register({ redirect_uris: [CALLBACK, otherCallback] });
        const code = await codeFor(client);
        expect((await exchange(client, code, { redirect_uri: otherCallback })).body.error).toBe('invalid_grant');
        expect((await rows('codex_plugin_oauth_codes'))[0].consumed_at).toBeNull();
        expect((await exchange(client, code)).status).toBe(200);
    });

    test('pool connection rejection fails before any code, grant or token mutation', async () => {
        const client = await register();
        const code = await codeFor(client);
        pool.query.mockClear();
        pool.connect.mockRejectedValueOnce(new Error('private-connection-value'));
        const response = await exchange(client, code);
        expect(response.status).toBe(500);
        expect(pool.query.mock.calls.some(([sql]) => /UPDATE|INSERT/.test(sql))).toBe(false);
        expect((await rows('codex_plugin_oauth_codes'))[0].consumed_at).toBeNull();
        expect(await rows('codex_plugin_oauth_tokens')).toHaveLength(0);
        expect(await rows('codex_plugin_oauth_grants')).toHaveLength(0);
        expect(JSON.stringify(serverLog.mock.calls)).not.toContain('private-connection-value');
    });

    test('expired codes and missing device owners cannot mint tokens', async () => {
        const client = await register();
        const code = await codeFor(client);
        await sqlPool.query('UPDATE codex_plugin_oauth_codes SET expires_at = $1', [new Date(0)]);
        expect((await exchange(client, code)).body.error).toBe('invalid_grant');
        const anotherCode = await codeFor(client);
        delete devices['owner-a'];
        expect((await exchange(client, anotherCode)).body.error).toBe('invalid_grant');
        expect(await rows('codex_plugin_oauth_tokens')).toHaveLength(0);
    });

    test('persistence failure rolls back consumption and token/grant writes with sanitized logs', async () => {
        const client = await register();
        const code = await codeFor(client);
        pool.query.mockImplementation((sql, values) => {
            if (/INSERT INTO codex_plugin_oauth_tokens/.test(sql)) throw new Error('private-database-value');
            return sqlPool.query(sql, values);
        });
        const response = await exchange(client, code);
        expect(response.status).toBe(500);
        expect(response.body).toEqual({ error: 'server_error', error_description: 'Unable to complete authorization.' });
        expect((await rows('codex_plugin_oauth_codes'))[0].consumed_at).toBeNull();
        expect(await rows('codex_plugin_oauth_grants')).toHaveLength(0);
        expect(connections.at(-1).query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
        expect(connections.at(-1).release).toHaveBeenCalledTimes(1);
        const logs = JSON.stringify(serverLog.mock.calls);
        for (const value of ['private-database-value', code, ownerCookie, devices['owner-a'].deviceSecret]) expect(logs.includes(value)).toBe(false);
        pool.query.mockImplementation((sql, values) => sqlPool.query(sql, values));
        expect((await exchange(client, code)).status).toBe(200);
    });

    test('only the registered grant types are available, and confidential client auth is rejected', async () => {
        const client = await register({ grant_types: ['authorization_code'] });
        const tokens = await tokensFor(client);
        expect(tokens.refresh_token).toBeUndefined();
        const unsupported = await exchange(client, 'a'.repeat(43), { grant_type: 'client_credentials' });
        expect(unsupported.body.error).toBe('unsupported_grant_type');
        const disallowed = await refresh(client, 'a'.repeat(43));
        expect(disallowed.body.error).toBe('unauthorized_client');
        const basic = await exchange(client, 'a'.repeat(43)).set('Authorization', 'Basic Zm9vOmJhcg==');
        expect(basic.status).toBe(401);
        const secret = await exchange(client, 'a'.repeat(43), { client_secret: 'untrusted-value' });
        expect(secret.status).toBe(400);
    });
});

describe('refresh rotation and family revocation', () => {
    test('rotation narrows scopes, keeps absolute expiry, and revokes the family on replay', async () => {
        const client = await register();
        const original = await tokensFor(client);
        const originalExpiry = (await rows('codex_plugin_oauth_grants'))[0].expires_at;
        const result = await refresh(client, original.refresh_token, { scope: 'codex:read' });
        expect(result.status).toBe(200);
        expect(result.body.scope).toBe('codex:read');
        expect(result.body.refresh_token === original.refresh_token).toBe(false);
        expect(result.body.access_token === original.access_token).toBe(false);
        await expect(oauth.authenticateBearer(bearer(result.body.access_token), ['codex:manage'])).rejects.toMatchObject({ status: 403, code: 'insufficient_scope' });
        expect((await refresh(client, result.body.refresh_token, { scope: 'codex:manage' })).body.error).toBe('invalid_scope');
        const final = await refresh(client, result.body.refresh_token);
        expect(final.status).toBe(200);
        expect(final.body.scope).toBe('codex:read');
        const stored = await rows('codex_plugin_oauth_tokens');
        expect(stored.every(t => t.refresh_expires_at.getTime() === originalExpiry.getTime())).toBe(true);
        const lock = pool.query.mock.calls.find(([sql]) => /FOR UPDATE OF t, g/.test(sql));
        expect(Boolean(lock)).toBe(true);
        expect(lock[0]).toContain('g.client_id = $2');
        expect(lock[0]).toContain('g.resource = $3');
        expect(lock[0]).toContain('t.refresh_expires_at > NOW()');
        expect((await refresh(client, original.refresh_token)).body.error).toBe('invalid_grant');
        expect((await refresh(client, final.body.refresh_token)).body.error).toBe('invalid_grant');
        await expect(oauth.authenticateBearer(bearer(final.body.access_token))).rejects.toMatchObject({ status: 401 });
    });

    test('concurrent refreshes have exactly one winner', async () => {
        const client = await register();
        const tokens = await tokensFor(client);
        const responses = await Promise.all([refresh(client, tokens.refresh_token), refresh(client, tokens.refresh_token)]);
        expect(responses.map(r => r.status).sort()).toEqual([200, 400]);
        expect(await rows('codex_plugin_oauth_tokens')).toHaveLength(2);
    });

    test('failed refresh persistence rolls back consumption so the original refresh remains usable', async () => {
        const client = await register();
        const tokens = await tokensFor(client);
        pool.query.mockImplementation((sql, values) => {
            if (/INSERT INTO codex_plugin_oauth_tokens/.test(sql)) throw new Error('private-database-value');
            return sqlPool.query(sql.replace(/FOR UPDATE OF t, g/g, 'FOR UPDATE'), values);
        });
        expect((await refresh(client, tokens.refresh_token)).status).toBe(500);
        const stored = await rows('codex_plugin_oauth_tokens');
        expect(stored).toHaveLength(1);
        expect(stored[0].refresh_consumed_at).toBeNull();
        expect(connections.at(-1).query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
        pool.query.mockImplementation((sql, values) => sqlPool.query(sql.replace(/FOR UPDATE OF t, g/g, 'FOR UPDATE'), values));
        expect((await refresh(client, tokens.refresh_token)).status).toBe(200);
    });

    test('refresh binds to client/resource and rejects token or family expiry', async () => {
        const client = await register();
        const other = await register();
        const tokens = await tokensFor(client);
        expect((await refresh(other, tokens.refresh_token)).body.error).toBe('invalid_grant');
        expect((await refresh(client, tokens.refresh_token, { resource: `${BASE}/other` })).body.error).toBe('invalid_target');
        expect((await refresh(client, tokens.refresh_token, { scope: 'admin' })).body.error).toBe('invalid_scope');
        await sqlPool.query('UPDATE codex_plugin_oauth_tokens SET refresh_expires_at = $1', [new Date(0)]);
        expect((await refresh(client, tokens.refresh_token)).body.error).toBe('invalid_grant');
        await sqlPool.query('UPDATE codex_plugin_oauth_tokens SET refresh_expires_at = $1', [new Date(Date.now() + 60000)]);
        await sqlPool.query('UPDATE codex_plugin_oauth_grants SET expires_at = $1', [new Date(0)]);
        expect((await refresh(client, tokens.refresh_token)).body.error).toBe('invalid_grant');
    });

    test.each(['access_token', 'refresh_token'])('revoke %s invalidates all family tokens and refreshes', async kind => {
        const client = await register();
        const tokens = await tokensFor(client);
        const rotated = await refresh(client, tokens.refresh_token);
        expect(rotated.status).toBe(200);
        const response = await revoke(client, tokens[kind], { token_type_hint: kind });
        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        for (const token of [tokens.access_token, rotated.body.access_token]) {
            await expect(oauth.authenticateBearer(bearer(token))).rejects.toMatchObject({ status: 401 });
        }
        expect((await refresh(client, rotated.body.refresh_token)).body.error).toBe('invalid_grant');
    });

    test('unknown/other-client revocations disclose nothing and cannot revoke another client', async () => {
        const client = await register();
        const other = await register();
        const tokens = await tokensFor(client);
        expect((await revoke(other, tokens.refresh_token)).status).toBe(200);
        expect((await revoke(client, 'unknown-token')).status).toBe(200);
        expect((await oauth.authenticateBearer(bearer(tokens.access_token))).deviceId).toBe('owner-a');
        expect((await revoke(client, tokens.access_token, { token_type_hint: 'other' })).status).toBe(400);
        expect((await request(app).post(`${MOUNT}/revoke`).send({ token: tokens.refresh_token })).status).toBe(400);
    });
});

describe('strict resource-server JWT validation', () => {
    test.each([
        ['issuer', { iss: 'https://other.example' }], ['audience', { aud: `${BASE}/other` }],
        ['audience array', { aud: [RESOURCE, 'https://other.example'] }], ['type', { type: 'user_session' }],
        ['expiry', { exp: 1 }], ['missing expiry', { exp: undefined }], ['future validity', { nbf: 4102444800 }],
        ['unknown owner', { sub: 'unknown' }], ['legacy device token', { type: 'oauth_access', deviceId: 'owner-a' }],
        ['unknown scope', { scope: 'codex:read admin' }], ['client identity', { client_id: 'other-client' }],
        ['missing jti', { jti: undefined }]
    ])('rejects %s with sanitized 401', async (_label, mutation) => {
        const client = await register();
        const tokens = await tokensFor(client);
        const claims = { ...jwt.decode(tokens.access_token), ...mutation };
        for (const key of Object.keys(claims)) if (claims[key] === undefined) delete claims[key];
        const token = jwt.sign(claims, process.env.JWT_SECRET, { algorithm: 'HS256', header: { typ: 'at+jwt' } });
        await expect(oauth.authenticateBearer(bearer(token))).rejects.toMatchObject({ status: 401, statusCode: 401,
            code: 'invalid_token', message: 'Authentication required.' });
    });

    test('signature, algorithm, header type, token DB state and scope checks are mandatory', async () => {
        const client = await register();
        const tokens = await tokensFor(client, { scope: 'codex:read' });
        const claims = jwt.decode(tokens.access_token);
        for (const token of [jwt.sign(claims, 'incorrect-signing-key', { header: { typ: 'at+jwt' } }),
            jwt.sign(claims, process.env.JWT_SECRET, { algorithm: 'HS384', header: { typ: 'at+jwt' } }),
            jwt.sign(claims, process.env.JWT_SECRET), jwt.sign(claims, null, { algorithm: 'none' })]) {
            await expect(oauth.authenticateBearer(bearer(token))).rejects.toMatchObject({ status: 401 });
        }
        for (const req of [{}, { headers: {} }, { headers: { authorization: 'not-bearer' } },
            { headers: { authorization: ['Bearer', 'a-token'] } }, { headers: { authorization: `Bearer ${'a'.repeat(5000)}` } }]) {
            await expect(oauth.authenticateBearer(req)).rejects.toMatchObject({ status: 401 });
        }
        await expect(oauth.authenticateBearer(bearer(tokens.access_token), ['admin'])).rejects.toMatchObject({ status: 403 });
        await expect(oauth.authenticateBearer(bearer(tokens.access_token), 'codex:read')).rejects.toMatchObject({ status: 403 });
        await sqlPool.query('UPDATE codex_plugin_oauth_tokens SET access_expires_at = $1', [new Date(0)]);
        await expect(oauth.authenticateBearer(bearer(tokens.access_token))).rejects.toMatchObject({ status: 401 });
        await sqlPool.query('DELETE FROM codex_plugin_oauth_tokens');
        await expect(oauth.authenticateBearer(bearer(tokens.access_token))).rejects.toMatchObject({ status: 401 });
    });

    test('DB identity mismatches and failures fail closed without leaking DB/request values', async () => {
        const client = await register();
        const tokens = await tokensFor(client);
        await sqlPool.query('UPDATE codex_plugin_oauth_grants SET device_id = $1', ['owner-b']);
        await expect(oauth.authenticateBearer(bearer(tokens.access_token))).rejects.toMatchObject({ status: 401 });
        pool.query.mockRejectedValueOnce(new Error('private-database-value'));
        await expect(oauth.authenticateBearer(bearer(tokens.access_token))).rejects.toMatchObject({ status: 401, message: 'Authentication required.' });
        expect(serverLog).not.toHaveBeenCalled();
    });

    test('persistent tokens survive factory reconstruction and respect deleted owners', async () => {
        const client = await register();
        const tokens = await tokensFor(client);
        const replacement = createCodexPluginOAuth({ pool, devices: new Map(Object.entries(devices)),
            authMiddleware: realAuth(devices).authMiddleware, baseUrl: `${BASE}/` });
        expect((await replacement.authenticateBearer(bearer(tokens.access_token))).clientId).toBe(client.client_id);
        delete devices['owner-a'];
        await expect(oauth.authenticateBearer(bearer(tokens.access_token))).rejects.toMatchObject({ status: 401 });
    });
});
