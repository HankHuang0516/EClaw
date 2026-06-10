'use strict';

/**
 * Payload-hash dedupe middleware for /api/client/speak.
 * Card: card_51eb9991e76821f4cd8f7a1e (Hank 2026-06-10 12:08 TW).
 *
 * Asserts the dedupe gate behaves correctly for the observed real-world
 * pattern: client-side auto-retry of the same payload within 10s.
 */

const { makeMiddleware, hashPayload, DEFAULT_WINDOW_MS } = require('../../client-speak-payload-dedupe');

function mockReq(body) {
    return { body };
}

function mockRes() {
    const res = {
        statusCode: 200,
        _headers: {},
        _jsonBody: null,
        set(k, v) { this._headers[k.toLowerCase()] = v; return this; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this._jsonBody = body; return this; },
    };
    return res;
}

describe('client-speak-payload-dedupe middleware', () => {
    let mw;

    beforeEach(() => {
        mw = makeMiddleware({ windowMs: 10_000 });
    });

    afterEach(() => {
        if (mw && mw._stop) mw._stop();
    });

    test('first call: no cache hit, passes through to next() and wraps res.json', () => {
        const req = mockReq({ deviceId: 'd1', entityId: 5, text: 'hello', source: 'web_chat' });
        const res = mockRes();
        const next = jest.fn();
        mw(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res._headers['x-client-speak-dedupe']).toBeUndefined();

        // Simulate handler responding
        res.json({ success: true, id: 'msg-1' });
        expect(res._jsonBody).toEqual({ success: true, id: 'msg-1' });
        expect(mw._cache.size).toBe(1);
    });

    test('second call with identical payload within window: cache HIT, short-circuits with cached response + X-Client-Speak-Dedupe header', () => {
        const body = { deviceId: 'd1', entityId: 5, text: 'hello', source: 'web_chat' };

        // First call
        const req1 = mockReq(body);
        const res1 = mockRes();
        mw(req1, res1, jest.fn());
        res1.json({ success: true, id: 'msg-1' });

        // Second call (same payload)
        const req2 = mockReq(body);
        const res2 = mockRes();
        const next2 = jest.fn();
        mw(req2, res2, next2);
        expect(next2).not.toHaveBeenCalled();
        expect(res2._headers['x-client-speak-dedupe']).toBe('hit');
        expect(res2.statusCode).toBe(200);
        expect(res2._jsonBody).toEqual({ success: true, id: 'msg-1' });
    });

    test('different text: no dedupe (different hash)', () => {
        const req1 = mockReq({ deviceId: 'd1', entityId: 5, text: 'hello', source: 'web_chat' });
        const res1 = mockRes();
        mw(req1, res1, jest.fn());
        res1.json({ success: true, id: 'msg-1' });

        const req2 = mockReq({ deviceId: 'd1', entityId: 5, text: 'world', source: 'web_chat' });
        const res2 = mockRes();
        const next2 = jest.fn();
        mw(req2, res2, next2);
        expect(next2).toHaveBeenCalledTimes(1);
        expect(res2._headers['x-client-speak-dedupe']).toBeUndefined();
    });

    test('different deviceId: no dedupe (cross-device safety)', () => {
        const req1 = mockReq({ deviceId: 'd1', entityId: 5, text: 'hello', source: 'web_chat' });
        const res1 = mockRes();
        mw(req1, res1, jest.fn());
        res1.json({ success: true });

        const req2 = mockReq({ deviceId: 'd2', entityId: 5, text: 'hello', source: 'web_chat' });
        const res2 = mockRes();
        const next2 = jest.fn();
        mw(req2, res2, next2);
        expect(next2).toHaveBeenCalledTimes(1);
    });

    test('different entityId: no dedupe', () => {
        const req1 = mockReq({ deviceId: 'd1', entityId: 5, text: 'hello' });
        const res1 = mockRes();
        mw(req1, res1, jest.fn());
        res1.json({ success: true });

        const req2 = mockReq({ deviceId: 'd1', entityId: 6, text: 'hello' });
        const res2 = mockRes();
        const next2 = jest.fn();
        mw(req2, res2, next2);
        expect(next2).toHaveBeenCalledTimes(1);
    });

    test('array entityId is normalized (order-independent)', () => {
        const req1 = mockReq({ deviceId: 'd1', entityId: [3, 5], text: 'hello' });
        const res1 = mockRes();
        mw(req1, res1, jest.fn());
        res1.json({ success: true, broadcast: true });

        // Same broadcast, different array order — should still dedupe
        const req2 = mockReq({ deviceId: 'd1', entityId: [5, 3], text: 'hello' });
        const res2 = mockRes();
        const next2 = jest.fn();
        mw(req2, res2, next2);
        expect(next2).not.toHaveBeenCalled();
        expect(res2._jsonBody).toEqual({ success: true, broadcast: true });
    });

    test('missing deviceId or text+mediaUrl: pass-through (let handler validate)', () => {
        const req = mockReq({ entityId: 5 });  // no deviceId
        const res = mockRes();
        const next = jest.fn();
        mw(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(mw._cache.size).toBe(0);
    });

    test('5xx response NOT cached (avoids replaying transient server errors)', () => {
        const body = { deviceId: 'd1', entityId: 5, text: 'hello' };
        const req1 = mockReq(body);
        const res1 = mockRes();
        mw(req1, res1, jest.fn());
        res1.status(503).json({ error: 'Server starting up' });

        // Second call should NOT see cached 503; should pass to handler again
        const req2 = mockReq(body);
        const res2 = mockRes();
        const next2 = jest.fn();
        mw(req2, res2, next2);
        expect(next2).toHaveBeenCalledTimes(1);
        expect(res2._headers['x-client-speak-dedupe']).toBeUndefined();
    });

    test('4xx response IS cached (deterministic validation errors)', () => {
        const body = { deviceId: 'd1', entityId: 5, text: 'hello' };
        const req1 = mockReq(body);
        const res1 = mockRes();
        mw(req1, res1, jest.fn());
        res1.status(400).json({ error: 'bad payload' });

        const req2 = mockReq(body);
        const res2 = mockRes();
        const next2 = jest.fn();
        mw(req2, res2, next2);
        expect(next2).not.toHaveBeenCalled();
        expect(res2.statusCode).toBe(400);
        expect(res2._jsonBody).toEqual({ error: 'bad payload' });
    });

    test('hashPayload is deterministic across calls', () => {
        const a = hashPayload(['d1', '5', 'hello', 'web_chat', '']);
        const b = hashPayload(['d1', '5', 'hello', 'web_chat', '']);
        expect(a).toBe(b);
        expect(a).toHaveLength(64);  // sha256 hex
    });

    test('DEFAULT_WINDOW_MS is 10s per card spec', () => {
        expect(DEFAULT_WINDOW_MS).toBe(10_000);
    });
});
