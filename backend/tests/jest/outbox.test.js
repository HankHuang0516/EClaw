'use strict';

/**
 * Tests for the offline outbox module (Phase 2 #5 client).
 * Card: card_47ed9a0c. Spec: docs/offline-delivery-queue-spec.md.
 *
 * Module is browser-side but exports a CommonJS shape so jest can require it.
 * localStorage is faked per-test via a small in-memory store assigned to
 * global.localStorage before each suite.
 */

function makeFakeStorage() {
    var store = {};
    return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
        setItem: function (k, v) { store[k] = String(v); },
        removeItem: function (k) { delete store[k]; },
        clear: function () { store = {}; },
        _store: function () { return store; },
    };
}

describe('outbox.js — Phase 2 #5 client queue', () => {
    let outbox;

    beforeEach(() => {
        global.localStorage = makeFakeStorage();
        // Re-require to get a fresh module-level state each test
        jest.resetModules();
        outbox = require('../../public/portal/shared/outbox.js');
    });

    afterEach(() => {
        delete global.localStorage;
    });

    test('starts empty', () => {
        expect(outbox.snapshot()).toEqual([]);
        expect(outbox.summary()).toEqual({ total: 0, by: { queued: 0, retrying: 0, sent: 0, failed: 0 } });
    });

    test('enqueue persists entries with required shape', () => {
        const result = outbox.enqueue({ deviceId: 'd', message: 'hi' });
        expect(result.entry.state).toBe('queued');
        expect(result.entry.attempts).toBe(0);
        expect(result.entry.idempotencyKey).toMatch(/.+/);
        expect(outbox.snapshot()).toHaveLength(1);
    });

    test('caller can supply idempotencyKey for replay-stable retries', () => {
        outbox.enqueue({ message: 'a' }, { idempotencyKey: 'fixed-key-1234' });
        expect(outbox.snapshot()[0].idempotencyKey).toBe('fixed-key-1234');
    });

    test('markRetrying / markSent / markFailed transition state', () => {
        const r = outbox.enqueue({ message: 'a' });
        const k = r.entry.idempotencyKey;
        outbox.markRetrying(k);
        expect(outbox.snapshot()[0].state).toBe('retrying');
        outbox.markSent(k);
        expect(outbox.snapshot()[0].state).toBe('sent');
        outbox.markFailed(k, 'boom');
        expect(outbox.snapshot()[0].state).toBe('failed');
        expect(outbox.snapshot()[0].errorMessage).toBe('boom');
    });

    test('bumpAttempt schedules next retry per backoff schedule', () => {
        const r = outbox.enqueue({ message: 'a' });
        const k = r.entry.idempotencyKey;
        for (let i = 0; i < 5; i++) outbox.bumpAttempt(k);
        const entry = outbox.snapshot()[0];
        expect(entry.attempts).toBe(5);
        // After 5 bumps the entry is back in queued state with nextRetryAt set
        expect(entry.state).toBe('queued');
    });

    test('bumpAttempt over MAX_ATTEMPTS terminal-fails the entry', () => {
        const r = outbox.enqueue({ message: 'a' });
        const k = r.entry.idempotencyKey;
        for (let i = 0; i < outbox.MAX_ATTEMPTS; i++) outbox.bumpAttempt(k);
        const entry = outbox.snapshot()[0];
        expect(entry.state).toBe('failed');
        expect(entry.attempts).toBe(outbox.MAX_ATTEMPTS);
    });

    test('backoffFor returns spec schedule', () => {
        expect(outbox.backoffFor(0)).toBe(0);
        expect(outbox.backoffFor(1)).toBe(5_000);
        expect(outbox.backoffFor(2)).toBe(15_000);
        expect(outbox.backoffFor(3)).toBe(45_000);
        expect(outbox.backoffFor(4)).toBe(120_000);
        // Beyond schedule, cap kicks in
        expect(outbox.backoffFor(5)).toBe(outbox.BACKOFF_CAP_MS);
        expect(outbox.backoffFor(99)).toBe(outbox.BACKOFF_CAP_MS);
    });

    test('summary buckets entries by state', () => {
        outbox.enqueue({ m: 1 });
        const r2 = outbox.enqueue({ m: 2 });
        outbox.markRetrying(r2.entry.idempotencyKey);
        const r3 = outbox.enqueue({ m: 3 });
        outbox.markSent(r3.entry.idempotencyKey);
        const r4 = outbox.enqueue({ m: 4 });
        outbox.markFailed(r4.entry.idempotencyKey, 'x');
        expect(outbox.summary()).toEqual({ total: 4, by: { queued: 1, retrying: 1, sent: 1, failed: 1 } });
    });

    test('clear() empties the store', () => {
        outbox.enqueue({ m: 1 });
        outbox.enqueue({ m: 2 });
        outbox.clear();
        expect(outbox.snapshot()).toEqual([]);
    });

    test('remove(key) drops a single entry', () => {
        const a = outbox.enqueue({ m: 'a' });
        outbox.enqueue({ m: 'b' });
        outbox.remove(a.entry.idempotencyKey);
        const left = outbox.snapshot();
        expect(left).toHaveLength(1);
        expect(left[0].payload.m).toBe('b');
    });

    test('Q1 cap policy: drops OLDEST queued first when at MAX_ENTRIES', () => {
        // Seed the storage directly so we don't blow up with 100 enqueue() calls
        const seeds = [];
        for (let i = 0; i < outbox.MAX_ENTRIES; i++) {
            seeds.push({
                idempotencyKey: 'seed-' + i,
                payload: { i },
                state: 'queued',
                attempts: 0,
                nextRetryAt: 0,
                createdAt: i,                              // 0..99 monotonic
            });
        }
        global.localStorage.setItem(outbox.STORAGE_KEY, JSON.stringify(seeds));
        const r = outbox.enqueue({ m: 'fresh' }, { idempotencyKey: 'fresh-key' });
        expect(r.droppedForCap.length).toBeGreaterThan(0);
        // Oldest seed (createdAt=0) should be dropped
        const droppedKeys = r.droppedForCap.map(function (e) { return e.idempotencyKey; });
        expect(droppedKeys).toContain('seed-0');
        // Fresh entry kept
        const finalKeys = outbox.snapshot().map(function (e) { return e.idempotencyKey; });
        expect(finalKeys).toContain('fresh-key');
    });

    test('Q2 GC: failed entries older than FAILED_TTL_MS are pruned on next load', () => {
        const ancient = {
            idempotencyKey: 'old-fail',
            payload: {},
            state: 'failed',
            attempts: 12,
            nextRetryAt: 0,
            createdAt: Date.now() - (outbox.FAILED_TTL_MS + 60_000),
            errorMessage: 'long-gone',
        };
        const fresh = {
            idempotencyKey: 'fresh-fail',
            payload: {},
            state: 'failed',
            attempts: 12,
            nextRetryAt: 0,
            createdAt: Date.now(),
            errorMessage: 'still-relevant',
        };
        global.localStorage.setItem(outbox.STORAGE_KEY, JSON.stringify([ancient, fresh]));
        const snap = outbox.snapshot();
        expect(snap.map(e => e.idempotencyKey)).toEqual(['fresh-fail']);
    });

    test('nextDueAt returns the soonest queued/retrying retry time', () => {
        const a = outbox.enqueue({ m: 'a' });
        const b = outbox.enqueue({ m: 'b' });
        // Manually move b's nextRetryAt earlier
        outbox.update(b.entry.idempotencyKey, function (e) {
            e.nextRetryAt = 100;
            return e;
        });
        outbox.update(a.entry.idempotencyKey, function (e) {
            e.nextRetryAt = 500;
            return e;
        });
        expect(outbox.nextDueAt()).toBe(100);
    });

    test('corrupted localStorage falls back to empty', () => {
        global.localStorage.setItem(outbox.STORAGE_KEY, '<<<not json>>>');
        expect(outbox.snapshot()).toEqual([]);
    });

    test('flushOutbox sends every queued entry whose nextRetryAt is due', async () => {
        outbox.enqueue({ m: 'a' }, { idempotencyKey: 'k-a' });
        outbox.enqueue({ m: 'b' }, { idempotencyKey: 'k-b' });
        const sender = jest.fn().mockResolvedValue(undefined);
        const result = await outbox.flushOutbox(sender);
        expect(result.sent).toBe(2);
        expect(result.failed).toBe(0);
        expect(sender).toHaveBeenCalledTimes(2);
        // All entries now sent
        const final = outbox.snapshot();
        expect(final.every(e => e.state === 'sent')).toBe(true);
    });

    test('flushOutbox marks failed entries when sender throws + bumps attempts', async () => {
        outbox.enqueue({ m: 'a' }, { idempotencyKey: 'k-a' });
        const sender = jest.fn().mockRejectedValue(new Error('network'));
        const result = await outbox.flushOutbox(sender);
        expect(result.sent).toBe(0);
        // First throw → not terminal, entry is requeued via bumpAttempt
        expect(result.requeued + result.failed).toBe(1);
        const entry = outbox.snapshot()[0];
        expect(entry.attempts).toBe(1);
    });

    test('flushOutbox terminal-fails an entry after MAX_ATTEMPTS', async () => {
        outbox.enqueue({ m: 'a' }, { idempotencyKey: 'k-a' });
        // Pre-bump to one before max so the next throw terminal-fails
        for (let i = 0; i < outbox.MAX_ATTEMPTS - 1; i++) outbox.bumpAttempt('k-a');
        // Reset nextRetryAt to now so flushOutbox picks the entry up
        outbox.update('k-a', (e) => { e.nextRetryAt = Date.now(); return e; });
        const sender = jest.fn().mockRejectedValue(new Error('network'));
        const result = await outbox.flushOutbox(sender);
        expect(result.failed).toBe(1);
        expect(outbox.snapshot()[0].state).toBe('failed');
    });

    test('flushOutbox skips entries whose nextRetryAt is in the future', async () => {
        outbox.enqueue({ m: 'a' }, { idempotencyKey: 'k-a' });
        outbox.update('k-a', (e) => { e.nextRetryAt = Date.now() + 60_000; return e; });
        const sender = jest.fn().mockResolvedValue(undefined);
        const result = await outbox.flushOutbox(sender);
        expect(result.sent).toBe(0);
        expect(sender).not.toHaveBeenCalled();
    });

    test('flushOutbox ignores already-sent entries', async () => {
        outbox.enqueue({ m: 'a' }, { idempotencyKey: 'k-a' });
        outbox.markSent('k-a');
        const sender = jest.fn().mockResolvedValue(undefined);
        const result = await outbox.flushOutbox(sender);
        expect(result.sent).toBe(0);
        expect(sender).not.toHaveBeenCalled();
    });
});
