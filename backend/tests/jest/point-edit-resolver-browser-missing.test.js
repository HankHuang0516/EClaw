/**
 * Graceful-degrade test for point-edit-resolver: when headless Chromium is not
 * provisioned in the runtime (nixpacks prod runs `npm install` only, not
 * `npx playwright install`), POST /resolve-coordinate must return 503 and log
 * ONE concise line — NOT Playwright's multi-line "install browsers" banner,
 * which the prod ErrLog monitor split into ~9 separate ERROR cards.
 */

'use strict';

process.env.RATE_LIMIT_DISABLED = '1';

jest.mock('playwright', () => {
    // Mirror the real Playwright error: first line is the launch failure, then a
    // multi-line ASCII banner telling you to run `npx playwright install`.
    const bannerErr = new Error([
        "browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1234/chrome-linux/chrome",
        '╔═════════════════════════════════════════════════════════╗',
        '║ Looks like Playwright was just installed or updated.     ║',
        '║ Please run the following command to download new browsers:',
        '║     npx playwright install                               ║',
        '║ <3 Playwright Team                                       ║',
        '╚═════════════════════════════════════════════════════════╝',
    ].join('\n'));
    return { chromium: { launch: jest.fn().mockRejectedValue(bannerErr) } };
});

const express = require('express');
const request = require('supertest');
const resolver = require('../../point-edit-resolver');

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/point-edit', resolver.router);
    return app;
}

describe('point-edit graceful-degrade when Chromium executable is missing', () => {
    test('returns 503 point_edit_unavailable and logs a single concise line (no banner)', async () => {
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const r = await request(makeApp())
            .post('/api/point-edit/resolve-coordinate')
            .send({ x: 10, y: 10, viewportW: 800, viewportH: 600, url: 'https://eclawbot.com/portal/info.html' });

        expect(r.status).toBe(503);
        expect(r.body).toMatchObject({ success: false, error: 'point_edit_unavailable' });

        // The whole point: the prod ErrLog monitor splits MULTI-LINE output into
        // one card per line. The log must be a single concise line — not the
        // multi-line banner. Discriminate on banner-only markers (box-drawing +
        // signature), NOT on "npx playwright install" (our one-line hint may
        // legitimately reference that command).
        const logged = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(logged).not.toContain('╔');
        expect(logged).not.toContain('║');
        expect(logged).not.toMatch(/<3 Playwright Team/);
        // Our concise failure line is present, and there is no embedded newline
        // banner (each console.error call is one line).
        expect(logged).toMatch(/point-edit.*unavailable/i);
        expect(errSpy.mock.calls.every((c) => !String(c.join(' ')).includes('\n'))).toBe(true);

        errSpy.mockRestore();
    });
});
