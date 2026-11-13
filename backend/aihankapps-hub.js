/**
 * AiHankApps 管理中樞 (admin hub) — the page /AiHankApps/hub/ and its read API /api/aihankapps/hub/*.
 *
 * Hank, 2026-11-10: "在作品集再製作一頁 但只有登入eclaw管理者才能看到的額外頁面 / 這是所有作品後台的管理中樞 /
 * 我要監控後台每一款APP所有數據", then after seeing the mock-up: "可以，接真資料".
 *
 * Access: every byte of the page (HTML, scripts, styles) and every API answer except /access goes through the existing
 * authModule.authMiddleware + authModule.adminMiddleware (user_accounts.is_admin), unchanged. The page files live in
 * backend/aihankapps-hub/, outside public/, so the public static mount can never serve them. The path is reserved in
 * index.js before anonymous pageview tracking and public static serving, like /AiHankApps/admin-demos.
 *
 * The repository is public: the page's code is visible there, its numbers are not. Nothing this module reads from the
 * database is written to a file, and the API answers are private/no-store.
 *
 * Data (read-only, aggregates only — no account, device or message content leaves the database):
 *   - files shipped with the deployment: public/AiHankApps/app-catalog.json and reports/data.js (store installs,
 *     downloads, AdMob revenue, crash events, rating — the same numbers the public APP 趨勢 page shows);
 *   - app_portfolio_traffic_daily (portfolio views, introduction views, store clicks per app and day);
 *   - app_portfolio_likes / _comments / _beta_feedback, fraud_app_feedback_reports (counts);
 *   - user_accounts and chat_messages (EClawbot sign-ups, messages and active devices per Taipei day);
 *   - dream_buddy_inference_jobs / dream_buddy_ad_transactions (夢話夥伴 conversations, devices, rewarded ads);
 *   - tappay_transactions and topup_orders (EClawbot payments: count and amount per Taipei day);
 *   - the hub's own tables, see aihankapps-hub-store.js: service probes (is each back-end answering, how fast) and
 *     daily counts an operator's collector imports from the game servers and other back-ends;
 *   - problem reports and the alert schedule's notes, see aihankapps-hub-inbox.js: the text of each recent report
 *     (EClawbot feedback, 詐騙帝國 feedback, portfolio beta feedback, 拾光AI雲端相簿 reports imported by the collector)
 *     and what the schedule decided about each alert. This is the one place where message text is read: Hank asked to
 *     see every report as an alert (2026-11-13); the answer stays admin-only and private/no-store.
 * Worker and Wishlist operations data are read by the page from the public /api/aihankapps/ops API.
 *
 * A source that cannot be read is reported as { ok: false } and the rest of the answer still arrives. A day the
 * source does not know stays null; days a live counter covers but has no row for are zero.
 */

'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const hubStore = require('./aihankapps-hub-store');
const hubInbox = require('./aihankapps-hub-inbox');

const PAGE_DIR = path.join(__dirname, 'aihankapps-hub');
const PORTFOLIO_DIR = path.join(__dirname, 'public', 'AiHankApps');
const LOGIN_URL = '/portal/?return_to=%2FAiHankApps%2Fhub%2F';
const TIME_ZONE = 'Asia/Taipei';
const DAY_MS = 86400000, TAIPEI_OFFSET_MS = 8 * 3600000;
const HISTORY_DAYS = 400;            // daily history sent to the page: a year plus room to compare
const CHAT_DAYS = 190;               // chat_messages has no index on created_at alone: keep the scan window modest
const CACHE_MS = 2 * 60 * 1000, CHAT_CACHE_MS = 10 * 60 * 1000;
const QUERY_TIMEOUT_MS = 8000;
const ECLAW_APP = 'eclawbot', DREAM_APP = 'dreambuddy', FRAUD_APP = 'com.hankhuang.fraudempire', SITE = '__site__';
const STORE_METRICS = ['googleInstalls', 'appleDownloads', 'admobRevenue', 'crashes', 'anrs'];
const TRAFFIC_METRICS = { view: 'siteViews', intro: 'introViews', google: 'googleClicks', apple: 'appleClicks' };
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const PAGE_FILES = {
    'index.html': 'text/html; charset=utf-8',
    'hub.css': 'text/css; charset=utf-8',
    'hub-charts.js': 'text/javascript; charset=utf-8',
    'hub-data.js': 'text/javascript; charset=utf-8',
    'hub-app.js': 'text/javascript; charset=utf-8',
    'hub-timehut.js': 'text/javascript; charset=utf-8',
};
// Scripts and styles only from this path; inline style attributes are needed for bar widths the page computes.
const CONTENT_SECURITY_POLICY = [
    "default-src 'none'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'self'", "form-action 'none'",
    "worker-src 'none'", "script-src 'self'", "script-src-attr 'none'", "style-src 'self' https://fonts.googleapis.com",
    "style-src-attr 'unsafe-inline'", 'font-src https://fonts.gstatic.com', "img-src 'self' data: https:", "connect-src 'self'",
].join('; ');
const FORBIDDEN_PAGE = '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex"><title>管理中樞 · AiHankApps</title></head><body><main><h1>這個帳號沒有管理者權限</h1>'
    + '<p>管理中樞只開放給 EClaw 管理者。</p><p><a href="/AiHankApps/">回到 APP 作品集</a></p></main></body></html>';

// ---- account sign-ups per app ---------------------------------------------------------------------------------------
// Hank, 2026-11-11: "所有 App 的帳號註冊人數" — only apps that have accounts; counts only, never who.
//   connected:     numbers are read (this server's database, or facts the collector imports read-only)
//   not_connected: the app has accounts, but there is no read-only count for the hub yet (note says what is missing)
//   none:          the app has no account sign-up (note says what it uses instead)
//   unknown:       not confirmed yet (note says why); shown separately, never counted as "no accounts"
// Inventory 2026-11-11 (read-only: source code, privacy pages, store privacy labels).
// facts: [total, new in 7 days, new in 30 days] keys imported by tools/aihankapps-hub (backends.js; 時光相簿 from collect.js).
const ACCOUNT_APPS = [
    { app: ECLAW_APP, status: 'connected', from: 'eclaw', source: 'EClaw 主站 user_accounts（唯讀 COUNT）' },
    { app: 'weesh', status: 'connected', facts: ['usersTotal', 'accountsNew7d', 'accountsNew30d'], source: 'Wishlist.ai 後台 User 表（收集工具唯讀匯入，每天 06:20）' },
    { app: 'typeforge-twin-cities', status: 'connected', facts: ['accountsTotal', 'accountsNew7d', 'accountsNew30d'], source: '活字戰紀伺服器 summit_accounts＋summit_device_bindings（綁定雙城烽火的帳號；收集工具唯讀匯入，每天 06:20）' },
    { app: 'summit-battle', status: 'connected', facts: ['accountsTotal', 'accountsNew7d', 'accountsNew30d'], source: '活字戰紀伺服器 summit_accounts＋summit_device_bindings（綁定巔峰之戰的帳號；收集工具唯讀匯入，每天 06:20）' },
    { app: 'timehut', status: 'connected', facts: ['accountsTotal', 'accountsNew7d', 'accountsNew30d'], source: '時光相簿伺服器帳號資料（伺服器只回數字的統計端點，收集工具用金鑰唯讀匯入，每小時一次；不含已刪除帳號）' },
    { app: 'rebound', status: 'none', note: '沒有註冊或登入；伺服器只為每份安裝建立訪客帳號（玩家總數見 APP 頁）。' },
    { app: DREAM_APP, status: 'none', note: '沒有帳號註冊；以 EClaw 裝置識別。' },
    { app: 'vibe-empire', status: 'unknown', note: '尚未確認：遊戲原始碼所在的資料區沒有掛載，只知道它用 EClaw 裝置綁定。' },
];

// ---- days -------------------------------------------------------------------------------------------------------------
const dayIndex = iso => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY_MS);
const isoDay = index => new Date(index * DAY_MS).toISOString().slice(0, 10);
const taipeiDay = ms => new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
const taipeiMidnight = iso => new Date(dayIndex(iso) * DAY_MS - TAIPEI_OFFSET_MS);
const laterDay = (a, b) => (a > b ? a : b);
const count = value => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null; };

// One slot per day for each (metric, app). null = the source does not know that day.
function createDaily(startIndex, days) {
    const series = {};
    const slot = (metric, app) => {
        const byApp = series[metric] || (series[metric] = {});
        return byApp[app] || (byApp[app] = new Array(days).fill(null));
    };
    return {
        add(metric, app, iso, value) {
            if (typeof iso !== 'string' || !ISO_DAY.test(iso) || typeof value !== 'number' || !Number.isFinite(value)) return;
            const i = dayIndex(iso) - startIndex;
            if (i < 0 || i >= days) return;
            const values = slot(metric, app);
            values[i] = (values[i] || 0) + value;
        },
        // A live counter that was running from `fromIso` to `toIso`: days without a row are zero, not unknown.
        fill(metric, app, fromIso, toIso) {
            const a = Math.max(0, dayIndex(fromIso) - startIndex), b = Math.min(days - 1, dayIndex(toIso) - startIndex);
            if (b < a) return;
            const values = slot(metric, app);
            for (let i = a; i <= b; i++) if (values[i] === null) values[i] = 0;
        },
        toJSON() {
            const out = {};
            for (const [metric, byApp] of Object.entries(series)) {
                for (const [app, values] of Object.entries(byApp)) {
                    let a = 0, b = values.length;
                    while (a < b && values[a] === null) a++;
                    while (b > a && values[b - 1] === null) b--;
                    if (b <= a) continue;
                    (out[metric] || (out[metric] = {}))[app] = { o: a, v: values.slice(a, b).map(v => (v === null ? null : Math.round(v * 1e4) / 1e4)) };
                }
            }
            return out;
        },
    };
}

// ---- files shipped with the deployment --------------------------------------------------------------------------------
// reports/data.js is `window.AIHANK_REPORT = {...};` with plain JSON inside.
function parseReport(text) {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('REPORT_SHAPE');
    const report = JSON.parse(text.slice(a, b + 1));
    if (!report || !Array.isArray(report.apps)) throw new Error('REPORT_SHAPE');
    return report;
}

function appsFromCatalog(catalog) {
    if (!catalog || !Array.isArray(catalog.apps)) throw new Error('CATALOG_SHAPE');
    const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
    const link = value => (typeof value === 'string' && /^https:\/\//.test(value) ? value : null);
    return catalog.apps.filter(app => app && typeof app.communityId === 'string' && typeof app.name === 'string').map(app => {
        const platforms = [];
        if (app.googlePackage) platforms.push({ key: 'android', label: 'Android', status: text(app.googleStatus, 40), public: app.publicGoogle === true, url: link(app.googleUrl), version: null });
        if (app.iosStatus || app.iosId) platforms.push({ key: 'ios', label: 'iOS', status: text(app.iosStatus, 40), public: app.publicApple === true, url: link(app.iosUrl), version: text(app.iosVersion, 24) || null });
        if (app.webUrl || app.webStatus) platforms.push({ key: 'web', label: 'Web', status: text(app.webStatus, 40), public: app.publicWeb === true, url: link(app.webUrl), version: null });
        if (!platforms.length) platforms.push({ key: 'other', label: text(app.source, 40) || '其他', status: '', public: true, url: link(app.releaseUrl) || link(app.guide), version: null });
        const icon = text(app.icon, 400);
        return {
            id: app.communityId,
            slug: text(app.projectId || app.communityId, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
            name: text(app.name, 80), mono: text(app.iconText, 8) || text(app.name, 2), category: text(app.category, 20), desc: text(app.desc, 200),
            aliases: Array.isArray(app.aliases) ? app.aliases.filter(a => typeof a === 'string').join(' ').slice(0, 200) : text(app.aliases, 200),
            // Local icons are files of the public portfolio; remote ones are the same URLs the portfolio page loads.
            icon: /^https:\/\//.test(icon) ? icon : /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(icon) && !icon.includes('..') ? '/AiHankApps/' + icon : null,
            platforms,
            links: { guide: link(app.guide), official: link(app.officialUrl), itch: link(app.itchUrl), release: link(app.releaseUrl), project: link(app.projectUrl) },
            checkedAt: text(app.checkedAt, 32) || null,
        };
    });
}

// ---- database ---------------------------------------------------------------------------------------------------------
// Every read runs in its own read-only transaction with a server-side time limit, so a slow table can neither be
// written to nor hold a connection for long. SET LOCAL ends with the transaction; nothing leaks into the pool.
async function readOnly(pool, run) {
    if (!pool) throw new Error('POOL_UNAVAILABLE');
    const client = await pool.connect();
    try {
        await client.query('BEGIN READ ONLY');
        await client.query('SET LOCAL statement_timeout = ' + QUERY_TIMEOUT_MS);
        const result = await run((sql, values) => client.query(sql, values));
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

// One row per catalog app: { app, name, status, total, new7d, new30d, source, observedAt, note }. Unknown numbers stay null.
function accountRows(apps, eclaw, facts, sources) {
    const byApp = new Map(ACCOUNT_APPS.map(row => [row.app, row]));
    return apps.map(app => {
        const def = byApp.get(app.id) || { status: 'none', note: '這款 APP 沒有帳號註冊功能。' };
        if (def.status === 'none' && !def.note) def.note = '這款 APP 沒有帳號註冊功能。';
        const row = { app: app.id, name: app.name, status: def.status, total: null, new7d: null, new30d: null, source: def.source || null, observedAt: null, note: def.note || null };
        if (def.from === 'eclaw') {
            const u = eclaw.users;
            if (u && sources.eclaw && sources.eclaw.ok) Object.assign(row, { total: count(u.total), new7d: count(u.new7d), new30d: count(u.new30d), observedAt: u.readAt || null });
        } else if (def.facts) {
            const f = facts[app.id] || {}, value = key => (f[key] && typeof f[key].value === 'number' ? count(f[key].value) : null);
            [row.total, row.new7d, row.new30d] = def.facts.map(value);
            const seen = def.facts.map(key => f[key] && f[key].observedAt).filter(Boolean);
            row.observedAt = seen.length ? Math.min(...seen) : null;
        }
        return row;
    });
}

function createData({ getPool, getAuthPool, getDeviceStats, now = Date.now, portfolioDir = PORTFOLIO_DIR }) {
    let cache = null, pending = null, chatCache = null;

    async function build() {
        const generatedAt = now();
        const today = taipeiDay(generatedAt), startIndex = dayIndex(today) - HISTORY_DAYS + 1, start = isoDay(startIndex);
        const daily = createDaily(startIndex, HISTORY_DAYS);
        const sources = {}, latest = { rating: {}, reviews: {}, likes: {}, comments: {}, betaFeedback: {}, feedback: {}, facts: {} };
        let services = [], infra = [];
        const eclaw = { users: null, devices: null };
        let apps = [];
        const section = async (id, run) => {
            try { sources[id] = { ok: true, ...(await run()) }; } catch (error) {
                console.error('[AiHankAppsHub] ' + id + ' unavailable:', error.message);
                sources[id] = { ok: false };
            }
        };

        await section('catalog', async () => {
            const catalog = JSON.parse(await fs.promises.readFile(path.join(portfolioDir, 'app-catalog.json'), 'utf8'));
            apps = appsFromCatalog(catalog);
            return { checkedAt: typeof catalog.checkedAt === 'string' ? catalog.checkedAt : null, apps: apps.length };
        });

        await section('store', async () => {
            const report = parseReport(await fs.promises.readFile(path.join(portfolioDir, 'reports', 'data.js'), 'utf8'));
            const starts = {}, ends = {};
            for (const metric of STORE_METRICS) {
                const total = (report.totals && report.totals[metric]) || {};
                starts[metric] = ISO_DAY.test(total.historyStart || '') ? total.historyStart : null;
                ends[metric] = ISO_DAY.test(total.historyEnd || '') ? total.historyEnd : null;
            }
            for (const app of report.apps) {
                if (!app || typeof app.id !== 'string') continue;
                for (const metric of STORE_METRICS) for (const p of (app[metric] && app[metric].points) || []) if (p) daily.add(metric, app.id, p.date, p.value);
                const rating = app.googleRating;
                if (rating && typeof rating.value === 'number') latest.rating[app.id] = { value: rating.value, date: ISO_DAY.test(rating.date || '') ? rating.date : null };
            }
            for (const row of (report.reviews && report.reviews.apps) || []) {
                if (row && typeof row.id === 'string') latest.reviews[row.id] = { google: count(row.google && row.google.count), apple: count(row.apple && row.apple.count) };
            }
            const unallocated = report.totals && report.totals.unallocatedRevenue;
            return { generatedAt: typeof report.generatedAt === 'string' ? report.generatedAt : null, currency: typeof report.currency === 'string' ? report.currency : null,
                starts, ends, unallocatedRevenue: unallocated ? count(unallocated.historyTotal) : null };
        });

        await section('traffic', () => readOnly(getPool(), async query => {
            const first = (await query('SELECT MIN(day)::text AS first FROM app_portfolio_traffic_daily')).rows[0].first;
            const rows = (await query('SELECT day::text AS day, app_id, action, count::text AS count FROM app_portfolio_traffic_daily WHERE day >= $1::date', [start])).rows;
            for (const row of rows) if (TRAFFIC_METRICS[row.action]) daily.add(TRAFFIC_METRICS[row.action], row.app_id, row.day, Number(row.count));
            if (first) {
                const from = laterDay(first, start);
                daily.fill('siteViews', SITE, from, today);
                for (const app of apps) for (const metric of ['introViews', 'googleClicks', 'appleClicks']) daily.fill(metric, app.id, from, today);
            }
            return { startedAt: first || null };
        }));

        await section('community', () => readOnly(getPool(), async query => {
            for (const row of (await query('SELECT app_id, COUNT(*)::int AS n FROM app_portfolio_likes GROUP BY app_id')).rows) latest.likes[row.app_id] = row.n;
            for (const row of (await query('SELECT app_id, COUNT(*)::int AS n FROM app_portfolio_comments GROUP BY app_id')).rows) latest.comments[row.app_id] = row.n;
            for (const row of (await query('SELECT app_id, COUNT(*)::int AS n, AVG(rating)::float8 AS rating FROM app_portfolio_beta_feedback GROUP BY app_id')).rows) {
                latest.betaFeedback[row.app_id] = { count: row.n, rating: row.rating === null ? null : Math.round(row.rating * 100) / 100 };
            }
            return {};
        }));

        await section('feedback', () => readOnly(getPool(), async query => {
            const row = (await query("SELECT COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'))::int AS recent, MAX(created_at) AS latest FROM fraud_app_feedback_reports")).rows[0];
            latest.feedback[FRAUD_APP] = { count: row.n, recent: row.recent, latestAt: row.latest ? new Date(row.latest).getTime() : null };
            return {};
        }));

        await section('eclaw', () => readOnly(getAuthPool(), async query => {
            const users = (await query("SELECT COUNT(*)::int AS total, (COUNT(*) FILTER (WHERE email_verified))::int AS verified, (COUNT(*) FILTER (WHERE subscription_status = 'premium'))::int AS premium, (COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'))::int AS new7d, (COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'))::int AS new30d FROM user_accounts")).rows[0];
            eclaw.users = { total: users.total, verified: users.verified, premium: users.premium, new7d: count(users.new7d), new30d: count(users.new30d), readAt: generatedAt };
            const rows = (await query("SELECT (created_at AT TIME ZONE 'Asia/Taipei')::date::text AS day, COUNT(*)::int AS n FROM user_accounts WHERE created_at >= $1 GROUP BY 1", [taipeiMidnight(start)])).rows;
            for (const row of rows) daily.add('eclawSignups', ECLAW_APP, row.day, row.n);
            daily.fill('eclawSignups', ECLAW_APP, start, today);
            return {};
        }));

        // One scan of chat_messages, kept for ten minutes: the table is the largest one this module touches.
        await section('eclawChat', async () => {
            const since = isoDay(dayIndex(today) - CHAT_DAYS + 1);
            if (!chatCache || chatCache.since !== since || generatedAt - chatCache.at > CHAT_CACHE_MS) {
                const rows = await readOnly(getAuthPool(), async query => (await query(
                    "SELECT (created_at AT TIME ZONE 'Asia/Taipei')::date::text AS day, COUNT(*)::int AS messages, COUNT(DISTINCT device_id)::int AS devices FROM chat_messages WHERE created_at >= $1 GROUP BY 1",
                    [taipeiMidnight(since)])).rows);
                chatCache = { at: generatedAt, since, rows };
            }
            for (const row of chatCache.rows) {
                daily.add('eclawMessages', ECLAW_APP, row.day, row.messages);
                daily.add('eclawActiveDevices', ECLAW_APP, row.day, row.devices);
            }
            daily.fill('eclawMessages', ECLAW_APP, since, today);
            daily.fill('eclawActiveDevices', ECLAW_APP, since, today);
            return { since, readAt: chatCache.at };
        });

        await section('dreambuddy', () => readOnly(getPool(), async query => {
            const first = (await query('SELECT MIN(quota_date)::text AS first FROM dream_buddy_inference_jobs')).rows[0].first;
            const jobs = (await query("SELECT quota_date::text AS day, COUNT(*)::int AS jobs, (COUNT(*) FILTER (WHERE status = 'completed'))::int AS completed, (COUNT(*) FILTER (WHERE status = 'failed'))::int AS failed, COUNT(DISTINCT device_id)::int AS devices FROM dream_buddy_inference_jobs WHERE quota_date >= $1::date GROUP BY 1", [start])).rows;
            for (const row of jobs) {
                daily.add('dreamTurns', DREAM_APP, row.day, row.jobs);
                daily.add('dreamCompleted', DREAM_APP, row.day, row.completed);
                daily.add('dreamFailed', DREAM_APP, row.day, row.failed);
                daily.add('dreamActiveDevices', DREAM_APP, row.day, row.devices);
            }
            const ads = (await query('SELECT quota_date::text AS day, COUNT(*)::int AS n FROM dream_buddy_ad_transactions WHERE quota_date >= $1::date GROUP BY 1', [start])).rows;
            for (const row of ads) daily.add('dreamAds', DREAM_APP, row.day, row.n);
            // These tables hold the whole history: before the first row there simply was no usage, so those days are zero.
            if (first) for (const metric of ['dreamTurns', 'dreamCompleted', 'dreamFailed', 'dreamActiveDevices', 'dreamAds']) daily.fill(metric, DREAM_APP, start, today);
            return { startedAt: first || null };
        }));

        // EClawbot payments: card payments that succeeded and wallet top-ups that were paid and not refunded.
        await section('eclawPayments', () => readOnly(getAuthPool(), async query => {
            const since = [taipeiMidnight(start)];
            const paid = (await query("SELECT (created_at AT TIME ZONE 'Asia/Taipei')::date::text AS day, COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::float8 AS twd FROM tappay_transactions WHERE status = 'success' AND currency = 'TWD' AND created_at >= $1 GROUP BY 1", since)).rows
                .concat((await query("SELECT (paid_at AT TIME ZONE 'Asia/Taipei')::date::text AS day, COUNT(*)::int AS n, COALESCE(SUM(amount_twd), 0)::float8 AS twd FROM topup_orders WHERE status = 'paid' AND refunded_at IS NULL AND amount_twd > 0 AND paid_at >= $1 GROUP BY 1", since)).rows);
            for (const row of paid) {
                daily.add('eclawPurchases', ECLAW_APP, row.day, row.n);
                daily.add('eclawPaidTwd', ECLAW_APP, row.day, row.twd);
            }
            daily.fill('eclawPurchases', ECLAW_APP, start, today);
            daily.fill('eclawPaidTwd', ECLAW_APP, start, today);
            return {};
        }));

        // The hub's own tables are created on first use, so a server that has not recorded a probe yet still answers.
        const ownTables = hubStore.prepare(getPool()).catch(() => null);

        // Daily counts and current totals handed over by the operator's collector (game servers, Wishlist…).
        await section('imports', () => ownTables.then(() => readOnly(getPool(), async query => {
            const known = new Set(apps.map(app => app.id)), imported = await hubStore.readImports(query, start);
            for (const row of imported.rows) if (known.has(row.app_id) && hubStore.IMPORT_METRICS.includes(row.metric)) daily.add('x.' + row.metric, row.app_id, row.day, Number(row.value));
            for (const row of imported.facts) {
                if (!known.has(row.app_id)) continue;
                (latest.facts[row.app_id] || (latest.facts[row.app_id] = {}))[row.key] = { ...row.value, source: row.source, observedAt: new Date(row.observed_at).getTime() };
            }
            // Per-service resources (Railway): traffic, CPU, memory, space and the latest deployment.
            infra = (imported.infra || []).filter(row => row.value && typeof row.value === 'object').map(row => ({ ...row.value,
                apps: (row.value.apps || []).filter(app => known.has(app)), source: row.source, observedAt: new Date(row.observed_at).getTime() }))
                .sort((a, b) => String(a.project).localeCompare(String(b.project)) || String(a.name).localeCompare(String(b.name)));
            return { collectors: Object.fromEntries(imported.sources.map(row => [row.id, { collectedAt: new Date(row.collected_at).getTime(), importedAt: new Date(row.imported_at).getTime(),
                values: row.detail && row.detail.values, notes: (row.detail && row.detail.notes) || [] }])) };
        })));

        await section('services', () => ownTables.then(() => readOnly(getPool(), async query => { services = await hubStore.readProbes(query, generatedAt); return {}; })));

        // Problem reports from every app, and the alert schedule's notes (Hank, 2026-11-13).
        let inbox = { feedback: [], notes: [], mutes: [], days: hubInbox.FEEDBACK_DAYS };
        await section('inbox', async () => {
            await hubInbox.prepare(getPool());
            const read = await readOnly(getPool(), query => hubInbox.readInbox(query, { now: generatedAt, appIds: new Set(apps.map(app => app.id)) }));
            inbox = { feedback: read.feedback, notes: read.notes, mutes: read.mutes, days: read.days };
            return { partial: read.partial };
        });

        try {
            const stats = typeof getDeviceStats === 'function' ? getDeviceStats() : null;
            if (stats) eclaw.devices = { total: count(stats.devices), entities: count(stats.entities), boundEntities: count(stats.boundEntities) };
        } catch (error) {
            console.error('[AiHankAppsHub] device stats unavailable:', error.message);
        }

        const accounts = accountRows(apps, eclaw, latest.facts, sources);
        return { success: true, schemaVersion: 1, generatedAt, timeZone: TIME_ZONE, today, apps,
            daily: { start, days: HISTORY_DAYS, series: daily.toJSON() }, latest, eclaw, services, infra, accounts, inbox, sources };
    }

    return {
        // Concurrent requests share one build; the answer is reused for two minutes.
        load({ fresh = false } = {}) {
            if (!fresh && cache && now() - cache.at < CACHE_MS) return Promise.resolve(cache.payload);
            if (!pending) {
                pending = build().then(payload => { cache = { at: now(), payload }; return payload; }).finally(() => { pending = null; });
            }
            return pending;
        },
        // After the page's own write (a mute), the next answer is built fresh.
        invalidate() { cache = null; },
    };
}

// ---- alerts by notification ID ---------------------------------------------------------------------------------------
// Hank, 2026-11-11: every alert on the page carries a notification ID an AI can use to look the problem up. The alerts
// are computed by the page's own data layer (hub-data.js) from the hub answer and the public operations API; to give
// exactly the same alerts, IDs and reasons, the server runs that same file in a sandbox with a stand-in fetch.
// Only the hub answer, the latest service checks and the two public ops reads (catalog, latest) are reachable from it.
const OPS_READS = new Set(['/api/aihankapps/ops/catalog', '/api/aihankapps/ops/latest']);
const ALERTS_CACHE_MS = 20 * 1000;
const taipeiTime = ms => (Number.isFinite(ms) && ms > 0 ? new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ') + ' (Asia/Taipei)' : null);
function defaultFetchOps(url) {
    return fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
}
function createAlerts({ loadHub, latestServices, fetchOps = defaultFetchOps, now = Date.now, pageDir = PAGE_DIR }) {
    let cache = null, pending = null;
    async function compute() {
        const at = now(), code = await fs.promises.readFile(path.join(pageDir, 'hub-data.js'), 'utf8');
        const reply = body => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) });
        const stub = async url => {
            if (url === '/api/aihankapps/hub/data') return reply(await loadHub());
            if (url === '/api/aihankapps/hub/services') return reply(latestServices());
            if (OPS_READS.has(url)) {
                const res = await fetchOps(url);
                return { ok: res.ok, status: res.status, json: () => res.json() };
            }
            return { ok: false, status: 404, json: async () => ({}) };     // series etc. are not needed for alerts
        };
        const sandbox = { window: {}, fetch: stub, encodeURIComponent, Date: class extends Date { static now() { return at; } } };
        vm.runInNewContext(code, sandbox, { timeout: 2000, filename: 'hub-data.js' });
        const D = sandbox.window.HubData;
        await D.load();
        const rules = {};
        D.RULES.forEach(r => { rules[r[0]] = { scope: r[1], condition: r[2] }; });
        const alerts = JSON.parse(JSON.stringify(D.ALERTS)).map(a => {
            const basisTaipei = {};
            Object.keys(a.basis || {}).forEach(k => { if (/At$/.test(k) && typeof a.basis[k] === 'number') basisTaipei[k] = taipeiTime(a.basis[k]); });
            return { id: a.ref, type: a.id, severity: a.sev, title: a.title, detail: a.detail, rule: a.rule, condition: (rules[a.rule] || {}).condition || null,
                scope: (rules[a.rule] || {}).scope || null, source: a.source, app: a.app, apps: a.apps, since: a.since, sinceTaipei: taipeiTime(a.since),
                basis: a.basis, basisTaipei, view: a.go ? '/AiHankApps/hub/#' + a.go : '/AiHankApps/hub/#alerts',
                // What the alert schedule decided (null = not looked at yet); a problem report's own words; what Hank is asked to do.
                triage: a.triage || null, quote: a.quote || null, ask: a.ask || null };
        });
        return { computedAt: at, computedAtTaipei: taipeiTime(at), alerts };
    }
    return {
        load({ fresh = false } = {}) {
            if (!fresh && cache && now() - cache.at < ALERTS_CACHE_MS) return Promise.resolve(cache.answer);
            if (!pending) pending = compute().then(answer => { cache = { at: now(), answer }; return answer; }).finally(() => { pending = null; });
            return pending;
        },
        invalidate() { cache = null; },
        // Exact notification ID first; otherwise the same alert type (the ID changes when the problem or its start changes).
        find(answer, id) {
            const exact = answer.alerts.find(a => a.id === id);
            if (exact) return { alert: exact, matchedBy: 'id' };
            const type = String(id).split(/[.@]/)[0];
            const same = answer.alerts.find(a => a.type === type);
            return same ? { alert: same, matchedBy: 'type' } : null;
        },
    };
}

// ---- access -----------------------------------------------------------------------------------------------------------
function privateHeaders(_req, res, next) {
    res.set({
        'Cache-Control': 'private, no-store, no-transform, max-age=0',
        'CDN-Cache-Control': 'no-store',
        'Cloudflare-CDN-Cache-Control': 'no-store',
        Pragma: 'no-cache',
        Expires: '0',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Frame-Options': 'SAMEORIGIN',
        'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    });
    res.vary('Cookie');
    res.vary('Authorization');
    res.vary('Origin');
    next();
}

// Ask an existing auth middleware for its decision without letting it answer the browser: it gets a stand-in response
// that only records the status. The middleware itself is not changed or re-implemented. Whatever it calls on the
// stand-in is accepted (headers, cookies…), so a later change to the middleware cannot make this throw; anything
// that ends a response counts as a refusal, and a redirect counts as "not signed in".
const ENDS_RESPONSE = new Set(['json', 'jsonp', 'send', 'end', 'render', 'sendFile', 'download']);
function decide(middleware, req) {
    return new Promise(resolve => {
        let settled = false, status = 200;
        const settle = value => { if (!settled) { settled = true; resolve(value); } };
        const refuse = code => settle({ pass: false, status: code });
        const probe = new Proxy({}, {
            get(_target, name) {
                if (typeof name !== 'string' || name === 'then') return undefined;
                if (name === 'statusCode') return status;
                if (name === 'headersSent') return false;
                if (name === 'status') return code => { status = code; return probe; };
                if (name === 'sendStatus') return code => { refuse(code); return probe; };
                if (name === 'redirect') return () => { refuse(401); return probe; };
                if (ENDS_RESPONSE.has(name)) return () => { refuse(status); return probe; };
                return () => probe;
            },
        });
        try { middleware(req, probe, error => settle(error ? { pass: false, status: 500 } : { pass: true })); } catch (_) { refuse(500); }
    });
}

const rates = new Map();
function limited(req) {
    const now = Date.now();
    if (rates.size >= 5000) for (const [key, value] of rates) if (value.until <= now) rates.delete(key);
    const key = crypto.createHash('sha256').update(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown').digest('hex');
    let rate = rates.get(key);
    if (!rate || rate.until <= now) {
        if (rates.size >= 5000 && !rate) return true;
        rate = { count: 0, until: now + 60000 };
        rates.set(key, rate);
    }
    return ++rate.count > 120;
}

function createRouters(options) {
    const { authMiddleware, adminMiddleware, getPool, getAuthPool, isReady, pageDir = PAGE_DIR } = options || {};
    if ([authMiddleware, adminMiddleware, getPool, getAuthPool, isReady].some(fn => typeof fn !== 'function')) throw new Error('Admin hub requires existing auth, admin and readiness middleware');
    const data = createData(options);
    const probes = hubStore.createProbes({ getPool, fetchImpl: options.fetchImpl, now: options.now });
    const unavailable = res => res.status(503).json({ success: false, error: 'Admin hub unavailable' });
    const clock = options.now || Date.now;
    const alerts = createAlerts({ loadHub: () => data.load(), latestServices: () => ({ success: true, checkedAt: clock(), services: probes.latest() }),
        fetchOps: options.fetchOps, now: clock, pageDir });

    // 'admin' | 'member' (signed in, not an administrator) | 'anonymous' | 'error'
    async function who(req) {
        const auth = await decide(authMiddleware, req);
        if (!auth.pass) return auth.status === 401 ? 'anonymous' : 'error';
        const admin = await decide(adminMiddleware, req);
        return admin.pass ? 'admin' : admin.status === 403 ? 'member' : 'error';
    }
    function readOnlySameOrigin(req, res, next) {
        const origin = req.get('origin');
        if (origin && !['https://eclawbot.com', 'https://www.eclawbot.com'].includes(origin)) return res.status(403).json({ success: false, error: 'Same-origin access required' });
        if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).set('Allow', 'GET, HEAD').json({ success: false, error: 'Read-only resource' });
        next();
    }
    const ready = (_req, res, next) => (isReady() ? next() : unavailable(res));
    // The API's one write (Hank 2026-11-13「以後略過類似警告」): POST /mutes and DELETE /mutes/<type>, only from the hub page
    // itself (the browser always sends Origin on these; a missing or foreign Origin is refused), and only for an administrator.
    const MUTES = /^\/mutes(\/[A-Za-z0-9._:-]{1,120})?$/;
    function sameOriginApi(req, res, next) {
        if (['GET', 'HEAD'].includes(req.method)) return readOnlySameOrigin(req, res, next);
        const write = (req.method === 'POST' && req.path === '/mutes') || (req.method === 'DELETE' && MUTES.test(req.path) && req.path !== '/mutes');
        if (!write) return res.status(405).set('Allow', 'GET, HEAD').json({ success: false, error: 'Read-only resource' });
        if (!['https://eclawbot.com', 'https://www.eclawbot.com'].includes(req.get('origin') || '')) return res.status(403).json({ success: false, error: 'Same-origin access required' });
        next();
    }

    // ---- the page: /AiHankApps/hub/ ----
    const files = new Map();
    function pageFile(name) {
        const file = path.join(pageDir, name), stat = fs.statSync(file), hit = files.get(name);
        if (hit && hit.mtimeMs === stat.mtimeMs) return hit.body;
        const body = fs.readFileSync(file);
        files.set(name, { mtimeMs: stat.mtimeMs, body });
        return body;
    }
    const page = express.Router();
    page.use(privateHeaders, ready, readOnlySameOrigin);
    page.use(async (req, res, next) => {
        const visitor = await who(req);
        if (visitor === 'admin') return next();
        // Someone opening the page in a browser is sent to sign in, or told plainly; scripts and styles just get the status.
        const navigating = req.method === 'GET' && (req.path === '/' || req.path === '/index.html') && /text\/html/.test(req.get('accept') || '');
        if (visitor === 'anonymous') return navigating ? res.redirect(302, LOGIN_URL) : res.status(401).json({ success: false, error: 'Not authenticated' });
        if (visitor === 'member') return navigating ? res.status(403).type('html').send(FORBIDDEN_PAGE) : res.status(403).json({ success: false, error: 'Admin access required' });
        return unavailable(res);
    });
    page.get(['/', '/index.html'], (req, res, next) => {
        // Relative script and style URLs need the trailing slash.
        if (req.path === '/' && !req.originalUrl.split('?')[0].endsWith('/')) return res.redirect(308, req.baseUrl + '/');
        req.url = '/index.html';
        next();
    });
    page.get('/:name', (req, res) => {
        const type = Object.prototype.hasOwnProperty.call(PAGE_FILES, req.params.name) ? PAGE_FILES[req.params.name] : null;
        if (!type) return res.status(404).json({ success: false, error: 'Admin hub page not found' });
        let body;
        try { body = pageFile(req.params.name); } catch (error) {
            console.error('[AiHankAppsHub] page file unavailable:', error.message);
            return unavailable(res);
        }
        res.set('Content-Type', type).set('Content-Length', String(body.length));
        return req.method === 'HEAD' ? res.end() : res.end(body);
    });
    page.use((_req, res) => res.status(404).json({ success: false, error: 'Admin hub page not found' }));

    // ---- the API: /api/aihankapps/hub/ ----
    const api = express.Router();
    api.use(privateHeaders, sameOriginApi);
    // The public portfolio asks this to decide whether to show the entry. It answers everyone, and says nothing else.
    api.get('/access', async (req, res) => {
        if (limited(req)) return res.status(429).set('Retry-After', '60').json({ success: false, admin: false });
        const admin = isReady() && await who(req) === 'admin';
        res.json({ success: true, admin });
    });
    api.use(ready, authMiddleware, adminMiddleware);
    // The last answer of each back-end's health check, from memory: cheap enough to ask every minute.
    api.get('/services', (_req, res) => res.json({ success: true, checkedAt: (options.now || Date.now)(), services: probes.latest() }));
    api.get('/data', async (req, res) => {
        try {
            res.json(await data.load({ fresh: req.query.fresh === '1' }));
        } catch (error) {
            console.error('[AiHankAppsHub] data failed:', error.message);
            unavailable(res);
        }
    });
    // Account sign-ups per app (counts only): the same rows the page shows.
    api.get('/accounts', async (req, res) => {
        try {
            const payload = await data.load({ fresh: req.query.fresh === '1' });
            res.json({ success: true, generatedAt: payload.generatedAt, generatedAtTaipei: taipeiTime(payload.generatedAt), timeZone: TIME_ZONE,
                note: 'status: connected = counted; not_connected = the app has accounts but no read-only count is wired yet; none = the app has no account sign-up; unknown = not confirmed yet. new7d/new30d count accounts created in the last 7/30 days.',
                accounts: payload.accounts || [] });
        } catch (error) {
            console.error('[AiHankAppsHub] accounts failed:', error.message);
            unavailable(res);
        }
    });
    // Alerts as the page shows them, each with its notification ID, source, rule, raw values and times.
    const ALERTS_NOTE = 'Alerts are computed from the current numbers and disappear when the condition clears; an ID that is no longer listed has cleared.';
    api.get('/alerts', async (req, res) => {
        try {
            const answer = await alerts.load({ fresh: req.query.fresh === '1' });
            res.json({ success: true, ...answer, count: answer.alerts.length, note: ALERTS_NOTE });
        } catch (error) {
            console.error('[AiHankAppsHub] alerts failed:', error.message);
            unavailable(res);
        }
    });
    api.get('/alerts/:id', async (req, res) => {
        const id = String(req.params.id || '');
        if (!/^[A-Za-z0-9._@-]{1,200}$/.test(id)) return res.status(400).json({ success: false, error: 'Invalid notification ID' });
        let answer;
        try { answer = await alerts.load({ fresh: req.query.fresh === '1' }); } catch (error) {
            console.error('[AiHankAppsHub] alerts failed:', error.message);
            return unavailable(res);
        }
        const hit = alerts.find(answer, id);
        if (!hit) return res.status(404).json({ success: false, error: 'No active alert with this notification ID (it may have cleared)', id,
            computedAt: answer.computedAt, computedAtTaipei: answer.computedAtTaipei, activeIds: answer.alerts.map(a => a.id) });
        res.json({ success: true, id, matchedBy: hit.matchedBy, computedAt: answer.computedAt, computedAtTaipei: answer.computedAtTaipei, alert: hit.alert, note: ALERTS_NOTE });
    });
    // 以後略過類似警告 (Hank, 2026-11-13): fold every alert of this kind into one information item; DELETE undoes it.
    const muteFailed = (res, error) => {
        if (/^MUTE_/.test(error.code || '')) return res.status(400).json({ success: false, error: error.code });
        console.error('[AiHankAppsHub] mute failed:', error.message);
        return unavailable(res);
    };
    api.post('/mutes', express.json({ limit: '2kb' }), async (req, res) => {
        try {
            const mute = await hubInbox.setMute(getPool(), req.body);
            data.invalidate(); alerts.invalidate();
            res.json({ success: true, mute });
        } catch (error) { muteFailed(res, error); }
    });
    api.delete('/mutes/:type', async (req, res) => {
        try {
            const result = await hubInbox.removeMute(getPool(), String(req.params.type || ''));
            data.invalidate(); alerts.invalidate();
            res.json({ success: true, ...result });
        } catch (error) { muteFailed(res, error); }
    });
    api.use((_req, res) => res.status(404).json({ success: false, error: 'Admin hub resource not found' }));

    return { page, api, data, probes, alerts };
}

module.exports = { createRouters, createData, createAlerts, ACCOUNT_APPS, privateHeaders, appsFromCatalog, parseReport, createDaily, readOnly, decide,
    dayIndex, isoDay, taipeiDay, PAGE_FILES, LOGIN_URL, HISTORY_DAYS, CHAT_DAYS, CONTENT_SECURITY_POLICY };
