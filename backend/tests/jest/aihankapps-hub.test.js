/**
 * AiHankApps 管理中樞 (/AiHankApps/hub/ + /api/aihankapps/hub/*): who gets in, what the data API answers, how the
 * page's data layer reads it, and how it is wired into the server. Everything here is synthetic.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const express = require('express');
const request = require('supertest');
const hub = require('../../aihankapps-hub');
const hubStore = require('../../aihankapps-hub-store');

const backendDir = path.resolve(__dirname, '../..');
const pageDir = path.join(backendDir, 'aihankapps-hub');
const NOW = Date.UTC(2026, 10, 10, 13, 0);           // 2026-11-10 21:00 in Taipei
const TODAY = '2026-11-10';
const START = hub.isoDay(hub.dayIndex(TODAY) - hub.HISTORY_DAYS + 1);
const at = iso => hub.dayIndex(iso) - hub.dayIndex(START);
const FRAUD = 'com.hankhuang.fraudempire';

function portfolioFixture(options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-portfolio-'));
    fs.mkdirSync(path.join(dir, 'reports'));
    fs.writeFileSync(path.join(dir, 'app-catalog.json'), JSON.stringify({ schemaVersion: 1, checkedAt: '2026-11-02T01:06:15.225Z', apps: [
        { name: 'Alpha：副標', iconText: 'AL', icon: 'icons/alpha.png', category: '工具', desc: 'first', aliases: ['A1', 'A2'], communityId: 'alpha',
            googlePackage: 'x.alpha', googleUrl: 'https://play.google.com/store/apps/details?id=x.alpha', googleStatus: '正式版', publicGoogle: true,
            iosId: '1', iosUrl: 'https://apps.apple.com/tw/app/id1', iosStatus: '開發中', publicApple: false, iosVersion: '1.2', guide: 'https://eclawbot.com/AiHankApps/guides/alpha/' },
        { name: 'Beta', icon: '../secret.png', communityId: 'com.example.beta', projectId: 'Beta Project', webUrl: 'javascript:alert(1)', webStatus: '開發中', guide: 'http://insecure.example/' },
        { name: 'Gamma', icon: 'https://cdn.example/icon.png', communityId: 'gamma', source: 'macOS / CLI', releaseUrl: 'https://example.com/release' },
        { name: 'no id' },
    ] }));
    const report = { schemaVersion: 2, mode: 'real', generatedAt: '2026-11-02T08:39:41.330Z', currency: 'TWD',
        apps: [
            { id: 'alpha', googleInstalls: { points: [{ date: '2026-10-25', value: 2 }, { date: '2026-10-27', value: 1 }] }, appleDownloads: { points: [{ date: '2026-10-26', value: 3 }] },
                admobRevenue: { points: [{ date: '2026-10-27', value: 0.123456 }] }, crashes: { points: [] }, anrs: { points: [] }, googleRating: { date: '2026-10-29', value: 4.5 } },
            { id: 'beta-old', googleInstalls: { points: [{ date: '2025-01-01', value: 9 }, { date: 'not-a-day', value: 1 }, { date: '2026-10-27', value: 'x' }] } },
        ],
        reviews: { apps: [{ id: 'alpha', google: { count: 2 }, apple: { count: 1 } }] },
        totals: { googleInstalls: { historyStart: '2026-08-01', historyEnd: '2026-10-27' }, appleDownloads: { historyStart: '2026-08-02', historyEnd: '2026-10-29' },
            admobRevenue: { historyStart: '2026-01-01', historyEnd: '2026-11-01' }, crashes: {}, anrs: {}, unallocatedRevenue: { historyTotal: 1.5 } } };
    if (options.report !== false) fs.writeFileSync(path.join(dir, 'reports', 'data.js'), options.report || 'window.AIHANK_REPORT = ' + JSON.stringify(report) + ';\n');
    return dir;
}

// A stand-in pg pool: answers by table name, records every statement, and can fail one table.
function fakePool(overrides = {}) {
    const tables = {
        trafficFirst: [{ first: '2026-11-08' }],
        trafficRows: [{ day: '2026-11-08', app_id: '__site__', action: 'view', count: '5' }, { day: '2026-11-09', app_id: 'alpha', action: 'intro', count: '4' },
            { day: '2026-11-09', app_id: 'alpha', action: 'google', count: '1' }, { day: '2026-11-09', app_id: 'alpha', action: 'bogus', count: '9' }],
        likes: [{ app_id: 'alpha', n: 3 }], comments: [{ app_id: 'alpha', n: 1 }], beta: [{ app_id: 'alpha', n: 2, rating: 4.3333 }],
        feedback: [{ n: 4, recent: 1, latest: new Date('2026-11-09T00:00:00Z') }],
        users: [{ total: 12, verified: 9, premium: 1 }], signups: [{ day: '2026-11-09', n: 2 }],
        chat: [{ day: '2026-11-10', messages: 7, devices: 3 }],
        dreamFirst: [{ first: '2026-11-01' }], dreamJobs: [{ day: '2026-11-09', jobs: 5, completed: 4, failed: 1, devices: 2 }], dreamAds: [{ day: '2026-11-09', n: 3 }],
        tappay: [{ day: '2026-11-09', n: 1, twd: 150 }], topups: [{ day: '2026-11-09', n: 2, twd: 180 }],
        hubDaily: [{ app_id: 'alpha', metric: 'activeUsers', day: '2026-11-08', value: 4 }, { app_id: 'alpha', metric: 'activeUsers', day: '2026-11-09', value: 6 },
            { app_id: 'alpha', metric: 'bogus', day: '2026-11-09', value: 9 }, { app_id: 'ghost', metric: 'plays', day: '2026-11-09', value: 9 }],
        hubFacts: [{ app_id: 'alpha', key: 'playersTotal', value: { label: '玩家總數', value: 12, unit: '人', order: 10 }, source: 'rebound', observed_at: new Date(NOW - 3600000) },
            { app_id: 'alpha', key: 'retention', value: { label: '留存', basis: '有玩一局', cohorts: [{ start: '2026-10-05', size: 4, d1: 2, d3: 1, d7: null, d14: null, d30: null }] }, source: 'rebound', observed_at: new Date(NOW - 3600000) },
            { app_id: 'ghost', key: 'playersTotal', value: { label: 'x', value: 1 }, source: 'rebound', observed_at: new Date(NOW) }],
        hubSources: [{ id: 'rebound', collected_at: new Date(NOW - 3600000), imported_at: new Date(NOW - 3500000), detail: { values: 2, notes: ['一則說明'] } }],
        probesRecent: [{ service: 'eclaw', at: new Date(Math.floor(NOW / 300000) * 300000), checks: 5, failures: 1, ms_total: 400 }],
        probesDaily: [{ service: 'eclaw', day: '2026-11-10', checks: 100, failures: 5, ms_total: 9500 }, { service: 'eclaw', day: '2026-10-01', checks: 10, failures: 10, ms_total: 0 }],
        ...overrides,
    };
    const pool = { log: [], params: {}, released: 0, connected: 0, direct: [] };
    pool.query = async sql => { pool.direct.push(sql); return { rows: [] }; };
    const pick = key => { if (tables[key] instanceof Error) throw tables[key]; return { rows: tables[key] }; };
    const answer = (sql, values) => {
        if (['BEGIN READ ONLY', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SET LOCAL statement_timeout = ')) return { rows: [] };
        const key = sql.includes('MIN(day)') ? 'trafficFirst' : sql.includes('FROM app_portfolio_traffic_daily') ? 'trafficRows'
            : sql.includes('FROM app_portfolio_likes') ? 'likes' : sql.includes('FROM app_portfolio_comments') ? 'comments' : sql.includes('FROM app_portfolio_beta_feedback') ? 'beta'
                : sql.includes('FROM fraud_app_feedback_reports') ? 'feedback' : sql.includes('FROM user_accounts') && sql.includes('GROUP BY') ? 'signups' : sql.includes('FROM user_accounts') ? 'users'
                    : sql.includes('FROM chat_messages') ? 'chat' : sql.includes('MIN(quota_date)') ? 'dreamFirst' : sql.includes('FROM dream_buddy_inference_jobs') ? 'dreamJobs'
                        : sql.includes('FROM dream_buddy_ad_transactions') ? 'dreamAds' : sql.includes('FROM tappay_transactions') ? 'tappay' : sql.includes('FROM topup_orders') ? 'topups'
                            : sql.includes('FROM aihankapps_hub_daily') ? 'hubDaily' : sql.includes('FROM aihankapps_hub_facts') ? 'hubFacts' : sql.includes('FROM aihankapps_hub_sources') ? 'hubSources'
                                : sql.includes("step = 'q'") ? 'probesRecent' : sql.includes("step = 'h'") ? 'probesDaily' : null;
        if (!key) throw new Error('Unexpected synthetic SQL: ' + sql);
        pool.params[key] = values;
        return pick(key);
    };
    pool.connect = async () => {
        pool.connected += 1;
        return { query: async (sql, values) => { pool.log.push(sql); return answer(sql, values); }, release: () => { pool.released += 1; } };
    };
    return pool;
}

function mount(options = {}) {
    const state = { ready: options.ready !== false, clock: NOW };
    const app = express();
    const stats = { publicRequests: 0 };
    const authMiddleware = (req, res, next) => {
        const who = req.get('x-test-user');
        if (who === 'boom') throw new Error('auth exploded');
        if (!['admin', 'member'].includes(who)) return res.status(401).json({ success: false, error: 'Not authenticated', reason: 'no_token' });
        req.user = { userId: who };
        next();
    };
    // Like the real one, this answers later (it asks the database).
    const adminMiddleware = (req, res, next) => setImmediate(() => {
        if (req.get('x-test-admin-db') === 'down') return res.status(500).json({ success: false, error: 'Server error' });
        return req.user.userId === 'admin' ? next() : res.status(403).json({ success: false, error: 'Admin access required' });
    });
    const pool = options.pool || fakePool();
    const routers = hub.createRouters({ authMiddleware, adminMiddleware, getPool: () => pool, getAuthPool: () => options.authPool || pool, isReady: () => state.ready,
        getDeviceStats: options.getDeviceStats || (() => ({ devices: 4, entities: 9, boundEntities: 6 })), now: () => state.clock, fetchImpl: options.fetchImpl,
        portfolioDir: options.portfolioDir || portfolioFixture(), ...(options.pageDir ? { pageDir: options.pageDir } : {}) });
    const slot = { page: routers.page };
    app.use('/AiHankApps/hub', hub.privateHeaders, (req, res) => slot.page(req, res, error => {
        if (!res.headersSent) res.status(error ? 503 : 404).json({ success: false, error: 'Admin hub unavailable' });
    }));
    app.use('/api/aihankapps/hub', routers.api);
    app.use((_req, res) => { stats.publicRequests += 1; res.status(200).send('public fallback'); });
    return { app, stats, routers, state, pool };
}
const as = (req, who) => req.set('x-test-user', who);
const browser = req => req.set('accept', 'text/html,application/xhtml+xml');

describe('admin hub: who gets in', () => {
    test('someone who is not signed in is sent to sign in, and gets nothing of the page', async () => {
        const { app, stats } = mount();
        for (const url of ['/AiHankApps/hub/', '/AiHankApps/hub', '/AiHankApps/hub/index.html']) {
            const res = await browser(request(app).get(url));
            expect(res.status).toBe(302);
            expect(res.headers.location).toBe('/portal/?return_to=%2FAiHankApps%2Fhub%2F');
            expect(res.headers['cache-control']).toBe('private, no-store, no-transform, max-age=0');
            expect(res.text).not.toContain('管理中樞');
        }
        for (const file of Object.keys(hub.PAGE_FILES).filter(name => name !== 'index.html')) {
            const res = await request(app).get('/AiHankApps/hub/' + file);
            expect(res.status).toBe(401);
            expect(res.body).toEqual({ success: false, error: 'Not authenticated' });
        }
        expect((await request(app).get('/AiHankApps/hub/')).status).toBe(401);       // not a browser navigation: plain status
        expect((await request(app).get('/api/aihankapps/hub/data')).status).toBe(401);
        expect(stats.publicRequests).toBe(0);
    });

    test('a signed-in account that is not an administrator is told so, and gets no page file or data', async () => {
        const { app, stats, pool } = mount();
        const page = await browser(as(request(app).get('/AiHankApps/hub/'), 'member'));
        expect(page.status).toBe(403);
        expect(page.headers['content-type']).toMatch(/text\/html/);
        expect(page.text).toContain('這個帳號沒有管理者權限');
        expect(page.text).not.toContain('hub-app.js');
        expect((await as(request(app).get('/AiHankApps/hub/hub-app.js'), 'member')).status).toBe(403);
        const data = await as(request(app).get('/api/aihankapps/hub/data'), 'member');
        expect(data.status).toBe(403);
        expect(data.body).toEqual({ success: false, error: 'Admin access required' });
        expect(pool.connected).toBe(0);
        expect(stats.publicRequests).toBe(0);
    });

    test('an administrator gets the page and every file it needs, privately', async () => {
        const { app } = mount();
        const page = await browser(as(request(app).get('/AiHankApps/hub/'), 'admin'));
        expect(page.status).toBe(200);
        expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(page.text).toBe(fs.readFileSync(path.join(pageDir, 'index.html'), 'utf8'));
        expect(page.headers['cache-control']).toBe('private, no-store, no-transform, max-age=0');
        expect(page.headers['cdn-cache-control']).toBe('no-store');
        expect(page.headers['x-robots-tag']).toBe('noindex, nofollow');
        expect(page.headers['x-content-type-options']).toBe('nosniff');
        expect(page.headers['x-frame-options']).toBe('SAMEORIGIN');
        expect(page.headers['content-security-policy']).toBe(hub.CONTENT_SECURITY_POLICY);
        expect(page.headers.vary).toMatch(/Cookie/);
        for (const [file, type] of Object.entries(hub.PAGE_FILES)) {
            const res = await as(request(app).get('/AiHankApps/hub/' + file), 'admin');
            expect([file, res.status, res.headers['content-type']]).toEqual([file, 200, type]);
            expect(Number(res.headers['content-length'])).toBe(fs.statSync(path.join(pageDir, file)).size);
        }
        const head = await as(request(app).head('/AiHankApps/hub/hub.css'), 'admin');
        expect(head.status).toBe(200);
        expect(head.text).toBeUndefined();
        const bare = await as(request(app).get('/AiHankApps/hub?x=1'), 'admin');
        expect([bare.status, bare.headers.location]).toEqual([308, '/AiHankApps/hub/']);
    });

    test('only the listed files exist: unknown names, traversal, writes and other origins are refused', async () => {
        const { app, stats } = mount();
        for (const name of ['secret.js', 'README.md', 'constructor', '__proto__', 'hub-app.js.map', '..%2Faihankapps-hub.js', 'a/b.js']) {
            const res = await as(request(app).get('/AiHankApps/hub/' + name), 'admin');
            expect([name, res.status]).toEqual([name, 404]);
        }
        const post = await as(request(app).post('/AiHankApps/hub/'), 'admin');
        expect([post.status, post.headers.allow]).toEqual([405, 'GET, HEAD']);
        expect((await as(request(app).delete('/api/aihankapps/hub/data'), 'admin')).status).toBe(405);
        expect((await as(request(app).get('/AiHankApps/hub/'), 'admin').set('origin', 'https://evil.test')).status).toBe(403);
        expect((await as(request(app).get('/api/aihankapps/hub/data'), 'admin').set('origin', 'https://evil.test')).status).toBe(403);
        expect((await as(request(app).get('/api/aihankapps/hub/data'), 'admin').set('origin', 'https://eclawbot.com')).status).toBe(200);
        expect((await as(request(app).get('/api/aihankapps/hub/nope'), 'admin')).status).toBe(404);
        expect(stats.publicRequests).toBe(0);
    });

    test('fails closed while the server is starting or when the admin check itself cannot answer', async () => {
        const starting = mount({ ready: false });
        expect((await browser(as(request(starting.app).get('/AiHankApps/hub/'), 'admin'))).status).toBe(503);
        expect((await as(request(starting.app).get('/api/aihankapps/hub/data'), 'admin')).status).toBe(503);
        expect((await as(request(starting.app).get('/api/aihankapps/hub/access'), 'admin')).body).toEqual({ success: true, admin: false });
        const { app, stats } = mount();
        expect((await browser(as(request(app).get('/AiHankApps/hub/'), 'admin').set('x-test-admin-db', 'down'))).status).toBe(503);
        expect((await browser(as(request(app).get('/AiHankApps/hub/'), 'boom'))).status).toBe(503);
        const missing = mount({ pageDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hub-empty-')) });
        jest.spyOn(console, 'error').mockImplementation(() => {});
        expect((await as(request(missing.app).get('/AiHankApps/hub/hub.css'), 'admin')).status).toBe(503);
        expect(stats.publicRequests + starting.stats.publicRequests + missing.stats.publicRequests).toBe(0);
    });

    test('the portfolio can ask whether to show the entry: only an administrator gets yes, and nothing else is said', async () => {
        const { app, pool } = mount();
        for (const [who, admin] of [[null, false], ['member', false], ['admin', true], ['boom', false]]) {
            const req = request(app).get('/api/aihankapps/hub/access');
            const res = await (who ? as(req, who) : req);
            expect([who, res.status, res.body]).toEqual([who, 200, { success: true, admin }]);
            expect(res.headers['cache-control']).toBe('private, no-store, no-transform, max-age=0');
        }
        expect((await as(request(app).get('/api/aihankapps/hub/access'), 'admin').set('x-test-admin-db', 'down')).body.admin).toBe(false);
        expect(pool.connected).toBe(0);                      // answering does not read any data
    });

    test('the stand-in response accepts whatever an auth middleware calls on it, and only next() is a pass', async () => {
        const run = middleware => hub.decide(middleware, {});
        expect(await run((_q, _s, next) => next())).toEqual({ pass: true });
        expect(await run((_q, _s, next) => next(new Error('x')))).toEqual({ pass: false, status: 500 });
        expect(await run((_q, res) => res.status(401).json({}))).toEqual({ pass: false, status: 401 });
        expect(await run((_q, res) => res.set('X', '1').vary('Cookie').clearCookie('eclaw_session').status(403).send('no'))).toEqual({ pass: false, status: 403 });
        expect(await run((_q, res) => res.sendStatus(404))).toEqual({ pass: false, status: 404 });
        expect(await run((_q, res) => res.redirect('/login'))).toEqual({ pass: false, status: 401 });
        expect(await run((_q, res) => res.json({ ok: true }))).toEqual({ pass: false, status: 200 });      // answered without next(): not a pass
        expect(await run(() => { throw new Error('boom'); })).toEqual({ pass: false, status: 500 });
        expect(await run((_q, res, next) => { res.status(401).json({}); next(); })).toEqual({ pass: false, status: 401 });   // the first decision stands
        expect(await run(async (_q, res) => { await null; res.status(403).end(); })).toEqual({ pass: false, status: 403 });
    });

    test('createRouters insists on the existing auth pieces', () => {
        expect(() => hub.createRouters({})).toThrow('Admin hub requires existing auth, admin and readiness middleware');
        expect(() => hub.createRouters()).toThrow();
    });
});

describe('admin hub: service checks', () => {
    test('the latest check of each back-end is for administrators only, and comes from memory', async () => {
        const fetchImpl = async url => ({ status: url.includes('wishlist-app') ? 503 : 200, body: null, json: async () => ({ status: 'ok', ok: true, workers: [], version: 'v9' }) });
        const { app, routers, state } = mount({ fetchImpl });
        const ask = who => as(request(app).get('/api/aihankapps/hub/services'), who);
        expect([(await request(app).get('/api/aihankapps/hub/services')).status, (await ask('member')).status]).toEqual([401, 403]);
        const before = await ask('admin');
        expect([before.status, before.headers['cache-control']]).toEqual([200, 'private, no-store, no-transform, max-age=0']);
        expect(before.body).toEqual({ success: true, checkedAt: NOW, services: hubStore.SERVICES.map(x => ({ id: x.id, name: x.name, apps: x.apps, ok: null, status: null, ms: null, at: null, info: null })) });
        await routers.probes.run();
        const after = await ask('admin');
        expect(after.body.services.map(x => [x.id, x.ok, x.status, x.info])).toEqual([['eclaw', true, 200, null], ['wishlist', false, 503, null], ['rebound', true, 200, null],
            ['summit', true, 200, 'v9'], ['leaderboard', true, 200, null], ['timehut', true, 200, 'v9'], ['monitor', true, 200, 'v9']]);
        expect((await as(request(app).post('/api/aihankapps/hub/services'), 'admin')).status).toBe(405);
        state.ready = false;
        expect((await ask('admin')).status).toBe(503);
    });
});

describe('admin hub: the data answer', () => {
    test('turns the catalog, the store report and the database rows into daily series', async () => {
        const { app } = mount();
        const res = await as(request(app).get('/api/aihankapps/hub/data'), 'admin');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('private, no-store, no-transform, max-age=0');
        const body = res.body, s = body.daily.series;
        expect([body.success, body.schemaVersion, body.generatedAt, body.timeZone, body.today]).toEqual([true, 1, NOW, 'Asia/Taipei', TODAY]);
        expect(body.daily).toMatchObject({ start: START, days: hub.HISTORY_DAYS });
        expect(Object.values(body.sources).map(x => x.ok)).toEqual(new Array(11).fill(true));

        // catalog: only what the portfolio already shows, with unsafe values dropped
        expect(body.apps.map(a => a.id)).toEqual(['alpha', 'com.example.beta', 'gamma']);
        expect(body.apps[0]).toMatchObject({ slug: 'alpha', name: 'Alpha：副標', mono: 'AL', category: '工具', aliases: 'A1 A2', icon: '/AiHankApps/icons/alpha.png',
            links: { guide: 'https://eclawbot.com/AiHankApps/guides/alpha/' } });
        expect(body.apps[0].platforms).toEqual([
            { key: 'android', label: 'Android', status: '正式版', public: true, url: 'https://play.google.com/store/apps/details?id=x.alpha', version: null },
            { key: 'ios', label: 'iOS', status: '開發中', public: false, url: 'https://apps.apple.com/tw/app/id1', version: '1.2' }]);
        expect(body.apps[1]).toMatchObject({ slug: 'beta-project', icon: null, links: { guide: null } });
        expect(body.apps[1].platforms).toEqual([{ key: 'web', label: 'Web', status: '開發中', public: false, url: null, version: null }]);
        expect(body.apps[2]).toMatchObject({ icon: 'https://cdn.example/icon.png', platforms: [{ key: 'other', label: 'macOS / CLI', status: '', public: true, url: 'https://example.com/release', version: null }] });

        // store report: a day without a point stays unknown; points outside the window or malformed are dropped
        expect(s.googleInstalls).toEqual({ alpha: { o: at('2026-10-25'), v: [2, null, 1] } });
        expect(s.appleDownloads).toEqual({ alpha: { o: at('2026-10-26'), v: [3] } });
        expect(s.admobRevenue).toEqual({ alpha: { o: at('2026-10-27'), v: [0.1235] } });
        expect(s.crashes).toBeUndefined();
        expect(body.sources.store).toMatchObject({ generatedAt: '2026-11-02T08:39:41.330Z', currency: 'TWD', unallocatedRevenue: 1.5,
            ends: { googleInstalls: '2026-10-27', appleDownloads: '2026-10-29', admobRevenue: '2026-11-01', crashes: null, anrs: null } });
        expect(body.latest.rating).toEqual({ alpha: { value: 4.5, date: '2026-10-29' } });
        expect(body.latest.reviews).toEqual({ alpha: { google: 2, apple: 1 } });

        // portfolio traffic: zero from the day counting began, for every app in the catalog; unknown actions ignored
        expect(s.siteViews).toEqual({ __site__: { o: at('2026-11-08'), v: [5, 0, 0] } });
        expect(s.introViews.alpha).toEqual({ o: at('2026-11-08'), v: [0, 4, 0] });
        expect(s.googleClicks.alpha).toEqual({ o: at('2026-11-08'), v: [0, 1, 0] });
        expect(s.appleClicks['com.example.beta']).toEqual({ o: at('2026-11-08'), v: [0, 0, 0] });
        expect(body.sources.traffic.startedAt).toBe('2026-11-08');
        expect(body.latest).toMatchObject({ likes: { alpha: 3 }, comments: { alpha: 1 }, betaFeedback: { alpha: { count: 2, rating: 4.33 } },
            feedback: { [FRAUD]: { count: 4, recent: 1, latestAt: Date.parse('2026-11-09T00:00:00Z') } } });

        // EClawbot: accounts cover the whole window; chat only the days that were scanned
        expect(body.eclaw).toEqual({ users: { total: 12, verified: 9, premium: 1 }, devices: { total: 4, entities: 9, boundEntities: 6 } });
        expect(s.eclawSignups.eclawbot.o).toBe(0);
        expect(s.eclawSignups.eclawbot.v).toHaveLength(hub.HISTORY_DAYS);
        expect(s.eclawSignups.eclawbot.v.slice(-3)).toEqual([0, 2, 0]);
        expect(s.eclawMessages.eclawbot.o).toBe(hub.HISTORY_DAYS - hub.CHAT_DAYS);
        expect(s.eclawMessages.eclawbot.v).toHaveLength(hub.CHAT_DAYS);
        expect([s.eclawMessages.eclawbot.v.at(-1), s.eclawActiveDevices.eclawbot.v.at(-1), s.eclawMessages.eclawbot.v.at(-2)]).toEqual([7, 3, 0]);
        expect(body.sources.eclawChat).toMatchObject({ since: hub.isoDay(hub.dayIndex(TODAY) - hub.CHAT_DAYS + 1), readAt: NOW });

        // 夢話夥伴: the table holds its whole history, so days before the first row are zero
        expect(s.dreamTurns.dreambuddy.v).toHaveLength(hub.HISTORY_DAYS);
        expect([s.dreamTurns.dreambuddy.v[0], s.dreamTurns.dreambuddy.v.at(-2), s.dreamCompleted.dreambuddy.v.at(-2), s.dreamFailed.dreambuddy.v.at(-2),
            s.dreamActiveDevices.dreambuddy.v.at(-2), s.dreamAds.dreambuddy.v.at(-2)]).toEqual([0, 5, 4, 1, 2, 3]);
        expect(body.sources.dreambuddy.startedAt).toBe('2026-11-01');

        // EClawbot payments: successful card payments plus paid, unrefunded top-ups, zero from the window's start
        expect(s.eclawPurchases.eclawbot.v).toHaveLength(hub.HISTORY_DAYS);
        expect([s.eclawPurchases.eclawbot.v.slice(-3), s.eclawPaidTwd.eclawbot.v.slice(-3)]).toEqual([[0, 3, 0], [0, 330, 0]]);

        // imported back-end counts: catalog apps and known metrics only, under an x. prefix; facts carry where they came from
        expect(s['x.activeUsers']).toEqual({ alpha: { o: at('2026-11-08'), v: [4, 6] } });
        expect([s['x.bogus'], s['x.plays']]).toEqual([undefined, undefined]);
        expect(body.latest.facts).toEqual({ alpha: {
            playersTotal: { label: '玩家總數', value: 12, unit: '人', order: 10, source: 'rebound', observedAt: NOW - 3600000 },
            retention: { label: '留存', basis: '有玩一局', cohorts: [{ start: '2026-10-05', size: 4, d1: 2, d3: 1, d7: null, d14: null, d30: null }], source: 'rebound', observedAt: NOW - 3600000 } } });
        expect(body.sources.imports).toEqual({ ok: true, collectors: { rebound: { collectedAt: NOW - 3600000, importedAt: NOW - 3500000, values: 2, notes: ['一則說明'] } } });

        // service checks: every watched back-end, with 24 hours of buckets and 90 days
        expect(body.services.map(x => x.id)).toEqual(hubStore.SERVICES.map(x => x.id));
        const main = body.services[0];
        expect([main.recent.up.at(-1), main.recent.ms.at(-1), main.uptime24h, main.daily.up.at(-1), main.daily.ms.at(-1), main.uptime7d, main.uptime90d]).toEqual([80, 100, 80, 95, 100, 95, 86.36]);
        expect([body.services[1].uptime24h, body.services[1].daily.up.every(v => v === null)]).toEqual([null, true]);
    });

    test('every database read is read-only, time-limited, and gives its connection back', async () => {
        const { app, pool } = mount();
        await as(request(app).get('/api/aihankapps/hub/data'), 'admin');
        expect(pool.connected).toBe(9);
        expect(pool.released).toBe(9);
        expect(pool.log.filter(sql => sql === 'BEGIN READ ONLY')).toHaveLength(9);
        expect(pool.log.filter(sql => sql === 'SET LOCAL statement_timeout = 8000')).toHaveLength(9);
        expect(pool.log.filter(sql => sql === 'COMMIT')).toHaveLength(9);
        expect(pool.log.join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/);
        // outside those transactions only the hub's own tables are prepared, once
        expect(pool.direct.map(sql => sql.split('(')[0].trim())).toEqual(['aihankapps_hub_probes', 'aihankapps_hub_daily', 'aihankapps_hub_facts', 'aihankapps_hub_sources'].map(t => 'CREATE TABLE IF NOT EXISTS ' + t));
        expect(pool.log.join('\n')).toMatch(/FROM tappay_transactions WHERE status = 'success' AND currency = 'TWD'/);
        expect(pool.log.join('\n')).toMatch(/FROM topup_orders WHERE status = 'paid' AND refunded_at IS NULL AND amount_twd > 0/);
        // nothing personal is selected: counts and days only
        expect(pool.log.join('\n')).not.toMatch(/SELECT \*|\b(email|device_secret|password_hash|nickname|content|description|prompt|visitor_hash|ua|referer|ip)\b|(?<!::)\btext\b/);
        expect(pool.params.trafficRows).toEqual([START]);
        expect(pool.params.signups[0].toISOString()).toBe(new Date(hub.dayIndex(START) * 86400000 - 8 * 3600000).toISOString());
        expect(pool.params.chat[0].toISOString()).toBe(new Date((hub.dayIndex(TODAY) - hub.CHAT_DAYS + 1) * 86400000 - 8 * 3600000).toISOString());
    });

    test('a source that cannot be read is reported and the rest still arrives', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const pool = fakePool({ chat: new Error('statement timeout'), dreamFirst: new Error('relation "dream_buddy_inference_jobs" does not exist') });
        const { app } = mount({ pool, portfolioDir: portfolioFixture({ report: 'window.AIHANK_REPORT = oops;' }), getDeviceStats: () => { throw new Error('devices not loaded'); } });
        const res = await as(request(app).get('/api/aihankapps/hub/data'), 'admin');
        expect(res.status).toBe(200);
        const ok = Object.fromEntries(Object.entries(res.body.sources).map(([id, value]) => [id, value.ok]));
        expect(ok).toEqual({ catalog: true, store: false, traffic: true, community: true, feedback: true, eclaw: true, eclawChat: false, dreambuddy: false, eclawPayments: true, imports: true, services: true });
        expect(res.body.sources.eclawChat).toEqual({ ok: false });            // no error text leaves the server
        expect(res.body.daily.series.googleInstalls).toBeUndefined();
        expect(res.body.daily.series.eclawMessages).toBeUndefined();
        expect(res.body.daily.series.dreamTurns).toBeUndefined();
        expect(res.body.daily.series.introViews.alpha.v).toEqual([0, 4, 0]);
        expect(res.body.eclaw).toEqual({ users: { total: 12, verified: 9, premium: 1 }, devices: null });
        expect(pool.log.filter(sql => sql === 'ROLLBACK')).toHaveLength(2);
        expect(pool.released).toBe(pool.connected);
        expect(JSON.stringify(res.body)).not.toMatch(/statement timeout|does not exist|devices not loaded/);
    });

    test('without a database the files still answer, and a missing catalog does not take the answer down', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-none-'));
        const routers = hub.createRouters({ authMiddleware: (_q, _s, next) => next(), adminMiddleware: (_q, _s, next) => next(), getPool: () => null, getAuthPool: () => null,
            isReady: () => true, now: () => NOW, portfolioDir: empty });
        const body = await routers.data.load();
        expect(body.success).toBe(true);
        expect(body.apps).toEqual([]);
        expect(Object.values(body.sources).every(x => x.ok === false)).toBe(true);
        expect(body.daily.series).toEqual({});
    });

    test('answers are reused for two minutes, the chat scan for ten, and concurrent requests share one build', async () => {
        const { routers, state, pool } = mount();
        const chatScans = () => pool.log.filter(sql => sql.includes('FROM chat_messages')).length;
        const [a, b] = await Promise.all([routers.data.load(), routers.data.load()]);
        expect(a).toBe(b);
        expect([pool.connected, chatScans()]).toEqual([9, 1]);
        state.clock = NOW + 119000;
        expect(await routers.data.load()).toBe(a);
        expect(pool.connected).toBe(9);
        const forced = await routers.data.load({ fresh: true });               // rebuilt, but the chat rows are still fresh enough
        expect(forced).not.toBe(a);
        expect([pool.connected, chatScans()]).toEqual([17, 1]);
        expect(forced.daily.series.eclawMessages.eclawbot.v.at(-1)).toBe(7);
        state.clock = NOW + 10 * 60000 + 1000;
        await routers.data.load();
        expect([pool.connected, chatScans()]).toEqual([26, 2]);
    });

    test('the small pieces: days, daily slots, report and catalog parsing', () => {
        expect(hub.taipeiDay(Date.UTC(2026, 10, 10, 15, 59))).toBe('2026-11-10');
        expect(hub.taipeiDay(Date.UTC(2026, 10, 10, 16, 0))).toBe('2026-11-11');     // midnight in Taipei
        expect(hub.isoDay(hub.dayIndex('2024-02-29') + 1)).toBe('2024-03-01');
        const daily = hub.createDaily(hub.dayIndex('2026-11-01'), 5);
        daily.add('m', 'a', '2026-11-02', 1);
        daily.add('m', 'a', '2026-11-02', 2);                 // two rows for one day add up
        daily.add('m', 'a', '2026-10-31', 9);                 // before the window
        daily.add('m', 'a', '2026-11-06', 9);                 // after the window
        daily.add('m', 'a', '2026-11-03', NaN);
        daily.add('m', 'a', 20261104, 1);
        daily.fill('m', 'a', '2026-10-01', '2026-11-03');
        daily.fill('m', 'b', '2026-11-04', '2026-11-02');     // an empty span adds nothing
        daily.add('q', 'a', '2026-11-05', 0.123456789);
        expect(daily.toJSON()).toEqual({ m: { a: { o: 0, v: [0, 3, 0] } }, q: { a: { o: 4, v: [0.1235] } } });
        expect(() => hub.parseReport('nothing here')).toThrow('REPORT_SHAPE');
        expect(() => hub.parseReport('window.AIHANK_REPORT = {"apps":1};')).toThrow('REPORT_SHAPE');
        expect(hub.parseReport('window.AIHANK_REPORT = {"apps":[]};').apps).toEqual([]);
        expect(() => hub.appsFromCatalog({ apps: 'x' })).toThrow('CATALOG_SHAPE');
        const [app] = hub.appsFromCatalog({ apps: [{ communityId: 'x', name: 'X', icon: 'icons/a b.png', googlePackage: 'p', googleUrl: 'ftp://x', aliases: 'one two', officialUrl: 'https://x.example/' }] });
        expect(app).toMatchObject({ icon: null, aliases: 'one two', mono: 'X', links: { official: 'https://x.example/' }, platforms: [{ key: 'android', url: null, public: false }] });
    });
});

// The page's own data layer, run against what the server above really answers.
describe('admin hub: the page reads the answer correctly', () => {
    const DAY = 86400000, TZ = 8 * 3600000;
    const dayT = iso => hub.dayIndex(iso) * DAY - TZ;
    async function loadPage({ pool, latest, opsDown, live } = {}) {
        const { routers } = mount({ pool });
        const payload = JSON.parse(JSON.stringify(await routers.data.load()));
        payload.apps.push({ id: 'weesh', slug: 'weesh', name: 'Wishlist.ai', category: '社交', platforms: [{ key: 'web', label: 'Web', public: true }], links: {} },
            { id: 'typeforge-twin-cities', slug: 'typeforge-twin-cities', name: '活字戰紀：雙城烽火', category: '遊戲', platforms: [{ key: 'android', label: 'Android', public: false }], links: {} },
            { id: 'eclawbot', slug: 'eclawbot', name: 'EClawbot', category: '工具', platforms: [{ key: 'web', label: 'Web', public: true }], links: {} },
            { id: 'dreambuddy', slug: 'dreambuddy', name: '夢話夥伴', category: 'AI', platforms: [{ key: 'ios', label: 'iOS', public: true }], links: {} });
        const ops = {
            catalog: { success: true, series: [{ id: 'wishlist.listed', group: 'wishlist', kind: 'count' }, { id: 'work.wishlist-retail.done', group: 'work', kind: 'count', worker: 'wishlist-retail', label: '完成查價的商品' },
                { id: 'work.timehut-mcode.photos', group: 'work', kind: 'count', worker: 'timehut-mcode', label: '完成比對的照片' }] },
            latest: latest || { success: true, status: { workers: [{ id: 'wishlist-retail', name: 'Wishlist 查價', health: 'healthy', processOnline: true, cpuCorePercent: 40, memoryBytes: 1 },
                { id: 'minimax-runtime', name: 'runtime', health: 'unknown', processOnline: true, cpuCorePercent: null }] },
            listing: { today: { count: 10 }, perHour24h: 120, targetPerHour: 100 }, chatPending: { pendingCount: 0 }, workTotals: { totals: {} },
            cpuFreshness: { dataFresh: true }, updatedAt: { latestStatus: new Date(NOW - 60000).toISOString() } },
        };
        const calls = [];
        const fetch = async url => {
            calls.push(url);
            const json = body => ({ ok: true, status: 200, json: async () => body });
            if (url === '/api/aihankapps/hub/data') return json(payload);
            if (url === '/api/aihankapps/hub/services' && live) return json({ success: true, checkedAt: NOW, services: live.services });
            if (opsDown) return { ok: false, status: 503, json: async () => ({}) };
            if (url === '/api/aihankapps/ops/catalog') return json(ops.catalog);
            if (url === '/api/aihankapps/ops/latest') return json(ops.latest);
            if (url.includes('step=day')) return json({ success: true, series: {
                'wishlist.listed': { kind: 'count', points: [[dayT('2026-11-08'), 30], [dayT('2026-11-09'), 50], [dayT(TODAY), 4]] },
                'work.wishlist-retail.done': { kind: 'count', points: [[dayT('2026-11-09'), 7]] }, 'work.timehut-mcode.photos': { kind: 'count', points: [[dayT('2026-11-09'), 2]] } } });
            if (url.includes('step=hour')) return json({ success: true, series: { 'wishlist.listed': { kind: 'count', points: [[NOW - 3600000, 6]] }, 'cpu.total.core': { kind: 'gauge', points: [[NOW - 3600000, 80, 90], [NOW - 3500000, 40, 50]] } } });
            throw new Error('unexpected request ' + url);
        };
        const sandbox = { window: {}, fetch, encodeURIComponent, Date: class extends Date { static now() { return NOW; } } };
        vm.runInNewContext(fs.readFileSync(path.join(pageDir, 'hub-data.js'), 'utf8'), sandbox);
        const D = sandbox.window.HubData;
        await D.load();
        return { D, calls, day: iso => hub.dayIndex(iso) };
    }

    test('apps, metric windows and totals', async () => {
        const { D, calls, day } = await loadPage();
        expect(calls.slice(0, 3)).toEqual(['/api/aihankapps/hub/data', '/api/aihankapps/ops/catalog', '/api/aihankapps/ops/latest']);
        expect(D.APPS.map(a => [a.id, a.key, a.short, a.stage])).toEqual([['alpha', 'alpha', 'Alpha', 'live'], ['beta-project', 'com.example.beta', 'Beta', 'dev'], ['gamma', 'gamma', 'Gamma', 'live'],
            ['weesh', 'weesh', 'Wishlist.ai', 'live'], ['typeforge-twin-cities', 'typeforge-twin-cities', '雙城烽火', 'dev'], ['eclawbot', 'eclawbot', 'EClawbot', 'live'], ['dreambuddy', 'dreambuddy', '夢話夥伴', 'live']]);
        expect(Array.from(D.CATS)).toEqual(['遊戲', '工具', '社交', 'AI', '其他']);
        expect(D.today).toBe(day(TODAY));
        const alpha = [D.APP.alpha], all = D.APPS;
        // each metric ends on its own last complete day: the store report lags, live counters stop at yesterday
        expect(D.metricEnd('installs')).toBe(day('2026-10-27'));       // the earlier of Google (10/27) and Apple (10/29)
        expect(D.metricEnd('revenue')).toBe(day('2026-11-01'));
        expect(D.metricEnd('intro')).toBe(day('2026-11-09'));
        expect(D.metricEnd('listed')).toBe(day('2026-11-09'));
        expect(D.metricEnd('ctr')).toBe(day('2026-11-09'));
        // count: the known days add up; unknown days are not zero
        expect(D.total('installs', all, day('2026-10-21'), day('2026-10-28'))).toBe(6);
        expect(Array.from(D.series('installs', alpha, day('2026-10-24'), 1, 4))).toEqual([null, 2, 3, 1]);
        expect(Array.from(D.platSeries('installs', alpha, 'android', day('2026-10-24'), 1, 4))).toEqual([null, 2, null, 1]);
        expect(Array.from(D.platSeries('installs', alpha, 'ios', day('2026-10-24'), 1, 4))).toEqual([null, null, 3, null]);
        expect(Array.from(D.platSeries('revenue', alpha, 'ios', day('2026-10-24'), 1, 2))).toEqual([null, null]);
        expect(D.total('installs', [D.APP.gamma], day('2026-10-21'), day('2026-10-28'))).toBeNull();
        expect(D.coverage('installs', alpha, day('2026-10-21'), day('2026-10-28'))).toEqual({ known: 3, days: 7 });
        expect(D.total('revenue', all, day('2026-10-26'), day('2026-11-02'))).toBeCloseTo(0.1235);
        // ratio: store clicks over introduction views; no views, no ratio
        expect(D.total('ctr', alpha, day('2026-11-08'), day('2026-11-10'))).toBe(25);
        expect(D.total('ctr', [D.APP.gamma], day('2026-11-08'), day('2026-11-10'))).toBeNull();
        // weekly buckets
        expect(Array.from(D.series('intro', all, day('2026-10-27'), 7, 2))).toEqual([null, 4]);
        // level: each source is averaged over the days it has, then added — EClawbot's later start does not dilute it
        expect(D.total('active', all, day('2026-11-09'), day('2026-11-11'))).toBe(1.5 + 1 + 6);      // plus the imported count for alpha, known for one of the two days
        expect(D.todayValue('eclawMessages', 'eclawbot')).toBe(7);
        expect(D.siteViews(day('2026-11-01'), day('2026-11-10'))).toBe(5);
        expect(D.rawSum('dreamTurns', 'dreambuddy', day('2026-11-01'), day('2026-11-10'))).toBe(5);
        expect(D.hasData('installs', D.APP.alpha)).toBe(true);
        expect(D.hasData('installs', D.APP.gamma)).toBe(false);
        expect(D.metricsFor(D.APP.alpha)).toEqual(['installs', 'revenue', 'intro', 'clicks', 'ctr', 'active']);
        expect(D.anyData('crashes')).toBe(false);
    });

    test('operations data joins the daily series, and only Wishlist listings carry a target', async () => {
        const { D, day } = await loadPage();
        expect(D.total('listed', D.APPS, day('2026-11-08'), day('2026-11-10'))).toBe(80);
        expect(D.total('aiwork', [D.APP.weesh], day('2026-11-09'), day('2026-11-10'))).toBe(7);
        expect(D.total('aiwork', D.APPS, day('2026-11-09'), day('2026-11-10'))).toBe(7);     // the Timehut worker has no app in this catalog
        expect(D.target('listed', D.APPS, day('2026-11-08'), day('2026-11-10'))).toBe(100 * 24 * 2);
        expect(D.target('listed', [D.APP.alpha], day('2026-11-08'), day('2026-11-10'))).toBeNull();
        expect(D.target('installs', D.APPS, day('2026-11-08'), day('2026-11-10'))).toBeNull();
        expect(D.ops.workers.map(w => [w.id, w.app])).toEqual([['wishlist-retail', 'weesh'], ['minimax-runtime', null]]);
        expect(D.ops.recent.listed.filter(v => v != null)).toEqual([6]);
        expect(D.ops.recent.cpu.filter(v => v != null)).toEqual([60]);                       // two readings in one hour: their mean
        expect(Array.from(D.bucketize([[0, 1], [10, 2], [25, 5], [99, 9]], 0, 20, 2, 'count'))).toEqual([3, 5]);
    });

    test('a previous period is compared only when every source was already recording through all of it', async () => {
        const { D, day } = await loadPage();
        expect(D.compareStart('intro')).toBe(day('2026-11-08'));
        expect(D.comparable('intro', day('2026-11-08'))).toBe(true);
        expect(D.comparable('intro', day('2026-11-07'))).toBe(false);
        expect(D.compareStart('installs')).toBe(day('2026-10-26'));       // the later of the two stores' first days
        expect(D.compareStart('ctr')).toBe(day('2026-11-08'));
        expect(D.comparable('crashes', day('2026-11-08'))).toBe(false);   // no data at all
    });

    test('alerts come from the numbers and clear with them', async () => {
        const quiet = await loadPage();
        quiet.D.computeAlerts(NOW);
        expect(quiet.D.ALERTS.map(a => a.id)).toEqual(['store-stale']);    // the fixture report is eight days old
        quiet.D.computeAlerts(Date.parse('2026-11-05T00:00:00Z'));
        expect(quiet.D.ALERTS).toEqual([]);
        expect(quiet.D.appState(quiet.D.APP.weesh)).toBe('live');
        expect(quiet.D.appState(quiet.D.APP['beta-project'])).toBe('dev');

        jest.spyOn(console, 'error').mockImplementation(() => {});
        const noisy = await loadPage({ pool: fakePool({ chat: new Error('down') }), latest: { success: true,
            status: { workers: [{ id: 'wishlist-retail', name: 'Wishlist 查價', health: 'healthy', processOnline: false }, { id: 'timehut-mcode', name: '人物比對', health: 'degraded', processOnline: true }] },
            listing: { perHour24h: 40, targetPerHour: 100 }, chatPending: { pendingCount: 2, observedAt: NOW - 1000 }, cpuFreshness: { dataFresh: false },
            updatedAt: { latestStatus: new Date(NOW - 45 * 60000).toISOString() } } });
        noisy.D.latest.rating.alpha.value = 3.2;
        noisy.D.computeAlerts(Date.parse('2026-11-05T00:00:00Z'));
        expect(noisy.D.ALERTS.map(a => [a.id, a.sev, a.app])).toEqual([['src-eclawChat', 'crit', null], ['worker-off-wishlist-retail', 'crit', 'weesh'], ['worker-bad-timehut-mcode', 'warn', 'timehut'],
            ['ops-stale', 'warn', null], ['listing-rate', 'warn', 'weesh'], ['chat-pending', 'info', 'weesh'], ['rating-alpha', 'warn', 'alpha']]);
        expect(noisy.D.appState(noisy.D.APP.weesh)).toBe('crit');
        expect(noisy.D.appState(noisy.D.APP.alpha)).toBe('warn');
        expect(noisy.D.RULES).toHaveLength(10);
    });

    test('the monitor\'s issue codes become a plain reason with its times', async () => {
        const quota = { id: 'timehut-mcode', name: '人物辨識', health: 'degraded', processOnline: true, coverage: 'between_job_heartbeat',
            issues: ['recorded_error_without_later_result', 'minimax_quota_exhausted'],
            issueDetails: [{ code: 'recorded_error_without_later_result', since: Date.UTC(2026, 10, 10, 23, 57), nextAttemptAt: null, httpStatus: null },
                { code: 'minimax_quota_exhausted', since: Date.UTC(2026, 10, 10, 23, 23), nextAttemptAt: Date.UTC(2026, 10, 11, 0, 10), httpStatus: null }] };
        const down = { id: 'wishlist-vision', name: '圖片辨識', health: 'degraded', processOnline: true, issues: ['heartbeat_or_poll_not_current', 'server_poll_failed'],
            issueDetails: [{ code: 'server_poll_failed', since: null, nextAttemptAt: null, httpStatus: 503 }] };
        const odd = { id: 'dream-buddy', name: 'Dream', health: 'degraded', processOnline: true, issues: ['something_new'] };
        const { D } = await loadPage({ latest: { success: true, status: { workers: [quota, down, odd] }, updatedAt: { latestStatus: new Date(NOW - 60000).toISOString() } } });
        expect(D.workerIssue(D.ops.workers[0])).toEqual({ code: 'minimax_quota_exhausted', label: 'MiniMax 額度用完', since: Date.UTC(2026, 10, 10, 23, 23),
            detail: 'MiniMax 回覆方案額度已用完（11/11 07:23 起）。排隊的工作留在伺服器上，worker 會在 11/11 08:10 自己再試，額度恢復後會自動補跑，不用重啟。' });
        expect(D.workerIssue(D.ops.workers[1]).detail).toBe('向工作伺服器取件時回了 503；伺服器恢復後會自動繼續。');
        expect(D.workerIssue(D.ops.workers[2])).toBeNull();
        D.computeAlerts(Date.parse('2026-11-05T00:00:00Z'));
        expect(D.ALERTS.filter(a => a.id.startsWith('worker-')).map(a => [a.id, a.sev, a.title])).toEqual([
            ['worker-bad-timehut-mcode', 'warn', '人物辨識：MiniMax 額度用完'], ['worker-bad-wishlist-vision', 'warn', '圖片辨識：伺服器回錯誤'], ['worker-bad-dream-buddy', 'warn', 'Dream 部分異常']]);
        expect(D.ALERTS.find(a => a.id === 'worker-bad-timehut-mcode').since).toBe(Date.UTC(2026, 10, 10, 23, 23));
        expect(D.ALERTS.find(a => a.id === 'worker-bad-dream-buddy').detail).toBe('程序還在，但監控的健康檢查沒有通過。');
    });

    test('a scheduled worker between its rounds is not called stopped, but a problem it reports still is', async () => {
        const between = { id: 'wishlist-retail', name: 'Wishlist 查價', health: 'unknown', processOnline: false, coverage: 'scheduled_between_rounds' };
        const { D } = await loadPage({ latest: { success: true, status: { workers: [between] }, updatedAt: { latestStatus: new Date(NOW - 60000).toISOString() } } });
        const before = Date.parse('2026-11-05T00:00:00Z');
        expect(D.betweenRounds(D.ops.workers[0])).toBe(true);
        D.computeAlerts(before);
        expect(D.ALERTS.filter(a => a.id.startsWith('worker-'))).toEqual([]);
        expect(D.appState(D.APP.weesh)).toBe('live');
        D.ops.workers[0].health = 'unhealthy';
        D.computeAlerts(before);
        expect(D.ALERTS.map(a => [a.id, a.sev])).toEqual([['worker-bad-wishlist-retail', 'warn']]);
        // a long-running worker whose process is gone is still stopped
        Object.assign(D.ops.workers[0], { health: 'unknown', coverage: 'process_only' });
        expect(D.betweenRounds(D.ops.workers[0])).toBe(false);
        D.computeAlerts(before);
        expect(D.ALERTS.map(a => [a.id, a.sev])).toEqual([['worker-off-wishlist-retail', 'crit']]);
    });

    test('service checks, imported numbers and retention reach the page, and raise alerts when they fail or go quiet', async () => {
        const live = { services: [{ id: 'eclaw', ok: true, status: 200, ms: 120, at: NOW - 30000 }, { id: 'rebound', ok: false, status: 0, ms: 10000, at: NOW - 30000 }] };
        const { D } = await loadPage({ live });
        expect(D.services.map(x => x.id)).toEqual(hubStore.SERVICES.map(x => x.id));
        expect([D.services[0].now.ok, D.services[0].now.ms, D.services[0].uptime24h, D.services[1].now]).toEqual([true, 120, 80, null]);
        expect(D.serviceFor(D.APP.eclawbot).map(x => x.id)).toEqual(['eclaw']);
        expect(D.serviceFor(D.APP['typeforge-twin-cities']).map(x => x.id)).toEqual(['summit', 'leaderboard']);
        expect(D.serviceFor(D.APP.alpha)).toEqual([]);
        expect(D.facts(D.APP.alpha)).toEqual([{ key: 'playersTotal', label: '玩家總數', value: 12, unit: '人', order: 10, source: 'rebound', observedAt: NOW - 3600000 }]);
        expect(D.retention(D.APP.alpha).cohorts).toEqual([{ start: '2026-10-05', size: 4, d1: 2, d3: 1, d7: null, d14: null, d30: null }]);
        expect([D.retention(D.APP.gamma), D.facts(D.APP.gamma)]).toEqual([null, []]);

        D.computeAlerts(Date.parse('2026-11-05T00:00:00Z'));
        expect(D.ALERTS.map(a => [a.id, a.sev, a.apps])).toEqual([['svc-down-rebound', 'crit', ['rebound']]]);
        expect(D.ALERTS[0].detail).toBe('最近一次健康檢查連不上或逾時。');
        // a day and a half after the last import the collector's numbers are called stale
        D.computeAlerts(NOW - 3600000 + 37 * 3600000);
        expect(D.ALERTS.map(a => a.id)).toEqual(['ops-stale', 'store-stale', 'svc-down-rebound', 'collector-stale-rebound']);
        expect(D.ALERTS.at(-1)).toMatchObject({ sev: 'warn', title: 'REBOUND 遊戲伺服器的數據超過一天沒更新', since: NOW - 3600000 });

        // the next refresh brings the service back, and its alert goes
        live.services = [{ id: 'rebound', ok: true, status: 200, ms: 90, at: NOW }];
        await D.refreshLive();
        D.computeAlerts(Date.parse('2026-11-05T00:00:00Z'));
        expect(D.ALERTS).toEqual([]);
        expect(D.services.find(x => x.id === 'rebound').now.ms).toBe(90);
    });

    test('when the operations API is down the rest still loads, and the sources list says what is missing', async () => {
        const { D, day } = await loadPage({ opsDown: true });
        expect(D.ops.ok).toBe(false);
        expect(D.total('installs', D.APPS, day('2026-10-21'), day('2026-10-28'))).toBe(6);
        expect(D.total('listed', D.APPS, day('2026-11-08'), day('2026-11-10'))).toBeNull();
        expect(D.ALERTS.map(a => a.id)).toContain('ops-down');
        const rows = D.sourceRows();
        expect(rows.find(r => r.name === '營運數據').state).toBe('crit');
        expect(rows.filter(r => r.state === 'ok').map(r => r.name)).toEqual(['商店報表', '作品集流量', '作品集互動', 'EClaw 帳號', 'EClaw 對話', '夢話夥伴後台', '問題回饋', 'EClaw 付款', '後台服務檢查', 'REBOUND 遊戲伺服器']);
        expect(rows.filter(r => r.state === 'none').map(r => r.name)).toEqual(['活字戰紀伺服器', 'Wishlist.ai 後台', '時光相簿伺服器', '其他 APP 的使用紀錄', '商店的內購金額']);
        expect(rows.find(r => r.name === '商店報表').note).toBe('Google 到 10/27、Apple 到 10/29、AdMob 到 11/1');
    });
});

describe('admin hub: how it is wired in', () => {
    const source = fs.readFileSync(path.join(backendDir, 'index.js'), 'utf8');

    test('the page is reserved before public tracking and static files, behind the existing admin check', () => {
        const reserved = source.indexOf("app.use('/AiHankApps/hub', aihankappsHub.privateHeaders");
        expect(reserved).toBeGreaterThan(0);
        expect(reserved).toBeLessThan(source.indexOf('app.use(sitePageviews.pageviewMiddleware())'));
        expect(reserved).toBeLessThan(source.indexOf("app.use('/AiHankApps', express.static"));
        expect(source).toContain("if (!aihankappsHubSlot.page) return res.status(503).json({ success: false, error: 'Admin hub unavailable' });");
        expect(source).toContain('const aihankappsHubRouters = aihankappsHub.createRouters({\n    authMiddleware: adminAuth, adminMiddleware: adminCheck,\n    getPool: () => chatPool, getAuthPool: () => authModule.pool, isReady: () => persistenceReady,');
        expect(source).toContain('aihankappsHubSlot.page = aihankappsHubRouters.page;');
        // the service checks run in the server, never under tests, and can be switched off
        expect(source).toContain("if (process.env.AIHANKAPPS_HUB_COLLECTOR !== '0' && process.env.NODE_ENV !== 'test') aihankappsHubRouters.probes.start();");
        expect(source).toContain("app.use('/api/aihankapps/hub', aihankappsHubRouters.api);");
        expect(source).toContain('const adminAuth = authModule.authMiddleware;');
    });

    test('the page files live outside public/, and the page loads nothing but its own listed files', () => {
        expect(fs.existsSync(path.join(backendDir, 'public', 'AiHankApps', 'hub'))).toBe(false);
        expect(fs.existsSync(path.join(backendDir, 'public', 'aihankapps-hub'))).toBe(false);
        for (const file of Object.keys(hub.PAGE_FILES)) expect(fs.existsSync(path.join(pageDir, file))).toBe(true);
        const html = fs.readFileSync(path.join(pageDir, 'index.html'), 'utf8');
        expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
        const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
        expect(scripts.map(m => /src="([^"]+)"/.exec(m[1])[1])).toEqual(['hub-data.js', 'hub-charts.js', 'hub-app.js']);
        expect(scripts.every(m => m[2] === '')).toBe(true);                               // no inline script: the policy would block it
        expect(html).not.toMatch(/\son[a-z]+\s*=/i);
        expect(html).not.toContain('<style');
        expect([...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1])).toEqual([
            'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&family=Noto+Serif+TC:wght@600;700&display=swap', 'hub.css']);
        // the page asks only its own API and the public operations API, on this origin
        const pageJs = ['hub-data.js', 'hub-app.js', 'hub-charts.js'].map(f => fs.readFileSync(path.join(pageDir, f), 'utf8')).join('\n');
        expect(pageJs).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
        expect(pageJs).not.toMatch(/\beval\(|new Function\(|document\.write\(/);
        expect(hub.CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
        expect(hub.CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
        expect(hub.CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'");
    });

    test('sign-in returns to the hub only for the exact same-origin path', () => {
        const portal = fs.readFileSync(path.join(backendDir, 'public', 'portal', 'index.html'), 'utf8');
        const redirect = portal.match(/function redirectAfterAuth\(\) \{[\s\S]*?\n        \}/)[0];
        for (const [returnTo, expected] of [['/AiHankApps/hub/', '/AiHankApps/hub/'], ['//evil.test/AiHankApps/hub/', 'dashboard.html'], ['https://evil.test/AiHankApps/hub/', 'dashboard.html'],
            ['/AiHankApps/hub/../../elsewhere', 'dashboard.html'], ['/AiHankApps/hub/?next=https://evil.test', 'dashboard.html'], ['/AiHankApps/hub', 'dashboard.html'], ['/AiHankApps/dot-progress/', '/AiHankApps/dot-progress/']]) {
            const sandbox = { localStorage: { getItem: () => null }, URLSearchParams, window: { location: { search: '?return_to=' + encodeURIComponent(returnTo) } } };
            vm.runInNewContext(redirect + '\nredirectAfterAuth();', sandbox);
            expect([returnTo, sandbox.window.location.href]).toEqual([returnTo, expected]);
        }
        expect(hub.LOGIN_URL).toBe('/portal/?return_to=' + encodeURIComponent('/AiHankApps/hub/'));
    });

    test('the portfolio shows the entry to administrators only, and adds nothing for anyone else', async () => {
        const portfolio = path.join(backendDir, 'public', 'AiHankApps');
        const html = fs.readFileSync(path.join(portfolio, 'index.html'), 'utf8');
        expect(html).toContain('<script src="hub-entry.js?v=admin-hub-20261110" defer></script>');
        expect(html).not.toContain('管理中樞');
        expect(html).not.toContain('href="hub/"');
        const code = fs.readFileSync(path.join(portfolio, 'hub-entry.js'), 'utf8');
        async function run(answer) {
            const added = [], asked = [];
            const element = tag => ({ tag, attrs: {}, style: {}, children: [], setAttribute(k, v) { this.attrs[k] = v; }, appendChild(child) { this.children.push(child); } });
            const row = { querySelector: selector => (selector === 'a' ? { style: { cssText: 'color:green' } } : added.find(a => selector === '[data-hub-entry]' && 'data-hub-entry' in a.attrs) || null),
                appendChild: node => added.push(node) };
            const sandbox = { document: { querySelector: selector => (selector === '.portfolio-shortcuts' ? row : null), createElement: element, createTextNode: text => ({ text }) },
                window: { fetch: async (url, init) => { asked.push([url, init]); if (answer instanceof Error) throw answer; return answer; } } };
            vm.runInNewContext(code, sandbox);
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setImmediate(resolve));
            return { added, asked };
        }
        const yes = await run({ ok: true, json: async () => ({ success: true, admin: true }) });
        expect(yes.asked).toEqual([['/api/aihankapps/hub/access', { credentials: 'same-origin', cache: 'no-store' }]]);
        expect(yes.added).toHaveLength(1);
        expect(yes.added[0]).toMatchObject({ tag: 'a', href: 'hub/', title: '只有管理者看得到', style: { cssText: 'color:green' } });
        expect(yes.added[0].children[0]).toEqual({ text: '管理中樞 ' });
        for (const answer of [{ ok: true, json: async () => ({ success: true, admin: false }) }, { ok: true, json: async () => ({ admin: 'true' }) }, { ok: false, json: async () => ({ admin: true }) },
            { ok: true, json: async () => null }, new Error('offline')]) {
            expect((await run(answer)).added).toEqual([]);
        }
    });
});

// Last on purpose: it uses up this process's allowance for the access question.
describe('admin hub: the access question is rate limited', () => {
    test('more than 120 questions a minute from one address are turned away', async () => {
        const { app } = mount();
        const statuses = new Set();
        let last;
        for (let i = 0; i < 130; i++) { last = await request(app).get('/api/aihankapps/hub/access'); statuses.add(last.status); }
        expect([...statuses].sort()).toEqual([200, 429]);
        expect([last.status, last.headers['retry-after'], last.body]).toEqual([429, '60', { success: false, admin: false }]);
    });
});
