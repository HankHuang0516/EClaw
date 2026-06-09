/**
 * Offline delivery outbox — Phase 2 #5 client side.
 * Spec: docs/offline-delivery-queue-spec.md. Card: card_47ed9a0c.
 *
 * Pure-function queue layer that chat.html (and any other send surface) wraps
 * around its POST /api/transform or /api/client/speak call. Persists pending
 * sends to localStorage, retries with exponential backoff on reconnect, and
 * deduplicates server-side via the Idempotency-Key header that the matching
 * middleware (backend/idempotency-keys.js, PRs #3271/#3272/#3274) consumes.
 *
 * Q1+Q2 defaults baked in per Hank autonomy directive 2026-06-10 02:31 TW
 * (he said "don't wait, find a way", so the spec's proposed defaults apply):
 *   - Q1 outbox-full policy: drop OLDEST queued entry, banner the user
 *   - Q2 failed-state lifetime: 7d auto-expire
 *   - Q3 idempotency on /api/client/speak: yes (already mounted in PR #3274)
 */
(function (global) {
    'use strict';

    var STORAGE_KEY = 'eclaw_outbox';
    var MAX_ENTRIES = 100;
    var FAILED_TTL_MS = 7 * 24 * 60 * 60 * 1000;     // 7 days
    var MAX_ATTEMPTS = 12;

    // Exponential backoff schedule per spec: 0/5s/15s/45s/2m/5m cap.
    var BACKOFF_MS = [0, 5_000, 15_000, 45_000, 120_000];
    var BACKOFF_CAP_MS = 300_000;

    function now() {
        return (global.Date && global.Date.now) ? Date.now() : 0;
    }

    function uuid() {
        if (global.crypto && global.crypto.randomUUID) {
            return global.crypto.randomUUID();
        }
        // RFC4122 v4-ish fallback
        return 'o-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
    }

    function loadRaw() {
        try {
            var raw = global.localStorage && global.localStorage.getItem(STORAGE_KEY);
            if (!raw) return [];
            var parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    function saveRaw(entries) {
        try {
            if (!global.localStorage) return;
            global.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
        } catch (e) {
            // QuotaExceededError, etc. — caller's banner is best-effort, swallow here.
        }
    }

    function backoffFor(attempt) {
        if (attempt < 0) return 0;
        if (attempt < BACKOFF_MS.length) return BACKOFF_MS[attempt];
        return BACKOFF_CAP_MS;
    }

    function pruneExpired(entries, nowMs) {
        return entries.filter(function (e) {
            if (e.state !== 'failed') return true;
            return (nowMs - (e.createdAt || 0)) <= FAILED_TTL_MS;
        });
    }

    function enforceCap(entries) {
        if (entries.length <= MAX_ENTRIES) return { kept: entries, dropped: [] };
        // Q1 policy: drop oldest queued first, then oldest retrying, then oldest
        // failed. Keep failures user-actionable longer than queued churn.
        var queued = entries.filter(function (e) { return e.state === 'queued'; })
            .sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        var retrying = entries.filter(function (e) { return e.state === 'retrying'; })
            .sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        var failed = entries.filter(function (e) { return e.state === 'failed'; })
            .sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        var sent = entries.filter(function (e) { return e.state === 'sent'; });

        var dropped = [];
        var totalKept = entries.length;
        var dropFromList = function (list) {
            while (totalKept > MAX_ENTRIES && list.length > 0) {
                dropped.push(list.shift());
                totalKept--;
            }
        };
        dropFromList(queued);
        if (totalKept > MAX_ENTRIES) dropFromList(retrying);
        if (totalKept > MAX_ENTRIES) dropFromList(failed);
        var kept = sent.concat(queued).concat(retrying).concat(failed);
        return { kept: kept, dropped: dropped };
    }

    function load() {
        var nowMs = now();
        var pruned = pruneExpired(loadRaw(), nowMs);
        return pruned;
    }

    function persist(entries) {
        var capped = enforceCap(entries);
        saveRaw(capped.kept);
        return capped;
    }

    function enqueue(payload, opts) {
        opts = opts || {};
        var entries = load();
        var entry = {
            idempotencyKey: opts.idempotencyKey || uuid(),
            payload: payload || {},
            state: 'queued',
            attempts: 0,
            nextRetryAt: now(),
            createdAt: now(),
        };
        entries.push(entry);
        var result = persist(entries);
        return { entry: entry, droppedForCap: result.dropped };
    }

    function update(idempotencyKey, mutator) {
        var entries = load();
        var updatedEntry = null;
        var nextEntries = entries.map(function (e) {
            if (e.idempotencyKey !== idempotencyKey) return e;
            var next = mutator(Object.assign({}, e));
            updatedEntry = next;
            return next;
        });
        persist(nextEntries);
        return updatedEntry;
    }

    function remove(idempotencyKey) {
        var entries = load();
        var next = entries.filter(function (e) { return e.idempotencyKey !== idempotencyKey; });
        persist(next);
        return next;
    }

    function clear() {
        saveRaw([]);
    }

    function snapshot() {
        return load();
    }

    function summary() {
        var entries = load();
        var by = { queued: 0, retrying: 0, sent: 0, failed: 0 };
        entries.forEach(function (e) { if (by[e.state] !== undefined) by[e.state]++; });
        return { total: entries.length, by: by };
    }

    function markRetrying(idempotencyKey) {
        return update(idempotencyKey, function (e) {
            e.state = 'retrying';
            return e;
        });
    }

    function markSent(idempotencyKey) {
        return update(idempotencyKey, function (e) {
            e.state = 'sent';
            return e;
        });
    }

    function markFailed(idempotencyKey, errorMessage) {
        return update(idempotencyKey, function (e) {
            e.state = 'failed';
            if (errorMessage) e.errorMessage = String(errorMessage).slice(0, 500);
            return e;
        });
    }

    function bumpAttempt(idempotencyKey) {
        return update(idempotencyKey, function (e) {
            e.attempts = (e.attempts || 0) + 1;
            e.nextRetryAt = now() + backoffFor(e.attempts);
            // If we've burned all attempts, terminal-fail the entry.
            if (e.attempts >= MAX_ATTEMPTS) {
                e.state = 'failed';
                e.errorMessage = e.errorMessage || 'max attempts exceeded';
            } else {
                e.state = 'queued';
            }
            return e;
        });
    }

    function nextDueAt() {
        var entries = load();
        var due = entries
            .filter(function (e) { return e.state === 'queued' || e.state === 'retrying'; })
            .map(function (e) { return e.nextRetryAt || 0; })
            .sort(function (a, b) { return a - b; });
        return due.length === 0 ? null : due[0];
    }

    var api = {
        STORAGE_KEY: STORAGE_KEY,
        MAX_ENTRIES: MAX_ENTRIES,
        FAILED_TTL_MS: FAILED_TTL_MS,
        MAX_ATTEMPTS: MAX_ATTEMPTS,
        BACKOFF_MS: BACKOFF_MS,
        BACKOFF_CAP_MS: BACKOFF_CAP_MS,
        backoffFor: backoffFor,
        load: load,
        snapshot: snapshot,
        summary: summary,
        enqueue: enqueue,
        update: update,
        remove: remove,
        clear: clear,
        markRetrying: markRetrying,
        markSent: markSent,
        markFailed: markFailed,
        bumpAttempt: bumpAttempt,
        nextDueAt: nextDueAt,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else if (global) {
        global.EclawOutbox = api;
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
