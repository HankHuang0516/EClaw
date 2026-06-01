/**
 * Hardening tests for point-edit-resolver — per-route rate limit + graceful
 * shutdown wiring + sanitizer reaffirm. Follow-up to PR #3010 (Track B v2)
 * supervisor review (card_d9b6a67dec4756296028d4bf).
 */

'use strict';

// Force the limiter on for these tests (other test files set RATE_LIMIT_DISABLED=1).
delete process.env.RATE_LIMIT_DISABLED;
process.env.POINT_EDIT_RATE_LIMIT_PER_MIN = '3';

jest.mock('playwright', () => {
    const _browser = {
        newContext: jest.fn().mockResolvedValue({
            route: jest.fn().mockResolvedValue(undefined),
            newPage: jest.fn().mockResolvedValue({
                goto: jest.fn().mockResolvedValue(undefined),
                evaluate: jest.fn().mockResolvedValue(null),
            }),
            close: jest.fn().mockResolvedValue(undefined),
        }),
        close: jest.fn().mockResolvedValue(undefined),
    };
    return {
        chromium: { launch: jest.fn().mockResolvedValue(_browser) },
        __mock: { _browser },
    };
});

const express = require('express');
const request = require('supertest');

// Require AFTER setting env so the limiter picks up max=3.
const resolver = require('../../point-edit-resolver');

function makeApp() {
    const app = express();
    // express-rate-limit needs to see real-looking IPs; supertest defaults
    // to 127.0.0.1 which is fine.
    app.set('trust proxy', false);
    app.use(express.json());
    app.use('/api/point-edit', resolver.router);
    return app;
}

afterAll(async () => {
    await resolver.closeBrowser();
});

describe('per-route rate limiter on POST /api/point-edit/resolve-coordinate', () => {
    test('returns 429 after the 3rd request in the same window (limit=3 via env)', async () => {
        const app = makeApp();
        const body = {
            x: 10,
            y: 10,
            viewportW: 800,
            viewportH: 600,
            url: 'https://eclawbot.com/portal/info.html',
        };

        // First 3 should NOT be 429. They may be 404 (no element resolved
        // because playwright is mocked to return null) or 200 — both are
        // "passed the limiter" outcomes.
        for (let i = 0; i < 3; i++) {
            const r = await request(app).post('/api/point-edit/resolve-coordinate').send(body);
            expect(r.status).not.toBe(429);
        }

        // 4th request from the same supertest client (same IP) should hit the limit.
        const r4 = await request(app).post('/api/point-edit/resolve-coordinate').send(body);
        expect(r4.status).toBe(429);
        expect(r4.body).toMatchObject({ success: false, error: 'rate_limited' });
        expect(r4.body.message).toMatch(/3\/min/);
    });
});

describe('closeBrowser export survives shape changes', () => {
    test('still exported and callable without throwing', async () => {
        expect(typeof resolver.closeBrowser).toBe('function');
        await expect(resolver.closeBrowser()).resolves.toBeUndefined();
    });
});

describe('sanitizeOuterHTML — reaffirm scope (no regression vs PR #3010)', () => {
    test('still strips script / on* / javascript: vectors', () => {
        const dirty = '<div onclick="x()"><a href="javascript:alert(1)">y</a><script>1</script></div>';
        const clean = resolver.sanitizeOuterHTML(dirty);
        expect(clean).not.toMatch(/onclick/i);
        expect(clean).not.toMatch(/javascript:/i);
        expect(clean).not.toMatch(/<script/i);
    });
});
