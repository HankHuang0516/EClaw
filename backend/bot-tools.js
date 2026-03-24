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

/** Auth middleware for POST endpoints (reads from req.body) */
function authBotPost(req, res, next) {
    const { deviceId, botSecret, deviceSecret, entityId } = req.body;
    if (!deviceId || (!botSecret && !deviceSecret)) {
        return res.status(400).json({ error: 'deviceId and botSecret (or deviceSecret) required' });
    }
    req.botAuth = { deviceId, botSecret: botSecret || deviceSecret, entityId: parseInt(entityId) || 0 };
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

    // Block internal/private IPs (RFC 1918, link-local, loopback, IPv6 private)
    const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
    const isPrivate = (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '0.0.0.0' ||
        hostname === '::1' ||
        hostname.startsWith('192.168.') ||
        hostname.startsWith('10.') ||
        hostname.startsWith('169.254.') ||
        hostname.startsWith('fc00:') || hostname.startsWith('fd') ||
        hostname.startsWith('fe80:') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    );
    if (isPrivate) {
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

// ── POST /api/bot/github-issue ─────────────────────────────────
// Proxy for bots to create GitHub issues (server holds the token)
// Rate limit: 5 issues/day per device
const issueCounters = new Map();
const MAX_ISSUES_PER_DAY = 5;

function checkIssueDailyLimit(deviceId) {
    const today = new Date().toISOString().slice(0, 10);
    const key = `${deviceId}:${today}`;
    const count = issueCounters.get(key) || 0;
    if (count >= MAX_ISSUES_PER_DAY) return false;
    // Clean old days
    for (const [k] of issueCounters) {
        if (!k.endsWith(today)) issueCounters.delete(k);
    }
    issueCounters.set(key, count + 1);
    return true;
}

router.post('/github-issue', authBotPost, async (req, res) => {
    const { deviceId } = req.botAuth;
    const { title, body, labels } = req.body;

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
        return res.status(400).json({ error: 'title required (string, non-empty)' });
    }
    if (title.length > 256) {
        return res.status(400).json({ error: 'title max 256 characters' });
    }
    if (body && typeof body !== 'string') {
        return res.status(400).json({ error: 'body must be a string' });
    }
    if (body && body.length > 10000) {
        return res.status(400).json({ error: 'body max 10000 characters' });
    }

    // Validate labels
    const issueLabels = ['bot-audit'];
    if (Array.isArray(labels)) {
        const ALLOWED_LABELS = [
            'skill-template', 'infrastructure', 'documentation',
            'feature-parity', 'community', 'bug', 'enhancement',
            'publisher', 'api-health', 'stale'
        ];
        for (const l of labels) {
            if (typeof l === 'string' && ALLOWED_LABELS.includes(l)) {
                issueLabels.push(l);
            }
        }
    }

    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;
    if (!token || !repo) {
        return res.status(501).json({ error: 'GitHub integration not configured (GITHUB_TOKEN / GITHUB_REPO)' });
    }

    if (!checkIssueDailyLimit(deviceId)) {
        return res.status(429).json({
            error: `Daily GitHub issue limit reached (${MAX_ISSUES_PER_DAY}/day). Try again tomorrow.`
        });
    }

    try {
        const ghRes = await fetch(`https://api.github.com/repos/${repo}/issues`, {
            method: 'POST',
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                title: title.trim(),
                body: (body || '').trim() + `\n\n---\n_Created by bot audit (entity #${req.botAuth.entityId}, device: ${deviceId.slice(0, 8)}…)_`,
                labels: issueLabels
            })
        });

        if (!ghRes.ok) {
            const err = await ghRes.text();
            console.error(`[BotTools] GitHub issue creation failed (${ghRes.status}):`, err);
            return res.status(502).json({ error: `GitHub API returned ${ghRes.status}` });
        }

        const data = await ghRes.json();
        console.log(`[BotTools] GitHub issue #${data.number} created by device ${deviceId.slice(0, 8)}…: ${title.trim()}`);
        res.json({
            success: true,
            issue: {
                number: data.number,
                url: data.html_url,
                title: data.title
            }
        });
    } catch (err) {
        console.error('[BotTools] GitHub API error:', err.message);
        res.status(500).json({ error: 'GitHub API request failed', detail: err.message });
    }
});

// ── POST /api/bot/audit-log ───────────────────────────────────
// Structured audit finding log — stored as Mission Dashboard notes
// with [AUDIT] prefix so local Claude can query & act on them.
router.post('/audit-log', authBotPost, async (req, res) => {
    const { deviceId } = req.botAuth;
    const { type, findings, summary, severity } = req.body;

    // Validate required fields
    const VALID_TYPES = [
        'url-validation', 'api-health', 'openapi-audit',
        'parity-audit', 'community-engagement', 'agent-card',
        'template-quality', 'general'
    ];
    if (!type || !VALID_TYPES.includes(type)) {
        return res.status(400).json({
            error: `type required, must be one of: ${VALID_TYPES.join(', ')}`
        });
    }
    if (!findings || !Array.isArray(findings)) {
        return res.status(400).json({ error: 'findings required (array of objects)' });
    }
    if (findings.length > 20) {
        return res.status(400).json({ error: 'findings max 20 items per log' });
    }

    const VALID_SEVERITIES = ['info', 'warning', 'critical'];
    const sev = VALID_SEVERITIES.includes(severity) ? severity : 'info';

    // Validate each finding
    for (const f of findings) {
        if (!f.item || typeof f.item !== 'string') {
            return res.status(400).json({ error: 'each finding must have "item" (string)' });
        }
        if (!f.status || !['ok', 'warning', 'error', 'dead', 'missing', 'stale'].includes(f.status)) {
            return res.status(400).json({
                error: 'each finding must have "status" (ok|warning|error|dead|missing|stale)'
            });
        }
    }

    // Build structured note for Mission Dashboard
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 16);

    const issueFindings = findings.filter(f => f.status !== 'ok');
    const okCount = findings.length - issueFindings.length;

    let content = `## Audit: ${type}\n`;
    content += `**Date:** ${dateStr} ${timeStr} UTC\n`;
    content += `**Severity:** ${sev}\n`;
    content += `**Entity:** #${req.botAuth.entityId}\n`;
    content += `**Results:** ${okCount}/${findings.length} OK\n\n`;

    if (issueFindings.length > 0) {
        content += `### Issues Found\n`;
        for (const f of issueFindings) {
            const icon = f.status === 'error' || f.status === 'dead' ? '❌' :
                         f.status === 'warning' || f.status === 'stale' ? '⚠️' : '❓';
            content += `- ${icon} **${f.item}**: ${f.status}`;
            if (f.detail) content += ` — ${f.detail}`;
            if (f.suggestion) content += ` → _${f.suggestion}_`;
            content += `\n`;
        }
    }

    if (summary) {
        content += `\n### Summary\n${summary}\n`;
    }

    // Store via Mission Dashboard note API (internal call)
    // We pass this to the caller to forward to mission/note/add
    // But since bot-tools doesn't have direct mission access,
    // return the formatted content so the schedule can store it.
    //
    // Also return as machine-readable JSON for local Claude.
    const noteTitle = `[AUDIT] ${type} — ${dateStr}`;

    res.json({
        success: true,
        audit: {
            type,
            severity: sev,
            date: dateStr,
            totalChecked: findings.length,
            issuesFound: issueFindings.length,
            findings,
            noteTitle,
            noteContent: content,
            // Pre-built curl for the bot to store in Mission Dashboard
            storageHint: `To persist this audit, POST to /api/mission/note/add with title="${noteTitle}" and the noteContent above.`
        }
    });

    console.log(`[BotTools] audit-log: type=${type}, severity=${sev}, findings=${findings.length}, issues=${issueFindings.length} (device: ${deviceId.slice(0, 8)}…)`);
});

// ── GET /api/bot/web-image-search ────────────────────────────
// Search for free-to-use images via Pexels API
// Returns direct image URLs that bots can embed in Markdown/HTML articles
router.get('/web-image-search', authBot, async (req, res) => {
    const { q, count, orientation } = req.query;
    const { deviceId } = req.botAuth;

    if (!q || !q.trim()) {
        return res.status(400).json({ error: 'q (search query) is required' });
    }
    if (q.length > 200) {
        return res.status(400).json({ error: 'q must be 200 chars or less' });
    }

    const apiKey = process.env.PEXELS_API_KEY;
    if (!apiKey) {
        return res.status(501).json({
            error: 'PEXELS_API_KEY not configured',
            hint: 'Get a free API key at https://www.pexels.com/api/ and set PEXELS_API_KEY env var'
        });
    }

    if (!checkRateLimit(deviceId)) {
        return res.status(429).json({ error: 'Rate limit exceeded (10/min)' });
    }

    const perPage = Math.min(Math.max(parseInt(count) || 3, 1), 10);
    const validOrientations = ['landscape', 'portrait', 'square'];
    const orient = validOrientations.includes(orientation) ? orientation : 'landscape';

    // Check cache
    const cacheKey = `img:${q}:${perPage}:${orient}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 10 * 60 * 1000) {
        return res.json({ ...cached.data, cached: true });
    }

    try {
        const params = new URLSearchParams({
            query: q.trim(),
            per_page: String(perPage),
            orientation: orient
        });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(`https://api.pexels.com/v1/search?${params}`, {
            headers: { Authorization: apiKey },
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            console.error(`[BotTools] Pexels API error ${response.status}: ${errText.slice(0, 200)}`);
            return res.status(502).json({ error: `Pexels API returned ${response.status}` });
        }

        const data = await response.json();
        const images = (data.photos || []).map(photo => ({
            url: photo.src.large,
            thumbnail: photo.src.medium,
            original: photo.src.original,
            alt: photo.alt || q.trim(),
            width: photo.width,
            height: photo.height,
            credit: photo.photographer,
            creditUrl: photo.photographer_url,
            pexelsUrl: photo.url,
            // Pre-built markdown for easy embedding
            markdown: `![${(photo.alt || q.trim()).replace(/[[\]]/g, '')}](${photo.src.large})`,
            attribution: `Photo by [${photo.photographer}](${photo.photographer_url}) on [Pexels](${photo.url})`
        }));

        const result = {
            query: q.trim(),
            images,
            resultCount: images.length,
            totalAvailable: data.total_results || 0,
            source: 'pexels',
            license: 'Free to use (Pexels License)',
            cached: false
        };

        // Cache result
        if (searchCache.size > 200) {
            const oldest = searchCache.keys().next().value;
            searchCache.delete(oldest);
        }
        searchCache.set(cacheKey, { data: result, ts: Date.now() });

        res.json(result);
        console.log(`[BotTools] image-search: q="${q.trim()}", results=${images.length} (device: ${deviceId.slice(0, 8)}…)`);
    } catch (err) {
        if (err.name === 'AbortError') {
            return res.status(504).json({ error: 'Image search timed out' });
        }
        console.error('[BotTools] image-search error:', err.message);
        res.status(500).json({ error: 'Image search failed' });
    }
});

module.exports = { router };
