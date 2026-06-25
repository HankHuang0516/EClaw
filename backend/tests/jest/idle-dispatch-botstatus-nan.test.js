/**
 * idle-dispatch-botstatus-nan.test.js
 * Regression for card_4e82263a — GET /bot-status/:botId used parseInt(botId)
 * with no validation, so a non-numeric path param became NaN and reached
 * isBotBusy's `to_jsonb($2::int)`, crashing with Postgres
 * `invalid input syntax for type integer: "NaN"` (logged "Bot status error").
 * The route must now reject a non-integer botId with 400 BEFORE touching the DB.
 *
 * Uses a real ephemeral express server + node http (no supertest dependency).
 */
const http = require('http');
const express = require('express');

jest.mock('../../idle_dispatch_handler', () => ({
    smartDispatch: jest.fn(),
    drainBotQueue: jest.fn(),
    cleanupStuckQueue: jest.fn(),
    getQueueStatus: jest.fn(),
    isBotBusy: jest.fn().mockResolvedValue(false),
}));

const handler = require('../../idle_dispatch_handler');
const router = require('../../api_idle_dispatch');

function startServer() {
    const app = express();
    app.use(express.json());
    app.use('/api/mission/idle-dispatch', router);
    return new Promise((resolve) => {
        const server = app.listen(0, () => resolve(server));
    });
}

function get(server, urlPath) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : {} }));
        }).on('error', reject);
    });
}

const AUTH = 'deviceId=dev1&entityId=2&botSecret=sec1';

describe('GET /api/mission/idle-dispatch/bot-status/:botId — NaN guard (card_4e82263a)', () => {
    let server;
    beforeEach(async () => {
        jest.clearAllMocks();
        handler.isBotBusy.mockResolvedValue(false);
        server = await startServer();
    });
    afterEach((done) => { server.close(done); });

    test('non-numeric "NaN" botId → 400 and never calls the DB layer', async () => {
        const res = await get(server, `/api/mission/idle-dispatch/bot-status/NaN?${AUTH}`);
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(handler.isBotBusy).not.toHaveBeenCalled();
    });

    test('alphabetic botId → 400, no DB call', async () => {
        const res = await get(server, `/api/mission/idle-dispatch/bot-status/abc?${AUTH}`);
        expect(res.status).toBe(400);
        expect(handler.isBotBusy).not.toHaveBeenCalled();
    });

    test('valid numeric botId → 200 and isBotBusy called with the parsed integer', async () => {
        handler.isBotBusy.mockResolvedValue(true);
        const res = await get(server, `/api/mission/idle-dispatch/bot-status/5?${AUTH}`);
        expect(res.status).toBe(200);
        expect(res.body.botEntityId).toBe(5);
        expect(res.body.isBusy).toBe(true);
        expect(handler.isBotBusy).toHaveBeenCalledWith('dev1', 5);
    });

    test('missing auth → 401 (guard order unchanged)', async () => {
        const res = await get(server, '/api/mission/idle-dispatch/bot-status/5');
        expect(res.status).toBe(401);
        expect(handler.isBotBusy).not.toHaveBeenCalled();
    });
});
