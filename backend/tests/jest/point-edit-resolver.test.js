'use strict';

jest.mock('playwright', () => {
    const evaluate = jest.fn();
    const _newPage = jest.fn().mockResolvedValue({
        goto: jest.fn().mockResolvedValue(undefined),
        evaluate,
    });
    const _route = jest.fn().mockResolvedValue(undefined);
    const _newContext = jest.fn().mockResolvedValue({
        route: _route,
        newPage: _newPage,
        close: jest.fn().mockResolvedValue(undefined),
    });
    const _browser = {
        newContext: _newContext,
        close: jest.fn().mockResolvedValue(undefined),
    };
    return {
        chromium: {
            launch: jest.fn().mockResolvedValue(_browser),
        },
        __mock: { evaluate, _route, _newPage, _newContext, _browser },
    };
});

const express = require('express');
const request = require('supertest');
const { chromium, __mock } = require('playwright');

const resolver = require('../../point-edit-resolver');

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/point-edit', resolver.router);
    return app;
}

afterEach(() => {
    __mock.evaluate.mockReset();
    __mock._route.mockClear();
    chromium.launch.mockClear();
});

afterAll(async () => {
    await resolver.closeBrowser();
});

describe('sanitizeOuterHTML', () => {
    test('strips <script> blocks', () => {
        const dirty = '<div>hi<script>alert(1)</script></div>';
        expect(resolver.sanitizeOuterHTML(dirty)).toBe('<div>hi</div>');
    });

    test('strips on*= inline event handlers', () => {
        const dirty = '<button onclick="evil()" class="x">go</button>';
        const clean = resolver.sanitizeOuterHTML(dirty);
        expect(clean).not.toMatch(/onclick/i);
        expect(clean).toContain('class="x"');
    });

    test('rewrites javascript: URLs in href/src', () => {
        const dirty = '<a href="javascript:alert(1)">x</a>';
        const clean = resolver.sanitizeOuterHTML(dirty);
        expect(clean).not.toMatch(/javascript:/i);
        expect(clean).toContain('href="#"');
    });

    test('returns empty string for non-string input', () => {
        expect(resolver.sanitizeOuterHTML(null)).toBe('');
        expect(resolver.sanitizeOuterHTML(undefined)).toBe('');
        expect(resolver.sanitizeOuterHTML(42)).toBe('');
    });
});

describe('validateCoordinateBody', () => {
    test('rejects missing x', () => {
        const r = resolver.validateCoordinateBody({ y: 10, viewportW: 800, viewportH: 600, url: 'https://eclawbot.com/x' });
        expect(r.error).toMatch(/x and y/);
    });

    test('rejects non-positive viewport', () => {
        const r = resolver.validateCoordinateBody({ x: 1, y: 1, viewportW: 0, viewportH: 600, url: 'https://eclawbot.com/x' });
        expect(r.error).toMatch(/viewportW and viewportH/);
    });

    test('rejects out-of-bounds coordinates', () => {
        const r = resolver.validateCoordinateBody({ x: 999999, y: 1, viewportW: 100, viewportH: 100, url: 'https://eclawbot.com/x' });
        expect(r.error).toMatch(/outside supported bounds/);
    });

    test('rejects disallowed origin', () => {
        const r = resolver.validateCoordinateBody({ x: 1, y: 1, viewportW: 100, viewportH: 100, url: 'https://evil.com/x' });
        expect(r.error).toBe('unsupported_origin');
        expect(r.hostname).toBe('evil.com');
    });

    test('accepts eclawbot.com', () => {
        const r = resolver.validateCoordinateBody({ x: 1, y: 1, viewportW: 100, viewportH: 100, url: 'https://eclawbot.com/portal/dashboard.html' });
        expect(r.error).toBeUndefined();
        expect(r.value).toBeDefined();
    });

    test('accepts localhost', () => {
        const r = resolver.validateCoordinateBody({ x: 1, y: 1, viewportW: 100, viewportH: 100, url: 'http://localhost:3000/x' });
        expect(r.error).toBeUndefined();
    });
});

describe('browser request guard', () => {
    function makeRoute(url) {
        return {
            request: () => ({ url: () => url }),
            continue: jest.fn().mockResolvedValue(undefined),
            abort: jest.fn().mockResolvedValue(undefined),
        };
    }

    test('allows only allow-listed network requests', () => {
        expect(resolver.isAllowedRequestUrl('https://eclawbot.com/assets/app.js')).toBe(true);
        expect(resolver.isAllowedRequestUrl('https://portal.eclawbot.com/app.js')).toBe(true);
        expect(resolver.isAllowedRequestUrl('https://evil.com/pixel.png')).toBe(false);
    });

    test('context route aborts disallowed subresources and redirect targets', async () => {
        const context = { route: jest.fn().mockResolvedValue(undefined) };
        await resolver.installRequestGuard(context);
        expect(context.route).toHaveBeenCalledWith('**/*', expect.any(Function));

        const handler = context.route.mock.calls[0][1];
        const allowed = makeRoute('https://eclawbot.com/static/app.js');
        await handler(allowed);
        expect(allowed.continue).toHaveBeenCalled();
        expect(allowed.abort).not.toHaveBeenCalled();

        const blockedSubresource = makeRoute('https://evil.com/pixel.png');
        await handler(blockedSubresource);
        expect(blockedSubresource.abort).toHaveBeenCalledWith('addressunreachable');
        expect(blockedSubresource.continue).not.toHaveBeenCalled();

        const blockedRedirectTarget = makeRoute('https://evil.com/redirect-final');
        await handler(blockedRedirectTarget);
        expect(blockedRedirectTarget.abort).toHaveBeenCalledWith('addressunreachable');
        expect(blockedRedirectTarget.continue).not.toHaveBeenCalled();
    });
});

describe('POST /api/point-edit/resolve-coordinate', () => {
    const validBody = {
        x: 200,
        y: 300,
        viewportW: 1280,
        viewportH: 800,
        url: 'https://eclawbot.com/publisher/dashboard.html',
    };

    test('200: returns sanitized outerHTML on hit', async () => {
        __mock.evaluate.mockResolvedValueOnce({
            selector: 'main > section:nth-of-type(2)',
            anchorId: 'main',
            outerHTML: '<section id="main">hi<script>alert(1)</script><button onclick="x()">go</button></section>',
            textSnippet: 'hi',
            rect: { x: 10, y: 20, w: 100, h: 40 },
            tagName: 'section',
        });
        const res = await request(makeApp())
            .post('/api/point-edit/resolve-coordinate')
            .send(validBody);
        expect(res.status).toBe(200);
        expect(res.body.mode).toBe('coord');
        expect(res.body.outerHTML).not.toMatch(/<script/i);
        expect(res.body.outerHTML).not.toMatch(/onclick=/i);
        expect(res.body.sourceHint).toContain('live:');
        expect(res.body.confidence).toBeCloseTo(0.9);
        expect(res.body.targetId).toBe('main');
        expect(__mock._route).toHaveBeenCalledWith('**/*', expect.any(Function));
        expect(__mock._route.mock.invocationCallOrder[0])
            .toBeLessThan(__mock._newPage.mock.invocationCallOrder[0]);
    });

    test('400: missing x', async () => {
        const res = await request(makeApp())
            .post('/api/point-edit/resolve-coordinate')
            .send({ y: 100, viewportW: 800, viewportH: 600, url: 'https://eclawbot.com/x' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/x and y/);
    });

    test('400: out-of-bounds viewport', async () => {
        const res = await request(makeApp())
            .post('/api/point-edit/resolve-coordinate')
            .send({ x: 1, y: 1, viewportW: 999999, viewportH: 600, url: 'https://eclawbot.com/x' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/outside supported bounds/);
    });

    test('422: unsupported origin', async () => {
        const res = await request(makeApp())
            .post('/api/point-edit/resolve-coordinate')
            .send({ ...validBody, url: 'https://evil.com/page' });
        expect(res.status).toBe(422);
        expect(res.body.error).toBe('unsupported_origin');
    });

    test('404: page.evaluate returns null', async () => {
        __mock.evaluate.mockResolvedValueOnce(null);
        const res = await request(makeApp())
            .post('/api/point-edit/resolve-coordinate')
            .send(validBody);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('target_not_found');
    });

    test('500: resolver throws', async () => {
        __mock.evaluate.mockRejectedValueOnce(new Error('chromium crashed'));
        const res = await request(makeApp())
            .post('/api/point-edit/resolve-coordinate')
            .send(validBody);
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('resolver_failure');
    });
});
