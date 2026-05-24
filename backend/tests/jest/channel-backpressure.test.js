const {
    channelBackpressureKey,
    parseRetryAfterMs,
    reserveChannelPush,
    recordChannelPushResult,
    resetChannelBackpressureState
} = require('../../channel-backpressure');

describe('channel callback backpressure', () => {
    beforeEach(() => {
        resetChannelBackpressureState();
    });

    test('caps outbound channel pushes at 30 per minute per account/entity', () => {
        const target = { deviceId: 'dev-a', entityId: 6, channelAccountId: 42 };

        for (let i = 0; i < 30; i += 1) {
            const reservation = reserveChannelPush(target, { now: 1000 + i });
            expect(reservation.allowed).toBe(true);
        }

        const blocked = reserveChannelPush(target, { now: 1030 });
        expect(blocked.allowed).toBe(false);
        expect(blocked.reason).toBe('channel_rate_limited');
        expect(blocked.retryAfterMs).toBeGreaterThan(0);
    });

    test('applies exponential backoff after callback failures and resets on success', () => {
        const target = { deviceId: 'dev-a', entityId: 6, channelAccountId: 42 };
        const key = channelBackpressureKey(target);

        const first = recordChannelPushResult(key, { success: false, reason: 'timeout' }, { now: 10_000 });
        expect(first.backoffMs).toBe(1000);

        const blocked = reserveChannelPush(key, { now: 10_500 });
        expect(blocked.allowed).toBe(false);
        expect(blocked.reason).toBe('channel_backoff');

        const second = recordChannelPushResult(key, { success: false, reason: 'timeout' }, { now: 12_000 });
        expect(second.backoffMs).toBe(2000);

        const reset = recordChannelPushResult(key, { success: true }, { now: 15_000 });
        expect(reset.consecutiveFailures).toBe(0);
        expect(reserveChannelPush(key, { now: 15_001 }).allowed).toBe(true);
    });

    test('honors Retry-After headers before exponential defaults', () => {
        const target = { deviceId: 'dev-a', entityId: 6, channelAccountId: 42 };
        const backoff = recordChannelPushResult(target, {
            success: false,
            status: 429,
            retryAfter: '7'
        }, { now: 20_000 });

        expect(backoff.backoffMs).toBe(7000);
        expect(parseRetryAfterMs('7', 20_000)).toBe(7000);
    });
});
