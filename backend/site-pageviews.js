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

// Events we accept from unauthenticated public pages. Keeping a closed
// allowlist here stops a spammer from writing arbitrary paths into
// site_page_views, which would poison the analytics dashboards.
const CTA_EVENT_ALLOWLIST = new Set([
    'share-chat-view',         // share-chat.html pageview (not covered by
                               // pageviewMiddleware because /portal is excluded)
    'share-chat-register-cta', // "Create your own Bot" button click
]);

function isValidCtaEvent(name) {
    return typeof name === 'string' && CTA_EVENT_ALLOWLIST.has(name);
}

/**
 * Record a CTA / beacon event from a public page that the pageview
 * middleware can't otherwise see (e.g. anything under /portal). Writes
 * into the same `site_page_views` table with a synthetic `/_cta/<name>`
 * path so the existing aggregation endpoint can report it via `path=_cta/*`.
 *
 * Fire-and-forget like the middleware — never throws, never blocks callers.
 */
async function recordCtaEvent(pool, req, name) {
    if (!pool || !isValidCtaEvent(name)) return;
    const q = req.query || {};
    const params = [
        '/_cta/' + name,
        clientIp(req).substring(0, 64) || null,
        (req.headers['user-agent'] || '').substring(0, 512) || null,
        (req.headers['referer'] || req.headers['referrer'] || '').substring(0, 512) || null,
        q.utm_source ? String(q.utm_source).substring(0, 128) : null,
        q.utm_medium ? String(q.utm_medium).substring(0, 128) : null,
        q.utm_campaign ? String(q.utm_campaign).substring(0, 128) : null,
    ];
    try {
        await pool.query(
            `INSERT INTO site_page_views (path, ip, ua, referer, utm_source, utm_medium, utm_campaign)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            params
        );
    } catch {
        // swallow — CTA tracking must not break user flow
    }
}

/**
 * Convert a shell-style glob (with `*`) into a Postgres LIKE pattern.
 * `*` → `%`, other chars are escaped. Returns null if input is empty.
 */
function globToLike(glob) {
    if (!glob || typeof glob !== 'string') return null;
    const esc = glob.replace(/[\\%_]/g, ch => '\\' + ch);
    return esc.replace(/\*/g, '%');
}

/**
 * Aggregate pageviews over the last `days` days, optionally filtered by
 * a path glob. Returns totalViews, uniqueIPs, daily series, topPaths, byCampaign.
 */
async function queryPageviews(pool, { days = 7, path = null, topLimit = 20 } = {}) {
    if (!pool) throw new Error('pool not set');
    const d = Math.max(1, Math.min(365, parseInt(days, 10) || 7));
    const like = globToLike(path);
    // $1 = days, $2 = like-pattern or null. Using COALESCE so $2 NULL disables the filter.
    const whereTimeAndPath = `
        WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
          AND ($2::text IS NULL OR path ILIKE $2 ESCAPE '\\')
    `;
    const [totals, daily, topPaths, byCampaign] = await Promise.all([
        pool.query(
            `SELECT COUNT(*)::bigint AS total,
                    COUNT(DISTINCT ip)::bigint AS uniq
             FROM site_page_views ${whereTimeAndPath}`,
            [d, like]
        ),
        pool.query(
            `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date,
                    COUNT(*)::bigint AS views,
                    COUNT(DISTINCT ip)::bigint AS unique_ips
             FROM site_page_views ${whereTimeAndPath}
             GROUP BY 1 ORDER BY 1`,
            [d, like]
        ),
        pool.query(
            `SELECT path, COUNT(*)::bigint AS views
             FROM site_page_views ${whereTimeAndPath}
             GROUP BY path ORDER BY views DESC LIMIT $3`,
            [d, like, topLimit]
        ),
        pool.query(
            `SELECT utm_campaign, COUNT(*)::bigint AS views, COUNT(DISTINCT ip)::bigint AS unique_ips
             FROM site_page_views ${whereTimeAndPath}
               AND utm_campaign IS NOT NULL
             GROUP BY utm_campaign ORDER BY views DESC LIMIT $3`,
            [d, like, topLimit]
        ),
    ]);
    const t = totals.rows[0] || { total: 0, uniq: 0 };
    return {
        days: d,
        pathFilter: path || null,
        totalViews: Number(t.total),
        uniqueIPs: Number(t.uniq),
        daily: daily.rows.map(r => ({
            date: r.date,
            views: Number(r.views),
            uniqueIPs: Number(r.unique_ips),
        })),
        topPaths: topPaths.rows.map(r => ({
            path: r.path,
            views: Number(r.views),
        })),
        byCampaign: byCampaign.rows.map(r => ({
            utm_campaign: r.utm_campaign,
            views: Number(r.views),
            uniqueIPs: Number(r.unique_ips),
        })),
    };
}

module.exports = {
    initPageviewsTable,
    pageviewMiddleware,
    setPool,
    shouldTrack, // exported for unit tests
    globToLike,  // exported for unit tests
    queryPageviews,
    recordCtaEvent,
    isValidCtaEvent,
    CTA_EVENT_ALLOWLIST,
    EXCLUDE_PREFIXES,
    MARKETING_PREFIXES,
};
