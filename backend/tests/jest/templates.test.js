/**
 * Template contribution endpoint tests (Jest + Supertest)
 *
 * Tests: POST /api/skill-templates/contribute, POST /api/soul-templates/contribute,
 *        POST /api/rule-templates/contribute, GET /api/skill-templates
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const get = (path) => request(app).get(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');

/** Register a device via the register endpoint */
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
    jest.resetModules();
});

// ════════════════════════════════════════════════════════════════
// GET /api/skill-templates — list templates
// ════════════════════════════════════════════════════════════════
describe('GET /api/skill-templates', () => {
    it('returns template list', async () => {
        const res = await get('/api/skill-templates');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.templates)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/soul-templates — list templates
// ════════════════════════════════════════════════════════════════
describe('GET /api/soul-templates', () => {
    it('returns template list', async () => {
        const res = await get('/api/soul-templates');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.templates)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/rule-templates — list templates
// ════════════════════════════════════════════════════════════════
describe('GET /api/rule-templates', () => {
    it('returns template list', async () => {
        const res = await get('/api/rule-templates');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.templates)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/skill-templates/contribute
// ════════════════════════════════════════════════════════════════
describe('POST /api/skill-templates/contribute', () => {
    it('returns 400 when required fields missing', async () => {
        const res = await post('/api/skill-templates/contribute').send({});
        expect(res.status).toBe(400);
    });

    it('returns 400 when skill is missing', async () => {
        const res = await post('/api/skill-templates/contribute')
            .send({ deviceId: 'dev-1', botSecret: 'sec' });
        expect(res.status).toBe(400);
    });

    it('returns 404 for nonexistent device', async () => {
        const res = await post('/api/skill-templates/contribute')
            .send({
                deviceId: 'nonexistent',
                botSecret: 'sec',
                skill: { id: 'test', title: 'T', url: 'https://x.com', steps: '1. step one\n2. step two — this is a detailed description of the action' },
            });
        expect(res.status).toBe(404);
    });

    it('returns 403 when botSecret does not match any entity', async () => {
        await registerDevice('test-skill-contribute');

        const res = await post('/api/skill-templates/contribute')
            .send({
                deviceId: 'test-skill-contribute',
                botSecret: 'wrong-secret',
                skill: { id: 'test', title: 'T', url: 'https://x.com', steps: '1. step one\n2. step two — detailed steps here' },
            });
        expect(res.status).toBe(403);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/soul-templates/contribute
// ════════════════════════════════════════════════════════════════
describe('POST /api/soul-templates/contribute', () => {
    it('returns 400 when required fields missing', async () => {
        const res = await post('/api/soul-templates/contribute').send({});
        expect(res.status).toBe(400);
    });

    it('returns 400 when soul is missing', async () => {
        const res = await post('/api/soul-templates/contribute')
            .send({ deviceId: 'dev-1', botSecret: 'sec' });
        expect(res.status).toBe(400);
    });

    it('returns 404 for nonexistent device', async () => {
        const res = await post('/api/soul-templates/contribute')
            .send({ deviceId: 'nonexistent', botSecret: 'sec', soul: { id: 'x', name: 'y' } });
        expect(res.status).toBe(404);
    });

    it('returns 403 when botSecret does not match', async () => {
        await registerDevice('test-soul-contribute');
        const res = await post('/api/soul-templates/contribute')
            .send({ deviceId: 'test-soul-contribute', botSecret: 'wrong', soul: { id: 'x', name: 'y' } });
        expect(res.status).toBe(403);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/rule-templates/contribute
// ════════════════════════════════════════════════════════════════
describe('POST /api/rule-templates/contribute', () => {
    it('returns 400 when required fields missing', async () => {
        const res = await post('/api/rule-templates/contribute').send({});
        expect(res.status).toBe(400);
    });

    it('returns 400 when rule is missing', async () => {
        const res = await post('/api/rule-templates/contribute')
            .send({ deviceId: 'dev-1', botSecret: 'sec' });
        expect(res.status).toBe(400);
    });

    it('returns 404 for nonexistent device', async () => {
        const res = await post('/api/rule-templates/contribute')
            .send({ deviceId: 'nonexistent', botSecret: 'sec', rule: { id: 'x', name: 'y' } });
        expect(res.status).toBe(404);
    });

    it('returns 403 when botSecret does not match', async () => {
        await registerDevice('test-rule-contribute');
        const res = await post('/api/rule-templates/contribute')
            .send({ deviceId: 'test-rule-contribute', botSecret: 'wrong', rule: { id: 'x', name: 'y' } });
        expect(res.status).toBe(403);
    });
});
