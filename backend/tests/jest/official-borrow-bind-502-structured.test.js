/**
 * Structured 502 on free/personal bot bind failure (GH#3001 / card_3367).
 *
 * Before this change, every handshake failure surfaced as a generic 502 with
 * "無法與免費版機器人建立連線" — the caller had no way to distinguish:
 *
 *   - bot host unreachable (Mac local box offline, tunnel dropped)
 *   - gateway up but no sessions
 *   - upstream LLM timed out
 *   - gateway returned HTTP 5xx
 *
 * `buildBindFailurePayload` maps the handshake `errorType` to a stable `code`
 * plus a `retryable` flag + `retry_after_ms` hint so health-cron and the
 * Android/iOS UI can show a useful next step instead of "try again later".
 *
 * Coverage:
 *   1. Unit: every errorType → expected code + retryable
 *   2. Endpoint: bind-free returns structured 502 when handshake fails
 *      (validates the new fields are wired into the actual response).
 */

require('./helpers/mock-setup');

const request = require('supertest');
const db = require('../../db');
const gatekeeper = require('../../gatekeeper');

let app;

const post = (path) => request(app).post(path).set('Host', 'localhost').set('Accept-Encoding', 'identity');

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

function clearMap(map) {
    for (const key of Object.keys(map)) delete map[key];
}

beforeEach(() => {
    clearMap(app.devices);
    clearMap(app._publicCodeIndex);
    clearMap(app._officialBorrowTest.officialBots);
    clearMap(app._officialBorrowTest.officialBindingsCache);
    gatekeeper.isDeviceBlocked.mockReturnValue(false);
    gatekeeper.hasAgreedToTOS.mockReturnValue(true);
    db.getOfficialBinding.mockResolvedValue(null);
});

// ════════════════════════════════════════════════════════════════════════════
// 1. Unit: buildBindFailurePayload mapping
// ════════════════════════════════════════════════════════════════════════════
describe('buildBindFailurePayload (unit)', () => {
    const ctx = {
        botKind: 'free',
        botId: 'mac_local_minimax_2_5',
        botName: 'Mac本地版_MiniMax2.5',
        webhookUrl: 'https://mac-tunnel.example.com/mcp',
    };

    it('maps connection_failed → BOT_UNREACHABLE (the Mac-box-offline case from GH#3001)', () => {
        const p = app._buildBindFailurePayload(
            { success: false, error: 'fetch failed', errorType: 'connection_failed' },
            ctx,
        );
        expect(p.success).toBe(false);
        expect(p.code).toBe('BOT_UNREACHABLE');
        expect(p.errorType).toBe('connection_failed');
        expect(p.upstream).toBe('bot_webhook');
        expect(p.retryable).toBe(true);
        expect(p.retry_after_ms).toBeGreaterThan(0);
        expect(p.botId).toBe('mac_local_minimax_2_5');
        expect(p.botName).toBe('Mac本地版_MiniMax2.5');
        expect(p.webhookHost).toBe('mac-tunnel.example.com');
        expect(p.hint).toMatch(/offline|unreachable/i);
    });

    it('maps timeout → UPSTREAM_TIMEOUT (retryable)', () => {
        const p = app._buildBindFailurePayload(
            { success: false, error: 'aborted', errorType: 'timeout' },
            ctx,
        );
        expect(p.code).toBe('UPSTREAM_TIMEOUT');
        expect(p.retryable).toBe(true);
        expect(p.retry_after_ms).toBeGreaterThan(0);
    });

    it('maps no_sessions → BOT_NO_SESSIONS (NOT retryable — needs operator action)', () => {
        const p = app._buildBindFailurePayload(
            { success: false, error: 'No session found', errorType: 'no_sessions' },
            ctx,
        );
        expect(p.code).toBe('BOT_NO_SESSIONS');
        expect(p.retryable).toBe(false);
        expect(p.retry_after_ms).toBeUndefined();
    });

    it('maps http_502 → UPSTREAM_502 with httpStatus preserved', () => {
        const p = app._buildBindFailurePayload(
            { success: false, error: 'HTTP 502: Bad Gateway', errorType: 'http_502', httpStatus: 502 },
            ctx,
        );
        expect(p.code).toBe('UPSTREAM_502');
        expect(p.upstream_http_status).toBe(502);
        expect(p.retryable).toBe(true);
    });

    it('maps http_403 → UPSTREAM_HTTP_403 (not retryable, 4xx is not transient)', () => {
        const p = app._buildBindFailurePayload(
            { success: false, error: 'HTTP 403', errorType: 'http_403', httpStatus: 403 },
            ctx,
        );
        expect(p.code).toBe('UPSTREAM_HTTP_403');
        expect(p.retryable).toBe(false);
    });

    it('falls back gracefully on missing/unknown errorType', () => {
        const p = app._buildBindFailurePayload(
            { success: false, error: 'mystery' },
            ctx,
        );
        // Default mapping when errorType missing: treat as connection_failed.
        expect(p.code).toBe('BOT_UNREACHABLE');
        expect(p.botId).toBe('mac_local_minimax_2_5');
    });

    it('passes through nulls when bot metadata is absent', () => {
        const p = app._buildBindFailurePayload(
            { success: false, errorType: 'timeout' },
            {},
        );
        expect(p.botKind).toBeNull();
        expect(p.botId).toBeNull();
        expect(p.botName).toBeNull();
        expect(p.webhookHost).toBeNull();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Endpoint: POST /api/official-borrow/bind-free returns structured 502
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/official-borrow/bind-free — structured 502 on handshake failure', () => {
    function seedDeviceAndFreeBot() {
        const deviceId = 'gh3001-device';
        const deviceSecret = 'gh3001-secret';
        const botId = 'mac_local_minimax_2_5';
        const now = Date.now();

        // Device with one empty entity slot.
        app.devices[deviceId] = {
            deviceId,
            deviceSecret,
            createdAt: now,
            nextEntityId: 1,
            entities: {
                0: {
                    ...app._createDefaultEntity(0),
                    entityId: 0,
                    isBound: false,
                },
            },
        };

        // Free bot pointing at a webhook we'll force-fail.
        app._officialBorrowTest.officialBots[botId] = {
            bot_id: botId,
            display_name: 'Mac本地版_MiniMax2.5',
            bot_type: 'free',
            // Use a URL that hits the global.fetch mock below, NOT a private IP
            // (DNS-rebinding protection rejects private IPs before fetch).
            // example.com resolves to a public IP, satisfying the DNS-rebinding
            // guard; fetch itself is mocked so we never actually hit the network.
            webhook_url: 'https://example.com/mcp',
            token: 'fake-token',
            status: 'active',
            session_key_template: 'default',
        };

        return { deviceId, deviceSecret, botId };
    }

    it('returns 502 with code=BOT_UNREACHABLE when webhook host fails to connect', async () => {
        const { deviceId, deviceSecret, botId } = seedDeviceAndFreeBot();

        // Force every fetch attempt (handshake + session discovery) to fail
        // with a network error — same shape as a dropped tunnel.
        const origFetch = global.fetch;
        global.fetch = jest.fn().mockImplementation(async () => {
            const err = new Error('fetch failed: ECONNREFUSED');
            err.name = 'TypeError';
            throw err;
        });

        try {
            const res = await post('/api/official-borrow/bind-free')
                .send({ deviceId, deviceSecret, entityId: 0, botId });

            expect(res.status).toBe(502);
            // Structured fields the SOP / health-cron / Android UI rely on:
            expect(res.body.success).toBe(false);
            expect(res.body.code).toBe('BOT_UNREACHABLE');
            expect(res.body.upstream).toBe('bot_webhook');
            expect(res.body.errorType).toBe('connection_failed');
            expect(res.body.retryable).toBe(true);
            expect(res.body.retry_after_ms).toBeGreaterThan(0);
            expect(res.body.botId).toBe(botId);
            expect(res.body.botName).toBe('Mac本地版_MiniMax2.5');
            expect(res.body.botKind).toBe('free');
            expect(res.body.webhookHost).toBe('example.com');
            // The human-readable error still names the kind for backward compat.
            expect(res.body.error).toMatch(/免費版|BOT_UNREACHABLE/);
        } finally {
            global.fetch = origFetch;
        }
    });

    it('returns 502 with code=UPSTREAM_502 when webhook returns HTTP 502', async () => {
        const { deviceId, deviceSecret, botId } = seedDeviceAndFreeBot();

        const origFetch = global.fetch;
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 502,
            text: async () => 'Bad Gateway',
        });

        try {
            const res = await post('/api/official-borrow/bind-free')
                .send({ deviceId, deviceSecret, entityId: 0, botId });

            expect(res.status).toBe(502);
            expect(res.body.code).toBe('UPSTREAM_502');
            expect(res.body.errorType).toBe('http_502');
            expect(res.body.upstream_http_status).toBe(502);
            expect(res.body.retryable).toBe(true);
        } finally {
            global.fetch = origFetch;
        }
    });
});
