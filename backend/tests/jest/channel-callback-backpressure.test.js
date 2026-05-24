jest.mock('../../db', () => ({
    getChannelAccountById: jest.fn(),
    getChannelAccountByDevice: jest.fn()
}));

const db = require('../../db');
const channelApiFactory = require('../../channel-api');
const { resetChannelBackpressureState } = require('../../channel-backpressure');

function makeResponse({ ok, status, retryAfter = null, body = '' }) {
    return {
        ok,
        status,
        headers: {
            get: jest.fn((name) => String(name).toLowerCase() === 'retry-after' ? retryAfter : null)
        },
        text: jest.fn().mockResolvedValue(body)
    };
}

function makeChannelModule(serverLog = jest.fn()) {
    const devices = {
        'dev-a': {
            entities: {
                6: {
                    entityId: 6,
                    character: 'Hermes',
                    botSecret: 'bot-secret',
                    messageQueue: [],
                    isBound: true
                }
            }
        }
    };

    return channelApiFactory(devices, {
        authMiddleware: (_req, _res, next) => next(),
        serverLog,
        generateBotSecret: () => 'bot-secret',
        generatePublicCode: () => 'pub123',
        publicCodeIndex: {},
        saveChatMessage: jest.fn(),
        io: { to: () => ({ emit: jest.fn() }) },
        saveData: jest.fn().mockResolvedValue(true),
        createDefaultEntity: (entityId) => ({ entityId, messageQueue: [] }),
        apiBase: 'https://eclawbot.com',
        awardEntityXP: jest.fn(),
        XP_AMOUNTS: {},
        notifyDevice: jest.fn(),
        deliverToEntity: jest.fn(),
        gatekeeperCheckText: (_deviceId, _entityId, text) => ({ text }),
        resolveSpeakToTarget: jest.fn(),
        checkBotToBotRateLimit: () => true,
        checkCrossSpeakRateLimit: () => true,
        crossDeviceSettings: null,
        devicePrefs: { getPrefs: jest.fn().mockResolvedValue({}) },
        recentBroadcasts: {},
        BOT2BOT_MAX_MESSAGES: 8,
        db: {},
        getMissionApiHints: () => '',
        buildIdentitySetupHint: () => '',
        buildBroadcastRecipientBlock: () => '',
        chatPool: null
    });
}

describe('pushToChannelCallback backpressure integration', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
        resetChannelBackpressureState();
        db.getChannelAccountById.mockResolvedValue({
            id: 42,
            device_id: 'dev-a',
            callback_url: 'https://hermes.example/eclaw-webhook',
            callback_token: 'callback-token',
            e2ee_capable: false
        });
        db.getChannelAccountByDevice.mockResolvedValue(null);
        global.fetch = jest.fn().mockResolvedValue(makeResponse({ ok: true, status: 200 }));
    });

    afterEach(() => {
        global.fetch = originalFetch;
        jest.clearAllMocks();
    });

    test('stops the 31st callback push inside one minute', async () => {
        const channelModule = makeChannelModule();

        for (let i = 0; i < 30; i += 1) {
            const result = await channelModule.pushToChannelCallback('dev-a', 6, { text: `msg ${i}` }, 42);
            expect(result).toEqual({ pushed: true });
        }

        const blocked = await channelModule.pushToChannelCallback('dev-a', 6, { text: 'msg 31' }, 42);
        expect(blocked.pushed).toBe(false);
        expect(blocked.reason).toBe('channel_rate_limited');
        expect(blocked.backpressure).toBe(true);
        expect(blocked.retryAfter).toBeGreaterThan(0);
        expect(global.fetch).toHaveBeenCalledTimes(30);
    });

    test('honors remote 429 Retry-After and skips pushes during backoff', async () => {
        const serverLog = jest.fn();
        const channelModule = makeChannelModule(serverLog);
        global.fetch = jest.fn().mockResolvedValueOnce(makeResponse({
            ok: false,
            status: 429,
            retryAfter: '7',
            body: 'slow down'
        }));

        const first = await channelModule.pushToChannelCallback('dev-a', 6, { text: 'msg' }, 42);
        expect(first).toEqual({
            pushed: false,
            reason: 'http_429',
            retryAfter: 7,
            backpressure: true
        });

        const second = await channelModule.pushToChannelCallback('dev-a', 6, { text: 'blocked' }, 42);
        expect(second.pushed).toBe(false);
        expect(second.reason).toBe('channel_backoff');
        expect(second.retryAfter).toBeGreaterThan(0);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(serverLog).toHaveBeenCalledWith(
            'warn',
            'channel',
            expect.stringContaining('Callback push delayed'),
            expect.any(Object)
        );
    });
});
