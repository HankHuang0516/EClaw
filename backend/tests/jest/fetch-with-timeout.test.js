/**
 * Unit tests for backend/tests/helpers/fetch-with-timeout.js
 *
 * Protects the release-gate timeout contract: if global fetch() hangs, our
 * wrapper MUST raise TimeoutError so the suite can fail fast instead of
 * blocking release for 10+ minutes (see 2026-04-19 v1.0.76 stall).
 */

const {
    fetchWithTimeout,
    withTimeout,
    TimeoutError,
    getDefaultTimeoutMs,
    DEFAULT_TIMEOUT_MS,
} = require('../helpers/fetch-with-timeout');

describe('fetch-with-timeout helper', () => {
    const realFetch = global.fetch;
    const realEnv = process.env.TEST_FETCH_TIMEOUT_MS;

    afterEach(() => {
        global.fetch = realFetch;
        if (realEnv === undefined) delete process.env.TEST_FETCH_TIMEOUT_MS;
        else process.env.TEST_FETCH_TIMEOUT_MS = realEnv;
    });

    test('withTimeout throws TimeoutError when signal fires', async () => {
        const start = Date.now();
        await expect(
            withTimeout(40, (signal) => new Promise((_, reject) => {
                signal.addEventListener('abort', () => {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            }))
        ).rejects.toBeInstanceOf(TimeoutError);
        const elapsed = Date.now() - start;
        // Abort fired promptly (< 400ms) — proves we didn't hang.
        expect(elapsed).toBeLessThan(400);
    });

    test('withTimeout resolves normally when fn finishes in time', async () => {
        const result = await withTimeout(200, async () => 'ok');
        expect(result).toBe('ok');
    });

    test('withTimeout re-throws non-timeout errors untouched', async () => {
        const original = new Error('db down');
        await expect(
            withTimeout(200, async () => { throw original; })
        ).rejects.toBe(original);
    });

    test('fetchWithTimeout propagates signal to fetch() and aborts slow call', async () => {
        // Stub global fetch with a handler that never resolves unless aborted.
        global.fetch = jest.fn((_url, init) => {
            return new Promise((_, reject) => {
                init.signal.addEventListener('abort', () => {
                    const err = new Error('The operation was aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            });
        });

        const start = Date.now();
        await expect(
            fetchWithTimeout('https://eclawbot.com/slow', { method: 'GET' }, { timeoutMs: 30 })
        ).rejects.toBeInstanceOf(TimeoutError);
        expect(Date.now() - start).toBeLessThan(400);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(global.fetch.mock.calls[0][1].signal).toBeDefined();
    });

    test('fetchWithTimeout returns Response when fetch resolves quickly', async () => {
        const fakeResponse = { status: 200, ok: true };
        global.fetch = jest.fn().mockResolvedValue(fakeResponse);
        const res = await fetchWithTimeout('https://eclawbot.com/ok', {}, { timeoutMs: 200 });
        expect(res).toBe(fakeResponse);
    });

    test('TimeoutError carries url + timeoutMs metadata', async () => {
        global.fetch = jest.fn((_url, init) => new Promise((_, reject) => {
            init.signal.addEventListener('abort', () => {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
            });
        }));
        try {
            await fetchWithTimeout('https://eclawbot.com/foo', {}, { timeoutMs: 25 });
            throw new Error('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(TimeoutError);
            expect(err.name).toBe('TimeoutError');
            expect(err.code).toBe('ETIMEOUT');
            expect(err.timeoutMs).toBe(25);
            expect(err.url).toBe('https://eclawbot.com/foo');
        }
    });

    test('getDefaultTimeoutMs honors TEST_FETCH_TIMEOUT_MS env var', () => {
        process.env.TEST_FETCH_TIMEOUT_MS = '2000';
        expect(getDefaultTimeoutMs()).toBe(2000);

        process.env.TEST_FETCH_TIMEOUT_MS = 'garbage';
        expect(getDefaultTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);

        process.env.TEST_FETCH_TIMEOUT_MS = '0';
        expect(getDefaultTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);

        delete process.env.TEST_FETCH_TIMEOUT_MS;
        expect(getDefaultTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
    });

    test('fetchWithTimeout respects caller-supplied signal when present', async () => {
        let observedSignal;
        global.fetch = jest.fn((_url, init) => {
            observedSignal = init.signal;
            return Promise.resolve({ status: 204 });
        });

        const externalAc = new AbortController();
        await fetchWithTimeout('https://eclawbot.com/x', { signal: externalAc.signal }, { timeoutMs: 1000 });
        // When caller passes their own signal, we do not overwrite it.
        expect(observedSignal).toBe(externalAc.signal);
    });
});
