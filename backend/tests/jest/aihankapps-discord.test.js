const discord = require('../../aihankapps-discord');

const GUILD = '1574788250583957615';
const FORUM = '1574789550536917073';

// Minimal fake of the REST routes the bot uses; records every call.
function fakeDiscord(routes) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const route = url.replace('https://discord.com/api/v10', '');
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ method: init.method, route, body, auth: init.headers.Authorization });
        const handler = routes[init.method + ' ' + route.split('?')[0]] || routes[init.method + ' *'];
        const out = handler ? handler(body, route) : {};
        return { ok: true, status: out === null ? 204 : 200, json: async () => out };
    };
    return { calls, fetchImpl };
}

describe('AiHankApps Discord bot', () => {
    test('forum tags keep existing ones and add every app plus moderated status tags', () => {
        const tags = discord.forumTags([{ id: '1', name: '紙上彈兵' }]);
        expect(tags[0]).toMatchObject({ id: '1', name: '紙上彈兵' });
        expect(tags.map(t => t.name)).toEqual(expect.arrayContaining(discord.APP_TAGS.map(([n]) => n).concat(['處理中', '已處理'])));
        expect(tags.filter(t => t.moderated).map(t => t.name)).toEqual(['處理中', '已處理']);
        expect(tags.length).toBeLessThanOrEqual(20);
        expect(tags.every(t => t.name.length <= 20)).toBe(true);
    });

    test('a forum post becomes a hub report for the tagged app, with its post time', () => {
        const thread = { id: '1575000000000000000', name: '閃退了', applied_tags: ['t1'] };
        const starter = { content: '打開第 3 關就閃退\niPhone 15 / 1.0.6', author: { username: 'amy', global_name: 'Amy' }, attachments: [{ filename: 'a.png', content_type: 'image/png' }] };
        const report = discord.reportFromThread(thread, starter, { t1: '紙上彈兵' });
        expect(report).toMatchObject({ id: thread.id, app: 'paper-flick-soldiers', reporter: 'Amy（Discord）', hasImage: true, category: 'discord' });
        expect(report.message).toBe('閃退了\n打開第 3 關就閃退\niPhone 15 / 1.0.6');
        expect(report.createdAt).toBe(discord.snowflakeTime(thread.id));
        expect(discord.reportFromThread({ id: thread.id, name: 'x', applied_tags: [] }, null, {}).app).toBe('portfolio');
    });

    test('first catalog read only records; later new versions and listings are announced', () => {
        const apps = [{ communityId: 'paper-flick-soldiers', name: '紙上彈兵', publicApple: true, iosVersion: '1.0.6', iosUrl: 'https://apps.apple.com/x', publicGoogle: false }];
        const first = discord.releaseMessages(apps, undefined);
        expect(first.messages).toEqual([]);
        const next = [{ ...apps[0], iosVersion: '1.0.7', publicGoogle: true, googleUrl: 'https://play.google.com/y' }];
        const second = discord.releaseMessages(next, first.current);
        expect(second.messages).toEqual(['📱 **紙上彈兵** iOS 版更新到 1.0.7\nhttps://apps.apple.com/x', '🎉 **紙上彈兵** 已在 Google Play 上架！\nhttps://play.google.com/y']);
        expect(discord.releaseMessages(next, second.current).messages).toEqual([]);
    });

    test('gift campaigns are announced once and again when sending starts, never on the first run', () => {
        const c = { id: 'xmas', announceAt: '2026-12-01T00:00:00Z', startsAt: '2026-12-24T00:00:00Z', deliveryEndsAt: '2026-12-31T00:00:00Z',
            copy: { 'zh-TW': { title: '聖誕禮包', upcoming: ['即將寄送'], active: ['寄送中'] } } };
        const before = discord.giftMessages([c], undefined, Date.parse('2026-11-30T00:00:00Z'));
        expect(before.messages).toEqual([]);
        const announced = discord.giftMessages([c], before.seen, Date.parse('2026-12-02T00:00:00Z'));
        expect(announced.messages).toEqual(['🎁 **聖誕禮包** 即將開始\n• 即將寄送']);
        const started = discord.giftMessages([c], announced.seen, Date.parse('2026-12-24T01:00:00Z'));
        expect(started.messages).toEqual(['🎁 **聖誕禮包** 開始寄送了！\n• 寄送中']);
        expect(discord.giftMessages([c], started.seen, Date.parse('2026-12-25T00:00:00Z')).messages).toEqual([]);
        // A campaign already running when the bot starts is recorded, not announced.
        expect(discord.giftMessages([c], undefined, Date.parse('2026-12-25T00:00:00Z')).messages).toEqual([]);
    });

    test('setup posts rules once, pins them, sets forum tags and empty topics only', async () => {
        const channels = [
            { id: 'r', name: 'rules', type: 0 }, { id: 'n', name: '新版本', type: 0 }, { id: 'g', name: '活動禮包', type: 0 }, { id: 'k', name: '內測招募', type: 0 },
            { id: FORUM, name: '問題回報', type: 15, available_tags: [] }, { id: 'p', name: '紙上彈兵', type: 0, topic: '' }, { id: 'w', name: 'weesh', type: 0, topic: '自訂主題' },
        ];
        let n = 0;
        const { calls, fetchImpl } = fakeDiscord({ [`GET /guilds/${GUILD}/channels`]: () => channels, 'POST *': () => ({ id: 'm' + (++n) }), 'PATCH *': () => ({}), 'PUT *': () => null });
        const client = discord.createClient({ token: 'test-token', fetchImpl });
        const result = await discord.runSetup(client, GUILD, {});
        expect(result.state).toMatchObject({ version: discord.SETUP_VERSION, rulesMessageId: 'm1' });
        expect(calls.find(c => c.route === '/channels/r/messages').body.content).toBe(discord.RULES);
        expect(calls.some(c => c.method === 'PUT' && c.route === '/channels/r/pins/m1')).toBe(true);
        expect(calls.find(c => c.route === `/channels/${FORUM}`).body.available_tags.length).toBe(14);
        expect(calls.some(c => c.route === '/channels/p' && c.method === 'PATCH')).toBe(true);
        expect(calls.some(c => c.route === '/channels/w')).toBe(false);
        expect(calls.every(c => c.auth === 'Bot test-token')).toBe(true);
        expect(calls.filter(c => c.body && c.body.content).every(c => c.body.allowed_mentions && c.body.allowed_mentions.parse.length === 0)).toBe(true);
        // Already set up: nothing is sent again.
        expect(await discord.runSetup(client, GUILD, { setup: result.state })).toEqual({ skipped: true });
    });

    test('a schedule note gets one fixed public reply and the status tag; done also archives', async () => {
        const tagsById = { a: '紙上彈兵', w: '處理中', d: '已處理' };
        const thread = { id: '1575000000000000000', applied_tags: ['a', 'w'], archived: false };
        const { calls, fetchImpl } = fakeDiscord({ 'GET *': () => thread, 'POST *': () => ({ id: 'x' }), 'PATCH *': () => ({}) });
        const client = discord.createClient({ token: 't', fetchImpl });
        const pool = { query: async () => ({ rows: [{ ref: 'fb-discord-1575000000000000000', state: 'done' }, { ref: 'fb-discord-not-a-thread', state: 'auto' }] }) };
        const out = await discord.syncReplies(client, pool, {}, tagsById);
        expect(out).toEqual({ replied: { '1575000000000000000': 'done' }, sent: 1 });
        expect(calls.find(c => c.method === 'POST').body.content).toBe(discord.REPLY.done);
        expect(calls.filter(c => c.method === 'PATCH').pop().body).toEqual({ applied_tags: ['a', 'd'], archived: true });
        // Same state again: no second reply.
        const again = fakeDiscord({ 'GET *': () => thread });
        expect((await discord.syncReplies(discord.createClient({ token: 't', fetchImpl: again.fetchImpl }), pool, out.replied, tagsById)).sent).toBe(0);
        expect(again.calls).toEqual([]);
    });

    test('without a token the bot stays off and its status carries no secret', () => {
        const bot = discord.createBot({ token: '', getPool: () => null, log: { log() {}, warn() {} } });
        expect(bot.start()).toBeNull();
        expect(bot.status()).toMatchObject({ enabled: false });
        const on = discord.createBot({ token: 'secret-token-value', getPool: () => null, log: { log() {}, warn() {} } });
        expect(JSON.stringify(on.status())).not.toContain('secret-token-value');
    });

    test('rate limits are retried after the advertised wait', async () => {
        let first = true;
        const waits = [];
        const fetchImpl = async () => {
            if (first) { first = false; return { ok: false, status: 429, json: async () => ({ retry_after: 0.5 }) }; }
            return { ok: true, status: 200, json: async () => ({ ok: 1 }) };
        };
        const client = discord.createClient({ token: 't', fetchImpl, sleep: async ms => { waits.push(ms); } });
        expect(await client.request('GET', '/x')).toEqual({ ok: 1 });
        expect(waits).toEqual([500]);
    });
});
