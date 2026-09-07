const crypto = require('crypto');
const express = require('express');

const ORIGINS = new Set([
    'https://eclawbot.com',
    'https://www.eclawbot.com',
    'https://eclw.twopiggyhavefun.chatgpt.site',
    'https://rebound-tactical-archive.twopiggyhavefun.chatgpt.site',
]);
const preparations = new WeakMap();
const rates = new Map();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function prepare(pool) {
    if (!pool) return Promise.reject(new Error('Database unavailable'));
    if (!preparations.has(pool)) {
        const promise = (async () => {
            await pool.query(`CREATE TABLE IF NOT EXISTS app_portfolio_traffic_events (
                event_id UUID PRIMARY KEY,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )`);
            await pool.query(`CREATE TABLE IF NOT EXISTS app_portfolio_traffic_daily (
                day DATE NOT NULL,
                app_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK (action IN ('view', 'intro', 'google', 'apple')),
                count BIGINT NOT NULL DEFAULT 0 CHECK (count >= 0),
                PRIMARY KEY (day, app_id, action)
            )`);
        })().catch(error => {
            preparations.delete(pool);
            throw error;
        });
        preparations.set(pool, promise);
    }
    return preparations.get(pool);
}

function limited(req) {
    const now = Date.now();
    if (rates.size >= 5000) {
        for (const [key, value] of rates) if (value.until <= now) rates.delete(key);
    }
    const key = crypto.createHash('sha256').update(req.ip || req.socket.remoteAddress || 'unknown').digest('hex');
    let rate = rates.get(key);
    if (!rate || rate.until <= now) {
        if (rates.size >= 5000 && !rate) return true;
        rate = { count: 0, until: now + 60000 };
        rates.set(key, rate);
    }
    return ++rate.count > 120;
}

function createRouter(getPool) {
    const router = express.Router();
    const catalog = require('./public/AiHankApps/app-catalog.json').apps
        .filter(app => app.googlePackage !== 'com.twopigs.echoesofnames')
        .map(({ communityId, name, googlePackage, iosId, publicGoogle, publicApple }) =>
            ({ communityId, name, googlePackage, iosId, publicGoogle, publicApple }));
    const ids = new Set(catalog.map(app => app.communityId));
    router.use((req, res, next) => {
        const origin = req.get('origin');
        if (ORIGINS.has(origin) || (req.method === 'GET' && origin === 'null')) {
            res.set('Access-Control-Allow-Origin', origin);
            res.vary('Origin');
        }
        res.set('Cache-Control', 'no-store');
        next();
    });
    router.use(express.text({ type: 'text/plain', limit: '2kb' }));

    // Serve only the public identity fields, with the same explicit CORS policy
    // as events. Standalone introductions must not depend on static-file CORS.
    router.get('/catalog', (_req, res) => res.json({ apps: catalog }));

    router.get('/', async (_req, res) => {
        try {
            const pool = getPool();
            await prepare(pool);
            const result = await pool.query(`
                SELECT app_id, action, SUM(count)::text AS total,
                    COALESCE(SUM(count) FILTER (WHERE day = (NOW() AT TIME ZONE 'Asia/Taipei')::date), 0)::text AS today
                FROM app_portfolio_traffic_daily GROUP BY app_id, action
            `);
            const clock = await pool.query(`SELECT
                TO_CHAR(NOW() AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') AS day,
                (SELECT MIN(day)::text FROM app_portfolio_traffic_daily) AS "startedAt"`);
            const pair = () => ({ today: 0, total: 0 });
            const apps = Object.fromEntries([...ids].map(id => [id, {
                ...pair(), intro: pair(), google: pair(), apple: pair(),
            }]));
            let site = pair();
            for (const row of result.rows) {
                const count = { today: Number(row.today), total: Number(row.total) };
                if (!Number.isSafeInteger(count.today) || !Number.isSafeInteger(count.total)) throw new Error('Counter overflow');
                if (row.app_id === '__site__' && row.action === 'view') site = count;
                else if (apps[row.app_id] && ['intro', 'google', 'apple'].includes(row.action)) {
                    apps[row.app_id][row.action] = count;
                    apps[row.app_id].today += count.today;
                    apps[row.app_id].total += count.total;
                }
            }
            res.json({ success: true, schemaVersion: 1, timeZone: 'Asia/Taipei', ...clock.rows[0], site, apps });
        } catch (error) {
            console.error('[AppPortfolio] traffic read failed:', error.message);
            res.status(503).json({ success: false, error: 'Statistics temporarily unavailable' });
        }
    });

    router.post('/events', async (req, res) => {
        if (!ORIGINS.has(req.get('origin'))) return res.status(403).json({ success: false });
        if (limited(req)) return res.status(429).set('Retry-After', '60').json({ success: false });
        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch { return res.status(400).json({ success: false }); }
        }
        const { eventId, appId, action } = body || {};
        const validAction = appId === '__site__' ? action === 'view'
            : ids.has(appId) && ['intro', 'google', 'apple'].includes(action);
        if (typeof eventId !== 'string' || !UUID.test(eventId) || !validAction) {
            return res.status(400).json({ success: false });
        }
        try {
            const pool = getPool();
            await prepare(pool);
            // One atomic statement: concurrent retries cannot increment twice.
            const result = await pool.query(`
                WITH accepted AS (
                    INSERT INTO app_portfolio_traffic_events (event_id) VALUES ($1::uuid)
                    ON CONFLICT DO NOTHING RETURNING event_id
                )
                INSERT INTO app_portfolio_traffic_daily (day, app_id, action, count)
                SELECT (NOW() AT TIME ZONE 'Asia/Taipei')::date, $2, $3, 1 FROM accepted WHERE TRUE
                ON CONFLICT (day, app_id, action) DO UPDATE
                    SET count = app_portfolio_traffic_daily.count + 1
                RETURNING count
            `, [eventId, appId, action]);
            res.json({ success: true, accepted: result.rowCount > 0 });
        } catch (error) {
            console.error('[AppPortfolio] traffic write failed:', error.message);
            res.status(503).json({ success: false });
        }
    });
    return router;
}

module.exports = { createRouter };
