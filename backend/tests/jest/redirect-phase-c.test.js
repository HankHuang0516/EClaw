/**
 * Redirect state machine Phase C — iOS Universal Links AASA
 * (card_ddb4e970eaf60926051fed29). Spec §3/§7.
 * Covers: apple-app-site-association statement shape + the IOS_TEAM_ID env
 * gate (404 when unset/malformed so iOS never sees a broken AASA), served at
 * both the root and .well-known locations.
 */
'use strict';

const express = require('express');
const request = require('supertest');

const redirect = require('../../redirect-router');

function makeApp() {
    redirect.init({ chatPool: null, devices: {}, jwtSecret: 'test-signing-secret' });
    const app = express();
    app.use(redirect.router);
    return app;
}

const VALID_TEAM = 'ABCDE12345';
const PATHS = ['/apple-app-site-association', '/.well-known/apple-app-site-association'];

describe('AASA — IOS_TEAM_ID env gate', () => {
    afterEach(() => { delete process.env.IOS_TEAM_ID; });

    test('404 when IOS_TEAM_ID is unset (no broken AASA published)', async () => {
        const res = await request(makeApp()).get('/apple-app-site-association');
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('aasa_unconfigured');
    });

    test('404 when IOS_TEAM_ID is malformed', async () => {
        process.env.IOS_TEAM_ID = 'too-short';
        const res = await request(makeApp()).get('/apple-app-site-association');
        expect(res.status).toBe(404);
    });
});

describe('AASA — statement shape when configured', () => {
    afterEach(() => { delete process.env.IOS_TEAM_ID; });

    for (const p of PATHS) {
        test(`served at ${p} as application/json with no redirect`, async () => {
            process.env.IOS_TEAM_ID = VALID_TEAM;
            const res = await request(makeApp()).get(p);
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/application\/json/);
            const det = res.body.applinks.details;
            expect(det).toHaveLength(1);
            expect(det[0].appID).toBe(`${VALID_TEAM}.com.eclawbot.app`);
            expect(det[0].paths).toEqual(['/r/*']);
            expect(res.body.applinks.apps).toEqual([]);
        });
    }
});
