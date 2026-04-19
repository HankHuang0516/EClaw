/**
 * fetch-with-timeout — Shared helper for live-API regression tests
 *
 * Purpose: wrap global `fetch()` with an AbortController-based timeout so a
 * slow or unreachable Railway instance fails fast instead of hanging the
 * entire release gate (see 2026-04-19 v1.0.76 stall in test-dynamic-entities).
 *
 * Usage:
 *   const { fetchWithTimeout, TimeoutError, getDefaultTimeoutMs } = require('./helpers/fetch-with-timeout');
 *   const res = await fetchWithTimeout(url, { method: 'POST', body, headers });
 *   // override per-call: fetchWithTimeout(url, opts, { timeoutMs: 5000 })
 *
 * Default timeout: 30_000 ms. Override globally via env TEST_FETCH_TIMEOUT_MS.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

function getDefaultTimeoutMs() {
    const raw = process.env.TEST_FETCH_TIMEOUT_MS;
    if (!raw) return DEFAULT_TIMEOUT_MS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
    return n;
}

class TimeoutError extends Error {
    constructor(message, { url, timeoutMs } = {}) {
        super(message);
        this.name = 'TimeoutError';
        this.code = 'ETIMEOUT';
        this.url = url;
        this.timeoutMs = timeoutMs;
    }
}

/**
 * withTimeout — run an async function with an AbortController that auto-aborts
 * after `ms` milliseconds. The inner function receives the AbortSignal as its
 * sole argument so it can forward it to `fetch()` (or any abortable op).
 *
 * Throws TimeoutError if the timer fires before fn resolves.
 */
async function withTimeout(ms, fn, meta = {}) {
    const ac = new AbortController();
    let timedOut = false;
    const t = setTimeout(() => {
        timedOut = true;
        ac.abort();
    }, ms);
    try {
        return await fn(ac.signal);
    } catch (err) {
        if (timedOut || err?.name === 'AbortError') {
            throw new TimeoutError(
                `Request timed out after ${ms}ms${meta.url ? ` (${meta.url})` : ''}`,
                { url: meta.url, timeoutMs: ms }
            );
        }
        throw err;
    } finally {
        clearTimeout(t);
    }
}

/**
 * fetchWithTimeout — drop-in replacement for `fetch()` that enforces a timeout.
 *
 * @param {string|URL} url         target URL
 * @param {object}     [init]      standard fetch init (method, headers, body, ...)
 * @param {object}     [opts]      { timeoutMs?: number } per-call override
 * @returns {Promise<Response>}
 * @throws  {TimeoutError} when the timer fires before the server responds
 */
async function fetchWithTimeout(url, init = {}, opts = {}) {
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : getDefaultTimeoutMs();
    return withTimeout(
        timeoutMs,
        (signal) => {
            // Caller-supplied signal takes precedence when present; otherwise wire ours.
            const finalInit = init.signal ? init : { ...init, signal };
            return fetch(url, finalInit);
        },
        { url: String(url) }
    );
}

module.exports = {
    fetchWithTimeout,
    withTimeout,
    TimeoutError,
    getDefaultTimeoutMs,
    DEFAULT_TIMEOUT_MS,
};
