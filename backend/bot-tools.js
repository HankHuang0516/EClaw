/**
 * Bot Tools API — Search & Web Fetch Proxy
 *
 * Provides search and web-fetch capabilities for OpenClaw bots
 * that lack built-in browser/search tools.
 *
 * Bots call these via exec+curl from their push instructions.
 *
 * Endpoints:
 *   GET /api/bot/web-search?q=...&deviceId=...&botSecret=...&entityId=...
 *   GET /api/bot/web-fetch?url=...&deviceId=...&botSecret=...&entityId=...
 */

const express = require('express');
const router = express.Router();

// ── Cache ──────────────────────────────────────────────────────
const searchCache = new Map();
const fetchCache = new Map();
const SEARCH_CACHE_TTL = 5 * 60 * 1000;  // 5 min
const FETCH_CACHE_TTL = 10 * 60 * 1000;  // 10 min
const MAX_CACHE_SIZE = 200;

function evictCache(cache, ttl) {
    if (cache.size > MAX_CACHE_SIZE) {
        const now = Date.now();
        for (const [key, val] of cache) {
            if (now - val.ts > ttl) cache.delete(key);
        }
    }
}

// ── Auth middleware ────────────────────────────────────────────
function authBot(req, res, next) {
    const { deviceId, botSecret, entityId } = req.query;
    if (!deviceId || !botSecret) {
        return res.status(400).json({ error: 'deviceId and botSecret required' });
    }
    // Attach to req for downstream use; actual validation happens via db lookup
    req.botAuth = { deviceId, botSecret, entityId: parseInt(entityId) || 0 };
    next();
}

// ── Rate limiting (per device) ────────────────────────────────
const rateLimits = new Map();
const RATE_WINDOW = 60 * 1000;  // 1 min
const MAX_REQUESTS = 10;        // 10 requests per minute per device

function checkRateLimit(deviceId) {
    const now = Date.now();
    let entry = rateLimits.get(deviceId);
    if (!entry || now - entry.windowStart > RATE_WINDOW) {
        entry = { windowStart: now, count: 0 };
        rateLimits.set(deviceId, entry);
    }
    entry.count++;
    return entry.count <= MAX_REQUESTS;
}

// Clean up rate limits periodically
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of rateLimits) {
        if (now - val.windowStart > RATE_WINDOW * 2) rateLimits.delete(key);
    }
}, 5 * 60 * 1000);

// ── Helper: strip HTML to plain text ──────────────────────────
function htmlToText(html) {
    return html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

// ── GET /api/bot/web-search ───────────────────────────────────
// Uses DuckDuckGo HTML to fetch search results (no API key needed)
router.get('/web-search', authBot, async (req, res) => {
    const { q, limit } = req.query;
    const { deviceId } = req.botAuth;

    if (!q || q.trim().length === 0) {
        return res.status(400).json({ error: 'q (query) parameter required' });
    }

    if (!checkRateLimit(deviceId)) {
        return res.status(429).json({ error: 'Rate limit exceeded. Max 10 requests per minute.' });
    }

    const maxResults = Math.min(parseInt(limit) || 8, 15);
    const query = q.trim().substring(0, 200); // Cap query length

    // Check cache
    const cacheKey = `search:${query}`;
    const cached = searchCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts < SEARCH_CACHE_TTL)) {
        return res.json({ ...cached.data, cached: true });
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        // Use DuckDuckGo HTML search (no API key needed)
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const response = await fetch(searchUrl, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        clearTimeout(timeout);

        if (!response.ok) {
            throw new Error(`Search returned status ${response.status}`);
        }

        const html = await response.text();

        // Parse DuckDuckGo HTML results
        const results = [];
        // Match result blocks: each has class "result" with link and snippet
        const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        let match;
        while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
            let url = match[1];
            // DuckDuckGo wraps URLs in redirect; extract actual URL
            const uddgMatch = url.match(/uddg=([^&]+)/);
            if (uddgMatch) {
                url = decodeURIComponent(uddgMatch[1]);
            }
            const title = htmlToText(match[2]);
            const snippet = htmlToText(match[3]);
            if (title && url) {
                results.push({ title, url, snippet });
            }
        }

        // Fallback: try alternate DuckDuckGo HTML structure
        if (results.length === 0) {
            const altRegex = /<a[^>]+rel="nofollow"[^>]+class="result__url"[^>]+href="([^"]*)"[^>]*>[\s\S]*?<\/a>[\s\S]*?<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\//g;
            while ((match = altRegex.exec(html)) !== null && results.length < maxResults) {
                let url = match[1];
                const uddgMatch = url.match(/uddg=([^&]+)/);
                if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
                const title = htmlToText(match[2]);
                const snippet = htmlToText(match[3]);
                if (title && url) {
                    results.push({ title, url, snippet });
                }
            }
        }

        const data = {
            query,
            results,
            resultCount: results.length,
            source: 'duckduckgo'
        };

        // Cache
        searchCache.set(cacheKey, { ts: Date.now(), data });
        evictCache(searchCache, SEARCH_CACHE_TTL);

        console.log(`[BotTools] web-search: "${query}" → ${results.length} results (device: ${deviceId})`);
        res.json(data);

    } catch (err) {
        if (err.name === 'AbortError') {
            return res.status(504).json({ error: 'Search timeout' });
        }
        console.error(`[BotTools] web-search error:`, err.message);
        res.status(500).json({ error: 'Search failed', detail: err.message });
    }
});

// ── GET /api/bot/web-fetch ────────────────────────────────────
// Fetches a URL and returns clean text content
router.get('/web-fetch', authBot, async (req, res) => {
    const { url, maxLength } = req.query;
    const { deviceId } = req.botAuth;

    if (!url) {
        return res.status(400).json({ error: 'url parameter required' });
    }

    if (!checkRateLimit(deviceId)) {
        return res.status(429).json({ error: 'Rate limit exceeded. Max 10 requests per minute.' });
    }

    // Validate URL
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return res.status(400).json({ error: 'Only http/https URLs supported' });
        }
    } catch {
        return res.status(400).json({ error: 'Invalid URL' });
    }

    // Block internal/private IPs
    const hostname = parsedUrl.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.startsWith('10.') || hostname === '0.0.0.0') {
        return res.status(403).json({ error: 'Internal URLs not allowed' });
    }

    const contentLimit = Math.min(parseInt(maxLength) || 5000, 15000);

    // Check cache
    const cacheKey = `fetch:${url}`;
    const cached = fetchCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts < FETCH_CACHE_TTL)) {
        return res.json({ ...cached.data, cached: true });
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; EClaw-Bot/1.0; +https://eclawbot.com)',
                'Accept': 'text/html, application/json, text/plain',
                'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8'
            },
            redirect: 'follow'
        });
        clearTimeout(timeout);

        if (!response.ok) {
            return res.status(502).json({ error: `Target returned status ${response.status}` });
        }

        const contentType = response.headers.get('content-type') || '';

        // Handle JSON responses directly
        if (contentType.includes('application/json')) {
            const text = await response.text();
            const data = {
                url,
                contentType: 'json',
                content: text.substring(0, contentLimit),
                length: text.length,
                truncated: text.length > contentLimit
            };
            fetchCache.set(cacheKey, { ts: Date.now(), data });
            evictCache(fetchCache, FETCH_CACHE_TTL);
            console.log(`[BotTools] web-fetch JSON: ${url} → ${text.length} chars (device: ${deviceId})`);
            return res.json(data);
        }

        // Handle HTML — strip to text
        if (contentType.includes('text/html')) {
            // Read up to 100KB of HTML
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let html = '';
            while (html.length < 100000) {
                const { done, value } = await reader.read();
                if (done) break;
                html += decoder.decode(value, { stream: true });
            }
            reader.cancel();

            // Extract title
            const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
            const title = titleMatch ? titleMatch[1].trim() : '';

            // Extract main content (try <main>, <article>, or <body>)
            let contentHtml = '';
            const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
            const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
            if (mainMatch) contentHtml = mainMatch[1];
            else if (articleMatch) contentHtml = articleMatch[1];
            else {
                const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
                contentHtml = bodyMatch ? bodyMatch[1] : html;
            }

            const text = htmlToText(contentHtml).substring(0, contentLimit);

            const data = {
                url,
                contentType: 'html',
                title,
                content: text,
                length: text.length,
                truncated: text.length >= contentLimit
            };
            fetchCache.set(cacheKey, { ts: Date.now(), data });
            evictCache(fetchCache, FETCH_CACHE_TTL);
            console.log(`[BotTools] web-fetch HTML: ${url} → ${text.length} chars (device: ${deviceId})`);
            return res.json(data);
        }

        // Handle plain text
        const text = await response.text();
        const data = {
            url,
            contentType: 'text',
            content: text.substring(0, contentLimit),
            length: text.length,
            truncated: text.length > contentLimit
        };
        fetchCache.set(cacheKey, { ts: Date.now(), data });
        evictCache(fetchCache, FETCH_CACHE_TTL);
        console.log(`[BotTools] web-fetch text: ${url} → ${text.length} chars (device: ${deviceId})`);
        return res.json(data);

    } catch (err) {
        if (err.name === 'AbortError') {
            return res.status(504).json({ error: 'Fetch timeout (10s)' });
        }
        console.error(`[BotTools] web-fetch error:`, err.message);
        res.status(500).json({ error: 'Fetch failed', detail: err.message });
    }
});

module.exports = { router };
