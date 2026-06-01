'use strict';

// IS_PROD and ALLOWED_HOSTS are captured at module-load time inside
// point-edit-resolver. To test prod-mode behaviour we must set NODE_ENV BEFORE
// require, with jest.resetModules() to avoid the cached non-prod copy from the
// sibling test file.

jest.mock('playwright', () => ({
    chromium: {
        launch: jest.fn().mockResolvedValue({
            newContext: jest.fn().mockResolvedValue({
                route: jest.fn().mockResolvedValue(undefined),
                newPage: jest.fn(),
                close: jest.fn().mockResolvedValue(undefined),
            }),
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

    test('allows https browser requests to allow-listed prod host', () => {
        expect(mod.isAllowedRequestUrl('https://eclawbot.com/assets/app.js')).toBe(true);
    });

    test('rejects non-https browser requests in prod', () => {
        expect(mod.isAllowedRequestUrl('http://eclawbot.com/assets/app.js')).toBe(false);
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
        process.env.POINT_EDIT_ALLOWED_HOSTS = 'eclawbot.com,localhost,127.0.0.1,169.254.169.254,[::1],[fe80::1]';
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

    test('loopback browser request still rejected despite override', () => {
        expect(mod.isAllowedRequestUrl('https://127.0.0.2/app.js')).toBe(false);
        expect(mod.isAllowedRequestUrl('https://[::1]/app.js')).toBe(false);
    });

    test('link-local browser request still rejected despite override', () => {
        expect(mod.isAllowedRequestUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
        expect(mod.isAllowedRequestUrl('https://[fe80::1]/app.js')).toBe(false);
    });
});

describe('SSRF hardening — request-level + extended prod blocks (prod env)', () => {
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

    test('isAllowedRequestUrl blocks redirect target on RFC1918 10/8', () => {
        expect(mod.isAllowedRequestUrl('https://10.0.0.5/foo')).toBe(false);
    });

    test('isAllowedRequestUrl blocks 172.16/12 (RFC1918)', () => {
        expect(mod.isAllowedRequestUrl('https://172.16.1.1/bar')).toBe(false);
        expect(mod.isAllowedRequestUrl('https://172.20.5.5/bar')).toBe(false);
        expect(mod.isAllowedRequestUrl('https://172.31.255.255/bar')).toBe(false);
    });

    test('isAllowedRequestUrl blocks 192.168/16', () => {
        expect(mod.isAllowedRequestUrl('https://192.168.1.1/x')).toBe(false);
    });

    test('isAllowedRequestUrl blocks IPv6 loopback ::1 (bracketed)', () => {
        expect(mod.isAllowedRequestUrl('https://[::1]/x')).toBe(false);
    });

    test('isAllowedRequestUrl blocks IPv6 ULA fc00::/7', () => {
        expect(mod.isAllowedRequestUrl('https://[fc00::1]/x')).toBe(false);
        expect(mod.isAllowedRequestUrl('https://[fd12:3456::1]/x')).toBe(false);
    });

    test('isAllowedRequestUrl blocks IPv6 link-local fe80::', () => {
        expect(mod.isAllowedRequestUrl('https://[fe80::1]/x')).toBe(false);
    });

    test('isAllowedRequestUrl blocks 0.0.0.0', () => {
        expect(mod.isAllowedRequestUrl('https://0.0.0.0/x')).toBe(false);
    });

    test('isAllowedRequestUrl blocks AWS metadata IP 169.254.169.254', () => {
        expect(mod.isAllowedRequestUrl('https://169.254.169.254/latest/meta-data/')).toBe(false);
    });

    test('isAllowedRequestUrl ALLOWS https://eclawbot.com/whatever in prod', () => {
        expect(mod.isAllowedRequestUrl('https://eclawbot.com/foo')).toBe(true);
        expect(mod.isAllowedRequestUrl('https://api.eclawbot.com/foo')).toBe(true);
    });

    test('isAllowedRequestUrl blocks http:// scheme in prod even for allow-listed host', () => {
        expect(mod.isAllowedRequestUrl('http://eclawbot.com/foo')).toBe(false);
    });

    test('isAllowedRequestUrl blocks data:, file:, javascript: schemes', () => {
        expect(mod.isAllowedRequestUrl('data:text/html,<h1>x</h1>')).toBe(false);
        expect(mod.isAllowedRequestUrl('file:///etc/passwd')).toBe(false);
        expect(mod.isAllowedRequestUrl('javascript:alert(1)')).toBe(false);
    });
});
