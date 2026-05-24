'use strict';

const DEFAULT_MAX_PER_WINDOW = 30;
const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 60 * 1000;

const channelBackpressureState = new Map();

function channelBackpressureKey({ deviceId, entityId, channelAccountId } = {}) {
    const accountPart = channelAccountId ? `account:${channelAccountId}` : 'account:legacy';
    return `${deviceId || 'unknown_device'}:${entityId ?? 'unknown_entity'}:${accountPart}`;
}

function getState(key) {
    if (!channelBackpressureState.has(key)) {
        channelBackpressureState.set(key, {
            timestamps: [],
            consecutiveFailures: 0,
            backoffUntil: 0,
            lastReason: null
        });
    }
    return channelBackpressureState.get(key);
}

function parseRetryAfterMs(value, now = Date.now()) {
    if (!value) return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) {
        return Math.ceil(numeric * 1000);
    }
    const parsedDate = Date.parse(value);
    if (Number.isFinite(parsedDate)) {
        return Math.max(0, parsedDate - now);
    }
    return null;
}

function reserveChannelPush(target, opts = {}) {
    const {
        now = Date.now(),
        maxPerWindow = DEFAULT_MAX_PER_WINDOW,
        windowMs = DEFAULT_WINDOW_MS
    } = opts;
    const key = typeof target === 'string' ? target : channelBackpressureKey(target);
    const state = getState(key);

    if (state.backoffUntil > now) {
        return {
            allowed: false,
            key,
            reason: 'channel_backoff',
            retryAfterMs: state.backoffUntil - now,
            consecutiveFailures: state.consecutiveFailures
        };
    }

    state.timestamps = state.timestamps.filter(ts => now - ts < windowMs);
    if (state.timestamps.length >= maxPerWindow) {
        const retryAfterMs = Math.max(1, (state.timestamps[0] + windowMs) - now);
        return {
            allowed: false,
            key,
            reason: 'channel_rate_limited',
            retryAfterMs,
            remaining: 0
        };
    }

    state.timestamps.push(now);
    return {
        allowed: true,
        key,
        remaining: Math.max(0, maxPerWindow - state.timestamps.length)
    };
}

function recordChannelPushResult(target, result = {}, opts = {}) {
    const {
        now = Date.now(),
        baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
        maxBackoffMs = DEFAULT_MAX_BACKOFF_MS
    } = opts;
    const key = typeof target === 'string' ? target : channelBackpressureKey(target);
    const state = getState(key);

    if (result.success) {
        state.consecutiveFailures = 0;
        state.backoffUntil = 0;
        state.lastReason = null;
        return { key, consecutiveFailures: 0, backoffMs: 0, retryAfterMs: 0 };
    }

    state.consecutiveFailures += 1;
    state.lastReason = result.reason || (result.status ? `http_${result.status}` : 'unknown');

    const retryAfterMs = parseRetryAfterMs(result.retryAfter, now);
    const exponentialMs = Math.min(
        maxBackoffMs,
        baseBackoffMs * Math.pow(2, Math.max(0, state.consecutiveFailures - 1))
    );
    const backoffMs = Math.max(1, retryAfterMs ?? exponentialMs);
    state.backoffUntil = now + backoffMs;

    return {
        key,
        consecutiveFailures: state.consecutiveFailures,
        backoffMs,
        retryAfterMs: retryAfterMs || 0,
        backoffUntil: state.backoffUntil
    };
}

function getChannelBackpressureSnapshot(target) {
    const key = typeof target === 'string' ? target : channelBackpressureKey(target);
    const state = channelBackpressureState.get(key);
    if (!state) return null;
    return {
        timestamps: [...state.timestamps],
        consecutiveFailures: state.consecutiveFailures,
        backoffUntil: state.backoffUntil,
        lastReason: state.lastReason
    };
}

function resetChannelBackpressureState() {
    channelBackpressureState.clear();
}

module.exports = {
    DEFAULT_MAX_PER_WINDOW,
    DEFAULT_WINDOW_MS,
    DEFAULT_BASE_BACKOFF_MS,
    DEFAULT_MAX_BACKOFF_MS,
    channelBackpressureKey,
    parseRetryAfterMs,
    reserveChannelPush,
    recordChannelPushResult,
    getChannelBackpressureSnapshot,
    resetChannelBackpressureState
};
