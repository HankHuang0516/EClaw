'use strict';

const {
    makeMiddleware,
    hashKey,
    isValidClientKey,
    TTL_HOURS,
    MIN_KEY_LEN,
    MAX_KEY_LEN,
} = require('../../idempotency-keys');

function makeReq({ key = null, deviceId = 'dev-test' } = {}) {
    const headers = {};
    if (key !== null) headers['idempotency-key'] = key;
    return {
        get(name) {
            return headers[String(name).toLowerCase()];
        },
        body: { deviceId },
    };
}

function makeRes() {
    const res = {
        statusCode: 200,
        sentBody: undefined,
        sentStatus: undefined,
        setHeaders: {},
        status(code) { this.statusCode = code; this.sentStatus = code; return this; },
        set(name, val) { this.setHeaders[name] = val; return this; },
        json(body) { this.sentBody = body; return body; },
    };
    return res;
}

function makePool(initialRows = []) {
    let rows = initialRows.slice();
    let insertFails = false;
    let lookupFails = false;
    return {
        rows: () => rows.slice(),
        breakLookup() { lookupFails = true; },
        breakInsert() { insertFails = true; },
        async query(sql, params) {
            if (lookupFails && sql.startsWith('SELECT')) throw new Error('boom');
            if (sql.startsWith('SELECT')) {
                const hit = rows.find((r) => r.hash === params[0] && r.expires_at > Date.now());
                return { rows: hit ? [{ response_blob: hit.response_blob, status_code: hit.status_code }] : [] };
            }
            if (sql.startsWith('INSERT')) {
                if (insertFails) throw new Error('boom-insert');
                const exists = rows.some((r) => r.hash === params[0]);
                if (!exists) {
                    rows.push({
                        hash: params[0],
                        response_blob: JSON.parse(params[1]),
                        status_code: params[2],
                        expires_at: Date.now() + 24 * 60 * 60 * 1000,
                    });
                }
                return { rows: [] };
            }
            return { rows: [] };
        },
    };
}

describe('idempotency-keys middleware', () => {
    test('no Idempotency-Key header → next() without touching pool', async () => {
        const pool = makePool();
        const middleware = makeMiddleware(pool);
        const req = makeReq({ key: null });
        const res = makeRes();
        let called = false;
        await middleware(req, res, () => { called = true; });
        expect(called).toBe(true);
        expect(res.sentBody).toBeUndefined();
        expect(pool.rows()).toHaveLength(0);
    });

    test('first call caches the response after handler writes it', async () => {
        const pool = makePool();
        const middleware = makeMiddleware(pool);
        const req = makeReq({ key: 'abc-12345-xyz' });
        const res = makeRes();
        let nextCalled = false;
        await middleware(req, res, () => { nextCalled = true; });
        expect(nextCalled).toBe(true);
        res.status(201).json({ ok: true, id: 'msg-1' });
        // Insert is fire-and-forget; await a tick.
        await new Promise((r) => setImmediate(r));
        expect(pool.rows()).toHaveLength(1);
        expect(pool.rows()[0].response_blob).toEqual({ ok: true, id: 'msg-1' });
        expect(pool.rows()[0].status_code).toBe(201);
    });

    test('second call with same (deviceId, key) returns cached blob + X-Idempotent-Hit:1', async () => {
        const pool = makePool();
        const middleware = makeMiddleware(pool);
        const key = 'replay-key-001';

        const req1 = makeReq({ key });
        const res1 = makeRes();
        await middleware(req1, res1, () => {});
        res1.status(200).json({ ok: true, processed: 'first' });
        await new Promise((r) => setImmediate(r));

        const req2 = makeReq({ key });
        const res2 = makeRes();
        let nextCalled = false;
        await middleware(req2, res2, () => { nextCalled = true; });

        expect(nextCalled).toBe(false);
        expect(res2.setHeaders['X-Idempotent-Hit']).toBe('1');
        expect(res2.sentStatus).toBe(200);
        expect(res2.sentBody).toEqual({ ok: true, processed: 'first' });
    });

    test('different deviceId with same key → cache miss (per-device scoping)', async () => {
        const pool = makePool();
        const middleware = makeMiddleware(pool);
        const key = 'replay-key-002';

        const req1 = makeReq({ key, deviceId: 'dev-A' });
        const res1 = makeRes();
        await middleware(req1, res1, () => {});
        res1.status(200).json({ from: 'A' });
        await new Promise((r) => setImmediate(r));

        const req2 = makeReq({ key, deviceId: 'dev-B' });
        const res2 = makeRes();
        let nextCalled = false;
        await middleware(req2, res2, () => { nextCalled = true; });
        expect(nextCalled).toBe(true);
        expect(res2.sentBody).toBeUndefined();
    });

    test('DB lookup failure → falls through to handler', async () => {
        const pool = makePool();
        pool.breakLookup();
        const middleware = makeMiddleware(pool);
        const req = makeReq({ key: 'any-valid-key' });
        const res = makeRes();
        let nextCalled = false;
        await middleware(req, res, () => { nextCalled = true; });
        expect(nextCalled).toBe(true);
    });

    test('DB insert failure → handler still returns correctly (logs warning)', async () => {
        const pool = makePool();
        pool.breakInsert();
        const middleware = makeMiddleware(pool);
        const req = makeReq({ key: 'insert-fail-key' });
        const res = makeRes();
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        await middleware(req, res, () => {});
        const ret = res.status(200).json({ ok: true });
        expect(ret).toEqual({ ok: true });
        await new Promise((r) => setImmediate(r));
        warnSpy.mockRestore();
    });

    test('invalid client key (too short / wrong chars) → no-op next()', async () => {
        const pool = makePool();
        const middleware = makeMiddleware(pool);
        for (const bad of ['short', 'with spaces!', 'a'.repeat(MAX_KEY_LEN + 1)]) {
            const req = makeReq({ key: bad });
            const res = makeRes();
            let nextCalled = false;
            await middleware(req, res, () => { nextCalled = true; });
            expect(nextCalled).toBe(true);
            expect(res.sentBody).toBeUndefined();
        }
    });

    test('hashKey produces stable 64-char hex per (deviceId, key)', () => {
        const h1 = hashKey('dev-X', 'key-1');
        const h2 = hashKey('dev-X', 'key-1');
        const h3 = hashKey('dev-X', 'key-2');
        const h4 = hashKey('dev-Y', 'key-1');
        expect(h1).toBe(h2);
        expect(h1).not.toBe(h3);
        expect(h1).not.toBe(h4);
        expect(h1).toMatch(/^[a-f0-9]{64}$/);
    });

    test('isValidClientKey enforces length + charset', () => {
        expect(isValidClientKey('abc12345')).toBe(true);
        expect(isValidClientKey('a'.repeat(MIN_KEY_LEN))).toBe(true);
        expect(isValidClientKey('a'.repeat(MAX_KEY_LEN))).toBe(true);
        expect(isValidClientKey('a'.repeat(MIN_KEY_LEN - 1))).toBe(false);
        expect(isValidClientKey('a'.repeat(MAX_KEY_LEN + 1))).toBe(false);
        expect(isValidClientKey('hash key with space')).toBe(false);
        expect(isValidClientKey('hash@invalid')).toBe(false);
        expect(isValidClientKey('hash-valid_123.x')).toBe(true);
        expect(isValidClientKey(null)).toBe(false);
        expect(isValidClientKey(undefined)).toBe(false);
        expect(isValidClientKey(42)).toBe(false);
    });

    test('constants expose TTL_HOURS = 24', () => {
        expect(TTL_HOURS).toBe(24);
    });
});
