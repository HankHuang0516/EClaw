/**
 * Site Pageviews Module
 *
 * Tracks GET hits on marketing / public HTML pages (landing, enterprise,
 * privacy, docs, arena, plus any *.html that isn't under portal/api/assets/shared).
 * Portal pages already ship their own device-scoped telemetry via
 * /shared/telemetry.js; this module is the anonymous "non-logged-in visitor"
 * counterpart used by Card #21 (aggregated endpoint) + Card #22 (admin UI).
 *
 * Middleware is fire-and-forget: a failed INSERT must never block the user
 * from getting the page.
 */

const EXCLUDE_PREFIXES = ['/portal', '/api', '/assets', '/shared'];

// Marketing paths (prefix match, except '/' which is exact). Anything starting
// with one of these is tracked even if it doesn't end in .html.
const MARKETING_PREFIXES = ['/landing', '/enterprise', '/privacy-policy', '/docs', '/arena'];

let _pool = null;

function setPool(pool) {
    _pool = pool;
}

async function initPageviewsTable(pool) {
    if (!pool) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS site_page_views (
                id           BIGSERIAL   PRIMARY KEY,
                path         TEXT        NOT NULL,
                ip           TEXT,
                ua           TEXT,
                referer      TEXT,
                utm_source   TEXT,
                utm_medium   TEXT,
                utm_campaign TEXT,
                created_at   TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_spv_path_ts  ON site_page_views (path, created_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_spv_ts       ON site_page_views (created_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_spv_campaign ON site_page_views (utm_campaign) WHERE utm_campaign IS NOT NULL`);
        console.log('[Pageviews] Database table ready');
    } catch (err) {
        console.error('[Pageviews] Failed to create table:', err.message);
    }
}

function shouldTrack(req) {
    if (req.method !== 'GET') return false;
    const p = req.path;
    if (!p) return false;
    for (const ex of EXCLUDE_PREFIXES) {
        if (p === ex || p.startsWith(ex + '/')) return false;
    }
    if (p === '/') return true;
    if (p.endsWith('.html')) return true;
    for (const m of MARKETING_PREFIXES) {
        if (p === m || p.startsWith(m + '/') || p === m + '.html') return true;
    }
    return false;
}

function clientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    return (req.socket && req.socket.remoteAddress) || '';
}

function pageviewMiddleware() {
    return (req, res, next) => {
        try {
            if (_pool && shouldTrack(req)) {
                const q = req.query || {};
                const params = [
                    req.path,
                    clientIp(req).substring(0, 64) || null,
                    (req.headers['user-agent'] || '').substring(0, 512) || null,
                    (req.headers['referer'] || req.headers['referrer'] || '').substring(0, 512) || null,
                    q.utm_source ? String(q.utm_source).substring(0, 128) : null,
                    q.utm_medium ? String(q.utm_medium).substring(0, 128) : null,
                    q.utm_campaign ? String(q.utm_campaign).substring(0, 128) : null
                ];
                _pool.query(
                    `INSERT INTO site_page_views (path, ip, ua, referer, utm_source, utm_medium, utm_campaign)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    params
                ).catch(() => { /* swallow — tracking must not break user requests */ });
            }
        } catch {
            // never throw from tracking middleware
        }
        next();
    };
}

module.exports = {
    initPageviewsTable,
    pageviewMiddleware,
    setPool,
    shouldTrack, // exported for unit tests
    EXCLUDE_PREFIXES,
    MARKETING_PREFIXES,
};
