/**
 * Regression: GH#2956 — official_bots.retirement_reason sticky flag.
 *
 * When a free bot is retired due to chronic delivery failures (e.g. a local
 * Mac listener that consistently returns push_timeout), the bot must:
 *   1. Be excluded from /api/official-borrow/free-bots.
 *   2. Preserve its retirement_reason across admin PUT round-trips so a
 *      restart-time migration does not silently revert an admin re-enable.
 *   3. Allow admin re-enable by clearing retirement_reason via PUT.
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const get = (path) => request(app).get(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');
const put = (path) => request(app).put(path).set('Host', 'localhost');

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
    clearMap(app._officialBorrowTest.officialBots);
    clearMap(app._officialBorrowTest.officialBindingsCache);
});

describe('GH#2956 official_bots.retirement_reason', () => {
    it('admin GET surfaces display_name, model_name, retirement_reason', async () => {
        await post('/api/admin/bots/create')
            .send({ botId: 'retire-getme', botType: 'free', webhookUrl: 'https://x.example/h', token: 'tk' });
        await put('/api/admin/official-bot/retire-getme')
            .send({ status: 'disabled', displayName: 'StalledBot', retirementReason: 'GH#2956 test' });

        const res = await get('/api/admin/official-bots');
        expect(res.status).toBe(200);
        const bot = res.body.bots.find(b => b.bot_id === 'retire-getme');
        expect(bot).toBeTruthy();
        expect(bot.status).toBe('disabled');
        expect(bot.display_name).toBe('StalledBot');
        expect(bot.retirement_reason).toBe('GH#2956 test');
    });

    it('admin PUT sets and clears retirement_reason without status change', async () => {
        await post('/api/admin/bots/create')
            .send({ botId: 'retire-toggle', botType: 'free', webhookUrl: 'https://x.example/h', token: 'tk' });

        // Set retirement reason
        const setRes = await put('/api/admin/official-bot/retire-toggle')
            .send({ retirementReason: 'GH#2956: push_timeout x2' });
        expect(setRes.status).toBe(200);
        expect(app._officialBorrowTest.officialBots['retire-toggle'].retirement_reason).toBe('GH#2956: push_timeout x2');

        // Clear retirement reason by passing empty string (admin re-enable path)
        const clearRes = await put('/api/admin/official-bot/retire-toggle')
            .send({ retirementReason: '' });
        expect(clearRes.status).toBe(200);
        expect(app._officialBorrowTest.officialBots['retire-toggle'].retirement_reason).toBeNull();
    });

    it('disabled retired bot is excluded from /api/official-borrow/free-bots', async () => {
        await post('/api/admin/bots/create')
            .send({ botId: 'retire-hidden', botType: 'free', webhookUrl: 'https://x.example/h', token: 'tk' });
        await post('/api/admin/bots/create')
            .send({ botId: 'retire-shown', botType: 'free', webhookUrl: 'https://x.example/h', token: 'tk' });

        await put('/api/admin/official-bot/retire-hidden')
            .send({ status: 'disabled', retirementReason: 'GH#2956: chronic push_timeout' });

        const res = await get('/api/official-borrow/free-bots');
        expect(res.status).toBe(200);
        const ids = res.body.bots.map(b => b.botId);
        expect(ids).not.toContain('retire-hidden');
        expect(ids).toContain('retire-shown');
    });
});
