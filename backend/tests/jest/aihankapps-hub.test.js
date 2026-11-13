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
        users: [{ total: 12, verified: 9, premium: 1, new7d: 1, new30d: 3 }], signups: [{ day: '2026-11-09', n: 2 }],
        chat: [{ day: '2026-11-10', messages: 7, devices: 3 }],
        dreamFirst: [{ first: '2026-11-01' }], dreamJobs: [{ day: '2026-11-09', jobs: 5, completed: 4, failed: 1, devices: 2 }], dreamAds: [{ day: '2026-11-09', n: 3 }],
        tappay: [{ day: '2026-11-09', n: 1, twd: 150 }], topups: [{ day: '2026-11-09', n: 2, twd: 180 }],
        hubDaily: [{ app_id: 'alpha', metric: 'activeUsers', day: '2026-11-08', value: 4 }, { app_id: 'alpha', metric: 'activeUsers', day: '2026-11-09', value: 6 },
            { app_id: 'alpha', metric: 'bogus', day: '2026-11-09', value: 9 }, { app_id: 'ghost', metric: 'plays', day: '2026-11-09', value: 9 }],
        hubFacts: [{ app_id: 'alpha', key: 'playersTotal', value: { label: '玩家總數', value: 12, unit: '人', order: 10 }, source: 'rebound', observed_at: new Date(NOW - 3600000) },
            { app_id: 'alpha', key: 'retention', value: { label: '留存', basis: '有玩一局', cohorts: [{ start: '2026-10-05', size: 4, d1: 2, d3: 1, d7: null, d14: null, d30: null }] }, source: 'rebound', observed_at: new Date(NOW - 3600000) },
            { app_id: 'ghost', key: 'playersTotal', value: { label: 'x', value: 1 }, source: 'rebound', observed_at: new Date(NOW) }],
        hubSources: [{ id: 'rebound', collected_at: new Date(NOW - 3600000), imported_at: new Date(NOW - 3500000), detail: { values: 2, notes: ['一則說明'] } }],
        hubInfra: [{ id: '11111111-2222-3333-4444-555555555555', source: 'railway', observed_at: new Date(NOW - 600000), value: { id: '11111111-2222-3333-4444-555555555555', name: 'api', project: 'Alpha',
            apps: ['alpha', 'ghost'], deploy: { status: 'SUCCESS', at: NOW - 86400000 }, volume: { usedMb: 300, sizeMb: 500 },
            hourly: { start: NOW - 24 * 3600000, step: 3600000, netInMb: [1.5, null], netOutMb: [4, 2], cpu: [0.01, 0.02], memMb: [100, 120] },
            daily: { start: '2026-11-08', netInMb: [10, 12], netOutMb: [40, 44], cpu: [0.01, 0.02], memMb: [100, 110] } } }],
        probesRecent: [{ service: 'eclaw', at: new Date(Math.floor(NOW / 300000) * 300000), checks: 5, failures: 1, ms_total: 400 }],
        probesDaily: [{ service: 'eclaw', day: '2026-11-10', checks: 100, failures: 5, ms_total: 9500 }, { service: 'eclaw', day: '2026-10-01', checks: 10, failures: 10, ms_total: 0 }],
        // problem reports and the alert schedule's notes (aihankapps-hub-inbox.js)
        regclass: [{ t: 'present' }], eclawFeedback: [], fraudItems: [], betaItems: [], hubFeedback: [], hubNotes: [], hubMutes: [],
        ...overrides,
    };
    const pool = { log: [], params: {}, released: 0, connected: 0, direct: [] };
    pool.query = async sql => { pool.direct.push(sql); return { rows: [] }; };
    const pick = key => { if (tables[key] instanceof Error) throw tables[key]; return { rows: tables[key] }; };
    const answer = (sql, values) => {
        if (['BEGIN READ ONLY', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SET LOCAL statement_timeout = ')) return { rows: [] };
        const key = sql.includes('to_regclass') ? 'regclass' : sql.includes('FROM aihankapps_hub_mutes') ? 'hubMutes' : sql.includes('FROM aihankapps_hub_notes') ? 'hubNotes' : sql.includes('FROM aihankapps_hub_feedback') ? 'hubFeedback'
            : sql.includes('FROM feedback') ? 'eclawFeedback' : sql.includes("comment <> ''") ? 'betaItems' : sql.includes('description, app_version') ? 'fraudItems'
            : sql.includes('MIN(day)') ? 'trafficFirst' : sql.includes('FROM app_portfolio_traffic_daily') ? 'trafficRows'
            : sql.includes('FROM app_portfolio_likes') ? 'likes' : sql.includes('FROM app_portfolio_comments') ? 'comments' : sql.includes('FROM app_portfolio_beta_feedback') ? 'beta'
                : sql.includes('FROM fraud_app_feedback_reports') ? 'feedback' : sql.includes('FROM user_accounts') && sql.includes('GROUP BY') ? 'signups' : sql.includes('FROM user_accounts') ? 'users'
                    : sql.includes('FROM chat_messages') ? 'chat' : sql.includes('MIN(quota_date)') ? 'dreamFirst' : sql.includes('FROM dream_buddy_inference_jobs') ? 'dreamJobs'
                        : sql.includes('FROM dream_buddy_ad_transactions') ? 'dreamAds' : sql.includes('FROM tappay_transactions') ? 'tappay' : sql.includes('FROM topup_orders') ? 'topups'
                            : sql.includes('FROM aihankapps_hub_daily') ? 'hubDaily' : sql.includes('FROM aihankapps_hub_facts') ? 'hubFacts' : sql.includes('FROM aihankapps_hub_sources') ? 'hubSources' : sql.includes('FROM aihankapps_hub_infra') ? 'hubInfra'
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
        getDeviceStats: options.getDeviceStats || (() => ({ devices: 4, entities: 9, boundEntities: 6 })), now: () => state.clock, fetchImpl: options.fetchImpl, fetchOps: options.fetchOps,
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
        expect(Object.values(body.sources).map(x => x.ok)).toEqual(new Array(12).fill(true));

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
        expect(body.eclaw).toEqual({ users: { total: 12, verified: 9, premium: 1, new7d: 1, new30d: 3, readAt: NOW }, devices: { total: 4, entities: 9, boundEntities: 6 } });
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

        // Railway resources: one row per service, apps outside the catalog dropped, where it came from and when
        expect(body.infra).toHaveLength(1);
        expect(body.infra[0]).toMatchObject({ name: 'api', project: 'Alpha', apps: ['alpha'], source: 'railway', observedAt: NOW - 600000, volume: { usedMb: 300, sizeMb: 500 } });
    });

    test('every database read is read-only, time-limited, and gives its connection back', async () => {
        const { app, pool } = mount();
        await as(request(app).get('/api/aihankapps/hub/data'), 'admin');
        expect(pool.connected).toBe(10);
        expect(pool.released).toBe(10);
        expect(pool.log.filter(sql => sql === 'BEGIN READ ONLY')).toHaveLength(10);
        expect(pool.log.filter(sql => sql === 'SET LOCAL statement_timeout = 8000')).toHaveLength(10);
        expect(pool.log.filter(sql => sql === 'COMMIT')).toHaveLength(10);
        expect(pool.log.join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/);
        // outside those transactions only the hub's own tables are prepared, once
        expect(pool.direct.map(sql => sql.split('(')[0].trim())).toEqual(['aihankapps_hub_probes', 'aihankapps_hub_daily', 'aihankapps_hub_facts', 'aihankapps_hub_sources', 'aihankapps_hub_infra'].map(t => 'CREATE TABLE IF NOT EXISTS ' + t)
            .concat(['CREATE TABLE IF NOT EXISTS aihankapps_hub_feedback', 'CREATE INDEX IF NOT EXISTS idx_aihankapps_hub_feedback_created ON aihankapps_hub_feedback', 'CREATE TABLE IF NOT EXISTS aihankapps_hub_notes', 'CREATE TABLE IF NOT EXISTS aihankapps_hub_mutes']));
        expect(pool.log.join('\n')).toMatch(/FROM tappay_transactions WHERE status = 'success' AND currency = 'TWD'/);
        expect(pool.log.join('\n')).toMatch(/FROM topup_orders WHERE status = 'paid' AND refunded_at IS NULL AND amount_twd > 0/);
        // nothing personal is selected: counts and days only — except the problem reports Hank asked to read as alerts
        // (2026-11-13), whose text is read by the inbox queries alone, and never with device secrets, logs, e-mail or addresses
        const isInbox = sql => /FROM (feedback|fraud_app_feedback_reports|app_portfolio_beta_feedback|aihankapps_hub_feedback|aihankapps_hub_notes)\b/.test(sql) && /ORDER BY/.test(sql);
        const inboxSql = pool.log.filter(isInbox), rest = pool.log.filter(sql => !isInbox(sql));
        expect(inboxSql).toHaveLength(6);
        expect(rest.join('\n')).not.toMatch(/SELECT \*|\b(email|device_secret|password_hash|nickname|content|description|prompt|visitor_hash|ua|referer|ip)\b|(?<!::)\btext\b/);
        expect(inboxSql.join('\n')).not.toMatch(/SELECT \*|\b(email|device_id|device_secret|password_hash|log_snapshot|device_state|debug_result|ai_diagnosis|submission_id|payload_hash|visitor_hash|ua|referer|ip)\b/);
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
        expect(ok).toEqual({ catalog: true, store: false, traffic: true, community: true, feedback: true, eclaw: true, eclawChat: false, dreambuddy: false, eclawPayments: true, imports: true, services: true, inbox: true });
        expect(res.body.sources.eclawChat).toEqual({ ok: false });            // no error text leaves the server
        expect(res.body.daily.series.googleInstalls).toBeUndefined();
        expect(res.body.daily.series.eclawMessages).toBeUndefined();
        expect(res.body.daily.series.dreamTurns).toBeUndefined();
        expect(res.body.daily.series.introViews.alpha.v).toEqual([0, 4, 0]);
        expect(res.body.eclaw).toEqual({ users: { total: 12, verified: 9, premium: 1, new7d: 1, new30d: 3, readAt: NOW }, devices: null });
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
        expect([pool.connected, chatScans()]).toEqual([10, 1]);
        state.clock = NOW + 119000;
        expect(await routers.data.load()).toBe(a);
        expect(pool.connected).toBe(10);
        const forced = await routers.data.load({ fresh: true });               // rebuilt, but the chat rows are still fresh enough
        expect(forced).not.toBe(a);
        expect([pool.connected, chatScans()]).toEqual([19, 1]);
        expect(forced.daily.series.eclawMessages.eclawbot.v.at(-1)).toBe(7);
        state.clock = NOW + 10 * 60000 + 1000;
        await routers.data.load();
        expect([pool.connected, chatScans()]).toEqual([29, 2]);
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
    async function loadPage({ pool, latest, opsDown, live, portfolioDir } = {}) {
        const { routers } = mount({ pool, portfolioDir });
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
        expect(noisy.D.RULES).toHaveLength(16);
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

    test('Railway resources reach the page: traffic joins the metrics, and full space or a failed deployment raises an alert', async () => {
        const { D, day } = await loadPage();
        expect(D.infra.map(r => [r.name, r.apps])).toEqual([['api', ['alpha']]]);
        expect(D.infraFor(D.APP.alpha).length).toBe(1);
        expect(D.infraFor(D.APP.gamma)).toEqual([]);
        expect(D.METRICS.netOut).toMatchObject({ group: '後台', fmt: 'mb', parts: ['x.netOutMb'] });
        expect(D.GROUPS).toContain('後台');
        const before = Date.parse('2026-11-05T00:00:00Z');
        D.computeAlerts(before);
        expect(D.ALERTS.filter(a => /^(space|deploy)-/.test(a.id))).toEqual([]);           // 60% used, last deployment fine
        Object.assign(D.infra[0], { volume: { usedMb: 430, sizeMb: 500 }, deploy: { status: 'FAILED', at: NOW - 600000 } });
        D.computeAlerts(before);
        const raised = D.ALERTS.filter(a => /^(space|deploy)-/.test(a.id));
        expect(raised.map(a => [a.id.split('-')[0], a.sev, a.title, a.apps])).toEqual([['space', 'warn', 'Alpha api 的空間用了 86%', ['alpha']], ['deploy', 'crit', 'Alpha api 部署失敗', ['alpha']]]);
        expect(raised[0].detail).toBe('已用 430 MB，上限 500 MB；滿了之後這個服務會寫不進去，要清理資料或在 Railway 加大空間。');
        D.infra[0].volume = { usedMb: 4900, sizeMb: 5000 };
        D.computeAlerts(before);
        expect(D.ALERTS.find(a => a.id.startsWith('space-'))).toMatchObject({ sev: 'crit', title: 'Alpha api 的空間用了 98%' });
        expect(D.appState(D.APP.alpha)).toBe('crit');
        void day;
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

    // 需要人為介入 (Hank, 2026-11-12): what the listing schedules cannot fix themselves.
    const board = items => ({ label: '需要人為介入', value: items.filter(x => x.kind === 'human').length, unit: '件', order: 5, boardAt: NOW - 60000, healing: items.filter(x => x.kind === 'healing').length, items });
    test('one severe alert per problem that needs a person; what a schedule is still healing raises nothing; a cleared board clears the alert', async () => {
        const page = await loadPage();
        const at = Date.parse('2026-11-05T00:00:00Z');
        page.D.latest.facts.weesh = { ...(page.D.latest.facts.weesh || {}), attention: board([
            { id: 'shopee-verification', kind: 'human', platform: 'shopee', title: '蝦皮需要手動通過驗證', detail: '請在 Chrome 開 shopee.tw 通過一次。', since: Date.parse('2026-11-04T16:00:00Z'), count: 3 },
            { id: 'fb-hard-posts', kind: 'healing', platform: 'fb', title: 'FB 多件清單待處理', detail: '', since: Date.parse('2026-11-04T18:00:00Z'), count: 1 }]) };
        page.D.computeAlerts(at);
        expect(page.D.ALERTS.map(a => [a.id, a.sev, a.app, a.ref, a.rule])).toEqual([['attention-shopee-verification', 'crit', 'weesh', 'attention-shopee-verification@20261105-0000', '需要人為介入']]);
        expect(page.D.ALERTS[0].title).toBe('需要人為介入：蝦皮需要手動通過驗證');
        expect(page.D.ALERTS[0].detail).toBe('請在 Chrome 開 shopee.tw 通過一次。（已回報 3 次）');
        expect(page.D.ALERTS[0].basis).toMatchObject({ id: 'shopee-verification', platform: 'shopee', count: 3 });
        expect(page.D.appState(page.D.APP.weesh)).toBe('crit');
        expect(page.D.RULES[12]).toEqual(['需要人為介入', 'Wishlist.ai 上架排程', expect.stringMatching(/自己解不了/), 'crit']);
        page.D.latest.facts.weesh.attention = board([]);
        page.D.computeAlerts(at);
        expect(page.D.ALERTS).toEqual([]);
    });

    // 問題回饋與排程判斷 (Hank, 2026-11-13): every recent report is an alert until the alert schedule closes it; the
    // schedule's note rides on each alert, and what only Hank can do becomes a severe alert that says what to do.
    test('reports become alerts, the schedule\'s notes ride on them, and what needs Hank is severe and says what to do', async () => {
        const t = iso => new Date(iso);
        const pool = fakePool({
            eclawFeedback: [{ id: 41, message: 'App 開不起來\n一直轉圈', category: 'bug', app_version: '1.2.3', source: 'android', created_at: String(Date.parse('2026-11-09T01:00:00Z')) }],
            fraudItems: [{ id: '11111111-1111-4111-8111-111111111111', category: 'balance', description: '第三關太難', app_version: '0.9 (21)', screen: 'stage3', created_at: t('2026-11-09T02:00:00Z') }],
            betaItems: [{ id: '7', app_id: 'alpha', rating: 2, continuation: 'maybe', comment: '', app_version: '1.0', platform: 'android', created_at: t('2026-11-09T03:00:00Z') },
                { id: '8', app_id: 'ghost', rating: 1, continuation: 'no', comment: 'not in the catalog', app_version: '1.0', platform: 'web', created_at: t('2026-11-09T03:30:00Z') }],
            hubFeedback: [{ source: 'timehut-line', ext_id: 'L1', app_id: 'alpha', channel: 'line', category: 'upload', message: '照片傳不上去', version: null, reporter: null, has_image: false, created_at: t('2026-11-09T04:00:00Z') }],
            hubNotes: [
                { ref: 'fb-fraud-11111111-1111-4111-8111-111111111111', app_id: null, state: 'done', title: null, note: '已記錄平衡調整', ask: null, standalone: false, by_who: 'schedule', created_at: t('2026-11-09T05:00:00Z'), updated_at: t('2026-11-09T05:00:00Z') },
                { ref: 'fb-beta-7', app_id: 'alpha', state: 'auto', title: null, note: '沒有文字的低分評價，已記下', ask: null, standalone: false, by_who: 'schedule', created_at: t('2026-11-09T05:00:00Z'), updated_at: t('2026-11-09T05:00:00Z') },
                { ref: 'fb-timehut-line-L1', app_id: 'alpha', state: 'human', title: '拾光上傳失敗要修', note: '看起來是伺服器擋下大檔', ask: '請決定要不要開 session 修上傳上限', standalone: false, by_who: 'schedule', created_at: t('2026-11-09T05:00:00Z'), updated_at: t('2026-11-09T06:00:00Z') },
                { ref: 'human-line-quota', app_id: 'alpha', state: 'human', title: 'LINE 推播額度快用完', note: '本月已用 70%', ask: '請決定是否升級 LINE 方案', standalone: true, by_who: 'schedule', created_at: t('2026-11-09T07:00:00Z'), updated_at: t('2026-11-09T07:00:00Z') },
                { ref: 'rating-alpha', app_id: 'alpha', state: 'human', title: 'Alpha 評分偏低', note: '最近兩則一星評論都在說同一個錯誤', ask: '請看評論決定要不要回覆', standalone: false, by_who: 'schedule', created_at: t('2026-11-09T07:00:00Z'), updated_at: t('2026-11-09T07:00:00Z') }],
        });
        const dir = portfolioFixture(), file = path.join(dir, 'app-catalog.json'), catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
        catalog.apps.push({ name: 'EClawbot', communityId: 'eclawbot', webUrl: 'https://eclawbot.com/' });
        fs.writeFileSync(file, JSON.stringify(catalog));
        const page = await loadPage({ pool, portfolioDir: dir });
        page.D.latest.rating.alpha.value = 3.2;
        page.D.computeAlerts(Date.parse('2026-11-10T00:00:00Z'));
        const by = Object.fromEntries(page.D.ALERTS.map(a => [a.ref, a]));
        // the closed report is gone; the one from an app outside the catalog never arrives
        expect(by['fb-fraud-11111111-1111-4111-8111-111111111111']).toBeUndefined();
        expect(Object.keys(by).filter(r => r.startsWith('fb-'))).toEqual(['fb-timehut-line-L1', 'fb-beta-7', 'fb-eclaw-41']);
        // not looked at yet: a warning with the report's own words
        expect(by['fb-eclaw-41']).toMatchObject({ id: 'feedback-eclaw', sev: 'warn', app: 'eclawbot', title: 'EClawbot 問題回饋：APP 內回報・錯誤', detail: 'App 開不起來 一直轉圈', quote: 'App 開不起來\n一直轉圈', triage: null, rule: '新的問題回饋' });
        expect(by['fb-eclaw-41'].basis).toMatchObject({ source: 'eclaw', version: '1.2.3', channel: 'android' });
        // being handled: information, with the schedule's note
        expect(by['fb-beta-7']).toMatchObject({ sev: 'info', title: 'Alpha 問題回饋：作品集內測回饋・2 星', detail: '（沒有文字）', triage: { state: 'auto', label: '排程處理中', note: '沒有文字的低分評價，已記下' } });
        // needs Hank: severe, says what to do, keeps the report
        expect(by['fb-timehut-line-L1']).toMatchObject({ sev: 'crit', title: '需要你處理：拾光上傳失敗要修', detail: '請決定要不要開 session 修上傳上限', ask: '請決定要不要開 session 修上傳上限', quote: '照片傳不上去', triage: { state: 'human' } });
        // a computed alert the schedule says only Hank can clear is escalated in place, not duplicated
        expect(by['rating-alpha']).toMatchObject({ id: 'rating-alpha', sev: 'crit', title: '需要你處理：Alpha 評分偏低', ask: '請看評論決定要不要回覆', triage: { state: 'human', note: '最近兩則一星評論都在說同一個錯誤' } });
        expect(page.D.ALERTS.filter(a => a.ref === 'rating-alpha')).toHaveLength(1);
        // a problem the schedule found that no rule shows
        expect(by['human-line-quota']).toMatchObject({ id: 'human', sev: 'crit', title: '需要你處理：LINE 推播額度快用完', ask: '請決定是否升級 LINE 方案', rule: '排程請你處理', app: 'alpha' });
        expect(page.D.RULES.slice(13).map(r => [r[0], r[3]])).toEqual([['新的問題回饋', 'warn'], ['排程請你處理', 'crit'], ['已略過的類似警告', 'info']]);
        // once the schedule closes the escalation, it is gone
        // the page lists what needs Hank first, then severe, warning, information
        expect(page.D.byUrgency(page.D.ALERTS).slice(0, 3).map(a => a.ref)).toEqual(['rating-alpha', 'fb-timehut-line-L1', 'human-line-quota']);
        expect(page.D.byUrgency(page.D.ALERTS).at(-1).sev).toBe('info');
        page.D.inbox.notes = page.D.inbox.notes.filter(n => n.ref !== 'human-line-quota');
        page.D.computeAlerts(Date.parse('2026-11-10T00:00:00Z'));
        expect(page.D.ALERTS.map(a => a.ref)).not.toContain('human-line-quota');
    });

    test('the alerts answer carries the schedule\'s decision, the report\'s words and what Hank is asked to do', async () => {
        const pool = fakePool({ hubFeedback: [{ source: 'timehut-app', ext_id: 'A1', app_id: 'alpha', channel: 'android-play', category: null, message: '閃退', version: '1.0.18', reporter: '小…明', has_image: true, created_at: new Date('2026-11-09T04:00:00Z') }],
            hubNotes: [{ ref: 'fb-timehut-app-A1', app_id: 'alpha', state: 'auto', title: null, note: '已確認是 1.0.17 的已知問題，1.0.18 修好', ask: null, standalone: false, by_who: 'schedule', created_at: new Date('2026-11-09T05:00:00Z'), updated_at: new Date('2026-11-09T05:00:00Z') }] });
        const { routers } = mount({ pool });
        const answer = await routers.alerts.load({ fresh: true });
        const a = answer.alerts.find(x => x.id === 'fb-timehut-app-A1');
        expect(a).toMatchObject({ type: 'feedback-timehut-app', severity: 'info', quote: '閃退', ask: null, triage: { state: 'auto', note: '已確認是 1.0.17 的已知問題，1.0.18 修好' } });
        expect(a.basis).toMatchObject({ hasImage: true, version: '1.0.18', channel: 'android-play' });
    });

    // 以後略過類似警告 (Hank, 2026-11-13): a muted kind folds into one information item that stays, even with no members.
    test('a muted kind folds into one information item; the app page lists the alerts behind the sidebar dot', async () => {
        const pool = fakePool({ hubMutes: [{ type: 'rating-alpha', label: 'Alpha 的評分偏低', sample_ref: 'rating-alpha', created_at: new Date('2026-11-09T00:00:00Z') },
            { type: 'collector-stale-summit', label: '活字戰紀伺服器的數據超過一天沒更新', sample_ref: null, created_at: new Date('2026-11-09T01:00:00Z') }],
        hubNotes: [{ ref: 'human-line-quota', app_id: 'alpha', state: 'human', title: 'LINE 推播額度快用完', note: '已用 70%', ask: '請決定是否升級方案', standalone: true, by_who: 'schedule', created_at: new Date('2026-11-09T07:00:00Z'), updated_at: new Date('2026-11-09T07:00:00Z') }] });
        const page = await loadPage({ pool });
        page.D.latest.rating.alpha.value = 3.2;
        page.D.computeAlerts(Date.parse('2026-11-05T00:00:00Z'));
        const by = Object.fromEntries(page.D.ALERTS.map(a => [a.ref, a]));
        expect(by['rating-alpha']).toBeUndefined();
        expect(by['muted-rating-alpha']).toMatchObject({ id: 'muted', sev: 'info', title: '已略過：Alpha 的評分偏低（目前 1 件）', rule: '已略過的類似警告', app: 'alpha' });
        expect(by['muted-rating-alpha'].muted.members.map(m => m.ref)).toEqual(['rating-alpha']);
        // a mute with nothing in it right now stays, so it can be undone
        expect(by['muted-collector-stale-summit']).toMatchObject({ sev: 'info', title: '已略過：活字戰紀伺服器的數據超過一天沒更新（目前 0 件）', basis: { count: 0, members: [] } });
        // the schedule's own asks and people's reports are never folded
        expect(page.D.mutable({ id: 'human' })).toBe(false);
        expect(['feedback-eclaw', 'feedback-fraud', 'feedback-beta', 'feedback-timehut-app', 'feedback-timehut-line'].map(id => page.D.mutable({ id }))).toEqual([false, false, false, false, false]);
        expect(page.D.mutable({ id: 'feedback-eclaw-health' })).toBe(true);
        expect(by['human-line-quota']).toMatchObject({ sev: 'crit' });
        // what colours Alpha in the sidebar is what its page lists; an information fold alone does not colour it
        expect(page.D.alertsFor(page.D.APP.alpha).map(a => a.ref).sort()).toEqual(['human-line-quota', 'muted-rating-alpha']);
        expect(page.D.appState(page.D.APP.alpha)).toBe('crit');
        page.D.inbox.notes = [];
        page.D.computeAlerts(Date.parse('2026-11-05T00:00:00Z'));
        expect(page.D.appState(page.D.APP.alpha)).toBe('live');
        // undoing the mute brings the alert back on its own
        page.D.inbox.mutes = [];
        page.D.computeAlerts(Date.parse('2026-11-05T00:00:00Z'));
        expect(page.D.ALERTS.map(a => a.ref)).toContain('rating-alpha');
    });

    test('when the operations API is down the rest still loads, and the sources list says what is missing', async () => {
        const { D, day } = await loadPage({ opsDown: true });
        expect(D.ops.ok).toBe(false);
        expect(D.total('installs', D.APPS, day('2026-10-21'), day('2026-10-28'))).toBe(6);
        expect(D.total('listed', D.APPS, day('2026-11-08'), day('2026-11-10'))).toBeNull();
        expect(D.ALERTS.map(a => a.id)).toContain('ops-down');
        const rows = D.sourceRows();
        expect(rows.find(r => r.name === '營運數據').state).toBe('crit');
        expect(rows.filter(r => r.state === 'ok').map(r => r.name)).toEqual(['商店報表', '作品集流量', '作品集互動', 'EClaw 帳號', 'EClaw 對話', '夢話夥伴後台', '問題回饋', '問題回饋與排程判斷', 'EClaw 付款', '後台服務檢查', 'REBOUND 遊戲伺服器']);
        expect(rows.filter(r => r.state === 'none').map(r => r.name)).toEqual(['活字戰紀伺服器', 'Wishlist.ai 後台', 'Wishlist.ai 帳戶明細', 'Railway 後台資源', '時光相簿伺服器', '上架警示板', '拾光 APP 內問題回饋', '拾光 LINE 問題回饋', '其他 APP 的使用紀錄', '商店的內購金額']);
        // the per-account source says how often it runs and, once imported, exactly what it carries (not "counts only")
        expect(rows.find(r => r.name === 'Wishlist.ai 帳戶明細')).toMatchObject({ freq: '每小時', cover: 'Wishlist.ai', note: '還沒有匯入過' });
        expect(rows.find(r => r.name === '商店報表').note).toBe('Google 到 10/27、Apple 到 10/29、AdMob 到 11/1');
    });
});

describe('admin hub: account sign-ups per app', () => {
    function portfolioWithAccounts() {
        const dir = portfolioFixture(), file = path.join(dir, 'app-catalog.json'), catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
        catalog.apps.push({ name: 'EClawbot', communityId: 'eclawbot', webUrl: 'https://eclawbot.com/' }, { name: 'Wishlist.ai', communityId: 'weesh', webUrl: 'https://example.com/' },
            { name: '時光相簿', communityId: 'timehut', webUrl: 'https://example.com/t' });
        fs.writeFileSync(file, JSON.stringify(catalog));
        return dir;
    }
    test('apps with accounts get counts only; an app without a reader says so; the rest have no account feature', async () => {
        const pool = fakePool({ hubFacts: [{ app_id: 'weesh', key: 'usersTotal', value: { label: '註冊帳號總數', value: 40, unit: '個' }, source: 'wishlist', observed_at: new Date(NOW - 7200000) },
            { app_id: 'weesh', key: 'accountsNew7d', value: { label: '近 7 天', value: 2, unit: '個' }, source: 'wishlist', observed_at: new Date(NOW - 7200000) },
            { app_id: 'timehut', key: 'accountsTotal', value: { label: '註冊帳號總數', value: 9, unit: '個' }, source: 'timehut', observed_at: new Date(NOW - 3600000) },
            { app_id: 'timehut', key: 'accountsNew7d', value: { label: '近 7 天', value: 1, unit: '個' }, source: 'timehut', observed_at: new Date(NOW - 3600000) },
            { app_id: 'timehut', key: 'accountsNew30d', value: { label: '近 30 天', value: 4, unit: '個' }, source: 'timehut', observed_at: new Date(NOW - 3600000) }] });
        const { app } = mount({ pool, portfolioDir: portfolioWithAccounts() });
        expect((await request(app).get('/api/aihankapps/hub/accounts')).status).toBe(401);
        expect((await as(request(app).get('/api/aihankapps/hub/accounts'), 'member')).status).toBe(403);
        const res = await as(request(app).get('/api/aihankapps/hub/accounts'), 'admin');
        expect(res.status).toBe(200);
        const by = Object.fromEntries(res.body.accounts.map(r => [r.app, r]));
        expect([by.eclawbot.status, by.eclawbot.total, by.eclawbot.new7d, by.eclawbot.new30d, by.eclawbot.observedAt]).toEqual(['connected', 12, 1, 3, NOW]);
        expect([by.weesh.status, by.weesh.total, by.weesh.new7d, by.weesh.new30d, by.weesh.observedAt]).toEqual(['connected', 40, 2, null, NOW - 7200000]);
        expect([by.timehut.status, by.timehut.total, by.timehut.new7d, by.timehut.new30d, by.timehut.observedAt]).toEqual(['connected', 9, 1, 4, NOW - 3600000]);
        expect(by.timehut.source).toMatch(/只回數字/);
        expect(hub.ACCOUNT_APPS.filter(r => r.status === 'not_connected')).toEqual([]);
        expect([by.alpha.status, by.alpha.total, by.alpha.note]).toEqual(['none', null, '這款 APP 沒有帳號註冊功能。']);
        expect(hub.ACCOUNT_APPS.find(r => r.app === 'vibe-empire').status).toBe('unknown');
        expect(hub.ACCOUNT_APPS.find(r => r.app === 'rebound').note).toMatch(/訪客帳號/);
        // the same rows travel with the page's data answer; nothing but counts
        const data = await as(request(app).get('/api/aihankapps/hub/data'), 'admin');
        expect(data.body.accounts).toEqual(res.body.accounts);
        expect(Object.keys(by.eclawbot).sort()).toEqual(['app', 'name', 'new30d', 'new7d', 'note', 'observedAt', 'source', 'status', 'total']);
    });
});

describe('admin hub: notification IDs and the alert lookup', () => {
    const worker = (id, extra) => ({ id, name: id === 'timehut-mcode' ? '時光相簿人物／影片辨識' : id, processOnline: true, coverage: 'between_job_heartbeat', ...extra });
    const opsWith = workers => async url => ({ ok: true, status: 200, json: async () => (url.endsWith('/latest')
        ? { success: true, status: { workers }, listing: null, chatPending: { pendingCount: 0 }, workTotals: { totals: {} }, cpuFreshness: { dataFresh: true }, updatedAt: { latestStatus: new Date(NOW - 60000).toISOString() } }
        : { success: true, series: [] }) });
    test('every alert has a stable ID, and an administrator can look it up with its source, rule and raw values', async () => {
        const down = worker('timehut-mcode', { health: 'degraded', lastPollAt: NOW - 30000, lastPollStatus: 503, lastErrorAt: NOW - 30000, recordedErrorKind: 'poll',
            issues: ['heartbeat_or_poll_not_current', 'server_poll_failed', 'recorded_error_without_later_result'],
            issueDetails: [{ code: 'heartbeat_or_poll_not_current', since: NOW - 30000 }, { code: 'server_poll_failed', since: NOW - 30000, httpStatus: 503 }, { code: 'recorded_error_without_later_result', since: NOW - 30000 }] });
        const asked = [];
        const fetchOps = async url => { asked.push(url); return opsWith([down])(url); };
        const { app } = mount({ fetchOps });
        expect((await request(app).get('/api/aihankapps/hub/alerts')).status).toBe(401);
        expect((await as(request(app).get('/api/aihankapps/hub/alerts/store-stale'), 'member')).status).toBe(403);
        const list = await as(request(app).get('/api/aihankapps/hub/alerts'), 'admin');
        expect(list.status).toBe(200);
        expect(list.body.alerts.map(a => a.id)).toEqual(['worker-bad-timehut-mcode.server_poll_failed', 'store-stale@20261102-1639']);
        expect(asked.sort()).toEqual(['/api/aihankapps/ops/catalog', '/api/aihankapps/ops/latest']);   // nothing else is fetched
        const one = await as(request(app).get('/api/aihankapps/hub/alerts/worker-bad-timehut-mcode.server_poll_failed'), 'admin');
        expect(one.status).toBe(200);
        expect(one.body.matchedBy).toBe('id');
        expect(one.body.alert).toMatchObject({ type: 'worker-bad-timehut-mcode', severity: 'warn', title: '時光相簿人物／影片辨識：伺服器回錯誤', rule: 'worker 狀態異常',
            condition: '監控回報「異常」或「部分異常」', app: 'timehut', since: NOW - 30000, sinceTaipei: '2026-11-10 20:59 (Asia/Taipei)' });
        expect(one.body.alert.source).toMatch(/MiniMax worker 監控/);
        expect(one.body.alert.basis).toMatchObject({ workerId: 'timehut-mcode', lastPollStatus: 503, lastErrorAt: NOW - 30000, recordedErrorKind: 'poll' });
        expect(one.body.alert.basisTaipei.lastPollAt).toBe('2026-11-10 20:59 (Asia/Taipei)');
        // an older ID of the same alert type still finds it, and says so; an unknown one lists what is active
        const older = await as(request(app).get('/api/aihankapps/hub/alerts/worker-bad-timehut-mcode.item_processing_failed'), 'admin');
        expect([older.status, older.body.matchedBy, older.body.alert.id]).toEqual([200, 'type', 'worker-bad-timehut-mcode.server_poll_failed']);
        const gone = await as(request(app).get('/api/aihankapps/hub/alerts/ops-stale'), 'admin');
        expect([gone.status, gone.body.activeIds]).toEqual([404, ['worker-bad-timehut-mcode.server_poll_failed', 'store-stale@20261102-1639']]);
        expect((await as(request(app).get('/api/aihankapps/hub/alerts/' + encodeURIComponent('a b<')), 'admin')).status).toBe(400);
    });
    test('a worker the monitor reports healthy again raises no alert', async () => {
        const healed = worker('timehut-mcode', { health: 'healthy', lastPollAt: NOW - 30000, lastPollStatus: 200, lastErrorAt: NOW - 26 * 60000, recordedErrorKind: 'poll', issues: [], issueDetails: [] });
        const { app } = mount({ fetchOps: opsWith([healed]) });
        const list = await as(request(app).get('/api/aihankapps/hub/alerts'), 'admin');
        expect(list.body.alerts.map(a => a.id)).toEqual(['store-stale@20261102-1639']);
    });
    test('the operator script computes the same alerts from inside the container, with one fresh check per service', async () => {
        const script = require('../../scripts/aihankapps-hub-alerts');
        const probed = [];
        const answer = await script.compute({ pool: fakePool(), now: () => NOW, fetchOps: opsWith([]), portfolioDir: portfolioFixture(),
            services: [{ id: 'rebound', name: 'REBOUND 遊戲伺服器', apps: [], url: 'https://example.invalid/health' }],
            probe: async service => { probed.push(service.id); return { ok: false, status: 503, ms: 12, at: NOW }; } });
        expect(probed).toEqual(['rebound']);
        const ids = answer.alerts.map(a => a.id);
        expect(ids).toContain('store-stale@20261102-1639');                 // the same alert, with the same ID, as the admin API gives
        expect(answer.alerts.find(a => a.type === 'svc-down-rebound')).toMatchObject({ severity: 'crit', rule: '後台服務沒有回應' });
        expect(answer.computedAt).toBe(NOW);
    });
    test('the page shows each ID with a copy button', () => {
        const app = fs.readFileSync(path.join(pageDir, 'hub-app.js'), 'utf8');
        expect(app).toMatch(/通知 ID/);
        expect(app).toMatch(/data-act="al-copy"/);
        expect(app).toMatch(/'al-copy': v => copyText\(v, '已複製通知 ID：' \+ v/);
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
        expect(scripts.map(m => /src="([^"]+)"/.exec(m[1])[1])).toEqual(['hub-data.js', 'hub-charts.js', 'hub-timehut.js', 'hub-weesh.js', 'hub-app.js']);
        expect(scripts.every(m => m[2] === '')).toBe(true);                               // no inline script: the policy would block it
        expect(html).not.toMatch(/\son[a-z]+\s*=/i);
        expect(html).not.toContain('<style');
        expect([...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1])).toEqual([
            'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&family=Noto+Serif+TC:wght@600;700&display=swap', 'hub.css']);
        // the page asks only its own API and the public operations API, on this origin
        const pageJs = ['hub-data.js', 'hub-app.js', 'hub-charts.js', 'hub-timehut.js', 'hub-weesh.js'].map(f => fs.readFileSync(path.join(pageDir, f), 'utf8')).join('\n');
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

    test('the portfolio shows the entry to everyone; the page itself decides who gets in', async () => {
        const portfolio = path.join(backendDir, 'public', 'AiHankApps');
        const html = fs.readFileSync(path.join(portfolio, 'index.html'), 'utf8');
        const shortcuts = html.slice(html.indexOf('<div class="portfolio-shortcuts"'), html.indexOf('</div>', html.indexOf('<div class="portfolio-shortcuts"')));
        expect(shortcuts).toMatch(/<a\s+href="hub\/"[^>]*aria-label="開啟管理中樞（需要管理者帳號）"[^>]*>管理中樞 <span aria-hidden="true">↗<\/span><\/a>/);
        expect(html).not.toContain('hub-entry.js');
        expect(fs.existsSync(path.join(portfolio, 'hub-entry.js'))).toBe(false);
        // following it without signing in leads to the sign-in page, which comes back here
        const { app } = mount();
        const res = await browser(request(app).get('/AiHankApps/hub/'));
        expect([res.status, res.headers.location]).toEqual([302, hub.LOGIN_URL]);
        expect(hub.LOGIN_URL).toBe('/portal/?return_to=%2FAiHankApps%2Fhub%2F');
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

describe('admin hub: 拾光 user detail (hub-timehut.js)', () => {
    const load = () => { const sandbox = { window: {}, localStorage: { getItem: () => null, setItem: () => {} }, Intl, Date, Math, JSON, Object, Array, Number, String, Set }; vm.runInNewContext(fs.readFileSync(path.join(pageDir, 'hub-timehut.js'), 'utf8'), sandbox); return sandbox.window.HubTimehut; };
    const HOUR = 3600000, DAY = 24 * HOUR;
    const user = (ref, name, extra = {}) => Object.assign({ ref, v: 1, name, login: 'ab…c', owner: false, lastLoginAt: Date.now() - HOUR, albums: [], media: { albums: 1, photos: 3, videos: 1 }, history: { appUploadBytes: 10, lineReceivedBytes: 20 },
        line: { received: 0, stages: {}, reasons: {}, days: [] }, uploads: null, ai: null, traffic: null }, extra);
    test('facts become users; only thUser + 10 hex keys with v 1 count, the meta fact is kept apart', () => {
        const T = load();
        const d = T.fromFacts({ accountsTotal: { label: 'x', value: 3 }, thUsersMeta: { v: 1, users: 2 }, thUserabcdef0123: { v: 1, name: 'A' }, thUserXYZ: { v: 1, name: 'bad' }, thUser0123456789: { v: 2, name: 'old' } });
        expect(d.users.map(u => [u.ref, u.name])).toEqual([['abcdef0123', 'A']]);
        expect(d.meta).toEqual({ v: 1, users: 2 });
    });
    test('insights: long waits and failures first, with plain reasons and hints; traffic share; quiet when nothing is wrong', () => {
        const T = load();
        const a = user('aaaaaaaaaa', '小屋', { owner: true, line: { received: 20, recognized: 15, stages: { uploaded: 10, excluded: 3, recognition_queued: 3, failed: 2, blocked: 2 }, reasons: { IMPORT_FAILED: 2, MATCH_NOT_CONFIGURED: 2 }, oldestWaitingAt: Date.now() - 2 * DAY, days: [] },
            traffic: { days: [['2026-11-12', 1, 900, 800]] } });
        const b = user('bbbbbbbbbb', '阿嬤', { line: { received: 10, stages: { excluded: 8, uploaded: 2 }, reasons: { MATCH_NO_PERSON: 8 }, days: [] }, traffic: { days: [['2026-11-12', 1, 100, 50]] }, lastLoginAt: Date.now() - 40 * DAY });
        const list = T.insights([a, b], { trafficSince: new Date(Date.now() - 2 * DAY).toISOString(), dropped: 1 });
        const text = list.map(x => x.sev + ' ' + x.text);
        expect(list[0]).toMatchObject({ sev: 'crit', user: 'aaaaaaaaaa' });
        expect(text.some(x => /^crit 小屋 有 2 張處理失敗，主要是「匯入相簿失敗」/.test(x))).toBe(true);
        expect(text.some(x => /^warn 小屋 有 2 張卡住：照片所在的相簿沒開人物辨識/.test(x))).toBe(true);
        expect(text.some(x => /^info 阿嬤 有 80% 的 LINE 照片被判定不是參考對象/.test(x))).toBe(true);
        expect(text.some(x => /最多的是 小屋（900 B，占 90%）/.test(x))).toBe(true);
        expect(text.some(x => /流量從 .* 開始記錄/.test(x))).toBe(true);
        expect(text.some(x => /^info 阿嬤 已經 40 天沒有登入/.test(x))).toBe(true);
        expect(text.some(x => /略過了 1 位/.test(x))).toBe(true);
        const calm = T.insights([user('cccccccccc', '王', { line: { received: 4, stages: { uploaded: 4 }, reasons: { UPLOAD_COMPLETED: 4 }, days: [] } })], {});
        expect(calm.map(x => x.sev)).toEqual(['ok']);
    });
    test('names and album titles are escaped; an empty detail explains where it comes from', () => {
        const T = load();
        const el = { innerHTML: '', querySelector: () => null, contains: () => true };
        T.mount(el, { meta: { asOf: new Date().toISOString(), notes: [] }, users: [user('dddddddddd', '<img src=x onerror=alert(1)>', { albums: [['<b>相簿</b>', 'a', 1, 0, 0]] })] });
        expect(el.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(el.innerHTML).not.toContain('<img src=x');
        expect(el.innerHTML).toContain('用戶明細');
        const empty = { innerHTML: '' };
        T.mount(empty, { meta: null, users: [] });
        expect(empty.innerHTML).toMatch(/1\.0\.118 起提供/);
        expect(T.bytes(1536)).toBe('1.50 KB');
        expect(T.bytes(null)).toBe('—');
    });
    test('no login time: falls back to the last day with traffic, never claims "no login"; the funnel is counted from stages', () => {
        const today = new Date(Date.now() + 8 * HOUR).toISOString().slice(0, 10);
        const open = ref => { const sandbox = { window: {}, localStorage: { getItem: k => (k === 'hub.th.open' ? JSON.stringify(ref) : null), setItem: () => {} }, Intl, Date, Math, JSON, Object, Array, Number, String, Set }; vm.runInNewContext(fs.readFileSync(path.join(pageDir, 'hub-timehut.js'), 'utf8'), sandbox); return sandbox.window.HubTimehut; };
        // 較早的照片沒有「辨識完成」標記：recognized 3，但併入 5＋排除 4
        const u = user('eeeeeeeeee', '小屋', { lastLoginAt: null, line: { received: 12, recognized: 3, stages: { uploaded: 5, excluded: 4, recognized: 1, unknown: 2 }, reasons: {}, days: [] },
            traffic: { inBytes: 1, outBytes: 2, mediaOutBytes: 0, uploadInBytes: 0, requests: 3, days: [[today, 1, 2, 0]] } });
        const quiet = user('ffffffffff', '阿嬤', { lastLoginAt: null });
        const el = { innerHTML: '', querySelector: () => null, contains: () => true };
        open('eeeeeeeeee').mount(el, { meta: { asOf: new Date().toISOString(), notes: [] }, users: [u, quiet] });
        expect(el.innerHTML).not.toContain('沒有登入紀錄');
        expect(el.innerHTML).toContain('最近使用 今天');
        expect(el.innerHTML).toMatch(/辨識有結果<\/span>.*?<b>10<\/b><em>83%<\/em>/);
        expect(el.innerHTML).not.toContain('完成辨識');
        expect(el.innerHTML).toContain('不明／已停止');
        expect(load().enrich(u).activeDay).toBe(today);
        expect(load().enrich(quiet).activeDay).toBe(null);
    });
    test('QA accounts: recognised by name or login (never the owner), tagged, hidden on request with the numbers, and markable by hand', () => {
        const saved = {};
        const sandbox = { window: {}, localStorage: { getItem: k => (k in saved ? saved[k] : null), setItem: (k, v) => { saved[k] = v; } }, Intl, Date, Math, JSON, Object, Array, Number, String, Set };
        vm.runInNewContext(fs.readFileSync(path.join(pageDir, 'hub-timehut.js'), 'utf8'), sandbox);
        const T = sandbox.window.HubTimehut;
        expect([{ name: '人工驗收 a', login: 'ab…c' }, { name: '商店審查示範帳戶', login: 're…6' }, { name: 'Tom', login: 'qa…b' }, { name: 'E2E run', login: 'ab…c' }, { name: 'QA', login: 'x' }].map(T.autoQa)).toEqual([true, true, true, true, true]);
        expect([{ name: '小屋', login: 'ab…c' }, { name: 'Quality', login: 'aq…a' }, { name: 'latest', login: 'te…t' }, { name: '人工驗收', login: 'qa…a', owner: true }].map(T.autoQa)).toEqual([false, false, false, false]);
        const line = n => ({ received: n, stages: { uploaded: n }, reasons: {}, days: [] });
        const el = { innerHTML: '', querySelector: () => null, contains: () => true };
        const click = (th, v) => el.onclick({ target: { closest: () => ({ dataset: { th, v } }) }, preventDefault() {} });
        T.mount(el, { meta: { asOf: new Date().toISOString(), notes: [] }, users: [user('aaaaaaaaaa', '小屋', { owner: true, line: line(10) }), user('bbbbbbbbbb', '人工驗收 a', { line: line(5) }), user('cccccccccc', '阿嬤', { line: line(1) })] });
        const count = html => (html.match(/class="th-tag th-tag-qa"/g) || []).length;
        expect(count(el.innerHTML)).toBe(1);
        expect(el.innerHTML).toMatch(/<span>用戶<\/span><b>3 位<\/b>/);
        expect(el.innerHTML).toMatch(/<span>LINE 收到<\/span><b>16 張<\/b>/);
        expect(el.innerHTML).toMatch(/data-th="hideqa" data-v="1" aria-pressed="false"[^>]*>隱藏 QA 測試用 1</);
        click('hideqa', '1');                       // hidden: gone from the table and from every number, and it says so
        expect(el.innerHTML).not.toContain('人工驗收 a');
        expect(el.innerHTML).toMatch(/<span>用戶<\/span><b>2 位<\/b>/);
        expect(el.innerHTML).toMatch(/<span>LINE 收到<\/span><b>11 張<\/b>/);
        expect(el.innerHTML).toContain('已隱藏 1 個 QA 測試用帳戶，數字不含它們');
        expect(el.innerHTML).toMatch(/data-th="hideqa" data-v="1" aria-pressed="true"/);
        expect(JSON.parse(saved['hub.th.hideQa'])).toBe(true);
        click('qa', 'cccccccccc');                  // marked by hand while hidden: it leaves too
        expect(el.innerHTML).not.toContain('阿嬤');
        expect(JSON.parse(saved['hub.th.qa'])).toEqual({ cccccccccc: true });
        click('hideqa', '1');                       // shown again: two tags now
        expect(count(el.innerHTML)).toBe(2);
        click('qa', 'bbbbbbbbbb');                  // the automatic one can be unmarked; back to automatic removes the stored mark
        expect(count(el.innerHTML)).toBe(1);
        expect(JSON.parse(saved['hub.th.qa'])).toEqual({ cccccccccc: true, bbbbbbbbbb: false });
        click('qa', 'bbbbbbbbbb');
        expect(JSON.parse(saved['hub.th.qa'])).toEqual({ cccccccccc: true });
        click('open', 'bbbbbbbbbb');                // the detail offers the opposite action
        expect(el.innerHTML).toMatch(/data-th="qa" data-v="bbbbbbbbbb"[^>]*>取消 QA 標籤</);
        click('hideqa', '1');                       // hiding closes a QA account's open detail
        expect(el.innerHTML).not.toContain('id="th-panel"');
    });
});

describe('admin hub: Weesh 帳戶智慧數據庫 (hub-weesh.js)', () => {
    const boot = (stored = {}) => { const sandbox = { window: {}, localStorage: { getItem: k => (k in stored ? JSON.stringify(stored[k]) : null), setItem: () => {} }, Intl, Date, Math, JSON, Object, Array, Number, String, Set }; vm.runInNewContext(fs.readFileSync(path.join(pageDir, 'hub-weesh.js'), 'utf8'), sandbox); return sandbox.window.HubWeesh; };
    const HOUR = 3600000, DAY = 24 * HOUR;
    const today = new Date(Date.now() + 8 * HOUR).toISOString().slice(0, 10);
    // what the collector stores for one account (synthetic)
    const fact = (name, extra = {}) => Object.assign({ v: 1, name, login: 'ab***@example.invalid', ev: true, pv: false, premium: false, api: false, sub: null, subUntil: null, createdAt: Date.now() - 40 * DAY, lastAt: null, talkAt: null,
        wish: { n: 0, lists: 0, pub: 0, bought: 0, hidden: 0, aiFailed: 0, d30: 0, linked: 0, watches: 0 }, sell: { n: 0, active: 0, reserved: 0, sold: 0, expired: 0, removed: 0, draft: 0, d30: 0 },
        chat: { buy: 0, sell: 0, sent: 0, d30: 0, unread: 0, oldestUnreadAt: null, inquiries: 0 }, meet: { n: 0, open: 0, done: 0 }, pay: { n: 0, twd: 0 }, social: { following: 0, followers: 0 },
        dev: { ios: 0, android: 0, other: 0 }, ai: 0, feedback: 0, days: [] }, extra);
    const users = (W, facts) => W.fromFacts(facts).users;

    test('facts become accounts; only wlUser + 10 hex keys with v 1 count, missing parts read as zero, the meta fact is kept apart', () => {
        const W = boot();
        const d = W.fromFacts({ usersTotal: { label: 'x', value: 3 }, wlUsersMeta: { v: 1, users: 2, shown: 1, dropped: 1 }, wlUseraaaaaaaaaa: { v: 1, name: 'A', wish: { n: 2 } }, wlUserXYZ: { v: 1, name: 'bad' }, wlUserbbbbbbbbbb: { v: 2, name: 'old' } });
        expect(d.users.map(u => [u.ref, u.name, u.wish.n, u.wish.aiFailed, u.sell.active, u.days.length])).toEqual([['aaaaaaaaaa', 'A', 2, 0, 0, 0]]);
        expect(d.meta).toEqual({ v: 1, users: 2, shown: 1, dropped: 1 });
        expect(W.fromFacts({}).meta).toBe(null);
    });

    test('every account is placed at the furthest step it has reached', () => {
        const W = boot(), f = extra => W.fromFacts({ wlUseraaaaaaaaaa: fact('A', extra) }).users[0];
        expect(W.stageOf(f({}))).toBe('idle');
        expect(W.stageOf(f({ wish: { n: 1 } }))).toBe('content');
        expect(W.stageOf(f({ sell: { n: 1, draft: 1 } }))).toBe('content');
        expect(W.stageOf(f({ wish: { n: 1 }, chat: { inquiries: 1 } }))).toBe('talk');
        expect(W.stageOf(f({ chat: { sell: 1 }, meet: { n: 1, open: 1 } }))).toBe('meet');
        expect(W.stageOf(f({ meet: { n: 2, done: 1 } }))).toBe('done');
    });

    test('insights: unread replies and failed wishes first, then who is idle, stuck in drafts or most active; the summary uses the collector totals when accounts were left out', () => {
        const W = boot();
        const list = users(W, {
            wlUseraaaaaaaaaa: fact('小明', { wish: { n: 6, aiFailed: 2, d30: 3 }, chat: { buy: 2, sent: 5, unread: 1, oldestUnreadAt: Date.now() - 4 * DAY }, lastAt: Date.now() - HOUR, days: [[today, 3, 0, 2]] }),
            wlUserbbbbbbbbbb: fact('阿華', { sell: { n: 4, draft: 4 }, lastAt: Date.now() - 2 * DAY, days: [[today, 0, 1, 0]] }),
            wlUsercccccccccc: fact('', { ev: false }),
            wlUserdddddddddd: fact('新人', { createdAt: Date.now() - DAY, dev: { ios: 1 }, meet: { n: 1, open: 1 }, chat: { sell: 1 } }),
        });
        const text = W.insights(list, { v: 1, dropped: 0 }).map(x => x.sev + ' ' + x.text);
        expect(text[0]).toMatch(/^crit 小明 有 1 個對話對方已回覆但還沒讀，最久的已經 4 天/);
        expect(text[1]).toBe('warn 小明 有 2 個願望的 AI 整理失敗。');
        expect(text).toContain('info 有 1 個帳戶註冊超過 7 天，還沒有任何願望、刊登或對話。');
        expect(text).toContain('info 阿華 有 4 件刊登停在草稿，沒有任何一件刊出。');
        expect(text).toContain('info 近 30 天最活躍的是 小明：新增 3 個願望、0 件刊登、2 則訊息。');
        expect(text).toContain('info 近 7 天有 1 個新帳戶，其中 1 個已經開始使用。');
        expect(text).toContain('info 有 1 個帳戶的信箱和手機都還沒驗證。');
        expect(text).toContain('info 1 個帳戶裝了 App 並開啟通知（iOS 1、Android 0）。');
        expect(text.some(x => /^info 有 1 個帳戶約了面交還沒完成（共 1 筆/.test(x))).toBe(true);
        expect(text.at(-1)).toBe('ok 共 4 個帳戶：1 個建立過願望（25%）、1 個刊登過商品（25%）、1 個傳過訊息、0 個完成過面交。');
        // accounts left out for size: the totals come from the collector, and the page says so
        const cut = W.insights(list.slice(0, 1), { v: 1, dropped: 9, totals: { users: 10, withWish: 5, withListing: 2, withChat: 3, withMeetDone: 1, active30: 4, wishes: 30, listings: 8, listingsActive: 3, sent: 40, paidUsers: 1, paidTwd: 300, appUsers: 2 } }).map(x => x.text);
        expect(cut).toContain('共 10 個帳戶：5 個建立過願望（50%）、2 個刊登過商品（20%）、3 個傳過訊息、1 個完成過面交。');
        expect(cut).toContain('付費帳戶 1 個，累計 NT$ 300。');
        expect(cut.some(x => /略過了 9 個最久沒有動作的帳戶的明細/.test(x))).toBe(true);
        expect(W.insights([], { v: 1 }).map(x => x.text)).toEqual(['目前還沒有任何帳戶。']);
    });

    test('the page: names are escaped, an unnamed account is still listed, the open account shows its detail, and no detail explains itself', () => {
        const facts = {
            wlUsersMeta: { v: 1, asOf: Date.now(), users: 2, shown: 2, dropped: 0, notes: [] },
            wlUseraaaaaaaaaa: fact('<img src=x onerror=alert(1)>', { premium: true, wish: { n: 3, lists: 2, pub: 1 }, sell: { n: 5, active: 2, expired: 1, draft: 2, d30: 1 }, chat: { buy: 1, sell: 2, sent: 7 }, meet: { n: 1, done: 1 }, pay: { n: 2, twd: 598 }, sub: 'ACTIVE', lastAt: Date.now() - HOUR, days: [[today, 1, 1, 4]] }),
            wlUserbbbbbbbbbb: fact('', { login: '' }),
        };
        const el = { innerHTML: '', querySelector: () => null, contains: () => true };
        const W = boot({ 'hub.ws.open': 'aaaaaaaaaa' });
        W.mount(el, W.fromFacts(facts));
        expect(el.innerHTML).toContain('帳戶智慧數據庫');
        expect(el.innerHTML).toContain('智慧洞察');
        expect(el.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(el.innerHTML).not.toContain('<img src=x');
        expect(el.innerHTML).toContain('（未命名）');
        expect(el.innerHTML).toContain('沒有登入信箱');
        expect(el.innerHTML).toContain('所有帳戶走到哪一步');
        expect(el.innerHTML).toMatch(/完成面交 <b>1<\/b>/);                 // the stage legend
        expect(el.innerHTML).toContain('id="ws-panel"');
        expect(el.innerHTML).toContain('2 筆・NT$ 598');
        expect(el.innerHTML).toContain('訂閱中');
        expect(el.innerHTML).toMatch(/刊登中<\/td><td class="num">2<\/td><td class="num muted">40%/);
        expect(el.innerHTML).toContain('近 30 天活動');
        expect(el.innerHTML).not.toMatch(/https?:\/\//);
        // the stage bar and the "只有註冊" filter are the same question: picking a stage lets go of that filter instead of emptying the table
        const idleFirst = { innerHTML: '', querySelector: () => null, contains: () => true };
        const W2 = boot({ 'hub.ws.filter': 'idle' });
        W2.mount(idleFirst, W2.fromFacts(facts));
        expect(idleFirst.innerHTML).toMatch(/data-ws="filter" data-v="idle" aria-pressed="true"/);
        idleFirst.onclick({ target: { closest: () => ({ dataset: { ws: 'group', v: 'done' } }) }, preventDefault() {} });
        expect(idleFirst.innerHTML).toMatch(/data-ws="filter" data-v="all" aria-pressed="true"/);
        expect(idleFirst.innerHTML).toContain('只看「完成面交」');
        expect(idleFirst.innerHTML).not.toContain('沒有符合條件的帳戶');
        const empty = { innerHTML: '' };
        boot().mount(empty, { meta: null, users: [] });
        expect(empty.innerHTML).toMatch(/還沒有帳戶明細/);
    });
});

describe('admin hub: 以後略過類似警告 (the API\'s only write)', () => {
    const ORIGIN = 'https://eclawbot.com';
    test('an administrator on the hub page can mute and unmute a kind; nothing else can write', async () => {
        const { app, pool, routers } = mount();
        const first = await routers.data.load();
        const post = (body, who = 'admin', origin = ORIGIN) => { const r = as(request(app).post('/api/aihankapps/hub/mutes'), who); return (origin ? r.set('Origin', origin) : r).send(body); };
        const ok = await post({ type: 'rating-alpha', label: 'Alpha 的評分偏低', sampleRef: 'rating-alpha' });
        expect(ok.status).toBe(200);
        expect(ok.body).toMatchObject({ success: true, mute: { type: 'rating-alpha', label: 'Alpha 的評分偏低' } });
        const insert = pool.direct.find(sql => sql.includes('INSERT INTO aihankapps_hub_mutes'));
        expect(insert).toMatch(/ON CONFLICT \(type\) DO UPDATE/);
        // the next answer is built fresh, so the page sees the mute at once
        expect(await routers.data.load()).not.toBe(first);
        const del = await as(request(app).delete('/api/aihankapps/hub/mutes/rating-alpha'), 'admin').set('Origin', ORIGIN);
        expect(del.status).toBe(200);
        expect(pool.direct.some(sql => sql.includes('DELETE FROM aihankapps_hub_mutes'))).toBe(true);
        // refused: no or a foreign Origin, not an administrator, not signed in, a kind that may not be muted, any other write
        expect((await post({ type: 'rating-alpha', label: 'x' }, 'admin', null)).status).toBe(403);
        expect((await post({ type: 'rating-alpha', label: 'x' }, 'admin', 'https://evil.example')).status).toBe(403);
        expect((await post({ type: 'rating-alpha', label: 'x' }, 'member')).status).toBe(403);
        expect((await post({ type: 'rating-alpha', label: 'x' }, 'nobody')).status).toBe(401);
        expect((await post({ type: 'human', label: 'x' })).body).toEqual({ success: false, error: 'MUTE_TYPE' });
        expect((await post({ type: 'feedback-eclaw', label: 'x' })).body).toEqual({ success: false, error: 'MUTE_TYPE' });
        expect((await post({ type: 'rating-alpha', label: '', extra: 1 })).body).toEqual({ success: false, error: 'MUTE_SHAPE' });
        expect((await as(request(app).post('/api/aihankapps/hub/data'), 'admin').set('Origin', ORIGIN).send({})).status).toBe(405);
        expect((await as(request(app).delete('/api/aihankapps/hub/mutes'), 'admin').set('Origin', ORIGIN)).status).toBe(405);
        expect((await as(request(app).put('/api/aihankapps/hub/mutes'), 'admin').set('Origin', ORIGIN).send({})).status).toBe(405);
        expect(pool.direct.filter(sql => sql.includes('INSERT INTO aihankapps_hub_mutes'))).toHaveLength(1);
    });
});

