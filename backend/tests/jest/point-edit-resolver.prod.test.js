'use strict';

// IS_PROD and ALLOWED_HOSTS are captured at module-load time inside
// point-edit-resolver. To test prod-mode behaviour we must set NODE_ENV BEFORE
// require, with jest.resetModules() to avoid the cached non-prod copy from the
// sibling test file.

jest.mock('playwright', () => ({
    chromium: {
        launch: jest.fn().mockResolvedValue({
            newContext: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
        }),
    },
}));

describe('SSRF hardening (NODE_ENV=production)', () => {
    const ORIG = {
        NODE_ENV: process.env.NODE_ENV,
        RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT,
        POINT_EDIT_ALLOWED_HOSTS: process.env.POINT_EDIT_ALLOWED_HOSTS,
    };
    let mod;

    beforeAll(() => {
        process.env.NODE_ENV = 'production';
        delete process.env.RAILWAY_ENVIRONMENT;
        delete process.env.POINT_EDIT_ALLOWED_HOSTS;
        jest.resetModules();
        mod = require('../../point-edit-resolver');
    });

    afterAll(() => {
        if (ORIG.NODE_ENV === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = ORIG.NODE_ENV;
        if (ORIG.RAILWAY_ENVIRONMENT === undefined) delete process.env.RAILWAY_ENVIRONMENT;
        else process.env.RAILWAY_ENVIRONMENT = ORIG.RAILWAY_ENVIRONMENT;
        if (ORIG.POINT_EDIT_ALLOWED_HOSTS === undefined) delete process.env.POINT_EDIT_ALLOWED_HOSTS;
        else process.env.POINT_EDIT_ALLOWED_HOSTS = ORIG.POINT_EDIT_ALLOWED_HOSTS;
        jest.resetModules();
    });

    test('rejects localhost in prod', () => {
        const r = mod.validateCoordinateBody({
            x: 10, y: 10, viewportW: 1024, viewportH: 768,
            url: 'https://localhost/foo',
        });
        expect(r.error).toBe('unsupported_origin');
    });

    test('rejects 127.0.0.1 in prod', () => {
        const r = mod.validateCoordinateBody({
            x: 10, y: 10, viewportW: 1024, viewportH: 768,
            url: 'https://127.0.0.1/foo',
        });
        expect(r.error).toBe('unsupported_origin');
    });

    test('rejects http:// in prod even for whitelisted host', () => {
        const r = mod.validateCoordinateBody({
            x: 10, y: 10, viewportW: 1024, viewportH: 768,
            url: 'http://eclawbot.com/foo',
        });
        expect(r.error).toBe('insecure_scheme');
        expect(r.protocol).toBe('http:');
    });

    test('accepts https://eclawbot.com in prod', () => {
        const r = mod.validateCoordinateBody({
            x: 10, y: 10, viewportW: 1024, viewportH: 768,
            url: 'https://eclawbot.com/foo',
        });
        expect(r.error).toBeUndefined();
        expect(r.value).toBeDefined();
    });
});

describe('SSRF hardening — operator override does NOT defeat loopback block in prod', () => {
    const ORIG = {
        NODE_ENV: process.env.NODE_ENV,
        RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT,
        POINT_EDIT_ALLOWED_HOSTS: process.env.POINT_EDIT_ALLOWED_HOSTS,
    };
    let mod;

    beforeAll(() => {
        process.env.NODE_ENV = 'production';
        delete process.env.RAILWAY_ENVIRONMENT;
        // Operator misconfiguration: explicit localhost in the override.
        process.env.POINT_EDIT_ALLOWED_HOSTS = 'eclawbot.com,localhost,127.0.0.1';
        jest.resetModules();
        mod = require('../../point-edit-resolver');
    });

    afterAll(() => {
        if (ORIG.NODE_ENV === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = ORIG.NODE_ENV;
        if (ORIG.RAILWAY_ENVIRONMENT === undefined) delete process.env.RAILWAY_ENVIRONMENT;
        else process.env.RAILWAY_ENVIRONMENT = ORIG.RAILWAY_ENVIRONMENT;
        if (ORIG.POINT_EDIT_ALLOWED_HOSTS === undefined) delete process.env.POINT_EDIT_ALLOWED_HOSTS;
        else process.env.POINT_EDIT_ALLOWED_HOSTS = ORIG.POINT_EDIT_ALLOWED_HOSTS;
        jest.resetModules();
    });

    test('localhost still rejected despite override', () => {
        const r = mod.validateCoordinateBody({
            x: 10, y: 10, viewportW: 1024, viewportH: 768,
            url: 'https://localhost/foo',
        });
        expect(r.error).toBe('unsupported_origin');
    });
});
