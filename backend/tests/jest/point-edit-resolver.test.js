'use strict';

require('./helpers/mock-setup');

const request = require('supertest');

let app;

const post = (path) => request(app).post(path).set('Host', 'localhost');

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

describe('POST /api/point-edit/resolve-coordinate', () => {
    it('returns a normalized coord target for the demo CTA button', async () => {
        const res = await post('/api/point-edit/resolve-coordinate').send({
            x: 211,
            y: 446,
            viewportW: 1280,
            viewportH: 800,
            url: 'https://eclawbot.com/portal/info.html?demo=pointedit',
        });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            mode: 'coord',
            targetId: 'cta.button',
            selector: '[data-point-edit-id="cta.button"]',
            anchorId: 'cta.block',
            textSnippet: 'Buy Now',
        });
        expect(res.body.coordinates).toMatchObject({
            x: 211,
            y: 446,
            viewportW: 1280,
            viewportH: 800,
        });
        expect(res.body.coordinates.normalizedX).toBeCloseTo(0.165, 2);
        expect(res.body.confidence).toBeGreaterThanOrEqual(0.9);
        expect(res.body.rect).toEqual(expect.objectContaining({
            x: expect.any(Number),
            y: expect.any(Number),
            w: expect.any(Number),
            h: expect.any(Number),
        }));
        expect(res.body.sourceHint).toContain('backend/public/portal/info.html:4968#cta.button');
        expect(res.body.astPath).toBe('backend/public/portal/info.html:4968#cta.button');
    });

    it('resolves the mobile thumb-region coordinate to the CTA button', async () => {
        const res = await post('/api/point-edit/resolve-coordinate').send({
            x: 96,
            y: 471,
            viewportW: 390,
            viewportH: 844,
            url: '/portal/info.html?demo=pointedit',
        });

        expect(res.status).toBe(200);
        expect(res.body.mode).toBe('coord');
        expect(res.body.targetId).toBe('cta.button');
        expect(res.body.selector).toBe('[data-point-edit-id="cta.button"]');
        expect(res.body.coordinates.normalizedX).toBeCloseTo(0.246, 2);
    });

    it('400s for malformed coordinate payloads', async () => {
        const res = await post('/api/point-edit/resolve-coordinate').send({
            x: 'nope',
            y: 100,
            viewportW: 1280,
            viewportH: 800,
            url: '/portal/info.html?demo=pointedit',
        });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/x and y/);
    });

    it('422s unsupported pages instead of guessing a target', async () => {
        const res = await post('/api/point-edit/resolve-coordinate').send({
            x: 211,
            y: 446,
            viewportW: 1280,
            viewportH: 800,
            url: 'https://eclawbot.com/portal/dashboard.html',
        });

        expect(res.status).toBe(422);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('unsupported_url');
    });
});
