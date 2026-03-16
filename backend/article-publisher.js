// Article Publisher — Multi-platform article publishing
// Supported: Blogger, Hashnode, X/Twitter, DEV.to, WordPress.com, Telegraph, Qiita, WeChat,
//            Tumblr, Reddit, LinkedIn, Mastodon
const express = require('express');
const crypto = require('crypto');
const OAuth = require('oauth-1.0a');
const router = express.Router();

// ============================================
// PUBLISHER AUTH — optional API key gate
// ============================================
function requirePublisherAuth(req, res, next) {
    // GET /platforms is always public (read-only discovery)
    if (req.method === 'GET' && req.path === '/platforms') return next();
    // Read at request time so env changes take effect without restart
    const apiKey = process.env.PUBLISHER_API_KEY;
    // If PUBLISHER_API_KEY not set, skip auth (backward-compatible)
    if (!apiKey) return next();
    const key = req.headers['x-publisher-key'];
    if (key === apiKey) return next();
    res.status(401).json({ error: 'Invalid or missing X-Publisher-Key header' });
}

router.use(requirePublisherAuth);

// ============================================
// CONFIG
// ============================================
const BLOGGER_CLIENT_ID = process.env.BLOGGER_CLIENT_ID;
const BLOGGER_CLIENT_SECRET = process.env.BLOGGER_CLIENT_SECRET;
const BLOGGER_REDIRECT_URI = process.env.BLOGGER_REDIRECT_URI || 'https://eclawbot.com/api/publisher/blogger/oauth/callback';
const BLOGGER_SCOPE = 'https://www.googleapis.com/auth/blogger';
const HASHNODE_API_TOKEN = process.env.HASHNODE_API_TOKEN;
const HASHNODE_GQL_ENDPOINT = 'https://gql.hashnode.com';

// DEV.to (Forem API)
const DEVTO_API_KEY = process.env.DEVTO_API_KEY;
const DEVTO_API_BASE = 'https://dev.to/api';

// WordPress (supports OAuth2 with DB-backed tokens OR Application Password)
const WORDPRESS_CLIENT_ID = process.env.WORDPRESS_CLIENT_ID;
const WORDPRESS_CLIENT_SECRET = process.env.WORDPRESS_CLIENT_SECRET;
const WORDPRESS_REDIRECT_URI = process.env.WORDPRESS_REDIRECT_URI || 'https://eclawbot.com/api/publisher/wordpress/oauth/callback';
const WORDPRESS_ACCESS_TOKEN = process.env.WORDPRESS_ACCESS_TOKEN; // fallback: static env token
const WORDPRESS_API_BASE = 'https://public-api.wordpress.com';
const WORDPRESS_SITE_URL = (process.env.WORDPRESS_SITE_URL || '').replace(/\/+$/, '');
const WORDPRESS_USERNAME = process.env.WORDPRESS_USERNAME;
const WORDPRESS_APP_PASSWORD = process.env.WORDPRESS_APP_PASSWORD;
const WP_USE_APP_PASSWORD = !!(WORDPRESS_SITE_URL && WORDPRESS_USERNAME && WORDPRESS_APP_PASSWORD);

// Telegraph (Telegra.ph)
const TELEGRAPH_API_BASE = 'https://api.telegra.ph';
let telegraphAccessToken = process.env.TELEGRAPH_ACCESS_TOKEN || null;

// Qiita
const QIITA_ACCESS_TOKEN = process.env.QIITA_ACCESS_TOKEN;
const QIITA_API_BASE = 'https://qiita.com/api/v2';

// WeChat Official Account
const WECHAT_APP_ID = process.env.WECHAT_APP_ID;
const WECHAT_APP_SECRET = process.env.WECHAT_APP_SECRET;
const WECHAT_API_BASE = 'https://api.weixin.qq.com/cgi-bin';
let wechatTokenCache = { access_token: null, expires_at: 0 };

// Tumblr (API v2, OAuth 1.0a — reuse oauth-1.0a lib)
const TUMBLR_CONSUMER_KEY = process.env.TUMBLR_CONSUMER_KEY;
const TUMBLR_CONSUMER_SECRET = process.env.TUMBLR_CONSUMER_SECRET;
const TUMBLR_ACCESS_TOKEN = process.env.TUMBLR_ACCESS_TOKEN;
const TUMBLR_ACCESS_TOKEN_SECRET = process.env.TUMBLR_ACCESS_TOKEN_SECRET;
const TUMBLR_API_BASE = 'https://api.tumblr.com/v2';

// Reddit (OAuth2 password grant — script app)
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;
const REDDIT_USERNAME = process.env.REDDIT_USERNAME;
const REDDIT_PASSWORD = process.env.REDDIT_PASSWORD;
let redditTokenCache = { access_token: null, expires_at: 0 };

// LinkedIn (OAuth2 Bearer)
const LINKEDIN_ACCESS_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;
const LINKEDIN_PERSON_URN = process.env.LINKEDIN_PERSON_URN; // e.g. "urn:li:person:abc123"

// Mastodon (Bearer token, any instance)
const MASTODON_ACCESS_TOKEN = process.env.MASTODON_ACCESS_TOKEN;
const MASTODON_INSTANCE_URL = process.env.MASTODON_INSTANCE_URL || 'https://mastodon.social';

// ============================================
// DAILY RATE LIMITER — prevent platform bans from automated mass posting
// ============================================
const publishRateLimits = {
    qiita: { maxPerDay: 2, label: 'Qiita' },
    wordpress: { maxPerDay: 4, label: 'WordPress' },  // 2 sites × 2 posts
};
const publishCounters = new Map(); // key: "platform:YYYY-MM-DD" -> count

function checkPublishRateLimit(platform) {
    const limit = publishRateLimits[platform];
    if (!limit) return null; // no limit for this platform
    const today = new Date().toISOString().slice(0, 10);
    const key = `${platform}:${today}`;
    const count = publishCounters.get(key) || 0;
    if (count >= limit.maxPerDay) {
        return `${limit.label} daily publish limit reached (${limit.maxPerDay}/day) — skipping to avoid platform ban. Try again tomorrow.`;
    }
    return null;
}

function recordPublish(platform) {
    const today = new Date().toISOString().slice(0, 10);
    const key = `${platform}:${today}`;
    publishCounters.set(key, (publishCounters.get(key) || 0) + 1);
    // Clean old entries (keep only today)
    for (const k of publishCounters.keys()) {
        if (!k.endsWith(today)) publishCounters.delete(k);
    }
}

function rateLimitInfo(platform) {
    const limit = publishRateLimits[platform];
    if (!limit) return {};
    const today = new Date().toISOString().slice(0, 10);
    const key = `${platform}:${today}`;
    const used = publishCounters.get(key) || 0;
    return { rateLimit: { maxPerDay: limit.maxPerDay, usedToday: used, remaining: Math.max(0, limit.maxPerDay - used) } };
}

// Token store: DB-backed with in-memory cache
let _pool = null;
const bloggerTokens = new Map(); // in-memory cache: deviceId -> { access_token, refresh_token, expires_at, blog_id, blogs }
const wordpressTokens = new Map(); // in-memory cache: key -> { access_token, expires_at, sites }

function initPublisherTable(pool) {
    _pool = pool;
    pool.query(`
        CREATE TABLE IF NOT EXISTS blogger_tokens (
            device_id TEXT PRIMARY KEY,
            access_token TEXT,
            refresh_token TEXT,
            expires_at BIGINT,
            blog_id TEXT,
            blogs JSONB DEFAULT '[]',
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `).then(() => {
        console.log('[Publisher] blogger_tokens table ready');
        // Load existing tokens into memory cache
        return pool.query('SELECT * FROM blogger_tokens');
    }).then(result => {
        for (const row of result.rows) {
            bloggerTokens.set(row.device_id, {
                access_token: row.access_token,
                refresh_token: row.refresh_token,
                expires_at: Number(row.expires_at),
                blog_id: row.blog_id,
                blogs: row.blogs || []
            });
        }
        if (result.rows.length > 0) {
            console.log(`[Publisher] Loaded ${result.rows.length} Blogger token(s) from DB`);
        }
    }).catch(err => console.warn('[Publisher] blogger_tokens init:', err.message));

    // WordPress tokens table
    pool.query(`
        CREATE TABLE IF NOT EXISTS wordpress_tokens (
            token_key TEXT PRIMARY KEY,
            access_token TEXT NOT NULL,
            expires_at BIGINT NOT NULL,
            sites JSONB DEFAULT '[]',
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `).then(() => {
        console.log('[Publisher] wordpress_tokens table ready');
        return pool.query('SELECT * FROM wordpress_tokens');
    }).then(result => {
        for (const row of result.rows) {
            wordpressTokens.set(row.token_key, {
                access_token: row.access_token,
                expires_at: Number(row.expires_at),
                sites: row.sites || []
            });
        }
        if (result.rows.length > 0) {
            console.log(`[Publisher] Loaded ${result.rows.length} WordPress token(s) from DB`);
        }
    }).catch(err => console.warn('[Publisher] wordpress_tokens init:', err.message));
}

async function saveBloggerToken(deviceId) {
    const entry = bloggerTokens.get(deviceId);
    if (!_pool || !entry) return;
    await _pool.query(`
        INSERT INTO blogger_tokens (device_id, access_token, refresh_token, expires_at, blog_id, blogs, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (device_id) DO UPDATE SET
            access_token = EXCLUDED.access_token,
            refresh_token = EXCLUDED.refresh_token,
            expires_at = EXCLUDED.expires_at,
            blog_id = EXCLUDED.blog_id,
            blogs = EXCLUDED.blogs,
            updated_at = NOW()
    `, [deviceId, entry.access_token, entry.refresh_token, entry.expires_at, entry.blog_id, JSON.stringify(entry.blogs || [])]);
}

async function saveWordpressToken(key) {
    const entry = wordpressTokens.get(key);
    if (!_pool || !entry) return;
    await _pool.query(`
        INSERT INTO wordpress_tokens (token_key, access_token, expires_at, sites, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (token_key) DO UPDATE SET
            access_token = EXCLUDED.access_token,
            expires_at = EXCLUDED.expires_at,
            sites = EXCLUDED.sites,
            updated_at = NOW()
    `, [key, entry.access_token, entry.expires_at, JSON.stringify(entry.sites || [])]);
}

// Get a valid WordPress access token (DB-backed > env var fallback)
function getWordpressToken() {
    const entry = wordpressTokens.get('default');
    if (entry) {
        if (entry.expires_at > Date.now()) return { token: entry.access_token, sites: entry.sites };
        // Token expired
        return { token: null, expired: true, sites: entry.sites };
    }
    // Fallback to env var (static token, no expiry tracking)
    if (WORDPRESS_ACCESS_TOKEN) return { token: WORDPRESS_ACCESS_TOKEN, sites: [] };
    return { token: null, expired: false };
}

// Attach expiry warning to WordPress API responses when token expires in < 3 days
function wpExpiryWarning() {
    const entry = wordpressTokens.get('default');
    if (!entry) return undefined;
    const msLeft = entry.expires_at - Date.now();
    const daysLeft = msLeft / 86400000;
    if (daysLeft >= 3) return undefined;
    const renewUrl = WORDPRESS_CLIENT_ID ? 'https://eclawbot.com/api/publisher/wordpress/oauth/start' : null;
    if (daysLeft <= 0) return { warning: 'WordPress token has expired — please re-authorize now', daysLeft: 0, renewUrl };
    return {
        warning: `WordPress token expires in ${daysLeft < 1 ? 'less than 1 day' : Math.ceil(daysLeft) + ' day(s)'} — please renew soon`,
        daysLeft: Math.ceil(daysLeft),
        renewUrl
    };
}

// ============================================
// BLOGGER OAUTH FLOW
// ============================================

// Step 1: Start OAuth — redirect user to Google consent
router.get('/blogger/oauth/start', (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const state = crypto.randomBytes(16).toString('hex') + ':' + deviceId;
    const params = new URLSearchParams({
        client_id: BLOGGER_CLIENT_ID,
        redirect_uri: BLOGGER_REDIRECT_URI,
        response_type: 'code',
        scope: BLOGGER_SCOPE,
        access_type: 'offline',   // get refresh_token
        prompt: 'consent',        // force consent to ensure refresh_token
        state
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// Step 2: OAuth callback — exchange code for tokens
router.get('/blogger/oauth/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`OAuth error: ${error}`);
    if (!code || !state) return res.status(400).send('Missing code or state');

    const deviceId = state.split(':').slice(1).join(':');

    try {
        // Exchange code for tokens
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: BLOGGER_CLIENT_ID,
                client_secret: BLOGGER_CLIENT_SECRET,
                redirect_uri: BLOGGER_REDIRECT_URI,
                grant_type: 'authorization_code'
            })
        });
        const tokens = await tokenRes.json();
        if (tokens.error) return res.status(400).json({ error: tokens.error, description: tokens.error_description });

        // Store tokens
        bloggerTokens.set(deviceId, {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: Date.now() + (tokens.expires_in * 1000) - 60000 // 1min buffer
        });

        // Fetch blog list to auto-detect blog ID
        const blogsRes = await fetch('https://www.googleapis.com/blogger/v3/users/self/blogs', {
            headers: { Authorization: `Bearer ${tokens.access_token}` }
        });
        const blogs = await blogsRes.json();
        if (blogs.items && blogs.items.length > 0) {
            const entry = bloggerTokens.get(deviceId);
            entry.blogs = blogs.items.map(b => ({ id: b.id, name: b.name, url: b.url }));
            entry.blog_id = blogs.items[0].id; // default to first blog
        }

        // Persist to DB
        await saveBloggerToken(deviceId);

        res.send(`<h2>Blogger OAuth Success!</h2>
            <p>Device: ${deviceId}</p>
            <p>Blogs found: ${blogs.items ? blogs.items.length : 0}</p>
            <pre>${JSON.stringify(bloggerTokens.get(deviceId)?.blogs || [], null, 2)}</pre>
            <p>You can close this window.</p>`);
    } catch (err) {
        console.error('[Publisher] Blogger OAuth error:', err);
        res.status(500).send('OAuth exchange failed: ' + err.message);
    }
});

// Refresh access token if expired
async function refreshBloggerToken(deviceId) {
    const entry = bloggerTokens.get(deviceId);
    if (!entry?.refresh_token) throw new Error('No refresh token for device ' + deviceId);
    if (entry.expires_at > Date.now()) return entry.access_token; // still valid

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: BLOGGER_CLIENT_ID,
            client_secret: BLOGGER_CLIENT_SECRET,
            refresh_token: entry.refresh_token,
            grant_type: 'refresh_token'
        })
    });
    const data = await res.json();
    if (data.error) throw new Error(`Token refresh failed: ${data.error}`);

    entry.access_token = data.access_token;
    entry.expires_at = Date.now() + (data.expires_in * 1000) - 60000;
    saveBloggerToken(deviceId).catch(err => console.warn('[Publisher] Token persist error:', err.message));
    return entry.access_token;
}

// Check OAuth status
router.get('/blogger/status', (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    const entry = bloggerTokens.get(deviceId);
    if (!entry) return res.json({ authorized: false });
    res.json({
        authorized: true,
        blogs: entry.blogs || [],
        blog_id: entry.blog_id,
        token_expires_at: entry.expires_at
    });
});

// ============================================
// BLOGGER PUBLISH / DELETE
// ============================================

router.post('/blogger/publish', express.json(), async (req, res) => {
    const { deviceId, title, content, labels, blogId, isDraft } = req.body;
    if (!deviceId || !title || !content) {
        return res.status(400).json({ error: 'deviceId, title, content required' });
    }

    try {
        const token = await refreshBloggerToken(deviceId);
        const targetBlogId = blogId || bloggerTokens.get(deviceId)?.blog_id;
        if (!targetBlogId) return res.status(400).json({ error: 'No blog_id. Complete OAuth first.' });

        const url = `https://www.googleapis.com/blogger/v3/blogs/${targetBlogId}/posts` +
            (isDraft ? '?isDraft=true' : '');
        const postRes = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ kind: 'blogger#post', title, content, labels: labels || [] })
        });
        const post = await postRes.json();
        if (post.error) return res.status(postRes.status).json(post);

        console.log(`[Publisher] Blogger post created: ${post.id} "${title}"`);
        res.json({ success: true, platform: 'blogger', postId: post.id, url: post.url, title: post.title });
    } catch (err) {
        console.error('[Publisher] Blogger publish error:', err);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/blogger/post/:postId', async (req, res) => {
    const { deviceId } = req.query;
    const { postId } = req.params;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    try {
        const token = await refreshBloggerToken(deviceId);
        const blogId = bloggerTokens.get(deviceId)?.blog_id;
        if (!blogId) return res.status(400).json({ error: 'No blog_id' });

        const delRes = await fetch(
            `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/${postId}`,
            { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
        );
        if (delRes.status === 204 || delRes.ok) {
            console.log(`[Publisher] Blogger post deleted: ${postId}`);
            return res.json({ success: true, platform: 'blogger', deleted: postId });
        }
        const err = await delRes.json();
        res.status(delRes.status).json(err);
    } catch (err) {
        console.error('[Publisher] Blogger delete error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// HASHNODE PUBLISH / DELETE
// ============================================

async function hashnodeGQL(query, variables = {}) {
    const res = await fetch(HASHNODE_GQL_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: HASHNODE_API_TOKEN
        },
        body: JSON.stringify({ query, variables })
    });
    const data = await res.json();
    if (data.errors) throw new Error(data.errors.map(e => e.message).join('; '));
    return data.data;
}

// Get current user's publications
router.get('/hashnode/me', async (req, res) => {
    try {
        const data = await hashnodeGQL(`query { me { id username publications(first: 10) { edges { node { id title url } } } } }`);
        res.json({ success: true, user: data.me });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/hashnode/publish', express.json(), async (req, res) => {
    const { publicationId, title, contentMarkdown, tags, slug } = req.body;
    if (!publicationId || !title || !contentMarkdown) {
        return res.status(400).json({ error: 'publicationId, title, contentMarkdown required' });
    }

    try {
        const data = await hashnodeGQL(`
            mutation PublishPost($input: PublishPostInput!) {
                publishPost(input: $input) {
                    post { id title slug url }
                }
            }
        `, {
            input: {
                publicationId,
                title,
                contentMarkdown,
                slug: slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
                tags: tags ? tags.map(t => typeof t === 'string' ? { slug: t, name: t } : t) : []
            }
        });
        const post = data.publishPost.post;
        console.log(`[Publisher] Hashnode post created: ${post.id} "${title}"`);
        res.json({ success: true, platform: 'hashnode', postId: post.id, url: post.url, slug: post.slug });
    } catch (err) {
        console.error('[Publisher] Hashnode publish error:', err);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/hashnode/post/:postId', async (req, res) => {
    const { postId } = req.params;
    try {
        await hashnodeGQL(`
            mutation RemovePost($id: ID!) {
                removePost(input: { id: $id }) {
                    post { id }
                }
            }
        `, { id: postId });
        console.log(`[Publisher] Hashnode post deleted: ${postId}`);
        res.json({ success: true, platform: 'hashnode', deleted: postId });
    } catch (err) {
        console.error('[Publisher] Hashnode delete error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// X (TWITTER) PUBLISH / REPLY / DELETE
// Uses OAuth 1.0a (HMAC-SHA1) for Twitter API v2
// Tokens stored in env: X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
// ============================================

const X_API_BASE = 'https://api.x.com/2';

function getXOAuth() {
    return OAuth({
        consumer: {
            key: process.env.X_CONSUMER_KEY,
            secret: process.env.X_CONSUMER_SECRET
        },
        signature_method: 'HMAC-SHA1',
        hash_function(base_string, key) {
            return crypto.createHmac('sha1', key).update(base_string).digest('base64');
        }
    });
}

function getXToken() {
    return {
        key: process.env.X_ACCESS_TOKEN,
        secret: process.env.X_ACCESS_TOKEN_SECRET
    };
}

async function xApiRequest(method, path, body = null) {
    const url = `${X_API_BASE}${path}`;
    const oauth = getXOAuth();
    const token = getXToken();
    const authHeader = oauth.toHeader(oauth.authorize({ url, method }, token));

    const options = {
        method,
        headers: {
            ...authHeader,
            'Content-Type': 'application/json'
        }
    };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(url, options);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!res.ok) {
        const errMsg = data?.detail || data?.title || data?.errors?.[0]?.message || `HTTP ${res.status}`;
        const err = new Error(errMsg);
        err.status = res.status;
        err.xResponse = data;
        err.xHeaders = {
            'x-rate-limit-limit': res.headers.get('x-rate-limit-limit'),
            'x-rate-limit-remaining': res.headers.get('x-rate-limit-remaining'),
            'x-rate-limit-reset': res.headers.get('x-rate-limit-reset'),
            'x-app-limit-24hour-limit': res.headers.get('x-app-limit-24hour-limit'),
            'x-app-limit-24hour-remaining': res.headers.get('x-app-limit-24hour-remaining'),
        };
        throw err;
    }
    return data;
}

// POST /api/publisher/x/tweet — Create a tweet (or reply if reply_to is set)
router.post('/x/tweet', express.json(), async (req, res) => {
    const { text, reply_to } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    try {
        const body = { text };
        if (reply_to) body.reply = { in_reply_to_tweet_id: reply_to };

        const data = await xApiRequest('POST', '/tweets', body);
        console.log(`[Publisher] X tweet created: ${data.data?.id} ${reply_to ? '(reply to ' + reply_to + ')' : ''}`);
        res.json({
            success: true,
            platform: 'x',
            tweetId: data.data?.id,
            text: data.data?.text,
            isReply: !!reply_to
        });
    } catch (err) {
        console.error('[Publisher] X tweet error:', err);
        res.status(err.status || 500).json({ error: err.message, xResponse: err.xResponse, xHeaders: err.xHeaders });
    }
});

// DELETE /api/publisher/x/tweet/:tweetId — Delete a tweet
router.delete('/x/tweet/:tweetId', async (req, res) => {
    const { tweetId } = req.params;
    try {
        await xApiRequest('DELETE', `/tweets/${tweetId}`);
        console.log(`[Publisher] X tweet deleted: ${tweetId}`);
        res.json({ success: true, platform: 'x', deleted: tweetId });
    } catch (err) {
        console.error('[Publisher] X delete error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/publisher/x/me — Get authenticated user info
router.get('/x/me', async (req, res) => {
    try {
        const data = await xApiRequest('GET', '/users/me');
        res.json({ success: true, user: data.data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// DEV.to (Forem API v1) — Global developer community
// Auth: api-key header | Content: Markdown
// ============================================

function requireDevto(res) {
    if (!DEVTO_API_KEY) { res.status(501).json({ error: 'DEV.to not configured (DEVTO_API_KEY missing)' }); return false; }
    return true;
}

async function devtoRequest(method, path, body = null) {
    const options = {
        method,
        headers: {
            'api-key': DEVTO_API_KEY,
            'Accept': 'application/vnd.forem.api-v1+json',
            'Content-Type': 'application/json'
        }
    };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(`${DEVTO_API_BASE}${path}`, options);
    const data = await res.json();
    if (!res.ok) {
        const err = new Error(data.error || data.message || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return data;
}

// GET /api/publisher/devto/me
router.get('/devto/me', async (req, res) => {
    if (!requireDevto(res)) return;
    try {
        const data = await devtoRequest('GET', '/users/me');
        res.json({ success: true, user: { id: data.id, username: data.username, name: data.name } });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST /api/publisher/devto/publish
router.post('/devto/publish', express.json(), async (req, res) => {
    if (!requireDevto(res)) return;
    const { title, body_markdown, published, tags, series, canonical_url } = req.body;
    if (!title || !body_markdown) return res.status(400).json({ error: 'title, body_markdown required' });

    try {
        const article = { title, body_markdown, published: published !== false };
        if (tags) article.tags = tags;
        if (series) article.series = series;
        if (canonical_url) article.canonical_url = canonical_url;

        const data = await devtoRequest('POST', '/articles', { article });
        console.log(`[Publisher] DEV.to article created: ${data.id} "${title}"`);
        res.json({ success: true, platform: 'devto', postId: String(data.id), url: data.url, title: data.title, slug: data.slug });
    } catch (err) {
        console.error('[Publisher] DEV.to publish error:', err);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// PUT /api/publisher/devto/post/:postId
router.put('/devto/post/:postId', express.json(), async (req, res) => {
    if (!requireDevto(res)) return;
    const { postId } = req.params;
    const { title, body_markdown, published, tags, series, canonical_url } = req.body;

    try {
        const article = {};
        if (title !== undefined) article.title = title;
        if (body_markdown !== undefined) article.body_markdown = body_markdown;
        if (published !== undefined) article.published = published;
        if (tags !== undefined) article.tags = tags;
        if (series !== undefined) article.series = series;
        if (canonical_url !== undefined) article.canonical_url = canonical_url;

        const data = await devtoRequest('PUT', `/articles/${postId}`, { article });
        console.log(`[Publisher] DEV.to article updated: ${postId}`);
        res.json({ success: true, platform: 'devto', postId: String(data.id), url: data.url, title: data.title });
    } catch (err) {
        console.error('[Publisher] DEV.to update error:', err);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// DELETE /api/publisher/devto/post/:postId — unpublish (DEV.to doesn't support true delete via API)
router.delete('/devto/post/:postId', async (req, res) => {
    if (!requireDevto(res)) return;
    const { postId } = req.params;
    try {
        await devtoRequest('PUT', `/articles/${postId}`, { article: { published: false } });
        console.log(`[Publisher] DEV.to article unpublished: ${postId}`);
        res.json({ success: true, platform: 'devto', unpublished: String(postId) });
    } catch (err) {
        console.error('[Publisher] DEV.to unpublish error:', err);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// ============================================
// WORDPRESS.COM OAUTH FLOW
// ============================================

// Step 1: Start OAuth — redirect user to WordPress.com consent
router.get('/wordpress/oauth/start', (req, res) => {
    if (!WORDPRESS_CLIENT_ID || !WORDPRESS_CLIENT_SECRET) {
        return res.status(501).json({ error: 'WordPress OAuth not configured (need WORDPRESS_CLIENT_ID + WORDPRESS_CLIENT_SECRET)' });
    }
    const state = crypto.randomBytes(16).toString('hex');
    const params = new URLSearchParams({
        client_id: WORDPRESS_CLIENT_ID,
        redirect_uri: WORDPRESS_REDIRECT_URI,
        response_type: 'code',
        scope: 'global',
        state
    });
    res.redirect(`https://public-api.wordpress.com/oauth2/authorize?${params}`);
});

// Step 2: OAuth callback — exchange code for token, store in DB
router.get('/wordpress/oauth/callback', async (req, res) => {
    const { code, error: oauthError } = req.query;
    if (oauthError) return res.status(400).send(`OAuth error: ${oauthError}`);
    if (!code) return res.status(400).send('Missing authorization code');

    try {
        const tokenRes = await fetch('https://public-api.wordpress.com/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: WORDPRESS_CLIENT_ID,
                client_secret: WORDPRESS_CLIENT_SECRET,
                redirect_uri: WORDPRESS_REDIRECT_URI,
                code,
                grant_type: 'authorization_code'
            })
        });
        const tokens = await tokenRes.json();
        if (tokens.error) return res.status(400).json({ error: tokens.error, description: tokens.error_description });

        // WordPress.com tokens expire in ~14 days (1209600s)
        const expiresIn = tokens.expires_in || 1209600;
        const expiresAt = Date.now() + (expiresIn * 1000) - 60000; // 1min buffer

        // Fetch sites for this user
        const sitesRes = await fetch(`${WORDPRESS_API_BASE}/rest/v1.1/me/sites`, {
            headers: { Authorization: `Bearer ${tokens.access_token}` }
        });
        const sitesData = await sitesRes.json();
        const sites = (sitesData.sites || []).map(s => ({ id: s.ID, name: s.name, url: s.URL }));

        // Store in memory + DB
        wordpressTokens.set('default', {
            access_token: tokens.access_token,
            expires_at: expiresAt,
            sites
        });
        await saveWordpressToken('default');

        const expiryDate = new Date(expiresAt).toISOString().slice(0, 10);
        console.log(`[Publisher] WordPress OAuth success — ${sites.length} site(s), expires ${expiryDate}`);
        res.send(`<h2>WordPress OAuth Success!</h2>
            <p>Sites found: ${sites.length}</p>
            <ul>${sites.map(s => `<li>${s.name} — ${s.url} (ID: ${s.id})</li>`).join('')}</ul>
            <p>Token expires: ${expiryDate}</p>
            <p>You can close this window.</p>`);
    } catch (err) {
        console.error('[Publisher] WordPress OAuth error:', err);
        res.status(500).send('OAuth exchange failed: ' + err.message);
    }
});

// GET /api/publisher/wordpress/oauth/status — Check token status
router.get('/wordpress/oauth/status', (req, res) => {
    const wp = getWordpressToken();
    if (WP_USE_APP_PASSWORD) {
        return res.json({ configured: true, authMode: 'app_password', expires: null });
    }
    if (!wp.token && !wp.expired) {
        const authUrl = WORDPRESS_CLIENT_ID ? `/api/publisher/wordpress/oauth/start` : null;
        return res.json({ configured: false, authMode: null, authUrl });
    }
    const entry = wordpressTokens.get('default');
    const daysLeft = entry ? Math.max(0, Math.round((entry.expires_at - Date.now()) / 86400000)) : null;
    res.json({
        configured: !!wp.token,
        authMode: entry ? 'oauth2_db' : 'oauth2_env',
        expired: wp.expired || false,
        daysLeft,
        expiresAt: entry?.expires_at ? new Date(entry.expires_at).toISOString() : null,
        sites: wp.sites || [],
        renewUrl: WORDPRESS_CLIENT_ID ? `/api/publisher/wordpress/oauth/start` : null
    });
});

// ============================================
// WORDPRESS.COM (REST API) — Global blogging platform
// Auth: OAuth2 DB-backed | Bearer token fallback | Application Password
// ============================================

function requireWordpress(res) {
    if (WP_USE_APP_PASSWORD) return true;
    const wp = getWordpressToken();
    if (wp.token) return true;
    if (wp.expired) {
        const renewUrl = WORDPRESS_CLIENT_ID ? `https://eclawbot.com/api/publisher/wordpress/oauth/start` : null;
        res.status(401).json({
            error: 'WordPress token expired — please re-authorize',
            renewUrl,
            hint: renewUrl ? 'Visit renewUrl in your browser to re-authorize' : 'Set WORDPRESS_ACCESS_TOKEN env var'
        });
        return false;
    }
    res.status(501).json({ error: 'WordPress not configured (need OAuth setup or WORDPRESS_ACCESS_TOKEN or APP_PASSWORD)' });
    return false;
}

async function wordpressRequest(method, path, body = null) {
    const headers = { 'Content-Type': 'application/json' };
    let url;

    if (WP_USE_APP_PASSWORD) {
        const credentials = Buffer.from(`${WORDPRESS_USERNAME}:${WORDPRESS_APP_PASSWORD}`).toString('base64');
        headers.Authorization = `Basic ${credentials}`;
        url = `${WORDPRESS_SITE_URL}/wp-json${path}`;
    } else {
        const wp = getWordpressToken();
        if (!wp.token) {
            const err = new Error(wp.expired ? 'WordPress token expired — re-authorize at /api/publisher/wordpress/oauth/start' : 'WordPress not configured');
            err.status = 401;
            throw err;
        }
        headers.Authorization = `Bearer ${wp.token}`;
        url = `${WORDPRESS_API_BASE}${path}`;
    }

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(url, options);
    const data = await res.json();
    if (!res.ok) {
        let msg = data.message || data.error || `HTTP ${res.status}`;
        if (msg.includes('disabled')) {
            msg = 'WordPress.com free plan does not support the posts REST API — upgrade to a paid plan, or configure self-hosted WordPress with WORDPRESS_SITE_URL + WORDPRESS_USERNAME + WORDPRESS_APP_PASSWORD env vars';
        }
        const err = new Error(msg);
        err.status = res.status;
        throw err;
    }
    return data;
}

// GET /api/publisher/wordpress/me — Get user + sites
router.get('/wordpress/me', async (req, res) => {
    if (!requireWordpress(res)) return;
    try {
        if (WP_USE_APP_PASSWORD) {
            const user = await wordpressRequest('GET', '/wp/v2/users/me');
            res.json({
                success: true, authMode: 'app_password',
                user: { id: user.id, username: user.slug, display_name: user.name },
                sites: [{ id: 'default', name: user.name, url: WORDPRESS_SITE_URL }]
            });
        } else {
            const data = await wordpressRequest('GET', '/rest/v1.1/me');
            const sites = await wordpressRequest('GET', '/rest/v1.1/me/sites');
            res.json({
                success: true, authMode: 'oauth2',
                user: { id: data.ID, username: data.username, display_name: data.display_name },
                sites: (sites.sites || []).map(s => ({ id: s.ID, name: s.name, url: s.URL })),
                ...wpExpiryWarning()
            });
        }
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST /api/publisher/wordpress/publish
router.post('/wordpress/publish', express.json(), async (req, res) => {
    if (!requireWordpress(res)) return;
    const rateLimitMsg = checkPublishRateLimit('wordpress');
    if (rateLimitMsg) return res.status(429).json({ error: rateLimitMsg });
    const { siteId, title, content, status, categories, tags } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'title, content required' });
    if (!WP_USE_APP_PASSWORD && !siteId) return res.status(400).json({ error: 'siteId required for OAuth2 mode' });

    try {
        const postBody = { title, content, status: status || 'publish' };
        if (categories) postBody.categories = categories;
        if (tags) postBody.tags = tags;

        if (WP_USE_APP_PASSWORD) {
            const data = await wordpressRequest('POST', '/wp/v2/posts', postBody);
            recordPublish('wordpress');
            console.log(`[Publisher] WordPress post created (app_password): ${data.id} "${title}"`);
            res.json({ success: true, platform: 'wordpress', postId: String(data.id), url: data.link, title: data.title?.rendered || title, status: data.status });
        } else {
            const data = await wordpressRequest('POST', `/rest/v1.1/sites/${siteId}/posts/new`, postBody);
            recordPublish('wordpress');
            console.log(`[Publisher] WordPress post created: ${data.ID} "${title}"`);
            res.json({ success: true, platform: 'wordpress', postId: String(data.ID), url: data.URL, title: data.title, status: data.status, ...wpExpiryWarning() });
        }
    } catch (err) {
        console.error('[Publisher] WordPress publish error:', err);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// PUT /api/publisher/wordpress/post/:postId
router.put('/wordpress/post/:postId', express.json(), async (req, res) => {
    if (!requireWordpress(res)) return;
    const { postId } = req.params;
    const { siteId, title, content, status, categories, tags } = req.body;
    if (!WP_USE_APP_PASSWORD && !siteId) return res.status(400).json({ error: 'siteId required for OAuth2 mode' });

    try {
        const postBody = {};
        if (title !== undefined) postBody.title = title;
        if (content !== undefined) postBody.content = content;
        if (status !== undefined) postBody.status = status;
        if (categories !== undefined) postBody.categories = categories;
        if (tags !== undefined) postBody.tags = tags;

        if (WP_USE_APP_PASSWORD) {
            const data = await wordpressRequest('POST', `/wp/v2/posts/${postId}`, postBody);
            console.log(`[Publisher] WordPress post updated (app_password): ${postId}`);
            res.json({ success: true, platform: 'wordpress', postId: String(data.id), url: data.link, title: data.title?.rendered });
        } else {
            const data = await wordpressRequest('POST', `/rest/v1.1/sites/${siteId}/posts/${postId}`, postBody);
            console.log(`[Publisher] WordPress post updated: ${postId}`);
            res.json({ success: true, platform: 'wordpress', postId: String(data.ID), url: data.URL, title: data.title, ...wpExpiryWarning() });
        }
    } catch (err) {
        console.error('[Publisher] WordPress update error:', err);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// DELETE /api/publisher/wordpress/post/:postId
router.delete('/wordpress/post/:postId', async (req, res) => {
    if (!requireWordpress(res)) return;
    const { postId } = req.params;
    const { siteId } = req.query;
    if (!WP_USE_APP_PASSWORD && !siteId) return res.status(400).json({ error: 'siteId query param required for OAuth2 mode' });

    try {
        if (WP_USE_APP_PASSWORD) {
            await wordpressRequest('DELETE', `/wp/v2/posts/${postId}?force=true`);
        } else {
            await wordpressRequest('POST', `/rest/v1.1/sites/${siteId}/posts/${postId}/delete`);
        }
        console.log(`[Publisher] WordPress post deleted: ${postId}`);
        res.json({ success: true, platform: 'wordpress', deleted: postId, ...wpExpiryWarning() });
    } catch (err) {
        console.error('[Publisher] WordPress delete error:', err);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// ============================================
// TELEGRAPH (Telegra.ph API) — Instant publishing
// Auth: access_token (auto-created) | Content: HTML → Node format
// ============================================

function htmlToTelegraphNodes(html) {
    // Convert simple HTML to Telegraph Node format
    // Telegraph accepts: [{tag, attrs, children}] or plain strings
    const nodes = [];
    // Split by paragraphs, wrap in <p> if plain text
    const lines = html.split(/\n+/).filter(l => l.trim());
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('<')) {
            // Already HTML — pass as raw string (Telegraph API accepts HTML string in content)
            nodes.push(trimmed);
        } else {
            nodes.push({ tag: 'p', children: [trimmed] });
        }
    }
    return nodes.length > 0 ? nodes : [{ tag: 'p', children: [html] }];
}

async function telegraphRequest(method, body = {}) {
    const res = await fetch(`${TELEGRAPH_API_BASE}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!data.ok) {
        throw new Error(data.error || 'Telegraph API error');
    }
    return data.result;
}

async function ensureTelegraphAccount() {
    if (telegraphAccessToken) return telegraphAccessToken;
    // Auto-create account
    const result = await telegraphRequest('createAccount', {
        short_name: 'EClaw',
        author_name: 'EClaw Platform',
        author_url: 'https://eclawbot.com'
    });
    telegraphAccessToken = result.access_token;
    console.log('[Publisher] Telegraph account created automatically');
    return telegraphAccessToken;
}

// POST /api/publisher/telegraph/account — Create or get account
router.post('/telegraph/account', express.json(), async (req, res) => {
    try {
        const { short_name, author_name, author_url } = req.body;
        if (telegraphAccessToken) {
            // Return existing account info
            const info = await telegraphRequest('getAccountInfo', {
                access_token: telegraphAccessToken,
                fields: ['short_name', 'author_name', 'author_url', 'page_count']
            });
            return res.json({ success: true, platform: 'telegraph', account: info, existing: true });
        }
        const result = await telegraphRequest('createAccount', {
            short_name: short_name || 'EClaw',
            author_name: author_name || 'EClaw Platform',
            author_url: author_url || 'https://eclawbot.com'
        });
        telegraphAccessToken = result.access_token;
        console.log('[Publisher] Telegraph account created');
        res.json({ success: true, platform: 'telegraph', account: result });
    } catch (err) {
        console.error('[Publisher] Telegraph account error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/publisher/telegraph/publish
router.post('/telegraph/publish', express.json(), async (req, res) => {
    const { title, content, author_name, author_url } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'title, content required' });

    try {
        const token = await ensureTelegraphAccount();
        const page = await telegraphRequest('createPage', {
            access_token: token,
            title,
            content: htmlToTelegraphNodes(content),
            author_name: author_name || 'EClaw Platform',
            author_url: author_url || 'https://eclawbot.com',
            return_content: false
        });
        console.log(`[Publisher] Telegraph page created: "${title}" → ${page.url}`);
        res.json({ success: true, platform: 'telegraph', path: page.path, url: page.url, title: page.title });
    } catch (err) {
        console.error('[Publisher] Telegraph publish error:', err);
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/publisher/telegraph/page/:path — Edit page
router.put('/telegraph/page/:path', express.json(), async (req, res) => {
    const { path } = req.params;
    const { title, content, author_name, author_url } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'title, content required' });

    try {
        const token = await ensureTelegraphAccount();
        const page = await telegraphRequest('editPage', {
            access_token: token,
            path,
            title,
            content: htmlToTelegraphNodes(content),
            author_name: author_name || 'EClaw Platform',
            author_url: author_url || 'https://eclawbot.com',
            return_content: false
        });
        console.log(`[Publisher] Telegraph page updated: ${path}`);
        res.json({ success: true, platform: 'telegraph', path: page.path, url: page.url, title: page.title });
    } catch (err) {
        console.error('[Publisher] Telegraph edit error:', err);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// GET /api/publisher/telegraph/page/:path/views — Get page views
router.get('/telegraph/page/:path/views', async (req, res) => {
    const { path } = req.params;
    try {
        const views = await telegraphRequest('getViews', { path });
        res.json({ success: true, platform: 'telegraph', path, views: views.views });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// QIITA (API v2) — Japan's largest developer knowledge platform
// Auth: Bearer token | Content: Markdown
// Rate limit: 1000 req/hr (authenticated)
// ============================================

function requireQiita(res) {
    if (!QIITA_ACCESS_TOKEN) { res.status(501).json({ error: 'Qiita not configured (QIITA_ACCESS_TOKEN missing)' }); return false; }
    return true;
}

async function qiitaRequest(method, path, body = null) {
    const options = {
        method,
        headers: {
            Authorization: `Bearer ${QIITA_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
        }
    };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(`${QIITA_API_BASE}${path}`, options);
    if (res.status === 204) return null;
    const data = await res.json();
    if (!res.ok) {
        let msg = data.message || data.error || `HTTP ${res.status}`;
        if (res.status === 401) {
            msg = 'Qiita token expired or revoked — regenerate at https://qiita.com/settings/tokens/new (scopes: read_qiita, write_qiita) and update QIITA_ACCESS_TOKEN on Railway';
        }
        const err = new Error(msg);
        err.status = res.status;
        throw err;
    }
    return data;
}

// GET /api/publisher/qiita/me
router.get('/qiita/me', async (req, res) => {
    if (!requireQiita(res)) return;
    try {
        const data = await qiitaRequest('GET', '/authenticated_user');
        res.json({ success: true, user: { id: data.id, name: data.name, items_count: data.items_count, followers_count: data.followers_count } });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST /api/publisher/qiita/publish
router.post('/qiita/publish', express.json(), async (req, res) => {
    if (!requireQiita(res)) return;
    const rateLimitMsg = checkPublishRateLimit('qiita');
    if (rateLimitMsg) return res.status(429).json({ error: rateLimitMsg });
    const { title, body, tags, private: isPrivate, tweet } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'title, body required' });

    try {
        const item = {
            title,
            body,
            private: isPrivate || false,
            tweet: tweet || false,
            tags: (tags || []).map(t => typeof t === 'string' ? { name: t, versions: [] } : t)
        };
        if (item.tags.length === 0) item.tags = [{ name: 'EClaw', versions: [] }];

        const data = await qiitaRequest('POST', '/items', item);
        recordPublish('qiita');
        console.log(`[Publisher] Qiita article created: ${data.id} "${title}"`);
        res.json({ success: true, platform: 'qiita', postId: data.id, url: data.url, title: data.title });
    } catch (err) {
        console.error('[Publisher] Qiita publish error:', err);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// PUT /api/publisher/qiita/post/:postId
router.put('/qiita/post/:postId', express.json(), async (req, res) => {
    if (!requireQiita(res)) return;
    const { postId } = req.params;
    const { title, body, tags, private: isPrivate } = req.body;

    try {
        const item = {};
        if (title !== undefined) item.title = title;
        if (body !== undefined) item.body = body;
        if (isPrivate !== undefined) item.private = isPrivate;
        if (tags !== undefined) item.tags = tags.map(t => typeof t === 'string' ? { name: t, versions: [] } : t);

        const data = await qiitaRequest('PATCH', `/items/${postId}`, item);
        console.log(`[Publisher] Qiita article updated: ${postId}`);
        res.json({ success: true, platform: 'qiita', postId: data.id, url: data.url, title: data.title });
    } catch (err) {
        console.error('[Publisher] Qiita update error:', err);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// DELETE /api/publisher/qiita/post/:postId
router.delete('/qiita/post/:postId', async (req, res) => {
    if (!requireQiita(res)) return;
    const { postId } = req.params;
    try {
        await qiitaRequest('DELETE', `/items/${postId}`);
        console.log(`[Publisher] Qiita article deleted: ${postId}`);
        res.json({ success: true, platform: 'qiita', deleted: postId });
    } catch (err) {
        console.error('[Publisher] Qiita delete error:', err);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// ============================================
// WECHAT OFFICIAL ACCOUNT (微信公眾號) — China's dominant content platform
// Auth: AppID + AppSecret → access_token | Content: HTML
// Note: Creates drafts only — manual publish required from WeChat admin
// ============================================

function requireWechat(res) {
    if (!WECHAT_APP_ID || !WECHAT_APP_SECRET) { res.status(501).json({ error: 'WeChat not configured (WECHAT_APP_ID, WECHAT_APP_SECRET missing)' }); return false; }
    return true;
}

async function getWechatToken() {
    // Return cached token if still valid (with 5min buffer)
    if (wechatTokenCache.access_token && wechatTokenCache.expires_at > Date.now() + 300000) {
        return wechatTokenCache.access_token;
    }
    const res = await fetch(
        `${WECHAT_API_BASE}/token?grant_type=client_credential&appid=${WECHAT_APP_ID}&secret=${WECHAT_APP_SECRET}`
    );
    const data = await res.json();
    if (data.errcode) throw new Error(`WeChat token error: ${data.errcode} ${data.errmsg}`);
    wechatTokenCache = {
        access_token: data.access_token,
        expires_at: Date.now() + (data.expires_in * 1000)
    };
    console.log('[Publisher] WeChat access_token refreshed');
    return data.access_token;
}

// GET /api/publisher/wechat/token — Get/refresh access_token status
router.get('/wechat/token', async (req, res) => {
    if (!requireWechat(res)) return;
    try {
        const token = await getWechatToken();
        res.json({ success: true, platform: 'wechat', token_expires_at: wechatTokenCache.expires_at, has_token: !!token });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/publisher/wechat/upload-image — Upload cover image (permanent material)
router.post('/wechat/upload-image', async (req, res) => {
    if (!requireWechat(res)) return;

    try {
        const token = await getWechatToken();
        // Expect multipart/form-data with 'media' field
        // Forward the raw request body to WeChat
        const contentType = req.headers['content-type'];
        if (!contentType || !contentType.includes('multipart/form-data')) {
            return res.status(400).json({ error: 'Content-Type must be multipart/form-data with media field' });
        }

        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const rawBody = Buffer.concat(chunks);

        const wxRes = await fetch(
            `${WECHAT_API_BASE}/material/add_material?access_token=${token}&type=image`,
            { method: 'POST', headers: { 'Content-Type': contentType }, body: rawBody }
        );
        const data = await wxRes.json();
        if (data.errcode) return res.status(400).json({ error: `WeChat: ${data.errcode} ${data.errmsg}` });

        console.log(`[Publisher] WeChat image uploaded: ${data.media_id}`);
        res.json({ success: true, platform: 'wechat', media_id: data.media_id, url: data.url });
    } catch (err) {
        console.error('[Publisher] WeChat upload error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/publisher/wechat/draft — Create a draft article
router.post('/wechat/draft', express.json(), async (req, res) => {
    if (!requireWechat(res)) return;
    const { title, content, thumb_media_id, author, digest } = req.body;
    if (!title || !content || !thumb_media_id) {
        return res.status(400).json({ error: 'title, content, thumb_media_id required' });
    }

    try {
        const token = await getWechatToken();
        const article = {
            title,
            content,
            thumb_media_id,
            author: author || 'EClaw',
            digest: digest || title,
            show_cover_pic: 1,
            need_open_comment: 0,
            only_fans_can_comment: 0
        };

        const wxRes = await fetch(`${WECHAT_API_BASE}/draft/add?access_token=${token}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ articles: [article] })
        });
        const data = await wxRes.json();
        if (data.errcode) return res.status(400).json({ error: `WeChat: ${data.errcode} ${data.errmsg}` });

        console.log(`[Publisher] WeChat draft created: ${data.media_id} "${title}"`);
        res.json({ success: true, platform: 'wechat', media_id: data.media_id, title });
    } catch (err) {
        console.error('[Publisher] WeChat draft error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/publisher/wechat/drafts — List drafts
router.get('/wechat/drafts', async (req, res) => {
    if (!requireWechat(res)) return;
    try {
        const token = await getWechatToken();
        const offset = parseInt(req.query.offset) || 0;
        const count = Math.min(parseInt(req.query.count) || 20, 20);

        const wxRes = await fetch(`${WECHAT_API_BASE}/draft/batchget?access_token=${token}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ offset, count, no_content: 1 })
        });
        const data = await wxRes.json();
        if (data.errcode) return res.status(400).json({ error: `WeChat: ${data.errcode} ${data.errmsg}` });

        res.json({ success: true, platform: 'wechat', total_count: data.total_count, items: data.item || [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/publisher/wechat/draft/:mediaId
router.delete('/wechat/draft/:mediaId', async (req, res) => {
    if (!requireWechat(res)) return;
    const { mediaId } = req.params;
    try {
        const token = await getWechatToken();
        const wxRes = await fetch(`${WECHAT_API_BASE}/draft/delete?access_token=${token}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ media_id: mediaId })
        });
        const data = await wxRes.json();
        if (data.errcode) return res.status(400).json({ error: `WeChat: ${data.errcode} ${data.errmsg}` });

        console.log(`[Publisher] WeChat draft deleted: ${mediaId}`);
        res.json({ success: true, platform: 'wechat', deleted: mediaId });
    } catch (err) {
        console.error('[Publisher] WeChat delete error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// TUMBLR (API v2) — Global social blogging platform
// Auth: OAuth 1.0a | Content: NPF (Neue Post Format) / HTML
// ============================================

function requireTumblr(res) {
    if (!TUMBLR_CONSUMER_KEY || !TUMBLR_ACCESS_TOKEN) {
        res.status(501).json({ error: 'Tumblr not configured (TUMBLR_CONSUMER_KEY, TUMBLR_ACCESS_TOKEN missing)' });
        return false;
    }
    return true;
}

function getTumblrOAuth() {
    return OAuth({
        consumer: { key: TUMBLR_CONSUMER_KEY, secret: TUMBLR_CONSUMER_SECRET },
        signature_method: 'HMAC-SHA1',
        hash_function(base_string, key) {
            return crypto.createHmac('sha1', key).update(base_string).digest('base64');
        }
    });
}

async function tumblrRequest(method, path, body = null) {
    const url = `${TUMBLR_API_BASE}${path}`;
    const oauth = getTumblrOAuth();
    const token = { key: TUMBLR_ACCESS_TOKEN, secret: TUMBLR_ACCESS_TOKEN_SECRET };
    const authHeader = oauth.toHeader(oauth.authorize({ url, method }, token));

    const options = {
        method,
        headers: { ...authHeader, 'Content-Type': 'application/json' }
    };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(url, options);
    const data = await res.json();
    if (!res.ok) {
        const err = new Error(data.meta?.msg || data.errors?.[0]?.detail || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return data.response;
}

// GET /api/publisher/tumblr/me — Get user info + blogs
router.get('/tumblr/me', async (req, res) => {
    if (!requireTumblr(res)) return;
    try {
        const data = await tumblrRequest('GET', '/user/info');
        const user = data.user;
        res.json({
            success: true,
            user: { name: user.name, blogs: user.blogs.map(b => ({ name: b.name, url: b.url, title: b.title })) }
        });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST /api/publisher/tumblr/publish
router.post('/tumblr/publish', express.json(), async (req, res) => {
    if (!requireTumblr(res)) return;
    const { blogName, title, content, tags, state } = req.body;
    if (!blogName || !content) return res.status(400).json({ error: 'blogName, content required' });

    try {
        // Use NPF (Neue Post Format)
        const postBody = {
            content: [{ type: 'text', text: content, formatting: [] }],
            state: state || 'published',
            tags: tags ? tags.join(',') : ''
        };
        if (title) {
            // Prepend title as heading block
            postBody.content.unshift({ type: 'text', subtype: 'heading1', text: title });
        }

        const data = await tumblrRequest('POST', `/blog/${blogName}/posts`, postBody);
        console.log(`[Publisher] Tumblr post created: ${data.id} on ${blogName}`);
        res.json({
            success: true, platform: 'tumblr', postId: String(data.id),
            url: `https://${blogName}.tumblr.com/post/${data.id}`, blogName
        });
    } catch (err) {
        console.error('[Publisher] Tumblr publish error:', err);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// DELETE /api/publisher/tumblr/post/:postId
router.delete('/tumblr/post/:postId', async (req, res) => {
    if (!requireTumblr(res)) return;
    const { postId } = req.params;
    const { blogName } = req.query;
    if (!blogName) return res.status(400).json({ error: 'blogName query param required' });

    try {
        await tumblrRequest('POST', `/blog/${blogName}/post/delete`, { id: postId });
        console.log(`[Publisher] Tumblr post deleted: ${postId}`);
        res.json({ success: true, platform: 'tumblr', deleted: postId });
    } catch (err) {
        console.error('[Publisher] Tumblr delete error:', err);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// ============================================
// REDDIT (OAuth2 script app) — Global discussion platform
// Auth: OAuth2 password grant | Content: text/link
// ============================================

function requireReddit(res) {
    if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET || !REDDIT_USERNAME || !REDDIT_PASSWORD) {
        res.status(501).json({ error: 'Reddit not configured (REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD missing)' });
        return false;
    }
    return true;
}

async function getRedditToken() {
    if (redditTokenCache.access_token && redditTokenCache.expires_at > Date.now() + 60000) {
        return redditTokenCache.access_token;
    }
    const auth = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64');
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'EClaw:v1.0 (by /u/' + REDDIT_USERNAME + ')'
        },
        body: new URLSearchParams({
            grant_type: 'password',
            username: REDDIT_USERNAME,
            password: REDDIT_PASSWORD
        })
    });
    const data = await res.json();
    if (data.error) throw new Error(`Reddit auth: ${data.error}`);
    redditTokenCache = {
        access_token: data.access_token,
        expires_at: Date.now() + (data.expires_in * 1000)
    };
    return data.access_token;
}

async function redditRequest(method, path, body = null) {
    const token = await getRedditToken();
    const options = {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'EClaw:v1.0 (by /u/' + REDDIT_USERNAME + ')'
        }
    };
    if (body) options.body = new URLSearchParams(body);
    const res = await fetch(`https://oauth.reddit.com${path}`, options);
    const data = await res.json();
    if (!res.ok && !data.json) {
        const err = new Error(data.message || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return data;
}

// GET /api/publisher/reddit/me
router.get('/reddit/me', async (req, res) => {
    if (!requireReddit(res)) return;
    try {
        const token = await getRedditToken();
        const meRes = await fetch('https://oauth.reddit.com/api/v1/me', {
            headers: {
                Authorization: `Bearer ${token}`,
                'User-Agent': 'EClaw:v1.0 (by /u/' + REDDIT_USERNAME + ')'
            }
        });
        const data = await meRes.json();
        res.json({ success: true, user: { name: data.name, id: data.id, link_karma: data.link_karma, comment_karma: data.comment_karma } });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST /api/publisher/reddit/submit — Submit a text or link post
router.post('/reddit/submit', express.json(), async (req, res) => {
    if (!requireReddit(res)) return;
    const { subreddit, title, text, url: linkUrl, kind } = req.body;
    if (!subreddit || !title) return res.status(400).json({ error: 'subreddit, title required' });

    try {
        const postBody = {
            sr: subreddit,
            title,
            kind: kind || (linkUrl ? 'link' : 'self'),
            api_type: 'json'
        };
        if (linkUrl) postBody.url = linkUrl;
        if (text) postBody.text = text;

        const data = await redditRequest('POST', '/api/submit', postBody);
        const result = data.json?.data;
        if (data.json?.errors?.length > 0) {
            return res.status(400).json({ error: data.json.errors.map(e => e.join(': ')).join('; ') });
        }
        console.log(`[Publisher] Reddit post submitted to r/${subreddit}: ${result?.id}`);
        res.json({
            success: true, platform: 'reddit', postId: result?.id,
            url: result?.url, subreddit, title
        });
    } catch (err) {
        console.error('[Publisher] Reddit submit error:', err);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// DELETE /api/publisher/reddit/post/:postId — Delete (requires fullname t3_id)
router.delete('/reddit/post/:postId', async (req, res) => {
    if (!requireReddit(res)) return;
    const { postId } = req.params;
    try {
        const fullname = postId.startsWith('t3_') ? postId : `t3_${postId}`;
        await redditRequest('POST', '/api/del', { id: fullname });
        console.log(`[Publisher] Reddit post deleted: ${postId}`);
        res.json({ success: true, platform: 'reddit', deleted: postId });
    } catch (err) {
        console.error('[Publisher] Reddit delete error:', err);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// ============================================
// LINKEDIN (Posts API) — Professional publishing
// Auth: Bearer token | Content: text/article
// ============================================

function requireLinkedin(res) {
    if (!LINKEDIN_ACCESS_TOKEN || !LINKEDIN_PERSON_URN) {
        res.status(501).json({ error: 'LinkedIn not configured (LINKEDIN_ACCESS_TOKEN, LINKEDIN_PERSON_URN missing)' });
        return false;
    }
    return true;
}

async function linkedinRequest(method, path, body = null) {
    const options = {
        method,
        headers: {
            Authorization: `Bearer ${LINKEDIN_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': '202501'
        }
    };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(`https://api.linkedin.com${path}`, options);
    if (res.status === 204) return null;
    const data = await res.json();
    if (!res.ok) {
        const err = new Error(data.message || data.serviceErrorCode || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return data;
}

// GET /api/publisher/linkedin/me
router.get('/linkedin/me', async (req, res) => {
    if (!requireLinkedin(res)) return;
    try {
        const data = await linkedinRequest('GET', '/v2/userinfo');
        res.json({ success: true, user: { sub: data.sub, name: data.name, email: data.email, picture: data.picture } });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST /api/publisher/linkedin/publish — Create a post (text or article)
router.post('/linkedin/publish', express.json(), async (req, res) => {
    if (!requireLinkedin(res)) return;
    const { text, articleUrl, articleTitle, articleDescription, visibility } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    try {
        const postBody = {
            author: LINKEDIN_PERSON_URN,
            commentary: text,
            visibility: visibility || 'PUBLIC',
            distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
            lifecycleState: 'PUBLISHED'
        };

        // If article URL provided, add as article content
        if (articleUrl) {
            postBody.content = {
                article: {
                    source: articleUrl,
                    title: articleTitle || '',
                    description: articleDescription || ''
                }
            };
        }

        const data = await linkedinRequest('POST', '/rest/posts', postBody);
        // LinkedIn returns 201 with x-restli-id header for the post URN
        console.log(`[Publisher] LinkedIn post created`);
        res.json({ success: true, platform: 'linkedin', postId: data?.id || 'created' });
    } catch (err) {
        console.error('[Publisher] LinkedIn publish error:', err);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// DELETE /api/publisher/linkedin/post/:postUrn — Delete a post
router.delete('/linkedin/post/:postUrn', async (req, res) => {
    if (!requireLinkedin(res)) return;
    const { postUrn } = req.params;
    try {
        await linkedinRequest('DELETE', `/rest/posts/${encodeURIComponent(postUrn)}`);
        console.log(`[Publisher] LinkedIn post deleted: ${postUrn}`);
        res.json({ success: true, platform: 'linkedin', deleted: postUrn });
    } catch (err) {
        console.error('[Publisher] LinkedIn delete error:', err);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// ============================================
// MASTODON (API v1) — Decentralized social / Fediverse
// Auth: Bearer token | Content: text (500 chars default, varies by instance)
// ============================================

function requireMastodon(res) {
    if (!MASTODON_ACCESS_TOKEN) {
        res.status(501).json({ error: 'Mastodon not configured (MASTODON_ACCESS_TOKEN missing)' });
        return false;
    }
    return true;
}

async function mastodonRequest(method, path, body = null) {
    const options = {
        method,
        headers: {
            Authorization: `Bearer ${MASTODON_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
        }
    };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(`${MASTODON_INSTANCE_URL}${path}`, options);
    if (res.status === 204) return null;
    const data = await res.json();
    if (!res.ok) {
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return data;
}

// GET /api/publisher/mastodon/me
router.get('/mastodon/me', async (req, res) => {
    if (!requireMastodon(res)) return;
    try {
        const data = await mastodonRequest('GET', '/api/v1/accounts/verify_credentials');
        res.json({
            success: true,
            user: { id: data.id, username: data.username, display_name: data.display_name, url: data.url, instance: MASTODON_INSTANCE_URL }
        });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST /api/publisher/mastodon/publish — Post a status (toot)
router.post('/mastodon/publish', express.json(), async (req, res) => {
    if (!requireMastodon(res)) return;
    const { status, visibility, language, scheduled_at, in_reply_to_id } = req.body;
    if (!status) return res.status(400).json({ error: 'status required' });

    try {
        const postBody = { status, visibility: visibility || 'public' };
        if (language) postBody.language = language;
        if (scheduled_at) postBody.scheduled_at = scheduled_at;
        if (in_reply_to_id) postBody.in_reply_to_id = in_reply_to_id;

        const data = await mastodonRequest('POST', '/api/v1/statuses', postBody);
        console.log(`[Publisher] Mastodon status posted: ${data.id} on ${MASTODON_INSTANCE_URL}`);
        res.json({
            success: true, platform: 'mastodon', postId: data.id,
            url: data.url, instance: MASTODON_INSTANCE_URL
        });
    } catch (err) {
        console.error('[Publisher] Mastodon publish error:', err);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// DELETE /api/publisher/mastodon/post/:postId
router.delete('/mastodon/post/:postId', async (req, res) => {
    if (!requireMastodon(res)) return;
    const { postId } = req.params;
    try {
        await mastodonRequest('DELETE', `/api/v1/statuses/${postId}`);
        console.log(`[Publisher] Mastodon status deleted: ${postId}`);
        res.json({ success: true, platform: 'mastodon', deleted: postId });
    } catch (err) {
        console.error('[Publisher] Mastodon delete error:', err);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// ============================================
// UNIFIED PLATFORMS LISTING
// ============================================

router.get('/platforms', (req, res) => {
    const platforms = [
        { id: 'blogger', name: 'Blogger', region: 'global', authType: 'oauth', contentFormat: 'html',
          configured: !!(BLOGGER_CLIENT_ID && BLOGGER_CLIENT_SECRET) },
        { id: 'hashnode', name: 'Hashnode', region: 'global', authType: 'api_key', contentFormat: 'markdown',
          configured: !!HASHNODE_API_TOKEN },
        { id: 'x', name: 'X (Twitter)', region: 'global', authType: 'oauth1a', contentFormat: 'text',
          configured: !!(process.env.X_CONSUMER_KEY && process.env.X_ACCESS_TOKEN) },
        { id: 'devto', name: 'DEV.to', region: 'global', authType: 'api_key', contentFormat: 'markdown',
          configured: !!DEVTO_API_KEY },
        { id: 'wordpress', name: 'WordPress', region: 'global',
          authType: WP_USE_APP_PASSWORD ? 'basic' : 'bearer',
          authMode: WP_USE_APP_PASSWORD ? 'app_password' : (wordpressTokens.has('default') ? 'oauth2_db' : 'oauth2'),
          contentFormat: 'html',
          configured: WP_USE_APP_PASSWORD || !!getWordpressToken().token,
          ...wpExpiryWarning(), ...rateLimitInfo('wordpress') },
        { id: 'telegraph', name: 'Telegraph', region: 'global', authType: 'auto', contentFormat: 'html',
          configured: true },
        { id: 'qiita', name: 'Qiita', region: 'ja', authType: 'bearer', contentFormat: 'markdown',
          configured: !!QIITA_ACCESS_TOKEN, ...rateLimitInfo('qiita') },
        { id: 'wechat', name: 'WeChat Official Account', region: 'zh-CN', authType: 'app_credentials', contentFormat: 'html',
          configured: !!(WECHAT_APP_ID && WECHAT_APP_SECRET), draftsOnly: true },
        { id: 'tumblr', name: 'Tumblr', region: 'global', authType: 'oauth1a', contentFormat: 'npf',
          configured: !!(TUMBLR_CONSUMER_KEY && TUMBLR_ACCESS_TOKEN) },
        { id: 'reddit', name: 'Reddit', region: 'global', authType: 'oauth2_password', contentFormat: 'text',
          configured: !!(REDDIT_CLIENT_ID && REDDIT_USERNAME) },
        { id: 'linkedin', name: 'LinkedIn', region: 'global', authType: 'bearer', contentFormat: 'text',
          configured: !!(LINKEDIN_ACCESS_TOKEN && LINKEDIN_PERSON_URN) },
        { id: 'mastodon', name: 'Mastodon', region: 'global', authType: 'bearer', contentFormat: 'text',
          configured: !!MASTODON_ACCESS_TOKEN, instance: MASTODON_INSTANCE_URL }
    ];
    res.json({ success: true, platforms });
});

// ============================================
// HEALTH CHECK — test all platform auth tokens
// ============================================
router.get('/health', async (req, res) => {
    const results = [];

    // Helper: test a platform with a quick API call
    async function probe(id, name, fn) {
        const start = Date.now();
        try {
            const detail = await fn();
            results.push({ id, name, ok: true, ms: Date.now() - start, ...detail });
        } catch (err) {
            results.push({ id, name, ok: false, ms: Date.now() - start, error: err.message, status: err.status });
        }
    }

    await Promise.allSettled([
        // Blogger — check if OAuth tokens exist in DB
        probe('blogger', 'Blogger', async () => {
            if (!BLOGGER_CLIENT_ID) return { skip: true, reason: 'BLOGGER_CLIENT_ID not set' };
            // Blogger uses DB-backed OAuth; checking if we have stored tokens is enough
            return { configured: true };
        }),
        // Hashnode
        probe('hashnode', 'Hashnode', async () => {
            if (!HASHNODE_API_TOKEN) return { skip: true, reason: 'HASHNODE_API_TOKEN not set' };
            const r = await fetch(HASHNODE_GQL_ENDPOINT, {
                method: 'POST',
                headers: { Authorization: HASHNODE_API_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: '{ me { id username } }' })
            });
            const d = await r.json();
            if (d.errors) throw Object.assign(new Error(d.errors[0].message), { status: 401 });
            return { user: d.data?.me?.username };
        }),
        // DEV.to
        probe('devto', 'DEV.to', async () => {
            if (!DEVTO_API_KEY) return { skip: true, reason: 'DEVTO_API_KEY not set' };
            const r = await fetch(`${DEVTO_API_BASE}/users/me`, { headers: { 'api-key': DEVTO_API_KEY } });
            if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
            const d = await r.json();
            return { user: d.username };
        }),
        // WordPress
        probe('wordpress', 'WordPress', async () => {
            if (WP_USE_APP_PASSWORD) {
                const credentials = Buffer.from(`${WORDPRESS_USERNAME}:${WORDPRESS_APP_PASSWORD}`).toString('base64');
                const r = await fetch(`${WORDPRESS_SITE_URL}/wp-json/wp/v2/users/me`, {
                    headers: { Authorization: `Basic ${credentials}` }
                });
                if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
                return { authMode: 'app_password' };
            }
            const wp = getWordpressToken();
            if (!wp.token) return { skip: true, reason: wp.expired ? 'OAuth token expired' : 'Not configured' };
            // Test read endpoint
            const r = await fetch(`${WORDPRESS_API_BASE}/rest/v1.1/me`, {
                headers: { Authorization: `Bearer ${wp.token}` }
            });
            if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
            // Test write endpoint
            const wr = await fetch(`${WORDPRESS_API_BASE}/rest/v1.1/sites/253401752/posts/new`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${wp.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: '__health_check__', content: 'test', status: 'draft' })
            });
            if (!wr.ok) {
                const wd = await wr.json().catch(() => ({}));
                const msg = wd.message || wd.error || `HTTP ${wr.status}`;
                if (msg.includes('disabled')) {
                    return { authMode: 'oauth2', readOk: true, writeOk: false,
                        issue: 'WordPress.com has disabled the posts API for this site — free plan limitation. Upgrade to a paid plan or use self-hosted WordPress with Application Password auth.',
                        fix: 'Set WORDPRESS_SITE_URL + WORDPRESS_USERNAME + WORDPRESS_APP_PASSWORD env vars to use a self-hosted WordPress instead.' };
                }
                throw Object.assign(new Error(msg), { status: wr.status });
            }
            // If draft was created, delete it
            const wd = await wr.json();
            if (wd.ID) {
                await fetch(`${WORDPRESS_API_BASE}/rest/v1.1/sites/253401752/posts/${wd.ID}/delete`, {
                    method: 'POST', headers: { Authorization: `Bearer ${wp.token}` }
                }).catch(() => {});
            }
            return { authMode: 'oauth2', readOk: true, writeOk: true };
        }),
        // Qiita
        probe('qiita', 'Qiita', async () => {
            if (!QIITA_ACCESS_TOKEN) return { skip: true, reason: 'QIITA_ACCESS_TOKEN not set' };
            const r = await fetch(`${QIITA_API_BASE}/authenticated_user`, {
                headers: { Authorization: `Bearer ${QIITA_ACCESS_TOKEN}` }
            });
            if (!r.ok) {
                if (r.status === 401) {
                    throw Object.assign(new Error(
                        'Qiita token expired or revoked. Regenerate at https://qiita.com/settings/tokens/new (scopes: read_qiita, write_qiita) and update QIITA_ACCESS_TOKEN env var on Railway.'
                    ), { status: 401 });
                }
                throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
            }
            const d = await r.json();
            return { user: d.id };
        }),
        // X (Twitter)
        probe('x', 'X (Twitter)', async () => {
            if (!process.env.X_CONSUMER_KEY || !process.env.X_ACCESS_TOKEN) return { skip: true, reason: 'X credentials not set' };
            return { configured: true };
        }),
        // Tumblr
        probe('tumblr', 'Tumblr', async () => {
            if (!TUMBLR_CONSUMER_KEY || !TUMBLR_ACCESS_TOKEN) return { skip: true, reason: 'Tumblr credentials not set' };
            return { configured: true };
        }),
        // Mastodon
        probe('mastodon', 'Mastodon', async () => {
            if (!MASTODON_ACCESS_TOKEN) return { skip: true, reason: 'MASTODON_ACCESS_TOKEN not set' };
            const r = await fetch(`${MASTODON_INSTANCE_URL}/api/v1/accounts/verify_credentials`, {
                headers: { Authorization: `Bearer ${MASTODON_ACCESS_TOKEN}` }
            });
            if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
            const d = await r.json();
            return { user: d.username, instance: MASTODON_INSTANCE_URL };
        }),
        // Telegraph
        probe('telegraph', 'Telegraph', async () => {
            return { configured: true, note: 'Telegraph auto-creates accounts; always available' };
        }),
        // Reddit
        probe('reddit', 'Reddit', async () => {
            if (!REDDIT_CLIENT_ID || !REDDIT_USERNAME) return { skip: true, reason: 'Reddit credentials not set' };
            return { configured: true };
        }),
        // LinkedIn
        probe('linkedin', 'LinkedIn', async () => {
            if (!LINKEDIN_ACCESS_TOKEN) return { skip: true, reason: 'LINKEDIN_ACCESS_TOKEN not set' };
            return { configured: true };
        }),
    ]);

    const healthy = results.filter(r => r.ok && !r.issue);
    const issues = results.filter(r => !r.ok || r.issue);
    const skipped = results.filter(r => r.ok && r.skip);

    res.json({
        success: true,
        summary: { total: results.length, healthy: healthy.length - skipped.length, issues: issues.length, skipped: skipped.length },
        platforms: results
    });
});

module.exports = { router, initPublisherTable };
