/**
 * Unit tests for lib/api-errors.js
 *
 * Covers apiError() shape, requireFields() guard, and ERROR_CATALOG.
 * No DB / HTTP — pure helper logic.
 */

const { apiError, requireFields, ERROR_CATALOG } = require('../../lib/api-errors');

function mockRes() {
    const res = {
        statusCode: 200,
        body: null,
    };
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (body) => {
        res.body = body;
        return res;
    };
    return res;
}

describe('apiError()', () => {
    it('returns 400 with stable shape for a catalog code', () => {
        const res = mockRes();
        apiError(res, 'MISSING_REQUIRED_FIELD');
        expect(res.statusCode).toBe(400);
        expect(res.body).toMatchObject({
            success: false,
            code: 'MISSING_REQUIRED_FIELD',
            error: expect.any(String),
            errorI18nKey: 'err_missing_required_field',
            hint: expect.any(String),
        });
    });

    it('falls back to the bare code when an unknown code is passed', () => {
        const res = mockRes();
        apiError(res, 'TOTALLY_MADE_UP');
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('TOTALLY_MADE_UP');
        expect(res.body.error).toBe('TOTALLY_MADE_UP');
        expect(res.body.errorI18nKey).toBeNull();
        expect(res.body.hint).toBeNull();
    });

    it('includes missingFields when provided', () => {
        const res = mockRes();
        apiError(res, 'MISSING_REQUIRED_FIELD', {
            missingFields: ['email', 'password'],
        });
        expect(res.body.missingFields).toEqual(['email', 'password']);
    });

    it('omits missingFields when array is empty', () => {
        const res = mockRes();
        apiError(res, 'INVALID_EMAIL', { missingFields: [] });
        expect(res.body).not.toHaveProperty('missingFields');
    });

    it('omits missingFields when not provided', () => {
        const res = mockRes();
        apiError(res, 'INVALID_EMAIL');
        expect(res.body).not.toHaveProperty('missingFields');
    });

    it('respects status override', () => {
        const res = mockRes();
        apiError(res, 'BUSINESS_RULE_VIOLATION', { status: 409 });
        expect(res.statusCode).toBe(409);
    });

    it('respects error/hint/i18nKey overrides', () => {
        const res = mockRes();
        apiError(res, 'INVALID_FORMAT', {
            error: 'Custom EN message',
            hint: 'Custom hint',
            i18nKey: 'custom_key',
        });
        expect(res.body.error).toBe('Custom EN message');
        expect(res.body.hint).toBe('Custom hint');
        expect(res.body.errorI18nKey).toBe('custom_key');
    });

    it('splices extra fields into the payload without clobbering reserved ones', () => {
        const res = mockRes();
        apiError(res, 'INVALID_LANGUAGE', {
            extra: { allowed: ['en', 'zh'], code: 'IGNORED' },
        });
        expect(res.body.allowed).toEqual(['en', 'zh']);
        expect(res.body.code).toBe('INVALID_LANGUAGE'); // reserved, not overwritten
    });

    it('always sets success:false', () => {
        const res = mockRes();
        apiError(res, 'INVALID_EMAIL');
        expect(res.body.success).toBe(false);
    });
});

describe('requireFields()', () => {
    it('returns true when all fields are present and non-empty', () => {
        const res = mockRes();
        const ok = requireFields(res, { a: 1, b: 'x' }, ['a', 'b']);
        expect(ok).toBe(true);
        expect(res.body).toBeNull();
    });

    it('returns false and emits 400 + missingFields when a field is missing', () => {
        const res = mockRes();
        const ok = requireFields(res, { a: 1 }, ['a', 'b']);
        expect(ok).toBe(false);
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('MISSING_REQUIRED_FIELD');
        expect(res.body.missingFields).toEqual(['b']);
    });

    it('treats null as missing', () => {
        const res = mockRes();
        const ok = requireFields(res, { a: null, b: 1 }, ['a', 'b']);
        expect(ok).toBe(false);
        expect(res.body.missingFields).toEqual(['a']);
    });

    it('treats empty string and whitespace as missing', () => {
        const res = mockRes();
        const ok = requireFields(res, { a: '', b: '   ', c: 'ok' }, ['a', 'b', 'c']);
        expect(ok).toBe(false);
        expect(res.body.missingFields).toEqual(['a', 'b']);
    });

    it('does NOT treat 0 or false as missing', () => {
        const res = mockRes();
        const ok = requireFields(res, { count: 0, flag: false }, ['count', 'flag']);
        expect(ok).toBe(true);
        expect(res.body).toBeNull();
    });

    it('handles missing body gracefully', () => {
        const res = mockRes();
        const ok = requireFields(res, undefined, ['x']);
        expect(ok).toBe(false);
        expect(res.body.missingFields).toEqual(['x']);
    });

    it('uses caller-supplied error override when present', () => {
        const res = mockRes();
        requireFields(res, {}, ['email', 'password'], {
            error: 'Email and password required',
        });
        expect(res.body.error).toBe('Email and password required');
    });

    it('generates a sensible default error message when no override is given', () => {
        const res = mockRes();
        requireFields(res, {}, ['foo']);
        expect(res.body.error).toMatch(/foo/);
    });

    it('reports every missing field, not just the first', () => {
        const res = mockRes();
        requireFields(res, {}, ['a', 'b', 'c']);
        expect(res.body.missingFields).toEqual(['a', 'b', 'c']);
    });
});

describe('ERROR_CATALOG', () => {
    it('contains a stable set of well-known codes with required keys', () => {
        const required = [
            'MISSING_REQUIRED_FIELD',
            'INVALID_FORMAT',
            'INVALID_EMAIL',
            'INVALID_PASSWORD',
            'INVALID_TOKEN',
            'EXPIRED_TOKEN',
            'INVALID_LANGUAGE',
            'AGENT_CARD_INCOMPLETE',
        ];
        for (const code of required) {
            expect(ERROR_CATALOG).toHaveProperty(code);
            expect(ERROR_CATALOG[code]).toMatchObject({
                defaultError: expect.any(String),
                i18nKey: expect.any(String),
                hint: expect.any(String),
            });
            // i18n key convention: lowercase snake, prefixed with err_
            expect(ERROR_CATALOG[code].i18nKey).toMatch(/^err_[a-z_]+$/);
        }
    });
});
