/**
 * Redirect state machine Phase A — card_14571f26914b9c1eae148362.
 * Spec: docs/redirect-state-machine-spec.md (APPROVED, #6 review folded).
 * Covers: route registry shapes/validation, HMAC sig roundtrip, /r/ entry
 * states, server-side mint auth, telemetry beacon validation, return_to guard.
 */
'use strict';

const express = require('express');
const request = require('supertest');

const registry = require('../../shared/route-registry');
const redirect = require('../../redirect-router');

const DEVICE = 'dev-redirect-test';
const DEVICES = {
    [DEVICE]: {
        deviceSecret: 'ds-secret',
        entities: { 2: { isBound: true, botSecret: 'bs-secret' } },
    },
};

function makeApp() {
    redirect.init({ chatPool: null, devices: DEVICES, jwtSecret: 'test-signing-secret' });
    const app = express();
    app.use(redirect.router);
    return app;
}

describe('route registry — URL shapes match current consumers (#6 amendment 1)', () => {
    test('card → kanban ?card=<id>#<id>', () => {
        expect(registry.buildWebUrl('card', { cardId: 'card_abc123def456' }))
            .toBe('/portal/kanban.html?card=card_abc123def456#card_abc123def456');
    });
    test('chat → ?contact=<publicCode>', () => {
        expect(registry.buildWebUrl('chat', { publicCode: '3xa3h4' }))
            .toBe('/portal/chat.html?contact=3xa3h4');
    });
    test('note → mission ?note=', () => {
        expect(registry.buildWebUrl('note', { noteId: 'n-42' }))
            .toBe('/portal/mission.html?note=n-42');
    });
    test('profile → /p/:publicCode (not /portal/bot/)', () => {
        expect(registry.buildWebUrl('profile', { publicCode: 'tbwb9e' })).toBe('/p/tbwb9e');
    });
    test('param regexes reject malformed input', () => {
        expect(registry.validateParams('card', { cardId: 'not-a-card' }).ok).toBe(false);
        expect(registry.validateParams('chat', { publicCode: 'UPPER!' }).ok).toBe(false);
        expect(registry.validateParams('card', {}).ok).toBe(false);
        expect(registry.validateParams('nope', {}).error).toBe('unknown_target');
    });
    test('sensitive flags: card/note signed, chat/profile public (approved open-point 3)', () => {
        expect(registry.ROUTES.card.sensitive).toBe(true);
        expect(registry.ROUTES.note.sensitive).toBe(true);
        expect(registry.ROUTES.chat.sensitive).toBe(false);
        expect(registry.ROUTES.profile.sensitive).toBe(false);
    });
});

describe('route registry — isSafeReturnTo (no open redirect)', () => {
    test.each([
        ['/portal/chat.html?contact=abc123', true],
        ['/r/card?cardId=card_abc123def456', true],
        ['/portal/dashboard.html', true],
        ['https://evil.example/portal/chat.html', false],
        ['//evil.example/phish', false],
        ['/portal/unknown-page.html', false],
        ['javascript:alert(1)', false],
    ])('%s → %s', (value, ok) => {
        expect(registry.isSafeReturnTo(value)).toBe(ok);
    });
});

describe('sig — HMAC roundtrip', () => {
    beforeAll(() => redirect.init({ chatPool: null, devices: DEVICES, jwtSecret: 'test-signing-secret' }));
    const { computeSig, verifySig } = redirect._internal;
    const params = { cardId: 'card_abc123def456' };

    test('valid sig within exp verifies', () => {
        const exp = Math.floor(Date.now() / 1000) + 60;
        expect(verifySig('card', params, exp, computeSig('card', params, exp))).toBe(true);
    });
    test('expired sig rejected', () => {
        const exp = Math.floor(Date.now() / 1000) - 1;
        expect(verifySig('card', params, exp, computeSig('card', params, exp))).toBe(false);
    });
    test('tampered param rejected', () => {
        const exp = Math.floor(Date.now() / 1000) + 60;
        const sig = computeSig('card', params, exp);
        expect(verifySig('card', { cardId: 'card_fff000fff000' }, exp, sig)).toBe(false);
    });
});

describe('GET /r/:target', () => {
    let app;
    beforeEach(() => { app = makeApp(); });

    test('public target 302s to the registry web URL with traceId appended', async () => {
        const res = await request(app).get('/r/chat?publicCode=3xa3h4');
        expect(res.status).toBe(302);
        expect(res.headers.location).toMatch(/^\/portal\/chat\.html\?contact=3xa3h4&traceId=rt_[a-f0-9]{12}$/);
    });
    test('traceId lands BEFORE the hash for card targets', async () => {
        const exp = Math.floor(Date.now() / 1000) + 60;
        const sig = redirect._internal.computeSig('card', { cardId: 'card_abc123def456' }, exp);
        const res = await request(app).get(`/r/card?cardId=card_abc123def456&exp=${exp}&sig=${sig}`);
        expect(res.status).toBe(302);
        expect(res.headers.location).toMatch(/^\/portal\/kanban\.html\?card=card_abc123def456&traceId=rt_[a-f0-9]{12}#card_abc123def456$/);
    });
    test('sensitive target without sig → dashboard with redirectError (never dead-ends)', async () => {
        const res = await request(app).get('/r/card?cardId=card_abc123def456');
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/portal/dashboard.html?redirectError=expired');
    });
    test('unknown target → dashboard with redirectError=unknown', async () => {
        const res = await request(app).get('/r/etcpasswd');
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/portal/dashboard.html?redirectError=unknown');
    });
    test('malformed param → redirectError=invalid', async () => {
        const res = await request(app).get('/r/chat?publicCode=NOPE');
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/portal/dashboard.html?redirectError=invalid');
    });
});

describe('POST /api/redirect/mint', () => {
    let app;
    beforeEach(() => { app = makeApp(); });

    test('403 without credentials', async () => {
        const res = await request(app).post('/api/redirect/mint')
            .send({ target: 'card', params: { cardId: 'card_abc123def456' } });
        expect(res.status).toBe(403);
    });
    test('mints signed URL for sensitive target with botSecret auth', async () => {
        const res = await request(app).post('/api/redirect/mint')
            .send({ deviceId: DEVICE, botSecret: 'bs-secret', entityId: 2,
                target: 'card', params: { cardId: 'card_abc123def456' } });
        expect(res.status).toBe(200);
        expect(res.body.url).toMatch(/^\/r\/card\?cardId=card_abc123def456&traceId=rt_[a-f0-9]{12}&exp=\d+&sig=[a-f0-9]{32}$/);
    });
    test('minted URL round-trips through /r/ to the kanban deep link', async () => {
        const mint = await request(app).post('/api/redirect/mint')
            .send({ deviceId: DEVICE, deviceSecret: 'ds-secret',
                target: 'card', params: { cardId: 'card_abc123def456' } });
        const res = await request(app).get(mint.body.url);
        expect(res.status).toBe(302);
        expect(res.headers.location).toContain('/portal/kanban.html?card=card_abc123def456');
    });
    test('public target mints unsigned URL', async () => {
        const res = await request(app).post('/api/redirect/mint')
            .send({ deviceId: DEVICE, deviceSecret: 'ds-secret',
                target: 'profile', params: { publicCode: 'tbwb9e' } });
        expect(res.body.url).toMatch(/^\/r\/profile\?publicCode=tbwb9e&traceId=rt_[a-f0-9]{12}$/);
    });
    test('400 on unknown target / bad params', async () => {
        const res = await request(app).post('/api/redirect/mint')
            .send({ deviceId: DEVICE, deviceSecret: 'ds-secret', target: 'card', params: { cardId: 'bad' } });
        expect(res.status).toBe(400);
    });
});

describe('POST /api/redirect/telemetry', () => {
    let app;
    beforeEach(() => { app = makeApp(); });

    test('accepts a valid TARGET_RENDERED beacon', async () => {
        const res = await request(app).post('/api/redirect/telemetry')
            .send({ traceId: 'rt_0123456789ab', state: 'TARGET_RENDERED', target: 'chat' });
        expect(res.status).toBe(200);
    });
    test('rejects bad traceId / unknown state / unknown target', async () => {
        for (const body of [
            { traceId: 'nope', state: 'TARGET_RENDERED', target: 'chat' },
            { traceId: 'rt_0123456789ab', state: 'HACK', target: 'chat' },
            { traceId: 'rt_0123456789ab', state: 'TARGET_RENDERED', target: 'nope' },
        ]) {
            const res = await request(app).post('/api/redirect/telemetry').send(body);
            expect(res.status).toBe(400);
        }
    });
});
