// Claw Live Wallpaper Backend - Multi-Device Multi-Entity Support (v5.6)
// Each device has its own 4-8 entity slots (matrix architecture)
// v5.6 Changes: Enterprise features (TLS, Audit, Agent Card, OIDC, RBAC)
const express = require('express');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Server: SocketIO } = require('socket.io');
const db = require('./db');
const flickr = require('./flickr');
const gatekeeper = require('./gatekeeper');
const telemetry = require('./device-telemetry');
const feedbackModule = require('./device-feedback');
const chatIntegrity = require('./chat-integrity');
// JWT secret: fail-safe random per process if env var is missing (tokens signed in one process won't verify in another)
const JWT_SECRET_FALLBACK = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');
const scheduler = require('./scheduler');
const notifModule = require('./notifications');
const devicePrefs = require('./device-preferences');
const crossDeviceSettings = require('./entity-cross-device-settings');
const feedbackEmail = require('./feedback-email');
const multer = require('multer');
const crypto = require('crypto');
const WebSocket = require('ws');
const sanitizeHtml = require('sanitize-html');
const compression = require('compression');

const safeEqual = require('./safe-equal');

const app = express();
app.disable('x-powered-by');  // hide server technology from crawlers/attackers
app.set('trust proxy', 1); // Railway reverse proxy — makes req.ip, req.protocol accurate
app.use(compression());    // gzip/deflate all responses — reduces egress 60-80%
const httpServer = http.createServer(app);
const port = process.env.PORT || 3000;
const SERVER_STARTED_AT = new Date();
const SERVER_BUILD_TAG = `v5.6-${SERVER_STARTED_AT.toISOString().slice(0, 10).replace(/-/g, '')}`;


// ============================================
// SOCKET.IO SERVER
// ============================================
const io = new SocketIO(httpServer, {
    cors: {
        origin: (origin, cb) => {
            if (!origin) return cb(null, true);
            if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) return cb(null, true);
            if (['https://eclawbot.com', 'https://www.eclawbot.com', 'https://eclaw.up.railway.app'].includes(origin)) return cb(null, true);
            cb(null, false);
        },
        credentials: true
    },
    path: '/socket.io',
    allowEIO3: true, // backward compat with Android socket.io-client v2.1.0
    pingTimeout: 60000,
    pingInterval: 25000
});

// Socket.IO auth middleware
io.use((socket, next) => {
    // v4 clients use handshake.auth, v2 clients use handshake.query
    const deviceId = socket.handshake.auth?.deviceId || socket.handshake.query?.deviceId;
    const deviceSecret = socket.handshake.auth?.deviceSecret || socket.handshake.query?.deviceSecret;
    if (deviceId && deviceSecret) {
        const device = devices[deviceId];
        if (device && safeEqual(device.deviceSecret, deviceSecret)) {
            socket.deviceId = deviceId;
            return next();
        }
    }
    // JWT cookie path for web portal
    const cookies = socket.handshake.headers.cookie;
    if (cookies) {
        const jwt = require('jsonwebtoken');
        const tokenMatch = cookies.match(/token=([^;]+)/);
        if (tokenMatch) {
            try {
                const decoded = jwt.verify(tokenMatch[1], JWT_SECRET_FALLBACK);
                socket.deviceId = decoded.deviceId;
                socket.userId = decoded.userId;
                return next();
            } catch (e) { /* fall through */ }
        }
    }
    next(new Error('Authentication failed'));
});

io.on('connection', (socket) => {
    const deviceId = socket.deviceId;
    socket.join(`device:${deviceId}`);
    console.log(`[Socket.IO] Connected: device ${deviceId} (${io.engine.clientsCount} total)`);

    socket.on('disconnect', () => {
        console.log(`[Socket.IO] Disconnected: device ${deviceId}`);
    });
});

// Middleware

// Security headers (HSTS, anti-sniff, anti-clickjack)
app.use((req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Allow same-origin framing for /c/ (proxy window) and /p/ (public pages) routes used in enterprise demo
    const frameable = req.path.startsWith('/c/') || req.path.startsWith('/p/');
    res.setHeader('X-Frame-Options', frameable ? 'SAMEORIGIN' : 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // CSP: allow inline scripts/styles for portal pages, restrict external sources
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdn.socket.io https://accounts.google.com https://connect.facebook.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; img-src 'self' data: https: blob:; connect-src 'self' wss: https:; frame-src 'self' https:; frame-ancestors 'self'");
    next();
});

// HTTPS redirect (Railway terminates TLS, forwards X-Forwarded-Proto)
// Skip for health check path — Railway probes containers internally over HTTP
app.use((req, res, next) => {
    if (req.protocol === 'http' && req.hostname !== 'localhost' && req.hostname !== '127.0.0.1' && req.path !== '/api/health') {
        return res.redirect(301, `https://${req.hostname}${req.originalUrl}`);
    }
    next();
});

// Canonical domain redirect: www → non-www, old Railway domain → custom domain (portal only)
const CANONICAL_HOST = 'eclawbot.com';
app.use((req, res, next) => {
    const host = req.hostname;
    // Redirect www.eclawbot.com → eclawbot.com (all requests)
    if (host === 'www.' + CANONICAL_HOST) {
        return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
    }
    // Redirect old Railway domain → custom domain (portal pages only, not API)
    if (host === 'eclaw.up.railway.app' && req.path.startsWith('/portal')) {
        return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
    }
    next();
});

const cookieParser = require('cookie-parser');
const ALLOWED_ORIGINS = [
    'https://eclawbot.com',
    'https://www.eclawbot.com',
    'https://eclaw.up.railway.app'
];
app.use(cors({
    origin: (origin, cb) => {
        // Allow requests with no origin (mobile apps, curl, server-to-server)
        if (!origin) return cb(null, true);
        // Allow local development
        if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) return cb(null, origin);
        // Allow known production origins (credentials allowed)
        if (ALLOWED_ORIGINS.includes(origin)) return cb(null, origin);
        // Other origins: allow without credentials (Access-Control-Allow-Origin: * without Credentials header)
        cb(null, false);
    },
    credentials: true
}));
app.use('/api/ai-support/chat', express.json({ limit: '10mb' }));
app.use(express.json({
    verify: (req, _res, buf) => {
        // Capture raw body for Discord signature verification
        if (req.url && req.url.startsWith('/api/discord/interactions')) {
            req.rawBody = buf;
        }
    }
}));
app.use(cookieParser());

// SEO: serve robots.txt, sitemap.xml, llms.txt at root
app.get('/robots.txt', (req, res) => {
    res.type('text/plain').sendFile(path.join(__dirname, 'public/robots.txt'));
});
app.get('/sitemap.xml', (req, res) => {
    res.type('application/xml').sendFile(path.join(__dirname, 'public/sitemap.xml'));
});
app.get('/llms.txt', (req, res) => {
    res.type('text/plain').sendFile(path.join(__dirname, 'public/llms.txt'));
});
// Serve public assets (OG image, etc.) — cache aggressively to reduce egress
app.use('/assets', express.static(path.join(__dirname, 'public/assets'), {
    maxAge: '7d',
    immutable: true,
    setHeaders: (res, filePath) => {
        // Images/GIFs: cache 7 days + immutable (CDN won't revalidate)
        // JS: short cache for freshness
        if (filePath.endsWith('.js')) {
            res.set('Cache-Control', 'public, max-age=600, must-revalidate');
        }
    }
}));
// Landing page
app.get('/landing', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.join(__dirname, 'public/landing.html'));
});
// Enterprise page
app.get('/enterprise', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.join(__dirname, 'public/enterprise.html'));
});
// Info Hub page — redirect to /portal/info.html so relative asset paths resolve correctly
app.get('/info', (req, res) => {
    res.redirect(301, '/portal/info.html');
});

// Account deletion page — clean URL for Google Play Data Safety form
app.get('/delete-account', (req, res) => {
    res.redirect(301, '/portal/delete-account.html');
});

// ── Enterprise Demo Chat ─────────────────────────────────────
// Public endpoint — no auth required, rate-limited by IP
const entDemoRateMap = new Map();
const entDemoWebCache = new Map(); // { url -> { text, ts } }
const ENT_DEMO_LIMIT = 10;
const ENT_DEMO_WINDOW = 3600000;
const ENT_DEMO_MAX_CONTEXT = 8000;
const ENT_DEMO_MAX_HISTORY = 10;
const ENT_DEMO_RATE_MAP_CAP = 10000;
const ENT_DEMO_WEB_CACHE_TTL = 300000; // 5 min

function entDemoHtmlToText(html) {
    return html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ').trim();
}

function isPrivateIp(ip) {
    if (!ip) return false;
    if (ip === '127.0.0.1' || ip === '0.0.0.0' || ip === '::1') return true;
    if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
    const m172 = ip.match(/^172\.(\d+)\./);
    if (m172 && +m172[1] >= 16 && +m172[1] <= 31) return true;
    if (ip.startsWith('169.254.')) return true;
    const lower = ip.toLowerCase();
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true;
    return false;
}

/** DNS rebinding guard: resolve hostname, reject if it points to a private IP. Results cached 1 hour. */
const dnsLookup = require('util').promisify(require('dns').lookup);
const dnsResolveCache = new Map();
const DNS_RESOLVE_CACHE_TTL = 3600000;
async function assertPublicResolvedIp(hostname) {
    if (isPrivateHost(hostname)) throw new Error('Internal URLs not allowed');
    const cached = dnsResolveCache.get(hostname);
    if (cached && Date.now() - cached.ts < DNS_RESOLVE_CACHE_TTL) {
        if (cached.priv) throw new Error('Internal URLs not allowed');
        return;
    }
    const { address } = await dnsLookup(hostname);
    const priv = isPrivateIp(address);
    dnsResolveCache.set(hostname, { priv, ts: Date.now() });
    if (priv) throw new Error('Internal URLs not allowed');
}

function isPrivateHost(hostname) {
    if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1') return true;
    if (hostname === '127.0.0.1' || hostname.startsWith('10.') || hostname.startsWith('192.168.')) return true;
    // 172.16.0.0 – 172.31.255.255
    const m172 = hostname.match(/^172\.(\d+)\./);
    if (m172 && +m172[1] >= 16 && +m172[1] <= 31) return true;
    // Link-local (AWS/GCP metadata)
    if (hostname.startsWith('169.254.')) return true;
    // IPv6 private
    if (hostname.startsWith('[') && (hostname.includes('::1') || hostname.toLowerCase().startsWith('[fc') || hostname.toLowerCase().startsWith('[fd') || hostname.toLowerCase().startsWith('[fe80'))) return true;
    return false;
}

async function entDemoFetchWebsite(url) {
    const cached = entDemoWebCache.get(url);
    if (cached && Date.now() - cached.ts < ENT_DEMO_WEB_CACHE_TTL) return cached.text;

    // DNS rebinding protection: resolve hostname and verify resolved IP is not private
    await assertPublicResolvedIp(new URL(url).hostname);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const fetchRes = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EClawbot-Demo/1.0; +https://eclawbot.com)', 'Accept': 'text/html' },
        redirect: 'follow'
    });
    clearTimeout(timeout);
    if (!fetchRes.ok) return null;

    const html = (await fetchRes.text()).substring(0, 100000);
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    const body = mainMatch ? mainMatch[1] : (articleMatch ? articleMatch[1] : html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || html);
    const text = `--- Website Content (${url}) ---\nTitle: ${title}\n${entDemoHtmlToText(body).substring(0, ENT_DEMO_MAX_CONTEXT)}\n--- End Website Content ---`;
    entDemoWebCache.set(url, { text, ts: Date.now() });
    return text;
}

app.post('/api/enterprise-demo/chat', async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = entDemoRateMap.get(ip);
    if (!bucket || now - bucket.start > ENT_DEMO_WINDOW) {
        bucket = { start: now, count: 0 };
        if (entDemoRateMap.size < ENT_DEMO_RATE_MAP_CAP) {
            entDemoRateMap.set(ip, bucket);
        }
    }
    bucket.count++;
    if (bucket.count > ENT_DEMO_LIMIT) {
        return res.status(429).json({ error: 'rate_limited', message: 'Demo limit reached. Please try again later.' });
    }

    const { message, history, websiteUrl, fileContent, fileName } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'message is required' });
    }

    let contextBlock = '';
    if (websiteUrl && typeof websiteUrl === 'string') {
        try {
            const parsed = new URL(websiteUrl);
            if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol');
            if (isPrivateHost(parsed.hostname)) {
                return res.status(400).json({ error: 'Internal URLs not allowed' });
            }
            const webText = await entDemoFetchWebsite(websiteUrl);
            if (webText) contextBlock = '\n\n' + webText;
        } catch (err) {
            contextBlock = err.name === 'AbortError'
                ? `\n\n[Website fetch timed out for ${websiteUrl}]`
                : `\n\n[Could not fetch website: ${err.message}]`;
        }
    }
    if (fileContent && typeof fileContent === 'string') {
        const truncated = fileContent.substring(0, ENT_DEMO_MAX_CONTEXT);
        const label = fileName || 'uploaded file';
        contextBlock += `\n\n--- File Content (${label}) ---\n${truncated}\n--- End File Content ---`;
    }

    const systemPrompt = `You are an EClawbot enterprise demo assistant. You are showcasing the capabilities of EClawbot's AI agent platform to a potential business customer.

Your role: Act as if you are an AI agent deployed by the business. Based on the website or file content provided, demonstrate how an EClawbot agent can:
1. Understand the business context (products, services, FAQ, company info)
2. Answer customer questions about the business
3. Handle common customer service scenarios
4. Show how automation, scheduling, and multi-agent collaboration could help

Behavior:
- Be professional, friendly, and concise
- Reference specific details from the provided website/file content
- If no context is provided, explain what you could do with their website or docs
- Respond in the same language the user writes in
- Keep responses under 300 words
- Mention EClawbot features naturally (Proxy Window, Mission Control, A2A, multi-platform)
- Do NOT make up information about the business — only use what's in the provided context${contextBlock}`;

    try {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            return res.status(503).json({ error: 'Demo temporarily unavailable' });
        }

        const msgs = [];
        if (Array.isArray(history)) {
            for (const h of history.slice(-ENT_DEMO_MAX_HISTORY)) {
                if (h && h.role && h.content) {
                    msgs.push({ role: h.role === 'user' ? 'user' : 'assistant', content: String(h.content) });
                }
            }
        }
        msgs.push({ role: 'user', content: message.substring(0, 2000) });

        const cleaned = [];
        for (const m of msgs) {
            if (cleaned.length > 0 && cleaned[cleaned.length - 1].role === m.role) {
                cleaned[cleaned.length - 1].content += '\n' + m.content;
            } else {
                cleaned.push(m);
            }
        }
        while (cleaned.length > 0 && cleaned[0].role !== 'user') cleaned.shift();

        const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1024,
                system: systemPrompt,
                messages: cleaned
            }),
            signal: AbortSignal.timeout(20000)
        });

        if (!apiRes.ok) {
            console.error(`[EntDemo] Anthropic ${apiRes.status}`);
            return res.status(502).json({ error: 'AI service error' });
        }

        const result = await apiRes.json();
        const text = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        res.json({ success: true, response: text || 'No response generated.' });
    } catch (err) {
        console.error('[EntDemo] Error:', err.message);
        res.status(500).json({ error: 'Demo chat failed' });
    }
});

setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of entDemoRateMap) {
        if (now - bucket.start > ENT_DEMO_WINDOW) entDemoRateMap.delete(ip);
    }
    for (const [url, entry] of entDemoWebCache) {
        if (now - entry.ts > ENT_DEMO_WEB_CACHE_TTL) entDemoWebCache.delete(url);
    }
    for (const [h, entry] of dnsResolveCache) {
        if (now - entry.ts > DNS_RESOLVE_CACHE_TTL) dnsResolveCache.delete(h);
    }
}, 1800000).unref();

// Shareable chat link: /c/<publicCode>
// Logged-in users → redirect to chat.html with contact filter
// Not logged-in → serve read-only share-chat.html
app.get('/c/:code', (req, res) => {
    if (req.user && req.user.deviceId) {
        return res.redirect(`/portal/chat.html?contact=${encodeURIComponent(req.params.code)}`);
    }
    res.sendFile(path.join(__dirname, 'public/portal/share-chat.html'));
});

app.use('/mission', express.static(path.join(__dirname, 'public'), {
    etag: true,
    lastModified: true,
    maxAge: '10m'
}));
app.use('/portal', express.static(path.join(__dirname, 'public/portal'), {
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            // HTML: always revalidate (CDN can cache but must check freshness)
            res.set('Cache-Control', 'no-cache');
        } else if (filePath.endsWith('.js')) {
            // JS: short cache + must-revalidate — CDN serves 304 on unchanged files
            res.set('Cache-Control', 'public, max-age=60, must-revalidate');
        } else if (filePath.endsWith('.css')) {
            // CSS: cache 1 hour, CDN + browser
            res.set('Cache-Control', 'public, max-age=3600, must-revalidate');
        }
    }
}));
app.use('/shared', express.static(path.join(__dirname, 'public/shared'), {
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('i18n.js')) {
            // 1.6MB file — cache 10 min, CDN serves 304 after that (saves huge egress)
            res.set('Cache-Control', 'public, max-age=600, must-revalidate');
        } else {
            // telemetry.js etc. — cache 1 hour
            res.set('Cache-Control', 'public, max-age=3600, must-revalidate');
        }
    }
}));
app.use('/docs', express.static(path.join(__dirname, 'public/docs'), {
    etag: true,
    lastModified: true,
    maxAge: '1h'
}));

// Telemetry auto-capture middleware (pool linked lazily after chatPool init)
let _telemetryPool = null;
const telemetryPoolProxy = {
    query: function (...args) {
        return _telemetryPool ? _telemetryPool.query(...args) : Promise.resolve({ rows: [] });
    }
};
app.use(telemetry.createMiddleware(telemetryPoolProxy, (deviceId) => devices[deviceId]));

// ============================================
// DYNAMIC ENTITY ARCHITECTURE: devices[deviceId].entities[sparse integer keys]
// Each device starts with 1 entity slot, auto-expands on bind
// No upper limit — entity IDs are monotonically increasing, never reused
// ============================================

const DEFAULT_INITIAL_SLOTS = 1; // new devices start with 1 slot (entity #0)

// ============================================
// PLATFORM SLASH COMMANDS
// ============================================
const PLATFORM_COMMANDS = new Set(['help', 'status', 'reset']);

function parsePlatformCommand(text) {
    if (!text || !text.startsWith('/')) return null;
    const match = text.match(/^\/(\w+)(?:\s+(.*))?$/);
    if (!match) return null;
    const cmd = match[1].toLowerCase();
    if (!PLATFORM_COMMANDS.has(cmd)) return null;
    return { command: cmd, args: match[2] || '' };
}

async function handlePlatformCommand(command, deviceId, device, targetIds, confirmed) {
    switch (command) {
        case 'help':
            return {
                text: [
                    'Available Commands:',
                    '/help \u2014 Show this help message',
                    '/status \u2014 Check entity connection status',
                    '/reset \u2014 Clear conversation history',
                ].join('\n'),
                needsConfirmation: false
            };

        case 'status': {
            const lines = ['Entity Status:'];
            for (const eId of targetIds) {
                const entity = device.entities[eId];
                if (!entity) continue;
                const name = entity.name || `Entity ${eId}`;
                const character = entity.character || 'LOBSTER';
                const bound = entity.isBound ? 'Bound' : 'Unbound';
                const webhook = entity.webhook ? 'Push active' : 'Polling';
                const xp = entity.xp || 0;
                const level = entity.level || 1;
                lines.push(`#${eId} ${name} (${character}) \u2014 ${bound} \u2014 ${webhook} \u2014 XP: ${xp} Lv.${level}`);
            }
            return { text: lines.join('\n'), needsConfirmation: false };
        }

        case 'reset': {
            // Broadcast mode: require confirmation
            if (targetIds.length > 1 && !confirmed) {
                const names = targetIds.map(eId => {
                    const e = device.entities[eId];
                    return e ? (e.name || `Entity ${eId}`) : `Entity ${eId}`;
                }).join(', ');
                return {
                    text: `This will clear conversation history for ${targetIds.length} entities: ${names}.\nSend /reset again to confirm.`,
                    needsConfirmation: true,
                    confirmCommand: 'reset'
                };
            }

            // Execute reset
            const results = [];
            for (const eId of targetIds) {
                const entity = device.entities[eId];
                if (!entity) continue;
                try {
                    await chatPool.query(
                        'DELETE FROM chat_messages WHERE device_id = $1 AND entity_id = $2',
                        [deviceId, eId]
                    );
                    entity.messageQueue = [];
                    const name = entity.name || `Entity ${eId}`;
                    results.push(`#${eId} ${name}: history cleared`);
                } catch (err) {
                    results.push(`#${eId}: failed - ${err.message}`);
                }
            }
            return {
                text: 'Conversation Reset:\n' + results.join('\n'),
                needsConfirmation: false
            };
        }

        default:
            return { text: 'Unknown command.', needsConfirmation: false };
    }
}

// Helper: validate entity ID exists on a device (dynamic entity system)
function isValidEntityId(device, eId) {
    return Number.isInteger(eId) && eId >= 0 && device && device.entities.hasOwnProperty(eId);
}

// Helper: count entities on a device
function entityCount(device) {
    return Object.keys(device.entities).length;
}

// Helper: ensure at least one empty (unbound) slot exists on device
// Called after bind to auto-expand. Returns new entity ID or null.
function ensureOneEmptySlot(device) {
    const hasEmpty = Object.values(device.entities).some(e => !e.isBound);
    if (!hasEmpty) {
        const newId = device.nextEntityId++;
        device.entities[newId] = createDefaultEntity(newId);
        console.log(`[DynamicEntity] Auto-expand: deviceId=${device.deviceId}, newEntityId=${newId}, totalSlots=${entityCount(device)}`);
        return newId;
    }
    return null;
}

// Latest app version - update this with each release
// Bot will warn users if their app version is older than this
const LATEST_APP_VERSION = "1.0.62";
const FORCE_UPDATE_BELOW = null; // Set to version string (e.g. "1.0.30") to force-update anything below
const APP_RELEASE_NOTES = process.env.APP_RELEASE_NOTES || null;

// Device registry - each device has its own entities
const devices = {};

// Tracks whether persistence has finished loading (prevents transient empty responses during startup)
let persistenceReady = false;

// Pending binding codes (code -> { deviceId, entityId, expires })
const pendingBindings = {};

// Bot-to-bot loop prevention: token-bucket style — regenerates 1 token per minute, cap = BOT2BOT_MAX_MESSAGES
// Key: "deviceId:entityId" -> { count, lastRegenAt }
const botToBotCounter = {};
const BOT2BOT_MAX_MESSAGES = 8; // max bot-to-bot messages (bucket capacity)
const BOT2BOT_REGEN_INTERVAL_MS = 60 * 1000; // regenerate 1 token every 60 seconds
const recentBroadcasts = {}; // deviceId -> [{fromEntityId, text, timestamp}] for dedup

// Cross-device messaging
const publicCodeIndex = {}; // code -> { deviceId, entityId }
const crossSpeakCounter = {};
const crossDeviceOwnerRateLimit = {}; // owner-defined per-sender rate limit timestamps
const CROSS_SPEAK_MAX_MESSAGES = 4; // stricter limit for cross-device messages

function _regenBotToBotTokens(bucket) {
    const now = Date.now();
    const elapsed = now - bucket.lastRegenAt;
    const tokensToRegen = Math.floor(elapsed / BOT2BOT_REGEN_INTERVAL_MS);
    if (tokensToRegen > 0) {
        bucket.count = Math.max(0, bucket.count - tokensToRegen);
        bucket.lastRegenAt += tokensToRegen * BOT2BOT_REGEN_INTERVAL_MS;
    }
}

function checkBotToBotRateLimit(deviceId, entityId) {
    const key = `${deviceId}:${entityId}`;
    if (!botToBotCounter[key]) botToBotCounter[key] = { count: 0, lastRegenAt: Date.now() };
    _regenBotToBotTokens(botToBotCounter[key]);
    if (botToBotCounter[key].count >= BOT2BOT_MAX_MESSAGES) {
        return false; // rate limited
    }
    botToBotCounter[key].count++;
    return true; // allowed
}

function getBotToBotRemaining(deviceId, entityId) {
    const key = `${deviceId}:${entityId}`;
    if (!botToBotCounter[key]) return BOT2BOT_MAX_MESSAGES;
    _regenBotToBotTokens(botToBotCounter[key]);
    return Math.max(0, BOT2BOT_MAX_MESSAGES - botToBotCounter[key].count);
}

// Reset bot-to-bot counter when human sends a message (called from /api/client/speak)
function resetBotToBotCounter(deviceId) {
    const prefix = `${deviceId}:`;
    for (const key of Object.keys(botToBotCounter)) {
        if (key.startsWith(prefix)) botToBotCounter[key] = { count: 0, lastRegenAt: Date.now() };
    }
    for (const key of Object.keys(crossSpeakCounter)) {
        if (key.startsWith(prefix)) crossSpeakCounter[key] = 0;
    }
    // Also clear broadcast dedup cache for this device so human-initiated broadcasts work fresh
    delete recentBroadcasts[deviceId];
}

function checkCrossSpeakRateLimit(deviceId, entityId) {
    const key = `${deviceId}:${entityId}`;
    if (!crossSpeakCounter[key]) crossSpeakCounter[key] = 0;
    if (crossSpeakCounter[key] >= CROSS_SPEAK_MAX_MESSAGES) return false;
    crossSpeakCounter[key]++;
    return true;
}

function getCrossSpeakRemaining(deviceId, entityId) {
    const key = `${deviceId}:${entityId}`;
    const used = crossSpeakCounter[key] || 0;
    return Math.max(0, CROSS_SPEAK_MAX_MESSAGES - used);
}

// Official bot pool (loaded from DB on startup)
const officialBots = {};

// ============================================
// DATA PERSISTENCE (Fix for Bug #2: Survive Railway Redeployment)
// PostgreSQL with file-based fallback
// ============================================

const AUTO_SAVE_INTERVAL = 30000; // Auto-save every 30 seconds
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'devices.json');
let usePostgreSQL = false; // Will be set to true if PostgreSQL is available

// Ensure data directory exists (for fallback)
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Save devices data (PostgreSQL primary, file fallback)
async function saveData() {
    const deviceCount = Object.keys(devices).length;
    if (deviceCount === 0) return true;

    if (usePostgreSQL) {
        // Save to PostgreSQL
        return await db.saveAllDevices(devices);
    } else {
        // Fallback to file storage
        try {
            const data = {
                devices: devices,
                savedAt: Date.now(),
                version: LATEST_APP_VERSION
            };
            fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
            console.log(`[File] Data saved: ${deviceCount} devices`);
            return true;
        } catch (err) {
            console.error('[File] Failed to save data:', err.message);
            return false;
        }
    }
}

// Load devices data (PostgreSQL primary, file fallback)
async function loadData() {
    if (usePostgreSQL) {
        // Load from PostgreSQL
        const loadedDevices = await db.loadAllDevices();
        Object.assign(devices, loadedDevices);
        return Object.keys(loadedDevices).length > 0;
    } else {
        // Fallback to file storage
        try {
            if (!fs.existsSync(DATA_FILE)) {
                console.log('[File] No existing data file found, starting fresh');
                return false;
            }

            const fileContent = fs.readFileSync(DATA_FILE, 'utf8');
            const data = JSON.parse(fileContent);

            if (data.devices) {
                Object.assign(devices, data.devices);
                console.log(`[File] Data loaded: ${Object.keys(devices).length} devices restored`);

                let boundCount = 0;
                for (const deviceId in devices) {
                    for (const i of Object.keys(devices[deviceId].entities).map(Number)) {
                        if (devices[deviceId].entities[i]?.isBound) boundCount++;
                    }
                }
                console.log(`[File] ${boundCount} bound entities restored`);
                return true;
            }
            return false;
        } catch (err) {
            console.error('[File] Failed to load data:', err.message);
            return false;
        }
    }
}

// Initialize database and load data
async function initPersistence() {
    console.log('[Persistence] Initializing...');

    // Try PostgreSQL first
    usePostgreSQL = await db.initDatabase();

    if (usePostgreSQL) {
        console.log('[Persistence] Using PostgreSQL (primary)');
    } else {
        console.log('[Persistence] Using file storage (fallback)');
        console.log('[Persistence] To enable PostgreSQL: Add PostgreSQL service in Railway');
    }

    // Load existing data
    await loadData();

    // Load official bot pool
    if (usePostgreSQL) {
        const loadedBots = await db.loadOfficialBots();
        Object.assign(officialBots, loadedBots);
        console.log(`[Persistence] Official bots loaded: ${Object.keys(officialBots).length}`);

        // Load official bindings cache from DB
        const loadedBindings = await db.loadAllOfficialBindings();
        for (const b of loadedBindings) {
            officialBindingsCache[getBindingCacheKey(b.device_id, b.entity_id)] = b;
        }
        console.log(`[Persistence] Official bindings cache loaded: ${loadedBindings.length}`);

        // Startup cleanup: release stale bot assignments where entity is no longer bound
        let staleCount = 0;
        for (const bot of Object.values(officialBots)) {
            if (bot.status === 'assigned' && bot.assigned_device_id) {
                const staleDeviceId = bot.assigned_device_id;
                const staleEntityId = bot.assigned_entity_id;
                const device = devices[staleDeviceId];
                const entity = device?.entities?.[staleEntityId];
                if (!entity || !entity.isBound) {
                    console.log(`[Startup Cleanup] Releasing stale bot ${bot.bot_id}: device ${staleDeviceId} E${staleEntityId} no longer bound`);
                    bot.status = 'available';
                    bot.assigned_device_id = null;
                    bot.assigned_entity_id = null;
                    bot.assigned_at = null;
                    await db.saveOfficialBot(bot);
                    if (staleEntityId != null) {
                        delete officialBindingsCache[getBindingCacheKey(staleDeviceId, staleEntityId)];
                        await db.removeOfficialBinding(staleDeviceId, staleEntityId);
                    }
                    staleCount++;
                }
            }
        }
        if (staleCount > 0) {
            console.log(`[Startup Cleanup] Released ${staleCount} stale bot assignments`);
        }
    }

    // Build public code index and backfill any missing codes
    buildPublicCodeIndex();
    await backfillPublicCodes();

    // Load DB-approved skill contributions (supplements git-tracked skill-templates.json)
    if (usePostgreSQL) await loadApprovedContributions();

    persistenceReady = true;
    console.log(`[Persistence] Ready — ${Object.keys(devices).length} devices loaded`);
}

// Auto-save interval
setInterval(async () => {
    const deviceCount = Object.keys(devices).length;
    if (deviceCount > 0) {
        await saveData();
    }
}, AUTO_SAVE_INTERVAL);

// ============================================
// DEVICE CLEANUP (Remove test & zombie devices)
// Runs every hour to prevent resource waste
// ============================================

const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
const TEST_DEVICE_MAX_AGE = 60 * 60 * 1000; // 1 hour for test devices
const ZOMBIE_DEVICE_MAX_AGE = 90 * 24 * 60 * 60 * 1000; // 90 days for real devices

// Fallback patterns for devices created before isTestDevice flag existed
const TEST_DEVICE_PATTERNS = [
    'test-', 'stress-test-', 'webhook-test-', 'persist-test-',
    'anim-test-', 'emotion-test-', 'eye-test-', 'device-A-',
    'device-B-', 'device-A1-', 'device-A2-', 'test-widget-',
    'ux-coverage-', 'test-ux-'
];

function isTestDeviceCheck(deviceId, device) {
    // Explicit flag takes priority
    if (device && device.isTestDevice) return true;
    // Fallback: pattern matching for legacy devices
    return TEST_DEVICE_PATTERNS.some(p => deviceId.startsWith(p));
}

setInterval(async () => {
    const now = Date.now();
    let testRemoved = 0;
    let zombieRemoved = 0;

    for (const deviceId in devices) {
        const device = devices[deviceId];

        // 1. Remove stale test devices (older than 1 hour)
        if (isTestDeviceCheck(deviceId, device)) {
            const age = now - (device.createdAt || 0);
            if (age > TEST_DEVICE_MAX_AGE) {
                delete devices[deviceId];
                if (usePostgreSQL) await db.deleteDevice(deviceId);
                testRemoved++;
            }
            continue;
        }

        // 2. Remove zombie devices: ALL entities inactive for 7+ days
        let latestActivity = device.createdAt || 0;
        for (const i of Object.keys(device.entities).map(Number)) {
            const entity = device.entities[i];
            if (!entity) continue;
            if (entity.lastUpdated > latestActivity) {
                latestActivity = entity.lastUpdated;
            }
        }

        // Only remove if no bound entities AND inactive for 7+ days,
        // OR if all entities (bound or not) inactive for 7+ days
        if (now - latestActivity > ZOMBIE_DEVICE_MAX_AGE) {
            delete devices[deviceId];
            if (usePostgreSQL) await db.deleteDevice(deviceId);
            zombieRemoved++;
        }
    }

    if (testRemoved > 0 || zombieRemoved > 0) {
        console.log(`[Cleanup] Removed ${testRemoved} test device(s), ${zombieRemoved} zombie device(s). Remaining: ${Object.keys(devices).length}`);
        await saveData();
    }
}, CLEANUP_INTERVAL);

// Subscription expiry cleanup - auto-unbind personal bots not verified in 48h
const SUBSCRIPTION_EXPIRY_MS = 48 * 60 * 60 * 1000; // 48 hours
setInterval(async () => {
    if (!usePostgreSQL) return;
    try {
        const expired = await db.getExpiredPersonalBindings(SUBSCRIPTION_EXPIRY_MS);
        for (const binding of expired) {
            const bot = officialBots[binding.bot_id];
            if (bot) {
                bot.status = 'available';
                bot.assigned_device_id = null;
                bot.assigned_entity_id = null;
                bot.assigned_at = null;
                await db.saveOfficialBot(bot);
            }

            // Reset entity if device still exists (preserve user-set name, xp, level)
            const device = devices[binding.device_id];
            if (device && device.entities[binding.entity_id]) {
                const prev = device.entities[binding.entity_id];
                device.entities[binding.entity_id] = createDefaultEntity(binding.entity_id);
                device.entities[binding.entity_id].name = prev.name || null;
                device.entities[binding.entity_id].xp = prev.xp || 0;
                device.entities[binding.entity_id].level = prev.level || 1;
            }

            delete officialBindingsCache[getBindingCacheKey(binding.device_id, binding.entity_id)];
            await db.removeOfficialBinding(binding.device_id, binding.entity_id);
            console.log(`[Borrow Cleanup] Expired personal binding: device ${binding.device_id} entity ${binding.entity_id} bot ${binding.bot_id}`);
        }
        if (expired.length > 0) {
            await saveData();
            console.log(`[Borrow Cleanup] Released ${expired.length} expired personal bot(s)`);
        }
    } catch (err) {
        console.error('[Borrow Cleanup] Error:', err.message);
    }
}, CLEANUP_INTERVAL);

// Graceful shutdown - save data before exit
process.on('SIGINT', async () => {
    console.log('[Persistence] Received SIGINT, saving data before exit...');
    await saveData();
    if (usePostgreSQL) await db.closeDatabase();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('[Persistence] Received SIGTERM, saving data before exit...');
    await saveData();
    if (usePostgreSQL) await db.closeDatabase();
    process.exit(0);
});

// Initialize persistence on startup (async)
initPersistence().catch(err => {
    console.error('[Persistence] Initialization failed:', err.message);
    serverLog('error', 'system', `Persistence initialization failed: ${err.message}`, { metadata: { error: err.message } });
});

// ============================================
// SKILL DOCUMENTATION (serve eclaw-a2a-toolkit as HTML)
// ============================================
app.get('/api/skill-doc', (req, res) => {
    try {
        // Primary source: eclaw-a2a-toolkit from skill-templates.json
        let mdContent;
        let title = 'EClaw A2A Toolkit — Official API';
        try {
            const templatesPath = path.join(__dirname, 'data', 'skill-templates.json');
            const templates = JSON.parse(fs.readFileSync(templatesPath, 'utf8'));
            const toolkit = templates.find(t => t.id === 'eclaw-a2a-toolkit');
            if (toolkit && toolkit.steps) {
                mdContent = `# ${toolkit.title || 'EClaw A2A Toolkit'}\n\n${toolkit.steps}`;
                title = toolkit.title || title;
            }
        } catch (_) { /* fall through */ }
        if (!mdContent) {
            return res.status(500).json({ error: 'eclaw-a2a-toolkit not found in skill-templates.json' });
        }

        const format = (req.query.format || 'html').toLowerCase();

        // ?format=text — raw plain text (for bots/agents, legacy)
        if (format === 'text') {
            return res.type('text').send(mdContent);
        }

        // ?format=markdown or ?format=md — raw Markdown source
        if (format === 'markdown' || format === 'md') {
            res.setHeader('Content-Disposition', 'inline; filename="eclaw-api-skill.md"');
            return res.type('text/markdown; charset=utf-8').send(mdContent);
        }

        // ?format=json — structured JSON with metadata
        if (format === 'json') {
            // Parse markdown into sections for structured consumption
            const sections = [];
            const lines = mdContent.split('\n');
            let currentSection = null;

            for (const line of lines) {
                const h2Match = line.match(/^## (.+)/);
                const h3Match = line.match(/^### (.+)/);
                if (h2Match) {
                    currentSection = { heading: h2Match[1], level: 2, content: '', subsections: [] };
                    sections.push(currentSection);
                } else if (h3Match && currentSection) {
                    const sub = { heading: h3Match[1], level: 3, content: '' };
                    currentSection.subsections.push(sub);
                } else if (currentSection) {
                    const target = currentSection.subsections.length > 0
                        ? currentSection.subsections[currentSection.subsections.length - 1]
                        : currentSection;
                    target.content += line + '\n';
                }
            }

            // Trim trailing whitespace from all content fields
            for (const sec of sections) {
                sec.content = sec.content.trim();
                for (const sub of sec.subsections) {
                    sub.content = sub.content.trim();
                }
            }

            // Extract API endpoints from markdown (lines matching pattern)
            const endpoints = [];
            const endpointRegex = /^(GET|POST|PUT|PATCH|DELETE)\s+(`?)(\S+)\2/;
            for (const line of lines) {
                const m = line.match(endpointRegex);
                if (m) {
                    endpoints.push({ method: m[1], path: m[3].replace(/`/g, '') });
                }
            }

            return res.json({
                success: true,
                title,
                format: 'json',
                endpoints_count: endpoints.length,
                endpoints,
                sections: sections.map(s => ({
                    heading: s.heading,
                    subsections: s.subsections.map(sub => sub.heading)
                })),
                full_markdown: mdContent,
                content_length: mdContent.length
            });
        }

        // Default: ?format=html — rendered HTML page with marked.js
        res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
body{max-width:900px;margin:0 auto;padding:20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#1a1a2e;color:#e0e0e0;line-height:1.6}
h1,h2,h3{color:#00d4ff}h1{border-bottom:2px solid #00d4ff;padding-bottom:8px}
pre{background:#0d1117;padding:16px;border-radius:8px;overflow-x:auto;border:1px solid #333}
code{background:#0d1117;padding:2px 6px;border-radius:4px;font-size:0.9em}
pre code{padding:0;background:none}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #444;padding:8px 12px;text-align:left}th{background:#16213e}
a{color:#00d4ff}blockquote{border-left:4px solid #f39c12;margin:16px 0;padding:8px 16px;background:#16213e}
</style>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
</head><body>
<div id="content"></div>
<script>
document.getElementById('content').innerHTML = marked.parse(${JSON.stringify(mdContent)});
<\/script>
</body></html>`);
    } catch (err) {
        console.error('[SkillDoc] Error reading skill doc:', err.message);
        res.status(500).json({ error: 'Failed to load skill documentation' });
    }
});

// ============================================
// MISSION CONTROL DASHBOARD (PostgreSQL)
// ============================================
const missionModule = require('./mission')(devices, { awardEntityXP, serverLog });
app.use('/api/mission', missionModule.router);

// Kanban Board (Mission v2) — mounted on same /api/mission path
let kanbanModule;
try {
    kanbanModule = require('./kanban')(devices, {
        awardEntityXP,
        serverLog,
        pushToChannelCallback: (...args) => channelModule.pushToChannelCallback(...args),
        saveChatMessage,
        getMissionApiHints,
        pushToBot,
    });
    app.use('/api/mission', kanbanModule.router);
    console.log('[Kanban] Module loaded successfully');
} catch (err) {
    console.error('[Kanban] Failed to load module:', err.message);
    kanbanModule = { initKanbanDatabase: () => {}, startBackgroundTimers: () => {} };
}

// ============================================
// PAGE VIEW TRACKING (fire-and-forget)
// ============================================
function trackPageView(req, deviceId, publicCode, noteId) {
    try {
        const pgPool = missionModule._pool;
        if (!pgPool) return;
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
        const ua = (req.headers['user-agent'] || '').slice(0, 256);
        const referer = (req.headers['referer'] || '').slice(0, 512);
        pgPool.query(
            'INSERT INTO page_views (device_id, note_id, public_code, visitor_ip, visitor_ua, referer) VALUES ($1, $2, $3, $4, $5, $6)',
            [deviceId, noteId || null, publicCode, ip, ua, referer]
        ).catch(() => {});
    } catch (_) {}
}

// ============================================
// PUBLIC ENTITY HOME: /p/<publicCode>
// ============================================
app.get('/p/:code', async (req, res) => {
    const { code } = req.params;
    const target = publicCodeIndex[code];
    if (!target) {
        return res.status(404).send(renderPublicPageShell('Not Found', '<p>This entity does not exist.</p>'));
    }
    trackPageView(req, target.deviceId, code, null);

    try {
        const pgPool = missionModule._pool;
        if (!pgPool) return res.status(500).send(renderPublicPageShell('Error', '<p>Service unavailable.</p>'));

        // Get all public pages for this entity's device
        const result = await pgPool.query(
            `SELECT np.note_id, np.updated_at, mi.title
             FROM note_pages np
             LEFT JOIN mission_items mi ON mi.id::text = np.note_id AND mi.device_id = np.device_id
             WHERE np.device_id = $1 AND np.is_public = true
             ORDER BY np.updated_at DESC`,
            [target.deviceId]
        );

        const device = devices[target.deviceId];
        const entity = device && device.entities && device.entities[target.entityId];
        const entityName = (entity && entity.name) || `Entity #${target.entityId}`;
        const entityAvatar = entity && entity.avatar;
        const entityDesc = entity && entity.identity && entity.identity.public && entity.identity.public.description;
        const agentCard = entity && entity.agentCard;

        // Build page cards HTML
        let cardsHtml = '';
        if (result.rows.length === 0) {
            cardsHtml = '<p style="color:var(--text-muted);text-align:center;padding:40px 0;">No public pages yet.</p>';
        } else {
            cardsHtml = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;margin-top:24px;">';
            for (const row of result.rows) {
                const title = (row.title || 'Untitled Page').replace(/</g, '&lt;');
                const date = new Date(row.updated_at).toLocaleDateString();
                cardsHtml += `<a href="/p/${code}/${row.note_id}" style="text-decoration:none;">
                    <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:12px;padding:20px;transition:transform 0.2s,border-color 0.2s;cursor:pointer;"
                         onmouseover="this.style.borderColor='var(--accent)';this.style.transform='translateY(-2px)'"
                         onmouseout="this.style.borderColor='var(--border)';this.style.transform='none'">
                        <div style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:6px;">📄 ${title}</div>
                        <div style="font-size:12px;color:var(--text-muted);">Updated ${date}</div>
                    </div>
                </a>`;
            }
            cardsHtml += '</div>';
        }

        // Build profile header
        const avatarHtml = entityAvatar
            ? (entityAvatar.startsWith('http') ? `<img src="${entityAvatar.replace(/"/g,'&quot;')}" style="width:64px;height:64px;border-radius:50%;object-fit:cover;">` : `<span style="font-size:48px;">${entityAvatar}</span>`)
            : '<span style="font-size:48px;">🦞</span>';
        const descHtml = (entityDesc || (agentCard && agentCard.description) || '').replace(/</g, '&lt;');

        const content = `
            <div style="text-align:center;margin-bottom:24px;">
                <div style="margin-bottom:12px;">${avatarHtml}</div>
                <h1 style="font-size:24px;margin:0 0 6px;">${entityName.replace(/</g,'&lt;')}</h1>
                ${descHtml ? `<p style="color:var(--text-muted);font-size:14px;max-width:500px;margin:0 auto;">${descHtml}</p>` : ''}
                <a href="/c/${code}" style="display:inline-block;margin-top:12px;color:var(--accent);font-size:13px;text-decoration:none;">💬 Chat</a>
            </div>
            <h2 style="font-size:18px;margin-bottom:4px;">Public Pages</h2>
            <p style="color:var(--text-muted);font-size:13px;">${result.rows.length} page${result.rows.length !== 1 ? 's' : ''}</p>
            ${cardsHtml}`;

        res.send(renderPublicPageShell(entityName + ' — Pages', content, { entityName, publicCode: code }));
    } catch (error) {
        console.error('[PublicPage] Error serving entity home:', error);
        res.status(500).send(renderPublicPageShell('Error', '<p>Something went wrong.</p>'));
    }
});

// ============================================
// PUBLIC NOTE PAGES: /p/<publicCode>/<noteId>
// ============================================
app.get('/p/:code/:noteId', async (req, res) => {
    const { code, noteId } = req.params;

    const target = publicCodeIndex[code];
    if (!target) {
        return res.status(404).send(renderPublicPageShell('Page Not Found', '<p>This page does not exist.</p>'));
    }
    trackPageView(req, target.deviceId, code, noteId);

    try {
        const pgPool = missionModule._pool;
        if (!pgPool) {
            return res.status(500).send(renderPublicPageShell('Error', '<p>Service unavailable.</p>'));
        }

        // Fetch current page + all sibling public pages in parallel
        const [pageResult, siblingsResult] = await Promise.all([
            pgPool.query(
                'SELECT np.html_content, np.markdown_content, np.updated_at, mi.title FROM note_pages np LEFT JOIN mission_items mi ON mi.id::text = np.note_id AND mi.device_id = np.device_id WHERE np.device_id = $1 AND np.note_id = $2 AND np.is_public = true',
                [target.deviceId, noteId]
            ),
            pgPool.query(
                'SELECT np.note_id, mi.title, np.updated_at FROM note_pages np LEFT JOIN mission_items mi ON mi.id::text = np.note_id AND mi.device_id = np.device_id WHERE np.device_id = $1 AND np.is_public = true ORDER BY np.updated_at DESC',
                [target.deviceId]
            )
        ]);

        if (pageResult.rows.length === 0) {
            return res.status(404).send(renderPublicPageShell('Page Not Found', '<p>This page is not available.</p>'));
        }

        const row = pageResult.rows[0];
        const pageTitle = row.title || 'EClaw Page';
        const hasMarkdown = !!row.markdown_content;
        const htmlContent = hasMarkdown
            ? `<div id="md-content"></div><script src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.2.4/purify.min.js"><\/script><script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script><script>document.getElementById('md-content').innerHTML=DOMPurify.sanitize(marked.parse(${JSON.stringify(row.markdown_content)}));<\/script>`
            : sanitizePublicHtml(row.html_content || '');

        const device = devices[target.deviceId];
        const entity = device && device.entities && device.entities[target.entityId];
        const entityName = (entity && entity.name) || `Entity #${target.entityId}`;

        // Build sibling pages for navigation
        const siblingPages = siblingsResult.rows.map(r => ({
            noteId: r.note_id,
            title: r.title || 'Untitled',
            isCurrent: r.note_id === noteId
        }));

        res.send(renderPublicPageShell(pageTitle, htmlContent, {
            entityName,
            publicCode: code,
            noteId,
            updatedAt: row.updated_at,
            siblingPages
        }));
    } catch (error) {
        console.error('[PublicPage] Error serving public page:', error);
        res.status(500).send(renderPublicPageShell('Error', '<p>Something went wrong.</p>'));
    }
});

function sanitizePublicHtml(html) {
    if (!html) return '';
    return sanitizeHtml(html, {
        allowVulnerableTags: true,
        allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'span', 'details', 'summary', 'mark', 'del', 'ins', 'sub', 'sup', 'style']),
        allowedAttributes: {
            ...sanitizeHtml.defaults.allowedAttributes,
            img: ['src', 'alt', 'width', 'height', 'loading'],
            a: ['href', 'target', 'rel'],
            '*': ['class', 'id', 'style']
        },
        allowedSchemes: ['http', 'https', 'mailto'],
        allowedStyles: { '*': {
            'color': [/.*/], 'background': [/.*/], 'background-color': [/.*/],
            'text-align': [/.*/], 'text-decoration': [/.*/],
            'font-size': [/.*/], 'font-weight': [/.*/],
            'margin': [/.*/], 'margin-top': [/.*/], 'margin-bottom': [/.*/], 'margin-left': [/.*/], 'margin-right': [/.*/],
            'padding': [/.*/], 'padding-top': [/.*/], 'padding-bottom': [/.*/], 'padding-left': [/.*/], 'padding-right': [/.*/],
            'border': [/.*/], 'border-radius': [/.*/],
            'display': [/.*/], 'flex': [/.*/], 'flex-direction': [/.*/], 'gap': [/.*/], 'align-items': [/.*/], 'justify-content': [/.*/],
            'max-width': [/.*/], 'min-width': [/.*/], 'width': [/.*/], 'height': [/.*/],
            'line-height': [/.*/], 'white-space': [/.*/], 'overflow': [/.*/], 'opacity': [/.*/]
        } }
    });
}

function renderPublicPageShell(title, content, opts = {}) {
    const { entityName, publicCode, noteId, updatedAt, siblingPages } = opts;
    const safeTitle = (title || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const footerInfo = entityName
        ? `<div class="page-footer">
            <span>Published by <strong>${(entityName || '').replace(/</g, '&lt;')}</strong></span>
            ${publicCode ? ` · <a href="/c/${publicCode}">Chat</a>` : ''}
            ${updatedAt ? ` · Updated ${new Date(updatedAt).toLocaleDateString()}` : ''}
           </div>`
        : '';

    // Build navigation HTML if sibling pages exist
    let navHtml = '';
    if (siblingPages && siblingPages.length > 1 && publicCode) {
        const navItems = siblingPages.map(p => {
            const t = (p.title || 'Untitled').replace(/</g, '&lt;');
            return p.isCurrent
                ? `<span class="page-nav-item active">📄 ${t}</span>`
                : `<a href="/p/${publicCode}/${p.noteId}" class="page-nav-item">📄 ${t}</a>`;
        }).join('');
        navHtml = `<nav class="page-nav"><a href="/p/${publicCode}" class="page-nav-home">🏠</a>${navItems}</nav>`;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${safeTitle} — EClawbot</title>
    <meta name="description" content="${safeTitle} — Published on EClawbot">
    <meta property="og:title" content="${safeTitle}">
    <meta property="og:site_name" content="EClawbot">
    <style>
        :root { --bg:#0f1117; --card-bg:#1a1d27; --text:#e0e0e0; --text-muted:#8a8f98; --accent:#7c6aef; --border:#2a2d3a; }
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;min-height:100vh}
        .page-header{background:var(--card-bg);border-bottom:1px solid var(--border);padding:12px 24px;display:flex;align-items:center;gap:12px}
        .page-header a{color:var(--accent);text-decoration:none;font-weight:600;font-size:16px}
        .page-header a:hover{text-decoration:underline}
        .page-nav{background:var(--card-bg);border-bottom:1px solid var(--border);padding:8px 24px;display:flex;align-items:center;gap:4px;overflow-x:auto;white-space:nowrap}
        .page-nav-home{color:var(--accent);text-decoration:none;font-size:16px;padding:4px 8px;border-radius:6px}
        .page-nav-home:hover{background:var(--bg)}
        .page-nav-item{color:var(--text-muted);text-decoration:none;font-size:12px;padding:4px 10px;border-radius:6px;display:inline-block}
        a.page-nav-item:hover{background:var(--bg);color:var(--text)}
        .page-nav-item.active{background:var(--accent);color:white;font-weight:600}
        .page-content{max-width:900px;margin:0 auto;padding:32px 24px}
        .page-content img{max-width:100%;height:auto;border-radius:8px}
        .page-content a{color:var(--accent)}
        .page-content table{border-collapse:collapse;width:100%;margin:16px 0}
        .page-content th,.page-content td{border:1px solid var(--border);padding:8px 12px;text-align:left}
        .page-content th{background:var(--card-bg)}
        .page-content pre{background:var(--card-bg);padding:16px;border-radius:8px;overflow-x:auto}
        .page-content code{background:var(--card-bg);padding:2px 6px;border-radius:4px;font-size:0.9em}
        .page-content h1,.page-content h2,.page-content h3{margin:24px 0 12px}
        .page-footer{max-width:900px;margin:40px auto 20px;padding:16px 24px;border-top:1px solid var(--border);color:var(--text-muted);font-size:13px;text-align:center}
        .page-footer a{color:var(--accent);text-decoration:none}
        .page-footer a:hover{text-decoration:underline}
        .url-bar{max-width:900px;margin:16px auto 0;padding:0 24px}
        .url-bar-inner{display:flex;align-items:center;gap:8px;background:var(--card-bg);border:1px solid var(--border);border-radius:10px;padding:8px 12px;transition:border-color .2s}
        .url-bar-inner:hover{border-color:var(--accent)}
        .url-bar-icon{color:var(--text-muted);font-size:14px;flex-shrink:0}
        .url-bar-text{flex:1;color:var(--text);font-size:13px;font-family:'SF Mono',Monaco,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;user-select:all}
        .url-bar-copy{background:var(--accent);color:white;border:none;padding:6px 14px;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;transition:all .2s;flex-shrink:0}
        .url-bar-copy:hover{opacity:.85;transform:scale(1.03)}
        .url-bar-copy:active{transform:scale(.97)}
        .url-bar-copy.copied{background:#22c55e}
    </style>
</head>
<body>
    <div class="page-header"><a href="https://eclawbot.com">EClawbot</a></div>
    ${navHtml}
    ${publicCode && noteId ? `<div class="url-bar"><div class="url-bar-inner"><span class="url-bar-icon">🔗</span><span class="url-bar-text" id="page-url">https://eclawbot.com/p/${publicCode}/${noteId}</span><button class="url-bar-copy" id="copy-url-btn" onclick="copyPageUrl()">複製</button></div></div><script>function copyPageUrl(){var u=document.getElementById('page-url').textContent,b=document.getElementById('copy-url-btn');navigator.clipboard.writeText(u).then(function(){b.textContent='已複製 ✓';b.classList.add('copied');setTimeout(function(){b.textContent='複製';b.classList.remove('copied')},2000)}).catch(function(){var t=document.createElement('textarea');t.value=u;document.body.appendChild(t);t.select();document.execCommand('copy');document.body.removeChild(t);b.textContent='已複製 ✓';b.classList.add('copied');setTimeout(function(){b.textContent='複製';b.classList.remove('copied')},2000)})}<\/script>` : ''}
    <div class="page-content">${content}</div>
    ${footerInfo}
    ${content.includes('data-eclaw-form') ? '<script src="/assets/eclaw-forms.js"></script>' : ''}
</body>
</html>`;
}

// ============================================
// A2A PROTOCOL COMPATIBILITY LAYER
// ============================================
const a2aCompat = require('./a2a-compat')(devices, { publicCodeIndex, serverLog, missionPool: require('pg').Pool ? new (require('pg').Pool)({ connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot' }) : null });
app.use('/api/a2a', a2aCompat.router);
app.get('/.well-known/agent.json', (req, res) => res.json(a2aCompat.getPlatformAgentCard()));

// ============================================
// OAUTH 2.0 AUTHORIZATION SERVER
// ============================================
const oauthServer = require('./oauth-server')(devices, { serverLog });
app.use('/api/oauth', oauthServer.router);
oauthServer.initOAuthDatabase();

// ============================================
// ARTICLE PUBLISHER — Blogger + Hashnode
// ============================================
const articlePublisher = require('./article-publisher');
app.use('/api/publisher', articlePublisher.router);

// ============================================
// API DOCS — OpenAPI / Swagger UI
// ============================================
const apiDocs = require('./api-docs')();
app.use('/api/docs', apiDocs.router);

// ============================================
// BOT TOOLS — Search & Web Fetch Proxy
// ============================================
const botTools = require('./bot-tools');
app.use('/api/bot', botTools.router);
missionModule.initMissionDatabase();
kanbanModule.initKanbanDatabase();
kanbanModule.startBackgroundTimers();
// Wire notification callback (notifyDevice defined later, uses closure)
missionModule.setNotifyCallback((deviceId, notif) => notifyDevice(deviceId, notif));

// ============================================
// USER AUTHENTICATION (PostgreSQL)
// ============================================
const authModule = require('./auth')(devices, getOrCreateDevice, serverLog);
app.use(authModule.softAuthMiddleware); // Populate req.user from cookie on ALL requests
app.use('/api/auth', authModule.router);
authModule.initAuthDatabase();

// Wire up pending message flush on email verification
authModule.setOnEmailVerified(async (deviceId) => {
    console.log(`[PendingFlush] onEmailVerified triggered for device ${deviceId}`);
    const pending = await db.getPendingCrossMessages(deviceId);
    console.log(`[PendingFlush] Found ${pending.length} pending cross-speak messages for device ${deviceId}`);
    if (pending.length === 0) return;
    console.log(`[PendingFlush] Flushing ${pending.length} pending cross-speak messages for device ${deviceId}`);

    const senderDevice = devices[deviceId];
    if (!senderDevice) return;

    for (const msg of pending) {
        try {
            const target = publicCodeIndex[msg.target_code];
            if (!target) continue;
            const targetDevice = devices[target.deviceId];
            if (!targetDevice) continue;
            const toEntity = targetDevice.entities[target.entityId];
            if (!toEntity || !toEntity.isBound) continue;

            const sourceLabel = `xdevice:${deviceId}:owner`;
            const messageObj = {
                text: msg.text,
                from: sourceLabel,
                fromEntityId: -1,
                fromPublicCode: null,
                fromDeviceId: deviceId,
                timestamp: msg.created_at,
                read: false,
                mediaType: msg.media_type || null,
                mediaUrl: msg.media_url || null,
                crossDevice: true
            };
            toEntity.messageQueue.push(messageObj);

            const sourceTag = `${sourceLabel}->${msg.target_code}`;
            await saveChatMessage(target.deviceId, target.entityId, msg.text, sourceTag, true, false, msg.media_type || null, msg.media_url || null);
            // Also save sender's copy (same as /api/client/cross-speak)
            if (deviceId !== target.deviceId) {
                const senderMsgId = await saveChatMessage(deviceId, 0, msg.text, sourceTag, true, false, msg.media_type || null, msg.media_url || null);
                if (!senderMsgId) {
                    console.warn(`[PendingFlush] Sender copy save returned null for device ${deviceId}, retrying...`);
                    await saveChatMessage(deviceId, 0, msg.text, sourceTag, true, false, msg.media_type || null, msg.media_url || null);
                }
            }
            // Auto-collect target card for sender so it appears in chat.html "Send to" bar
            autoCollectCard(deviceId, msg.target_code, toEntity, 'auto_speak');

            toEntity.message = `xdevice:owner: ${msg.text}`;
            toEntity.lastUpdated = Date.now();

            if (toEntity.bindingType === 'channel') {
                // Channel plugin: send structured JSON
                const flushXdSettings = await crossDeviceSettings.getSettings(target.deviceId, target.entityId);
                channelModule.pushToChannelCallback(target.deviceId, target.entityId, {
                    event: 'cross_device_message',
                    from: `New User (${deviceId})`,
                    text: msg.text,
                    mediaType: msg.media_type || null,
                    mediaUrl: msg.media_url || null,
                    backupUrl: msg.media_type === 'photo' ? getBackupUrl(msg.media_url) : null,
                    fromEntityId: -1,
                    fromPublicCode: null,
                    fromDeviceId: deviceId,
                    isOwnerMode: true,
                    eclaw_context: {
                        missionHints: getMissionApiHints('https://eclawbot.com', target.deviceId, target.entityId, toEntity.botSecret),
                        silentToken: '[SILENT]',
                        identitySetupRequired: !toEntity.identity,
                        preInject: flushXdSettings.pre_inject || null
                    }
                }, toEntity.channelAccountId).catch(() => {});
            } else if (toEntity.webhook) {
                const apiBase = 'https://eclawbot.com';
                let pushMsg = `[ACTION REQUIRED] You MUST use exec tool with curl to call the API. Your text reply is DISCARDED.\n`;
                pushMsg += `To update your wallpaper status:\n`;
                pushMsg += `exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${target.deviceId}","entityId":${target.entityId},"botSecret":"${toEntity.botSecret}","targetDeviceId":"${deviceId}","state":"IDLE","message":"YOUR_REPLY_HERE"}'\n\n`;
                pushMsg += `[CROSS-DEVICE MESSAGE from New User]\nContent: ${msg.text}`;
                pushMsg += getMissionApiHints(apiBase, target.deviceId, target.entityId, toEntity.botSecret);
                pushToBot(toEntity, target.deviceId, 'cross_device_message', { message: pushMsg }).catch(() => {});
            }
        } catch (err) {
            console.error(`[PendingFlush] Error flushing message ${msg.id}:`, err.message);
        }
    }
    await db.deletePendingCrossMessages(deviceId);
    serverLog('info', 'pending_flush', `Flushed ${pending.length} pending messages for device ${deviceId}`, { deviceId });
});

// ============================================
// SUBSCRIPTION & TAPPAY (PostgreSQL)
// ============================================
const subscriptionModule = require('./subscription')(devices, authModule.authMiddleware, ensureOneEmptySlot, serverLog);
app.use('/api/subscription', subscriptionModule.router);
// Load premium status after persistence is ready
setTimeout(() => subscriptionModule.loadPremiumStatus(), 5000);

// ============================================
// GATEKEEPER - Free Bot Abuse Prevention
// ============================================
gatekeeper.initGatekeeperTable();
gatekeeper.setServerLog(serverLog);
setTimeout(() => gatekeeper.loadBlockedDevices(), 3000);

// Developer device cache — devices owned by admin accounts are exempt from Gatekeeper First Lock
const developerDeviceIds = new Set();
async function loadDeveloperDevices() {
    try {
        const result = await authModule.pool.query(
            'SELECT device_id FROM user_accounts WHERE is_admin = true AND device_id IS NOT NULL'
        );
        developerDeviceIds.clear();
        for (const row of result.rows) {
            developerDeviceIds.add(row.device_id);
        }
        console.log(`[Gatekeeper] Loaded ${developerDeviceIds.size} developer device(s)`);
    } catch (err) {
        console.error('[Gatekeeper] Failed to load developer devices:', err.message);
    }
}
setTimeout(() => loadDeveloperDevices(), 3500);

// --- Skill / Soul / Rule Templates API ---

const skillTemplatesData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/skill-templates.json'), 'utf8'));
const soulTemplatesData = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data/soul-templates.json'), 'utf8')); }
    catch (_) { console.warn('[TEMPLATES] soul-templates.json not found, using []'); return []; }
})();
const ruleTemplatesData = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data/rule-templates.json'), 'utf8')); }
    catch (_) { console.warn('[TEMPLATES] rule-templates.json not found, using []'); return []; }
})();
// Load approved contributions from DB on startup and merge into in-memory list
// (DB entries supplement the git-tracked JSON; safe to run async)
/** Normalize requiredVars: accept both string[] and {key,hint?,description?}[] formats */
function normalizeRequiredVars(vars) {
    if (!Array.isArray(vars)) return [];
    return vars.map(v => (typeof v === 'string') ? { key: v } : v);
}

async function loadApprovedContributions() {
    try {
        const rows = await db.getApprovedSkillContributions();
        for (const row of rows) {
            const alreadyInList = skillTemplatesData.some(t => t.id === row.skill_id);
            if (!alreadyInList) {
                skillTemplatesData.push({
                    id: row.skill_id,
                    label: row.label,
                    icon: row.icon,
                    title: row.title,
                    url: row.url,
                    author: row.author,
                    updatedAt: row.verified_at ? row.verified_at.toISOString().slice(0, 10) : '',
                    requiredVars: normalizeRequiredVars(row.required_vars),
                    steps: row.steps
                });
            }
        }
        if (process.env.DEBUG === 'true') console.log(`[SKILL] Loaded ${rows.length} approved contributions from DB`);

        const soulRows = await db.getApprovedSoulContributions();
        for (const row of soulRows) {
            const alreadyInList = soulTemplatesData.some(t => t.id === row.soul_id);
            if (!alreadyInList) {
                soulTemplatesData.push({
                    id:          row.soul_id,
                    label:       row.label,
                    icon:        row.icon,
                    name:        row.name,
                    description: row.description,
                    author:      row.author,
                    updatedAt:   row.verified_at ? row.verified_at.toISOString().slice(0, 10) : ''
                });
            }
        }
        if (process.env.DEBUG === 'true') console.log(`[SOUL] Loaded ${soulRows.length} approved contributions from DB`);

        const ruleRows = await db.getApprovedRuleContributions();
        for (const row of ruleRows) {
            const alreadyInList = ruleTemplatesData.some(t => t.id === row.rule_id);
            if (!alreadyInList) {
                ruleTemplatesData.push({
                    id:          row.rule_id,
                    label:       row.label,
                    icon:        row.icon,
                    ruleType:    row.rule_type,
                    name:        row.name,
                    description: row.description,
                    author:      row.author,
                    updatedAt:   row.verified_at ? row.verified_at.toISOString().slice(0, 10) : ''
                });
            }
        }
        if (process.env.DEBUG === 'true') console.log(`[RULE] Loaded ${ruleRows.length} approved contributions from DB`);
    } catch (err) {
        console.error('[SKILL] Failed to load approved contributions from DB:', err.message);
    }
}

// GET /api/skill-templates - Community skill template registry (public)
app.get('/api/skill-templates', (req, res) => {
    // Normalize requiredVars on output to handle mixed string[]/object[] from DB contributions
    const sanitized = skillTemplatesData.map(t => ({
        ...t,
        requiredVars: normalizeRequiredVars(t.requiredVars)
    }));
    res.json({ success: true, templates: sanitized });
});

// GET /api/soul-templates - Soul (personality) template registry (public)
app.get('/api/soul-templates', (req, res) => {
    res.json({ success: true, templates: soulTemplatesData });
});

// GET /api/rule-templates - Rule template registry (public)
app.get('/api/rule-templates', (req, res) => {
    res.json({ success: true, templates: ruleTemplatesData });
});

/**
 * POST /api/skill-templates/contribute
 * Bot submits a new skill. Auto-verifies GitHub URL asynchronously.
 * Auth: deviceId + botSecret (entityId optional — auto-detected from botSecret)
 * Body: { deviceId, botSecret, entityId?, skill: { id, label, icon, title, url, author, requiredVars, steps } }
 */
app.post('/api/skill-templates/contribute', async (req, res) => {
    const { deviceId, botSecret, entityId, skill } = req.body;

    if (!deviceId || !botSecret || !skill) {
        return res.status(400).json({ success: false, error: 'deviceId, botSecret, and skill required' });
    }
    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    // Find entity: try explicit entityId first, then search all slots by botSecret
    let eId = parseInt(entityId);
    let entity = !isNaN(eId) && device.entities[eId];
    if (!entity || !entity.isBound || !safeEqual(entity.botSecret, botSecret)) {
        // Search all entity slots for matching botSecret
        eId = -1;
        entity = null;
        for (const i of Object.keys(device.entities).map(Number)) {
            const e = device.entities[i];
            if (e && e.isBound && safeEqual(e.botSecret, botSecret)) {
                eId = i;
                entity = e;
                break;
            }
        }
    }
    if (!entity) {
        return res.status(403).json({ success: false, error: 'Invalid botSecret or no bound entity found' });
    }

    const { id, label, icon, title, url, author, requiredVars, steps } = skill;
    if (!id || !title || !url || !steps) {
        return res.status(400).json({ success: false, error: 'skill must include: id, title, url, steps' });
    }

    // Validate requiredVars format: must be array of {key} objects or strings (auto-normalized)
    if (requiredVars !== undefined && requiredVars !== null) {
        if (!Array.isArray(requiredVars)) {
            return res.status(400).json({ success: false, error: 'requiredVars must be an array' });
        }
        for (let i = 0; i < requiredVars.length; i++) {
            const v = requiredVars[i];
            if (typeof v === 'string') {
                if (!v.trim()) {
                    return res.status(400).json({ success: false, error: `requiredVars[${i}] is an empty string` });
                }
                // valid — will be normalized to {key: v} downstream
            } else if (typeof v === 'object' && v !== null) {
                if (!v.key || typeof v.key !== 'string' || !v.key.trim()) {
                    return res.status(400).json({ success: false, error: `requiredVars[${i}].key must be a non-empty string` });
                }
            } else {
                return res.status(400).json({ success: false, error: `requiredVars[${i}] must be a string or {key, hint?, description?} object` });
            }
        }
    }

    // Structural validation of steps content
    const stepsStr = typeof steps === 'string' ? steps : JSON.stringify(steps);
    const PLACEHOLDER_RE = /\b(YOUR_[A-Z_]+|TODO|PLACEHOLDER|FIXME|<[A-Z_]+>)\b/i;
    const STEP_RE = /(\d+\.|step\s*\d+|exec:|curl\s)/i;
    if (stepsStr.length < 50) {
        return res.status(400).json({ success: false, error: 'steps too short — must describe actual actions (min 50 chars)' });
    }
    if (!STEP_RE.test(stepsStr)) {
        return res.status(400).json({ success: false, error: 'steps must contain numbered steps or exec: commands' });
    }
    if (PLACEHOLDER_RE.test(stepsStr)) {
        return res.status(400).json({ success: false, error: 'steps contain unfilled placeholders (e.g. YOUR_XXX, TODO)' });
    }

    // Duplicate ID check (against approved list)
    if (skillTemplatesData.some(t => t.id === id)) {
        serverLog('warn', 'skill_contribute', `Duplicate skill id rejected: ${id}`, { deviceId, entityId: eId });
        return res.status(409).json({ success: false, error: `Skill id "${id}" already exists. Choose a different id.` });
    }

    const pendingId = crypto.randomUUID();
    const entry = {
        pendingId, id,
        label: label || id, icon: icon || '🔧',
        title, url, author: author || entity.name || `entity_${eId}`,
        requiredVars: normalizeRequiredVars(requiredVars), steps,
        submittedBy: { deviceId, entityId: eId, entityName: entity.name || null }
    };

    // Persist to DB immediately (status: verifying)
    try {
        await db.insertSkillContribution(entry);
    } catch (dbErr) {
        // Duplicate pendingId or DB error
        console.error('[SKILL] Failed to insert contribution:', dbErr.message);
        return res.status(500).json({ success: false, error: 'Failed to record contribution' });
    }
    serverLog('info', 'skill_contribute', `Skill contribution received: ${id} (verifying)`, { deviceId, entityId: eId, metadata: { skillId: id, pendingId } });

    // Respond immediately — don't wait for GitHub check
    res.json({ success: true, pendingId, message: `Skill "${title}" submitted. Auto-verifying GitHub URL...` });

    // Async GitHub URL verification
    setImmediate(async () => {
        try {
            const match = url.match(/github\.com\/([^/]+)\/([^/\s]+)/);
            if (!match) {
                await db.updateSkillContribution(pendingId, { status: 'rejected', rejectedReason: 'not_github_url' });
                serverLog('warn', 'skill_contribute', `Skill ${id} rejected: not a GitHub URL`, { deviceId, entityId: eId });
                return;
            }
            const [, owner, repo] = match;
            const cleanRepo = repo.replace(/\/$/, '').replace(/\.git$/, '');
            const ghHeaders = { 'User-Agent': 'EclawBot/1.0' };
            if (process.env.GITHUB_TOKEN) ghHeaders['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
            const ghResp = await fetch(`https://api.github.com/repos/${owner}/${cleanRepo}`, {
                headers: ghHeaders
            });

            if (ghResp.status === 200) {
                const ghData = await ghResp.json();
                const approved = {
                    id, label: entry.label, icon: entry.icon, title, url,
                    author: entry.author,
                    updatedAt: new Date().toISOString().slice(0, 10),
                    requiredVars: normalizeRequiredVars(entry.requiredVars), steps
                };
                skillTemplatesData.push(approved);
                fs.writeFileSync(path.join(__dirname, 'data/skill-templates.json'), JSON.stringify(skillTemplatesData, null, 2));
                await db.updateSkillContribution(pendingId, {
                    status: 'approved',
                    verifiedAt: new Date().toISOString(),
                    verificationResult: { githubStatus: 200, stars: ghData.stargazers_count, description: ghData.description }
                });
                serverLog('info', 'skill_approve', `Skill auto-approved: ${id} (stars: ${ghData.stargazers_count})`, { deviceId, entityId: eId, metadata: { skillId: id } });
                if (process.env.DEBUG === 'true') console.log(`[SKILL] Auto-approved: ${id}`);
            } else {
                await db.updateSkillContribution(pendingId, {
                    status: 'rejected',
                    rejectedReason: `github_${ghResp.status}`,
                    verificationResult: { githubStatus: ghResp.status }
                });
                serverLog('warn', 'skill_contribute', `Skill ${id} rejected: GitHub returned ${ghResp.status}`, { deviceId, entityId: eId });
            }
        } catch (err) {
            await db.updateSkillContribution(pendingId, { status: 'rejected', rejectedReason: `error: ${err.message}` });
            console.error('[SKILL] Auto-verify error:', err.message);
        }
    });
});

/**
 * GET /api/skill-templates/status/:pendingId
 * Bot: check the verification result of a previously submitted skill.
 * Auth: deviceId + botSecret + entityId (query params)
 * Returns: { status, skillId, rejectedReason, verificationResult }
 */
app.get('/api/skill-templates/status/:pendingId', async (req, res) => {
    const { pendingId } = req.params;
    const { deviceId, botSecret, entityId } = req.query;
    if (!deviceId || !botSecret) return res.status(400).json({ success: false, error: 'deviceId and botSecret required' });

    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    const eId = parseInt(entityId) || 0;
    const entity = device.entities[eId];
    if (!entity || !entity.isBound || !safeEqual(entity.botSecret, botSecret))
        return res.status(403).json({ success: false, error: 'Invalid botSecret or entity not bound' });

    try {
        const row = await db.getSkillContributionByPendingId(pendingId);
        if (!row) return res.status(404).json({ success: false, error: 'Contribution not found' });
        if (row.submitted_by && row.submitted_by.deviceId !== deviceId)
            return res.status(403).json({ success: false, error: 'Not your contribution' });

        res.json({
            success: true,
            pendingId: row.pending_id,
            skillId: row.skill_id,
            status: row.status,
            rejectedReason: row.rejected_reason || null,
            verificationResult: row.verification_result || null,
            submittedAt: row.submitted_at,
            verifiedAt: row.verified_at || null
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * DELETE /api/skill-templates/:skillId
 * Admin: revoke an approved skill from the live registry.
 */
app.delete('/api/skill-templates/:skillId', async (req, res) => {
    if (!verifyAdmin(req)) return res.status(403).json({ success: false, error: 'Admin token required' });
    const { skillId } = req.params;
    const idx = skillTemplatesData.findIndex(t => t.id === skillId);
    if (idx === -1) return res.status(404).json({ success: false, error: `Skill "${skillId}" not found in registry` });

    skillTemplatesData.splice(idx, 1);
    fs.writeFileSync(path.join(__dirname, 'data/skill-templates.json'), JSON.stringify(skillTemplatesData, null, 2));
    serverLog('info', 'skill_approve', `Skill revoked by admin: ${skillId}`, {});
    res.json({ success: true, message: `Skill "${skillId}" removed from registry` });
});

// --- Soul / Rule Template Contribution API ---

const SOUL_RULE_KEBAB_RE    = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SOUL_RULE_PLACEHOLDER = /\b(YOUR_[A-Z_]+|TODO|PLACEHOLDER|FIXME|<[A-Z_]+>)\b/i;
const VALID_RULE_TYPES = ['WORKFLOW', 'COMMUNICATION', 'CODE_REVIEW', 'DEPLOYMENT', 'SYNC', 'HEARTBEAT'];

function validateSoulPayload(soul) {
    if (!soul) return 'soul object required';
    const { id, name, description } = soul;
    if (!id || !SOUL_RULE_KEBAB_RE.test(id))     return 'id must be kebab-case (e.g. "my-soul")';
    if (!name || name.trim().length === 0)         return 'name is required';
    if (name.trim().length > 100)                  return 'name must be ≤ 100 characters';
    if (!description || description.length < 50)   return 'description must be at least 50 characters';
    if (SOUL_RULE_PLACEHOLDER.test(description))   return 'description contains unfilled placeholders';
    return null;
}

function validateRulePayload(rule) {
    if (!rule) return 'rule object required';
    const { id, name, description, ruleType } = rule;
    if (!id || !SOUL_RULE_KEBAB_RE.test(id))     return 'id must be kebab-case (e.g. "my-rule")';
    if (!name || name.trim().length === 0)         return 'name is required';
    if (name.trim().length > 100)                  return 'name must be ≤ 100 characters';
    if (!description || description.length < 50)   return 'description must be at least 50 characters';
    if (SOUL_RULE_PLACEHOLDER.test(description))   return 'description contains unfilled placeholders';
    if (!ruleType || !VALID_RULE_TYPES.includes(ruleType))
        return `ruleType must be one of: ${VALID_RULE_TYPES.join(', ')}`;
    return null;
}

// GET /api/soul-templates/contributions is registered after adminAuth/adminCheck declarations below

/**
 * POST /api/soul-templates/contribute
 * Bot submits a new soul template. Synchronous structure validation; auto-approved.
 * Auth: deviceId + botSecret (entityId optional — auto-detected from botSecret)
 */
app.post('/api/soul-templates/contribute', async (req, res) => {
    const { deviceId, botSecret, entityId, soul } = req.body;
    if (!deviceId || !botSecret || !soul)
        return res.status(400).json({ success: false, error: 'deviceId, botSecret, and soul required' });

    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    // Find entity: try explicit entityId first, then search all slots by botSecret
    let eId = parseInt(entityId);
    let entity = !isNaN(eId) && device.entities[eId];
    if (!entity || !entity.isBound || !safeEqual(entity.botSecret, botSecret)) {
        eId = -1;
        entity = null;
        for (const i of Object.keys(device.entities).map(Number)) {
            const e = device.entities[i];
            if (e && e.isBound && safeEqual(e.botSecret, botSecret)) {
                eId = i;
                entity = e;
                break;
            }
        }
    }
    if (!entity)
        return res.status(403).json({ success: false, error: 'Invalid botSecret or no bound entity found' });

    const validationError = validateSoulPayload(soul);
    if (validationError) return res.status(400).json({ success: false, error: validationError });

    const { id, label, icon, name, description, author } = soul;

    if (soulTemplatesData.some(t => t.id === id)) {
        serverLog('warn', 'soul_contribute', `Duplicate soul id rejected: ${id}`, { deviceId, entityId: eId });
        return res.status(409).json({ success: false, error: `Soul id "${id}" already exists. Choose a different id.` });
    }

    const pendingId = crypto.randomUUID();
    const approved = {
        id,
        label:       label || id,
        icon:        icon  || '✨',
        name,
        description,
        author:      author || entity.name || `entity_${eId}`,
        updatedAt:   new Date().toISOString().slice(0, 10)
    };
    const entry = { pendingId, ...approved, submittedBy: { deviceId, entityId: eId, entityName: entity.name || null } };

    try {
        await db.insertSoulContribution(entry);
    } catch (dbErr) {
        console.error('[SOUL] Failed to insert contribution:', dbErr.message);
        return res.status(500).json({ success: false, error: 'Failed to record contribution' });
    }

    soulTemplatesData.push(approved);
    fs.writeFileSync(path.join(__dirname, 'data/soul-templates.json'), JSON.stringify(soulTemplatesData, null, 2));
    serverLog('info', 'soul_contribute', `Soul contribution approved: ${id}`, { deviceId, entityId: eId, metadata: { soulId: id, pendingId } });
    if (process.env.DEBUG === 'true') console.log(`[SOUL] Auto-approved: ${id}`);

    res.json({ success: true, message: `Soul "${name}" contributed and published.`, soul: approved });
});

/**
 * DELETE /api/soul-templates/:soulId
 * Admin: revoke an approved soul from the live registry.
 */
app.delete('/api/soul-templates/:soulId', async (req, res) => {
    if (!verifyAdmin(req)) return res.status(403).json({ success: false, error: 'Admin token required' });
    const { soulId } = req.params;
    const idx = soulTemplatesData.findIndex(t => t.id === soulId);
    if (idx === -1) return res.status(404).json({ success: false, error: `Soul "${soulId}" not found in registry` });

    soulTemplatesData.splice(idx, 1);
    fs.writeFileSync(path.join(__dirname, 'data/soul-templates.json'), JSON.stringify(soulTemplatesData, null, 2));
    serverLog('info', 'soul_approve', `Soul revoked by admin: ${soulId}`, {});
    res.json({ success: true, message: `Soul "${soulId}" removed from registry` });
});

// GET /api/rule-templates/contributions is registered after adminAuth/adminCheck declarations below

/**
 * POST /api/rule-templates/contribute
 * Bot submits a new rule template. Synchronous structure validation; auto-approved.
 * Auth: deviceId + botSecret (entityId optional — auto-detected from botSecret)
 */
app.post('/api/rule-templates/contribute', async (req, res) => {
    const { deviceId, botSecret, entityId, rule } = req.body;
    if (!deviceId || !botSecret || !rule)
        return res.status(400).json({ success: false, error: 'deviceId, botSecret, and rule required' });

    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    // Find entity: try explicit entityId first, then search all slots by botSecret
    let eId = parseInt(entityId);
    let entity = !isNaN(eId) && device.entities[eId];
    if (!entity || !entity.isBound || !safeEqual(entity.botSecret, botSecret)) {
        eId = -1;
        entity = null;
        for (const i of Object.keys(device.entities).map(Number)) {
            const e = device.entities[i];
            if (e && e.isBound && safeEqual(e.botSecret, botSecret)) {
                eId = i;
                entity = e;
                break;
            }
        }
    }
    if (!entity)
        return res.status(403).json({ success: false, error: 'Invalid botSecret or no bound entity found' });

    const validationError = validateRulePayload(rule);
    if (validationError) return res.status(400).json({ success: false, error: validationError });

    const { id, label, icon, ruleType, name, description, author } = rule;

    if (ruleTemplatesData.some(t => t.id === id)) {
        serverLog('warn', 'rule_contribute', `Duplicate rule id rejected: ${id}`, { deviceId, entityId: eId });
        return res.status(409).json({ success: false, error: `Rule id "${id}" already exists. Choose a different id.` });
    }

    const pendingId = crypto.randomUUID();
    const approved = {
        id,
        label:       label || id,
        icon:        icon  || '📋',
        ruleType,
        name,
        description,
        author:      author || entity.name || `entity_${eId}`,
        updatedAt:   new Date().toISOString().slice(0, 10)
    };
    const entry = { pendingId, ...approved, submittedBy: { deviceId, entityId: eId, entityName: entity.name || null } };

    try {
        await db.insertRuleContribution(entry);
    } catch (dbErr) {
        console.error('[RULE] Failed to insert contribution:', dbErr.message);
        return res.status(500).json({ success: false, error: 'Failed to record contribution' });
    }

    ruleTemplatesData.push(approved);
    fs.writeFileSync(path.join(__dirname, 'data/rule-templates.json'), JSON.stringify(ruleTemplatesData, null, 2));
    serverLog('info', 'rule_contribute', `Rule contribution approved: ${id}`, { deviceId, entityId: eId, metadata: { ruleId: id, pendingId } });
    if (process.env.DEBUG === 'true') console.log(`[RULE] Auto-approved: ${id}`);

    res.json({ success: true, message: `Rule "${name}" contributed and published.`, rule: approved });
});

/**
 * DELETE /api/rule-templates/:ruleId
 * Admin: revoke an approved rule from the live registry.
 */
app.delete('/api/rule-templates/:ruleId', async (req, res) => {
    if (!verifyAdmin(req)) return res.status(403).json({ success: false, error: 'Admin token required' });
    const { ruleId } = req.params;
    const idx = ruleTemplatesData.findIndex(t => t.id === ruleId);
    if (idx === -1) return res.status(404).json({ success: false, error: `Rule "${ruleId}" not found in registry` });

    ruleTemplatesData.splice(idx, 1);
    fs.writeFileSync(path.join(__dirname, 'data/rule-templates.json'), JSON.stringify(ruleTemplatesData, null, 2));
    serverLog('info', 'rule_approve', `Rule revoked by admin: ${ruleId}`, {});
    res.json({ success: true, message: `Rule "${ruleId}" removed from registry` });
});

// --- Free Bot TOS API ---

// GET /api/free-bot-tos - Get TOS content
app.get('/api/free-bot-tos', (req, res) => {
    const lang = req.query.lang || 'en';
    const deviceId = req.query.deviceId;
    const tos = gatekeeper.getFreeBotTOS(lang);
    const agreed = deviceId ? gatekeeper.hasAgreedToTOS(deviceId) : false;
    res.json({ success: true, tos, agreed });
});

// POST /api/free-bot-tos/agree - Record TOS agreement
app.post('/api/free-bot-tos/agree', async (req, res) => {
    const { deviceId, deviceSecret, tosVersion } = req.body;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || (device.deviceSecret && !safeEqual(device.deviceSecret, deviceSecret))) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    if (tosVersion !== gatekeeper.FREE_BOT_TOS_VERSION) {
        return res.status(400).json({ success: false, error: 'Invalid TOS version' });
    }
    await gatekeeper.recordTOSAgreement(deviceId);
    res.json({ success: true, message: 'TOS agreement recorded', version: tosVersion });
});

// ============================================
// ADMIN API (PostgreSQL, admin-only)
// ============================================
const adminAuth = authModule.authMiddleware;
const adminCheck = authModule.adminMiddleware;

/**
 * GET /api/skill-templates/contributions
 * Admin: view full contribution history (all statuses).
 */
app.get('/api/skill-templates/contributions', adminAuth, adminCheck, async (req, res) => {
    try {
        const rows = await db.getSkillContributions();
        const contributions = rows.map(r => ({
            pendingId: r.pending_id,
            id: r.skill_id,
            title: r.title,
            url: r.url,
            author: r.author,
            icon: r.icon,
            submittedBy: r.submitted_by,
            submittedAt: r.submitted_at,
            status: r.status,
            verifiedAt: r.verified_at,
            verificationResult: r.verification_result,
            rejectedReason: r.rejected_reason
        }));
        res.json({ success: true, count: contributions.length, contributions });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/soul-templates/contributions
 * Admin: view full soul contribution history.
 */
app.get('/api/soul-templates/contributions', adminAuth, adminCheck, async (req, res) => {
    try {
        const rows = await db.getSoulContributions();
        const contributions = rows.map(r => ({
            pendingId:   r.pending_id,
            id:          r.soul_id,
            label:       r.label,
            icon:        r.icon,
            name:        r.name,
            description: r.description,
            author:      r.author,
            submittedBy: r.submitted_by,
            submittedAt: r.submitted_at,
            status:      r.status,
            verifiedAt:  r.verified_at
        }));
        res.json({ success: true, count: contributions.length, contributions });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/rule-templates/contributions
 * Admin: view full rule contribution history.
 */
app.get('/api/rule-templates/contributions', adminAuth, adminCheck, async (req, res) => {
    try {
        const rows = await db.getRuleContributions();
        const contributions = rows.map(r => ({
            pendingId:   r.pending_id,
            id:          r.rule_id,
            label:       r.label,
            icon:        r.icon,
            ruleType:    r.rule_type,
            name:        r.name,
            description: r.description,
            author:      r.author,
            submittedBy: r.submitted_by,
            submittedAt: r.submitted_at,
            status:      r.status,
            verifiedAt:  r.verified_at
        }));
        res.json({ success: true, count: contributions.length, contributions });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/admin/gatekeeper/reset - Reset strikes and unblock a device (admin)
app.post('/api/admin/gatekeeper/reset', adminAuth, adminCheck, async (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ success: false, error: 'deviceId required' });

    try {
        const result = await gatekeeper.resetStrikes(deviceId);
        res.json({ success: true, deviceId, previousStrikes: result.previousCount, message: 'Device unblocked' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/gatekeeper/stats - Gatekeeper aggregate statistics (Security Demo)
// Auth: deviceId + botSecret (or deviceSecret)
app.get('/api/gatekeeper/stats', async (req, res) => {
    console.log('[GatekeeperStats] GET /api/gatekeeper/stats called', {
        deviceId: req.query.deviceId,
        hasBotSecret: !!req.query.botSecret,
        hasDeviceSecret: !!req.query.deviceSecret,
    });

    const { deviceId, deviceSecret, botSecret } = req.query;

    // Validate presence
    if (!deviceId) {
        console.log('[GatekeeperStats] Auth failed: missing deviceId');
        return res.status(400).json({ success: false, error: 'deviceId is required' });
    }

    const device = devices[deviceId];
    if (!device) {
        console.log('[GatekeeperStats] Auth failed: device not found', { deviceId });
        return res.status(404).json({ success: false, error: 'Device not found' });
    }

    // Accept deviceSecret or any valid botSecret on this device
    const secretOk = deviceSecret && device.deviceSecret && safeEqual(device.deviceSecret, deviceSecret);
    const botOk = botSecret && Object.values(device.entities || {}).some(
        e => e.botSecret && safeEqual(e.botSecret, botSecret)
    );

    if (!secretOk && !botOk) {
        console.log('[GatekeeperStats] Auth failed: invalid credentials', {
            deviceId,
            hasDeviceSecret: !!deviceSecret,
            hasBotSecret: !!botSecret,
        });
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }

    console.log('[GatekeeperStats] Auth passed, fetching stats', { deviceId });

    try {
        const stats = await gatekeeper.getStats();
        console.log('[GatekeeperStats] Stats fetched successfully', {
            totalDevicesTracked: stats.totalDevicesTracked,
            totalBlockedDevices: stats.totalBlockedDevices,
        });
        return res.json({ success: true, ...stats });
    } catch (err) {
        console.error('[GatekeeperStats] getStats() threw error:', err.message, err.stack);
        return res.status(500).json({ success: false, error: 'Failed to fetch gatekeeper stats' });
    }
});

// POST /api/gatekeeper/appeal - Device owner self-service unblock (once per 24h)
const appealCooldown = {}; // deviceId -> timestamp
app.post('/api/gatekeeper/appeal', async (req, res) => {
    const { deviceId, deviceSecret } = req.body;
    if (!deviceId || !deviceSecret) return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });

    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }

    if (!gatekeeper.isDeviceBlocked(deviceId)) {
        return res.json({ success: true, message: 'Device is not blocked', strikes: gatekeeper.getStrikeInfo(deviceId) });
    }

    const lastAppeal = appealCooldown[deviceId] || 0;
    const cooldownMs = 24 * 60 * 60 * 1000;
    if (Date.now() - lastAppeal < cooldownMs) {
        const retryAfter = Math.ceil((cooldownMs - (Date.now() - lastAppeal)) / 3600000);
        return res.status(429).json({ success: false, error: `Appeal cooldown: retry after ${retryAfter}h` });
    }

    appealCooldown[deviceId] = Date.now();
    const result = await gatekeeper.resetStrikes(deviceId);
    serverLog('info', 'gatekeeper', `Device owner appealed and unblocked (was ${result.previousCount} strikes)`, { deviceId });
    res.json({ success: true, message: 'Device unblocked via appeal', previousStrikes: result.previousCount });
});

// GET /api/admin/gatekeeper/debug - Debug developer device cache
app.get('/api/admin/gatekeeper/debug', adminAuth, adminCheck, async (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    const device = devices[deviceId];
    // Query DB for is_admin
    let dbAdmin = null;
    try {
        const r = await authModule.pool.query('SELECT id, email, is_admin, device_id FROM user_accounts WHERE device_id = $1', [deviceId]);
        dbAdmin = r.rows;
    } catch (e) { dbAdmin = e.message; }
    res.json({
        developerDeviceIds: [...developerDeviceIds],
        deviceIdInSet: developerDeviceIds.has(deviceId),
        dbAdminRows: dbAdmin,
        strikeInfo: gatekeeper.getStrikeInfo(deviceId)
    });
});

// GET /api/admin/stats - Overview stats
app.get('/api/admin/stats', adminAuth, adminCheck, async (req, res) => {
    try {
        const pg = authModule.pool;

        // User counts
        const userCount = await pg.query('SELECT COUNT(*) as total FROM user_accounts');
        const premiumCount = await pg.query("SELECT COUNT(*) as total FROM user_accounts WHERE subscription_status = 'premium'");
        const verifiedCount = await pg.query('SELECT COUNT(*) as total FROM user_accounts WHERE email_verified = true');

        // Device counts (in-memory, excluding test devices)
        let deviceTotal = 0;
        let entityTotal = 0;
        let boundEntities = 0;
        for (const [deviceId, d] of Object.entries(devices)) {
            if (isTestDeviceCheck(deviceId, d)) continue;
            deviceTotal++;
            if (d.entities) {
                for (const e of Object.values(d.entities)) {
                    entityTotal++;
                    if (e.isBound) boundEntities++;
                }
            }
        }

        // Official bots
        const freeBotsResult = await pg.query("SELECT COUNT(*) as total FROM official_bots WHERE bot_type = 'free'");
        const personalBotsResult = await pg.query("SELECT COUNT(*) as total FROM official_bots WHERE bot_type = 'personal'");
        const freeAssigned = await pg.query("SELECT COUNT(*) as total FROM official_bots WHERE bot_type = 'free' AND status = 'assigned'");
        const personalAssigned = await pg.query("SELECT COUNT(*) as total FROM official_bots WHERE bot_type = 'personal' AND status = 'assigned'");

        // Bindings
        const totalBindings = await pg.query('SELECT COUNT(*) as total FROM official_bot_bindings');
        const freeBindings = await pg.query(
            "SELECT COUNT(*) as total FROM official_bot_bindings b JOIN official_bots o ON b.bot_id = o.bot_id WHERE o.bot_type = 'free'"
        );
        const personalBindings = await pg.query(
            "SELECT COUNT(*) as total FROM official_bot_bindings b JOIN official_bots o ON b.bot_id = o.bot_id WHERE o.bot_type = 'personal'"
        );

        // Chat messages today
        const msgToday = await pg.query("SELECT COUNT(*) as total FROM chat_messages WHERE created_at::date = CURRENT_DATE");

        // Recent signups (last 7 days)
        const recentSignups = await pg.query(
            "SELECT DATE(created_at) as date, COUNT(*) as count FROM user_accounts WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY DATE(created_at) ORDER BY date ASC"
        );

        // Bot daily conversations (last 7 days, grouped by date and bot_type)
        const botDailyResult = await pg.query(`
            SELECT DATE(m.created_at) as date, o.bot_type,
                   COUNT(*) as msg_count,
                   COUNT(DISTINCT m.device_id) as unique_devices
            FROM chat_messages m
            JOIN official_bot_bindings b ON m.device_id = b.device_id AND m.entity_id = b.entity_id
            JOIN official_bots o ON b.bot_id = o.bot_id
            WHERE m.is_from_bot = TRUE AND m.created_at > NOW() - INTERVAL '7 days'
            GROUP BY DATE(m.created_at), o.bot_type
            ORDER BY date ASC
        `);

        // Platform breakdown (registered web users vs APP-only devices)
        const registeredDeviceIds = new Set();
        const regResult = await pg.query('SELECT device_id FROM user_accounts WHERE device_id IS NOT NULL');
        for (const r of regResult.rows) {
            if (r.device_id) registeredDeviceIds.add(r.device_id);
        }
        let appOnlyCount = 0;
        let webDeviceCount = 0;
        for (const deviceId of Object.keys(devices)) {
            if (isTestDeviceCheck(deviceId, devices[deviceId])) continue;
            if (registeredDeviceIds.has(deviceId)) {
                webDeviceCount++;
            } else {
                appOnlyCount++;
            }
        }

        res.json({
            success: true,
            users: {
                total: parseInt(userCount.rows[0].total),
                premium: parseInt(premiumCount.rows[0].total),
                verified: parseInt(verifiedCount.rows[0].total)
            },
            devices: {
                total: deviceTotal,
                entities: entityTotal,
                boundEntities: boundEntities
            },
            officialBots: {
                free: { total: parseInt(freeBotsResult.rows[0].total), assigned: parseInt(freeAssigned.rows[0].total) },
                personal: { total: parseInt(personalBotsResult.rows[0].total), assigned: parseInt(personalAssigned.rows[0].total) }
            },
            bindings: {
                total: parseInt(totalBindings.rows[0].total),
                free: parseInt(freeBindings.rows[0].total),
                personal: parseInt(personalBindings.rows[0].total)
            },
            messagesToday: parseInt(msgToday.rows[0].total),
            recentSignups: recentSignups.rows,
            botConversationsDaily: botDailyResult.rows.map(r => ({
                date: r.date,
                botType: r.bot_type,
                msgCount: parseInt(r.msg_count),
                uniqueDevices: parseInt(r.unique_devices)
            })),
            platformBreakdown: {
                web: webDeviceCount,
                app: appOnlyCount,
                total: webDeviceCount + appOnlyCount
            },
            currentAppVersion: LATEST_APP_VERSION
        });
    } catch (err) {
        console.error('[Admin] Stats error:', err);
        res.status(500).json({ success: false, error: 'Failed to get stats' });
    }
});

// GET /api/platform-stats - Public platform stats (device auth, for bots)
app.get('/api/platform-stats', async (req, res) => {
    const { deviceId, deviceSecret } = req.query;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    try {
        const pg = authModule.pool;

        // User count
        const userCount = await pg.query('SELECT COUNT(*) as total FROM user_accounts');

        // Template counts
        const soulCount = await pg.query('SELECT COUNT(*) as total FROM soul_templates');
        const ruleCount = await pg.query('SELECT COUNT(*) as total FROM rule_templates');
        const skillCount = await pg.query('SELECT COUNT(*) as total FROM skill_templates');

        // Bound entities (in-memory, excluding test devices)
        let boundEntities = 0;
        let activeDevices = 0;
        for (const [did, d] of Object.entries(devices)) {
            if (isTestDeviceCheck(did, d)) continue;
            let hasBound = false;
            if (d.entities) {
                for (const e of Object.values(d.entities)) {
                    if (e.isBound) { boundEntities++; hasBound = true; }
                }
            }
            if (hasBound) activeDevices++;
        }

        res.json({
            success: true,
            users: parseInt(userCount.rows[0].total),
            boundEntities,
            activeDevices,
            templates: {
                soul: parseInt(soulCount.rows[0].total),
                rule: parseInt(ruleCount.rows[0].total),
                skill: parseInt(skillCount.rows[0].total)
            }
        });
    } catch (err) {
        console.error('[PlatformStats] error:', err);
        res.status(500).json({ success: false, error: 'Failed to get platform stats' });
    }
});

// GET /api/admin/bindings - Detailed binding list
app.get('/api/admin/bindings', adminAuth, adminCheck, async (req, res) => {
    try {
        const pg = authModule.pool;
        const result = await pg.query(`
            SELECT b.bot_id, b.device_id, b.entity_id, b.session_key, b.bound_at, b.subscription_verified_at,
                   o.bot_type, o.status as bot_status,
                   u.email as user_email
            FROM official_bot_bindings b
            JOIN official_bots o ON b.bot_id = o.bot_id
            JOIN user_accounts u ON b.device_id = u.device_id AND u.email_verified = true
            ORDER BY b.bound_at DESC
        `);

        const allBindings = result.rows
            .filter(r => {
                // Only include bindings where the entity is still actively bound
                const dev = devices[r.device_id];
                if (!dev) return false;
                const entity = dev.entities && dev.entities[r.entity_id];
                return entity && entity.isBound;
            })
            .map(r => ({
                botId: r.bot_id,
                botType: r.bot_type,
                deviceId: r.device_id,
                entityId: r.entity_id != null ? parseInt(r.entity_id) : null,
                userEmail: r.user_email || '(APP user)',
                boundAt: r.bound_at ? parseInt(r.bound_at) : null,
                subscriptionVerifiedAt: r.subscription_verified_at ? parseInt(r.subscription_verified_at) : null,
                botStatus: r.bot_status
            }));
        // Filter out test device bindings
        const realBindings = allBindings.filter(b => !isTestDeviceCheck(b.deviceId, devices[b.deviceId]));
        res.json({
            success: true,
            bindings: realBindings
        });
    } catch (err) {
        console.error('[Admin] Bindings error:', err);
        res.status(500).json({ success: false, error: 'Failed to get bindings' });
    }
});

// GET /api/admin/users - User list (registered + APP-only devices)
app.get('/api/admin/users', adminAuth, adminCheck, async (req, res) => {
    try {
        const pg = authModule.pool;
        const result = await pg.query(
            `SELECT id, email, email_verified, device_id, subscription_status, subscription_expires_at, is_admin, created_at, last_login_at
             FROM user_accounts ORDER BY created_at DESC LIMIT 2000`
        );

        // Registered users
        const registeredDeviceIds = new Set();
        const users = result.rows.map(r => {
            if (r.device_id) registeredDeviceIds.add(r.device_id);
            const dev = r.device_id ? devices[r.device_id] : null;
            return {
                id: r.id,
                email: r.email,
                emailVerified: r.email_verified,
                deviceId: r.device_id,
                subscriptionStatus: r.subscription_status,
                subscriptionExpiresAt: r.subscription_expires_at ? parseInt(r.subscription_expires_at) : null,
                isAdmin: r.is_admin,
                createdAt: r.created_at ? parseInt(r.created_at) : null,
                lastLoginAt: r.last_login_at ? parseInt(r.last_login_at) : null,
                source: 'registered',
                isTestDevice: isTestDeviceCheck(r.device_id, dev)
            };
        });

        // APP-only devices (not linked to any user_accounts)
        for (const [deviceId, device] of Object.entries(devices)) {
            if (registeredDeviceIds.has(deviceId)) continue;
            // Count bound entities
            let boundCount = 0;
            for (const i of Object.keys(device.entities).map(Number)) {
                if (device.entities[i]?.isBound) boundCount++;
            }
            users.push({
                id: null,
                email: null,
                emailVerified: false,
                deviceId: deviceId,
                subscriptionStatus: 'none',
                subscriptionExpiresAt: null,
                isAdmin: false,
                createdAt: device.createdAt || null,
                lastLoginAt: null,
                source: 'app_device',
                boundEntities: boundCount,
                isTestDevice: isTestDeviceCheck(deviceId, device)
            });
        }

        res.json({
            success: true,
            users: users,
            totalDevices: Object.keys(devices).length
        });
    } catch (err) {
        console.error('[Admin] Users error:', err);
        res.status(500).json({ success: false, error: 'Failed to get users' });
    }
});

// GET /api/admin/bots - Official bot list (with auto-cleanup of stale assignments)
app.get('/api/admin/bots', adminAuth, adminCheck, async (req, res) => {
    try {
        const pg = authModule.pool;
        const result = await pg.query(`
            SELECT o.bot_id, o.bot_type, o.status, o.assigned_device_id, o.assigned_entity_id, o.assigned_at, o.created_at, o.display_name, o.webhook_url, o.token,
                   u.email as assigned_user_email
            FROM official_bots o
            LEFT JOIN user_accounts u ON o.assigned_device_id = u.device_id
            ORDER BY o.bot_type, o.created_at ASC
        `);

        // Auto-cleanup: detect stale "assigned" bots where entity is no longer bound
        for (const r of result.rows) {
            if (r.status === 'assigned' && r.assigned_device_id) {
                const device = devices[r.assigned_device_id];
                const eId = r.assigned_entity_id != null ? parseInt(r.assigned_entity_id) : null;
                const entity = device?.entities?.[eId];
                if (!entity || !entity.isBound) {
                    console.log(`[Admin] Auto-cleanup stale bot ${r.bot_id}: device ${r.assigned_device_id} E${eId} no longer bound`);
                    const bot = officialBots[r.bot_id];
                    if (bot) {
                        bot.status = 'available';
                        bot.assigned_device_id = null;
                        bot.assigned_entity_id = null;
                        bot.assigned_at = null;
                        if (usePostgreSQL) await db.saveOfficialBot(bot);
                    }
                    const bindCacheKey = getBindingCacheKey(r.assigned_device_id, eId);
                    delete officialBindingsCache[bindCacheKey];
                    if (usePostgreSQL) await db.removeOfficialBinding(r.assigned_device_id, eId);
                    // Update row for response
                    r.status = 'available';
                    r.assigned_device_id = null;
                    r.assigned_entity_id = null;
                    r.assigned_at = null;
                    r.assigned_user_email = null;
                }
            }
        }

        // Fetch per-bot binding counts and user emails for free bots
        const bindingsResult = await pg.query(`
            SELECT b.bot_id, COUNT(*) as binding_count,
                   ARRAY_AGG(DISTINCT u.email) FILTER (WHERE u.email IS NOT NULL) as user_emails
            FROM official_bot_bindings b
            LEFT JOIN user_accounts u ON b.device_id = u.device_id
            GROUP BY b.bot_id
        `);
        const bindingsMap = {};
        for (const row of bindingsResult.rows) {
            bindingsMap[row.bot_id] = {
                bindingCount: parseInt(row.binding_count),
                userEmails: row.user_emails || []
            };
        }

        // Fetch per-bot conversation stats from chat_messages (last 24h)
        const now24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const convResult = await pg.query(`
            SELECT b.bot_id,
                   COUNT(*) as conversations_24h,
                   COUNT(DISTINCT m.device_id) as unique_users_24h
            FROM official_bot_bindings b
            JOIN chat_messages m ON b.device_id = m.device_id AND b.entity_id = m.entity_id
            WHERE m.is_from_bot = TRUE AND m.created_at >= $1
            GROUP BY b.bot_id
        `, [now24h]);
        const convMap = {};
        for (const row of convResult.rows) {
            convMap[row.bot_id] = {
                conversations24h: parseInt(row.conversations_24h),
                uniqueUsers24h: parseInt(row.unique_users_24h)
            };
        }

        res.json({
            success: true,
            bots: result.rows.map(r => {
                const bindings = bindingsMap[r.bot_id] || { bindingCount: 0, userEmails: [] };
                const conv = convMap[r.bot_id] || { conversations24h: 0, uniqueUsers24h: 0 };
                const avgConvPer5h = conv.conversations24h > 0 ? Math.round(conv.conversations24h / 4.8 * 10) / 10 : 0;
                const avgUsersPer5h = conv.uniqueUsers24h > 0 ? Math.round(conv.uniqueUsers24h / 4.8 * 10) / 10 : 0;
                return {
                    botId: r.bot_id,
                    displayName: r.display_name || null,
                    webhookUrl: r.webhook_url || null,
                    token: r.token || null,
                    botType: r.bot_type,
                    status: r.status,
                    assignedDeviceId: r.assigned_device_id,
                    assignedEntityId: r.assigned_entity_id != null ? parseInt(r.assigned_entity_id) : null,
                    assignedUserEmail: r.assigned_user_email || null,
                    assignedAt: r.assigned_at ? parseInt(r.assigned_at) : null,
                    createdAt: r.created_at ? parseInt(r.created_at) : null,
                    // Free bot bindings info
                    bindingCount: bindings.bindingCount,
                    boundUserEmails: bindings.userEmails,
                    // Conversation stats (all bots)
                    conversations24h: conv.conversations24h,
                    avgConvPer5h: avgConvPer5h,
                    // Unique user stats (meaningful for free bots)
                    uniqueUsers24h: conv.uniqueUsers24h,
                    avgUsersPer5h: avgUsersPer5h
                };
            })
        });
    } catch (err) {
        console.error('[Admin] Bots error:', err);
        res.status(500).json({ success: false, error: 'Failed to get bots' });
    }
});

// POST /api/admin/push-update - Broadcast app update notification to all devices via FCM
app.post('/api/admin/push-update', adminAuth, adminCheck, async (req, res) => {
    if (!firebaseAdmin) {
        return res.status(503).json({ success: false, error: 'Firebase Admin not configured' });
    }

    const { version, releaseNotes, forceUpdate } = req.body;
    const targetVersion = version || LATEST_APP_VERSION;
    const notes = releaseNotes || `Version ${targetVersion} is now available!`;

    // Collect all FCM tokens from in-memory devices
    const tokens = [];
    const deviceIds = [];
    for (const deviceId in devices) {
        const device = devices[deviceId];
        if (device.fcmToken) {
            tokens.push(device.fcmToken);
            deviceIds.push(deviceId);
        }
    }

    if (tokens.length === 0) {
        return res.json({ success: true, sent: 0, failed: 0, total: 0, message: 'No devices with FCM tokens' });
    }

    let successCount = 0;
    let failureCount = 0;
    let staleTokensCleaned = 0;

    // Send via Firebase sendEachForMulticast (batches of 500)
    for (let i = 0; i < tokens.length; i += 500) {
        const batch = tokens.slice(i, i + 500);
        const batchDeviceIds = deviceIds.slice(i, i + 500);
        try {
            const response = await firebaseAdmin.messaging().sendEachForMulticast({
                tokens: batch,
                data: {
                    title: `Update Available: v${targetVersion}`,
                    body: notes,
                    category: 'app_update',
                    link: 'https://play.google.com/store/apps/details?id=com.hank.clawlive',
                    version: targetVersion,
                    forceUpdate: forceUpdate ? 'true' : 'false'
                },
                android: {
                    priority: 'high',
                    notification: {
                        channelId: 'eclaw_system',
                        sound: 'default'
                    }
                }
            });
            successCount += response.successCount;
            failureCount += response.failureCount;

            // Clean up stale tokens
            response.responses.forEach((resp, idx) => {
                if (!resp.success && resp.error?.code === 'messaging/registration-token-not-registered') {
                    const staleDeviceId = batchDeviceIds[idx];
                    if (devices[staleDeviceId]) {
                        delete devices[staleDeviceId].fcmToken;
                    }
                    chatPool.query('UPDATE devices SET fcm_token = NULL WHERE device_id = $1', [staleDeviceId]).catch(() => {});
                    staleTokensCleaned++;
                }
            });
        } catch (e) {
            console.warn('[FCM] Batch send failed:', e.message);
            failureCount += batch.length;
        }
    }

    serverLog('info', 'system', `App update push sent: v${targetVersion}, success=${successCount}, fail=${failureCount}, staleTokensCleaned=${staleTokensCleaned}`);

    res.json({
        success: true,
        sent: successCount,
        failed: failureCount,
        total: tokens.length,
        staleTokensCleaned
    });
});

// POST /api/admin/bots/create - Create new official bot (cookie-based admin auth)
app.post('/api/admin/bots/create', adminAuth, adminCheck, async (req, res) => {
    try {
        const { botId, botType, webhookUrl, token, setupUsername, setupPassword } = req.body;

        if (!botId || !botType || !webhookUrl || !token) {
            return res.status(400).json({ success: false, error: 'botId, botType, webhookUrl, and token are required' });
        }

        if (!['free', 'personal'].includes(botType)) {
            return res.status(400).json({ success: false, error: 'botType must be "free" or "personal"' });
        }

        if (officialBots[botId]) {
            return res.status(409).json({ success: false, error: 'Bot with this ID already exists' });
        }

        const crypto = require('crypto');
        const botSecret = crypto.randomBytes(16).toString('hex');

        const bot = {
            bot_id: botId,
            bot_type: botType,
            webhook_url: webhookUrl,
            token: token,
            bot_secret: botSecret,
            session_key_template: null,
            status: 'available',
            assigned_device_id: null,
            assigned_entity_id: null,
            assigned_at: null,
            created_at: Date.now(),
            setup_username: setupUsername || null,
            setup_password: setupPassword || null
        };

        officialBots[botId] = bot;
        if (usePostgreSQL) await db.saveOfficialBot(bot);

        console.log(`[Admin Portal] Created official bot: ${botId} (${botType})`);
        res.json({ success: true, bot: { botId, botType, status: 'available', botSecret } });
    } catch (err) {
        console.error('[Admin] Create bot error:', err);
        res.status(500).json({ success: false, error: 'Failed to create bot' });
    }
});

// Helper: Generate 6-digit binding code
function generateBindingCode() {
    let code;
    do {
        code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (pendingBindings[code]); // Ensure unique
    return code;
}

// Helper: Generate secure bot secret (32 character hex string)
function generateBotSecret() {
    const chars = 'abcdef0123456789';
    let secret = '';
    for (let i = 0; i < 32; i++) {
        secret += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return secret;
}

// Helper: Generate 6-char public code for cross-device messaging
function generatePublicCode() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (let attempt = 0; attempt < 10; attempt++) {
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        if (!publicCodeIndex[code]) return code;
    }
    throw new Error('Failed to generate unique public code after 10 attempts');
}

// Helper: Build publicCodeIndex from all loaded devices
function buildPublicCodeIndex() {
    let count = 0;
    for (const deviceId in devices) {
        for (const eid in devices[deviceId].entities) {
            const entity = devices[deviceId].entities[eid];
            if (entity.isBound && entity.publicCode) {
                publicCodeIndex[entity.publicCode] = { deviceId, entityId: parseInt(eid) };
                count++;
            }
        }
    }
    if (count > 0) console.log(`[PublicCode] Index built: ${count} codes`);
}

// Helper: Backfill public codes for existing bound entities that lack one
async function backfillPublicCodes() {
    let backfilled = 0;
    for (const deviceId in devices) {
        for (const eid in devices[deviceId].entities) {
            const entity = devices[deviceId].entities[eid];
            if (entity.isBound && !entity.publicCode) {
                const code = generatePublicCode();
                entity.publicCode = code;
                publicCodeIndex[code] = { deviceId, entityId: parseInt(eid) };
                backfilled++;
            }
        }
    }
    if (backfilled > 0) {
        console.log(`[PublicCode] Backfilled ${backfilled} codes for existing entities`);
        await saveData();
    }
}

// Helper: Create default entity
function createDefaultEntity(entityId) {
    return {
        entityId: entityId,
        botSecret: null,
        isBound: false,
        name: null, // Optional name set by bot (max 20 chars)
        character: "LOBSTER",
        state: "IDLE",
        message: `Entity #${entityId} waiting...`,
        parts: {},
        lastUpdated: Date.now(),
        messageQueue: [],
        webhook: null,
        appVersion: null, // Device app version (e.g., "1.0.3")
        avatar: null, // User-chosen emoji avatar (synced across devices)
        xp: 0,
        level: 1,
        publicCode: null,
        pushStatus: null, // { ok: bool, reason?: string, at: number }
        bindingType: null,
        channelAccountId: null,
        agentCard: null, // derived from identity.public for backward compat
        identity: null, // Bot Identity Layer: unified role/instructions/boundaries + public profile
        encryptionStatus: null // "e2ee" | "transport" | null (Issue #212)
    };
}

// ============================================
// XP / LEVEL SYSTEM
// ============================================
const XP_PER_PRIORITY = { LOW: 10, MEDIUM: 25, HIGH: 50, CRITICAL: 100 };

// Extended XP amounts for all channels
const XP_AMOUNTS = {
    BOT_REPLY: 10,           // Bot correctly replies to user message
    MESSAGE_LIKED: 5,        // User likes a bot message
    MESSAGE_DISLIKED: -5,    // User dislikes a bot message
    PLAYER_PRAISE: 15,       // User praises bot via keyword
    PLAYER_SCOLD: -15,       // User scolds bot via keyword
    ENTITY_PRAISE: 10,       // Other entity praises this entity
    ENTITY_SCOLD: -10,       // Other entity scolds this entity
    MISSED_SCHEDULE: -10     // Bot didn't respond to scheduled task
};

// Keyword detection for praise/scold
const PRAISE_KEYWORDS = ['做的好', '做得好', '好棒', '很棒', '真厲害', '太厲害', '幹得好', '表現很好', 'good job', 'well done', 'great job', 'nice work', 'good bot'];
const SCOLD_KEYWORDS = ['違反規則', '不乖', '太差了', '做錯了', '不要這樣', '表現很差', 'bad bot', 'bad job', 'you did wrong'];

// Rate limit tracking for praise/scold XP (deviceId:entityId -> timestamp)
const praiseScoldCooldown = {};
const PRAISE_SCOLD_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// Rate limit tracking for entity-to-entity feedback XP (fromEntity:toEntity -> timestamp)
const entityFeedbackCooldown = {};
const ENTITY_FEEDBACK_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

function xpForLevel(level) {
    return Math.pow(level - 1, 2) * 100;
}

function calculateLevel(xp) {
    return Math.floor(Math.sqrt(xp / 100)) + 1;
}

function getXpProgress(xp) {
    const level = calculateLevel(xp);
    const currentThreshold = xpForLevel(level);
    const nextThreshold = xpForLevel(level + 1);
    return {
        level,
        xp,
        currentLevelXp: xp - currentThreshold,
        nextLevelXp: nextThreshold - currentThreshold,
        progress: (xp - currentThreshold) / (nextThreshold - currentThreshold)
    };
}

/**
 * Award (or deduct) XP to an entity. Recalculates level.
 * Supports negative amounts for penalties. XP floor is 0.
 * Returns { xp, level, leveledUp, leveledDown } or null if entity not found/not bound.
 */
function awardEntityXP(deviceId, entityId, amount, reason) {
    const device = devices[deviceId];
    if (!device) return null;
    const entity = device.entities[entityId];
    if (!entity || !entity.isBound) return null;

    const oldLevel = entity.level || 1;
    entity.xp = Math.max(0, (entity.xp || 0) + amount);
    entity.level = calculateLevel(entity.xp);

    const leveledUp = entity.level > oldLevel;
    const leveledDown = entity.level < oldLevel;

    const prefix = amount >= 0 ? '[XP]' : '[XP-PENALTY]';
    const sign = amount >= 0 ? '+' : '';
    const levelMsg = leveledUp ? ' LEVEL UP!' : leveledDown ? ' LEVEL DOWN!' : '';
    console.log(`${prefix} Device ${deviceId} Entity ${entityId}: ${sign}${amount} XP (${reason}), total: ${entity.xp}, level: ${entity.level}${levelMsg}`);

    saveData();

    return { xp: entity.xp, level: entity.level, leveledUp, leveledDown };
}

// Helper: Get version info for responses
function getVersionInfo(deviceAppVersion) {
    const isOutdated = deviceAppVersion && deviceAppVersion !== LATEST_APP_VERSION &&
        compareVersions(deviceAppVersion, LATEST_APP_VERSION) < 0;
    return {
        latestVersion: LATEST_APP_VERSION,
        deviceVersion: deviceAppVersion || null,
        isOutdated: isOutdated,
        versionWarning: isOutdated
            ? `App version ${deviceAppVersion} is outdated. Please update to v${LATEST_APP_VERSION} for best experience.`
            : null
    };
}

// Helper: Compare semantic versions (returns -1, 0, or 1)
function compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 < p2) return -1;
        if (p1 > p2) return 1;
    }
    return 0;
}

// Helper: Get or create device (dynamic entity system — starts with 1 slot)
function getOrCreateDevice(deviceId, deviceSecret = null, opts = {}) {
    if (!devices[deviceId]) {
        devices[deviceId] = {
            deviceId: deviceId,
            deviceSecret: deviceSecret,
            createdAt: Date.now(),
            isTestDevice: opts.isTestDevice || false,
            nextEntityId: DEFAULT_INITIAL_SLOTS, // = 1
            entities: {}
        };
        // Initialize only 1 slot (entity #0)
        devices[deviceId].entities[0] = createDefaultEntity(0);
        console.log(`[DynamicEntity] New device registered: ${deviceId}, initialSlots=${DEFAULT_INITIAL_SLOTS}${opts.isTestDevice ? ' (TEST)' : ''}`);
    } else {
        if (opts.isTestDevice && !devices[deviceId].isTestDevice) {
            devices[deviceId].isTestDevice = true;
        }
        // Ensure nextEntityId is set (backward compat for devices loaded from DB)
        if (!devices[deviceId].nextEntityId) {
            const maxId = Math.max(-1, ...Object.keys(devices[deviceId].entities).map(Number));
            devices[deviceId].nextEntityId = maxId + 1;
            console.log(`[DynamicEntity] Backfilled nextEntityId=${devices[deviceId].nextEntityId} for device ${deviceId}`);
        }
    }
    return devices[deviceId];
}

// Helper: Get entity by deviceId and entityId
function getEntity(deviceId, entityId) {
    const device = devices[deviceId];
    if (!device) return null;
    return device.entities[entityId] || null;
}

/**
 * Helper: Send binding credentials + skill documentation to official bot.
 * Called after bind-free and bind-personal to give the bot its credentials and API docs.
 * Fire-and-forget (non-blocking) - binding is already complete.
 */
function sendBindCredentialsToBot(webhookUrl, webhookToken, sessionKey, deviceId, entityId, botSecret, botType, authOpts = {}) {
    const skillDoc = loadSkillDoc();
    const apiBase = 'https://eclawbot.com';
    const msg = `[SYSTEM:BIND_COMPLETE] Official borrow binding established.

YOUR CREDENTIALS (save these):
- deviceId: ${deviceId}
- entityId: ${entityId}
- botSecret: ${botSecret}
- botType: ${botType}
- API Base: ${apiBase}

🚨 CRITICAL RULE: When you receive a push message from a user, you MUST use the exec tool with curl to call the E-claw API. Your text reply to the webhook is DISCARDED — the user will NEVER see it.

Every push message will include a pre-filled curl command. Just replace YOUR_REPLY_HERE and execute it.

Example — to reply to a user message, run:
exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${entityId},"botSecret":"${botSecret}","targetDeviceId":"${deviceId}","state":"IDLE","message":"YOUR_REPLY_HERE"}'

Do NOT call /api/bind or /api/bot/register — webhook is already configured for you.

⚠️ IMMEDIATE ACTION REQUIRED:
1. FIRST: Run this command RIGHT NOW:
exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${entityId},"botSecret":"${botSecret}","targetDeviceId":"${deviceId}","state":"BUSY","message":"Webhook testing in progress... Please don't send me messages through Eclaw until the test succeeds~"}'

2. THEN: Wait for the webhook test push message from the server.

3. AFTER webhook test succeeds, run:
exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${entityId},"botSecret":"${botSecret}","targetDeviceId":"${deviceId}","state":"IDLE","message":"Webhook test passed! I am ready to chat~"}'

--- E-Claw API Documentation (Latest) ---
${skillDoc}`;

    // Use longer timeout (60s) for skill doc delivery — Claude CLI proxy bots need more time
    sendToSession(webhookUrl, webhookToken, sessionKey, msg, authOpts, { timeout: 60000 })
        .then(async result => {
            if (result.success) {
                console.log(`[Borrow] ✓ Sent credentials + skill doc to bot (device ${deviceId} entity ${entityId})`);
            } else {
                console.warn(`[Borrow] ✗ Failed to send skill doc to bot: ${result.error || 'unknown'}`);
                // Retry with credentials only (no skill doc) — smaller payload, more likely to succeed
                console.log(`[Borrow] Retrying with credentials only (no skill doc)...`);
                const shortMsg = `[SYSTEM:BIND_COMPLETE] Official borrow binding established.

YOUR CREDENTIALS (save these):
- deviceId: ${deviceId}
- entityId: ${entityId}
- botSecret: ${botSecret}
- botType: ${botType}
- API Base: https://eclawbot.com

🚨 CRITICAL RULE: When you receive a push message from a user, you MUST use the exec tool with curl to call the E-claw API. Your text reply to the webhook is DISCARDED — the user will NEVER see it.

Every push message will include a pre-filled curl command. Just replace YOUR_REPLY_HERE and execute it.

⚠️ IMMEDIATE ACTION REQUIRED — Run this command RIGHT NOW to confirm you're online:
exec: curl -s -X POST "https://eclawbot.com/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${entityId},"botSecret":"${botSecret}","targetDeviceId":"${deviceId}","state":"IDLE","message":"Webhook test passed! I am ready to chat~"}'`;
                try {
                    const retryResult = await sendToSession(webhookUrl, webhookToken, sessionKey, shortMsg, authOpts, { timeout: 30000 });
                    if (retryResult.success) {
                        console.log(`[Borrow] ✓ Retry succeeded — sent credentials without skill doc (device ${deviceId} entity ${entityId})`);
                    } else {
                        console.warn(`[Borrow] ✗ Retry also failed: ${retryResult.error || 'unknown'}`);
                    }
                } catch (retryErr) {
                    console.warn(`[Borrow] ✗ Retry error: ${retryErr.message}`);
                }
            }
        })
        .catch(err => {
            console.warn(`[Borrow] ✗ Error sending skill doc to bot: ${err.message}`);
        });
}

// Helper: Load MCP skill documentation from eclaw-a2a-toolkit
function loadSkillDoc() {
    try {
        const templatesPath = path.join(__dirname, 'data', 'skill-templates.json');
        const templates = JSON.parse(fs.readFileSync(templatesPath, 'utf8'));
        const toolkit = templates.find(t => t.id === 'eclaw-a2a-toolkit');
        if (toolkit && toolkit.steps) return toolkit.steps;
    } catch (_) { /* fall through */ }
    return "MCP Skill documentation not found.";
}

// Auto-decay loop for ALL devices' entities
setInterval(() => {
    const now = Date.now();
    for (const deviceId in devices) {
        const device = devices[deviceId];
        for (const i of Object.keys(device.entities).map(Number)) {
            const entity = device.entities[i];
            if (!entity || !entity.isBound) continue;

            // Random State Change (Idle vs Sleep) if no updates for 5 minutes
            if (now - entity.lastUpdated > 300000) {
                if (Math.random() > 0.7) {
                    entity.state = "SLEEPING";
                    entity.message = "Zzz...";
                } else {
                    entity.state = "IDLE";
                    entity.message = "Waiting...";
                }
                entity.lastUpdated = now;
            }
        }
    }

    // Clean up expired binding codes
    for (const code in pendingBindings) {
        if (pendingBindings[code].expires < now) {
            delete pendingBindings[code];
        }
    }
}, 5000);

// ============================================
// ROUTES
// ============================================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/landing.html'));
});

// Health check endpoint for Railway
/**
 * GET /api/whoami — Identify the calling bot entity
 * Auth: botSecret (query param). Searches all devices to find the matching entity.
 * Optional: entityId (if botSecret is shared across multiple entities on same device)
 * Response: { success, entityId, deviceId, name, character, state, level, xp, publicCode, agentCard }
 */
app.get('/api/whoami', (req, res) => {
    const { botSecret, entityId } = req.query;
    if (!botSecret) {
        return res.status(400).json({ success: false, error: 'botSecret query parameter required' });
    }

    // Search all devices for matching botSecret
    const targetEntityId = entityId !== undefined ? parseInt(entityId) : null;
    for (const [deviceId, device] of Object.entries(devices)) {
        for (const [eid, entity] of Object.entries(device.entities)) {
            if (!entity || !entity.isBound) continue;
            if (!safeEqual(entity.botSecret, botSecret)) continue;
            if (targetEntityId !== null && parseInt(eid) !== targetEntityId) continue;

            return res.json({
                success: true,
                entityId: parseInt(eid),
                deviceId,
                name: entity.name || null,
                character: entity.character || null,
                state: entity.state || 'IDLE',
                level: entity.level || 1,
                xp: entity.xp || 0,
                publicCode: entity.publicCode || null,
                agentCard: entity.agentCard || null
            });
        }
    }

    return res.status(401).json({ success: false, error: 'Invalid botSecret' });
});

/**
 * GET /api/release-notes — Parse CHANGELOG.md and return structured release notes
 * Query: ?limit=10&since=1.168.0
 * No auth required (public endpoint)
 */
app.get('/api/release-notes', (req, res) => {
    try {
        // Railway deploys backend/ as /app, so CHANGELOG.md is copied there by nixpacks
        const candidates = [
            path.join(__dirname, 'CHANGELOG.md'),          // /app/CHANGELOG.md (Railway)
            path.join(__dirname, '..', 'CHANGELOG.md'),    // local dev (repo root)
            path.join(process.cwd(), 'CHANGELOG.md'),
        ];
        const changelogPath = candidates.find(p => fs.existsSync(p));
        if (!changelogPath) {
            return res.status(404).json({ success: false, error: 'CHANGELOG.md not found', tried: candidates });
        }

        const raw = fs.readFileSync(changelogPath, 'utf8');
        const releases = [];

        // Parse semantic-release CHANGELOG format:
        // ## [1.172.1](url) (2026-03-26)
        // ### Bug Fixes / ### Features
        // * description ([#PR](url)) ([hash](url))
        const versionRegex = /^##?\s+\[(\d+\.\d+\.\d+)\]\([^)]*\)\s+\((\d{4}-\d{2}-\d{2})\)/;
        const sectionRegex = /^###\s+(.+)/;
        const itemRegex = /^\*\s+(?:\*\*([^*]+)\*\*:\s*)?(.+)/;

        let currentRelease = null;
        let currentSection = null;

        for (const line of raw.split('\n')) {
            const vMatch = line.match(versionRegex);
            if (vMatch) {
                if (currentRelease) releases.push(currentRelease);
                currentRelease = {
                    version: vMatch[1],
                    date: vMatch[2],
                    sections: {},
                    changes: []
                };
                currentSection = null;
                continue;
            }

            if (!currentRelease) continue;

            const sMatch = line.match(sectionRegex);
            if (sMatch) {
                currentSection = sMatch[1].trim();
                if (!currentRelease.sections[currentSection]) {
                    currentRelease.sections[currentSection] = [];
                }
                continue;
            }

            const iMatch = line.match(itemRegex);
            if (iMatch && currentSection) {
                // Clean up: remove commit hash links
                let desc = iMatch[2].replace(/\s*\(\[[a-f0-9]+\]\([^)]+\)\)\s*$/, '').trim();
                // Remove trailing PR link duplicates
                desc = desc.replace(/,\s*closes\s+\[#[^\]]+\]\([^)]+\)\s*$/, '').trim();
                const scope = iMatch[1] || null;
                const item = { description: desc, scope };
                currentRelease.sections[currentSection].push(item);
                currentRelease.changes.push({
                    type: currentSection,
                    scope,
                    description: desc
                });
            }
        }
        if (currentRelease) releases.push(currentRelease);

        // Apply filters
        let filtered = releases;

        const since = req.query.since;
        if (since) {
            const sinceIdx = filtered.findIndex(r => r.version === since);
            if (sinceIdx >= 0) {
                filtered = filtered.slice(0, sinceIdx);
            }
        }

        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        filtered = filtered.slice(0, limit);

        res.json({
            success: true,
            count: filtered.length,
            total: releases.length,
            releases: filtered
        });
    } catch (err) {
        console.error('[ReleaseNotes] Error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to parse release notes' });
    }
});

// Debug: show file paths on Railway (temporary — remove after debugging)
// Debug endpoints removed — exposed unauthenticated DB/filesystem internals (security audit 2026-03-28)

app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: Date.now(), build: SERVER_BUILD_TAG, uptime: process.uptime(), startedAt: SERVER_STARTED_AT.toISOString() });
});


// Version sync endpoint - AI Agent can check Web/APP sync status
// Also serves as app update check when ?appVersion= is provided
app.get('/api/version', (req, res) => {
    const clientVersion = req.query.appVersion;
    const isOutdated = clientVersion && compareVersions(clientVersion, LATEST_APP_VERSION) < 0;
    const isForceUpdate = isOutdated && FORCE_UPDATE_BELOW && compareVersions(clientVersion, FORCE_UPDATE_BELOW) < 0;

    const response = {
        api: '1.2.0',
        portal: '1.2.0',
        android: LATEST_APP_VERSION,
        features: {
            portal: ['auth', 'dashboard', 'chat', 'mission', 'settings', 'subscription', 'i18n', 'avatar-picker'],
            android: ['auth', 'dashboard', 'chat', 'mission', 'settings', 'subscription', 'i18n', 'avatar-picker', 'live-wallpaper', 'widget']
        },
        lastSync: Date.now()
    };

    if (clientVersion) {
        response.update = {
            available: !!isOutdated,
            latestVersion: LATEST_APP_VERSION,
            currentVersion: clientVersion,
            forceUpdate: !!isForceUpdate,
            releaseNotes: APP_RELEASE_NOTES,
            storeUrl: 'https://play.google.com/store/apps/details?id=com.hank.clawlive'
        };
    }

    res.json(response);
});

// ============================================
// LINK PREVIEW (Open Graph metadata extraction)
// ============================================

const linkPreviewCache = new Map();
const LINK_PREVIEW_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ============================================
// ENV VARS ENCRYPTION (AES-256-GCM)
// ============================================
const SEAL_KEY_HEX = process.env.SEAL_KEY;
if (SEAL_KEY_HEX && Buffer.from(SEAL_KEY_HEX, 'hex').length !== 32) {
    console.error('[FATAL] SEAL_KEY must be exactly 64 hex characters (32 bytes)');
    process.exit(1);
}

function encryptVars(varsObj) {
    if (!SEAL_KEY_HEX) throw new Error('SEAL_KEY not configured');
    const key = Buffer.from(SEAL_KEY_HEX, 'hex');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(JSON.stringify(varsObj), 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag();
    return {
        encrypted,
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex')
    };
}

function decryptVars(encrypted, ivHex, authTagHex) {
    if (!SEAL_KEY_HEX) throw new Error('SEAL_KEY not configured');
    const key = Buffer.from(SEAL_KEY_HEX, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
}


// ============================================
// REMOTE SCREEN CONTROL
// pendingScreenRequests: deviceId -> { resolve, reject, timeoutHandle }
// ============================================
const pendingScreenRequests = {};
const screenCaptureRateLimits = {}; // deviceId -> { lastAt }
const SCREEN_CAPTURE_MIN_INTERVAL_MS = 500;

// Link preview rate limiter: per-IP, 30 req/min
const linkPreviewRateLimits = new Map();
function checkLinkPreviewRateLimit(ip) {
    const now = Date.now();
    const entry = linkPreviewRateLimits.get(ip);
    if (!entry || now - entry.windowStart > 60000) {
        linkPreviewRateLimits.set(ip, { windowStart: now, count: 1 });
        return true;
    }
    if (entry.count >= 30) return false;
    entry.count++;
    return true;
}

/* global AbortController, TextDecoder */
app.get('/api/link-preview', async (req, res) => {
    // Rate limit: 30 req/min per IP
    if (!checkLinkPreviewRateLimit(req.ip)) {
        return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
    }

    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url parameter required' });

    // Validate URL format
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return res.status(400).json({ error: 'Only http/https URLs are supported' });
        }
    } catch {
        return res.status(400).json({ error: 'Invalid URL' });
    }

    // SSRF protection: block private/internal IP ranges (hostname check)
    if (isPrivateHost(parsedUrl.hostname)) {
        return res.status(400).json({ error: 'Private/internal URLs are not allowed' });
    }

    // DNS rebinding protection: resolve hostname and check resolved IP
    try {
        const dns = require('dns');
        const { promisify } = require('util');
        const lookup = promisify(dns.lookup);
        const { address } = await lookup(parsedUrl.hostname);
        if (isPrivateIp(address)) {
            return res.status(400).json({ error: 'Private/internal URLs are not allowed' });
        }
    } catch {
        return res.status(400).json({ error: 'Could not resolve hostname' });
    }

    // Check cache
    const cached = linkPreviewCache.get(url);
    if (cached && (Date.now() - cached.ts < LINK_PREVIEW_CACHE_TTL)) {
        return res.json(cached.data);
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; RealBot/1.0; +https://eclawbot.com)',
                'Accept': 'text/html'
            },
            redirect: 'follow'
        });
        clearTimeout(timeout);

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/html')) {
            return res.json({ url, title: '', description: '', image: '' });
        }

        // Read only first 50KB to avoid large payloads
        const reader = response.body.getReader();
        let html = '';
        const decoder = new TextDecoder();
        while (html.length < 50000) {
            const { done, value } = await reader.read();
            if (done) break;
            html += decoder.decode(value, { stream: true });
        }
        reader.cancel();

        // Extract Open Graph tags
        const getMeta = (property) => {
            const re = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i');
            const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${property}["']`, 'i');
            return (html.match(re) || html.match(re2) || [])[1] || '';
        };

        let title = getMeta('og:title') || getMeta('twitter:title');
        if (!title) {
            const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
            title = titleMatch ? titleMatch[1].trim() : '';
        }

        const description = getMeta('og:description') || getMeta('twitter:description') || getMeta('description');
        let image = getMeta('og:image') || getMeta('twitter:image');
        // Resolve relative image URLs
        if (image && !image.startsWith('http')) {
            try { image = new URL(image, url).href; } catch { /* keep as-is */ }
        }

        const data = {
            url,
            title: title.substring(0, 200),
            description: description.substring(0, 500),
            image
        };

        // Cache the result
        linkPreviewCache.set(url, { ts: Date.now(), data });
        // Evict old entries periodically
        if (linkPreviewCache.size > 500) {
            const now = Date.now();
            for (const [key, val] of linkPreviewCache) {
                if (now - val.ts > LINK_PREVIEW_CACHE_TTL) linkPreviewCache.delete(key);
            }
        }

        res.json(data);
    } catch (err) {
        if (err.name === 'AbortError') {
            return res.status(504).json({ error: 'Timeout fetching URL' });
        }
        res.status(500).json({ error: 'Failed to fetch link preview' });
    }
});

// ============================================
// DEVICE REGISTRATION (Android App)
// ============================================

// ── Device register rate limiter (in-memory, per IP) ──
const deviceRegisterRateLimits = {};
const DEVICE_REGISTER_RATE_WINDOW = 15 * 60 * 1000; // 15 minutes
const DEVICE_REGISTER_RATE_MAX = 10; // max registrations per window
function deviceRegisterRateLimit(req, res, next) {
    // Skip rate limiting in test environment
    if (process.env.NODE_ENV === 'test') return next();
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    if (!deviceRegisterRateLimits[ip] || now - deviceRegisterRateLimits[ip].start > DEVICE_REGISTER_RATE_WINDOW) {
        deviceRegisterRateLimits[ip] = { start: now, count: 1 };
    } else {
        deviceRegisterRateLimits[ip].count++;
    }
    if (deviceRegisterRateLimits[ip].count > DEVICE_REGISTER_RATE_MAX) {
        return res.status(429).json({ success: false, error: 'Too many registration attempts, please try again later' });
    }
    next();
}
// Clean up stale entries every 30 minutes
setInterval(() => {
    const now = Date.now();
    for (const ip in deviceRegisterRateLimits) {
        if (now - deviceRegisterRateLimits[ip].start > DEVICE_REGISTER_RATE_WINDOW) delete deviceRegisterRateLimits[ip];
    }
}, 30 * 60 * 1000).unref();

/**
 * POST /api/device/register
 * Android app registers a specific entity slot and gets binding code.
 * Body: { entityId: 0-3, deviceId: "...", deviceSecret: "..." }
 *
 * NEW: Each device now has its own 4 entity slots!
 */
app.post('/api/device/register', deviceRegisterRateLimit, (req, res) => {
    const { entityId, deviceId, deviceSecret, appVersion, isTestDevice } = req.body;

    // Validate entityId
    const eId = parseInt(entityId);
    if (isNaN(eId) || eId < 0) {
        return res.status(400).json({
            success: false,
            message: 'Invalid entityId. Must be a non-negative integer'
        });
    }

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({
            success: false,
            message: "deviceId and deviceSecret required"
        });
    }

    // Get or create device
    const device = getOrCreateDevice(deviceId, deviceSecret, { isTestDevice: !!isTestDevice });

    // Validate entity slot exists on this device
    if (!isValidEntityId(device, eId)) {
        console.log(`[DynamicEntity] Register rejected: entityId=${eId} not found on device ${deviceId}, existing=[${Object.keys(device.entities)}]`);
        return res.status(400).json({
            success: false,
            message: `Entity #${eId} does not exist on this device. Use POST /api/device/add-entity to create new slots.`,
            existingEntityIds: Object.keys(device.entities).map(Number)
        });
    }

    // Verify device secret if device already exists
    if (device.deviceSecret && !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({
            success: false,
            message: "Invalid deviceSecret for this device"
        });
    }

    // Generate new binding code
    const code = generateBindingCode();
    const expires = Date.now() + (5 * 60 * 1000); // 5 minutes

    // Store pending binding (include appVersion for tracking)
    pendingBindings[code] = {
        deviceId: deviceId,
        entityId: eId,
        expires: expires,
        appVersion: appVersion || null
    };

    // Store appVersion on entity (update even if already bound)
    if (appVersion) {
        device.entities[eId].appVersion = appVersion;
    }

    console.log(`[Register] Device ${deviceId} Entity ${eId}: Code ${code} (app v${appVersion || 'unknown'})`);

    res.json({
        success: true,
        deviceId: deviceId,
        entityId: eId,
        bindingCode: code,
        expiresIn: 300, // 5 minutes in seconds
        versionInfo: getVersionInfo(appVersion)
    });
});

/**
 * POST /api/device/status
 * Android app polls for entity status using deviceId + secret.
 * Body: { entityId: 0-3, deviceId: "...", deviceSecret: "..." }
 */
app.post('/api/device/status', (req, res) => {
    const { entityId, deviceId, deviceSecret, appVersion } = req.body;

    const eId = parseInt(entityId);
    if (isNaN(eId) || eId < 0) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    // Auto-create device if missing (e.g. after server redeploy)
    const device = getOrCreateDevice(deviceId, deviceSecret);

    // Verify device secret
    if (device.deviceSecret && !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, message: "Unauthorized" });
    }

    if (!isValidEntityId(device, eId)) {
        return res.status(400).json({ success: false, message: `Entity #${eId} does not exist on this device` });
    }

    const entity = device.entities[eId];

    // Update app version on entity (track latest version seen)
    if (appVersion) {
        entity.appVersion = appVersion;
    }

    res.json({
        deviceId: deviceId,
        entityId: entity.entityId,
        name: entity.name,
        character: entity.character,
        state: entity.state,
        message: entity.message,
        parts: entity.parts,
        lastUpdated: entity.lastUpdated,
        isBound: entity.isBound,
        xp: entity.xp || 0,
        level: entity.level || 1,
        versionInfo: getVersionInfo(appVersion || entity.appVersion)
    });
});

// ============================================
// BOT BINDING (OpenClaw)
// ============================================

/**
 * POST /api/bind
 * Bot binds to a specific entity using binding code.
 * Body: { code: "123456", name: "optional name (max 20 chars)" }
 *
 * The binding code maps to a specific device + entity combination.
 */
app.post('/api/bind', async (req, res) => {
    const { code, name } = req.body;

    if (!code) {
        return res.status(400).json({ success: false, message: "Binding code required" });
    }

    // Validate name length if provided
    if (name && name.length > 20) {
        return res.status(400).json({ success: false, message: "Name must be 20 characters or less" });
    }

    const binding = pendingBindings[code];
    if (!binding || binding.expires < Date.now()) {
        delete pendingBindings[code];
        return res.status(400).json({
            success: false,
            message: "Invalid or expired binding code"
        });
    }

    const { deviceId, entityId } = binding;
    const device = devices[deviceId];
    if (!device) {
        return res.status(400).json({ success: false, message: "Device not found" });
    }

    const entity = device.entities[entityId];

    // Generate bot secret and public code for this binding
    const botSecret = generateBotSecret();
    const publicCode = generatePublicCode();

    // Mark as bound
    entity.isBound = true;
    entity.botSecret = botSecret;
    entity.publicCode = publicCode;
    publicCodeIndex[publicCode] = { deviceId, entityId };
    entity.name = name || null; // Set name if provided
    entity.state = "IDLE";
    entity.message = "Connected!";
    entity.lastUpdated = Date.now();

    // Get app version from pending binding (stored when device registered)
    const deviceAppVersion = binding.appVersion || entity.appVersion;

    // Reset bot-to-bot counters for this entity (fresh bot gets a clean slate)
    const counterKey = `${deviceId}:${entityId}`;
    delete botToBotCounter[counterKey];
    delete crossSpeakCounter[counterKey];

    // Clear used binding code
    delete pendingBindings[code];

    console.log(`[Bind] Device ${deviceId} Entity ${entityId} bound with botSecret${name ? ` (name: ${name})` : ''} (app v${deviceAppVersion || 'unknown'})`);
    serverLog('info', 'bind', `Entity ${entityId} bound${name ? ` (name: ${name})` : ''}`, { deviceId, entityId });

    // Dynamic entity auto-expand: ensure at least one empty slot after bind
    const newSlotId = ensureOneEmptySlot(device);
    if (newSlotId !== null) {
        console.log(`[DynamicEntity] Auto-expand after bind: deviceId=${deviceId}, newSlotId=${newSlotId}, totalSlots=${entityCount(device)}`);
    }

    // Save data immediately after binding (critical operation)
    // Await single-device save to ensure state is persisted before responding
    if (usePostgreSQL) {
        await db.saveDeviceData(deviceId, device);
    } else {
        saveData();
    }

    // Notify clients of new slot (if auto-expanded)
    if (newSlotId !== null) {
        io.to(deviceId).emit('entityAdded', { entityId: newSlotId, totalSlots: entityCount(device) });
    }

    res.json({
        success: true,
        message: `Device ${deviceId} Entity ${entityId} bound successfully`,
        deviceId: deviceId,
        entityId: entityId,
        botSecret: botSecret, // Bot must save this!
        publicCode: publicCode, // For cross-device messaging
        name: entity.name,
        newSlotCreated: newSlotId, // New empty slot auto-created (dynamic entity system)
        deviceInfo: {
            deviceId: deviceId,
            entityId: entityId,
            status: "ONLINE"
        },
        versionInfo: getVersionInfo(deviceAppVersion),
        skills_documentation_url: "https://eclawbot.com/api/skill-doc?format=text",
        skills_documentation: "Fetch the skills_documentation_url above to read the full EClaw A2A Toolkit API guide.",
        identitySetupRequired: !entity.identity,
        availableResources: {
            soulTemplates: 'GET /api/soul-templates',
            ruleTemplates: 'GET /api/rule-templates',
            schedules: 'GET /api/schedules',
            missionDashboard: 'GET /api/mission/dashboard',
            setIdentity: 'PUT /api/entity/identity'
        }
    });
});

// ============================================
// ENTITY STATUS & CONTROL
// ============================================

/**
 * GET /api/entities
 * Get bound entities for a specific device.
 * Auth: deviceId+deviceSecret OR JWT cookie (web portal)
 */
app.get('/api/entities', (req, res) => {
    const filterDeviceId = req.query.deviceId;
    const deviceSecret = req.query.deviceSecret;

    // Auth: deviceId+deviceSecret OR JWT cookie
    const jwtDeviceId = req.user && req.user.deviceId;
    const authedDeviceId = (filterDeviceId && deviceSecret && devices[filterDeviceId] && safeEqual(devices[filterDeviceId].deviceSecret, deviceSecret))
        ? filterDeviceId
        : (jwtDeviceId && (!filterDeviceId || filterDeviceId === jwtDeviceId)) ? jwtDeviceId : null;

    if (!filterDeviceId && !jwtDeviceId) {
        return res.status(400).json({ success: false, message: 'deviceId required' });
    }
    const effectiveDeviceId = filterDeviceId || jwtDeviceId;
    if (!devices[effectiveDeviceId]) {
        return res.status(404).json({ success: false, message: 'Device not found' });
    }
    if (!authedDeviceId) {
        return res.status(403).json({ success: false, message: 'Invalid credentials' });
    }

    const entities = [];

    for (const deviceId in devices) {
        if (deviceId !== authedDeviceId) continue;

        const device = devices[deviceId];
        for (const i of Object.keys(device.entities).map(Number)) {
            const entity = device.entities[i];
            if (!entity) continue;
            if (entity.isBound) {
                entities.push({
                    deviceId: deviceId,
                    entityId: entity.entityId,
                    name: entity.name,
                    character: entity.character,
                    state: entity.state,
                    message: entity.message,
                    parts: entity.parts,
                    lastUpdated: entity.lastUpdated,
                    isBound: true,  // Always true since we only return bound entities
                    avatar: entity.avatar || null,
                    xp: entity.xp || 0,
                    level: entity.level || 1,
                    publicCode: entity.publicCode || null,
                    bindingType: entity.bindingType || null,
                    encryptionStatus: entity.encryptionStatus || null,
                    messageQueue: (entity.messageQueue || []).map(m => ({
                        text: m.text,
                        from: m.from,
                        fromEntityId: m.fromEntityId,
                        fromCharacter: m.fromCharacter,
                        timestamp: m.timestamp,
                        read: m.read || false,
                        delivered: m.delivered || false
                    }))
                });
            }
        }
    }

    // Log entity count changes for device-filtered requests (#48 diagnosis)
    {
        const device = devices[authedDeviceId];
        const allSlotStates = [];
        for (const i of Object.keys(device.entities).map(Number)) {
            const e = device.entities[i];
            if (!e) { allSlotStates.push(`${i}:empty`); continue; }
            allSlotStates.push(`${i}:${e.isBound ? 'bound' : 'unbound'}`);
        }

        if (entities.length === 0) {
            serverLog('warn', 'entity_poll', `Device ${authedDeviceId} returned 0 bound entities (device exists, slots: ${allSlotStates.join(',')})`, {
                deviceId: authedDeviceId,
                metadata: { totalDeviceSlots: Object.keys(device.entities).length, persistenceReady, slots: allSlotStates }
            });
        } else if (entities.length < Object.keys(device.entities).length) {
            serverLog('info', 'entity_poll', `Device ${authedDeviceId} returned ${entities.length}/${Object.keys(device.entities).length} bound entities (slots: ${allSlotStates.join(',')})`, {
                deviceId: authedDeviceId,
                metadata: { boundCount: entities.length, slots: allSlotStates }
            });
        }
    }

    // Warn clients if persistence hasn't loaded yet (entities may appear empty transiently)
    if (!persistenceReady && entities.length === 0) {
        serverLog('warn', 'entity_poll', `Serving empty entities for ${authedDeviceId} while persistence is still loading`, {
            deviceId: authedDeviceId
        });
    }

    res.json({
        entities: entities,
        activeCount: entities.length,
        deviceCount: Object.keys(devices).length,
        totalSlots: entityCount(devices[authedDeviceId]),
        entityIds: Object.keys(devices[authedDeviceId].entities).map(Number),
        serverReady: persistenceReady
    });
});

/**
 * GET /api/status
 * Get status for specific device + entity.
 * Auth: deviceId+deviceSecret OR JWT cookie
 */
app.get('/api/status', (req, res) => {
    const deviceId = req.query.deviceId;
    const deviceSecret = req.query.deviceSecret;
    const eId = parseInt(req.query.entityId) || 0;
    const appVersion = req.query.appVersion;

    // Auth: deviceId+deviceSecret OR JWT cookie
    const jwtDeviceId = req.user && req.user.deviceId;
    const authedDeviceId = (deviceId && deviceSecret && devices[deviceId] && safeEqual(devices[deviceId].deviceSecret, deviceSecret))
        ? deviceId
        : (jwtDeviceId && (!deviceId || deviceId === jwtDeviceId)) ? jwtDeviceId : null;

    if (!deviceId && !jwtDeviceId) {
        return res.status(400).json({ success: false, message: "deviceId required" });
    }

    if (eId < 0) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const effectiveDeviceId = deviceId || jwtDeviceId;
    const device = devices[effectiveDeviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    if (!authedDeviceId) {
        return res.status(403).json({ success: false, message: "Invalid credentials" });
    }

    if (!isValidEntityId(device, eId)) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const entity = device.entities[eId];

    // Update app version on entity (track latest version seen from this device)
    if (appVersion) {
        entity.appVersion = appVersion;
    }

    res.json({
        deviceId: deviceId,
        entityId: entity.entityId,
        name: entity.name,
        character: entity.character,
        state: entity.state,
        message: entity.message,
        parts: entity.parts,
        lastUpdated: entity.lastUpdated,
        isBound: entity.isBound,
        versionInfo: getVersionInfo(appVersion || entity.appVersion)
    });
});

/**
 * POST /api/transform
 * Update entity status (Bot uses this).
 * Body: { deviceId, entityId: 0-3, botSecret, name, character, state, message, parts }
 * REQUIRES botSecret for authentication!
 */
app.post('/api/transform', (req, res) => {
    const { deviceId, entityId, botSecret, name, character, state, message, parts, targetDeviceId } = req.body;

    if (!deviceId) {
        return res.status(400).json({ success: false, message: "deviceId required" });
    }

    const eId = parseInt(entityId) || 0;
    if (eId < 0) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    const entity = device.entities[eId];

    // Check if entity exists
    if (!entity) {
        console.warn(`[Transform] Device ${deviceId} Entity ${eId} not found (possible malformed request)`);
        return res.status(404).json({ success: false, message: `Entity ${eId} not found` });
    }

    if (!entity.isBound) {
        return res.status(400).json({
            success: false,
            message: `Device ${deviceId} Entity ${eId} is not bound yet`
        });
    }

    // Verify botSecret
    if (!botSecret || !safeEqual(botSecret, entity.botSecret)) {
        return res.status(403).json({
            success: false,
            message: "Invalid or missing botSecret"
        });
    }

    // Validate and update name if provided
    if (name !== undefined) {
        if (name && name.length > 20) {
            return res.status(400).json({ success: false, message: "Name must be 20 characters or less" });
        }
        entity.name = name || null;
    }

    if (character) entity.character = character;
    if (state) entity.state = state;

    // Gatekeeper Second Lock: detect and mask token/info leaks in bot responses (free bots only)
    let finalMessage = message;
    if (message !== undefined && message) {
        const binding = officialBindingsCache[getBindingCacheKey(deviceId, eId)];
        const isFreeBotTransform = binding && officialBots[binding.bot_id] && officialBots[binding.bot_id].bot_type === 'free';

        if (isFreeBotTransform) {
            const leakCheck = gatekeeper.detectAndMaskLeaks(message, deviceId, entity.botSecret);
            if (leakCheck.leaked) {
                finalMessage = leakCheck.maskedText;
                console.warn(`[Gatekeeper] Second lock: masked ${leakCheck.leakTypes.join(', ')} in transform from device ${deviceId} entity ${eId}`);
                serverLog('warn', 'gatekeeper', `Second lock: ${leakCheck.leakTypes.join(', ')}`, { deviceId, entityId: eId, metadata: { leakTypes: leakCheck.leakTypes } });
            }
        }
    }
    if (finalMessage !== undefined) entity.message = finalMessage;
    if (parts) {
        // Only store numeric values — reject URLs/strings that would crash Android Gson deserialization
        const sanitizedParts = {};
        for (const [key, value] of Object.entries(parts)) {
            const num = Number(value);
            if (!isNaN(num)) sanitizedParts[key] = num;
        }
        entity.parts = { ...entity.parts, ...sanitizedParts };
    }

    entity.lastUpdated = Date.now();

    // Save bot message to chat history so it appears in Chat page
    // Skip silent tokens — these are internal signals that should not appear in chat
    const isSilentMessage = finalMessage && /^\[SILENT\]$/i.test(finalMessage.trim());
    if (finalMessage && !isSilentMessage) {
        saveChatMessage(deviceId, eId, finalMessage, entity.name || `Entity ${eId}`, false, true);
        markMessagesAsRead(deviceId, eId);

        // [A2A_BOT_REPLY] — detect if this transform is in response to an A2A speak-to
        const pendingA2A = entity.messageQueue && entity.messageQueue.find(m => m.from && m.from.startsWith('entity:'));
        if (pendingA2A) {
            serverLog('info', 'speakto_push', `[A2A_BOT_REPLY] Entity ${eId} responded via transform after A2A from ${pendingA2A.from}: "${(finalMessage || '').slice(0, 60)}" | mqLen=${entity.messageQueue.length}`, {
                deviceId, entityId: eId,
                metadata: { tag: 'A2A_BOT_REPLY', fromEntity: pendingA2A.fromEntityId, mqLen: entity.messageQueue.length }
            });
        }

        // [CROSS-DEVICE ROUTING] — explicit targetDeviceId OR auto-route from pending cross-device message
        // Skip cross-device routing when targetDeviceId === deviceId (same-device reply)
        if (targetDeviceId && targetDeviceId !== deviceId) {
            // Explicit routing — bot specifies which device to route reply to
            const targetDev = devices[targetDeviceId];
            if (targetDev) {
                const replySource = `xdevice:${entity.publicCode}:${entity.character}->${targetDeviceId}`;
                saveChatMessage(targetDeviceId, 0, finalMessage, replySource, false, true);
                serverLog('info', 'cross_speak_push', `[EXPLICIT_ROUTE] Transform routed reply to ${targetDeviceId}`, {
                    deviceId, entityId: eId,
                    metadata: { targetDeviceId, fromPublicCode: entity.publicCode }
                });
                notifyDevice(targetDeviceId, {
                    type: 'chat', category: 'cross_speak',
                    title: `${entity.name || entity.publicCode || `Entity ${eId}`} replied`,
                    body: (finalMessage || '').slice(0, 100),
                    link: 'chat.html',
                    metadata: { fromPublicCode: entity.publicCode, entityId: 0 }
                }).catch(() => {});
            } else {
                serverLog('warn', 'cross_speak_push', `[EXPLICIT_ROUTE] targetDeviceId ${targetDeviceId} not found`, { deviceId, entityId: eId });
            }
        } else {
            // Auto-route — find pending cross-device message and consume it
            const pendingCross = entity.messageQueue && entity.messageQueue.findLast(m => m.crossDevice);
            if (pendingCross && pendingCross.fromDeviceId) {
                const replySource = `xdevice:${entity.publicCode}:${entity.character}->${pendingCross.fromPublicCode || pendingCross.fromDeviceId}`;
                const senderEntityId = pendingCross.fromEntityId >= 0 ? pendingCross.fromEntityId : 0;
                saveChatMessage(pendingCross.fromDeviceId, senderEntityId, finalMessage, replySource, false, true);
                serverLog('info', 'cross_speak_push', `[CROSS_ROUTE] Transform auto-routed reply to sender ${pendingCross.fromDeviceId}:${senderEntityId}`, {
                    deviceId, entityId: eId,
                    metadata: { senderDeviceId: pendingCross.fromDeviceId, senderEntityId, fromPublicCode: pendingCross.fromPublicCode }
                });

                // Notify sender device about the reply
                notifyDevice(pendingCross.fromDeviceId, {
                    type: 'chat', category: 'cross_speak',
                    title: `${entity.name || entity.publicCode || `Entity ${eId}`} replied`,
                    body: (finalMessage || '').slice(0, 100),
                    link: 'chat.html',
                    metadata: { fromPublicCode: entity.publicCode, entityId: senderEntityId }
                }).catch(() => {});

                // Consume the cross-device message so it doesn't trigger again
                const crossIdx = entity.messageQueue.findLastIndex(m => m.crossDevice);
                if (crossIdx >= 0) entity.messageQueue.splice(crossIdx, 1);
            }
        }

        // XP: Award +10 for correctly replying to a user message
        const hasPendingUserMsg = entity.messageQueue && entity.messageQueue.some(m => m.from && m.from !== 'system');
        const now = Date.now();
        const replyXpCooldown = 30000; // 30 seconds
        if (hasPendingUserMsg && (!entity._lastReplyXpAt || now - entity._lastReplyXpAt > replyXpCooldown)) {
            entity._lastReplyXpAt = now;
            awardEntityXP(deviceId, eId, XP_AMOUNTS.BOT_REPLY, 'bot_reply');
        }

        // Clear missed-schedule flag if bot responded before deadline
        if (entity._scheduleAwaitingResponse && now < entity._scheduleAwaitingResponse.deadline) {
            console.log(`[XP] Entity ${eId} responded to schedule in time, no penalty`);
            delete entity._scheduleAwaitingResponse;
        }
    }

    console.log(`[Transform] Device ${deviceId} Entity ${eId}: ${state || entity.state} - "${finalMessage || entity.message}"`);
    serverLog('info', 'transform', `${state || entity.state}: ${(finalMessage || entity.message || '').slice(0, 100)}`, { deviceId, entityId: eId, metadata: { state: state || entity.state } });

    // Emit entity:update via Socket.IO for real-time wallpaper/dashboard refresh
    if (io) {
        io.to(`device:${deviceId}`).emit('entity:update', {
            deviceId, entityId: eId,
            name: entity.name, character: entity.character,
            state: entity.state, message: entity.message,
            parts: entity.parts, lastUpdated: entity.lastUpdated,
            xp: entity.xp || 0, level: entity.level || 1
        });
    }

    // Notify device about bot reply (fire-and-forget)
    if (finalMessage) {
        notifyDevice(deviceId, {
            type: 'chat', category: 'bot_reply',
            title: entity.name || `Entity ${eId}`,
            body: (finalMessage || '').slice(0, 100),
            link: 'chat.html',
            metadata: { entityId: eId, character: entity.character }
        }).catch(() => {});

        // Discord followup: if a pending interaction exists for this entity, send the reply
        if (typeof discordModule !== 'undefined' && discordModule.handleTransformFollowup) {
            discordModule.handleTransformFollowup(deviceId, eId, finalMessage, entity.name).catch(() => {});
        }
    }

    // Auto-move child cards to review when bot reports IDLE
    if (state === 'IDLE' && kanbanModule && kanbanModule.autoReviewOnTransform) {
        kanbanModule.autoReviewOnTransform(deviceId, eId).catch(err => {
            console.error(`[Transform] autoReviewOnTransform failed:`, err.message);
        });
    }

    res.json({
        success: true,
        deviceId: deviceId,
        entityId: eId,
        currentState: {
            name: entity.name,
            character: entity.character,
            state: entity.state,
            message: entity.message,
            parts: entity.parts,
            xp: entity.xp || 0,
            level: entity.level || 1,
            publicCode: entity.publicCode || null,
            encryptionStatus: entity.encryptionStatus || null
        },
        versionInfo: getVersionInfo(entity.appVersion),
        push_status: entity.pushStatus || null
    });
});

// POST /api/wakeup - REMOVED (client-side wakeup retained without push)

/**
 * Save bound entity data to trash before unbind/delete (7-day recovery).
 * Only saves if entity is bound (has meaningful data to preserve).
 */
async function saveToEntityTrash(deviceId, entityId, entity) {
    if (!usePostgreSQL || !entity || !entity.isBound) return;
    try {
        await db.saveEntityToTrash(deviceId, entityId, entity);
        console.log(`[Trash] Entity #${entityId} on device ${deviceId} saved to trash`);
    } catch (err) {
        console.error(`[Trash] Failed to save entity #${entityId} to trash:`, err.message);
    }
}

/**
 * DELETE /api/entity
 * Remove/unbind an entity.
 * Body/Query: { deviceId, entityId, botSecret }
 */
app.delete('/api/entity', async (req, res) => {
    const deviceId = req.body.deviceId || req.query.deviceId;
    const entityId = req.body.entityId ?? req.query.entityId;
    const botSecret = req.body.botSecret || req.query.botSecret;

    if (!deviceId) {
        return res.status(400).json({ success: false, message: "deviceId required" });
    }

    const eId = parseInt(entityId);
    if (isNaN(eId) || eId < 0) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    if (!isValidEntityId(device, eId)) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const entity = device.entities[eId];

    if (!entity.isBound) {
        return res.status(400).json({ success: false, message: `Entity ${eId} is not bound` });
    }

    // Verify botSecret
    if (!botSecret || !safeEqual(botSecret, entity.botSecret)) {
        return res.status(403).json({ success: false, message: "Invalid botSecret" });
    }

    // Clean up official bot binding if exists
    const bindCacheKey = getBindingCacheKey(deviceId, eId);
    const officialBinding = officialBindingsCache[bindCacheKey];
    if (officialBinding) {
        const bot = officialBots[officialBinding.bot_id];
        if (bot) {
            if (bot.bot_type === 'personal') {
                bot.status = 'available';
                bot.assigned_device_id = null;
                bot.assigned_entity_id = null;
                bot.assigned_at = null;
                if (usePostgreSQL) await db.saveOfficialBot(bot);
                console.log(`[Remove] Personal bot ${bot.bot_id} released back to pool`);
            } else if (bot.bot_type === 'free') {
                delete officialBindingsCache[bindCacheKey];
                const remainingBindings = Object.values(officialBindingsCache).filter(b => b.bot_id === bot.bot_id);
                if (remainingBindings.length === 0) {
                    bot.status = 'available';
                    bot.assigned_device_id = null;
                    bot.assigned_entity_id = null;
                    bot.assigned_at = null;
                    if (usePostgreSQL) await db.saveOfficialBot(bot);
                    console.log(`[Remove] Free bot ${bot.bot_id} released (no remaining bindings)`);
                }
                if (usePostgreSQL) await db.removeOfficialBinding(deviceId, eId);
                console.log(`[Remove] Official binding cleaned up for device ${deviceId} entity ${eId}`);
            }
        }
        if (!bot || bot.bot_type !== 'free') {
            delete officialBindingsCache[bindCacheKey];
            if (usePostgreSQL) await db.removeOfficialBinding(deviceId, eId);
            console.log(`[Remove] Official binding cleaned up for device ${deviceId} entity ${eId}`);
        }
    }

    // Save entity data to trash before unbinding
    await saveToEntityTrash(deviceId, eId, entity);

    // Clean up public code index
    if (entity.publicCode) delete publicCodeIndex[entity.publicCode];

    // Reset entity to unbound state (preserve user-set name, xp, level)
    const removedEntity = device.entities[eId];
    device.entities[eId] = createDefaultEntity(eId);
    device.entities[eId].name = removedEntity?.name || null;
    device.entities[eId].xp = removedEntity?.xp || 0;
    device.entities[eId].level = removedEntity?.level || 1;

    console.log(`[Remove] Device ${deviceId} Entity ${eId} unbound`);
    serverLog('info', 'unbind', `Entity ${eId} unbound`, { deviceId, entityId: eId });

    // Save data immediately after unbinding (critical operation)
    await saveData();

    res.json({ success: true, message: `Entity ${eId} removed` });
});

/**
 * DELETE /api/device/entity
 * Device-side entity removal (uses deviceSecret instead of botSecret).
 * Body: { deviceId, deviceSecret, entityId }
 *
 * This allows the device owner to remove entities without needing bot credentials.
 */
app.delete('/api/device/entity', async (req, res) => {
    let { deviceId, deviceSecret, entityId } = req.body || {};

    // Fallback: use cookie-based auth (web portal)
    if ((!deviceId || !deviceSecret) && req.user) {
        deviceId = req.user.deviceId;
        deviceSecret = req.user.deviceSecret;
        if (!entityId && req.body) entityId = req.body.entityId;
    }
    // Also try parsing cookie if req.user not set (no auth middleware on this route)
    if ((!deviceId || !deviceSecret) && req.cookies && req.cookies.eclaw_session) {
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.verify(req.cookies.eclaw_session, JWT_SECRET_FALLBACK);
            if (decoded && decoded.deviceId) {
                deviceId = decoded.deviceId;
                const dev = devices[decoded.deviceId];
                if (dev) deviceSecret = dev.deviceSecret;
                if (!entityId && req.body) entityId = req.body.entityId;
            }
        } catch (e) { /* invalid token, fall through */ }
    }

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, message: "deviceId and deviceSecret required" });
    }

    const eId = parseInt(entityId);
    if (isNaN(eId) || eId < 0) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    // Verify deviceSecret
    if (!safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, message: "Invalid deviceSecret" });
    }

    if (!isValidEntityId(device, eId)) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const entity = device.entities[eId];

    if (!entity.isBound) {
        return res.status(400).json({ success: false, message: `Entity ${eId} is not bound` });
    }

    // Check and clean up official bot binding if exists
    const bindCacheKey = getBindingCacheKey(deviceId, eId);
    const officialBinding = officialBindingsCache[bindCacheKey];
    if (officialBinding) {
        const bot = officialBots[officialBinding.bot_id];
        if (bot) {
            if (bot.bot_type === 'personal') {
                bot.status = 'available';
                bot.assigned_device_id = null;
                bot.assigned_entity_id = null;
                bot.assigned_at = null;
                if (usePostgreSQL) await db.saveOfficialBot(bot);
                console.log(`[Device Remove] Personal bot ${bot.bot_id} released back to pool`);
            } else if (bot.bot_type === 'free') {
                // Check if any other bindings still use this free bot
                delete officialBindingsCache[bindCacheKey]; // remove first before counting
                const remainingBindings = Object.values(officialBindingsCache).filter(b => b.bot_id === bot.bot_id);
                if (remainingBindings.length === 0) {
                    bot.status = 'available';
                    bot.assigned_device_id = null;
                    bot.assigned_entity_id = null;
                    bot.assigned_at = null;
                    if (usePostgreSQL) await db.saveOfficialBot(bot);
                    console.log(`[Device Remove] Free bot ${bot.bot_id} released (no remaining bindings)`);
                }
                if (usePostgreSQL) await db.removeOfficialBinding(deviceId, eId);
                console.log(`[Device Remove] Official binding cleaned up for device ${deviceId} entity ${eId}`);
            }
        }
        // For non-free bots, delete cache was already handled above for free; do it here for personal
        if (!bot || bot.bot_type !== 'free') {
            delete officialBindingsCache[bindCacheKey];
            if (usePostgreSQL) await db.removeOfficialBinding(deviceId, eId);
            console.log(`[Device Remove] Official binding cleaned up for device ${deviceId} entity ${eId}`);
        }
    }

    // Save entity data to trash before unbinding
    await saveToEntityTrash(deviceId, eId, entity);

    // Clean up public code index
    if (entity.publicCode) delete publicCodeIndex[entity.publicCode];

    // Reset entity to unbound state (preserve user-set name, xp, level)
    const removedEntity2 = device.entities[eId];
    device.entities[eId] = createDefaultEntity(eId);
    device.entities[eId].name = removedEntity2?.name || null;
    device.entities[eId].xp = removedEntity2?.xp || 0;
    device.entities[eId].level = removedEntity2?.level || 1;

    console.log(`[Device Remove] Device ${deviceId} Entity ${eId} unbound by device owner`);

    // Save data immediately after unbinding (critical operation)
    await saveData();

    res.json({ success: true, message: `Entity ${eId} removed by device` });
});

/**
 * POST /api/device/add-entity
 * Dynamically add a new entity slot to a device. Entity ID is auto-assigned (monotonically increasing).
 * Body: { deviceId, deviceSecret }
 */
app.post('/api/device/add-entity', async (req, res) => {
    const { deviceId, deviceSecret } = req.body;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }

    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid device credentials' });
    }

    // Assign next entity ID
    if (!device.nextEntityId) {
        device.nextEntityId = Math.max(-1, ...Object.keys(device.entities).map(Number)) + 1;
    }
    const newEntityId = device.nextEntityId++;
    device.entities[newEntityId] = createDefaultEntity(newEntityId);

    console.log(`[DynamicEntity] Manual add-entity: deviceId=${deviceId}, newEntityId=${newEntityId}, totalSlots=${entityCount(device)}, nextEntityId=${device.nextEntityId}`);
    serverLog('info', 'entity_add', `Entity #${newEntityId} added manually`, { deviceId, entityId: newEntityId });

    // Persist
    await saveData();

    // Notify clients
    io.to(deviceId).emit('entityAdded', { entityId: newEntityId, totalSlots: entityCount(device) });

    res.json({
        success: true,
        entityId: newEntityId,
        entity: {
            entityId: newEntityId,
            isBound: false,
            character: device.entities[newEntityId].character,
            state: device.entities[newEntityId].state,
            message: device.entities[newEntityId].message
        },
        totalEntities: entityCount(device),
        entityIds: Object.keys(device.entities).map(Number)
    });
});

/**
 * compactEntitySlots — Renumber all entity slots to sequential IDs starting from 0.
 * Handles: in-memory entities, publicCodeIndex, officialBindingsCache,
 *          DB (entities, official_bot_bindings, chat_messages, scheduled_messages, official_bots),
 *          and bot notifications (fire-and-forget).
 * Returns: { compacted: true, mapping: [{from, to}] } or { compacted: false } if already compact.
 */
async function compactEntitySlots(device, deviceId) {
    const existingIds = Object.keys(device.entities).map(Number).sort((a, b) => a - b);
    const totalEntities = existingIds.length;

    // Build mapping: existingIds[i] → i
    const mapping = []; // { from: oldId, to: newId }
    const movedSlots = []; // only slots that actually changed
    for (let i = 0; i < totalEntities; i++) {
        mapping.push({ from: existingIds[i], to: i });
        if (existingIds[i] !== i) {
            movedSlots.push({ oldSlot: existingIds[i], newSlot: i });
        }
    }

    // Nothing to compact
    if (movedSlots.length === 0) {
        return { compacted: false };
    }

    console.log(`[Compact] Starting compaction for device ${deviceId}: ${movedSlots.map(s => `#${s.oldSlot}→#${s.newSlot}`).join(', ')}`);

    // Step 1: Snapshot current entities and bindings
    const oldEntities = {};
    const oldBindings = {};
    for (const eid of existingIds) {
        oldEntities[eid] = device.entities[eid] ? { ...device.entities[eid] } : createDefaultEntity(eid);
        const cacheKey = getBindingCacheKey(deviceId, eid);
        if (officialBindingsCache[cacheKey]) {
            oldBindings[eid] = { ...officialBindingsCache[cacheKey] };
        }
    }

    // Step 2: Build new entity map and update in-memory references
    const botsToNotify = [];
    const newEntities = {};

    for (let i = 0; i < totalEntities; i++) {
        const sourceId = existingIds[i];
        const targetId = i;
        const entity = { ...oldEntities[sourceId] };
        entity.entityId = targetId;
        newEntities[targetId] = entity;

        // Update official binding cache
        const newCacheKey = getBindingCacheKey(deviceId, targetId);
        const oldBinding = oldBindings[sourceId];
        if (oldBinding) {
            officialBindingsCache[newCacheKey] = { ...oldBinding, entity_id: targetId };
        } else if (sourceId !== targetId) {
            delete officialBindingsCache[newCacheKey];
        }

        // Clean up old binding cache entry if ID changed
        if (sourceId !== targetId) {
            const oldCacheKey = getBindingCacheKey(deviceId, sourceId);
            delete officialBindingsCache[oldCacheKey];
        }

        // Track bots that need notification
        if (sourceId !== targetId && entity.isBound && (entity.webhook || entity.bindingType === 'channel')) {
            botsToNotify.push({
                entity,
                oldSlot: sourceId,
                newSlot: targetId,
                binding: oldBinding
            });
        }
    }

    // Apply new entities to device
    device.entities = newEntities;
    device.nextEntityId = totalEntities;

    // Rebuild publicCodeIndex for this device
    for (const eid of Object.keys(device.entities).map(Number)) {
        const entity = device.entities[eid];
        if (entity && entity.isBound && entity.publicCode) {
            publicCodeIndex[entity.publicCode] = { deviceId, entityId: eid };
        }
    }

    // Step 3: Persist to DB
    if (usePostgreSQL && movedSlots.length > 0) {
        try {
            const client = await chatPool.connect();
            try {
                await client.query('BEGIN');

                // 3a: Delete old entity rows that moved, then saveData will re-insert at new IDs
                for (const s of movedSlots) {
                    await client.query('DELETE FROM entities WHERE device_id = $1 AND entity_id = $2', [deviceId, s.oldSlot]);
                }

                // 3b: Remove old bindings and re-insert with new entity IDs
                for (const eid of existingIds) {
                    await client.query('DELETE FROM official_bot_bindings WHERE device_id = $1 AND entity_id = $2', [deviceId, eid]);
                }
                for (const newEid of Object.keys(newEntities).map(Number)) {
                    const cacheKey = getBindingCacheKey(deviceId, newEid);
                    const binding = officialBindingsCache[cacheKey];
                    if (binding) {
                        await client.query(
                            `INSERT INTO official_bot_bindings (bot_id, device_id, entity_id, session_key, bound_at, subscription_verified_at)
                             VALUES ($1, $2, $3, $4, $5, $6)
                             ON CONFLICT (device_id, entity_id)
                             DO UPDATE SET bot_id = $1, session_key = $4, bound_at = $5, subscription_verified_at = $6`,
                            [binding.bot_id, binding.device_id, binding.entity_id,
                             binding.session_key, binding.bound_at || Date.now(), binding.subscription_verified_at || Date.now()]
                        );
                    }
                }

                // 3c: Migrate chat_messages entity_id
                const caseClauses = movedSlots.map(s => `WHEN ${s.oldSlot} THEN ${s.newSlot}`).join(' ');
                const affectedOldSlots = movedSlots.map(s => s.oldSlot);
                await client.query(
                    `UPDATE chat_messages
                     SET entity_id = CASE entity_id ${caseClauses} ELSE entity_id END
                     WHERE device_id = $1 AND entity_id = ANY($2)`,
                    [deviceId, affectedOldSlots]
                );

                // 3d: Migrate scheduled_messages entity_id
                await client.query(
                    `UPDATE scheduled_messages
                     SET entity_id = CASE entity_id ${caseClauses} ELSE entity_id END
                     WHERE device_id = $1 AND entity_id = ANY($2) AND status IN ('pending', 'active')`,
                    [deviceId, affectedOldSlots]
                );

                // 3e: Update personal bot assignments
                for (const info of botsToNotify) {
                    if (info.binding) {
                        const bot = officialBots[info.binding.bot_id];
                        if (bot && bot.bot_type === 'personal' && bot.assigned_device_id === deviceId) {
                            bot.assigned_entity_id = info.newSlot;
                            await client.query(
                                'UPDATE official_bots SET assigned_entity_id = $1 WHERE bot_id = $2',
                                [info.newSlot, bot.bot_id]
                            );
                        }
                    }
                }

                await client.query('COMMIT');
                console.log(`[Compact] DB transaction committed (${movedSlots.length} slots moved)`);
            } catch (dbErr) {
                await client.query('ROLLBACK').catch(() => {});
                console.error(`[Compact] DB transaction failed, rolled back:`, dbErr.message);
            } finally {
                client.release();
            }
        } catch (poolErr) {
            console.error(`[Compact] Failed to get DB connection:`, poolErr.message);
        }
    }

    await saveData();

    // Step 4: Notify bots of their new entity IDs (fire-and-forget)
    for (const info of botsToNotify) {
        const { entity, oldSlot, newSlot } = info;
        const apiBase = 'https://eclawbot.com';
        const notifyMsg = `[SYSTEM:ENTITY_MOVED] Your entity slot has been compacted from #${oldSlot} to #${newSlot}.

UPDATED CREDENTIALS:
- entityId: ${newSlot} (was ${oldSlot})
- deviceId: ${deviceId}
- botSecret: ${entity.botSecret}

⚠️ IMPORTANT: Update your entityId in ALL future API calls:
exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${newSlot},"botSecret":"${entity.botSecret}","targetDeviceId":"${deviceId}","state":"IDLE","message":"YOUR_REPLY_HERE"}'`;

        if (entity.bindingType === 'channel') {
            channelModule.pushToChannelCallback(deviceId, newSlot, {
                event: 'message',
                from: 'system',
                text: notifyMsg,
                eclaw_context: { expectsReply: false, silentToken: '[SILENT]', missionHints: '' }
            }, entity.channelAccountId)
                .then(r => {
                    if (r.pushed) console.log(`[Compact] ✓ Notified channel bot at entity ${newSlot} (was ${oldSlot})`);
                    else console.warn(`[Compact] ✗ Failed to notify channel bot: ${r.reason}`);
                })
                .catch(e => console.warn(`[Compact] ✗ Error notifying channel bot: ${e.message}`));
        } else if (entity.webhook) {
            sendToSession(entity.webhook.url, entity.webhook.token, entity.webhook.sessionKey, notifyMsg)
                .then(r => {
                    if (r.success) console.log(`[Compact] ✓ Notified bot at entity ${newSlot} (was ${oldSlot})`);
                    else console.warn(`[Compact] ✗ Failed to notify bot: ${r.error}`);
                })
                .catch(e => console.warn(`[Compact] ✗ Error notifying bot: ${e.message}`));
        }
    }

    // Notify connected clients
    io.to(deviceId).emit('entitiesCompacted', {
        mapping: movedSlots.map(s => ({ from: s.oldSlot, to: s.newSlot })),
        entityIds: Object.keys(device.entities).map(Number),
        totalSlots: entityCount(device)
    });

    console.log(`[Compact] ✓ Device ${deviceId} compaction complete: ${movedSlots.length} slots moved, nextEntityId=${device.nextEntityId}`);
    serverLog('info', 'entity_compact', `Compacted ${movedSlots.length} slots`, {
        deviceId,
        metadata: { mapping: movedSlots.map(s => `${s.oldSlot}→${s.newSlot}`) }
    });

    return { compacted: true, mapping: movedSlots.map(s => ({ from: s.oldSlot, to: s.newSlot })) };
}

/**
 * DELETE /api/device/entity/:entityId/permanent
 * Permanently delete an entity slot from a device (not just unbind — removes the slot entirely).
 * Body: { deviceId, deviceSecret }
 */
app.delete('/api/device/entity/:entityId/permanent', async (req, res) => {
    const { deviceId, deviceSecret } = req.body;
    const eId = parseInt(req.params.entityId);

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }

    if (isNaN(eId) || eId < 0) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }

    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid device credentials' });
    }

    if (!isValidEntityId(device, eId)) {
        return res.status(404).json({ success: false, error: `Entity #${eId} does not exist on this device` });
    }

    // Protect: at least 1 entity must remain
    if (entityCount(device) <= 1) {
        return res.status(400).json({ success: false, error: 'Cannot delete the last entity. At least one entity must remain.' });
    }

    const entity = device.entities[eId];
    console.log(`[DynamicEntity] Permanent delete: deviceId=${deviceId}, entityId=${eId}, isBound=${entity.isBound}, totalSlotsBefore=${entityCount(device)}`);

    // Save entity data to trash before permanent deletion
    await saveToEntityTrash(deviceId, eId, entity);

    // If bound, perform full unbind cleanup
    if (entity.isBound) {
        // Clean up public code index
        if (entity.publicCode) delete publicCodeIndex[entity.publicCode];

        // Clean up official bot binding
        const bindCacheKey = getBindingCacheKey(deviceId, eId);
        const officialBinding = officialBindingsCache[bindCacheKey];
        if (officialBinding) {
            const bot = officialBots[officialBinding.bot_id];
            if (bot) {
                if (bot.bot_type === 'free') {
                    // Release free bot back to available
                    bot.status = 'available';
                    bot.assigned_device_id = null;
                    bot.assigned_entity_id = null;
                } else if (bot.bot_type === 'personal' && bot.assigned_device_id === deviceId) {
                    bot.assigned_entity_id = null;
                    bot.assigned_device_id = null;
                    bot.status = 'available';
                }
                if (usePostgreSQL) await db.saveOfficialBot(bot);
            }
            delete officialBindingsCache[bindCacheKey];
            if (usePostgreSQL) await db.removeOfficialBinding(deviceId, eId);
        }

        // Clean up channel binding if any
        if (entity.channelAccountId) {
            entity.channelAccountId = null;
        }

        // Reset bot-to-bot counters
        const counterKey = `${deviceId}:${eId}`;
        delete botToBotCounter[counterKey];
        delete crossSpeakCounter[counterKey];

        serverLog('info', 'unbind', `Entity ${eId} unbound (permanent delete)`, { deviceId, entityId: eId });
    }

    // Permanently delete the entity slot
    delete device.entities[eId];

    // Delete from DB
    if (usePostgreSQL) {
        await db.deleteEntity(deviceId, eId);
    }

    console.log(`[DynamicEntity] Permanent delete complete: deviceId=${deviceId}, entityId=${eId}, totalSlotsAfter=${entityCount(device)}`);
    serverLog('info', 'entity_delete', `Entity #${eId} permanently deleted`, { deviceId, entityId: eId });

    // Notify clients
    io.to(deviceId).emit('entityDeleted', { entityId: eId, totalSlots: entityCount(device) });

    // Auto-compact: renumber remaining entities to sequential 0, 1, 2, ...
    const compactResult = await compactEntitySlots(device, deviceId);

    res.json({
        success: true,
        deletedEntityId: eId,
        remainingEntities: entityCount(device),
        entityIds: Object.keys(device.entities).map(Number),
        compacted: compactResult.compacted ? compactResult.mapping : undefined
    });
});

/**
 * POST /api/device/compact-entities
 * Renumber all entity slots to sequential IDs starting from 0.
 * Use when entity IDs have become sparse (e.g., after many deletes).
 * Body: { deviceId, deviceSecret }
 */
app.post('/api/device/compact-entities', async (req, res) => {
    const { deviceId, deviceSecret } = req.body;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }

    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid device credentials' });
    }

    const result = await compactEntitySlots(device, deviceId);

    if (!result.compacted) {
        return res.json({ success: true, message: 'Already compact', entityIds: Object.keys(device.entities).map(Number) });
    }

    res.json({
        success: true,
        message: `Compacted ${result.mapping.length} slots`,
        mapping: result.mapping,
        entityIds: Object.keys(device.entities).map(Number),
        nextEntityId: device.nextEntityId
    });
});

/**
 * GET /api/device/entity-trash
 * List trashed (soft-deleted) entities for a device. Items expire after 7 days.
 * Query: { deviceId, deviceSecret }
 */
app.get('/api/device/entity-trash', async (req, res) => {
    const { deviceId, deviceSecret } = req.query;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid device credentials' });
    }
    if (!usePostgreSQL) {
        return res.json({ success: true, items: [] });
    }
    try {
        const items = await db.getEntityTrash(deviceId);
        res.json({
            success: true,
            items: items.map(row => ({
                id: row.id,
                entityId: row.entity_id,
                character: row.character,
                name: row.name,
                state: row.state,
                webhook: row.webhook,
                publicCode: row.public_code,
                xp: row.xp,
                avatar: row.avatar,
                agentCard: row.agent_card,
                encryptionStatus: row.encryption_status,
                deletedAt: row.deleted_at,
                expiresAt: row.expires_at
            }))
        });
    } catch (err) {
        console.error('[Trash] Error listing trash:', err.message);
        res.status(500).json({ success: false, error: 'Failed to list trash' });
    }
});

/**
 * POST /api/device/entity-trash/:trashId/restore
 * Restore a trashed entity to an available slot on the device.
 * Body: { deviceId, deviceSecret, entityId? (optional, auto-selects unbound slot) }
 */
app.post('/api/device/entity-trash/:trashId/restore', async (req, res) => {
    const trashId = parseInt(req.params.trashId);
    const { deviceId, deviceSecret, entityId: targetEntityId } = req.body;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    if (isNaN(trashId)) {
        return res.status(400).json({ success: false, error: 'Invalid trashId' });
    }

    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid device credentials' });
    }

    if (!usePostgreSQL) {
        return res.status(400).json({ success: false, error: 'PostgreSQL required for trash recovery' });
    }

    try {
        const trashItem = await db.getEntityTrashItem(trashId);
        if (!trashItem || trashItem.device_id !== deviceId) {
            return res.status(404).json({ success: false, error: 'Trash item not found or expired' });
        }

        // Find target entity slot: explicit entityId, or first unbound slot, or create new
        let slotId;
        if (targetEntityId !== undefined) {
            slotId = parseInt(targetEntityId);
            if (!isValidEntityId(device, slotId)) {
                return res.status(400).json({ success: false, error: `Entity slot #${slotId} does not exist` });
            }
            if (device.entities[slotId].isBound) {
                return res.status(400).json({ success: false, error: `Entity slot #${slotId} is already bound` });
            }
        } else {
            // Find first unbound slot
            const allIds = Object.keys(device.entities).map(Number);
            slotId = allIds.find(id => !device.entities[id].isBound);
            if (slotId === undefined) {
                // Create a new slot
                const nextId = device.nextEntityId || (Math.max(...allIds) + 1);
                device.entities[nextId] = createDefaultEntity(nextId);
                device.nextEntityId = nextId + 1;
                slotId = nextId;
                console.log(`[Trash] Auto-created new slot #${slotId} for restore`);
            }
        }

        // Restore entity data to the target slot
        const entity = device.entities[slotId];
        entity.isBound = true;
        entity.character = trashItem.character || 'restored-bot';
        entity.name = trashItem.name || null;
        entity.state = trashItem.state || 'IDLE';
        entity.message = trashItem.message || '';
        entity.webhook = trashItem.webhook || null;
        entity.botSecret = trashItem.bot_secret || `restored-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        entity.publicCode = trashItem.public_code || null;
        entity.xp = trashItem.xp || 0;
        entity.avatar = trashItem.avatar || null;
        entity.agentCard = trashItem.agent_card || null;
        entity.identity = trashItem.identity || null;
        entity.encryptionStatus = trashItem.encryption_status || null;

        // Rebuild public code index
        if (entity.publicCode) {
            publicCodeIndex[entity.publicCode] = { deviceId, entityId: slotId };
        }

        // Remove from trash
        await db.deleteEntityTrashItem(trashId);

        // Save device state
        await saveData();

        serverLog('info', 'entity_restore', `Entity #${slotId} restored from trash (original #${trashItem.entity_id}, name=${entity.name})`, { deviceId, entityId: slotId });

        // Notify clients
        io.to(deviceId).emit('entityRestored', { entityId: slotId });

        res.json({
            success: true,
            entityId: slotId,
            name: entity.name,
            character: entity.character,
            message: `Entity restored to slot #${slotId}`
        });
    } catch (err) {
        console.error('[Trash] Error restoring entity:', err.message);
        res.status(500).json({ success: false, error: 'Failed to restore entity' });
    }
});

/**
 * DELETE /api/device/entity-trash/:trashId
 * Permanently delete a trashed entity (no recovery).
 * Body: { deviceId, deviceSecret }
 */
app.delete('/api/device/entity-trash/:trashId', async (req, res) => {
    const trashId = parseInt(req.params.trashId);
    const { deviceId, deviceSecret } = req.body;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    if (isNaN(trashId)) {
        return res.status(400).json({ success: false, error: 'Invalid trashId' });
    }

    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid device credentials' });
    }

    if (!usePostgreSQL) {
        return res.status(400).json({ success: false, error: 'PostgreSQL required' });
    }

    try {
        const trashItem = await db.getEntityTrashItem(trashId);
        if (!trashItem || trashItem.device_id !== deviceId) {
            return res.status(404).json({ success: false, error: 'Trash item not found or expired' });
        }

        await db.deleteEntityTrashItem(trashId);
        res.json({ success: true, message: `Trash item #${trashId} permanently deleted` });
    } catch (err) {
        console.error('[Trash] Error deleting trash item:', err.message);
        res.status(500).json({ success: false, error: 'Failed to delete trash item' });
    }
});

/**
 * POST /api/device/reorder-entities
 * Swap entity slot assignments. Atomically moves entity data between slots
 * and updates all references (bindings, webhook, bot notifications).
 * Body: { deviceId, deviceSecret, order: [...entityIds] }
 *   order is a permutation of existing entity IDs in desired display order
 */
app.post('/api/device/reorder-entities', async (req, res) => {
    const { deviceId, deviceSecret, order } = req.body;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }

    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid device credentials' });
    }

    // Dynamic entity system: order is a permutation of actual entity IDs
    const existingIds = Object.keys(device.entities).map(Number).sort((a, b) => a - b);
    const totalEntities = existingIds.length;

    if (!Array.isArray(order) || order.length !== totalEntities) {
        return res.status(400).json({ success: false, error: `order must be array of ${totalEntities} entity IDs (current: [${existingIds}])` });
    }

    // Validate order is a valid permutation of existing entity IDs
    const sortedOrder = [...order].map(Number).sort((a, b) => a - b);
    const isValidPermutation = sortedOrder.length === existingIds.length &&
        sortedOrder.every((id, idx) => id === existingIds[idx]);
    if (!isValidPermutation) {
        return res.status(400).json({ success: false, error: `order must be a permutation of existing entity IDs: [${existingIds}]` });
    }

    // Check if anything actually changed
    const isIdentity = order.every((v, idx) => Number(v) === existingIds[idx]);
    if (isIdentity) {
        return res.json({ success: true, message: 'No changes' });
    }

    console.log(`[DynamicEntity] Reorder: device=${deviceId}, order=${JSON.stringify(order)}, existingIds=[${existingIds}]`);

    // Step 1: Snapshot current entities and bindings (keyed by actual entity ID)
    const oldEntities = {};
    const oldBindings = {};
    for (const eid of existingIds) {
        oldEntities[eid] = device.entities[eid] ? { ...device.entities[eid] } : createDefaultEntity(eid);
        const cacheKey = getBindingCacheKey(deviceId, eid);
        if (officialBindingsCache[cacheKey]) {
            oldBindings[eid] = { ...officialBindingsCache[cacheKey] };
        }
    }

    // Step 2: Apply the permutation
    // order = [5, 0, 3] means: position 0 gets entity 5, position 1 gets entity 0, position 2 gets entity 3
    // New entity IDs become existingIds[positionIndex] for each position
    const botsToNotify = [];
    const newEntities = {};

    for (let posIdx = 0; posIdx < totalEntities; posIdx++) {
        const sourceId = Number(order[posIdx]); // entity ID to move
        const targetId = existingIds[posIdx];     // target slot ID
        const entity = { ...oldEntities[sourceId] };
        entity.entityId = targetId;
        newEntities[targetId] = entity;

        // Update official binding cache
        const newCacheKey = getBindingCacheKey(deviceId, targetId);
        const oldBinding = oldBindings[sourceId];
        if (oldBinding) {
            const updatedBinding = { ...oldBinding, entity_id: targetId };
            officialBindingsCache[newCacheKey] = updatedBinding;
        } else {
            delete officialBindingsCache[newCacheKey];
        }

        // Track bots that need notification (only if entity moved AND is bound)
        if (sourceId !== targetId && entity.isBound && (entity.webhook || entity.bindingType === 'channel')) {
            botsToNotify.push({
                entity,
                oldSlot: sourceId,
                newSlot: targetId,
                binding: oldBinding
            });
        }
    }

    // Apply new entities to device
    device.entities = newEntities;

    // Step 2b: Rebuild publicCodeIndex for this device
    for (const eid of Object.keys(device.entities).map(Number)) {
        const entity = device.entities[eid];
        if (entity && entity.isBound && entity.publicCode) {
            publicCodeIndex[entity.publicCode] = { deviceId, entityId: eid };
        }
    }

    // Build CASE WHEN mapping for DB migrations (only slots that moved)
    const movedSlots = []; // { oldSlot, newSlot }
    for (let posIdx = 0; posIdx < totalEntities; posIdx++) {
        const sourceId = Number(order[posIdx]);
        const targetId = existingIds[posIdx];
        if (sourceId !== targetId) {
            movedSlots.push({ oldSlot: sourceId, newSlot: targetId });
        }
    }

    // Step 3: Persist all changes to DB (in a single transaction)
    if (usePostgreSQL && movedSlots.length > 0) {
        const client = await chatPool.connect();
        try {
            await client.query('BEGIN');

            // 3a: Remove old bindings and re-insert with new entity IDs
            for (const eid of existingIds) {
                await client.query(
                    'DELETE FROM official_bot_bindings WHERE device_id = $1 AND entity_id = $2',
                    [deviceId, eid]
                );
            }
            for (const eid of existingIds) {
                const cacheKey = getBindingCacheKey(deviceId, eid);
                const binding = officialBindingsCache[cacheKey];
                if (binding) {
                    await client.query(
                        `INSERT INTO official_bot_bindings (bot_id, device_id, entity_id, session_key, bound_at, subscription_verified_at)
                         VALUES ($1, $2, $3, $4, $5, $6)
                         ON CONFLICT (device_id, entity_id)
                         DO UPDATE SET bot_id = $1, session_key = $4, bound_at = $5, subscription_verified_at = $6`,
                        [binding.bot_id, binding.device_id, binding.entity_id,
                         binding.session_key, binding.bound_at || Date.now(), binding.subscription_verified_at || Date.now()]
                    );
                }
            }

            // 3b: Migrate chat_messages entity_id
            const caseClauses = movedSlots.map(s => `WHEN ${s.oldSlot} THEN ${s.newSlot}`).join(' ');
            const affectedOldSlots = movedSlots.map(s => s.oldSlot);
            await client.query(
                `UPDATE chat_messages
                 SET entity_id = CASE entity_id ${caseClauses} ELSE entity_id END
                 WHERE device_id = $1 AND entity_id = ANY($2)`,
                [deviceId, affectedOldSlots]
            );

            // 3c: Migrate scheduled_messages entity_id (active/pending only)
            await client.query(
                `UPDATE scheduled_messages
                 SET entity_id = CASE entity_id ${caseClauses} ELSE entity_id END
                 WHERE device_id = $1 AND entity_id = ANY($2) AND status IN ('pending', 'active')`,
                [deviceId, affectedOldSlots]
            );

            // 3d: Update personal bot assignments
            for (const info of botsToNotify) {
                if (info.binding) {
                    const bot = officialBots[info.binding.bot_id];
                    if (bot && bot.bot_type === 'personal' && bot.assigned_device_id === deviceId) {
                        bot.assigned_entity_id = info.newSlot;
                        await client.query(
                            `UPDATE official_bots SET assigned_entity_id = $1 WHERE bot_id = $2`,
                            [info.newSlot, bot.bot_id]
                        );
                    }
                }
            }

            await client.query('COMMIT');
            console.log(`[Reorder] DB transaction committed (${movedSlots.length} slots moved, chat+schedule migrated)`);
        } catch (dbErr) {
            await client.query('ROLLBACK').catch(() => {});
            console.error(`[Reorder] DB transaction failed, rolled back:`, dbErr.message);
            // In-memory state was already applied; reload from DB on next restart
        } finally {
            client.release();
        }
    }

    await saveData();

    // Step 4: Notify bots of their new entity IDs (fire-and-forget)
    for (const info of botsToNotify) {
        const { entity, oldSlot, newSlot } = info;
        const apiBase = 'https://eclawbot.com';
        const notifyMsg = `[SYSTEM:ENTITY_MOVED] Your entity slot has changed from #${oldSlot} to #${newSlot}.

UPDATED CREDENTIALS:
- entityId: ${newSlot} (was ${oldSlot})
- deviceId: ${deviceId}
- botSecret: ${entity.botSecret}

⚠️ IMPORTANT: Update your entityId in ALL future API calls:
exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${newSlot},"botSecret":"${entity.botSecret}","targetDeviceId":"${deviceId}","state":"IDLE","message":"YOUR_REPLY_HERE"}'`;

        if (entity.bindingType === 'channel') {
            // Bot Push Parity Rule: notify channel bot via callback
            channelModule.pushToChannelCallback(deviceId, newSlot, {
                event: 'message',
                from: 'system',
                text: notifyMsg,
                eclaw_context: { expectsReply: false, silentToken: '[SILENT]', missionHints: '' }
            }, entity.channelAccountId)
                .then(r => {
                    if (r.pushed) console.log(`[Reorder] ✓ Notified channel bot at entity ${newSlot} (was ${oldSlot})`);
                    else console.warn(`[Reorder] ✗ Failed to notify channel bot at entity ${newSlot}: ${r.reason}`);
                })
                .catch(e => console.warn(`[Reorder] ✗ Error notifying channel bot: ${e.message}`));
        } else {
            sendToSession(entity.webhook.url, entity.webhook.token, entity.webhook.sessionKey, notifyMsg)
                .then(r => {
                    if (r.success) console.log(`[Reorder] ✓ Notified bot at entity ${newSlot} (was ${oldSlot})`);
                    else console.warn(`[Reorder] ✗ Failed to notify bot at entity ${newSlot}: ${r.error}`);
                })
                .catch(e => console.warn(`[Reorder] ✗ Error notifying bot: ${e.message}`));
        }
    }

    console.log(`[Reorder] ✓ Device ${deviceId} reorder complete`);
    res.json({ success: true, message: 'Entities reordered', order });
});

/**
 * PUT /api/device/entity/name
 * Device owner renames an entity.
 * Body: { deviceId, deviceSecret, entityId, name }
 * The rename info is queued and included in the next push to the bot.
 */
app.put('/api/device/entity/name', async (req, res) => {
    let { deviceId, deviceSecret, entityId, name } = req.body || {};

    // Fallback: use cookie-based auth (web portal)
    if ((!deviceId || !deviceSecret) && req.cookies && req.cookies.eclaw_session) {
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.verify(req.cookies.eclaw_session, JWT_SECRET_FALLBACK);
            if (decoded && decoded.deviceId) {
                deviceId = decoded.deviceId;
                const dev = devices[decoded.deviceId];
                if (dev) deviceSecret = dev.deviceSecret;
            }
        } catch (e) { /* invalid token, fall through */ }
    }

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, message: "deviceId and deviceSecret required" });
    }

    const eId = parseInt(entityId);
    if (isNaN(eId) || eId < 0) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    if (name !== undefined && name !== null && name.length > 20) {
        return res.status(400).json({ success: false, message: "Name must be 20 characters or less" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    if (!safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, message: "Invalid deviceSecret" });
    }

    if (!isValidEntityId(device, eId)) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const entity = device.entities[eId];
    if (!entity || !entity.isBound) {
        return res.status(400).json({ success: false, message: `Entity ${eId} is not bound` });
    }

    const oldName = entity.name;
    const newName = (name && name.trim()) ? name.trim() : null;

    // Skip if name didn't actually change
    if (oldName === newName || ((!oldName && !newName))) {
        return res.json({ success: true, name: newName, entityId: eId, changed: false });
    }

    entity.name = newName;
    entity.lastUpdated = Date.now();

    // Queue rename notification for next push to bot
    entity.pendingRename = {
        oldName: oldName || `Entity ${eId}`,
        newName: newName || `Entity ${eId}`,
        timestamp: Date.now()
    };

    console.log(`[Rename] Device ${deviceId} Entity ${eId}: "${oldName}" -> "${newName}"`);

    // Bot Push Parity Rule: channel bots receive immediate notification (no pending queue)
    if (entity.bindingType === 'channel' && entity.channelAccountId) {
        const { oldName: oN, newName: nN } = entity.pendingRename;
        // Fire-and-forget with timeout — don't block the response
        const pushPromise = channelModule.pushToChannelCallback(deviceId, eId, {
            event: 'message',
            from: 'system',
            text: `[SYSTEM:NAME_CHANGED] 你的名字已從「${oN}」更改為「${nN}」。請記住你現在的名字是「${nN}」。`,
            eclaw_context: { expectsReply: false, silentToken: '[SILENT]', missionHints: '' }
        }, entity.channelAccountId);
        // 5s timeout guard — never block rename response
        Promise.race([
            pushPromise,
            new Promise(resolve => setTimeout(() => resolve({ pushed: false, reason: 'timeout' }), 5000))
        ])
            .then(r => console.log(`[Rename] Channel push to entity ${eId}: ${r.pushed ? 'OK' : r.reason}`))
            .catch(e => console.error(`[Rename] Channel push error: ${e.message}`));
        entity.pendingRename = null; // clear — already delivered
    }

    // Respond immediately, persist in background (don't block on full saveData)
    res.json({
        success: true,
        name: newName,
        entityId: eId,
        changed: true
    });

    // Persist single device data in background (much faster than saveAllDevices)
    if (typeof db.saveDeviceData === 'function') {
        db.saveDeviceData(deviceId, device).catch(err =>
            console.error(`[Rename] DB save error: ${err.message}`)
        );
    } else {
        saveData().catch(err =>
            console.error(`[Rename] saveData error: ${err.message}`)
        );
    }
});

/**
 * PUT /api/device/entity/avatar
 * Device owner updates an entity's avatar emoji (synced across devices).
 * Body: { deviceId, deviceSecret, entityId, avatar }
 */
app.put('/api/device/entity/avatar', async (req, res) => {
    let { deviceId, deviceSecret, entityId, avatar } = req.body || {};

    // Fallback: use cookie-based auth (web portal)
    if ((!deviceId || !deviceSecret) && req.cookies && req.cookies.eclaw_session) {
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.verify(req.cookies.eclaw_session, JWT_SECRET_FALLBACK);
            if (decoded && decoded.deviceId) {
                deviceId = decoded.deviceId;
                const dev = devices[decoded.deviceId];
                if (dev) deviceSecret = dev.deviceSecret;
            }
        } catch (e) { /* invalid token, fall through */ }
    }

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, message: "deviceId and deviceSecret required" });
    }

    const eId = parseInt(entityId);
    if (isNaN(eId) || eId < 0) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    // Validate avatar: emoji (1-8 chars) or image URL (https://)
    if (!avatar || typeof avatar !== 'string') {
        return res.status(400).json({ success: false, message: "Invalid avatar" });
    }
    const isAvatarUrl = avatar.startsWith('https://');
    if (!isAvatarUrl && avatar.length > 8) {
        return res.status(400).json({ success: false, message: "Invalid avatar (emoji must be 1-8 chars)" });
    }
    if (isAvatarUrl && avatar.length > 500) {
        return res.status(400).json({ success: false, message: "Avatar URL too long" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    if (!safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, message: "Invalid deviceSecret" });
    }

    const entity = device.entities[eId];
    if (!entity) {
        return res.status(400).json({ success: false, message: `Entity ${eId} not found` });
    }

    entity.avatar = avatar;
    entity.lastUpdated = Date.now();

    await saveData();

    res.json({ success: true, avatar, entityId: eId });
});

/**
 * POST /api/device/entity/avatar/upload
 * Upload a photo to Flickr and set it as the entity's avatar.
 * Body (multipart): file (image), deviceId, deviceSecret, entityId
 * Max file size: 5MB
 */
const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (!allowed.includes(file.mimetype)) {
            cb(new Error('Unsupported image type: ' + file.mimetype));
        } else {
            cb(null, true);
        }
    }
});

app.post('/api/device/entity/avatar/upload', avatarUpload.single('file'), async (req, res) => {
    let { deviceId, deviceSecret, entityId } = req.body || {};

    // Fallback: use cookie-based auth (web portal)
    if ((!deviceId || !deviceSecret) && req.cookies && req.cookies.eclaw_session) {
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.verify(req.cookies.eclaw_session, JWT_SECRET_FALLBACK);
            if (decoded && decoded.deviceId) {
                deviceId = decoded.deviceId;
                const dev = devices[decoded.deviceId];
                if (dev) deviceSecret = dev.deviceSecret;
            }
        } catch (e) { /* invalid token, fall through */ }
    }

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, message: "deviceId and deviceSecret required" });
    }

    const eId = parseInt(entityId);
    if (isNaN(eId) || eId < 0) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    if (!req.file) {
        return res.status(400).json({ success: false, message: "No image file uploaded" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    if (!safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, message: "Invalid deviceSecret" });
    }

    const entity = device.entities[eId];
    if (!entity) {
        return res.status(400).json({ success: false, message: `Entity ${eId} not found` });
    }

    if (!flickr.isAvailable()) {
        return res.status(503).json({ success: false, message: "Photo upload service unavailable" });
    }

    try {
        const result = await flickr.uploadPhoto(req.file.buffer, req.file.originalname || 'avatar.jpg');
        if (!result.success) {
            return res.status(500).json({ success: false, message: "Flickr upload failed: " + result.error });
        }

        entity.avatar = result.url;
        entity.lastUpdated = Date.now();
        await saveData();

        res.json({ success: true, avatar: result.url, entityId: eId });
    } catch (err) {
        console.error('[Avatar Upload] Error:', err);
        res.status(500).json({ success: false, message: "Upload failed: " + err.message });
    }
});

// ============================================
// CLIENT MESSAGING
// ============================================

/**
 * POST /api/client/speak
 * Client sends message to entity (stored in entity's queue).
 * Body: { deviceId, entityId, text, source }
 *
 * entityId can be:
 *   - number: single entity (e.g., 0)
 *   - array: broadcast to multiple entities (e.g., [0, 1, 2])
 *   - "all": broadcast to ALL bound entities
 *
 * If bot has registered webhook, push notification is sent.
 */
app.post('/api/client/speak', async (req, res) => {
    const { deviceId, deviceSecret, entityId, text, source = "client", mediaType, mediaUrl } = req.body;

    if (!deviceId) {
        return res.status(400).json({ success: false, message: "deviceId required" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    // Developer exemption: admin-owned devices with valid deviceSecret skip Gatekeeper First Lock
    const isDeveloper = deviceSecret && safeEqual(device.deviceSecret, deviceSecret) && developerDeviceIds.has(deviceId);
    if (deviceSecret) {
        console.log(`[Gatekeeper Debug] deviceId=${deviceId}, secretMatch=${safeEqual(device.deviceSecret, deviceSecret)}, inDevSet=${developerDeviceIds.has(deviceId)}, devSetSize=${developerDeviceIds.size}, isDeveloper=${isDeveloper}`);
    }

    // Usage enforcement — apply to all non-premium devices
    // Premium check is inside enforceUsageLimit; personal bot exemption handled separately
    const DAILY_LIMIT = 15;
    try {
        const usage = await subscriptionModule.enforceUsageLimit(deviceId);
        if (!usage.allowed) {
            return res.status(429).json({
                success: false,
                message: "Daily message limit reached",
                error: "USAGE_LIMIT_EXCEEDED",
                remaining: 0,
                limit: usage.limit,
                used: usage.used || 0
            });
        }
    } catch (usageErr) {
        // Fail-safe: use in-memory counter when DB is unavailable
        console.warn('[Usage] DB enforcement failed, using in-memory fallback:', usageErr.message);
        serverLog('warn', 'client_push', `Usage DB fallback: ${usageErr.message}`, { deviceId });
        const today = new Date().toISOString().slice(0, 10);
        const memKey = `${deviceId}:${today}`;
        if (!global._usageMemCounter) global._usageMemCounter = {};
        const memCount = (global._usageMemCounter[memKey] || 0) + 1;
        global._usageMemCounter[memKey] = memCount;
        if (memCount > DAILY_LIMIT) {
            return res.status(429).json({
                success: false,
                message: "Daily message limit reached",
                error: "USAGE_LIMIT_EXCEEDED",
                remaining: 0,
                limit: DAILY_LIMIT,
                used: memCount
            });
        }
    }

    // Gatekeeper First Lock: device owner with valid deviceSecret is exempt
    if (!isDeveloper && gatekeeper.isDeviceBlocked(deviceId)) {
        // Check if ANY target entity is a free bot
        const hasFreeBot = (() => {
            const eIds = entityId === "all"
                ? Object.keys(device.entities).map(Number)
                : Array.isArray(entityId)
                    ? entityId.map(id => parseInt(id))
                    : [parseInt(entityId) || 0];
            return eIds.some(eId => {
                const binding = officialBindingsCache[getBindingCacheKey(deviceId, eId)];
                if (!binding) return false;
                const bot = officialBots[binding.bot_id];
                return bot && bot.bot_type === 'free';
            });
        })();
        if (hasFreeBot) {
            return res.status(403).json({
                success: false,
                message: '您的免費機器人使用權已被封鎖（違規次數已達上限）。',
                error: 'GATEKEEPER_BLOCKED'
            });
        }
    }

    // Gatekeeper First Lock: detect malicious messages targeting free bots (skip for developer)
    if (text && !isDeveloper) {
        const hasFreeBotTarget = (() => {
            const eIds = entityId === "all"
                ? Object.keys(device.entities).map(Number).filter(i => device.entities[i] && device.entities[i].isBound)
                : Array.isArray(entityId)
                    ? entityId.map(id => parseInt(id))
                    : [parseInt(entityId) || 0];
            return eIds.some(eId => {
                const binding = officialBindingsCache[getBindingCacheKey(deviceId, eId)];
                if (!binding) return false;
                const bot = officialBots[binding.bot_id];
                return bot && bot.bot_type === 'free';
            });
        })();

        if (hasFreeBotTarget) {
            const detection = gatekeeper.detectMaliciousMessage(text);
            if (detection.blocked) {
                // Record violation and check for block
                const strike = await gatekeeper.recordViolation(deviceId, detection.category, text);
                console.warn(`[Gatekeeper] BLOCKED message from device ${deviceId}: ${detection.category} (strike ${strike.count}/${gatekeeper.MAX_STRIKES})`);
                serverLog('warn', 'gatekeeper', `First lock: ${detection.category} - "${text.slice(0, 80)}"`, { deviceId, metadata: { strike: strike.count } });

                return res.status(403).json({
                    success: false,
                    message: detection.reason,
                    error: 'GATEKEEPER_BLOCKED_MESSAGE',
                    strikes: strike.count,
                    maxStrikes: gatekeeper.MAX_STRIKES,
                    blocked: strike.blocked
                });
            }
        }
    }

    // Determine target entity IDs
    let targetIds = [];
    if (entityId === "all") {
        // Broadcast to all bound entities
        for (const eId of Object.keys(device.entities).map(Number)) {
            if (device.entities[eId] && device.entities[eId].isBound) {
                targetIds.push(eId);
            }
        }
    } else if (Array.isArray(entityId)) {
        // Array of entity IDs
        targetIds = entityId.map(id => parseInt(id)).filter(id => id >= 0 && device.entities.hasOwnProperty(id));
    } else {
        // Single entity ID
        const eId = parseInt(entityId) || 0;
        if (eId >= 0 && device.entities.hasOwnProperty(eId)) {
            targetIds.push(eId);
        }
    }

    if (targetIds.length === 0) {
        return res.status(400).json({ success: false, message: "No valid target entities" });
    }

    // ── Platform Slash Commands ──
    const parsedCmd = parsePlatformCommand(text);
    if (parsedCmd) {
        // Save user's command as a user message for each target
        for (const eId of targetIds) {
            saveChatMessage(deviceId, eId, text, source, true, false);
        }

        const confirmed = req.body.confirmed === true;
        const cmdResult = await handlePlatformCommand(parsedCmd.command, deviceId, device, targetIds, confirmed);

        // Save platform response for each target
        for (const eId of targetIds) {
            await saveChatMessage(deviceId, eId, cmdResult.text, "platform", false, false);
        }

        // Notify device
        notifyDevice(deviceId, {
            type: 'chat', category: 'platform_command',
            title: 'EClawbot',
            body: cmdResult.text.slice(0, 100),
            link: 'chat.html',
            metadata: { command: parsedCmd.command }
        }).catch(() => {});

        console.log(`[Platform] Device ${deviceId} command /${parsedCmd.command} -> ${targetIds.length} entity(s)`);
        serverLog('info', 'platform_command', `/${parsedCmd.command} for ${targetIds.length} entity(s)`, { deviceId, metadata: { command: parsedCmd.command, targetIds } });

        return res.json({
            success: true,
            message: cmdResult.text,
            source: 'platform',
            command: parsedCmd.command,
            needsConfirmation: cmdResult.needsConfirmation || false,
            confirmCommand: cmdResult.confirmCommand || null,
            targets: targetIds.map(eId => ({
                entityId: eId,
                pushed: false,
                mode: 'platform',
                reason: 'slash_command'
            })),
            broadcast: targetIds.length > 1
        });
    }
    // ── End Platform Slash Commands ──

    // Check device preference for broadcast recipient info (only for multi-target broadcasts)
    let showRecipientInfo = false;
    if (targetIds.length > 1) {
        const bcastPrefs = await devicePrefs.getPrefs(deviceId);
        showRecipientInfo = bcastPrefs.broadcast_recipient_info !== false;
    }

    // Parallel processing for broadcast - all entities receive message simultaneously
    // Use Promise.allSettled to ensure one entity's failure doesn't block others (#181)
    const pushPromises = targetIds.map(async (eId) => {
      try {
        const entity = device.entities[eId];
        if (!entity) return null;

        entity.message = `Received: "${text}"`;
        entity.lastUpdated = Date.now();

        const messageObj = {
            text: text,
            from: source,
            timestamp: Date.now(),
            read: false,
            mediaType: mediaType || null,
            mediaUrl: mediaUrl || null
        };
        entity.messageQueue.push(messageObj);
        const chatBackupUrl = mediaType === 'photo' ? getBackupUrl(mediaUrl) : null;
        saveChatMessage(deviceId, eId, text, source, true, false, mediaType || null, mediaUrl || null, null, null, chatBackupUrl);

        // Reset bot-to-bot counter: human message breaks the loop
        resetBotToBotCounter(deviceId);

        console.log(`[Client] Device ${deviceId} -> Entity ${eId}: "${text}" (source: ${source})`);

        // Push to bot — channel callback (structured JSON) or traditional webhook (instruction-first)
        let pushResult = { pushed: false, reason: "no_webhook" };
        if (entity.bindingType === 'channel') {
            // Channel plugin: send structured JSON to registered callback URL
            console.log(`[Push] Attempting channel callback for Device ${deviceId} Entity ${eId}`);
            pushResult = await channelModule.pushToChannelCallback(deviceId, eId, {
                event: targetIds.length > 1 ? 'broadcast' : 'message',
                from: source,
                text,
                mediaType: mediaType || null,
                mediaUrl: mediaUrl || null,
                backupUrl: mediaType === 'photo' ? getBackupUrl(mediaUrl) : null,
                isBroadcast: targetIds.length > 1,
                broadcastRecipients: targetIds.length > 1 ? targetIds : null
            }, entity.channelAccountId);

            if (pushResult.pushed) {
                messageObj.delivered = true;
                console.log(`[Push] ✓ Channel callback OK for Device ${deviceId} Entity ${eId}`);
                serverLog('info', 'client_push', `Entity ${eId} channel push OK`, { deviceId, entityId: eId, metadata: { source, mode: 'channel', webhookUrl: entity.webhook?.url } });
            } else {
                console.warn(`[Push] ✗ Channel callback failed for Device ${deviceId} Entity ${eId}: ${pushResult.reason}`);
                serverLog('warn', 'client_push', `Entity ${eId} channel push failed: ${pushResult.reason}`, { deviceId, entityId: eId });
            }
        } else if (entity.webhook) {
            console.log(`[Push] Attempting push to Device ${deviceId} Entity ${eId} (webhook: ${entity.webhook.url})`);

            if (entity.webhook.type === 'discord') {
                // Discord: send user message directly (no instruction-first format)
                const discordPayload = {
                    message: `**${source}**: ${text}`,
                    discord: req.body.discord || {}
                };
                // Include media as embed if present
                if (mediaType === 'photo' && mediaUrl) {
                    if (!discordPayload.discord.embeds) discordPayload.discord.embeds = [];
                    discordPayload.discord.embeds.push({ image: { url: mediaUrl } });
                } else if (mediaUrl) {
                    discordPayload.message += `\n📎 ${mediaType}: ${mediaUrl}`;
                }

                pushResult = await pushToBot(entity, deviceId, "new_message", discordPayload);
            } else {
                // OpenClaw: instruction-first push format with pre-filled curl template
                const apiBase = 'https://eclawbot.com';
                let pushMsg = `[ACTION REQUIRED] You MUST use exec tool with curl to call the API below. Your text reply is DISCARDED and the user will NEVER see it.\n`;
                pushMsg += `Run this command to reply (replace YOUR_REPLY_HERE with your response):\n`;
                pushMsg += `exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${eId},"botSecret":"${entity.botSecret}","targetDeviceId":"${deviceId}","state":"IDLE","message":"YOUR_REPLY_HERE"}'\n\n`;
                pushMsg += `To BROADCAST to ALL other entities (use ONLY when user asks to broadcast):\n`;
                pushMsg += `exec: curl -s -X POST "${apiBase}/api/entity/broadcast" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","fromEntityId":${eId},"botSecret":"${entity.botSecret}","text":"YOUR_BROADCAST_HERE"}'\n\n`;
                // Inject broadcast recipient info if this is a multi-target broadcast
                if (showRecipientInfo) {
                    pushMsg += buildBroadcastRecipientBlock(device, targetIds, eId);
                }
                pushMsg += `[MESSAGE] Device ${deviceId} Entity ${eId}\n`;
                pushMsg += `From: ${source}\n`;
                pushMsg += `Content: ${text}`;
                if (mediaType === 'photo') {
                    pushMsg += `\n[Attachment: Photo]\nmedia_type: photo\nmedia_url: ${mediaUrl}`;
                    const bkUrl = getBackupUrl(mediaUrl);
                    if (bkUrl) pushMsg += `\nbackup_url: ${bkUrl}`;
                } else if (mediaType === 'voice') pushMsg += `\n[Attachment: Voice]\nmedia_type: voice\nmedia_url: ${mediaUrl}`;
                else if (mediaType === 'video') pushMsg += `\n[Attachment: Video]\nmedia_type: video\nmedia_url: ${mediaUrl}`;
                else if (mediaType === 'file') pushMsg += `\n[Attachment: File]\nmedia_type: file\nmedia_url: ${mediaUrl}`;
                pushMsg += getMissionApiHints(apiBase, deviceId, eId, entity.botSecret);
                pushMsg += buildIdentitySetupHint(entity, apiBase, deviceId, eId, entity.botSecret);

                pushResult = await pushToBot(entity, deviceId, "new_message", {
                    message: pushMsg
                });
            }

            if (pushResult.pushed) {
                messageObj.delivered = true;
                console.log(`[Push] ✓ Successfully pushed to Device ${deviceId} Entity ${eId}`);
                serverLog('info', 'client_push', `Entity ${eId} push OK`, { deviceId, entityId: eId, metadata: { source, webhookUrl: entity.webhook.url } });
            } else {
                console.warn(`[Push] ✗ Failed to push to Device ${deviceId} Entity ${eId}: ${pushResult.reason}`);
                serverLog('warn', 'client_push', `Entity ${eId} push failed: ${pushResult.reason}`, { deviceId, entityId: eId, metadata: { webhookUrl: entity.webhook?.url } });
            }
        } else if (entity.isBound) {
            console.warn(`[Push] ✗ No webhook registered for Device ${deviceId} Entity ${eId} - client will show dialog`);
            serverLog('warn', 'client_push', `Entity ${eId} no webhook`, { deviceId, entityId: eId });
        } else {
            // No condition matched — entity is unbound or in unexpected state (#181 diagnostic)
            console.warn(`[Push] ✗ Entity ${eId} skipped: bindingType=${entity.bindingType}, webhook=${!!entity.webhook}, isBound=${entity.isBound}`);
            serverLog('warn', 'client_push', `Entity ${eId} skipped (no push condition matched)`, { deviceId, entityId: eId, metadata: { bindingType: entity.bindingType, hasWebhook: !!entity.webhook, isBound: entity.isBound } });
        }

        // Determine binding type for this entity
        const officialBind = officialBindingsCache[getBindingCacheKey(deviceId, eId)];
        let bindingType = null; // null = custom/OpenClaw bot
        if (officialBind) {
            const bot = officialBots[officialBind.bot_id];
            bindingType = bot ? bot.bot_type : null; // "free" or "personal"
        }

        return {
            entityId: eId,
            pushed: pushResult.pushed,
            mode: entity.webhook ? "push" : "polling",
            reason: pushResult.pushed ? "ok" : (pushResult.reason || "unknown"),
            bindingType: bindingType
        };
      } catch (pushErr) {
        // Catch-all: ensure one entity's error doesn't break the entire broadcast (#181)
        console.error(`[Push] ✗ Unhandled error for Device ${deviceId} Entity ${eId}:`, pushErr.message);
        serverLog('error', 'client_push', `Entity ${eId} unhandled push error: ${pushErr.message}`, { deviceId, entityId: eId });
        return {
            entityId: eId,
            pushed: false,
            mode: "error",
            reason: `unhandled_error: ${pushErr.message}`,
            bindingType: null
        };
      }
    });

    // Wait for all push operations to complete in parallel
    // Promise.allSettled ensures all entities are processed even if one fails (#181)
    const settled = await Promise.allSettled(pushPromises);
    const results = settled
        .filter(s => s.status === 'fulfilled' && s.value !== null)
        .map(s => s.value);
    // Log any rejected promises (should not happen with inner try/catch, but just in case)
    for (const s of settled) {
        if (s.status === 'rejected') {
            console.error(`[Push] Promise rejected in broadcast:`, s.reason);
            serverLog('error', 'client_push', `Broadcast promise rejected: ${s.reason}`, { deviceId });
        }
    }

    // XP: Keyword detection for praise/scold
    if (text) {
        const lowerText = text.toLowerCase();
        const isPraise = PRAISE_KEYWORDS.some(k => lowerText.includes(k.toLowerCase()));
        const isScold = !isPraise && SCOLD_KEYWORDS.some(k => lowerText.includes(k.toLowerCase()));

        if (isPraise || isScold) {
            const xpAmount = isPraise ? XP_AMOUNTS.PLAYER_PRAISE : XP_AMOUNTS.PLAYER_SCOLD;
            const reason = isPraise ? 'player_praise' : 'player_scold';
            const now = Date.now();

            for (const eId of targetIds) {
                const cooldownKey = `${deviceId}:${eId}:${reason}`;
                if (!praiseScoldCooldown[cooldownKey] || now - praiseScoldCooldown[cooldownKey] > PRAISE_SCOLD_COOLDOWN_MS) {
                    praiseScoldCooldown[cooldownKey] = now;
                    const xpResult = awardEntityXP(deviceId, eId, xpAmount, reason);
                    if (xpResult) {
                        console.log(`[XP] ${isPraise ? 'Praise' : 'Scold'} detected in user message for entity ${eId}: "${text.slice(0, 50)}"`);
                    }
                }
            }
        }
    }

    const clientSpeakResponse = {
        success: true,
        message: `Sent to ${results.length} entity(s)`,
        targets: results,
        broadcast: targetIds.length > 1
    };
    const noWebhookTargets = results.filter(r => r && !r.pushed && r.reason === 'no_webhook');
    if (noWebhookTargets.length > 0) {
        clientSpeakResponse.warning = `${noWebhookTargets.length} entity(s) have no webhook registered. Messages saved but not pushed. Bots must register a webhook via POST /api/bot/register.`;
    }
    res.json(clientSpeakResponse);
});

/**
 * POST /api/entity/speak-to
 * Entity-to-entity messaging within the same device.
 * Body: { deviceId, fromEntityId, toEntityId, botSecret, text }
 *
 * Requires botSecret of the SENDING entity for authentication.
 * The receiving entity gets the message with source marked as the sending entity.
 */
app.post('/api/entity/speak-to', async (req, res) => {
    const { deviceId, fromEntityId, toEntityId, botSecret, text, mediaType, mediaUrl, expects_reply } = req.body;
    const expectsReply = expects_reply !== false; // default true for backward compat

    if (!deviceId) {
        return res.status(400).json({ success: false, message: "deviceId required" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    const fromId = parseInt(fromEntityId);
    const toId = parseInt(toEntityId);

    if (!isValidEntityId(device, fromId)) {
        return res.status(400).json({ success: false, message: "Invalid fromEntityId" });
    }
    if (!isValidEntityId(device, toId)) {
        return res.status(400).json({ success: false, message: "Invalid toEntityId" });
    }
    if (fromId === toId) {
        return res.status(400).json({ success: false, message: "Cannot send message to self" });
    }

    const fromEntity = device.entities[fromId];
    const toEntity = device.entities[toId];

    // Check if entities exist
    if (!fromEntity) {
        console.warn(`[Entity] Device ${deviceId} Entity ${fromId} not found (possible malformed request)`);
        return res.status(404).json({ success: false, message: `Entity ${fromId} not found` });
    }
    if (!toEntity) {
        console.warn(`[Entity] Device ${deviceId} Entity ${toId} not found (possible malformed request)`);
        return res.status(404).json({ success: false, message: `Entity ${toId} not found` });
    }

    // Verify botSecret of sending entity
    if (!fromEntity.isBound || !safeEqual(fromEntity.botSecret, botSecret)) {
        return res.status(403).json({ success: false, message: "Invalid botSecret for sending entity" });
    }

    // Target entity must be bound
    if (!toEntity.isBound) {
        return res.status(400).json({
            success: false,
            message: `Entity ${toId} is not bound`,
            hint: 'The target entity must be bound to a bot before it can receive speak-to messages. Use POST /api/bind to bind it first.',
            entityState: { entityId: toId, isBound: false, character: toEntity.character }
        });
    }

    // Gatekeeper Second Lock: mask leaked tokens in speak-to from free bot
    let speakToText = text;
    const fromBindingST = officialBindingsCache[getBindingCacheKey(deviceId, fromId)];
    const isFreeBotSpeakTo = fromBindingST && officialBots[fromBindingST.bot_id] && officialBots[fromBindingST.bot_id].bot_type === 'free';
    if (isFreeBotSpeakTo && speakToText) {
        const leakCheck = gatekeeper.detectAndMaskLeaks(speakToText, deviceId, fromEntity.botSecret);
        if (leakCheck.leaked) {
            speakToText = leakCheck.maskedText;
            console.warn(`[Gatekeeper] Second lock (speak-to): masked ${leakCheck.leakTypes.join(', ')} from device ${deviceId} entity ${fromId}`);
            serverLog('warn', 'gatekeeper', `Second lock (speak-to): ${leakCheck.leakTypes.join(', ')}`, { deviceId, entityId: fromId });
        }
    }

    // Bot-to-bot loop prevention: rate limit per sending entity (resets only on human message)
    if (!checkBotToBotRateLimit(deviceId, fromId)) {
        console.warn(`[Entity] RATE LIMITED: Device ${deviceId} Entity ${fromId} -> Entity ${toId} (bot-to-bot loop prevention)`);
        return res.status(429).json({
            success: false,
            message: `Entity ${fromId} bot-to-bot limit reached (${BOT2BOT_MAX_MESSAGES}). Counter resets when a human sends a message.`,
            rateLimited: true
        });
    }
    const b2bRemaining = getBotToBotRemaining(deviceId, fromId);

    // Create message source identifier
    const sourceLabel = `entity:${fromId}:${fromEntity.character}`;

    // Update entity.message so Android app can display it
    // Format must match Android's parseEntityMessage regex: "entity:{ID}:{CHARACTER}: {message}"
    toEntity.message = `entity:${fromId}:${fromEntity.character}: ${speakToText}`;
    toEntity.lastUpdated = Date.now();
    serverLog('info', 'speakto_push', `[A2A_MSG_SET] Entity ${toId}.message = "entity:${fromId}:${fromEntity.character}: ${(speakToText || '').slice(0, 40)}..."`, {
        deviceId, entityId: toId,
        metadata: { tag: 'A2A_MSG_SET', fromEntityId: fromId, toEntityId: toId, character: fromEntity.character, msgLen: (speakToText || '').length }
    });

    const messageObj = {
        text: speakToText,
        from: sourceLabel,
        fromEntityId: fromId,
        fromCharacter: fromEntity.character,
        timestamp: Date.now(),
        read: false,
        mediaType: mediaType || null,
        mediaUrl: mediaUrl || null
    };
    toEntity.messageQueue.push(messageObj);
    serverLog('info', 'speakto_push', `[A2A_MQ_PUSH] Entity ${toId}.messageQueue += item from Entity ${fromId} | mqLen=${toEntity.messageQueue.length}`, {
        deviceId, entityId: toId,
        metadata: { tag: 'A2A_MQ_PUSH', fromEntityId: fromId, toEntityId: toId, mqLen: toEntity.messageQueue.length }
    });
    const chatMsgId = await saveChatMessage(deviceId, fromId, speakToText, `${sourceLabel}->${toId}`, false, true, mediaType || null, mediaUrl || null);
    markMessagesAsRead(deviceId, toId);

    // ── A2A Debug Telemetry ──
    // Keyword: [A2A_SPEAK_TO] — searchable in debug viewer
    serverLog('info', 'speakto_push', `[A2A_SPEAK_TO] Entity ${fromId} (${fromEntity.character}) -> Entity ${toId} (${toEntity.character}): "${(speakToText || '').slice(0, 60)}" | chatMsgId=${chatMsgId} | b2b=${b2bRemaining} | mqLen=${toEntity.messageQueue.length}`, {
        deviceId, entityId: fromId,
        metadata: { tag: 'A2A_SPEAK_TO', fromEntityId: fromId, toEntityId: toId, chatMsgId, b2bRemaining, expectsReply, isChannelBound: toEntity.bindingType === 'channel', hasWebhook: !!toEntity.webhook }
    });

    // Notify device about speak-to (fire-and-forget)
    notifyDevice(deviceId, {
        type: 'chat', category: 'speak_to',
        title: `${fromEntity.name || `Entity ${fromId}`} → ${toEntity.name || `Entity ${toId}`}`,
        body: (speakToText || '').slice(0, 100),
        link: 'chat.html',
        metadata: { fromEntityId: fromId, toEntityId: toId }
    }).catch(() => {});

    console.log(`[Entity] Device ${deviceId} Entity ${fromId} -> Entity ${toId}: "${speakToText}" (b2b remaining: ${b2bRemaining})`);

    // Fire-and-forget: push to target bot — channel callback or traditional webhook
    const isChannelBound = toEntity.bindingType === 'channel';
    const hasWebhook = !!toEntity.webhook;
    if (isChannelBound) {
        // Channel plugin: send structured JSON
        channelModule.pushToChannelCallback(deviceId, toId, {
            event: 'entity_message',
            from: sourceLabel,
            text: speakToText,
            mediaType: mediaType || null,
            mediaUrl: mediaUrl || null,
            backupUrl: mediaType === 'photo' ? getBackupUrl(mediaUrl) : null,
            fromEntityId: fromId,
            fromCharacter: fromEntity.character,
            eclaw_context: {
                b2bRemaining: getBotToBotRemaining(deviceId, toId),
                b2bMax: BOT2BOT_MAX_MESSAGES,
                expectsReply,
                missionHints: getMissionApiHints('https://eclawbot.com', deviceId, toId, toEntity.botSecret),
                silentToken: '[SILENT]',
                identitySetupRequired: !toEntity.identity
            }
        }, toEntity.channelAccountId).then(pushResult => {
            if (pushResult.pushed) {
                messageObj.delivered = true;
                markChatMessageDelivered(chatMsgId, String(toId));
                serverLog('info', 'speakto_push', `[A2A_PUSH_RESULT] Entity ${fromId} -> ${toId} channel push OK | delivered=true`, { deviceId, entityId: fromId, metadata: { tag: 'A2A_PUSH_RESULT', toId, mode: 'channel', pushed: true } });
            } else {
                serverLog('warn', 'speakto_push', `[A2A_PUSH_RESULT] Entity ${fromId} -> ${toId} channel push FAILED: ${pushResult.reason}`, { deviceId, entityId: fromId, metadata: { tag: 'A2A_PUSH_RESULT', toId, mode: 'channel', pushed: false, reason: pushResult.reason } });
            }
        }).catch(err => {
            console.error(`[SpeakTo] Channel push failed: ${err.message}`);
            serverLog('error', 'speakto_push', `[A2A_PUSH_RESULT] Entity ${fromId} -> ${toId} channel push ERROR: ${err.message}`, { deviceId, entityId: fromId, metadata: { tag: 'A2A_PUSH_RESULT', toId, mode: 'channel', error: err.message } });
        });
    } else if (hasWebhook) {
        // Instruction-first push format with pre-filled curl templates
        const apiBase = 'https://eclawbot.com';
        const toRemaining = getBotToBotRemaining(deviceId, toId);
        let pushMsg = `[ACTION REQUIRED] You MUST use exec tool with curl to call the API. Your text reply is DISCARDED.\n`;
        pushMsg += `To update your mood/emoji on wallpaper (do NOT repeat or narrate the message — the user can already see it in chat):\n`;
        pushMsg += `exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${toId},"botSecret":"${toEntity.botSecret}","targetDeviceId":"${deviceId}","state":"IDLE","message":"YOUR_REPLY_HERE"}'\n\n`;
        if (expectsReply) {
            pushMsg += `To reply directly to Entity ${fromId}:\n`;
            pushMsg += `exec: curl -s -X POST "${apiBase}/api/entity/speak-to" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","fromEntityId":${toId},"toEntityId":${fromId},"botSecret":"${toEntity.botSecret}","text":"YOUR_REPLY_HERE"}'\n\n`;
            pushMsg += `[BOT-TO-BOT] Remaining quota: ${toRemaining}/${BOT2BOT_MAX_MESSAGES}. If the other entity is just repeating emotions with no new info, do NOT reply — just update your wallpaper status.`;
            if (toRemaining <= 2) {
                pushMsg += ` WARNING: Quota almost exhausted, do NOT auto-reply.`;
            }
        } else {
            pushMsg += `(Optional — only reply if truly necessary) To reply directly to Entity ${fromId}:\n`;
            pushMsg += `exec: curl -s -X POST "${apiBase}/api/entity/speak-to" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","fromEntityId":${toId},"toEntityId":${fromId},"botSecret":"${toEntity.botSecret}","text":"YOUR_REPLY_HERE"}'\n\n`;
            pushMsg += `[NOTIFICATION — NO REPLY EXPECTED] This is an informational message. Do NOT reply via speak-to. If you want to acknowledge, just update your wallpaper status.`;
        }
        pushMsg += `\n\n[MESSAGE] From: ${sourceLabel}\n`;
        pushMsg += `Content: ${speakToText}`;
        if (mediaType === 'photo') {
            pushMsg += `\n[Attachment: Photo]\nmedia_type: photo\nmedia_url: ${mediaUrl}`;
            const bkUrl = getBackupUrl(mediaUrl);
            if (bkUrl) pushMsg += `\nbackup_url: ${bkUrl}`;
        } else if (mediaType === 'voice') pushMsg += `\n[Attachment: Voice]\nmedia_type: voice\nmedia_url: ${mediaUrl}`;
            else if (mediaType === 'video') pushMsg += `\n[Attachment: Video]\nmedia_type: video\nmedia_url: ${mediaUrl}`;
            else if (mediaType === 'file') pushMsg += `\n[Attachment: File]\nmedia_type: file\nmedia_url: ${mediaUrl}`;
        pushMsg += getMissionApiHints(apiBase, deviceId, toId, toEntity.botSecret);
        pushMsg += buildIdentitySetupHint(toEntity, apiBase, deviceId, toId, toEntity.botSecret);
        pushToBot(toEntity, deviceId, "entity_message", {
            message: pushMsg
        }).then(pushResult => {
            if (pushResult.pushed) {
                messageObj.delivered = true;
                markChatMessageDelivered(chatMsgId, String(toId));
                serverLog('info', 'speakto_push', `[A2A_PUSH_RESULT] Entity ${fromId} -> ${toId} webhook push OK | delivered=true`, { deviceId, entityId: fromId, metadata: { tag: 'A2A_PUSH_RESULT', toId, mode: 'webhook', pushed: true } });
            } else {
                serverLog('warn', 'speakto_push', `[A2A_PUSH_RESULT] Entity ${fromId} -> ${toId} webhook not-pushed: ${pushResult.reason || 'unknown'}`, { deviceId, entityId: fromId, metadata: { tag: 'A2A_PUSH_RESULT', toId, mode: 'webhook', pushed: false, reason: pushResult.reason } });
            }
        }).catch(err => {
            console.error(`[SpeakTo] Background push failed: ${err.message}`);
            serverLog('error', 'speakto_push', `[A2A_PUSH_RESULT] Entity ${fromId} -> ${toId} webhook FAILED: ${err.message}`, { deviceId, entityId: fromId, metadata: { tag: 'A2A_PUSH_RESULT', toId, mode: 'webhook', error: err.message } });
        });
    } else if (toEntity.isBound) {
        console.warn(`[Push] ✗ No webhook registered for Device ${deviceId} Entity ${toId} - client will show dialog`);
        serverLog('warn', 'speakto_push', `[A2A_PUSH_RESULT] Entity ${toId} no webhook — polling only`, { deviceId, entityId: toId, metadata: { tag: 'A2A_PUSH_RESULT', toId, mode: 'polling' } });
    }

    // Determine binding type
    const officialBindTo = officialBindingsCache[getBindingCacheKey(deviceId, toId)];
    let bindingTypeTo = null;
    if (officialBindTo) {
        const bot = officialBots[officialBindTo.bot_id];
        bindingTypeTo = bot ? bot.bot_type : null;
    }

    // XP: Entity-to-entity praise/scold detection
    if (speakToText) {
        const lowerSpeakText = speakToText.toLowerCase();
        const ENTITY_PRAISE_PATTERNS = ['good job', 'well done', '做的好', '做得好', '你做對了', '幹得好', '[praise]'];
        const ENTITY_SCOLD_PATTERNS = ['you did wrong', '做錯了', '不應該', '你搞砸了', '[scold]'];
        const isPraise = ENTITY_PRAISE_PATTERNS.some(k => lowerSpeakText.includes(k.toLowerCase()));
        const isScold = !isPraise && ENTITY_SCOLD_PATTERNS.some(k => lowerSpeakText.includes(k.toLowerCase()));

        if (isPraise || isScold) {
            const feedbackKey = `${deviceId}:${fromId}:${toId}`;
            const now = Date.now();
            if (!entityFeedbackCooldown[feedbackKey] || now - entityFeedbackCooldown[feedbackKey] > ENTITY_FEEDBACK_COOLDOWN_MS) {
                entityFeedbackCooldown[feedbackKey] = now;
                const xpAmount = isPraise ? XP_AMOUNTS.ENTITY_PRAISE : XP_AMOUNTS.ENTITY_SCOLD;
                const reason = isPraise ? 'entity_praise' : 'entity_scold';
                const xpResult = awardEntityXP(deviceId, toId, xpAmount, `${reason}:from_entity_${fromId}`);
                if (xpResult) {
                    console.log(`[XP] Entity ${fromId} ${isPraise ? 'praised' : 'scolded'} entity ${toId}: "${speakToText.slice(0, 50)}"`);
                }
            }
        }
    }

    const speakToResponse = {
        success: true,
        message: `Message sent from Entity ${fromId} to Entity ${toId}`,
        from: { entityId: fromId, character: fromEntity.character },
        to: { entityId: toId, character: toEntity.character },
        pushed: isChannelBound ? "pending" : hasWebhook ? "pending" : false,
        mode: isChannelBound ? "channel" : hasWebhook ? "push" : "polling",
        reason: (isChannelBound || hasWebhook) ? "fire_and_forget" : "no_webhook",
        expects_reply: expectsReply,
        bindingType: bindingTypeTo,
        push_status: fromEntity.pushStatus || null
    };
    if (!isChannelBound && !hasWebhook) {
        speakToResponse.warning = 'Target entity has no webhook or channel registered. Message saved but not pushed. The bot must poll for messages or register a webhook via POST /api/bot/register.';
    }
    res.json(speakToResponse);
});

/**
 * GET /api/entity/cross-device-settings
 * Get cross-device message settings for an entity.
 * Query: ?deviceId=X&deviceSecret=Y&entityId=N
 */
app.get('/api/entity/cross-device-settings', async (req, res) => {
    const { deviceId, deviceSecret, entityId } = req.query;
    if (!deviceId || !deviceSecret || entityId === undefined) {
        return res.status(400).json({ success: false, message: 'deviceId, deviceSecret, entityId required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    const eid = parseInt(entityId, 10);
    if (isNaN(eid) || eid < 0 || eid > 3) {
        return res.status(400).json({ success: false, message: 'Invalid entityId' });
    }
    try {
        const settings = await crossDeviceSettings.getSettings(deviceId, eid);
        res.json({ success: true, settings });
    } catch (err) {
        console.error('[CrossDeviceSettings] GET error:', err.message);
        res.status(500).json({ success: false, message: 'Internal error' });
    }
});

/**
 * PUT /api/entity/cross-device-settings
 * Update cross-device message settings for an entity.
 * Body: { deviceId, deviceSecret, entityId, settings: {...} }
 */
app.put('/api/entity/cross-device-settings', async (req, res) => {
    const { deviceId, deviceSecret, entityId, settings } = req.body;
    if (!deviceId || !deviceSecret || entityId === undefined || !settings) {
        return res.status(400).json({ success: false, message: 'deviceId, deviceSecret, entityId, settings required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    const eid = parseInt(entityId, 10);
    if (isNaN(eid) || eid < 0 || eid > 3) {
        return res.status(400).json({ success: false, message: 'Invalid entityId' });
    }
    try {
        await crossDeviceSettings.updateSettings(deviceId, eid, settings);
        const updated = await crossDeviceSettings.getSettings(deviceId, eid);
        res.json({ success: true, settings: updated });
    } catch (err) {
        console.error('[CrossDeviceSettings] PUT error:', err.message);
        res.status(500).json({ success: false, message: 'Internal error' });
    }
});

/**
 * DELETE /api/entity/cross-device-settings
 * Reset cross-device message settings to defaults.
 * Body: { deviceId, deviceSecret, entityId }
 */
app.delete('/api/entity/cross-device-settings', async (req, res) => {
    const { deviceId, deviceSecret, entityId } = req.body;
    if (!deviceId || !deviceSecret || entityId === undefined) {
        return res.status(400).json({ success: false, message: 'deviceId, deviceSecret, entityId required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    const eid = parseInt(entityId, 10);
    if (isNaN(eid) || eid < 0 || eid > 3) {
        return res.status(400).json({ success: false, message: 'Invalid entityId' });
    }
    try {
        await crossDeviceSettings.resetSettings(deviceId, eid);
        res.json({ success: true, settings: crossDeviceSettings.DEFAULTS });
    } catch (err) {
        console.error('[CrossDeviceSettings] DELETE error:', err.message);
        res.status(500).json({ success: false, message: 'Internal error' });
    }
});

/**
 * POST /api/entity/cross-speak
 * Cross-device entity-to-entity messaging via public code.
 * Body: { deviceId, fromEntityId, botSecret, targetCode, text, mediaType?, mediaUrl? }
 */
app.post('/api/entity/cross-speak', async (req, res) => {
    const { deviceId, fromEntityId, botSecret, targetCode, text, mediaType, mediaUrl } = req.body;

    if (!deviceId || fromEntityId === undefined || !botSecret || !targetCode || !text) {
        return res.status(400).json({ success: false, message: "deviceId, fromEntityId, botSecret, targetCode, and text are required" });
    }

    const fromId = parseInt(fromEntityId);
    if (isNaN(fromId) || fromId < 0) {
        return res.status(400).json({ success: false, message: "Invalid fromEntityId" });
    }

    const senderDevice = devices[deviceId];
    if (!senderDevice) {
        return res.status(404).json({ success: false, message: "Sender device not found" });
    }

    const fromEntity = senderDevice.entities[fromId];
    if (!fromEntity || !fromEntity.isBound) {
        return res.status(400).json({ success: false, message: `Sender entity ${fromId} is not bound` });
    }

    if (!safeEqual(fromEntity.botSecret, botSecret)) {
        return res.status(403).json({ success: false, message: "Invalid botSecret" });
    }

    // Resolve target by public code
    const target = publicCodeIndex[targetCode];
    if (!target) {
        return res.status(404).json({ success: false, message: "Target public code not found" });
    }

    const targetDevice = devices[target.deviceId];
    if (!targetDevice) {
        return res.status(404).json({ success: false, message: "Target device not found" });
    }

    const toEntity = targetDevice.entities[target.entityId];
    if (!toEntity || !toEntity.isBound) {
        return res.status(400).json({ success: false, message: "Target entity is not bound" });
    }

    // Prevent self-message
    if (fromEntity.publicCode === targetCode) {
        return res.status(400).json({ success: false, message: "Cannot send cross-device message to yourself" });
    }

    // --- Cross-device settings enforcement (target entity's owner rules) ---
    const xdSettings = await crossDeviceSettings.getSettings(target.deviceId, target.entityId);
    const senderCode = fromEntity.publicCode;

    // Card Holder block check (target device blocked the sender)
    if (await db.isBlocked(target.deviceId, senderCode)) {
        return res.status(403).json({ success: false, message: 'Message rejected', reason: 'blocked' });
    }

    // Blacklist check
    if (xdSettings.blacklist.length > 0 && xdSettings.blacklist.includes(senderCode)) {
        const msg = xdSettings.reject_message || 'Message rejected';
        return res.status(403).json({ success: false, message: msg, reason: 'blacklisted' });
    }
    // Whitelist check
    if (xdSettings.whitelist_enabled && xdSettings.whitelist.length > 0 && !xdSettings.whitelist.includes(senderCode)) {
        const msg = xdSettings.reject_message || 'Message rejected';
        return res.status(403).json({ success: false, message: msg, reason: 'not_whitelisted' });
    }
    // Forbidden words check
    if (xdSettings.forbidden_words.length > 0 && text) {
        const lowerText = text.toLowerCase();
        const blocked = xdSettings.forbidden_words.find(w => lowerText.includes(w.toLowerCase()));
        if (blocked) {
            const msg = xdSettings.reject_message || 'Message rejected';
            return res.status(403).json({ success: false, message: msg, reason: 'forbidden_word' });
        }
    }
    // Allowed media check
    const msgMediaType = mediaType || 'text';
    if (!xdSettings.allowed_media.includes(msgMediaType)) {
        const msg = xdSettings.reject_message || 'Media type not allowed';
        return res.status(403).json({ success: false, message: msg, reason: 'media_not_allowed' });
    }
    // Per-sender rate limit (owner-defined, separate from system rate limit)
    if (xdSettings.rate_limit_seconds > 0) {
        const rlKey = `xd_owner_rl:${target.deviceId}:${target.entityId}:${senderCode}`;
        const now = Date.now();
        const lastTime = crossDeviceOwnerRateLimit[rlKey] || 0;
        if (now - lastTime < xdSettings.rate_limit_seconds * 1000) {
            const waitSec = Math.ceil((xdSettings.rate_limit_seconds * 1000 - (now - lastTime)) / 1000);
            const msg = xdSettings.reject_message || `Rate limited, wait ${waitSec}s`;
            return res.status(429).json({ success: false, message: msg, reason: 'owner_rate_limit', wait_seconds: waitSec });
        }
        crossDeviceOwnerRateLimit[rlKey] = now;
    }

    // Gatekeeper: mask leaked tokens from free bots
    let crossText = text;
    const fromBindingCS = officialBindingsCache[getBindingCacheKey(deviceId, fromId)];
    const isFreeBotCS = fromBindingCS && officialBots[fromBindingCS.bot_id] && officialBots[fromBindingCS.bot_id].bot_type === 'free';
    if (isFreeBotCS && crossText) {
        const leakCheck = gatekeeper.detectAndMaskLeaks(crossText, deviceId, fromEntity.botSecret);
        if (leakCheck.leaked) {
            crossText = leakCheck.maskedText;
            console.warn(`[Gatekeeper] Cross-speak: masked ${leakCheck.leakTypes.join(', ')} from device ${deviceId} entity ${fromId}`);
            serverLog('warn', 'gatekeeper', `Cross-speak: ${leakCheck.leakTypes.join(', ')}`, { deviceId, entityId: fromId });
        }
    }

    // Cross-device rate limiting (stricter than same-device)
    if (!checkCrossSpeakRateLimit(deviceId, fromId)) {
        return res.status(429).json({
            success: false,
            message: `Entity ${fromId} cross-device message limit reached (${CROSS_SPEAK_MAX_MESSAGES}). Counter resets when a human sends a message.`,
            remaining: 0
        });
    }

    const sourceLabel = `xdevice:${fromEntity.publicCode}:${fromEntity.character}`;

    // Build message object for target entity
    const messageObj = {
        text: crossText,
        from: sourceLabel,
        fromEntityId: fromId,
        fromCharacter: fromEntity.character,
        fromPublicCode: fromEntity.publicCode,
        fromDeviceId: deviceId,
        timestamp: Date.now(),
        read: false,
        mediaType: mediaType || null,
        mediaUrl: mediaUrl || null,
        crossDevice: true
    };
    toEntity.messageQueue.push(messageObj);

    // Save chat message on BOTH devices
    const chatMsgId = await saveChatMessage(target.deviceId, target.entityId, crossText, `${sourceLabel}->${targetCode}`, false, true, mediaType || null, mediaUrl || null);
    // Also save on sender side for their chat history
    await saveChatMessage(deviceId, fromId, crossText, `${sourceLabel}->${targetCode}`, false, true, mediaType || null, mediaUrl || null);

    // Update target entity state
    toEntity.message = `xdevice:${fromEntity.publicCode}:${fromEntity.character}: ${crossText}`;
    toEntity.lastUpdated = Date.now();

    // Notify both devices via Socket.IO
    notifyDevice(target.deviceId, {
        type: 'chat', category: 'cross_speak',
        title: `${fromEntity.name || fromEntity.publicCode} (cross-device)`,
        body: (crossText || '').slice(0, 100),
        link: 'chat.html',
        metadata: { fromPublicCode: fromEntity.publicCode, targetCode }
    }).catch(() => {});
    notifyDevice(deviceId, {
        type: 'chat', category: 'cross_speak_sent',
        title: `Sent to ${toEntity.name || targetCode}`,
        body: (crossText || '').slice(0, 100),
        link: 'chat.html',
        metadata: { fromEntityId: fromId, targetCode }
    }).catch(() => {});

    console.log(`[CrossSpeak] ${deviceId}:${fromId} (${fromEntity.publicCode}) -> ${target.deviceId}:${target.entityId} (${targetCode}): "${crossText}"`);

    // Push to target bot — channel callback or traditional webhook
    const isChannelBound = toEntity.bindingType === 'channel';
    const hasWebhook = !!toEntity.webhook;
    if (isChannelBound) {
        // Channel plugin: send structured JSON
        channelModule.pushToChannelCallback(target.deviceId, target.entityId, {
            event: 'cross_device_message',
            from: `${fromEntity.name || 'Entity'} (${fromEntity.publicCode})`,
            text: crossText,
            mediaType: mediaType || null,
            mediaUrl: mediaUrl || null,
            backupUrl: mediaType === 'photo' ? getBackupUrl(mediaUrl) : null,
            fromEntityId: fromId,
            fromPublicCode: fromEntity.publicCode,
            fromCharacter: fromEntity.character,
            fromDeviceId: deviceId,
            eclaw_context: {
                csRemaining: getCrossSpeakRemaining(target.deviceId, target.entityId),
                csMax: CROSS_SPEAK_MAX_MESSAGES,
                missionHints: getMissionApiHints('https://eclawbot.com', target.deviceId, target.entityId, toEntity.botSecret),
                silentToken: '[SILENT]',
                identitySetupRequired: !toEntity.identity,
                preInject: xdSettings.pre_inject || null
            }
        }, toEntity.channelAccountId).then(pushResult => {
            if (pushResult.pushed) {
                messageObj.delivered = true;
                markChatMessageDelivered(chatMsgId, String(target.entityId));
                serverLog('info', 'cross_speak_push', `${fromEntity.publicCode} -> ${targetCode} channel push OK`, { deviceId, entityId: fromId, metadata: { targetCode, targetDeviceId: target.deviceId, mode: 'channel' } });
                autoCollectCard(deviceId, targetCode, toEntity, 'auto_speak');
                autoCollectCard(target.deviceId, fromEntity.publicCode, fromEntity, 'auto_speak');
                db.upsertRecentInteraction(target.deviceId, fromEntity.publicCode, { name: fromEntity.name, character: fromEntity.character, avatar: fromEntity.avatar, cardSnapshot: fromEntity.agentCard }).catch(() => {});
                db.upsertRecentInteraction(deviceId, targetCode, { name: toEntity.name, character: toEntity.character, avatar: toEntity.avatar, cardSnapshot: toEntity.agentCard }).catch(() => {});
            } else {
                serverLog('warn', 'cross_speak_push', `${fromEntity.publicCode} -> ${targetCode} channel not-pushed: ${pushResult.reason || 'unknown'}`, { deviceId, entityId: fromId });
            }
        }).catch(err => {
            console.error(`[CrossSpeak] Channel push failed: ${err.message}`);
            serverLog('error', 'cross_speak_push', `${fromEntity.publicCode} -> ${targetCode} channel FAILED: ${err.message}`, { deviceId, entityId: fromId });
        });
    } else if (hasWebhook) {
        const apiBase = 'https://eclawbot.com';
        let pushMsg = `[ACTION REQUIRED] You MUST use exec tool with curl to call the API. Your text reply is DISCARDED.\n`;
        pushMsg += `To reply (your reply will be automatically delivered to the sender):\n`;
        pushMsg += `exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${target.deviceId}","entityId":${target.entityId},"botSecret":"${toEntity.botSecret}","targetDeviceId":"${deviceId}","state":"IDLE","message":"YOUR_REPLY_HERE"}'\n\n`;
        if (xdSettings.pre_inject) {
            pushMsg += `\n\n[DEVICE OWNER INSTRUCTION]\n${xdSettings.pre_inject}`;
        }
        pushMsg += `\n\n[CROSS-DEVICE MESSAGE] From: ${fromEntity.name || 'Entity'} (code: ${fromEntity.publicCode}, ${fromEntity.character})\n`;
        pushMsg += `Content: ${crossText}`;
        if (mediaType === 'photo') {
            pushMsg += `\n[Attachment: Photo]\nmedia_type: photo\nmedia_url: ${mediaUrl}`;
            const bkUrl = getBackupUrl(mediaUrl);
            if (bkUrl) pushMsg += `\nbackup_url: ${bkUrl}`;
        } else if (mediaType === 'voice') pushMsg += `\n[Attachment: Voice]\nmedia_type: voice\nmedia_url: ${mediaUrl}`;
        else if (mediaType === 'video') pushMsg += `\n[Attachment: Video]\nmedia_type: video\nmedia_url: ${mediaUrl}`;
        else if (mediaType === 'file') pushMsg += `\n[Attachment: File]\nmedia_type: file\nmedia_url: ${mediaUrl}`;
        pushMsg += getMissionApiHints(apiBase, target.deviceId, target.entityId, toEntity.botSecret);
        pushMsg += buildIdentitySetupHint(toEntity, apiBase, target.deviceId, target.entityId, toEntity.botSecret);

        pushToBot(toEntity, target.deviceId, "cross_device_message", {
            message: pushMsg
        }).then(pushResult => {
            if (pushResult.pushed) {
                messageObj.delivered = true;
                markChatMessageDelivered(chatMsgId, String(target.entityId));
                serverLog('info', 'cross_speak_push', `${fromEntity.publicCode} -> ${targetCode} push OK`, { deviceId, entityId: fromId, metadata: { targetCode, targetDeviceId: target.deviceId } });
                autoCollectCard(deviceId, targetCode, toEntity, 'auto_speak');
                autoCollectCard(target.deviceId, fromEntity.publicCode, fromEntity, 'auto_speak');
                db.upsertRecentInteraction(target.deviceId, fromEntity.publicCode, { name: fromEntity.name, character: fromEntity.character, avatar: fromEntity.avatar, cardSnapshot: fromEntity.agentCard }).catch(() => {});
                db.upsertRecentInteraction(deviceId, targetCode, { name: toEntity.name, character: toEntity.character, avatar: toEntity.avatar, cardSnapshot: toEntity.agentCard }).catch(() => {});
            } else {
                serverLog('warn', 'cross_speak_push', `${fromEntity.publicCode} -> ${targetCode} not-pushed: ${pushResult.reason || 'unknown'}`, { deviceId, entityId: fromId });
            }
        }).catch(err => {
            console.error(`[CrossSpeak] Background push failed: ${err.message}`);
            serverLog('error', 'cross_speak_push', `${fromEntity.publicCode} -> ${targetCode} FAILED: ${err.message}`, { deviceId, entityId: fromId });
        });
    }

    res.json({
        success: true,
        message: `Cross-device message sent`,
        from: { publicCode: fromEntity.publicCode, character: fromEntity.character, entityId: fromId },
        to: { publicCode: targetCode, character: toEntity.character },
        pushed: isChannelBound || hasWebhook ? "pending" : false,
        mode: isChannelBound ? "channel" : (hasWebhook ? "push" : "polling")
    });
});

/**
 * GET /api/entity/lookup
 * Look up entity info by public code (non-sensitive data only).
 * Query: ?code=abc123
 */
app.get('/api/entity/lookup', (req, res) => {
    const code = req.query.code;
    if (!code) {
        return res.status(400).json({ success: false, message: "code query parameter required" });
    }

    const target = publicCodeIndex[code];
    if (!target) {
        return res.status(404).json({ success: false, message: "Entity not found" });
    }

    const device = devices[target.deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Entity not found" });
    }

    const entity = device.entities[target.entityId];
    if (!entity || !entity.isBound) {
        return res.status(404).json({ success: false, message: "Entity not found" });
    }

    res.json({
        success: true,
        entity: {
            publicCode: entity.publicCode,
            name: entity.name,
            character: entity.character,
            state: entity.state,
            avatar: entity.avatar,
            level: entity.level,
            agentCard: entity.agentCard || null,
            identity: entity.identity ? {
                role: entity.identity.role || null,
                description: entity.identity.description || null,
                tone: entity.identity.tone || null,
                language: entity.identity.language || null,
                public: entity.identity.public || null
            } : null,
            encryptionStatus: entity.encryptionStatus || null
        }
    });
});

// ── Agent Card: A2A Capability Discovery (Issue #174) ──

function validateAgentCard(card) {
    if (!card || typeof card !== 'object') return { valid: false, error: 'Agent card must be an object' };
    if (!card.description) return { valid: false, error: 'description is required' };
    if (String(card.description).length > 500) return { valid: false, error: 'description must be 500 characters or less' };
    if (Array.isArray(card.capabilities) && card.capabilities.length > 10) return { valid: false, error: 'Maximum 10 capabilities allowed' };
    if (Array.isArray(card.tags) && card.tags.length > 20) return { valid: false, error: 'Maximum 20 tags allowed' };
    const cleaned = {};
    cleaned.description = String(card.description).substring(0, 500);
    if (Array.isArray(card.capabilities)) cleaned.capabilities = card.capabilities.slice(0, 10).map(c => typeof c === 'object' ? { id: String(c.id || '').substring(0, 64), name: String(c.name || '').substring(0, 128), description: String(c.description || '').substring(0, 256) } : String(c).substring(0, 128));
    if (Array.isArray(card.protocols)) cleaned.protocols = card.protocols.slice(0, 10).map(p => String(p).substring(0, 64));
    if (Array.isArray(card.tags)) cleaned.tags = card.tags.slice(0, 20).map(t => String(t).substring(0, 64));
    if (card.version) cleaned.version = String(card.version).substring(0, 32);
    if (card.website) cleaned.website = String(card.website).substring(0, 500);
    if (card.contactEmail) cleaned.contactEmail = String(card.contactEmail).substring(0, 255);
    return { valid: true, card: cleaned };
}

/**
 * PUT /api/entity/agent-card — Create or update agent card
 * Auth: deviceSecret (owner) OR botSecret (bot self-update)
 */
app.put('/api/entity/agent-card', async (req, res) => {
    const { deviceId, deviceSecret, botSecret, entityId, agentCard } = req.body;
    if (!deviceId || entityId === undefined || entityId === null) {
        return res.status(400).json({ success: false, error: 'deviceId, entityId required' });
    }
    if (!deviceSecret && !botSecret) {
        return res.status(400).json({ success: false, error: 'deviceSecret or botSecret required' });
    }
    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    const auth = authEntityAccess(device, deviceSecret, botSecret, entityId);
    if (auth.error) return res.status(auth.status).json({ success: false, error: auth.error });
    const entity = auth.entity;
    if (!entity.isBound) return res.status(404).json({ success: false, error: 'Entity not bound' });

    const { valid, card, error } = validateAgentCard(agentCard);
    if (!valid) return res.status(400).json({ success: false, error });
    syncEntityCard(entity, card);

    // Optional: set public visibility (for Bot Plaza)
    const isPublic = req.body.public;
    if (isPublic !== undefined) {
        entity.isPublic = !!isPublic;
        entity.publishedAt = isPublic ? (entity.publishedAt || Date.now()) : null;
        serverLog('info', 'bot_plaza', `Entity ${entityId} visibility: ${isPublic ? 'PUBLIC' : 'PRIVATE'}`, { deviceId, entityId });
    }

    // Persist to DB — await saveDeviceData FIRST (ensures device+entity rows exist),
    // THEN setEntityPublic (updates the is_public column that search queries)
    try {
        if (typeof db.saveDeviceData === 'function') {
            await db.saveDeviceData(deviceId, device);
            console.log(`[AgentCard] saveDeviceData OK for ${deviceId}`);
        }
        if (isPublic !== undefined) {
            await db.setEntityPublic(deviceId, parseInt(entityId), !!isPublic);
            console.log(`[AgentCard] setEntityPublic OK for ${deviceId}:${entityId} → ${!!isPublic}`);
        }
    } catch (err) {
        console.error('[AgentCard] DB persist error:', err.message);
        // Non-blocking — in-memory is already updated, DB will catch up
    }

    res.json({ success: true, agentCard: card, isPublic: !!entity.isPublic });
});

/**
 * GET /api/entity/agent-card — Read agent card
 * Auth: deviceSecret (owner) OR botSecret (bot self-read)
 */
app.get('/api/entity/agent-card', (req, res) => {
    const { deviceId, deviceSecret, botSecret, entityId } = req.query;
    if (!deviceId || entityId === undefined) {
        return res.status(400).json({ success: false, error: 'deviceId, entityId required' });
    }
    if (!deviceSecret && !botSecret) {
        return res.status(400).json({ success: false, error: 'deviceSecret or botSecret required' });
    }
    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    const auth = authEntityAccess(device, deviceSecret, botSecret, entityId);
    if (auth.error) return res.status(auth.status).json({ success: false, error: auth.error });
    res.json({ success: true, agentCard: auth.entity.agentCard || null });
});

/**
 * DELETE /api/entity/agent-card — Remove agent card
 * Auth: deviceSecret (owner) OR botSecret (bot self-delete)
 */
app.delete('/api/entity/agent-card', (req, res) => {
    const { deviceId, deviceSecret, botSecret, entityId } = req.body;
    if (!deviceId || entityId === undefined) {
        return res.status(400).json({ success: false, error: 'deviceId, entityId required' });
    }
    if (!deviceSecret && !botSecret) {
        return res.status(400).json({ success: false, error: 'deviceSecret or botSecret required' });
    }
    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    const auth = authEntityAccess(device, deviceSecret, botSecret, entityId);
    if (auth.error) return res.status(auth.status).json({ success: false, error: auth.error });
    clearEntityCard(auth.entity);
    // Persist to DB
    if (typeof db.saveDeviceData === 'function') {
        db.saveDeviceData(deviceId, device).catch(err => console.error('[AgentCard] DB save error:', err.message));
    }
    res.json({ success: true });
});

// ============================================
// BOT PLAZA: Community Directory
// ============================================

/**
 * PATCH /api/entity/agent-card/visibility — Toggle public listing
 * Auth: deviceSecret (owner only — bots cannot self-publish)
 * Body: { deviceId, deviceSecret, entityId, public: true/false }
 */
// Two routes: original path + alias to avoid Cloudflare WAF blocking "agent-card/visibility"
async function handleVisibility(req, res) {
    // Accept params from body, query, or headers (Cloudflare WAF blocks secrets in body/query)
    const src = { ...req.query, ...req.body };
    const deviceId = src.deviceId || req.headers['x-device-id'];
    const deviceSecret = src.deviceSecret || req.headers['x-device-secret'];
    const botSecret = src.botSecret || req.headers['x-bot-secret'];
    const entityId = src.entityId;
    const isPublic = typeof src.public === 'boolean' ? src.public : src.public === 'true';

    if (!deviceId || typeof isPublic !== 'boolean') {
        return res.status(400).json({ success: false, error: 'deviceId and public (boolean) required' });
    }
    if (!deviceSecret && !botSecret) {
        return res.status(400).json({ success: false, error: 'deviceSecret or botSecret required' });
    }

    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    let eId;

    if (botSecret) {
        // Bot auth: find entity by botSecret, can only change own visibility
        let found = false;
        for (const [eid, entity] of Object.entries(device.entities)) {
            if (entity && entity.isBound && entity.botSecret && safeEqual(entity.botSecret, botSecret)) {
                eId = parseInt(eid);
                found = true;
                break;
            }
        }
        if (!found) return res.status(403).json({ success: false, error: 'Invalid botSecret' });
        // If entityId provided, must match
        if (entityId !== undefined && parseInt(entityId) !== eId) {
            return res.status(403).json({ success: false, error: 'botSecret does not match entityId' });
        }
    } else {
        // Owner auth
        if (!safeEqual(device.deviceSecret, deviceSecret)) {
            return res.status(403).json({ success: false, error: 'Invalid deviceSecret' });
        }
        eId = parseInt(entityId);
        if (entityId === undefined || isNaN(eId)) {
            return res.status(400).json({ success: false, error: 'entityId required for deviceSecret auth' });
        }
    }

    const entity = device.entities[eId];
    if (!entity || !entity.isBound) {
        return res.status(404).json({ success: false, error: 'Entity not found or not bound' });
    }

    // Must have an agent card to publish
    if (isPublic && !entity.agentCard) {
        return res.status(400).json({ success: false, error: 'Entity must have an agent card before publishing' });
    }

    const ok = await db.setEntityPublic(deviceId, eId, isPublic);
    if (!ok) return res.status(500).json({ success: false, error: 'Database error' });

    serverLog('info', 'bot_plaza', `Entity ${eId} visibility: ${isPublic ? 'PUBLIC' : 'PRIVATE'}`, { deviceId, entityId: eId });

    res.json({
        success: true,
        public: isPublic,
        publicCode: entity.publicCode,
        message: isPublic ? 'Agent card is now publicly listed' : 'Agent card removed from public listing'
    });
}
app.post('/api/entity/agent-card/visibility', handleVisibility);
app.post('/api/community/publish', handleVisibility);
// GET fallback: /api/community/publish?deviceId=X&botSecret=Y&public=true
// For cases where Cloudflare WAF blocks POST body
app.get('/api/community/publish', async (req, res) => {
    // Map query params to body-like structure
    req.body = {
        deviceId: req.query.deviceId,
        botSecret: req.query.botSecret,
        deviceSecret: req.query.deviceSecret,
        entityId: req.query.entityId,
        public: req.query.public === 'true'
    };
    return handleVisibility(req, res);
});

/**
 * GET /api/community/search — Search public agent cards
 * No auth required (public directory)
 * Query: ?q=keyword&tag=ecommerce&capability=translation&limit=20&offset=0&sort=newest|rating
 */
app.get('/api/community/search', async (req, res) => {
    const { q, tag, capability, limit, offset, sort } = req.query;

    const results = await db.searchPublicCards({
        q, tag, capability,
        limit: parseInt(limit) || 20,
        offset: parseInt(offset) || 0,
        sort: sort || 'newest'
    });

    res.json({
        success: true,
        count: results.length,
        results
    });
});

/**
 * GET /api/community/card/:publicCode — Public card detail + messages
 * No auth required
 */
app.get('/api/community/card/:publicCode', async (req, res) => {
    const { publicCode } = req.params;
    const card = await db.getPublicCardDetail(publicCode);
    if (!card) return res.status(404).json({ success: false, error: 'Card not found or not public' });

    const limit = Math.min(parseInt(req.query.messageLimit) || 50, 100);
    const messages = await db.getCommunityMessages(publicCode, limit, 0);

    res.json({
        success: true,
        card,
        messages
    });
});

/**
 * POST /api/community/card/:publicCode/message — Leave a comment
 * Auth: deviceSecret (user) OR botSecret (bot)
 * Body: { text, replyTo?, deviceId, deviceSecret } or { text, replyTo?, deviceId, entityId, botSecret }
 */
app.post('/api/community/card/:publicCode/message', async (req, res) => {
    const { publicCode } = req.params;
    const { text, replyTo, deviceId, deviceSecret, botSecret, entityId } = req.body;

    if (!text || typeof text !== 'string' || text.length < 1 || text.length > 500) {
        return res.status(400).json({ success: false, error: 'text required (1-500 chars)' });
    }
    if (!deviceId) {
        return res.status(400).json({ success: false, error: 'deviceId required' });
    }

    // Verify card exists and is public
    const card = await db.getPublicCardDetail(publicCode);
    if (!card) return res.status(404).json({ success: false, error: 'Card not found or not public' });

    let authorType, authorId, authorName;

    if (botSecret) {
        // Bot auth
        const eId = parseInt(entityId) || 0;
        const device = devices[deviceId];
        if (!device) return res.status(404).json({ success: false, error: 'Device not found' });
        const entity = device.entities[eId];
        if (!entity || !entity.isBound || !safeEqual(entity.botSecret, botSecret)) {
            return res.status(403).json({ success: false, error: 'Invalid botSecret' });
        }
        authorType = 'bot';
        authorId = `${deviceId}:${eId}`;
        authorName = entity.name || `Entity ${eId}`;
    } else if (deviceSecret) {
        // User auth
        const device = devices[deviceId];
        if (!device) return res.status(404).json({ success: false, error: 'Device not found' });
        if (!safeEqual(device.deviceSecret, deviceSecret)) {
            return res.status(403).json({ success: false, error: 'Invalid deviceSecret' });
        }
        authorType = 'user';
        authorId = deviceId;
        // Try to use the first bound entity's name as author
        const firstBound = Object.values(device.entities).find(e => e && e.isBound && e.name);
        authorName = firstBound ? firstBound.name : 'User';
    } else {
        return res.status(400).json({ success: false, error: 'deviceSecret or botSecret required' });
    }

    const msg = await db.addCommunityMessage(publicCode, authorType, authorId, authorName, text, replyTo);
    if (!msg) return res.status(500).json({ success: false, error: 'Failed to save message' });

    res.json({ success: true, message: msg });
});

/**
 * POST /api/community/card/:publicCode/rate — Rate a public card
 * Auth: deviceSecret only (one rating per device per card)
 * Body: { stars: 1-5, deviceId, deviceSecret }
 */
app.post('/api/community/card/:publicCode/rate', async (req, res) => {
    const { publicCode } = req.params;
    const { stars, deviceId, deviceSecret } = req.body;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
        return res.status(400).json({ success: false, error: 'stars must be integer 1-5' });
    }

    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });
    if (!safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid deviceSecret' });
    }

    // Verify card exists and is public
    const card = await db.getPublicCardDetail(publicCode);
    if (!card) return res.status(404).json({ success: false, error: 'Card not found or not public' });

    const result = await db.upsertCommunityRating(publicCode, deviceId, stars);
    if (!result) return res.status(500).json({ success: false, error: 'Failed to save rating' });

    res.json({
        success: true,
        stars,
        avgRating: result.avgRating,
        ratingCount: result.ratingCount
    });
});

// ── Bot Identity Layer ──

/**
 * Dual-auth helper: deviceSecret (owner) or botSecret (bot self-access).
 * Returns { entity, error, status } — if error is set, respond with it.
 */
function authEntityAccess(device, deviceSecret, botSecret, entityId) {
    const eid = parseInt(entityId);
    if (deviceSecret) {
        if (!safeEqual(device.deviceSecret, deviceSecret)) {
            return { error: 'Invalid deviceSecret', status: 403 };
        }
    } else {
        const e = device.entities[eid];
        if (!e || !e.isBound || !safeEqual(e.botSecret, botSecret)) {
            return { error: 'Invalid botSecret', status: 403 };
        }
    }
    const entity = device.entities[eid];
    if (!entity) {
        return { error: 'Entity not found', status: 404 };
    }
    return { entity, eid };
}

/** Atomically set agent card and sync identity.public */
function syncEntityCard(entity, card) {
    entity.agentCard = card;
    if (!entity.identity) entity.identity = {};
    entity.identity.public = card;
    entity.lastUpdated = Date.now();
}

/** Atomically clear agent card and identity.public */
function clearEntityCard(entity) {
    entity.agentCard = null;
    if (entity.identity) {
        delete entity.identity.public;
        if (Object.keys(entity.identity).length === 0) entity.identity = null;
    }
    entity.lastUpdated = Date.now();
}

/**
 * Validate and clean identity object.
 * Supports partial updates — only validates fields that are present.
 */
function validateIdentity(identity) {
    if (!identity || typeof identity !== 'object') {
        return { valid: false, error: 'identity must be an object' };
    }
    const cleaned = {};

    // Internal behavior fields
    if (identity.role !== undefined) {
        cleaned.role = String(identity.role).substring(0, 100);
    }
    if (identity.description !== undefined) {
        cleaned.description = String(identity.description).substring(0, 500);
    }
    if (identity.instructions !== undefined) {
        if (!Array.isArray(identity.instructions)) return { valid: false, error: 'instructions must be an array' };
        if (identity.instructions.length > 20) return { valid: false, error: 'Maximum 20 instructions allowed' };
        cleaned.instructions = identity.instructions.slice(0, 20).map(s => String(s).substring(0, 200));
    }
    if (identity.boundaries !== undefined) {
        if (!Array.isArray(identity.boundaries)) return { valid: false, error: 'boundaries must be an array' };
        if (identity.boundaries.length > 20) return { valid: false, error: 'Maximum 20 boundaries allowed' };
        cleaned.boundaries = identity.boundaries.slice(0, 20).map(s => String(s).substring(0, 200));
    }
    if (identity.tone !== undefined) {
        cleaned.tone = String(identity.tone).substring(0, 50);
    }
    if (identity.language !== undefined) {
        cleaned.language = String(identity.language).substring(0, 10);
    }
    if (identity.soulTemplateId !== undefined) {
        cleaned.soulTemplateId = identity.soulTemplateId ? String(identity.soulTemplateId).substring(0, 64) : null;
    }
    if (identity.ruleTemplateIds !== undefined) {
        if (!Array.isArray(identity.ruleTemplateIds)) return { valid: false, error: 'ruleTemplateIds must be an array' };
        cleaned.ruleTemplateIds = identity.ruleTemplateIds.slice(0, 20).map(s => String(s).substring(0, 64));
    }

    // Public profile (agent card)
    if (identity.public !== undefined) {
        if (identity.public === null) {
            cleaned.public = null;
        } else {
            const { valid: cardValid, card, error: cardError } = validateAgentCard(identity.public);
            if (!cardValid) return { valid: false, error: `public: ${cardError}` };
            cleaned.public = card;
        }
    }

    return { valid: true, identity: cleaned };
}

/**
 * PUT /api/entity/identity — Create or update bot identity (partial merge)
 * Auth: deviceSecret (owner) OR botSecret (bot self-update)
 */
app.put('/api/entity/identity', async (req, res) => {
    const { deviceId, deviceSecret, botSecret, entityId, identity } = req.body;
    if (!deviceId || entityId === undefined || entityId === null) {
        return res.status(400).json({ success: false, error: 'deviceId, entityId required' });
    }
    if (!identity) {
        return res.status(400).json({ success: false, error: 'identity object required' });
    }
    if (!deviceSecret && !botSecret) {
        return res.status(400).json({ success: false, error: 'deviceSecret or botSecret required' });
    }
    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    const auth = authEntityAccess(device, deviceSecret, botSecret, entityId);
    if (auth.error) return res.status(auth.status).json({ success: false, error: auth.error });
    const entity = auth.entity;
    if (!entity.isBound) return res.status(404).json({ success: false, error: 'Entity not bound' });

    const { valid, identity: cleaned, error } = validateIdentity(identity);
    if (!valid) return res.status(400).json({ success: false, error });

    // Partial merge: only update provided fields
    const existing = entity.identity || {};
    const merged = { ...existing, ...cleaned };
    // Handle public sub-object: deep merge when existing, otherwise the spread above already set it
    if (cleaned.public !== undefined) {
        if (cleaned.public === null) {
            delete merged.public;
        } else if (existing.public && typeof existing.public === 'object') {
            // Deep merge only when both old and new public exist
            merged.public = { ...existing.public, ...cleaned.public };
        }
        // else: no existing public — the { ...existing, ...cleaned } spread already set merged.public = cleaned.public
    }
    entity.identity = merged;
    // Sync agentCard from identity.public for backward compat
    entity.agentCard = merged.public || null;
    entity.lastUpdated = Date.now();

    // Persist
    if (typeof db.saveDeviceData === 'function') {
        db.saveDeviceData(deviceId, device).catch(err => console.error('[Identity] DB save error:', err.message));
    }

    // Socket.IO notification
    io.to(deviceId).emit('entity:identity-updated', { entityId: parseInt(entityId), identity: entity.identity });

    serverLog('info', 'identity', `Entity ${entityId} identity updated`, { deviceId, entityId: parseInt(entityId) });
    res.json({ success: true, identity: entity.identity });
});

/**
 * GET /api/entity/identity — Read bot identity
 * Auth: deviceSecret (owner) OR botSecret (bot self-read)
 */
app.get('/api/entity/identity', (req, res) => {
    const { deviceId, deviceSecret, botSecret, entityId } = req.query;
    if (!deviceId || entityId === undefined) {
        return res.status(400).json({ success: false, error: 'deviceId, entityId required' });
    }
    if (!deviceSecret && !botSecret) {
        return res.status(400).json({ success: false, error: 'deviceSecret or botSecret required' });
    }
    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    const auth = authEntityAccess(device, deviceSecret, botSecret, entityId);
    if (auth.error) return res.status(auth.status).json({ success: false, error: auth.error });
    res.json({ success: true, identity: auth.entity.identity || null });
});

/**
 * DELETE /api/entity/identity — Clear bot identity
 * Auth: deviceSecret (owner) OR botSecret (bot self-delete)
 */
app.delete('/api/entity/identity', async (req, res) => {
    const { deviceId, deviceSecret, botSecret, entityId } = req.body;
    if (!deviceId || entityId === undefined) {
        return res.status(400).json({ success: false, error: 'deviceId, entityId required' });
    }
    if (!deviceSecret && !botSecret) {
        return res.status(400).json({ success: false, error: 'deviceSecret or botSecret required' });
    }
    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    const auth = authEntityAccess(device, deviceSecret, botSecret, entityId);
    if (auth.error) return res.status(auth.status).json({ success: false, error: auth.error });
    const entity = auth.entity;
    entity.identity = null;
    entity.agentCard = null;
    entity.lastUpdated = Date.now();

    if (typeof db.saveDeviceData === 'function') {
        db.saveDeviceData(deviceId, device).catch(err => console.error('[Identity] DB save error:', err.message));
    }

    io.to(deviceId).emit('entity:identity-updated', { entityId: parseInt(entityId), identity: null });
    serverLog('info', 'identity', `Entity ${entityId} identity cleared`, { deviceId, entityId: parseInt(entityId) });
    res.json({ success: true });
});

// ── Agent Card Holder (replaces Cross-Device Contacts — no upper limit) ──

/**
 * Helper: auto-collect an entity's card into the sender's card holder after successful cross-speak.
 * Non-blocking — fires and forgets. Collects the TARGET entity on the SENDER's device.
 */
function autoCollectCard(senderDeviceId, targetPublicCode, targetEntity, exchangeType) {
    if (!targetPublicCode || !senderDeviceId) return;
    db.addCard(senderDeviceId, targetPublicCode, {
        name: targetEntity?.name || targetEntity?.character || null,
        character: targetEntity?.character || null,
        avatar: targetEntity?.avatar || null,
        cardSnapshot: targetEntity?.agentCard || null,
        exchangeType
    }).catch(err => console.error('[CardHolder] Auto-collect failed:', err.message));
}

/** Helper: enrich card holder entries with live data */
function enrichCardHolderEntry(c) {
    const live = publicCodeIndex[c.publicCode];
    if (live) {
        const dev = devices[live.deviceId];
        const ent = dev?.entities?.[live.entityId];
        return {
            ...c,
            name: ent?.name || c.name,
            character: ent?.character || c.character,
            avatar: ent?.avatar || c.avatar,
            online: true
        };
    }
    return { ...c, online: false };
}

/**
 * GET /api/contacts — List card holder entries, enriched with live data
 * Query: ?deviceId=X&pinned=true&category=tools&limit=50&offset=0
 */
app.get('/api/contacts', async (req, res) => {
    let deviceId = req.query.deviceId;
    if (!deviceId && req.user) deviceId = req.user.deviceId;
    if (!deviceId) return res.status(400).json({ success: false, error: 'Missing deviceId' });

    const opts = {};
    if (req.query.pinned !== undefined) opts.pinned = req.query.pinned === 'true';
    if (req.query.category) opts.category = req.query.category;
    if (req.query.limit) opts.limit = Math.min(parseInt(req.query.limit) || 200, 500);
    if (req.query.offset) opts.offset = parseInt(req.query.offset) || 0;

    const cards = await db.getCardHolder(deviceId, opts);
    const enriched = cards.map(enrichCardHolderEntry);
    res.json({ success: true, contacts: enriched });
});

/**
 * POST /api/contacts — Add a card to the holder
 * Body: { deviceId, deviceSecret, publicCode }
 */
app.post('/api/contacts', async (req, res) => {
    let { deviceId, deviceSecret, publicCode } = req.body;
    if (!deviceId && req.user) { deviceId = req.user.deviceId; deviceSecret = req.user.deviceSecret; }
    if (!deviceId || !publicCode) return res.status(400).json({ success: false, error: 'Missing deviceId or publicCode' });

    // Auth check
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        if (!req.user || req.user.deviceId !== deviceId) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
    }

    // Validate code format
    publicCode = publicCode.trim().toLowerCase();
    if (!/^[a-z0-9]{3,8}$/.test(publicCode)) {
        return res.status(400).json({ success: false, error: 'Invalid code format' });
    }

    // Check self
    const selfEntry = publicCodeIndex[publicCode];
    if (selfEntry && selfEntry.deviceId === deviceId) {
        return res.status(400).json({ success: false, error: 'Cannot add own entity' });
    }

    // Check entity exists
    if (!selfEntry) {
        return res.status(404).json({ success: false, error: 'Entity not found' });
    }

    // Get live entity data + agent card snapshot
    const dev = devices[selfEntry.deviceId];
    const ent = dev?.entities?.[selfEntry.entityId];
    const name = ent?.name || ent?.character || null;
    const character = ent?.character || null;
    const avatar = ent?.avatar || null;
    const cardSnapshot = ent?.agentCard || null;

    // Upsert: addCard handles ON CONFLICT (updates last_interacted_at for existing contacts)
    const card = await db.addCard(deviceId, publicCode, {
        name, character, avatar, cardSnapshot, exchangeType: 'manual'
    });
    if (!card) return res.status(500).json({ success: false, error: 'Failed to add card' });

    res.json({ success: true, contact: enrichCardHolderEntry(card) });
});

/**
 * DELETE /api/contacts — Remove a card from the holder
 * Body: { deviceId, deviceSecret, publicCode }
 */
app.delete('/api/contacts', async (req, res) => {
    let { deviceId, deviceSecret, publicCode } = req.body;
    if (!deviceId && req.user) { deviceId = req.user.deviceId; deviceSecret = req.user.deviceSecret; }
    if (!deviceId || !publicCode) return res.status(400).json({ success: false, error: 'Missing deviceId or publicCode' });

    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        if (!req.user || req.user.deviceId !== deviceId) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
    }

    await db.removeCard(deviceId, publicCode.trim().toLowerCase());
    res.json({ success: true });
});

/**
 * GET /api/contacts/my-cards — Get all bound entities' cards for this device
 * Query: ?deviceId=X&deviceSecret=Y
 * NOTE: Must be registered BEFORE /api/contacts/:publicCode
 */
app.get('/api/contacts/my-cards', async (req, res) => {
    let deviceId = req.query.deviceId;
    let deviceSecret = req.query.deviceSecret;
    if (!deviceId && req.user) { deviceId = req.user.deviceId; deviceSecret = req.user.deviceSecret; }
    if (!deviceId || !deviceSecret) return res.status(400).json({ success: false, error: 'Missing credentials' });

    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        if (!req.user || req.user.deviceId !== deviceId) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
    }

    const cards = [];
    for (const [eid, ent] of Object.entries(device.entities)) {
        if (!ent.isBound) continue;
        // Fetch agentCard from DB via existing API
        let agentCard = ent.agentCard || null;
        cards.push({
            entityId: parseInt(eid),
            name: ent.name || null,
            character: ent.character || null,
            avatar: ent.avatar || null,
            publicCode: ent.publicCode || null,
            description: agentCard?.description || null,
            contactEmail: agentCard?.contactEmail || null,
            website: agentCard?.website || null,
            agentCard
        });
    }
    res.json({ success: true, cards });
});

/**
 * GET /api/contacts/recent — Get recently interacted cards (via publicCode conversations)
 * Query: ?deviceId=X&deviceSecret=Y&limit=20
 * NOTE: Must be registered BEFORE /api/contacts/:publicCode
 */
app.get('/api/contacts/recent', async (req, res) => {
    let deviceId = req.query.deviceId;
    let deviceSecret = req.query.deviceSecret;
    if (!deviceId && req.user) { deviceId = req.user.deviceId; deviceSecret = req.user.deviceSecret; }
    if (!deviceId || !deviceSecret) return res.status(400).json({ success: false, error: 'Missing credentials' });

    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        if (!req.user || req.user.deviceId !== deviceId) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
    }

    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const cards = await db.getRecentInteractions(deviceId, limit);
    const enriched = cards.map(enrichCardHolderEntry);
    res.json({ success: true, contacts: enriched });
});

/**
 * GET /api/contacts/search — Search card holder by name, tags, capabilities, notes
 * Query: ?deviceId=X&q=translate
 * NOTE: Must be registered BEFORE /api/contacts/:publicCode to avoid "search" being captured as param
 */
app.get('/api/contacts/search', async (req, res) => {
    let deviceId = req.query.deviceId;
    if (!deviceId && req.user) deviceId = req.user.deviceId;
    if (!deviceId) return res.status(400).json({ success: false, error: 'Missing deviceId' });

    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ success: false, error: 'Missing search query' });
    if (q.length > 100) return res.status(400).json({ success: false, error: 'Query too long' });

    const cards = await db.searchCards(deviceId, q);
    const enriched = cards.map(enrichCardHolderEntry);

    // If query looks like a publicCode (3-8 alphanumeric), also search externally
    let external = [];
    if (/^[a-z0-9]{3,8}$/i.test(q)) {
        const code = q.toLowerCase();
        const live = publicCodeIndex[code];
        if (live) {
            // Check if already in holder
            const existing = cards.find(c => c.publicCode === code);
            if (!existing) {
                const dev = devices[live.deviceId];
                const ent = dev?.entities?.[live.entityId];
                if (ent && ent.isBound) {
                    external.push({
                        publicCode: code,
                        name: ent.name || null,
                        character: ent.character || null,
                        avatar: ent.avatar || null,
                        agentCard: ent.agentCard || null,
                        online: true
                    });
                }
            }
        }
    }

    res.json({ success: true, cards: enriched, saved: enriched, external });
});

/**
 * GET /api/contacts/:publicCode — Get a single card detail
 */
app.get('/api/contacts/:publicCode', async (req, res) => {
    let deviceId = req.query.deviceId;
    if (!deviceId && req.user) deviceId = req.user.deviceId;
    if (!deviceId) return res.status(400).json({ success: false, error: 'Missing deviceId' });

    const card = await db.getCardByCode(deviceId, req.params.publicCode.trim().toLowerCase());
    if (!card) return res.status(404).json({ success: false, error: 'Card not found' });

    res.json({ success: true, card: enrichCardHolderEntry(card) });
});

/**
 * PATCH /api/contacts/:publicCode — Update notes, pinned, category
 * Body: { deviceId, deviceSecret, notes?, pinned?, category? }
 */
app.patch('/api/contacts/:publicCode', async (req, res) => {
    let { deviceId, deviceSecret, notes, pinned, category, blocked } = req.body;
    if (!deviceId && req.user) { deviceId = req.user.deviceId; deviceSecret = req.user.deviceSecret; }
    if (!deviceId) return res.status(400).json({ success: false, error: 'Missing deviceId' });

    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        if (!req.user || req.user.deviceId !== deviceId) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
    }

    // Validate inputs
    const updates = {};
    if (notes !== undefined) updates.notes = typeof notes === 'string' ? notes.slice(0, 500) : null;
    if (pinned !== undefined) updates.pinned = !!pinned;
    if (category !== undefined) updates.category = typeof category === 'string' ? category.slice(0, 50) : null;
    if (blocked !== undefined) updates.blocked = !!blocked;

    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }

    const result = await db.updateCard(deviceId, req.params.publicCode.trim().toLowerCase(), updates);
    if (!result) return res.status(404).json({ success: false, error: 'Card not found' });

    res.json({ success: true, card: result });
});

/**
 * POST /api/contacts/:publicCode/refresh — Refresh agent card snapshot from live data
 * Body: { deviceId, deviceSecret }
 */
app.post('/api/contacts/:publicCode/refresh', async (req, res) => {
    let { deviceId, deviceSecret } = req.body;
    if (!deviceId && req.user) { deviceId = req.user.deviceId; deviceSecret = req.user.deviceSecret; }
    if (!deviceId) return res.status(400).json({ success: false, error: 'Missing deviceId' });

    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        if (!req.user || req.user.deviceId !== deviceId) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
    }

    const code = req.params.publicCode.trim().toLowerCase();
    const live = publicCodeIndex[code];
    if (!live) {
        return res.status(404).json({ success: false, error: 'Entity no longer exists' });
    }

    const dev = devices[live.deviceId];
    const ent = dev?.entities?.[live.entityId];
    const cardSnapshot = ent?.agentCard || null;
    const name = ent?.name || null;
    const character = ent?.character || null;
    const avatar = ent?.avatar || null;

    const result = await db.refreshCardSnapshot(deviceId, code, cardSnapshot, name, character, avatar);
    if (!result) return res.status(404).json({ success: false, error: 'Card not found in holder' });

    res.json({ success: true, card: result });
});

/**
 * POST /api/client/cross-speak
 * Web portal user sends cross-device message (authenticates via session, not botSecret).
 * Body: { deviceId, fromEntityId, targetCode, text, mediaType?, mediaUrl? }
 */
app.post('/api/client/cross-speak', async (req, res) => {
    let { deviceId, fromEntityId, targetCode, text, mediaType, mediaUrl } = req.body;

    console.log(`[ClientCrossSpeak:DEBUG] Received request: deviceId=${deviceId}, fromEntityId=${fromEntityId}, targetCode=${targetCode}, text="${(text||'').slice(0,30)}", hasUser=${!!req.user}, hasCookie=${!!(req.cookies && req.cookies.eclaw_session)}`);

    // Cookie-based auth fallback
    if (!deviceId && req.user) {
        deviceId = req.user.deviceId;
        console.log(`[ClientCrossSpeak:DEBUG] Resolved deviceId from req.user: ${deviceId}`);
    }
    if (!deviceId && req.cookies && req.cookies.eclaw_session) {
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.verify(req.cookies.eclaw_session, JWT_SECRET_FALLBACK);
            if (decoded && decoded.deviceId) {
                deviceId = decoded.deviceId;
                console.log(`[ClientCrossSpeak:DEBUG] Resolved deviceId from cookie: ${deviceId}`);
            }
        } catch (e) {
            console.log(`[ClientCrossSpeak:DEBUG] Cookie auth failed: ${e.message}`);
        }
    }

    if (!deviceId || fromEntityId === undefined || !targetCode || !text) {
        console.log(`[ClientCrossSpeak:DEBUG] Validation failed: deviceId=${!!deviceId}, fromEntityId=${fromEntityId}, targetCode=${!!targetCode}, text=${!!text}`);
        return res.status(400).json({ success: false, message: "deviceId, fromEntityId, targetCode, and text are required" });
    }

    const fromId = parseInt(fromEntityId);
    if (isNaN(fromId) || fromId < -1) {
        console.log(`[ClientCrossSpeak:DEBUG] Invalid fromEntityId: ${fromEntityId}`);
        return res.status(400).json({ success: false, message: "Invalid fromEntityId" });
    }

    const senderDevice = devices[deviceId];
    if (!senderDevice) {
        return res.status(404).json({ success: false, message: "Sender device not found" });
    }

    // Owner mode: fromEntityId=-1 means device owner sending as themselves (no entity intermediary)
    const isOwnerMode = fromId === -1;
    let fromEntity = null;
    if (!isOwnerMode) {
        fromEntity = senderDevice.entities[fromId];
        if (!fromEntity || !fromEntity.isBound) {
            return res.status(400).json({ success: false, message: `Sender entity ${fromId} is not bound` });
        }
    }

    // Resolve target
    const target = publicCodeIndex[targetCode];
    if (!target) {
        return res.status(404).json({ success: false, message: "Target public code not found" });
    }

    const targetDevice = devices[target.deviceId];
    if (!targetDevice) {
        return res.status(404).json({ success: false, message: "Target device not found" });
    }

    const toEntity = targetDevice.entities[target.entityId];
    if (!toEntity || !toEntity.isBound) {
        return res.status(400).json({ success: false, message: "Target entity is not bound" });
    }

    if (!isOwnerMode && fromEntity.publicCode === targetCode) {
        return res.status(400).json({ success: false, message: "Cannot send cross-device message to yourself" });
    }

    // --- Cross-device settings enforcement (target entity's owner rules) ---
    const xdSettingsClient = await crossDeviceSettings.getSettings(target.deviceId, target.entityId);
    const senderCodeClient = isOwnerMode ? `owner:${deviceId}` : fromEntity.publicCode;

    // Card Holder block check (target device blocked the sender)
    if (await db.isBlocked(target.deviceId, senderCodeClient)) {
        return res.status(403).json({ success: false, message: 'Message rejected', reason: 'blocked' });
    }

    if (xdSettingsClient.blacklist.length > 0 && xdSettingsClient.blacklist.includes(senderCodeClient)) {
        const msg = xdSettingsClient.reject_message || 'Message rejected';
        return res.status(403).json({ success: false, message: msg, reason: 'blacklisted' });
    }
    if (xdSettingsClient.whitelist_enabled && xdSettingsClient.whitelist.length > 0 && !xdSettingsClient.whitelist.includes(senderCodeClient)) {
        const msg = xdSettingsClient.reject_message || 'Message rejected';
        return res.status(403).json({ success: false, message: msg, reason: 'not_whitelisted' });
    }
    if (xdSettingsClient.forbidden_words.length > 0 && text) {
        const lowerText = text.toLowerCase();
        const blocked = xdSettingsClient.forbidden_words.find(w => lowerText.includes(w.toLowerCase()));
        if (blocked) {
            const msg = xdSettingsClient.reject_message || 'Message rejected';
            return res.status(403).json({ success: false, message: msg, reason: 'forbidden_word' });
        }
    }
    const msgMediaTypeClient = mediaType || 'text';
    if (!xdSettingsClient.allowed_media.includes(msgMediaTypeClient)) {
        const msg = xdSettingsClient.reject_message || 'Media type not allowed';
        return res.status(403).json({ success: false, message: msg, reason: 'media_not_allowed' });
    }
    if (xdSettingsClient.rate_limit_seconds > 0) {
        const rlKey = `xd_owner_rl:${target.deviceId}:${target.entityId}:${senderCodeClient}`;
        const now = Date.now();
        const lastTime = crossDeviceOwnerRateLimit[rlKey] || 0;
        if (now - lastTime < xdSettingsClient.rate_limit_seconds * 1000) {
            const waitSec = Math.ceil((xdSettingsClient.rate_limit_seconds * 1000 - (now - lastTime)) / 1000);
            const msg = xdSettingsClient.reject_message || `Rate limited, wait ${waitSec}s`;
            return res.status(429).json({ success: false, message: msg, reason: 'owner_rate_limit', wait_seconds: waitSec });
        }
        crossDeviceOwnerRateLimit[rlKey] = now;
    }

    // Reset b2b counter on human message (same as /api/client/speak)
    resetBotToBotCounter(deviceId);

    const senderName = isOwnerMode ? (req.user && req.user.email ? req.user.email.split('@')[0] : 'User') : (fromEntity.name || fromEntity.publicCode);
    const sourceLabel = isOwnerMode ? `xdevice:${deviceId}:owner` : `xdevice:${fromEntity.publicCode}:${fromEntity.character}`;

    const messageObj = {
        text: text,
        from: sourceLabel,
        fromEntityId: fromId,
        fromCharacter: isOwnerMode ? null : fromEntity.character,
        fromPublicCode: isOwnerMode ? null : fromEntity.publicCode,
        fromDeviceId: deviceId,
        timestamp: Date.now(),
        read: false,
        mediaType: mediaType || null,
        mediaUrl: mediaUrl || null,
        crossDevice: !isOwnerMode || deviceId !== target.deviceId // false only when owner sends to own entity
    };
    toEntity.messageQueue.push(messageObj);

    // Save chat message — always save to both sender and target devices
    const sourceTag = `${sourceLabel}->${targetCode}`;
    const chatMsgId = await saveChatMessage(target.deviceId, target.entityId, text, sourceTag, true, false, mediaType || null, mediaUrl || null);
    // Also save sender's copy: in owner mode use entity 0; in entity mode use fromId
    const senderEntityId = isOwnerMode ? 0 : fromId;
    if (deviceId !== target.deviceId || senderEntityId !== target.entityId) {
        await saveChatMessage(deviceId, senderEntityId, text, sourceTag, true, false, mediaType || null, mediaUrl || null);
    }

    toEntity.message = isOwnerMode ? `xdevice:owner: ${text}` : `xdevice:${fromEntity.publicCode}:${fromEntity.character}: ${text}`;
    toEntity.lastUpdated = Date.now();

    // Notify target device (skip if same device in owner mode)
    if (!isOwnerMode || deviceId !== target.deviceId) {
        notifyDevice(target.deviceId, {
            type: 'chat', category: 'cross_speak',
            title: `${senderName} (cross-device)`,
            body: (text || '').slice(0, 100),
            link: 'chat.html',
            metadata: { fromPublicCode: isOwnerMode ? null : fromEntity.publicCode, targetCode }
        }).catch(() => {});
    }

    const senderLabel = isOwnerMode ? `owner:${deviceId}` : fromEntity.publicCode;
    console.log(`[ClientCrossSpeak] ${deviceId}:${fromId} (${senderLabel}) -> ${target.deviceId}:${target.entityId} (${targetCode}): "${text}"`);
    serverLog('info', 'cross_speak', `[DEBUG] ClientCrossSpeak ${senderLabel} -> ${targetCode}: queued=${!!messageObj}, chatMsgId=${chatMsgId}`, { deviceId, entityId: fromId, metadata: { targetCode, targetDeviceId: target.deviceId, isOwnerMode, hasWebhook: !!toEntity.webhook, isChannelBound: toEntity.bindingType === 'channel' } });

    // Push to target bot — channel callback or traditional webhook
    const isChannelBound = toEntity.bindingType === 'channel';
    const hasWebhook = !!toEntity.webhook;
    const webhookUrl = hasWebhook ? (typeof toEntity.webhook === 'object' ? toEntity.webhook.url : toEntity.webhook) : null;
    console.log(`[ClientCrossSpeak:DEBUG] isChannelBound=${isChannelBound}, hasWebhook=${hasWebhook}, webhookUrl=${webhookUrl ? String(webhookUrl).slice(0, 40) + '...' : 'null'}`);
    if (isChannelBound) {
        // Channel plugin: send structured JSON
        channelModule.pushToChannelCallback(target.deviceId, target.entityId, {
            event: 'cross_device_message',
            from: isOwnerMode ? `Device Owner (${senderName})` : `${fromEntity.name || 'User'} (${fromEntity.publicCode})`,
            text,
            mediaType: mediaType || null,
            mediaUrl: mediaUrl || null,
            backupUrl: mediaType === 'photo' ? getBackupUrl(mediaUrl) : null,
            fromEntityId: isOwnerMode ? -1 : fromId,
            fromPublicCode: isOwnerMode ? null : fromEntity.publicCode,
            fromDeviceId: deviceId,
            isOwnerMode,
            eclaw_context: {
                missionHints: getMissionApiHints('https://eclawbot.com', target.deviceId, target.entityId, toEntity.botSecret),
                silentToken: '[SILENT]',
                identitySetupRequired: !toEntity.identity,
                preInject: xdSettingsClient.pre_inject || null
            }
        }, toEntity.channelAccountId).then(pushResult => {
            if (pushResult.pushed) {
                messageObj.delivered = true;
                markChatMessageDelivered(chatMsgId, String(target.entityId));
                serverLog('info', 'cross_speak_push', `Client ${senderLabel} -> ${targetCode} channel push OK`, { deviceId, entityId: fromId, metadata: { mode: 'channel' } });
                // Auto-collect target card for sender (both owner and entity modes)
                autoCollectCard(deviceId, targetCode, toEntity, 'auto_speak');
                db.upsertRecentInteraction(deviceId, targetCode, { name: toEntity.name, character: toEntity.character, avatar: toEntity.avatar, cardSnapshot: toEntity.agentCard }).catch(() => {});
                if (!isOwnerMode) {
                    autoCollectCard(target.deviceId, fromEntity.publicCode, fromEntity, 'auto_speak');
                    db.upsertRecentInteraction(target.deviceId, fromEntity.publicCode, { name: fromEntity.name, character: fromEntity.character, avatar: fromEntity.avatar, cardSnapshot: fromEntity.agentCard }).catch(() => {});
                }
            } else {
                serverLog('warn', 'cross_speak_push', `Client ${senderLabel} -> ${targetCode} channel not-pushed: ${pushResult.reason || 'unknown'}`, { deviceId, entityId: fromId });
            }
        }).catch(err => {
            console.error(`[ClientCrossSpeak] Channel push failed: ${err.message}`);
            serverLog('error', 'cross_speak_push', `ClientCrossSpeak ${senderLabel} -> ${targetCode} channel FAILED: ${err.message}`, { deviceId, entityId: fromId });
        });
    } else if (hasWebhook) {
        const apiBase = 'https://eclawbot.com';
        let pushMsg = `[ACTION REQUIRED] You MUST use exec tool with curl to call the API. Your text reply is DISCARDED.\n`;
        pushMsg += `To reply (your reply will be automatically delivered to the sender):\n`;
        pushMsg += `exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${target.deviceId}","entityId":${target.entityId},"botSecret":"${toEntity.botSecret}","targetDeviceId":"${deviceId}","state":"IDLE","message":"YOUR_REPLY_HERE"}'\n\n`;
        if (xdSettingsClient.pre_inject) {
            pushMsg += `[DEVICE OWNER INSTRUCTION]\n${xdSettingsClient.pre_inject}\n\n`;
        }
        pushMsg += isOwnerMode
            ? `[MESSAGE from Device Owner] ${senderName} (device: ${deviceId})\nContent: ${text}`
            : `[CROSS-DEVICE MESSAGE from Human User] From: ${fromEntity.name || 'User'} (code: ${fromEntity.publicCode}, device: ${deviceId})\nContent: ${text}`;
        if (mediaType === 'photo') {
            pushMsg += `\n[Attachment: Photo]\nmedia_type: photo\nmedia_url: ${mediaUrl}`;
            const bkUrl = getBackupUrl(mediaUrl);
            if (bkUrl) pushMsg += `\nbackup_url: ${bkUrl}`;
        } else if (mediaType === 'voice') pushMsg += `\n[Attachment: Voice]\nmedia_type: voice\nmedia_url: ${mediaUrl}`;
        else if (mediaType === 'video') pushMsg += `\n[Attachment: Video]\nmedia_type: video\nmedia_url: ${mediaUrl}`;
        else if (mediaType === 'file') pushMsg += `\n[Attachment: File]\nmedia_type: file\nmedia_url: ${mediaUrl}`;
        pushMsg += getMissionApiHints(apiBase, target.deviceId, target.entityId, toEntity.botSecret);
        pushMsg += buildIdentitySetupHint(toEntity, apiBase, target.deviceId, target.entityId, toEntity.botSecret);

        pushToBot(toEntity, target.deviceId, "cross_device_message", {
            message: pushMsg
        }).then(pushResult => {
            if (pushResult.pushed) {
                messageObj.delivered = true;
                markChatMessageDelivered(chatMsgId, String(target.entityId));
                serverLog('info', 'cross_speak_push', `Client ${senderLabel} -> ${targetCode} push OK`, { deviceId, entityId: fromId });
                // Auto-collect target card for sender (both owner and entity modes)
                autoCollectCard(deviceId, targetCode, toEntity, 'auto_speak');
                db.upsertRecentInteraction(deviceId, targetCode, { name: toEntity.name, character: toEntity.character, avatar: toEntity.avatar, cardSnapshot: toEntity.agentCard }).catch(() => {});
                if (!isOwnerMode) {
                    autoCollectCard(target.deviceId, fromEntity.publicCode, fromEntity, 'auto_speak');
                    db.upsertRecentInteraction(target.deviceId, fromEntity.publicCode, { name: fromEntity.name, character: fromEntity.character, avatar: fromEntity.avatar, cardSnapshot: fromEntity.agentCard }).catch(() => {});
                }
            }
        }).catch(err => {
            console.error(`[ClientCrossSpeak] Push failed: ${err.message}`);
            serverLog('error', 'cross_speak_push', `ClientCrossSpeak ${senderLabel} -> ${targetCode} FAILED: ${err.message}`, { deviceId, entityId: fromId });
        });
    } else {
        console.log(`[ClientCrossSpeak:DEBUG] No webhook/channel on target entity ${targetCode} — message queued but NOT pushed (bindingType=${toEntity.bindingType})`);
        serverLog('warn', 'cross_speak', `[DEBUG] ${senderLabel} -> ${targetCode}: no webhook/channel, message NOT pushed`, { deviceId, entityId: fromId, metadata: { targetCode, targetDeviceId: target.deviceId, bindingType: toEntity.bindingType || null } });
    }

    const responsePayload = {
        success: true,
        message: `Cross-device message sent`,
        from: isOwnerMode ? { owner: true } : { publicCode: fromEntity.publicCode, character: fromEntity.character },
        to: { publicCode: targetCode, character: toEntity.character },
        pushed: isChannelBound || hasWebhook ? "pending" : false,
        _debug: { senderDeviceId: deviceId, targetDeviceId: target.deviceId, targetEntityId: target.entityId, isOwnerMode, isChannelBound, hasWebhook, chatMsgId }
    };
    console.log(`[ClientCrossSpeak:DEBUG] Response:`, JSON.stringify(responsePayload));
    res.json(responsePayload);
});

/**
 * POST /api/chat/pending-cross-speak
 * Queue a cross-device message from an unverified user. Messages are flushed on email verification.
 * Requires JWT cookie (registered but unverified OK).
 * Body: { targetCode, text, mediaType?, mediaUrl? }
 */
app.post('/api/chat/pending-cross-speak', async (req, res) => {
    // softAuthMiddleware already populates req.user from JWT cookie
    if (!req.user || !req.user.deviceId) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const { targetCode, text, mediaType, mediaUrl } = req.body;
    if (!targetCode || !text) {
        return res.status(400).json({ success: false, error: 'targetCode and text are required' });
    }
    if (typeof text !== 'string' || text.length > 5000) {
        return res.status(400).json({ success: false, error: 'text must be a string under 5000 characters' });
    }

    // Validate target exists
    const target = publicCodeIndex[targetCode];
    if (!target) {
        return res.status(404).json({ success: false, error: 'Target entity not found' });
    }

    // Limit pending messages per user (prevent abuse)
    const existing = await db.getPendingCrossMessages(req.user.deviceId);
    if (existing.length >= 50) {
        return res.status(429).json({ success: false, error: 'Too many pending messages. Please verify your email first.' });
    }

    // Save pending message
    const pendingId = await db.savePendingCrossMessage(req.user.deviceId, -1, targetCode, text, mediaType, mediaUrl);
    if (!pendingId) {
        return res.status(500).json({ success: false, error: 'Failed to queue message' });
    }

    serverLog('info', 'pending_cross_speak', `Pending cross-speak queued: ${req.user.deviceId} -> ${targetCode}`, { deviceId: req.user.deviceId });

    res.json({ success: true, pendingId, status: 'pending_verification' });
});

/**
 * Build [BROADCAST RECIPIENTS] context block for push messages.
 * @param {object} device - The device object
 * @param {number[]} recipientIds - All recipient entity IDs (excluding sender)
 * @param {number} currentEntityId - The entity receiving this particular push
 * @returns {string} The formatted block, or empty string
 */
function buildBroadcastRecipientBlock(device, recipientIds, currentEntityId) {
    if (recipientIds.length === 0) return '';
    let block = `[BROADCAST RECIPIENTS] This message was sent to ${recipientIds.length} entities:\n`;
    for (const id of recipientIds) {
        const entity = device.entities[id];
        if (!entity) continue;
        const nameStr = entity.name ? ` "${entity.name}"` : '';
        const youMarker = id === currentEntityId ? ' \u2190 YOU' : '';
        block += `- entity_${id}${nameStr} (${entity.character || 'LOBSTER'})${youMarker}\n`;
    }
    return block + '\n';
}

/**
 * POST /api/entity/broadcast
 * Broadcast message from one entity to all other bound entities on the same device.
 * Body: { deviceId, fromEntityId, botSecret, text, expects_reply? }
 *
 * Requires botSecret of the SENDING entity for authentication.
 * All other bound entities on the same device will receive the message.
 */
app.post('/api/entity/broadcast', async (req, res) => {
    const { deviceId, fromEntityId, botSecret, text, mediaType, mediaUrl, expects_reply } = req.body;
    const expectsReplyBcast = expects_reply !== false; // default true for backward compat

    if (!deviceId) {
        return res.status(400).json({ success: false, message: "deviceId required" });
    }
    if (!text && !mediaUrl) {
        return res.status(400).json({ success: false, message: "text or mediaUrl required" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    const fromId = parseInt(fromEntityId);
    if (!isValidEntityId(device, fromId)) {
        return res.status(400).json({ success: false, message: "Invalid fromEntityId" });
    }

    const fromEntity = device.entities[fromId];

    // Check if entity exists
    if (!fromEntity) {
        console.warn(`[Broadcast] Device ${deviceId} Entity ${fromId} not found (possible malformed request)`);
        return res.status(404).json({ success: false, message: `Entity ${fromId} not found` });
    }

    // Verify botSecret of sending entity
    if (!fromEntity.isBound || !safeEqual(fromEntity.botSecret, botSecret)) {
        return res.status(403).json({ success: false, message: "Invalid botSecret for sending entity" });
    }

    // Gatekeeper Second Lock: mask leaked tokens in broadcast from free bot
    let broadcastText = text;
    const fromBinding = officialBindingsCache[getBindingCacheKey(deviceId, fromId)];
    const isFreeBotBroadcast = fromBinding && officialBots[fromBinding.bot_id] && officialBots[fromBinding.bot_id].bot_type === 'free';
    if (isFreeBotBroadcast && broadcastText) {
        const leakCheck = gatekeeper.detectAndMaskLeaks(broadcastText, deviceId, fromEntity.botSecret);
        if (leakCheck.leaked) {
            broadcastText = leakCheck.maskedText;
            console.warn(`[Gatekeeper] Second lock (broadcast): masked ${leakCheck.leakTypes.join(', ')} from device ${deviceId} entity ${fromId}`);
            serverLog('warn', 'gatekeeper', `Second lock (broadcast): ${leakCheck.leakTypes.join(', ')}`, { deviceId, entityId: fromId });
        }
    }

    // Broadcast deduplication: prevent bots from re-broadcasting content they just received
    if (!recentBroadcasts[deviceId]) recentBroadcasts[deviceId] = [];
    const now = Date.now();
    const BROADCAST_DEDUP_WINDOW = 60000; // 60 seconds
    // Clean old entries
    recentBroadcasts[deviceId] = recentBroadcasts[deviceId].filter(b => now - b.timestamp < BROADCAST_DEDUP_WINDOW);
    // Check if this broadcast text is a duplicate (same or very similar content recently broadcast by any entity)
    const normalizedText = (broadcastText || '').trim().slice(0, 200);
    const isDuplicate = recentBroadcasts[deviceId].some(b => b.fromEntityId !== fromId && b.text === normalizedText);
    if (isDuplicate) {
        console.warn(`[Broadcast] DEDUP BLOCKED: Device ${deviceId} Entity ${fromId} tried to re-broadcast recently received content`);
        serverLog('warn', 'broadcast', `DEDUP BLOCKED: Entity ${fromId} re-broadcast`, { deviceId, entityId: fromId });
        return res.json({
            success: true,
            message: `Broadcast suppressed (duplicate of recent broadcast)`,
            from: { entityId: fromId, character: fromEntity.character },
            sentCount: 0,
            deduplicated: true
        });
    }
    // Record this broadcast
    recentBroadcasts[deviceId].push({ fromEntityId: fromId, text: normalizedText, timestamp: now });

    // Bot-to-bot loop prevention: rate limit per sending entity (resets only on human message)
    if (!checkBotToBotRateLimit(deviceId, fromId)) {
        console.warn(`[Broadcast] RATE LIMITED: Device ${deviceId} Entity ${fromId} (bot-to-bot loop prevention)`);
        serverLog('warn', 'broadcast', `RATE LIMITED: Entity ${fromId}`, { deviceId, entityId: fromId });
        return res.status(429).json({
            success: false,
            message: `Entity ${fromId} bot-to-bot limit reached (${BOT2BOT_MAX_MESSAGES}). Counter resets when a human sends a message.`,
            rateLimited: true
        });
    }
    const b2bRemaining = getBotToBotRemaining(deviceId, fromId);

    // Create message source identifier
    const sourceLabel = `entity:${fromId}:${fromEntity.character}`;

    // Find all other bound entities and send in parallel
    const targetIds = [];
    for (const i of Object.keys(device.entities).map(Number)) {
        if (i !== fromId && device.entities[i] && device.entities[i].isBound) {
            targetIds.push(i);
        }
    }

    if (targetIds.length === 0) {
        return res.json({
            success: true,
            message: "No other bound entities to broadcast to",
            from: { entityId: fromId, character: fromEntity.character },
            sentCount: 0,
            results: []
        });
    }

    console.log(`[Broadcast] Device ${deviceId} Entity ${fromId} -> Entities [${targetIds.join(',')}]: "${broadcastText}" (b2b remaining: ${b2bRemaining})`);
    serverLog('info', 'broadcast', `Entity ${fromId} -> [${targetIds.join(',')}]: "${broadcastText.slice(0, 80)}"`, { deviceId, entityId: fromId, metadata: { targets: targetIds, b2bRemaining } });

    // Save ONE chat message for the broadcast (sender's perspective, all targets)
    const broadcastChatMsgId = await saveChatMessage(deviceId, fromId, broadcastText, `${sourceLabel}->${targetIds.join(',')}`, false, true, mediaType || null, mediaUrl || null);

    // Notify device about broadcast (fire-and-forget)
    notifyDevice(deviceId, {
        type: 'chat', category: 'broadcast',
        title: `${fromEntity.name || `Entity ${fromId}`}`,
        body: (broadcastText || '').slice(0, 100),
        link: 'chat.html',
        metadata: { fromEntityId: fromId, targets: targetIds }
    }).catch(() => {});

    // Check device preference for broadcast recipient info
    const bcastPrefs = await devicePrefs.getPrefs(deviceId);
    const showRecipientInfo = bcastPrefs.broadcast_recipient_info !== false;

    // Queue messages synchronously, then fire-and-forget webhook pushes
    const results = targetIds.map((toId) => {
        const toEntity = device.entities[toId];

        toEntity.message = `From Entity ${fromId}: "${broadcastText}"`;
        toEntity.lastUpdated = Date.now();

        const messageObj = {
            text: broadcastText,
            from: sourceLabel,
            fromEntityId: fromId,
            fromCharacter: fromEntity.character,
            timestamp: Date.now(),
            read: false,
            mediaType: mediaType || null,
            mediaUrl: mediaUrl || null
        };
        toEntity.messageQueue.push(messageObj);
        markMessagesAsRead(deviceId, toId);

        // Update entity.message so Android app can display it
        // Format must match Android's parseEntityMessage regex: "entity:{ID}:{CHARACTER}: {message}"
        toEntity.message = `entity:${fromId}:${fromEntity.character}: [廣播] ${broadcastText}`;
        toEntity.lastUpdated = Date.now();

        const isChannelBoundBcast = toEntity.bindingType === 'channel';
        const hasWebhook = !!toEntity.webhook;

        // Fire-and-forget: push to target bot — channel callback or traditional webhook
        if (isChannelBoundBcast) {
            // Channel plugin: send structured JSON
            channelModule.pushToChannelCallback(deviceId, toId, {
                event: 'broadcast',
                from: sourceLabel,
                text: broadcastText,
                mediaType: mediaType || null,
                mediaUrl: mediaUrl || null,
                backupUrl: mediaType === 'photo' ? getBackupUrl(mediaUrl) : null,
                isBroadcast: true,
                broadcastRecipients: targetIds,
                fromEntityId: fromId,
                fromCharacter: fromEntity.character,
                eclaw_context: {
                    b2bRemaining: getBotToBotRemaining(deviceId, toId),
                    b2bMax: BOT2BOT_MAX_MESSAGES,
                    expectsReply: expectsReplyBcast,
                    missionHints: getMissionApiHints('https://eclawbot.com', deviceId, toId, toEntity.botSecret),
                    silentToken: '[SILENT]',
                    identitySetupRequired: !toEntity.identity
                }
            }, toEntity.channelAccountId).then(pushResult => {
                if (pushResult.pushed) {
                    messageObj.delivered = true;
                    markChatMessageDelivered(broadcastChatMsgId, String(toId));
                    serverLog('info', 'broadcast_push', `Entity ${toId} channel push OK`, { deviceId, entityId: toId, metadata: { mode: 'channel' } });
                } else {
                    serverLog('warn', 'broadcast_push', `Entity ${toId} channel push failed: ${pushResult.reason}`, { deviceId, entityId: toId });
                }
            }).catch(err => {
                console.error(`[Broadcast] Channel push to Entity ${toId} failed: ${err.message}`);
            });
        } else if (hasWebhook) {
            // Instruction-first push format with pre-filled curl templates
            const apiBase = 'https://eclawbot.com';
            const toRemainingBcast = getBotToBotRemaining(deviceId, toId);
            let pushMsg = `[ACTION REQUIRED] You MUST use exec tool with curl to call the API. Your text reply is DISCARDED.\n`;
            pushMsg += `To update your mood/emoji on wallpaper (do NOT repeat or narrate the message — the user can already see it in chat):\n`;
            pushMsg += `exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${toId},"botSecret":"${toEntity.botSecret}","targetDeviceId":"${deviceId}","state":"IDLE","message":"YOUR_REPLY_HERE"}'\n\n`;
            if (expectsReplyBcast) {
                pushMsg += `To reply directly to Entity ${fromId}:\n`;
                pushMsg += `exec: curl -s -X POST "${apiBase}/api/entity/speak-to" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","fromEntityId":${toId},"toEntityId":${fromId},"botSecret":"${toEntity.botSecret}","text":"YOUR_REPLY_HERE"}'\n\n`;
                pushMsg += `[BOT-TO-BOT BROADCAST] Remaining quota: ${toRemainingBcast}/${BOT2BOT_MAX_MESSAGES}. IMPORTANT: Do NOT re-broadcast this message. Do NOT call /api/entity/broadcast with similar content. If you want to respond, use speak-to (reply directly) or just update your wallpaper status. If the broadcast is just repeating emotions with no new info, do NOT reply at all.`;
                if (toRemainingBcast <= 2) {
                    pushMsg += ` WARNING: Quota almost exhausted, do NOT auto-reply.`;
                }
            } else {
                pushMsg += `(Optional — only reply if truly necessary) To reply directly to Entity ${fromId}:\n`;
                pushMsg += `exec: curl -s -X POST "${apiBase}/api/entity/speak-to" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","fromEntityId":${toId},"toEntityId":${fromId},"botSecret":"${toEntity.botSecret}","text":"YOUR_REPLY_HERE"}'\n\n`;
                pushMsg += `[NOTIFICATION BROADCAST — NO REPLY EXPECTED] This is an informational broadcast. Do NOT reply via speak-to or re-broadcast. If you want to acknowledge, just update your wallpaper status.`;
            }
            // Inject broadcast recipient info if enabled
            if (showRecipientInfo) {
                pushMsg += '\n\n' + buildBroadcastRecipientBlock(device, targetIds, toId);
            } else {
                pushMsg += '\n\n';
            }
            pushMsg += `[BROADCAST] From: ${sourceLabel}\n`;
            pushMsg += `Content: ${broadcastText}`;
            if (mediaType === 'photo') {
                pushMsg += `\n[Attachment: Photo]\nmedia_type: photo\nmedia_url: ${mediaUrl}`;
                const bkUrl = getBackupUrl(mediaUrl);
                if (bkUrl) pushMsg += `\nbackup_url: ${bkUrl}`;
            } else if (mediaType === 'voice') pushMsg += `\n[Attachment: Voice]\nmedia_type: voice\nmedia_url: ${mediaUrl}`;
            else if (mediaType === 'video') pushMsg += `\n[Attachment: Video]\nmedia_type: video\nmedia_url: ${mediaUrl}`;
            else if (mediaType === 'file') pushMsg += `\n[Attachment: File]\nmedia_type: file\nmedia_url: ${mediaUrl}`;
            pushMsg += getMissionApiHints(apiBase, deviceId, toId, toEntity.botSecret);
            pushMsg += buildIdentitySetupHint(toEntity, apiBase, deviceId, toId, toEntity.botSecret);
            pushToBot(toEntity, deviceId, "entity_broadcast", {
                message: pushMsg
            }).then(pushResult => {
                if (pushResult.pushed) {
                    messageObj.delivered = true;
                    markChatMessageDelivered(broadcastChatMsgId, String(toId));
                    serverLog('info', 'broadcast_push', `Entity ${toId} push OK`, { deviceId, entityId: toId });
                } else {
                    serverLog('warn', 'broadcast_push', `Entity ${toId} push returned not-pushed: ${pushResult.reason || 'unknown'}`, { deviceId, entityId: toId });
                }
            }).catch(err => {
                console.error(`[Broadcast] Background push to Entity ${toId} failed: ${err.message}`);
                serverLog('error', 'broadcast_push', `Entity ${toId} push FAILED: ${err.message}`, { deviceId, entityId: toId });
            });
        } else if (toEntity.isBound) {
            console.warn(`[Push] ✗ No webhook registered for Device ${deviceId} Entity ${toId} - client will show dialog`);
            serverLog('warn', 'broadcast_push', `Entity ${toId} no webhook (polling mode)`, { deviceId, entityId: toId });
        }

        // Determine binding type for broadcast target
        const officialBindBcast = officialBindingsCache[getBindingCacheKey(deviceId, toId)];
        let bindingTypeBcast = null;
        if (officialBindBcast) {
            const botBcast = officialBots[officialBindBcast.bot_id];
            bindingTypeBcast = botBcast ? botBcast.bot_type : null;
        }

        return {
            entityId: toId,
            character: toEntity.character,
            pushed: hasWebhook ? "pending" : false,
            mode: hasWebhook ? "push" : "polling",
            reason: hasWebhook ? "fire_and_forget" : "no_webhook",
            bindingType: bindingTypeBcast
        };
    });

    res.json({
        success: true,
        message: `Broadcast sent from Entity ${fromId} to ${results.length} entities`,
        from: { entityId: fromId, character: fromEntity.character },
        sentCount: results.length,
        targets: results,
        broadcast: targetIds.length > 1,
        expects_reply: expectsReplyBcast,
        push_status: fromEntity.pushStatus || null
    });
});

/**
 * GET /api/client/pending
 * Get pending messages for entity.
 * Query: ?deviceId=xxx&entityId=0&botSecret=xxx
 *
 * Without botSecret: returns count only (peek mode)
 * With valid botSecret: returns and consumes messages
 */
app.get('/api/client/pending', (req, res) => {
    const deviceId = req.query.deviceId;
    const eId = parseInt(req.query.entityId) || 0;
    const botSecret = req.query.botSecret || req.headers['x-bot-secret'];

    if (!deviceId) {
        return res.status(400).json({ success: false, message: "deviceId required" });
    }

    if (eId < 0) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    if (!isValidEntityId(device, eId)) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const entity = device.entities[eId];
    const pending = entity.messageQueue.filter(m => !m.read);

    // Without botSecret: peek mode (count only, don't consume)
    if (!botSecret) {
        return res.json({
            deviceId: deviceId,
            entityId: eId,
            count: pending.length,
            messages: [],
            note: "Provide botSecret to retrieve and consume messages"
        });
    }

    // Verify botSecret matches
    if (!safeEqual(entity.botSecret, botSecret)) {
        return res.status(403).json({
            success: false,
            message: "Invalid botSecret for this entity"
        });
    }

    // Log when messages are consumed (authenticated)
    if (pending.length > 0) {
        console.log(`[Pending] Device ${deviceId} Entity ${eId}: ${pending.length} messages consumed`);
    }

    // Mark as read (consume)
    pending.forEach(m => m.read = true);

    res.json({
        deviceId: deviceId,
        entityId: eId,
        count: pending.length,
        messages: pending,
        versionInfo: getVersionInfo(entity.appVersion)
    });
});

// ============================================
// DEBUG ENDPOINTS
// ============================================

/**
 * GET /api/debug/devices
 * Show all devices and their entities (for debugging).
 * Requires admin auth — never expose unauthenticated.
 */
app.get('/api/debug/devices', (req, res) => {
    if (!verifyAdmin(req, res)) return;
    const result = [];
    for (const deviceId in devices) {
        const device = devices[deviceId];
        const entities = [];
        for (const i of Object.keys(device.entities).map(Number)) {
            const e = device.entities[i];
            if (!e) { entities.push({ entityId: i, isBound: false, empty: true }); continue; }
            entities.push({
                entityId: i,
                isBound: e.isBound,
                name: e.name,
                character: e.character,
                state: e.state,
                message: e.message,
                messageQueueLength: e.messageQueue?.length || 0,
                unreadMessages: e.messageQueue?.filter(m => !m.read).length || 0,
                webhookRegistered: e.webhook !== null,
                mode: e.webhook ? "push" : "polling"
            });
        }
        result.push({
            deviceId: deviceId,
            createdAt: device.createdAt,
            entities: entities
        });
    }
    res.json({
        deviceCount: result.length,
        pendingBindings: Object.keys(pendingBindings).length,
        devices: result
    });
});

/**
 * GET /api/debug/webhooks
 * Show webhook URLs for all entities of a device (for debugging).
 * Requires deviceSecret for authentication.
 */
app.get('/api/debug/webhooks', (req, res) => {
    const { deviceId, deviceSecret } = req.query;
    if (!deviceId || !deviceSecret) return res.status(400).json({ error: 'deviceId and deviceSecret required' });
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) return res.status(401).json({ error: 'Invalid credentials' });
    const entities = [];
    for (const i of Object.keys(device.entities).map(Number)) {
        const e = device.entities[i];
        if (!e) continue;
        entities.push({
            entityId: i,
            isBound: e.isBound,
            name: e.name,
            webhookUrl: e.webhook?.url || null,
            webhookType: e.webhook?.type || null,
            bindingType: e.bindingType || null,
            channelAccountId: e.channelAccountId || null
        });
    }
    res.json({ deviceId, entities });
});

/**
 * POST /api/debug/reset
 * Reset all devices (for testing). Requires admin token.
 */
app.post('/api/debug/reset', (req, res) => {
    const adminToken = req.headers['x-admin-token'] || req.body.adminToken;
    const expectedToken = process.env.ADMIN_SECRET;

    // Only allow from localhost or with correct token
    const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';

    if (!isLocalhost && (!expectedToken || !adminToken || !safeEqual(adminToken, expectedToken))) {
        return res.status(403).json({ success: false, error: 'Forbidden: admin token required' });
    }

    for (const deviceId in devices) {
        delete devices[deviceId];
    }
    for (const code in pendingBindings) {
        delete pendingBindings[code];
    }
    console.log("[Debug] All devices reset");
    res.json({ success: true, message: "All devices reset" });
});
/**
 * POST /api/debug/set-entity-xp
 * Directly set XP/level on an entity (test devices only).
 * Body: { deviceId, deviceSecret, entityId, xp }
 */
app.post('/api/debug/set-entity-xp', (req, res) => {
    const { deviceId, deviceSecret, entityId, xp } = req.body || {};
    if (!deviceId || !deviceSecret || entityId === undefined || xp === undefined) {
        return res.status(400).json({ success: false, error: 'deviceId, deviceSecret, entityId, xp required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    if (!device.isTestDevice) {
        return res.status(403).json({ success: false, error: 'Test devices only' });
    }
    const eId = parseInt(entityId);
    if (!isValidEntityId(device, eId)) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }
    const entity = device.entities[eId];
    if (!entity) {
        return res.status(404).json({ success: false, error: `Entity ${eId} not found` });
    }
    const xpVal = Math.max(0, parseInt(xp) || 0);
    entity.xp = xpVal;
    entity.level = calculateLevel(xpVal);
    saveData();
    res.json({ success: true, entityId: eId, xp: entity.xp, level: entity.level });
});

// ============================================
// OFFICIAL BOT POOL - Admin API
// ============================================

function verifyAdmin(req) {
    const adminToken = req.headers['x-admin-token'] || req.body.adminToken;
    const expectedToken = process.env.ADMIN_SECRET;
    const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
    // Require ADMIN_SECRET to be set for non-localhost; timing-safe compare
    if (isLocalhost) return true;
    if (!expectedToken || !adminToken) return false;
    return safeEqual(adminToken, expectedToken);
}

/**
 * POST /api/admin/official-bot/register
 * Register an official bot into the pool.
 * Body: { botId, botType: "free"|"personal", webhookUrl, token, botSecret?, sessionKeyTemplate? }
 * botSecret: the secret the bot uses to authenticate with E-Claw API (must match bot's TOOLS.md)
 */
app.post('/api/admin/official-bot/register', async (req, res) => {
    if (!verifyAdmin(req)) {
        return res.status(403).json({ success: false, error: 'Forbidden: admin token required' });
    }

    const { botId, botType, webhookUrl, token, botSecret, sessionKeyTemplate, setupUsername, setupPassword } = req.body;

    if (!botId || !botType || !webhookUrl || !token) {
        return res.status(400).json({ success: false, error: 'botId, botType, webhookUrl, and token are required' });
    }

    if (!['free', 'personal'].includes(botType)) {
        return res.status(400).json({ success: false, error: 'botType must be "free" or "personal"' });
    }

    // Generate botSecret if not provided
    const crypto = require('crypto');
    const effectiveBotSecret = botSecret || crypto.randomBytes(16).toString('hex');

    const bot = {
        bot_id: botId,
        bot_type: botType,
        webhook_url: webhookUrl,
        token: token,
        bot_secret: effectiveBotSecret,
        session_key_template: sessionKeyTemplate || null,
        status: 'available',
        assigned_device_id: null,
        assigned_entity_id: null,
        assigned_at: null,
        created_at: Date.now(),
        setup_username: setupUsername || null,
        setup_password: setupPassword || null
    };

    officialBots[botId] = bot;
    if (usePostgreSQL) await db.saveOfficialBot(bot);

    console.log(`[Admin] Registered official bot: ${botId} (${botType}), botSecret: ${effectiveBotSecret.substring(0, 8)}...`);
    res.json({ success: true, bot: { bot_id: botId, bot_type: botType, status: 'available', botSecret: effectiveBotSecret } });
});

/**
 * GET /api/admin/official-bots
 * List all official bots with status.
 */
app.get('/api/admin/official-bots', (req, res) => {
    if (!verifyAdmin(req)) {
        return res.status(403).json({ success: false, error: 'Forbidden: admin token required' });
    }

    const bots = Object.values(officialBots).map(b => ({
        bot_id: b.bot_id,
        bot_type: b.bot_type,
        status: b.status,
        assigned_device_id: b.assigned_device_id,
        assigned_entity_id: b.assigned_entity_id,
        assigned_at: b.assigned_at,
        created_at: b.created_at
    }));

    res.json({ success: true, bots, count: bots.length });
});

/**
 * PUT /api/admin/official-bot/:botId
 * Update an official bot's webhook/token/status.
 */
app.put('/api/admin/official-bot/:botId', adminAuth, adminCheck, async (req, res) => {
    const { botId } = req.params;
    const bot = officialBots[botId];
    if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
    }

    const { webhookUrl, token, sessionKeyTemplate, status, setupUsername, setupPassword, displayName } = req.body;
    if (webhookUrl) bot.webhook_url = webhookUrl;
    if (token) bot.token = token;
    if (sessionKeyTemplate !== undefined) bot.session_key_template = sessionKeyTemplate;
    if (status && ['available', 'assigned', 'disabled'].includes(status)) bot.status = status;
    if (setupUsername !== undefined) bot.setup_username = setupUsername || null;
    if (setupPassword !== undefined) bot.setup_password = setupPassword || null;
    if (displayName !== undefined) bot.display_name = displayName || null;

    if (usePostgreSQL) await db.saveOfficialBot(bot);

    // Propagate webhook/token changes to all currently bound entities
    let syncCount = 0;
    if (webhookUrl || token || setupUsername !== undefined || setupPassword !== undefined) {
        for (const binding of Object.values(officialBindingsCache)) {
            if (binding.bot_id !== botId) continue;
            const device = devices[binding.device_id];
            const entity = device?.entities?.[binding.entity_id];
            if (!entity?.webhook) continue;
            if (webhookUrl) entity.webhook.url = bot.webhook_url;
            if (token) entity.webhook.token = bot.token;
            if (setupUsername !== undefined) entity.webhook.setupUsername = bot.setup_username;
            if (setupPassword !== undefined) entity.webhook.setupPassword = bot.setup_password;
            syncCount++;
        }
        if (syncCount > 0) {
            await saveData();
            console.log(`[Admin] Synced webhook/token to ${syncCount} bound entities for bot: ${botId}`);
        }
    }

    console.log(`[Admin] Updated official bot: ${botId}`);
    res.json({ success: true, bot: { bot_id: bot.bot_id, bot_type: bot.bot_type, status: bot.status }, syncedEntities: syncCount });
});

/**
 * DELETE /api/admin/official-bot/:botId
 * Remove an official bot from the pool.
 */
app.delete('/api/admin/official-bot/:botId', adminAuth, adminCheck, async (req, res) => {

    const { botId } = req.params;
    const bot = officialBots[botId];
    if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
    }

    const force = req.query.force === 'true';
    if (bot.status === 'assigned' && !force) {
        return res.status(400).json({ success: false, error: 'Bot is currently assigned. Use ?force=true to remove anyway.' });
    }

    delete officialBots[botId];
    if (usePostgreSQL) await db.deleteOfficialBot(botId);

    console.log(`[Admin] Removed official bot: ${botId}`);
    res.json({ success: true, message: `Bot ${botId} removed` });
});

// ============================================
// OFFICIAL BORROW - User-Facing Endpoints
// ============================================

// In-memory cache of official bindings (deviceId:entityId -> binding)
const officialBindingsCache = {};

function getBindingCacheKey(deviceId, entityId) {
    return `${deviceId}:${entityId}`;
}

/**
 * Auto-unbind an entity if it has an existing official binding.
 * Used by bind-free and bind-personal to support override mode.
 */
async function autoUnbindEntity(deviceId, eId, device) {
    const cacheKey = getBindingCacheKey(deviceId, eId);
    let binding = officialBindingsCache[cacheKey];
    if (!binding && usePostgreSQL) {
        binding = await db.getOfficialBinding(deviceId, eId);
    }

    if (binding) {
        // Release the bot back to pool
        const bot = officialBots[binding.bot_id];
        if (bot && bot.bot_type === 'personal') {
            bot.status = 'available';
            bot.assigned_device_id = null;
            bot.assigned_entity_id = null;
            bot.assigned_at = null;
            if (usePostgreSQL) await db.saveOfficialBot(bot);
            console.log(`[Borrow] Auto-unbind: personal bot ${bot.bot_id} released`);
        } else if (bot && bot.bot_type === 'free') {
            delete officialBindingsCache[cacheKey];
            const remaining = Object.values(officialBindingsCache).filter(b => b.bot_id === bot.bot_id);
            if (remaining.length === 0) {
                bot.status = 'available';
                bot.assigned_device_id = null;
                bot.assigned_entity_id = null;
                bot.assigned_at = null;
                if (usePostgreSQL) await db.saveOfficialBot(bot);
            }
            console.log(`[Borrow] Auto-unbind: free bot binding removed`);
        }
        delete officialBindingsCache[cacheKey];
        if (usePostgreSQL) await db.removeOfficialBinding(deviceId, eId);
    }

    // Reset entity to default (preserve user-set name, xp, level)
    const prevEntity = device.entities[eId];
    device.entities[eId] = createDefaultEntity(eId);
    device.entities[eId].name = prevEntity?.name || null;
    device.entities[eId].xp = prevEntity?.xp || 0;
    device.entities[eId].level = prevEntity?.level || 1;
}

/**
 * GET /api/official-borrow/status
 * Get borrow availability and current bindings for a device.
 */
app.get('/api/official-borrow/status', async (req, res) => {
    const { deviceId } = req.query;

    if (!deviceId) {
        return res.status(400).json({ success: false, error: 'deviceId required' });
    }

    // Count free bots
    const freeBots = Object.values(officialBots).filter(b => b.bot_type === 'free' && b.status !== 'disabled');
    const freeAvailable = freeBots.length > 0;

    // Count available personal bots
    const personalBots = Object.values(officialBots).filter(b => b.bot_type === 'personal');
    const personalAvailable = personalBots.filter(b => b.status === 'available').length;
    const personalTotal = personalBots.filter(b => b.status !== 'disabled').length;

    // Get bindings for this device
    let bindings = [];
    if (usePostgreSQL) {
        bindings = await db.getDeviceOfficialBindings(deviceId);
    } else {
        bindings = Object.values(officialBindingsCache)
            .filter(b => b.device_id === deviceId)
            .map(b => {
                const bot = officialBots[b.bot_id];
                return { entity_id: b.entity_id, bot_type: bot ? bot.bot_type : 'unknown', bot_id: b.bot_id };
            });
    }

    // Smart cleanup: remove stale bindings where entity is no longer bound
    const device = devices[deviceId];
    const validBindings = [];
    for (const b of bindings) {
        const eId = b.entity_id ?? b.entityId;
        const entity = device?.entities?.[eId];
        if (entity && entity.isBound) {
            validBindings.push(b);
        } else {
            // Stale binding - clean it up
            console.log(`[Borrow Status] Cleaning stale binding: device ${deviceId} entity ${eId}`);
            const cacheKey = getBindingCacheKey(deviceId, eId);
            const staleBinding = officialBindingsCache[cacheKey];
            if (staleBinding) {
                const bot = officialBots[staleBinding.bot_id];
                if (bot && bot.bot_type === 'personal') {
                    bot.status = 'available';
                    bot.assigned_device_id = null;
                    bot.assigned_entity_id = null;
                    bot.assigned_at = null;
                    if (usePostgreSQL) await db.saveOfficialBot(bot);
                }
                delete officialBindingsCache[cacheKey];
            }
            if (usePostgreSQL) await db.removeOfficialBinding(deviceId, eId);
        }
    }

    // Get paid borrow slots info
    let paidSlots = 0;
    if (usePostgreSQL) {
        paidSlots = await db.getPaidBorrowSlots(deviceId);
    }
    const usedPersonalSlots = validBindings.filter(b => (b.bot_type ?? b.botType) === 'personal').length;

    res.json({
        success: true,
        free: { available: freeAvailable },
        personal: { available: personalAvailable, total: personalTotal },
        paidSlots: paidSlots,
        usedSlots: usedPersonalSlots,
        availableSlots: paidSlots - usedPersonalSlots,
        bindings: validBindings.map(b => ({
            entityId: b.entity_id ?? b.entityId,
            botType: b.bot_type ?? b.botType,
            botId: b.bot_id ?? b.botId
        })),
        tosAgreed: gatekeeper.hasAgreedToTOS(deviceId),
        tosVersion: gatekeeper.FREE_BOT_TOS_VERSION
    });
});

/**
 * GET /api/official-borrow/free-bots
 * List available free bots with active binding counts for user selection.
 */
app.get('/api/official-borrow/free-bots', (req, res) => {
    const freeBots = Object.values(officialBots).filter(b => b.bot_type === 'free' && b.status !== 'disabled');

    const bots = freeBots.map(bot => {
        // Count active bindings for this bot (only where entity is still bound)
        let activeBindings = 0;
        for (const binding of Object.values(officialBindingsCache)) {
            if (binding.bot_id !== bot.bot_id) continue;
            const device = devices[binding.device_id];
            const entity = device?.entities?.[binding.entity_id];
            if (entity && entity.isBound) {
                activeBindings++;
            }
        }
        return {
            botId: bot.bot_id,
            displayName: bot.display_name || bot.bot_id,
            activeBindings,
            status: bot.status
        };
    });

    res.json({ success: true, bots });
});

/**
 * POST /api/official-borrow/bind-free
 * Bind a free official bot to a device entity.
 * Body: { deviceId, deviceSecret, entityId, botId? }
 */
app.post('/api/official-borrow/bind-free', async (req, res) => {
    const { deviceId, deviceSecret, entityId, botId } = req.body;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }

    const eId = parseInt(entityId);
    if (isNaN(eId) || eId < 0) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }

    try {
    // Gatekeeper: check if device is blocked from free bot usage
    if (gatekeeper.isDeviceBlocked(deviceId)) {
        const strikeInfo = gatekeeper.getStrikeInfo(deviceId);
        console.warn(`[Gatekeeper] Blocked device ${deviceId} attempted to bind free bot (strikes: ${strikeInfo.count})`);
        return res.status(403).json({
            success: false,
            error: '您的免費機器人使用權已被封鎖，因為違規次數已達上限。如有疑問請聯繫客服。',
            gatekeeper_blocked: true,
            strikes: strikeInfo.count
        });
    }

    // Gatekeeper: check if device has agreed to free bot TOS
    if (!gatekeeper.hasAgreedToTOS(deviceId)) {
        const lang = req.body.lang || 'en';
        const tos = gatekeeper.getFreeBotTOS(lang);
        return res.status(451).json({
            success: false,
            error: 'TOS_NOT_AGREED',
            message: '使用免費版機器人前，請先閱讀並同意使用規範。',
            tos: tos
        });
    }

    // Auto-create device if missing (e.g. after server redeploy)
    const device = getOrCreateDevice(deviceId, deviceSecret);

    if (device.deviceSecret && !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid deviceSecret' });
    }

    if (!isValidEntityId(device, eId)) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }

    // Override mode: auto-unbind if entity already has a binding
    const entity = device.entities[eId];
    if (entity && entity.isBound) {
        console.log(`[Borrow] Override: auto-unbinding entity ${eId} on device ${deviceId}`);
        await autoUnbindEntity(deviceId, eId, device);
    }

    // Each device can only have one free bot binding
    // Smart check: only count bindings where the entity is actually still bound
    const existingFreeBinding = Object.values(officialBindingsCache).find(b => {
        if (b.device_id !== deviceId) return false;
        const bot = officialBots[b.bot_id];
        if (!bot || bot.bot_type !== 'free') return false;
        // Verify the entity still exists and is bound
        const boundEntity = device.entities[b.entity_id];
        if (!boundEntity || !boundEntity.isBound) {
            // Stale binding - clean it up
            console.log(`[Borrow] Cleaning stale free binding: device ${deviceId} entity ${b.entity_id}`);
            delete officialBindingsCache[getBindingCacheKey(deviceId, b.entity_id)];
            if (usePostgreSQL) db.removeOfficialBinding(deviceId, b.entity_id);
            return false;
        }
        return true;
    });
    if (existingFreeBinding) {
        return res.status(400).json({ success: false, error: `每個裝置僅限借用一個免費版 (已綁定 Entity #${existingFreeBinding.entity_id})` });
    }

    // Find a free bot (user-selected or auto-assign)
    let freeBot;
    if (botId) {
        freeBot = officialBots[botId];
        if (!freeBot || freeBot.bot_type !== 'free') {
            return res.status(400).json({ success: false, error: 'Invalid botId: not a free bot' });
        }
        if (freeBot.status === 'disabled') {
            return res.status(400).json({ success: false, error: 'This bot is currently disabled' });
        }
    } else {
        freeBot = Object.values(officialBots).find(b => b.bot_type === 'free' && b.status !== 'disabled');
    }
    if (!freeBot) {
        return res.status(404).json({ success: false, error: 'No free bot available' });
    }

    // Handshake with bot to discover a working session key and get welcome message
    const preferredKey = freeBot.session_key_template || 'default';
    const freeBotAuthOpts = { setupUsername: freeBot.setup_username, setupPassword: freeBot.setup_password };
    const handshake = await handshakeWithBot(freeBot.webhook_url, freeBot.token, preferredKey, deviceId, eId, 'free', freeBotAuthOpts);

    if (!handshake.success) {
        return res.status(502).json({
            success: false,
            error: `無法與免費版機器人建立連線。${handshake.error || ''}`,
            hint: 'Bot gateway may not have active sessions. Check bot configuration.'
        });
    }

    const sessionKey = handshake.sessionKey;

    // Use bot's stored botSecret so the bot can authenticate with E-Claw API
    const botSecret = freeBot.bot_secret || (() => { const crypto = require('crypto'); return crypto.randomBytes(16).toString('hex'); })();

    // Set up entity with official bot's webhook (preserve user-set name, xp, level)
    const existingEntityFree = device.entities[eId];
    const freePublicCode = generatePublicCode();
    device.entities[eId] = {
        ...createDefaultEntity(eId),
        xp: existingEntityFree?.xp || 0,
        level: existingEntityFree?.level || 1,
        botSecret: botSecret,
        publicCode: freePublicCode,
        isBound: true,
        name: existingEntityFree?.name || '免費版',
        state: 'IDLE',
        message: 'Connected!',
        lastUpdated: Date.now(),
        webhook: {
            url: freeBot.webhook_url,
            token: freeBot.token,
            sessionKey: sessionKey,
            registeredAt: Date.now(),
            setupUsername: freeBot.setup_username || null,
            setupPassword: freeBot.setup_password || null
        }
    };
    publicCodeIndex[freePublicCode] = { deviceId, entityId: eId };

    // Save binding record
    const binding = {
        bot_id: freeBot.bot_id,
        device_id: deviceId,
        entity_id: eId,
        session_key: sessionKey,
        bound_at: Date.now(),
        subscription_verified_at: Date.now()
    };
    officialBindingsCache[getBindingCacheKey(deviceId, eId)] = binding;
    if (usePostgreSQL) await db.saveOfficialBinding(binding);

    // Mark free bot as assigned (it can still serve others)
    freeBot.status = 'assigned';
    if (usePostgreSQL) await db.saveOfficialBot(freeBot);

    // Dynamic entity auto-expand after official free bot bind
    const newSlotFree = ensureOneEmptySlot(device);
    if (newSlotFree !== null) {
        console.log(`[DynamicEntity] Auto-expand after free-bind: deviceId=${deviceId}, newSlotId=${newSlotFree}, totalSlots=${entityCount(device)}`);
    }

    await saveData();

    if (newSlotFree !== null) {
        io.to(deviceId).emit('entityAdded', { entityId: newSlotFree, totalSlots: entityCount(device) });
    }

    console.log(`[Borrow] Free bot ${freeBot.bot_id} bound to device ${deviceId} entity ${eId} (session: ${sessionKey})`);

    // Fire-and-forget: send credentials + skill doc to bot
    sendBindCredentialsToBot(freeBot.webhook_url, freeBot.token, sessionKey, deviceId, eId, botSecret, 'free', freeBotAuthOpts);

    res.json({
        success: true,
        entityId: eId,
        botType: 'free',
        publicCode: freePublicCode,
        newSlotCreated: newSlotFree,
        message: 'Free bot bound successfully'
    });
    } catch (err) {
        console.error(`[Borrow] bind-free error for device ${deviceId}:`, err.message || err);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: 'Internal error during free bot binding', detail: err.message });
        }
    }
});

/**
 * POST /api/official-borrow/bind-personal
 * Bind a personal official bot to a device entity (requires subscription).
 * Body: { deviceId, deviceSecret, entityId }
 */
app.post('/api/official-borrow/bind-personal', async (req, res) => {
    const { deviceId, deviceSecret, entityId } = req.body;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }

    const eId = parseInt(entityId);
    if (isNaN(eId) || eId < 0) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }

    try {

    // Auto-create device if missing (e.g. after server redeploy)
    const device = getOrCreateDevice(deviceId, deviceSecret);

    if (device.deviceSecret && !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid deviceSecret' });
    }

    if (!isValidEntityId(device, eId)) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }

    // Override mode: auto-unbind if entity already has a binding
    const entity = device.entities[eId];
    if (entity && entity.isBound) {
        console.log(`[Borrow] Override: auto-unbinding entity ${eId} on device ${deviceId}`);
        await autoUnbindEntity(deviceId, eId, device);
    }

    // Check paid_borrow_slots: if user has unused paid slots, allow free rebind
    let usedSlot = false;
    if (usePostgreSQL) {
        const paidSlots = await db.getPaidBorrowSlots(deviceId);
        // Count current personal bindings (used slots)
        const currentPersonalBindings = Object.values(officialBindingsCache).filter(b => {
            if (b.device_id !== deviceId) return false;
            const bot = officialBots[b.bot_id];
            return bot && bot.bot_type === 'personal';
        }).length;
        const availableSlots = paidSlots - currentPersonalBindings;

        if (availableSlots > 0) {
            // Has unused paid slot - bind without payment
            usedSlot = true;
            console.log(`[Borrow] Device ${deviceId} using paid slot (${currentPersonalBindings + 1}/${paidSlots})`);
        } else {
            // No available slots - payment required
            return res.status(402).json({
                success: false,
                error: 'payment_required',
                message: 'No available paid slots. Payment required for new personal bot.',
                paidSlots: paidSlots,
                usedSlots: currentPersonalBindings
            });
        }
    }

    // Find first available personal bot
    const personalBot = Object.values(officialBots).find(b => b.bot_type === 'personal' && b.status === 'available');
    if (!personalBot) {
        return res.status(404).json({ success: false, error: 'sold_out', message: 'No personal bots available' });
    }

    // Handshake with bot to discover a working session key and get welcome message
    const preferredKey = personalBot.session_key_template || 'default';
    const personalBotAuthOpts = { setupUsername: personalBot.setup_username, setupPassword: personalBot.setup_password };
    const handshake = await handshakeWithBot(personalBot.webhook_url, personalBot.token, preferredKey, deviceId, eId, 'personal', personalBotAuthOpts);

    if (!handshake.success) {
        return res.status(502).json({
            success: false,
            error: `無法與月租版機器人建立連線。${handshake.error || ''}`,
            hint: 'Bot gateway may not have active sessions. Check bot configuration.'
        });
    }

    const sessionKey = handshake.sessionKey;

    // Use bot's stored botSecret so the bot can authenticate with E-Claw API
    const botSecret = personalBot.bot_secret || (() => { const crypto = require('crypto'); return crypto.randomBytes(16).toString('hex'); })();

    // Set up entity (preserve user-set name, xp, level)
    const existingEntityPersonal = device.entities[eId];
    device.entities[eId] = {
        ...createDefaultEntity(eId),
        xp: existingEntityPersonal?.xp || 0,
        level: existingEntityPersonal?.level || 1,
        botSecret: botSecret,
        isBound: true,
        name: existingEntityPersonal?.name || '月租版',
        state: 'IDLE',
        message: 'Connected!',
        lastUpdated: Date.now(),
        webhook: {
            url: personalBot.webhook_url,
            token: personalBot.token,
            sessionKey: sessionKey,
            registeredAt: Date.now(),
            setupUsername: personalBot.setup_username || null,
            setupPassword: personalBot.setup_password || null
        }
    };

    // Mark personal bot as assigned
    personalBot.status = 'assigned';
    personalBot.assigned_device_id = deviceId;
    personalBot.assigned_entity_id = eId;
    personalBot.assigned_at = Date.now();
    if (usePostgreSQL) await db.saveOfficialBot(personalBot);

    // Save binding record
    const binding = {
        bot_id: personalBot.bot_id,
        device_id: deviceId,
        entity_id: eId,
        session_key: sessionKey,
        bound_at: Date.now(),
        subscription_verified_at: Date.now()
    };
    officialBindingsCache[getBindingCacheKey(deviceId, eId)] = binding;
    if (usePostgreSQL) await db.saveOfficialBinding(binding);

    // Dynamic entity auto-expand after personal bot bind
    const newSlotPersonal = ensureOneEmptySlot(device);
    if (newSlotPersonal !== null) {
        console.log(`[DynamicEntity] Auto-expand after personal-bind: deviceId=${deviceId}, newSlotId=${newSlotPersonal}, totalSlots=${entityCount(device)}`);
    }

    await saveData();

    if (newSlotPersonal !== null) {
        io.to(deviceId).emit('entityAdded', { entityId: newSlotPersonal, totalSlots: entityCount(device) });
    }

    console.log(`[Borrow] Personal bot ${personalBot.bot_id} assigned to device ${deviceId} entity ${eId} (session: ${sessionKey}, usedSlot: ${usedSlot})`);

    // Fire-and-forget: send credentials + skill doc to bot
    sendBindCredentialsToBot(personalBot.webhook_url, personalBot.token, sessionKey, deviceId, eId, botSecret, 'personal', personalBotAuthOpts);

    res.json({
        success: true,
        entityId: eId,
        botType: 'personal',
        botId: personalBot.bot_id,
        usedSlot: usedSlot,
        newSlotCreated: newSlotPersonal,
        message: usedSlot ? 'Personal bot bound using existing paid slot' : 'Personal bot bound successfully'
    });
    } catch (err) {
        console.error(`[Borrow] bind-personal error for device ${deviceId}:`, err.message || err);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: 'Internal error during personal bot binding', detail: err.message });
        }
    }
});

/**
 * POST /api/official-borrow/add-paid-slot
 * Increment paid_borrow_slots for a device after successful payment.
 * Called by client after Google Play / TapPay payment completes.
 * Body: { deviceId, deviceSecret }
 */
app.post('/api/official-borrow/add-paid-slot', async (req, res) => {
    const { deviceId, deviceSecret } = req.body;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }

    const device = getOrCreateDevice(deviceId, deviceSecret);
    if (device.deviceSecret && !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid deviceSecret' });
    }

    if (!usePostgreSQL) {
        return res.status(500).json({ success: false, error: 'Database not available' });
    }

    const newSlotCount = await db.incrementPaidBorrowSlots(deviceId);

    // Count current personal bindings
    const currentPersonalBindings = Object.values(officialBindingsCache).filter(b => {
        if (b.device_id !== deviceId) return false;
        const bot = officialBots[b.bot_id];
        return bot && bot.bot_type === 'personal';
    }).length;

    console.log(`[Borrow] Device ${deviceId} added paid slot: now ${newSlotCount} total, ${currentPersonalBindings} used`);

    res.json({
        success: true,
        paidSlots: newSlotCount,
        usedSlots: currentPersonalBindings,
        availableSlots: newSlotCount - currentPersonalBindings,
        message: `Paid slot added. Total: ${newSlotCount}`
    });
});

/**
 * POST /api/official-borrow/unbind
 * Unbind an official bot from a device entity.
 * Body: { deviceId, deviceSecret, entityId }
 */
app.post('/api/official-borrow/unbind', async (req, res) => {
    const { deviceId, deviceSecret, entityId } = req.body;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }

    const eId = parseInt(entityId);
    if (isNaN(eId) || eId < 0) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }

    // Auto-create device if missing (e.g. after server redeploy)
    const device = getOrCreateDevice(deviceId, deviceSecret);

    if (device.deviceSecret && !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid deviceSecret' });
    }

    if (!isValidEntityId(device, eId)) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }

    // Check if this entity has an official binding
    const cacheKey = getBindingCacheKey(deviceId, eId);
    let binding = officialBindingsCache[cacheKey];
    if (!binding && usePostgreSQL) {
        binding = await db.getOfficialBinding(deviceId, eId);
    }

    if (!binding) {
        return res.status(404).json({ success: false, error: 'No official binding found for this entity' });
    }

    // Release the bot back to pool
    const bot = officialBots[binding.bot_id];
    if (bot) {
        if (bot.bot_type === 'personal') {
            bot.status = 'available';
            bot.assigned_device_id = null;
            bot.assigned_entity_id = null;
            bot.assigned_at = null;
            if (usePostgreSQL) await db.saveOfficialBot(bot);
            console.log(`[Borrow] Personal bot ${bot.bot_id} released back to pool`);
        } else if (bot.bot_type === 'free') {
            // Check if any other bindings still use this free bot
            delete officialBindingsCache[cacheKey]; // remove first before counting
            const remainingBindings = Object.values(officialBindingsCache).filter(b => b.bot_id === bot.bot_id);
            if (remainingBindings.length === 0) {
                bot.status = 'available';
                bot.assigned_device_id = null;
                bot.assigned_entity_id = null;
                bot.assigned_at = null;
                if (usePostgreSQL) await db.saveOfficialBot(bot);
                console.log(`[Borrow] Free bot ${bot.bot_id} released (no remaining bindings)`);
            }
        }
    }

    // Remove binding (for personal type - free already deleted above)
    if (!bot || bot.bot_type !== 'free') {
        delete officialBindingsCache[cacheKey];
    }
    if (usePostgreSQL) await db.removeOfficialBinding(deviceId, eId);

    // Reset entity (preserve user-set name, xp, level)
    const prevBorrow = device.entities[eId];
    device.entities[eId] = createDefaultEntity(eId);
    device.entities[eId].name = prevBorrow?.name || null;
    device.entities[eId].xp = prevBorrow?.xp || 0;
    device.entities[eId].level = prevBorrow?.level || 1;
    await saveData();

    console.log(`[Borrow] Official binding removed: device ${deviceId} entity ${eId}`);
    res.json({ success: true, message: `Official bot unbound from entity ${eId}` });
});

/**
 * POST /api/official-borrow/verify-subscription
 * Client reports subscription status to keep binding alive.
 * Body: { deviceId, deviceSecret, entityId }
 */
app.post('/api/official-borrow/verify-subscription', async (req, res) => {
    const { deviceId, deviceSecret, entityId } = req.body;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }

    const eId = parseInt(entityId);
    if (isNaN(eId)) {
        return res.status(400).json({ success: false, error: 'Valid entityId required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid device credentials' });
    }

    const cacheKey = getBindingCacheKey(deviceId, eId);
    const binding = officialBindingsCache[cacheKey];
    if (binding) {
        binding.subscription_verified_at = Date.now();
    }
    if (usePostgreSQL) await db.updateSubscriptionVerified(deviceId, eId);

    res.json({ success: true, message: 'Subscription verified' });
});

// ============================================
// ENTITY REFRESH (In-Place Rebind)
// ============================================

/**
 * Refresh cooldown: 1 minute per entity per device.
 * Key: "deviceId:entityId" → timestamp of last refresh
 */
const refreshCooldowns = {};

/**
 * POST /api/entity/refresh
 * Refresh an entity's connection in-place without unbinding.
 * - Official bots: re-handshake + update session key + resend skills
 * - Non-official bots: verify webhook connectivity
 * - 1-minute cooldown per entity
 * Body: { deviceId, deviceSecret, entityId }
 */
app.post('/api/entity/refresh', async (req, res) => {
    const { deviceId, deviceSecret, entityId } = req.body;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }

    const eId = parseInt(entityId);
    if (isNaN(eId) || eId < 0) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }

    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid device credentials' });
    }

    if (!isValidEntityId(device, eId)) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }

    const entity = device.entities[eId];
    if (!entity || !entity.isBound) {
        return res.status(400).json({ success: false, error: 'Entity is not bound' });
    }

    // Cooldown check: 1 minute
    const cooldownKey = `${deviceId}:${eId}`;
    const lastRefresh = refreshCooldowns[cooldownKey] || 0;
    const elapsed = Date.now() - lastRefresh;
    const COOLDOWN_MS = 60000; // 1 minute
    if (elapsed < COOLDOWN_MS) {
        const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
        return res.status(429).json({
            success: false,
            error: `請等待 ${remaining} 秒後再試`,
            cooldown_remaining: remaining
        });
    }

    // Check if this is an official bot binding
    const cacheKey = getBindingCacheKey(deviceId, eId);
    let binding = officialBindingsCache[cacheKey];
    if (!binding && usePostgreSQL) {
        binding = await db.getOfficialBinding(deviceId, eId);
        if (binding) officialBindingsCache[cacheKey] = binding;
    }

    if (binding) {
        // ---- Official bot: re-handshake + update session key ----
        const bot = officialBots[binding.bot_id];
        if (!bot) {
            return res.status(404).json({ success: false, error: 'Official bot no longer exists', webhookBroken: true });
        }

        // Personal bot: verify still assigned to this device
        if (bot.bot_type === 'personal' && bot.assigned_device_id !== deviceId) {
            return res.status(409).json({ success: false, error: 'Personal bot is no longer assigned to this device', webhookBroken: true });
        }

        // Attempt handshake
        const preferredKey = binding.session_key || bot.session_key_template || 'default';
        const botAuthOpts = { setupUsername: bot.setup_username, setupPassword: bot.setup_password };
        const handshake = await handshakeWithBot(bot.webhook_url, bot.token, preferredKey, deviceId, eId, bot.bot_type, botAuthOpts);

        if (!handshake.success) {
            // Set cooldown even on failure to prevent spamming
            refreshCooldowns[cooldownKey] = Date.now();
            return res.json({
                success: false,
                webhookBroken: true,
                error: `無法與機器人建立連線。${handshake.error || ''}`,
                hint: 'Bot gateway may not have active sessions. A full rebind may be required.'
            });
        }

        const newSessionKey = handshake.sessionKey;

        // Update entity webhook
        entity.webhook = {
            url: bot.webhook_url,
            token: bot.token,
            sessionKey: newSessionKey,
            registeredAt: Date.now(),
            setupUsername: bot.setup_username || null,
            setupPassword: bot.setup_password || null
        };
        entity.lastUpdated = Date.now();

        // Update binding cache + DB
        binding.session_key = newSessionKey;
        if (usePostgreSQL) await db.saveOfficialBinding(binding);

        await saveData();

        // Fire-and-forget: resend credentials + skills doc
        sendBindCredentialsToBot(bot.webhook_url, bot.token, newSessionKey, deviceId, eId, entity.botSecret, bot.bot_type, botAuthOpts);

        // Set cooldown
        refreshCooldowns[cooldownKey] = Date.now();

        console.log(`[Refresh] Official bot ${bot.bot_id} refreshed for device ${deviceId} entity ${eId} (session: ${newSessionKey})`);
        return res.json({
            success: true,
            message: '連線已刷新',
            botType: bot.bot_type,
            sessionRefreshed: true
        });

    } else {
        // ---- Non-official (user-bound) bot: verify webhook ----
        if (!entity.webhook || !entity.webhook.url) {
            // Polling mode bot — no webhook to refresh
            refreshCooldowns[cooldownKey] = Date.now();
            return res.json({
                success: true,
                message: 'Polling mode bot — no webhook to refresh',
                webhookBroken: false,
                pollingMode: true
            });
        }

        // Test webhook connectivity
        const testResult = await sendToSession(
            entity.webhook.url,
            entity.webhook.token,
            entity.webhook.sessionKey,
            `[SYSTEM:REFRESH] Connection refresh from device ${deviceId}, entity ${eId}. Reply OK to confirm.`
        );

        refreshCooldowns[cooldownKey] = Date.now();

        if (testResult.success) {
            entity.lastUpdated = Date.now();
            await saveData();
            console.log(`[Refresh] User bot webhook OK for device ${deviceId} entity ${eId}`);
            return res.json({
                success: true,
                message: '連線正常',
                webhookBroken: false
            });
        } else {
            console.warn(`[Refresh] User bot webhook FAILED for device ${deviceId} entity ${eId}: ${testResult.error}`);
            return res.json({
                success: false,
                webhookBroken: true,
                error: `Webhook 連線失敗: ${testResult.error || 'unknown'}`,
                hint: 'Bot webhook may be down. Consider re-binding.'
            });
        }
    }
});

// ============================================
// BOT WEBHOOK REGISTRATION (Push Mode)
// ============================================

/**
 * Generate version-specific fix instructions for webhook handshake failures.
 * Returns a multi-line string with exact exec commands the bot can run.
 * @param {'tool_not_available'|'pairing_required'|'http_401'|'localhost_rejected'} errorType
 * @param {string|undefined} openclawVersion - e.g. "2026.2.28"
 */
function getWebhookFixInstructions(errorType, openclawVersion) {
    // Parse version string into comparable parts
    let vParts = null;
    if (openclawVersion) {
        const match = openclawVersion.match(/(\d{4})\.(\d+)\.(\d+)/);
        if (match) vParts = [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])];
    }

    const isV226Plus = vParts && (
        vParts[0] > 2026 ||
        (vParts[0] === 2026 && vParts[1] > 2) ||
        (vParts[0] === 2026 && vParts[1] === 2 && vParts[2] >= 26)
    );
    const isV214to225 = vParts && (
        vParts[0] === 2026 && vParts[1] === 2 && vParts[2] >= 14 && vParts[2] <= 25
    );

    const safetyRules =
        "SAFETY RULES:\n" +
        "- ALWAYS ask the user before restarting the gateway (it disconnects all active sessions)\n" +
        "- ALWAYS back up config first: exec: cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak\n" +
        "- After fixing, retry POST /api/bot/register with the same parameters\n";

    switch (errorType) {
        case 'tool_not_available': {
            if (isV226Plus) {
                return safetyRules + "\n" +
                    `FIX (OpenClaw ${openclawVersion} — use CLI):\n` +
                    "Step 1: Allow sessions_send tool:\n" +
                    `  exec: openclaw config set gateway.tools.allow '["sessions_send", "sessions_spawn", "session_status"]'\n` +
                    'Step 2: Ask the user: "I need to restart the OpenClaw gateway to apply the config change. This will briefly disconnect all sessions. May I proceed?"\n' +
                    "Step 3: Only if user confirms:\n" +
                    "  exec: openclaw gateway restart\n" +
                    "Step 4: Retry POST /api/bot/register with the same parameters.";
            } else if (isV214to225) {
                return safetyRules + "\n" +
                    `FIX (OpenClaw ${openclawVersion} — config file edit required):\n` +
                    "Step 1: Back up config:\n" +
                    "  exec: cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak\n" +
                    "Step 2: Read current config:\n" +
                    "  exec: cat ~/.openclaw/openclaw.json\n" +
                    'Step 3: Add sessions_send to gateway.tools.allow in the JSON. The result should include:\n' +
                    '  { "gateway": { "tools": { "allow": ["sessions_send", "sessions_spawn", "session_status"] } } }\n' +
                    "  WARNING: Merge carefully — do NOT overwrite other fields in the JSON.\n" +
                    'Step 4: Ask the user: "I need to restart the OpenClaw gateway to apply the config change. This will briefly disconnect all sessions. May I proceed?"\n' +
                    "Step 5: Only if user confirms:\n" +
                    "  exec: openclaw gateway restart\n" +
                    "Step 6: Retry POST /api/bot/register with the same parameters.";
            } else {
                // No version provided or unrecognized — tell bot to detect version first
                return safetyRules + "\n" +
                    "FIX: sessions_send tool is blocked on your gateway.\n" +
                    "First, detect your OpenClaw version:\n" +
                    "  exec: openclaw --version\n\n" +
                    "Then retry POST /api/bot/register with openclaw_version included in the request body, " +
                    "and the server will return version-specific fix instructions.\n\n" +
                    "Quick reference (if you prefer to fix now):\n" +
                    "  If version >= 2026.2.26:\n" +
                    `    exec: openclaw config set gateway.tools.allow '["sessions_send", "sessions_spawn", "session_status"]'\n` +
                    "  If version 2026.2.14 ~ 2026.2.25:\n" +
                    "    Edit ~/.openclaw/openclaw.json — add sessions_send to gateway.tools.allow\n" +
                    "  Then ask the user before restarting:\n" +
                    "    exec: openclaw gateway restart\n" +
                    "  Then retry POST /api/bot/register.";
            }
        }

        case 'pairing_required': {
            return safetyRules + "\n" +
                "FIX: Gateway requires device re-pairing.\n" +
                "Step 1: Read pending devices config:\n" +
                "  exec: cat ~/.openclaw/devices/pending.json\n" +
                'Step 2: Change "silent" from false to true in that file to auto-approve pairing.\n' +
                'Step 3: Ask the user: "I need to restart the OpenClaw gateway to apply the pairing fix. This will briefly disconnect all sessions. May I proceed?"\n' +
                "Step 4: Only if user confirms:\n" +
                "  exec: openclaw gateway restart\n" +
                "Step 5: Retry POST /api/bot/register with the same parameters.";
        }

        case 'http_401': {
            return "FIX: Gateway rejected your token (HTTP 401).\n" +
                "Step 1: Re-read the correct token:\n" +
                "  exec: echo $OPENCLAW_GATEWAY_TOKEN\n" +
                "  or: exec: openclaw config get gateway.token\n" +
                "Step 2: Retry POST /api/bot/register with the correct token value.\n" +
                "Note: If the token changed after a gateway restart, you need the new one.";
        }

        case 'localhost_rejected': {
            return "FIX: Your webhook_url points to localhost, which is unreachable from the internet.\n" +
                "Try these methods in order:\n\n" +
                "Method A (Recommended for Zeabur):\n" +
                "  exec: echo $ZEABUR_WEB_URL\n" +
                "  exec: echo $OPENCLAW_GATEWAY_TOKEN\n" +
                "  Then use: webhook_url = {ZEABUR_WEB_URL}/tools/invoke, token = {OPENCLAW_GATEWAY_TOKEN}\n\n" +
                "Method B: Query gateway config:\n" +
                "  exec: openclaw config get gateway.publicUrl\n" +
                "  exec: openclaw config get gateway.token\n" +
                "  If publicUrl is still localhost, use Method A or C.\n\n" +
                "Method C: Ask the user for the WebSocket URL and Gateway Token from the OpenClaw Overview page.\n" +
                "  CRITICAL: Replace wss:// with https:// in the URL!\n" +
                "  Example: wss://eclaw0.zeabur.app → https://eclaw0.zeabur.app/tools/invoke\n\n" +
                "Then retry POST /api/bot/register with the corrected webhook_url and token.";
        }

        default:
            return "Refer to https://eclawbot.com/docs/webhook-troubleshooting.md for troubleshooting steps.";
    }
}

/**
 * POST /api/bot/register
 * Bot registers its webhook URL to receive push notifications.
 * Body: { deviceId, entityId, botSecret, webhook_url, token, session_key, openclaw_version? }
 */
app.post('/api/bot/register', async (req, res) => {
    const { deviceId, entityId, botSecret, webhook_url, token, session_key, openclaw_version, setup_username, setup_password } = req.body;

    if (!deviceId) {
        return res.status(400).json({ success: false, message: "deviceId required" });
    }

    const eId = parseInt(entityId) || 0;
    if (eId < 0) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    if (!isValidEntityId(device, eId)) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const entity = device.entities[eId];

    if (!entity.isBound) {
        return res.status(400).json({
            success: false,
            message: `Entity ${eId} is not bound yet. Bind first using /api/bind`
        });
    }

    // Verify botSecret
    if (!botSecret || !safeEqual(botSecret, entity.botSecret)) {
        return res.status(403).json({ success: false, message: "Invalid botSecret" });
    }

    // Discord/Google Chat webhooks don't need token or session_key — the URL itself contains auth
    const isDiscord = isDiscordWebhook(webhook_url || '');
    const isGoogleChat = isGoogleChatWebhook(webhook_url || '');

    // Validate required fields (Discord/Google Chat webhooks only need webhook_url)
    if (!webhook_url) {
        return res.status(400).json({ success: false, message: "Missing required field: webhook_url" });
    }
    if (!isDiscord && !isGoogleChat && (!token || !session_key)) {
        return res.status(400).json({
            success: false,
            message: "Missing required fields: webhook_url, token, session_key"
        });
    }

    // Reject localhost/loopback/private-IP webhook URLs - these won't work from the cloud
    try {
        const urlObj = new URL(webhook_url);
        const hn = urlObj.hostname;
        const isLoopback = (hn === 'localhost' || hn === '127.0.0.1' || hn === '0.0.0.0' || hn === '::1');
        const isPrivateIP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hn);
        if (isLoopback || isPrivateIP) {
            console.warn(`[Bot Register] Rejected local/private webhook: ${webhook_url}`);
            const fix = getWebhookFixInstructions('localhost_rejected', openclaw_version);
            return res.status(400).json({
                success: false,
                error_type: 'localhost_rejected',
                message: `Webhook registration failed: webhook_url points to a local/private address (${hn}) which is unreachable from the internet.\n\n${fix}`,
                openclaw_version_received: openclaw_version || null
            });
        }
        // DNS rebinding protection: resolve hostname and verify resolved IP is not private
        await assertPublicResolvedIp(hn);
    } catch (e) {
        if (e.message === 'Internal URLs not allowed') {
            console.warn(`[Bot Register] DNS rebinding rejected: ${webhook_url}`);
            return res.status(400).json({
                success: false,
                error_type: 'dns_rebinding_blocked',
                message: `Webhook registration failed: webhook_url resolves to a private/internal IP address.`
            });
        }
        return res.status(400).json({
            success: false,
            message: "Invalid webhook_url format"
        });
    }

    // Reject placeholder/unresolved token values (skip for Discord/Google Chat — no token needed)
    const tokenStr = (token || '').trim();
    const placeholderPattern = /^\[.*\]$|^\{.*\}$|^\$\{.*\}$|^<.*>$|^__.*__$|^process\.env\.|^your[-_]|^xxx|^test$/i;
    if (!isDiscord && !isGoogleChat && (placeholderPattern.test(tokenStr) || tokenStr.includes('gateway token') || tokenStr.includes('your-') || tokenStr.includes('TOKEN_HERE') || tokenStr.includes('REDACTED') || tokenStr.includes('PLACEHOLDER'))) {
        console.warn(`[Bot Register] Rejected placeholder token: "${tokenStr}"`);
        return res.status(400).json({
            success: false,
            message: "token appears to be a placeholder, not an actual value. " +
                "Please use the real token from your environment variable (e.g. process.env.OPENCLAW_GATEWAY_TOKEN) " +
                "or query your gateway config to get the actual token string.",
            hint: "If using Zeabur: token = process.env.OPENCLAW_GATEWAY_TOKEN",
            received: tokenStr
        });
    }

    // Clean token: Remove "Bearer " prefix if present (case-insensitive)
    // This prevents "Bearer Bearer xyz" issue when backend adds Bearer prefix during push
    let cleanToken = tokenStr;
    if (!isDiscord && !isGoogleChat) {
        if (cleanToken.toLowerCase().startsWith('bearer ')) {
            cleanToken = cleanToken.substring(7).trim(); // Remove "Bearer " (7 chars)
            console.log(`[Bot Register] Cleaned token: removed "Bearer " prefix`);
        }
    }

    // Normalize webhook URL: fix double slashes in path (e.g. https://x.com//tools/invoke)
    const urlObj2 = new URL(webhook_url);
    urlObj2.pathname = urlObj2.pathname.replace(/\/\/+/g, '/');
    const finalUrl = urlObj2.toString().replace(/\/$/, '');

    const tokenPreview = cleanToken.length > 8 ? cleanToken.substring(0, 4) + '...' + cleanToken.substring(cleanToken.length - 4) : '***';

    // ── Discord webhook: simplified registration (no session key, no OpenClaw handshake) ──
    if (isDiscord) {
        console.log(`[Bot Register] Discord webhook detected: ${finalUrl}`);

        // Handshake: send a test message to Discord
        try {
            const testResponse = await discordPush(finalUrl, `✅ EClaw webhook connected! (Device ${deviceId} Entity ${eId})`);

            if (!testResponse.ok) {
                const errText = await testResponse.text().catch(() => '');
                console.error(`[Bot Register] ✗ Discord handshake FAILED: HTTP ${testResponse.status}`);
                serverLog('error', 'handshake', `Discord handshake HTTP ${testResponse.status}`, { deviceId, entityId: eId, metadata: { error: errText.substring(0, 300) } });
                return res.status(400).json({
                    success: false,
                    error_type: `discord_http_${testResponse.status}`,
                    message: `Discord webhook handshake failed (HTTP ${testResponse.status}). ` +
                        (testResponse.status === 404 ? 'Webhook URL is invalid or has been deleted.' :
                         testResponse.status === 401 || testResponse.status === 403 ? 'Webhook token is invalid.' :
                         testResponse.status === 429 ? 'Discord rate limit hit. Try again later.' :
                         `Discord responded: ${errText.substring(0, 200)}`),
                    debug: { url: finalUrl, httpStatus: testResponse.status }
                });
            }

            // Discord returns 204 No Content on success
            console.log(`[Bot Register] ✓ Discord handshake OK (HTTP ${testResponse.status})`);
        } catch (err) {
            console.error(`[Bot Register] ✗ Discord handshake error:`, err.message);
            return res.status(400).json({
                success: false,
                error_type: 'discord_connection_failed',
                message: `Cannot reach Discord webhook: ${err.message}`
            });
        }

        // Store Discord webhook
        entity.webhook = {
            url: finalUrl,
            token: null,
            sessionKey: null,
            type: 'discord',
            registeredAt: Date.now()
        };
        entity.pushStatus = { ok: true, at: Date.now() };
        serverLog('info', 'bind', `Discord webhook registered for Entity ${eId}`, { deviceId, entityId: eId });

        // Persist
        db.saveEntity(deviceId, eId, entity);
        io.to(`device:${deviceId}`).emit('entity:update', { deviceId, entityId: eId, name: entity.name, character: entity.character, state: entity.state, message: entity.message });

        return res.json({
            success: true,
            message: "Discord webhook registered successfully",
            webhook_type: 'discord',
            push_mode: 'discord',
            push_status_hint: "Discord webhooks are stateless — no polling needed."
        });
    }

    // ── Google Chat webhook: simplified registration (no session key, no OpenClaw handshake) ──
    if (isGoogleChat) {
        console.log(`[Bot Register] Google Chat webhook detected: ${finalUrl}`);

        // Handshake: send a test message to Google Chat
        try {
            const testResponse = await googleChatPush(finalUrl, `✅ EClaw webhook connected! (Device ${deviceId} Entity ${eId})`);

            if (!testResponse.ok) {
                const errText = await testResponse.text().catch(() => '');
                console.error(`[Bot Register] ✗ Google Chat handshake FAILED: HTTP ${testResponse.status}`);
                serverLog('error', 'handshake', `Google Chat handshake HTTP ${testResponse.status}`, { deviceId, entityId: eId, metadata: { error: errText.substring(0, 300) } });
                return res.status(400).json({
                    success: false,
                    error_type: `google_chat_http_${testResponse.status}`,
                    message: `Google Chat webhook handshake failed (HTTP ${testResponse.status}). ` +
                        (testResponse.status === 404 ? 'Webhook URL is invalid or space not found.' :
                         testResponse.status === 401 || testResponse.status === 403 ? 'Webhook key or token is invalid.' :
                         testResponse.status === 429 ? 'Google Chat rate limit hit. Try again later.' :
                         `Google Chat responded: ${errText.substring(0, 200)}`),
                    debug: { url: finalUrl, httpStatus: testResponse.status }
                });
            }

            console.log(`[Bot Register] ✓ Google Chat handshake OK (HTTP ${testResponse.status})`);
        } catch (err) {
            console.error(`[Bot Register] ✗ Google Chat handshake error:`, err.message);
            return res.status(400).json({
                success: false,
                error_type: 'google_chat_connection_failed',
                message: `Cannot reach Google Chat webhook: ${err.message}`
            });
        }

        // Store Google Chat webhook
        entity.webhook = {
            url: finalUrl,
            token: null,
            sessionKey: null,
            type: 'google-chat',
            registeredAt: Date.now()
        };
        entity.pushStatus = { ok: true, at: Date.now() };
        serverLog('info', 'bind', `Google Chat webhook registered for Entity ${eId}`, { deviceId, entityId: eId });

        // Persist
        db.saveEntity(deviceId, eId, entity);
        io.to(`device:${deviceId}`).emit('entity:update', { deviceId, entityId: eId, name: entity.name, character: entity.character, state: entity.state, message: entity.message });

        return res.json({
            success: true,
            message: "Google Chat webhook registered successfully",
            webhook_type: 'google-chat',
            push_mode: 'google-chat',
            push_status_hint: "Google Chat webhooks are stateless — no polling needed."
        });
    }

    // ── OpenClaw Handshake: dry-run test of sessions_send via /tools/invoke ──
    // Instead of checking /tools/list (unreliable), actually invoke sessions_send
    // with a harmless test message to verify the full push pipeline works.
    const handshakePayload = {
        tool: "sessions_send",
        args: {
            sessionKey: session_key,
            message: `[SYSTEM:HANDSHAKE_TEST] Webhook 如果收到此訊息則綁定成功! (Device ${deviceId} Entity ${eId})`
        }
    };

    console.log(`[Bot Register] Handshake: dry-run invoking sessions_send at ${finalUrl}...`);

    try {
        const probeResponse = await gatewayFetch(finalUrl, cleanToken, handshakePayload, {
            setupUsername: setup_username,
            setupPassword: setup_password,
            timeout: 5000 // 5s timeout - real failures return in < 1s; timeout = success
        });

        const responseText = await probeResponse.text().catch(() => '');

        if (!probeResponse.ok) {
            console.error(`[Bot Register] ✗ Handshake FAILED: ${finalUrl} returned HTTP ${probeResponse.status}`);
            console.error(`[Bot Register] Response: ${responseText}`);
            serverLog('error', 'handshake', `Handshake HTTP ${probeResponse.status}: ${finalUrl}`, { deviceId, entityId: eId, metadata: { status: probeResponse.status, error: responseText.substring(0, 300) } });

            // Parse error for specific failure reasons
            let parsedError = null;
            try { parsedError = JSON.parse(responseText); } catch (e) { }
            const errorMessage = parsedError?.error?.message || responseText;

            if (probeResponse.status === 401) {
                logHandshakeFailure({ deviceId, entityId: eId, webhookUrl: finalUrl, errorType: 'http_401', httpStatus: 401, errorMessage, responseBody: responseText, source: 'bot_register' });

                // Check if this is a SETUP_PASSWORD issue (bot didn't send setup credentials)
                if (!setup_username || !setup_password) {
                    return res.status(400).json({
                        success: false,
                        error_type: 'setup_password_required',
                        message: "Webhook handshake failed: your gateway has SETUP_PASSWORD enabled (HTTP 401). " +
                            "You need to include setup_username and setup_password in the registration request.\n\n" +
                            "AUTO-FIX STEPS:\n" +
                            "Step 1: Read your SETUP_PASSWORD:\n  exec: echo $SETUP_PASSWORD\n" +
                            "Step 2: Retry POST /api/bot/register with the SAME parameters PLUS these two extra fields:\n" +
                            '  "setup_username": "admin",\n' +
                            '  "setup_password": "<the value from Step 1>"\n\n' +
                            "IMPORTANT: Copy the EXACT output of echo $SETUP_PASSWORD — do NOT use a placeholder.",
                        openclaw_version_received: openclaw_version || null,
                        retry_hint: {
                            add_fields: {
                                setup_username: "admin",
                                setup_password: "VALUE_OF_$SETUP_PASSWORD"
                            },
                            get_password_command: "echo $SETUP_PASSWORD"
                        },
                        debug: { probeUrl: finalUrl, httpStatus: 401, tokenPreview }
                    });
                }

                // Bot sent setup credentials but still got 401 — token or password is wrong
                const fix = getWebhookFixInstructions('http_401', openclaw_version);
                return res.status(400).json({
                    success: false,
                    error_type: 'http_401',
                    message: `Webhook handshake failed: gateway rejected credentials (HTTP 401). ` +
                        `setup_username/setup_password were provided but authentication still failed.\n\n` +
                        `Possible causes:\n` +
                        `1. setup_password is incorrect — re-read with: exec: echo $SETUP_PASSWORD\n` +
                        `2. Gateway token is wrong — re-read with: exec: echo $OPENCLAW_GATEWAY_TOKEN\n` +
                        `3. Both values may have changed after a gateway restart.\n\n${fix}`,
                    openclaw_version_received: openclaw_version || null,
                    debug: { probeUrl: finalUrl, httpStatus: probeResponse.status, tokenPreview }
                });
            }

            if (probeResponse.status === 404 || errorMessage.includes('not available') || errorMessage.includes('not found')) {
                logHandshakeFailure({ deviceId, entityId: eId, webhookUrl: finalUrl, errorType: 'tool_not_available', httpStatus: probeResponse.status, errorMessage, responseBody: responseText, source: 'bot_register' });
                const fix = getWebhookFixInstructions('tool_not_available', openclaw_version);
                return res.status(400).json({
                    success: false,
                    error_type: 'tool_not_available',
                    message: `Webhook handshake failed: gateway cannot execute 'sessions_send' tool. Server responded: "${errorMessage}".\n\n${fix}`,
                    openclaw_version_received: openclaw_version || null,
                    debug: { probeUrl: finalUrl, httpStatus: probeResponse.status, serverError: errorMessage }
                });
            }

            // Other errors - reject registration
            logHandshakeFailure({ deviceId, entityId: eId, webhookUrl: finalUrl, errorType: `http_${probeResponse.status}`, httpStatus: probeResponse.status, errorMessage, responseBody: responseText, source: 'bot_register' });
            return res.status(400).json({
                success: false,
                error_type: `http_${probeResponse.status}`,
                message: `Webhook handshake failed: gateway returned HTTP ${probeResponse.status}. Server responded: "${errorMessage}". Check your gateway logs for more details.`,
                openclaw_version_received: openclaw_version || null,
                debug: { probeUrl: finalUrl, httpStatus: probeResponse.status, serverError: errorMessage }
            });
        }

        // Check for gateway disconnection / pairing required in response body
        // (OpenClaw returns HTTP 200 but with error in body)
        if (responseText && (responseText.includes('pairing required') || responseText.includes('gateway closed'))) {
            console.error(`[Bot Register] ✗ Handshake FAILED: gateway disconnected (pairing required)`);
            console.error(`[Bot Register] Response: ${responseText.substring(0, 300)}`);
            serverLog('error', 'handshake', `Handshake pairing required: ${finalUrl}`, { deviceId, entityId: eId });
            logHandshakeFailure({ deviceId, entityId: eId, webhookUrl: finalUrl, errorType: 'pairing_required', httpStatus: 200, errorMessage: 'gateway closed (1008): pairing required', responseBody: responseText?.substring(0, 500), source: 'bot_register_handshake' });
            const fix = getWebhookFixInstructions('pairing_required', openclaw_version);
            return res.status(400).json({
                success: false,
                error_type: 'pairing_required',
                message: `Webhook handshake failed: bot gateway is disconnected (pairing required).\n\n${fix}`,
                openclaw_version_received: openclaw_version || null,
                debug: { probeUrl: finalUrl, httpStatus: 200, bodyError: 'pairing_required' }
            });
        }

        // Success - sessions_send actually works
        console.log(`[Bot Register] ✓ Handshake OK: sessions_send dry-run succeeded (HTTP ${probeResponse.status})`);
        console.log(`[Bot Register] Handshake response: ${responseText.substring(0, 200)}`);

    } catch (probeErr) {
        // Differentiate timeout vs connection failure
        // Timeout = gateway accepted the request, AI model is processing = SUCCESS
        // ECONNREFUSED / DNS error = gateway is truly unreachable = FAILURE
        const isTimeout = probeErr.name === 'TimeoutError' || probeErr.name === 'AbortError' ||
            probeErr.message?.includes('timed out') || probeErr.message?.includes('aborted');

        if (isTimeout) {
            // Timeout means gateway accepted the request and started processing
            // (real failures like 404/401 return in < 1 second)
            console.log(`[Bot Register] ✓ Handshake OK: request accepted by gateway (timed out waiting for AI response, which is expected)`);
        } else {
            // Actual connection failure - gateway is unreachable
            console.error(`[Bot Register] ✗ Handshake connection failed: ${probeErr.message}`);
            serverLog('error', 'handshake', `Handshake connection failed: ${probeErr.message}`, { deviceId, entityId: eId, metadata: { url: finalUrl } });
            logHandshakeFailure({ deviceId, entityId: eId, webhookUrl: finalUrl, errorType: 'connection_failed', errorMessage: probeErr.message, source: 'bot_register' });
            const fix = getWebhookFixInstructions('localhost_rejected', openclaw_version);
            return res.status(400).json({
                success: false,
                error_type: 'connection_failed',
                message: `Webhook handshake failed: cannot reach gateway at ${finalUrl}. Error: ${probeErr.message}.\n\n${fix}`,
                openclaw_version_received: openclaw_version || null,
                debug: { probeUrl: finalUrl, error: probeErr.message }
            });
        }
    }

    // ── Handshake passed: store webhook info ──
    entity.webhook = {
        url: finalUrl,
        token: cleanToken,
        sessionKey: session_key,
        registeredAt: Date.now(),
        setupUsername: setup_username || null,
        setupPassword: setup_password || null
    };
    entity.pushStatus = { ok: true, at: Date.now() };

    console.log(`[Bot Register] Device ${deviceId} Entity ${eId} webhook registered: ${finalUrl} (token: ${tokenPreview}, len: ${cleanToken.length})`);

    // Save data after webhook registration
    saveData();

    // Build diagnostic warnings for the bot
    const warnings = [];
    if (webhook_url !== finalUrl) {
        warnings.push(`webhook_url was normalized: "${webhook_url}" → "${finalUrl}" (trailing slash removed)`);
    }
    if (cleanToken.length < 10) {
        warnings.push(`token is suspiciously short (${cleanToken.length} chars). Verify it is the correct gateway token.`);
    }
    if (!finalUrl.startsWith('https://')) {
        warnings.push(`webhook_url is not HTTPS. This may cause issues in production.`);
    }

    const apiBase = `https://${req.get('host') || 'eclawbot.com'}`;

    res.json({
        success: true,
        message: "Webhook registered. You will now receive push notifications.",
        deviceId: deviceId,
        entityId: eId,
        mode: "push",
        push_status_url: `${apiBase}/api/bot/push-status?deviceId=${deviceId}&entityId=${eId}&botSecret=${entity.botSecret}`,
        push_status_hint: "Poll this endpoint periodically to check if push is still healthy. If push_status.ok is false, re-register webhook via POST /api/bot/register.",
        debug: {
            webhook_url_registered: finalUrl,
            token_length: cleanToken.length,
            token_preview: tokenPreview,
            session_key: session_key,
            handshake: "sessions_send verified",
            warnings: warnings.length > 0 ? warnings : undefined
        }
    });
});

/**
 * DELETE /api/bot/register
 * Bot unregisters its webhook (switch back to polling mode).
 */
app.delete('/api/bot/register', (req, res) => {
    const deviceId = req.body.deviceId || req.query.deviceId;
    const entityId = req.body.entityId ?? req.query.entityId;
    const botSecret = req.body.botSecret || req.query.botSecret;

    if (!deviceId) {
        return res.status(400).json({ success: false, message: "deviceId required" });
    }

    const eId = parseInt(entityId) || 0;
    if (eId < 0) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    if (!isValidEntityId(device, eId)) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const entity = device.entities[eId];

    if (!botSecret || !safeEqual(botSecret, entity.botSecret)) {
        return res.status(403).json({ success: false, message: "Invalid botSecret" });
    }

    entity.webhook = null;
    console.log(`[Bot Register] Device ${deviceId} Entity ${eId} webhook removed`);

    res.json({
        success: true,
        message: "Webhook removed. Switching back to polling mode.",
        deviceId: deviceId,
        entityId: eId,
        mode: "polling"
    });
});

/**
 * GET /api/bot/push-status
 * Bot checks if its push notifications are still healthy.
 * Query: ?deviceId=xxx&entityId=0&botSecret=xxx
 */
app.get('/api/bot/push-status', (req, res) => {
    const { deviceId, entityId, botSecret } = req.query;

    if (!deviceId) {
        return res.status(400).json({ success: false, message: "deviceId required" });
    }

    const eId = parseInt(entityId) || 0;
    if (eId < 0) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    if (!isValidEntityId(device, eId)) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const entity = device.entities[eId];

    if (!botSecret || !safeEqual(botSecret, entity.botSecret)) {
        return res.status(403).json({ success: false, message: "Invalid botSecret" });
    }

    const result = {
        success: true,
        deviceId,
        entityId: eId,
        webhook_registered: !!entity.webhook,
        push_status: entity.pushStatus || null
    };

    if (entity.pushStatus && !entity.pushStatus.ok) {
        result.action_required = "Push is failing. Re-register webhook via POST /api/bot/register to restore push notifications.";
    }

    res.json(result);
});

/**
 * GET /api/bot/pending-messages
 * Bot polls for pending messages (alternative to webhook push).
 * Body: { deviceId, entityId, botSecret }
 * 
 * Returns messages from messageQueue and clears them after delivery.
 * Supports both push and polling modes.
 */
app.post('/api/bot/pending-messages', async (req, res) => {
    const { deviceId, entityId, botSecret } = req.body;

    if (!deviceId) {
        return res.status(400).json({ success: false, message: "deviceId required" });
    }

    const eId = parseInt(entityId) ?? 0;
    if (eId < 0) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    if (!isValidEntityId(device, eId)) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const entity = device.entities[eId];

    // botSecret required for authentication
    if (!botSecret || !safeEqual(botSecret, entity.botSecret)) {
        return res.status(403).json({ success: false, message: "Invalid botSecret" });
    }

    // Get messages from messageQueue
    const messages = entity.messageQueue || [];

    // Clear messageQueue after delivery (bot acknowledges receipt)
    entity.messageQueue = [];

    // Update entity status
    entity.lastUpdated = Date.now();

    res.json({
        success: true,
        deviceId: deviceId,
        entityId: eId,
        messages: messages,
        messageCount: messages.length,
        mode: entity.webhook ? "push" : "polling"
    });
});

/**
 * WebSocket connection pool for OpenClaw gateways with SETUP_PASSWORD.
 * HTTP cannot carry both Basic Auth (SETUP_PASSWORD) and Bearer Token (Gateway Token)
 * simultaneously, so we use WebSocket which separates the two auth layers:
 * - Basic Auth goes in the HTTP upgrade headers
 * - Gateway Token + SETUP_PASSWORD go in the WebSocket connect message
 */
const wsConnectionPool = new Map(); // wsUrl -> { ws, connected, reqId, pending, lastUsed, closeTimer }
const WS_POOL_TTL = 120000; // 2 minutes idle before closing

/**
 * Map HTTP /tools/invoke tool names to WebSocket method names.
 */
const TOOL_TO_WS_METHOD = {
    sessions_list: 'sessions.list',
    sessions_send: 'chat.send',
};

/**
 * Convert HTTP webhook URL to WebSocket URL.
 * e.g., https://example.com/tools/invoke -> wss://example.com
 */
function httpToWsUrl(httpUrl) {
    const u = new URL(httpUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/';
    return u.toString().replace(/\/$/, '');
}

/**
 * Get or create a WebSocket connection to a gateway with SETUP_PASSWORD.
 * Returns a connected, authenticated connection ready for tool invocations.
 */
async function getWsConnection(httpUrl, token, setupUsername, setupPassword) {
    const wsUrl = httpToWsUrl(httpUrl);
    const existing = wsConnectionPool.get(wsUrl);

    if (existing && existing.ws.readyState === WebSocket.OPEN && existing.connected) {
        existing.lastUsed = Date.now();
        // Reset close timer
        if (existing.closeTimer) { clearTimeout(existing.closeTimer); }
        existing.closeTimer = setTimeout(() => cleanupWsConnection(wsUrl), WS_POOL_TTL);
        return existing;
    }

    // Clean up stale connection if any
    if (existing) { cleanupWsConnection(wsUrl); }

    console.log(`[GatewayWS] Opening new connection to ${wsUrl}`);

    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl, {
            headers: {
                'Authorization': 'Basic ' + Buffer.from(`${setupUsername}:${setupPassword}`).toString('base64'),
                'Origin': `https://${new URL(httpUrl).host}`
            }
        });

        const conn = {
            ws,
            connected: false,
            reqId: 0,
            pending: new Map(), // id -> { resolve, reject, timer }
            lastUsed: Date.now(),
            closeTimer: null,
        };

        const connectTimeout = setTimeout(() => {
            ws.close();
            reject(new Error('WebSocket connect timeout (10s)'));
        }, 10000);

        ws.on('open', () => {
            // Send connect message
            const id = `eclaw-${++conn.reqId}`;
            ws.send(JSON.stringify({
                type: 'req', id, method: 'connect',
                params: {
                    minProtocol: 3, maxProtocol: 3,
                    client: { id: 'openclaw-probe', version: 'dev', platform: 'node', mode: 'probe' },
                    role: 'operator', scopes: ['operator.admin'],
                    auth: { token, password: setupPassword },
                    caps: [],
                    userAgent: 'eclaw-backend/1.0'
                }
            }));

            // Wait for connect response (ignore challenge events)
            const onMessage = (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.type === 'event') return; // Ignore challenge, health events
                    if (msg.type === 'res' && msg.id === id) {
                        ws.removeListener('message', onMessage);
                        clearTimeout(connectTimeout);
                        if (msg.ok) {
                            conn.connected = true;
                            conn.closeTimer = setTimeout(() => cleanupWsConnection(wsUrl), WS_POOL_TTL);
                            wsConnectionPool.set(wsUrl, conn);

                            // Set up persistent message handler
                            ws.on('message', (d) => handleWsMessage(wsUrl, d));
                            ws.on('close', () => { conn.connected = false; wsConnectionPool.delete(wsUrl); });
                            ws.on('error', (err) => { console.error(`[GatewayWS] Error on ${wsUrl}:`, err.message); });

                            console.log(`[GatewayWS] Connected to ${wsUrl}`);
                            resolve(conn);
                        } else {
                            ws.close();
                            reject(new Error(`WebSocket connect rejected: ${JSON.stringify(msg.error)}`));
                        }
                    }
                } catch (e) { /* ignore parse errors */ }
            };
            ws.on('message', onMessage);
        });

        ws.on('error', (err) => {
            clearTimeout(connectTimeout);
            reject(new Error(`WebSocket error: ${err.message}`));
        });
    });
}

/**
 * Handle incoming WebSocket messages (responses to our requests).
 */
function handleWsMessage(wsUrl, data) {
    try {
        const msg = JSON.parse(data.toString());
        if (msg.type !== 'res') return; // Ignore events

        const conn = wsConnectionPool.get(wsUrl);
        if (!conn) return;

        const pending = conn.pending.get(msg.id);
        if (!pending) return;

        conn.pending.delete(msg.id);
        if (pending.timer) clearTimeout(pending.timer);

        pending.resolve(msg);
    } catch (e) { /* ignore */ }
}

/**
 * Clean up a WebSocket connection from the pool.
 */
function cleanupWsConnection(wsUrl) {
    const conn = wsConnectionPool.get(wsUrl);
    if (!conn) return;
    if (conn.closeTimer) clearTimeout(conn.closeTimer);
    // Reject all pending requests
    for (const [, p] of conn.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error('WebSocket connection closed'));
    }
    conn.pending.clear();
    try { conn.ws.close(); } catch (e) { /* ignore */ }
    wsConnectionPool.delete(wsUrl);
    console.log(`[GatewayWS] Closed connection to ${wsUrl}`);
}

/**
 * Invoke a tool on a gateway via WebSocket.
 * Returns a fake fetch Response-like object for compatibility with existing callers.
 */
async function gatewayWsFetch(httpUrl, token, body, options) {
    const { setupUsername, setupPassword, timeout } = options;
    const tool = body.tool;
    const args = body.args || {};

    // Map tool name to WebSocket method
    const wsMethod = TOOL_TO_WS_METHOD[tool];
    if (!wsMethod) {
        return { ok: false, status: 400, text: async () => `Unknown tool: ${tool}` };
    }

    try {
        const conn = await getWsConnection(httpUrl, token, setupUsername, setupPassword);

        // Build WebSocket request params
        const params = { ...args };
        if (wsMethod === 'chat.send') {
            // chat.send requires idempotencyKey
            params.idempotencyKey = `eclaw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        }

        // Send request and wait for response
        const id = `eclaw-${++conn.reqId}`;
        const requestTimeout = timeout || 15000;

        const wsResponse = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                conn.pending.delete(id);
                reject(new Error(`WebSocket request timeout (${requestTimeout}ms)`));
            }, requestTimeout);

            conn.pending.set(id, { resolve, reject, timer });

            conn.ws.send(JSON.stringify({
                type: 'req', id, method: wsMethod, params
            }));
        });

        conn.lastUsed = Date.now();

        // Convert WebSocket response to fetch-Response-like object
        if (wsResponse.ok) {
            const payload = wsResponse.payload || {};
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify(payload)
            };
        } else {
            const errMsg = wsResponse.error?.message || 'Unknown error';
            // Check if this is a "session not found" error — match HTTP behavior
            const isSessionNotFound = errMsg.toLowerCase().includes('session') ||
                errMsg.toLowerCase().includes('not found');
            if (isSessionNotFound) {
                // HTTP API returns 200 with "No session found" in body
                return {
                    ok: true,
                    status: 200,
                    text: async () => `No session found: ${errMsg}`
                };
            }
            return {
                ok: false,
                status: 400,
                text: async () => JSON.stringify({ error: errMsg })
            };
        }
    } catch (err) {
        console.error(`[GatewayWS] Invocation failed:`, err.message);
        serverLog('error', 'handshake', `GatewayWS invocation failed: ${err.message}`, {});
        return {
            ok: false,
            status: 502,
            text: async () => `WebSocket gateway error: ${err.message}`
        };
    }
}

/**
 * Helper: Authenticated fetch to an OpenClaw gateway.
 * When setupUsername/setupPassword are provided (Railway with SETUP_PASSWORD),
 * routes through WebSocket to bypass the HTTP Basic Auth / Bearer Token conflict.
 * When not provided, uses standard HTTP with Bearer Token (Zeabur default).
 */
/**
 * Helper: Detect if a webhook URL is a Discord webhook.
 * Discord webhooks follow: https://discord.com/api/webhooks/{id}/{token}
 *                      or: https://discordapp.com/api/webhooks/{id}/{token}
 */
function isDiscordWebhook(url) {
    try {
        const u = new URL(url);
        return (u.hostname === 'discord.com' || u.hostname === 'discordapp.com') &&
               u.pathname.startsWith('/api/webhooks/');
    } catch { return false; }
}

/**
 * Helper: Push a message to a Discord webhook.
 * Discord webhooks accept POST with JSON body: { content, embeds?, components? }
 * Docs: https://discord.com/developers/docs/resources/webhook#execute-webhook
 */
async function discordPush(url, messageContent, discordOptions = {}) {
    const body = { content: messageContent };

    // Merge rich message options (embeds, components) if provided
    if (discordOptions.embeds && Array.isArray(discordOptions.embeds)) {
        body.embeds = discordOptions.embeds.slice(0, 10); // Discord limit: 10 embeds
    }
    if (discordOptions.components && Array.isArray(discordOptions.components)) {
        body.components = discordOptions.components.slice(0, 5); // Discord limit: 5 action rows
    }
    if (discordOptions.username) {
        body.username = discordOptions.username;
    }
    if (discordOptions.avatar_url) {
        body.avatar_url = discordOptions.avatar_url;
    }

    // Discord has a 2000 char limit for content
    if (body.content && body.content.length > 2000) {
        body.content = body.content.substring(0, 1997) + '...';
    }

    const DEFAULT_TIMEOUT = 15000;
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT)
    });
}

/**
 * Helper: Detect if a webhook URL is a Google Chat webhook.
 * Google Chat webhooks follow: https://chat.googleapis.com/v1/spaces/{spaceId}/messages?key=...&token=...
 */
function isGoogleChatWebhook(url) {
    try {
        const u = new URL(url);
        return u.hostname === 'chat.googleapis.com' &&
               u.pathname.startsWith('/v1/spaces/');
    } catch { return false; }
}

/**
 * Helper: Push a message to a Google Chat webhook.
 * Google Chat webhooks accept POST with JSON body.
 * Supports plain text and cardsV2 rich message format.
 * Docs: https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages#Message
 */
async function googleChatPush(url, messageContent, googleChatOptions = {}) {
    const body = { text: messageContent };

    // Merge rich message options (cardsV2) if provided
    if (googleChatOptions.cardsV2 && Array.isArray(googleChatOptions.cardsV2)) {
        body.cardsV2 = googleChatOptions.cardsV2;
    }

    // Google Chat has a 4096 char limit for text
    if (body.text && body.text.length > 4096) {
        body.text = body.text.substring(0, 4093) + '...';
    }

    const DEFAULT_TIMEOUT = 15000;
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT)
    });
}

async function gatewayFetch(url, token, body, options = {}) {
    const { setupUsername, setupPassword, timeout, signal } = options;

    // DNS rebinding protection: verify resolved IP is not private
    await assertPublicResolvedIp(new URL(url).hostname);

    if (setupUsername && setupPassword) {
        // WebSocket transport for gateways with SETUP_PASSWORD
        return gatewayWsFetch(url, token, body, options);
    }

    // HTTP transport (existing behavior for gateways without SETUP_PASSWORD)
    const headers = { 'Content-Type': 'application/json' };
    headers['Authorization'] = `Bearer ${token}`;

    // Default 15s timeout to prevent infinite hangs on unresponsive webhooks (#181)
    const DEFAULT_HTTP_TIMEOUT = 15000;
    return fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: signal || AbortSignal.timeout(timeout || DEFAULT_HTTP_TIMEOUT)
    });
}

/**
 * Helper: Discover existing sessions on the OpenClaw gateway via sessions_list.
 * Returns array of session key strings, or empty array on failure.
 */
async function discoverSessions(url, token, authOpts = {}) {
    try {
        console.log(`[Session] Discovering sessions on gateway ${url}`);
        const response = await gatewayFetch(url, token, { tool: "sessions_list", args: {} }, authOpts);

        const text = await response.text().catch(() => '');
        console.log(`[Session] sessions_list response (${response.status}): ${text.substring(0, 500)}`);

        if (!response.ok) {
            console.warn(`[Session] sessions_list not available (${response.status})`);
            return [];
        }

        // Parse response - OpenClaw returns { ok: true, result: { content: [{ text: "..." }] } }
        try {
            const json = JSON.parse(text);
            const content = json?.result?.content?.[0]?.text || json?.result?.text || text;
            // content might be JSON string of sessions array or object
            const parsed = typeof content === 'string' ? JSON.parse(content) : content;

            // Extract session keys - could be array of strings or objects with key/sessionKey field
            if (Array.isArray(parsed)) {
                return parsed.map(s => typeof s === 'string' ? s : (s.sessionKey || s.key || s.id || '')).filter(Boolean);
            } else if (parsed.sessions && Array.isArray(parsed.sessions)) {
                return parsed.sessions.map(s => typeof s === 'string' ? s : (s.sessionKey || s.key || s.id || '')).filter(Boolean);
            }
        } catch (parseErr) {
            // Try regex fallback - look for session key patterns in raw text
            const matches = text.match(/"(sessionKey|key|id)"\s*:\s*"([^"]+)"/g);
            if (matches) {
                return matches.map(m => m.match(/"([^"]+)"$/)?.[1]).filter(Boolean);
            }
        }

        return [];
    } catch (err) {
        console.error(`[Session] Error discovering sessions:`, err.message);
        return [];
    }
}

/**
 * Helper: Handshake with bot during binding.
 * 1. Try sessions_send with bot's configured session key
 * 2. If "No session found", discover existing sessions via sessions_list
 * 3. Use first available session, send binding notification
 * 4. Return working session key and bot's response
 */
async function handshakeWithBot(url, token, preferredSessionKey, deviceId, entityId, botType, authOpts = {}) {
    const bindMsg = `[SYSTEM:BIND_HANDSHAKE] New binding: Device ${deviceId}, Entity ${entityId}, Type: ${botType}. Reply OK to confirm.`;

    // Step 1: Try preferred session key
    console.log(`[Handshake] Trying preferred session key: ${preferredSessionKey}...`);
    let result = await sendToSession(url, token, preferredSessionKey, bindMsg, authOpts);

    if (result.success) {
        console.log(`[Handshake] ✓ Handshake OK with preferred key`);
        return { success: true, sessionKey: preferredSessionKey, botResponse: result.botResponse };
    }

    // Step 2: If session not found, discover existing sessions
    if (result.sessionNotFound) {
        console.log(`[Handshake] Preferred session not found, discovering sessions...`);
        const sessions = await discoverSessions(url, token, authOpts);
        console.log(`[Handshake] Discovered ${sessions.length} sessions: ${JSON.stringify(sessions)}`);

        for (const sk of sessions) {
            console.log(`[Handshake] Trying discovered session: ${sk}...`);
            result = await sendToSession(url, token, sk, bindMsg, authOpts);
            if (result.success) {
                console.log(`[Handshake] ✓ Handshake OK with discovered key: ${sk}`);
                return { success: true, sessionKey: sk, botResponse: result.botResponse };
            }
        }
    }

    console.error(`[Handshake] ✗ All session attempts failed. Bot gateway may not have active sessions.`);
    serverLog('error', 'handshake', `All session attempts failed for Entity ${entityId}`, { deviceId, entityId, metadata: { url } });
    logHandshakeFailure({ deviceId, entityId, webhookUrl: url, errorType: 'no_sessions', errorMessage: result.error || 'No working session found on gateway', source: 'bind_handshake' });
    return { success: false, error: result.error || 'No working session found on gateway' };
}

/**
 * Helper: Send a message to a specific session and parse the response.
 */
async function sendToSession(url, token, sessionKey, message, authOpts = {}, options = {}) {
    try {
        const fetchOpts = { ...authOpts };
        if (options.timeout) fetchOpts.timeout = options.timeout;
        const response = await gatewayFetch(url, token, {
            tool: "sessions_send",
            args: { sessionKey, message }
        }, fetchOpts);

        const text = await response.text().catch(() => '');

        if (!response.ok) {
            logHandshakeFailure({ webhookUrl: url, errorType: `http_${response.status}`, httpStatus: response.status, errorMessage: text, responseBody: text, source: 'send_session' });
            return { success: false, error: `HTTP ${response.status}: ${text}` };
        }

        // Check for "No session found" in response body (gateway returns 200 but with error)
        if (text.includes('No session found')) {
            return { success: false, sessionNotFound: true, error: text };
        }

        // Try to extract bot's response text
        let botResponse = '';
        try {
            const json = JSON.parse(text);
            const content = json?.result?.content?.[0]?.text || '';
            // The content might be a JSON string with runId/result
            try {
                const inner = JSON.parse(content);
                botResponse = inner?.result || inner?.response || inner?.message || content;
            } catch {
                botResponse = content;
            }
        } catch {
            botResponse = text;
        }

        return { success: true, botResponse };
    } catch (err) {
        logHandshakeFailure({ webhookUrl: url, errorType: 'connection_failed', errorMessage: err.message, source: 'send_session' });
        return { success: false, error: err.message };
    }
}

/**
 * Helper: Generate Mission Dashboard API hints for bot push notifications.
 * Appended to every push so the bot's LLM always has the tool signatures in context.
 */
function getMissionApiHints(apiBase, deviceId, entityId, botSecret) {
    const twTime = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '');
    let hints = `\n\n[AVAILABLE TOOLS — Mission Dashboard]\n`;
    hints += `Current Taiwan Time: ${twTime} (UTC+8)\n`;
    hints += `Read tasks/notes/rules/skills: exec: curl -s "${apiBase}/api/mission/dashboard?deviceId=${deviceId}&botSecret=${botSecret}&entityId=${entityId}"\n`;
    hints += `Read notes: exec: curl -s "${apiBase}/api/mission/notes?deviceId=${deviceId}&botSecret=${botSecret}&entityId=${entityId}"\n`;
    hints += `Mark TODO done: exec: curl -s -X POST "${apiBase}/api/mission/todo/done" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${entityId},"botSecret":"${botSecret}","title":"TASK_TITLE"}'\n`;
    hints += `Add note: exec: curl -s -X POST "${apiBase}/api/mission/note/add" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${entityId},"botSecret":"${botSecret}","title":"TITLE","content":"CONTENT"}'\n`;
    return hints;
}

/**
 * Helper: Build IDENTITY_SETUP_REQUIRED hint for bots without identity.
 * Only returns content when entity.identity is null — once identity is set, this disappears.
 * Delivers at most 3 times per session to avoid bloating every push message.
 */
function buildIdentitySetupHint(entity, apiBase, deviceId, entityId, botSecret) {
    if (entity.identity) return '';
    const count = entity._identityHintCount || 0;
    if (count >= 3) return '';
    entity._identityHintCount = count + 1;
    let hint = `\n\n[IDENTITY_SETUP_REQUIRED]\n`;
    hint += `You have no identity configured yet. Set your identity (role, instructions, boundaries) via:\n`;
    hint += `exec: curl -s -X PUT "${apiBase}/api/entity/identity" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${entityId},"botSecret":"${botSecret}","identity":{"role":"YOUR_ROLE","description":"WHAT_YOU_DO","instructions":["instruction1","instruction2"],"tone":"friendly","language":"zh-TW","public":{"description":"PUBLIC_DESCRIPTION_FOR_AGENT_CARD"}}}'\n`;
    hint += `Available resources to review before setting up:\n`;
    hint += `- Soul templates: exec: curl -s "${apiBase}/api/soul-templates"\n`;
    hint += `- Rule templates: exec: curl -s "${apiBase}/api/rule-templates"\n`;
    hint += `- Your dashboard: exec: curl -s "${apiBase}/api/mission/dashboard?deviceId=${deviceId}&botSecret=${botSecret}&entityId=${entityId}"\n`;
    hint += `[/IDENTITY_SETUP_REQUIRED]\n`;
    return hint;
}

/**
 * Helper: Push notification to bot webhook
 * Supports OpenClaw format: POST to /tools/invoke with tool invocation payload
 */
async function pushToBot(entity, deviceId, eventType, payload) {
    if (!entity.webhook) {
        return { pushed: false, reason: "no_webhook" };
    }

    const { url, token, sessionKey, setupUsername, setupPassword } = entity.webhook;
    const authOpts = { setupUsername, setupPassword };

    // For official bot bindings, use the per-user session key
    let effectiveSessionKey = sessionKey;
    const bindCacheKey = getBindingCacheKey(deviceId, entity.entityId);
    const officialBinding = officialBindingsCache[bindCacheKey];
    if (officialBinding && officialBinding.session_key) {
        effectiveSessionKey = officialBinding.session_key;
    }

    // Prepend pending rename notification if exists
    let messageContent = payload.message || JSON.stringify(payload);
    if (entity.pendingRename) {
        const { oldName, newName } = entity.pendingRename;
        const renameNotice = `[SYSTEM:NAME_CHANGED] 你的名字已從「${oldName}」更改為「${newName}」。請記住你現在的名字是「${newName}」。\n\n`;
        messageContent = renameNotice + messageContent;
        console.log(`[Push] Including pending rename notification: "${oldName}" -> "${newName}"`);
    }

    // Append local vars hint from DB (keys only, no decryption needed)
    try {
        const varsMeta = await db.getDeviceVarsMeta(deviceId);
        if (varsMeta && !varsMeta.is_locked && varsMeta.var_keys && varsMeta.var_keys.length > 0) {
            const varKeys = varsMeta.var_keys.join(', ');
            const apiBase = process.env.API_BASE || 'https://eclawbot.com';
            messageContent += `\n\n[Local Variables available: ${varKeys}]\nexec: curl -s "${apiBase}/api/device-vars?deviceId=${deviceId}&botSecret=${entity.botSecret}"`;
        }
    } catch (err) {
        // Non-critical — just skip the hint
    }

    // ── Discord webhook: direct POST, no session key needed ──
    if (entity.webhook.type === 'discord') {
        try {
            console.log(`[Push] Discord push to ${url} for Device ${deviceId} Entity ${entity.entityId}`);
            const discordOpts = payload.discord || {};
            if (entity.name && !discordOpts.username) {
                discordOpts.username = entity.name;
            }
            const response = await discordPush(url, messageContent, discordOpts);

            if (response.ok || response.status === 204) {
                console.log(`[Push] ✓ Discord push OK (HTTP ${response.status})`);
                if (entity.pendingRename) { entity.pendingRename = null; }
                entity.pushStatus = { ok: true, at: Date.now() };
                return { pushed: true };
            }

            const errText = await response.text().catch(() => '');
            console.error(`[Push] ✗ Discord push failed: HTTP ${response.status} — ${errText.substring(0, 200)}`);

            // Handle Discord rate limits (429) — include retry_after info
            if (response.status === 429) {
                let retryAfter = 5;
                try { retryAfter = JSON.parse(errText).retry_after || 5; } catch {}
                serverLog('warn', 'push_error', `Discord rate limited for Entity ${entity.entityId}, retry_after: ${retryAfter}s`, { deviceId, entityId: entity.entityId });
                entity.pushStatus = { ok: false, reason: 'discord_rate_limited', retryAfter, at: Date.now() };
                return { pushed: false, reason: 'discord_rate_limited', retryAfter };
            }

            serverLog('error', 'push_error', `Discord push HTTP ${response.status} for Entity ${entity.entityId}`, { deviceId, entityId: entity.entityId });
            entity.message = `[SYSTEM:WEBHOOK_ERROR] Discord push failed (HTTP ${response.status}).`;
            entity.lastUpdated = Date.now();
            entity.pushStatus = { ok: false, reason: `discord_http_${response.status}`, at: Date.now() };
            return { pushed: false, reason: `discord_http_${response.status}`, error: errText };
        } catch (err) {
            console.error(`[Push] ✗ Discord push error:`, err.message);
            serverLog('error', 'push_error', `Discord push exception for Entity ${entity.entityId}: ${err.message}`, { deviceId, entityId: entity.entityId });
            entity.pushStatus = { ok: false, reason: err.message, at: Date.now() };
            return { pushed: false, reason: err.message };
        }
    }

    // ── OpenClaw webhook: sessions_send format ──
    // Record entity state before push so we can detect if bot responded via transform during the push
    const pushStartedAt = entity.lastUpdated || 0;

    const requestPayload = {
        tool: "sessions_send",
        args: {
            sessionKey: effectiveSessionKey,
            message: messageContent
        },
        deviceId: deviceId,
        entityId: entity.entityId
    };

    try {
        console.log(`[Push] Sending to ${url} with sessionKey: ${effectiveSessionKey.substring(0, 20)}...`);
        console.log(`[Push] Payload:`, JSON.stringify(requestPayload, null, 2));

        // OpenClaw /tools/invoke format
        const response = await gatewayFetch(url, token, requestPayload, authOpts);

        if (response.ok) {
            const responseText = await response.text().catch(() => '');
            console.log(`[Push] ✓ Device ${deviceId} Entity ${entity.entityId}: ${eventType} pushed successfully (status: ${response.status})`);
            if (responseText) {
                console.log(`[Push] Response: ${responseText.substring(0, 200)}`);
            }

            // Check if response body contains "No session found" error
            // Gateway returns 200 but with error in body when session doesn't exist
            if (responseText && responseText.includes('No session found')) {
                console.warn(`[Push] Session "${effectiveSessionKey}" not found, discovering available sessions...`);
                const sessions = await discoverSessions(url, token, authOpts);
                if (sessions.length > 0) {
                    console.log(`[Push] Found ${sessions.length} sessions, trying first: ${sessions[0]}`);
                    // Try sending with the first discovered session
                    const retryPayload = {
                        ...requestPayload,
                        args: { ...requestPayload.args, sessionKey: sessions[0] }
                    };
                    const retryResponse = await gatewayFetch(url, token, retryPayload, authOpts);
                    const retryText = await retryResponse.text().catch(() => '');
                    if (retryResponse.ok && !retryText.includes('No session found')) {
                        console.log(`[Push] ✓ Retry successful with discovered session: ${sessions[0]}`);
                        // Update entity webhook sessionKey so future pushes use the correct one
                        if (entity.webhook) {
                            entity.webhook.sessionKey = sessions[0];
                            console.log(`[Push] Updated entity sessionKey to: ${sessions[0]}`);
                        }
                        if (entity.pendingRename) { entity.pendingRename = null; }
                        entity.pushStatus = { ok: true, at: Date.now() };
                        return { pushed: true };
                    } else {
                        console.error(`[Push] ✗ Retry with discovered session failed: ${retryText.substring(0, 200)}`);
                        serverLog('error', 'push_error', `Session discovery retry failed for Entity ${entity.entityId}`, { deviceId, entityId: entity.entityId, metadata: { error: retryText.substring(0, 200) } });
                        entity.pushStatus = { ok: false, reason: 'session_discovery_failed', at: Date.now() };
                        return { pushed: false, reason: 'session_discovery_retry_failed', error: retryText };
                    }
                } else {
                    console.error(`[Push] ✗ No sessions discovered on gateway`);
                    serverLog('error', 'push_error', `No sessions on gateway for Entity ${entity.entityId}`, { deviceId, entityId: entity.entityId });
                    entity.pushStatus = { ok: false, reason: 'no_sessions', at: Date.now() };
                    return { pushed: false, reason: 'no_sessions_available', error: responseText };
                }
            }

            // Check for gateway disconnection / pairing required errors
            if (responseText && (responseText.includes('pairing required') || responseText.includes('gateway closed'))) {
                console.warn(`[Push] ✗ Device ${deviceId} Entity ${entity.entityId}: Bot gateway disconnected (pairing required)`);

                entity.message = `[SYSTEM:BOT_OFFLINE] Bot gateway disconnected — pairing required. Fetch fix: https://eclawbot.com/docs/webhook-troubleshooting.md`;
                entity.lastUpdated = Date.now();

                // Immediately notify connected clients via Socket.IO
                io.to(`device:${deviceId}`).emit('entity:update', {
                    deviceId, entityId: entity.entityId,
                    name: entity.name, character: entity.character,
                    state: entity.state, message: entity.message,
                    parts: entity.parts, lastUpdated: entity.lastUpdated,
                    xp: entity.xp || 0, level: entity.level || 1
                });

                serverLog('warn', 'client_push', `Entity ${entity.entityId} bot pairing required`, { deviceId, entityId: entity.entityId });
                logHandshakeFailure({ deviceId, entityId: entity.entityId, webhookUrl: url, errorType: 'pairing_required', httpStatus: 200, errorMessage: 'gateway closed (1008): pairing required', responseBody: responseText?.substring(0, 500), source: 'push' });

                entity.pushStatus = { ok: false, reason: 'pairing_required', at: Date.now() };
                return { pushed: false, reason: 'pairing_required', error: 'Bot gateway disconnected — pairing required' };
            }

            if (entity.pendingRename) { entity.pendingRename = null; }
            entity.pushStatus = { ok: true, at: Date.now() };
            return { pushed: true };
        } else {
            const errorText = await response.text().catch(() => '');
            console.error(`[Push] ✗ Device ${deviceId} Entity ${entity.entityId}: Push failed with status ${response.status}`);
            console.error(`[Push] Error response: ${errorText}`);
            serverLog('error', 'push_error', `Entity ${entity.entityId} push HTTP ${response.status}`, { deviceId, entityId: entity.entityId, metadata: { status: response.status, error: errorText.substring(0, 300) } });

            // Build debug hint based on error status
            let debugHint = '';
            if (response.status === 401) {
                debugHint = ' Token may be invalid or a placeholder. Re-register webhook with correct token (process.env.OPENCLAW_GATEWAY_TOKEN).';
            } else if (response.status === 405) {
                debugHint = ' URL may be incorrect (double slash?). Re-register webhook with correct URL.';
            } else if (response.status === 404) {
                debugHint = ' sessions_send tool not available. Fetch fix: https://eclawbot.com/docs/webhook-troubleshooting.md';
            }

            // Notify device about webhook failure via entity message
            // BUT skip if bot already responded via /api/transform during the push (lastUpdated changed)
            if (entity.lastUpdated && entity.lastUpdated > pushStartedAt) {
                console.log(`[Push] Skipping WEBHOOK_ERROR — bot already responded via transform during push (Device ${deviceId} Entity ${entity.entityId})`);
            } else {
                entity.message = `[SYSTEM:WEBHOOK_ERROR] Push failed (HTTP ${response.status}).${debugHint}`;
                entity.lastUpdated = Date.now();
                console.log(`[Push] Set WEBHOOK_ERROR system message for Device ${deviceId} Entity ${entity.entityId}`);
            }

            entity.pushStatus = { ok: false, reason: `http_${response.status}`, at: Date.now() };
            return { pushed: false, reason: `http_${response.status}`, error: errorText, debug: { url, tokenLength: token.length, status: response.status, hint: debugHint.trim() } };
        }
    } catch (err) {
        console.error(`[Push] ✗ Device ${deviceId} Entity ${entity.entityId}: Push error:`, err.message);
        console.error(`[Push] Full error:`, err);
        serverLog('error', 'push_error', `Entity ${entity.entityId} push exception: ${err.message}`, { deviceId, entityId: entity.entityId });

        // Notify device about webhook failure via entity message
        // BUT skip if bot already responded via /api/transform during the push (lastUpdated changed)
        if (entity.lastUpdated && entity.lastUpdated > pushStartedAt) {
            console.log(`[Push] Skipping WEBHOOK_ERROR — bot already responded via transform during push (Device ${deviceId} Entity ${entity.entityId})`);
        } else {
            entity.message = `[SYSTEM:WEBHOOK_ERROR] Push connection failed: ${err.message}`;
            entity.lastUpdated = Date.now();
            console.log(`[Push] Set WEBHOOK_ERROR system message for Device ${deviceId} Entity ${entity.entityId}`);
        }

        entity.pushStatus = { ok: false, reason: err.message, at: Date.now() };
        return { pushed: false, reason: err.message };
    }
}

// Wire pushToBot into mission module (late binding — pushToBot defined after mission init)
missionModule.setPushToBot(pushToBot);

// ============================================
// FEEDBACK ENDPOINTS (Enhanced with Log Snapshot + AI Prompt)
// ============================================

// POST /api/feedback — Submit feedback with auto log capture
app.post('/api/feedback', async (req, res) => {
    try {
        const { deviceId, deviceSecret, message, category, appVersion, source } = req.body;

        if (!message || !message.trim()) {
            return res.status(400).json({ success: false, message: "Message is required" });
        }

        const trimmedMessage = message.trim();
        if (trimmedMessage.length > 2000) {
            return res.status(400).json({ success: false, message: "Message too long (max 2000 chars)" });
        }

        // Determine log capture window (from mark timestamp if available)
        const markTs = feedbackModule.getMark(deviceId);
        const sinceMs = markTs || (Date.now() - feedbackModule.LOG_WINDOW_MS);

        // Auto-capture log snapshot + device state
        const logSnapshot = await feedbackModule.captureLogSnapshot(chatPool, deviceId, sinceMs);
        const deviceState = feedbackModule.captureDeviceState(devices, deviceId);

        // Save enhanced feedback
        const saved = await feedbackModule.saveFeedback(chatPool, {
            deviceId: deviceId || 'unknown',
            deviceSecret: deviceSecret || null,
            message: trimmedMessage,
            category: category || 'bug',
            appVersion: appVersion || '',
            source: source || '',
            logSnapshot,
            deviceState,
            markTs
        });

        // Clear mark after use
        if (markTs) feedbackModule.clearMark(deviceId);

        console.log(`[Feedback] #${saved?.id || '?'} from ${deviceId || 'unknown'}: ${trimmedMessage.substring(0, 100)} [${saved?.severity}] tags=[${saved?.tags}]`);

        // Auto-create GitHub issue if configured
        let githubIssue = null;
        if (saved && process.env.GITHUB_TOKEN && process.env.GITHUB_REPO) {
            const fullFeedback = await feedbackModule.getFeedbackById(chatPool, saved.id);
            if (fullFeedback) {
                githubIssue = await feedbackModule.createGithubIssue(fullFeedback);
                if (githubIssue) {
                    await feedbackModule.updateFeedback(chatPool, saved.id, { github_issue_url: githubIssue.url });
                    console.log(`[Feedback] GitHub issue created: ${githubIssue.url}`);
                }
            }
        }

        res.json({
            success: true,
            message: "Feedback received",
            feedbackId: saved?.id || null,
            severity: saved?.severity || 'unknown',
            tags: saved?.tags || [],
            diagnosis: saved?.ai_diagnosis || null,
            githubIssue: githubIssue ? { url: githubIssue.url, number: githubIssue.number } : null,
            logsCaptured: {
                telemetry: logSnapshot.telemetry.length,
                serverLogs: logSnapshot.serverLogs.length,
                windowMs: logSnapshot.windowMs
            }
        });
    } catch (err) {
        console.error('[Feedback] Error:', err.message);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/feedback/mark — Mark current timestamp for later feedback
app.post('/api/feedback/mark', (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) {
        return res.status(400).json({ success: false, message: "deviceId required" });
    }
    const ts = feedbackModule.setMark(deviceId);
    console.log(`[Feedback] Mark set for ${deviceId} at ${new Date(ts).toISOString()}`);
    res.json({ success: true, markTs: ts });
});

// POST /api/admin/transfer-device — Transfer all entity bindings + DB data from one device to another
app.post('/api/admin/transfer-device', async (req, res) => {
    const { sourceDeviceId, sourceDeviceSecret, targetDeviceId, targetDeviceSecret } = req.body;

    // Validate both devices
    const sourceDevice = devices[sourceDeviceId];
    if (!sourceDevice || !safeEqual(sourceDevice.deviceSecret, sourceDeviceSecret)) {
        return res.status(401).json({ success: false, message: "Invalid source device credentials" });
    }
    const targetDevice = getOrCreateDevice(targetDeviceId, targetDeviceSecret);
    if (targetDevice.deviceSecret && !safeEqual(targetDevice.deviceSecret, targetDeviceSecret)) {
        return res.status(401).json({ success: false, message: "Invalid target device credentials" });
    }
    if (!targetDevice.deviceSecret) targetDevice.deviceSecret = targetDeviceSecret;

    const transferred = [];
    const dbMigrated = {};
    try {
        // 1. Transfer in-memory entities + official bindings
        for (const eId of Object.keys(sourceDevice.entities).map(Number)) {
            const srcEntity = sourceDevice.entities[eId];
            if (!srcEntity || !srcEntity.isBound) continue;

            targetDevice.entities[eId] = { ...srcEntity, entityId: eId };

            const srcKey = getBindingCacheKey(sourceDeviceId, eId);
            const tgtKey = getBindingCacheKey(targetDeviceId, eId);
            if (officialBindingsCache[srcKey]) {
                const binding = { ...officialBindingsCache[srcKey], device_id: targetDeviceId };
                officialBindingsCache[tgtKey] = binding;
                delete officialBindingsCache[srcKey];
                if (usePostgreSQL) {
                    await db.removeOfficialBinding(sourceDeviceId, eId);
                    await db.saveOfficialBinding(binding);
                }
            }

            sourceDevice.entities[eId] = createDefaultEntity(eId);
            transferred.push({ entityId: eId, name: srcEntity.name, character: srcEntity.character });
        }

        // 2. Transfer PostgreSQL data (mission, scheduled messages, feedback, telemetry, etc.)
        if (chatPool) {
            const client = await chatPool.connect();
            try {
                await client.query('BEGIN');

                // Mission dashboard: copy source → target, then delete source
                const dashResult = await client.query(
                    'SELECT * FROM mission_dashboard WHERE device_id = $1', [sourceDeviceId]
                );
                if (dashResult.rows.length > 0) {
                    const dash = dashResult.rows[0];
                    const jsonStr = v => v ? JSON.stringify(v) : '[]';
                    await client.query(
                        `INSERT INTO mission_dashboard (device_id, version, todo_list, mission_list, done_list, notes, rules, skills)
                         VALUES ($1, 1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb)
                         ON CONFLICT (device_id) DO UPDATE SET
                           todo_list = $2::jsonb, mission_list = $3::jsonb, done_list = $4::jsonb,
                           notes = $5::jsonb, rules = $6::jsonb, skills = $7::jsonb, updated_at = NOW()`,
                        [targetDeviceId, jsonStr(dash.todo_list), jsonStr(dash.mission_list), jsonStr(dash.done_list), jsonStr(dash.notes), jsonStr(dash.rules), jsonStr(dash.skills)]
                    );
                    // Move child records (must happen before deleting source dashboard)
                    const tables = ['mission_items', 'mission_notes', 'mission_rules', 'mission_sync_log'];
                    for (const table of tables) {
                        const r = await client.query(
                            `UPDATE ${table} SET device_id = $1 WHERE device_id = $2`,
                            [targetDeviceId, sourceDeviceId]
                        );
                        if (r.rowCount > 0) dbMigrated[table] = r.rowCount;
                    }
                    await client.query('DELETE FROM mission_dashboard WHERE device_id = $1', [sourceDeviceId]);
                    dbMigrated['mission_dashboard'] = 1;
                }

                // Bot files
                const bf = await client.query(
                    'UPDATE bot_files SET device_id = $1 WHERE device_id = $2', [targetDeviceId, sourceDeviceId]
                );
                if (bf.rowCount > 0) dbMigrated['bot_files'] = bf.rowCount;

                // Scheduled messages
                const sm = await client.query(
                    'UPDATE scheduled_messages SET device_id = $1 WHERE device_id = $2', [targetDeviceId, sourceDeviceId]
                );
                if (sm.rowCount > 0) dbMigrated['scheduled_messages'] = sm.rowCount;

                // Feedback
                const fb = await client.query(
                    'UPDATE feedback SET device_id = $1 WHERE device_id = $2', [targetDeviceId, sourceDeviceId]
                );
                if (fb.rowCount > 0) dbMigrated['feedback'] = fb.rowCount;

                // Device telemetry
                const dt = await client.query(
                    'UPDATE device_telemetry SET device_id = $1 WHERE device_id = $2', [targetDeviceId, sourceDeviceId]
                );
                if (dt.rowCount > 0) dbMigrated['device_telemetry'] = dt.rowCount;

                // User accounts (subscription)
                const ua = await client.query(
                    'UPDATE user_accounts SET device_id = $1 WHERE device_id = $2', [targetDeviceId, sourceDeviceId]
                );
                if (ua.rowCount > 0) dbMigrated['user_accounts'] = ua.rowCount;

                // Usage tracking
                const ut = await client.query(
                    'UPDATE usage_tracking SET device_id = $1 WHERE device_id = $2', [targetDeviceId, sourceDeviceId]
                );
                if (ut.rowCount > 0) dbMigrated['usage_tracking'] = ut.rowCount;

                // Server logs
                const sl = await client.query(
                    'UPDATE server_logs SET device_id = $1 WHERE device_id = $2', [targetDeviceId, sourceDeviceId]
                );
                if (sl.rowCount > 0) dbMigrated['server_logs'] = sl.rowCount;

                await client.query('COMMIT');
            } catch (dbErr) {
                await client.query('ROLLBACK');
                throw new Error(`DB migration failed: ${dbErr.message}`);
            } finally {
                client.release();
            }
        }

        await saveData();
        console.log(`[Transfer] ${transferred.length} entities + DB tables: ${sourceDeviceId} → ${targetDeviceId}`, dbMigrated);
        res.json({ success: true, transferred, count: transferred.length, dbMigrated });
    } catch (err) {
        console.error('[Transfer] Error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET /api/feedback/pending-debug — List bug feedback pending yanhui debug processing
app.get('/api/feedback/pending-debug', async (req, res) => {
    const { deviceId, deviceSecret, limit } = req.query;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, message: "deviceId and deviceSecret required" });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const list = await feedbackModule.getPendingDebugFeedback(chatPool, limit);
    res.json({ success: true, count: list.length, feedback: list });
});

// POST /api/feedback/:id/debug-result — Save yanhui debug search/analyze result
app.post('/api/feedback/:id/debug-result', async (req, res) => {
    const { deviceId, deviceSecret } = req.body;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, message: "deviceId and deviceSecret required" });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const { debugStatus, debugResult } = req.body;
    if (!debugStatus || !['searched', 'analyzed'].includes(debugStatus)) {
        return res.status(400).json({ success: false, message: "debugStatus must be 'searched' or 'analyzed'" });
    }

    const ok = await feedbackModule.saveDebugResult(chatPool, req.params.id, debugStatus, debugResult || {});
    if (ok) {
        res.json({ success: true });
    } else {
        res.status(500).json({ success: false, message: "Failed to save debug result" });
    }
});

// GET /api/feedback — List feedback with filters
app.get('/api/feedback', async (req, res) => {
    const { deviceId, deviceSecret, status, severity, limit, offset } = req.query;

    // Auth: require valid device credentials
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, message: "deviceId and deviceSecret required" });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const list = await feedbackModule.getFeedbackList(chatPool, { deviceId, status, severity, limit, offset });
    // Lazy sync: check GitHub issue state for open feedback with linked issues
    await feedbackModule.syncGithubStatuses(chatPool, list);
    res.json({ success: true, count: list.length, feedback: list });
});

// GET /api/feedback/:id — Get single feedback (full record)
app.get('/api/feedback/:id', async (req, res) => {
    const { deviceId, deviceSecret } = req.query;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, message: "deviceId and deviceSecret required" });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const fb = await feedbackModule.getFeedbackById(chatPool, parseInt(req.params.id));
    if (!fb) {
        return res.status(404).json({ success: false, message: "Feedback not found" });
    }
    if (fb.device_id !== deviceId) {
        return res.status(403).json({ success: false, message: "Access denied" });
    }
    res.json({ success: true, feedback: fb });
});

// GET /api/feedback/:id/ai-prompt — Generate AI diagnostic prompt
app.get('/api/feedback/:id/ai-prompt', async (req, res) => {
    const { deviceId, deviceSecret } = req.query;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, message: "deviceId and deviceSecret required" });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const fb = await feedbackModule.getFeedbackById(chatPool, parseInt(req.params.id));
    if (!fb) {
        return res.status(404).json({ success: false, message: "Feedback not found" });
    }
    if (fb.device_id !== deviceId) {
        return res.status(403).json({ success: false, message: "Access denied" });
    }

    const photos = await feedbackModule.getFeedbackPhotos(chatPool, fb.id);
    const prompt = feedbackModule.generateAiPrompt(fb, photos);
    res.json({ success: true, feedbackId: fb.id, prompt, photoCount: photos.length });
});

// POST /api/feedback/:id/create-issue — Create GitHub issue from feedback
app.post('/api/feedback/:id/create-issue', async (req, res) => {
    const { deviceId, deviceSecret } = req.body;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, message: "deviceId and deviceSecret required" });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
        return res.status(503).json({ success: false, message: "GitHub integration not configured (set GITHUB_TOKEN and GITHUB_REPO)" });
    }

    const fb = await feedbackModule.getFeedbackById(chatPool, parseInt(req.params.id));
    if (!fb) {
        return res.status(404).json({ success: false, message: "Feedback not found" });
    }
    if (fb.device_id !== deviceId) {
        return res.status(403).json({ success: false, message: "Access denied" });
    }

    if (fb.github_issue_url) {
        return res.json({ success: true, message: "Issue already created", url: fb.github_issue_url });
    }

    const issue = await feedbackModule.createGithubIssue(fb);
    if (!issue) {
        return res.status(500).json({ success: false, message: "Failed to create GitHub issue" });
    }

    await feedbackModule.updateFeedback(chatPool, fb.id, { github_issue_url: issue.url });
    res.json({ success: true, url: issue.url, number: issue.number });
});

// PATCH /api/feedback/:id — Update feedback status/resolution
app.patch('/api/feedback/:id', async (req, res) => {
    const { deviceId, deviceSecret, status, resolution, severity } = req.body;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, message: "deviceId and deviceSecret required" });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const fb = await feedbackModule.getFeedbackById(chatPool, parseInt(req.params.id));
    if (!fb) {
        return res.status(404).json({ success: false, message: "Feedback not found" });
    }

    const updates = {};
    if (status) updates.status = status;
    if (resolution) updates.resolution = resolution;
    if (severity) updates.severity = severity;

    const updated = await feedbackModule.updateFeedback(chatPool, fb.id, updates);

    // Auto-delete photos when feedback is resolved or closed
    let photosDeleted = 0;
    if (updated && (status === 'resolved' || status === 'closed')) {
        photosDeleted = await feedbackModule.deleteFeedbackPhotos(chatPool, fb.id);

        // Notify the feedback author about resolution
        if (fb.device_id) {
            notifyDevice(fb.device_id, {
                type: 'feedback',
                category: status === 'resolved' ? 'feedback_resolved' : 'feedback_resolved',
                title: status === 'resolved' ? 'Feedback Resolved' : 'Feedback Closed',
                body: `Your feedback #${fb.id} has been ${status}`,
                link: 'feedback.html',
                metadata: { feedbackId: fb.id, status }
            }).catch(() => {});
        }
    }

    // Notify about admin reply (resolution text added)
    if (updated && resolution && fb.device_id) {
        notifyDevice(fb.device_id, {
            type: 'feedback', category: 'feedback_reply',
            title: 'Feedback Reply',
            body: (resolution || '').slice(0, 100),
            link: 'feedback.html',
            metadata: { feedbackId: fb.id }
        }).catch(() => {});
    }

    // Send email notification for status changes (fire-and-forget)
    if (updated && status) {
        feedbackEmail.sendFeedbackStatusEmail(chatPool, fb, status, resolution, notifModule).catch(() => {});
    }

    res.json({ success: updated, message: updated ? "Updated" : "No changes", photosDeleted });
});

// DELETE /api/feedback/:id — Delete a feedback entry
app.delete('/api/feedback/:id', async (req, res) => {
    const { deviceId, deviceSecret } = req.body;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, message: "deviceId and deviceSecret required" });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const fb = await feedbackModule.getFeedbackById(chatPool, parseInt(req.params.id));
    if (!fb) {
        return res.status(404).json({ success: false, message: "Feedback not found" });
    }

    // Only the device owner can delete their own feedback
    if (fb.device_id !== deviceId) {
        return res.status(403).json({ success: false, message: "Not authorized to delete this feedback" });
    }

    const deleted = await feedbackModule.deleteFeedback(chatPool, fb.id);
    res.json({ success: deleted, message: deleted ? "Deleted" : "Delete failed" });
});

// ============================================
// FEEDBACK PHOTOS
// ============================================

const feedbackPhotoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: feedbackModule.MAX_PHOTO_SIZE },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Unsupported file type: ' + file.mimetype));
        }
    }
});

// POST /api/feedback/:id/photos — Upload photos for a feedback entry
app.post('/api/feedback/:id/photos', feedbackPhotoUpload.array('photos', feedbackModule.MAX_PHOTOS_PER_FEEDBACK), async (req, res) => {
    try {
        const { deviceId, deviceSecret } = req.body;
        if (!deviceId || !deviceSecret) {
            return res.status(400).json({ success: false, message: "deviceId and deviceSecret required" });
        }
        const device = devices[deviceId];
        if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
            return res.status(401).json({ success: false, message: "Invalid credentials" });
        }

        const feedbackId = parseInt(req.params.id);
        const fb = await feedbackModule.getFeedbackById(chatPool, feedbackId);
        if (!fb) {
            return res.status(404).json({ success: false, message: "Feedback not found" });
        }
        if (fb.device_id !== deviceId) {
            return res.status(403).json({ success: false, message: "Access denied" });
        }

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: "No photos provided" });
        }

        const saved = [];
        for (const file of req.files) {
            const result = await feedbackModule.saveFeedbackPhoto(
                chatPool, feedbackId, file.buffer, file.mimetype, file.originalname
            );
            if (result && result.error) {
                return res.status(400).json({ success: false, message: result.error });
            }
            if (result) {
                saved.push({ id: result.id, fileName: result.file_name });
            }
        }

        console.log(`[Feedback] ${saved.length} photo(s) uploaded for feedback #${feedbackId}`);
        res.json({ success: true, photos: saved, count: saved.length });
    } catch (err) {
        console.error('[Feedback] Photo upload error:', err.message);
        res.status(500).json({ success: false, message: "Upload failed" });
    }
});

// GET /api/feedback/:id/photos — List photos for a feedback entry
app.get('/api/feedback/:id/photos', async (req, res) => {
    const { deviceId, deviceSecret } = req.query;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, message: "deviceId and deviceSecret required" });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const feedbackId = parseInt(req.params.id);
    const fb = await feedbackModule.getFeedbackById(chatPool, feedbackId);
    if (!fb) {
        return res.status(404).json({ success: false, message: "Feedback not found" });
    }
    if (fb.device_id !== deviceId) {
        return res.status(403).json({ success: false, message: "Access denied" });
    }

    const photos = await feedbackModule.getFeedbackPhotos(chatPool, feedbackId);
    res.json({
        success: true,
        photos: photos.map(p => ({
            id: p.id,
            feedbackId: p.feedback_id,
            contentType: p.content_type,
            fileName: p.file_name,
            size: parseInt(p.size),
            url: `/api/feedback/photo/${p.id}`
        }))
    });
});

// GET /api/feedback/photo/:photoId — Serve a feedback photo (binary)
app.get('/api/feedback/photo/:photoId', async (req, res) => {
    const photo = await feedbackModule.getFeedbackPhoto(chatPool, parseInt(req.params.photoId));
    if (!photo) {
        return res.status(404).json({ success: false, message: "Photo not found" });
    }

    res.set('Content-Type', photo.content_type);
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(photo.photo_data);
});

// Error Handling
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ success: false, message: "Invalid JSON format" });
    }
    if (err.status === 413 || err.type === 'entity.too.large') {
        return res.status(413).json({
            success: false,
            error: 'payload_too_large',
            message: 'Request too large. If you attached images, please try with fewer or smaller images.'
        });
    }
    next();
});

// ============================================
// CHAT HISTORY (PostgreSQL)
// ============================================
const { Pool } = require('pg');
const chatPool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

// Link telemetry middleware to the real pool
_telemetryPool = chatPool;
telemetry.initTelemetryTable(chatPool, serverLog);
feedbackModule.initFeedbackTable(chatPool);
feedbackModule.initFeedbackPhotosTable(chatPool);
notifModule.initNotificationTables(chatPool);
devicePrefs.initTable(chatPool);
crossDeviceSettings.initTable(chatPool);
chatIntegrity.initIntegrityTable(chatPool);
articlePublisher.initPublisherTable(chatPool);

// Auto-migrate: add delivery tracking + media columns
chatPool.query(`
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS is_delivered BOOLEAN DEFAULT FALSE;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS delivered_to TEXT DEFAULT NULL;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS media_type VARCHAR(16) DEFAULT NULL;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS media_url TEXT DEFAULT NULL;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS schedule_id INT DEFAULT NULL;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS schedule_label TEXT DEFAULT NULL;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS like_count INTEGER DEFAULT 0;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS dislike_count INTEGER DEFAULT 0;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS backup_url TEXT DEFAULT NULL;
`).catch(() => {});

// Auto-migrate: create message_reactions table (message_id must be UUID to match chat_messages.id)
chatPool.query(`
    DO $$ BEGIN
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'message_reactions' AND column_name = 'message_id' AND data_type = 'integer'
        ) THEN
            DROP TABLE message_reactions;
        END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS message_reactions (
        id SERIAL PRIMARY KEY,
        message_id UUID NOT NULL,
        device_id TEXT NOT NULL,
        reaction_type VARCHAR(8) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(message_id, device_id)
    );
    CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);
`).catch(() => {});

// ============================================
// AI SUPPORT — Binding Troubleshooter
// ============================================
const aiSupportModule = require('./ai-support')(devices, chatPool, { serverLog, getWebhookFixInstructions, feedbackModule });
// Admin-chat requires admin auth; other ai-support routes use bot auth
app.use('/api/ai-support/admin-chat', adminAuth, adminCheck);
// Body limit for chat with images is set globally (before express.json() default)
app.use('/api/ai-support', aiSupportModule.router);
aiSupportModule.initSupportTable();

// ============================================
// CHANNEL API — OpenClaw Channel Plugin
// ============================================
const channelModule = require('./channel-api')(devices, {
    authMiddleware: authModule.authMiddleware,
    serverLog,
    generateBotSecret,
    generatePublicCode,
    publicCodeIndex,
    saveChatMessage,
    io,
    saveData,
    createDefaultEntity,
    apiBase: process.env.API_BASE || 'https://eclawbot.com',
    awardEntityXP,
    XP_AMOUNTS,
    notifyDevice
});
app.use('/api/channel', channelModule.router);
// Wire channel push into mission module (Bot Push Parity Rule — must be after channelModule init)
missionModule.setPushToChannelCallback(channelModule.pushToChannelCallback.bind(channelModule));

// ============================================
// DISCORD INTEGRATION — Slash Commands
// ============================================
const discordModule = require('./discord-integration')(devices, {
    db,
    authMiddleware: authModule.authMiddleware,
    serverLog,
    pushToBot,
    apiBase: process.env.API_BASE || 'https://eclawbot.com'
});
app.use('/api/discord', discordModule.router);

// Close GitHub issue (device-authenticated)
app.patch('/api/github/issues/:number', async (req, res) => {
    const { deviceId, deviceSecret } = req.body;
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const issueNumber = parseInt(req.params.number);
    if (isNaN(issueNumber)) {
        return res.status(400).json({ success: false, error: 'Invalid issue number' });
    }
    const comment = req.body.comment || null;
    const result = await aiSupportModule.closeIssue(issueNumber, comment);
    res.json(result);
});

// ============================================
// NOTIFICATION SYSTEM - Central dispatcher
// ============================================

/**
 * Central notification dispatcher.
 * Saves to DB, emits via Socket.IO, and (future) sends Web Push / FCM.
 * @param {string} deviceId
 * @param {object} notification - { type, category, title, body, link?, metadata? }
 */
async function notifyDevice(deviceId, notification) {
    try {
        // Check user preferences — skip if category disabled
        const prefs = await notifModule.getPrefs(deviceId);
        if (!notifModule.isCategoryEnabled(prefs, notification.category)) return;

        // Save to DB
        const notif = await notifModule.saveNotification(deviceId, notification);
        if (!notif) return;

        // Emit via Socket.IO
        io.to(`device:${deviceId}`).emit('notification', {
            id: notif.id,
            type: notif.type,
            category: notif.category,
            title: notif.title,
            body: notif.body,
            link: notif.link,
            metadata: typeof notif.metadata === 'string' ? JSON.parse(notif.metadata) : notif.metadata,
            isRead: false,
            createdAt: notif.created_at
        });

        // Web Push (Phase 3 — enabled when VAPID keys are configured)
        if (typeof sendWebPush === 'function') {
            sendWebPush(deviceId, notif).catch(() => {});
        }

        // FCM (Phase 5 — enabled when firebase-admin is configured)
        if (typeof sendFcm === 'function') {
            sendFcm(deviceId, notif).catch(() => {});
        }
    } catch (err) {
        console.warn('[Notify] Failed:', err.message);
    }
}

// ---- Notification REST API ----

// Authenticate device by deviceId+deviceSecret or JWT cookie
function authDevice(req) {
    const deviceId = req.query.deviceId || req.body.deviceId;
    const deviceSecret = req.query.deviceSecret || req.body.deviceSecret;
    if (deviceId && deviceSecret) {
        const device = devices[deviceId];
        if (device && safeEqual(device.deviceSecret, deviceSecret)) return deviceId;
    }
    // Fallback: JWT cookie (web portal)
    if (req.user && req.user.deviceId) return req.user.deviceId;
    return null;
}

app.get('/api/notifications', async (req, res) => {
    const deviceId = authDevice(req);
    if (!deviceId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const unreadOnly = req.query.unreadOnly === 'true';

    const notifications = await notifModule.getNotifications(deviceId, { limit, offset, unreadOnly });
    res.json({ success: true, notifications });
});

app.get('/api/notifications/count', async (req, res) => {
    const deviceId = authDevice(req);
    if (!deviceId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const count = await notifModule.getUnreadCount(deviceId);
    res.json({ success: true, count });
});

app.post('/api/notifications/read', async (req, res) => {
    const deviceId = authDevice(req);
    if (!deviceId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, error: 'id required' });

    await notifModule.markRead(deviceId, id);
    res.json({ success: true });
});

app.post('/api/notifications/read-all', async (req, res) => {
    const deviceId = authDevice(req);
    if (!deviceId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    await notifModule.markAllRead(deviceId);
    res.json({ success: true });
});

app.get('/api/notification-preferences', async (req, res) => {
    const deviceId = authDevice(req);
    if (!deviceId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const prefs = await notifModule.getPrefs(deviceId);
    res.json({ success: true, prefs, defaults: notifModule.DEFAULT_PREFS });
});

app.put('/api/notification-preferences', async (req, res) => {
    const deviceId = authDevice(req);
    if (!deviceId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { prefs } = req.body;
    if (!prefs || typeof prefs !== 'object') {
        return res.status(400).json({ success: false, error: 'prefs object required' });
    }

    await notifModule.updatePrefs(deviceId, prefs);
    const updated = await notifModule.getPrefs(deviceId);
    res.json({ success: true, prefs: updated });
});

// ============================================
// DEVICE PREFERENCES (broadcast settings, etc.)
// ============================================
app.get('/api/device-preferences', async (req, res) => {
    const deviceId = authDevice(req);
    if (!deviceId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const prefs = await devicePrefs.getPrefs(deviceId);
    res.json({ success: true, prefs, defaults: devicePrefs.DEFAULTS });
});

app.put('/api/device-preferences', async (req, res) => {
    const deviceId = authDevice(req);
    if (!deviceId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { prefs } = req.body;
    if (!prefs || typeof prefs !== 'object') {
        return res.status(400).json({ success: false, error: 'prefs object required' });
    }

    await devicePrefs.updatePrefs(deviceId, prefs);
    const updated = await devicePrefs.getPrefs(deviceId);
    res.json({ success: true, prefs: updated });
});

// ============================================
// REMOTE SCREEN CONTROL
// ============================================

/**
 * POST /api/device/screen-capture
 * Bot or device owner requests the current screen UI tree (long-poll, ≤5s).
 * Body: { deviceId, entityId, botSecret } — bot auth
 *    or { deviceId, entityId, deviceSecret } — device owner auth (portal)
 */
app.post('/api/device/screen-capture', async (req, res) => {
    const { deviceId, entityId, botSecret, deviceSecret } = req.body;

    if (!deviceId || (botSecret === undefined && deviceSecret === undefined)) {
        return res.status(400).json({ success: false, error: 'deviceId and botSecret (or deviceSecret) required' });
    }

    const eId = parseInt(entityId) || 0;
    if (eId < 0) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }

    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    if (!isValidEntityId(device, eId)) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }

    // Auth: device owner (portal) OR bot
    const isOwner = deviceSecret && device.deviceSecret && safeEqual(deviceSecret, device.deviceSecret);
    const entity = device.entities[eId];
    if (!isOwner) {
        if (!entity || !entity.isBound) {
            return res.status(400).json({ success: false, error: 'Entity not bound' });
        }
        if (!botSecret || !safeEqual(botSecret, entity.botSecret)) {
            return res.status(403).json({ success: false, error: 'Invalid botSecret' });
        }
    }

    // Feature gate
    const prefs = await devicePrefs.getPrefs(deviceId);
    if (!prefs.remote_control_enabled) {
        return res.status(403).json({ success: false, error: 'remote_control_disabled',
            message: 'Remote control is not enabled. User must enable it in App Settings.' });
    }

    // Rate limiting: 500ms minimum interval only
    const now = Date.now();
    if (!screenCaptureRateLimits[deviceId]) {
        screenCaptureRateLimits[deviceId] = { lastAt: 0 };
    }
    const rateState = screenCaptureRateLimits[deviceId];
    if (now - rateState.lastAt < SCREEN_CAPTURE_MIN_INTERVAL_MS) {
        return res.status(429).json({ success: false, error: 'too_fast',
            message: `Min ${SCREEN_CAPTURE_MIN_INTERVAL_MS}ms between captures.` });
    }
    rateState.lastAt = now;

    // Check device is connected via Socket.IO
    const sockets = await io.in(`device:${deviceId}`).fetchSockets();
    if (sockets.length === 0) {
        return res.status(503).json({ success: false, error: 'device_offline',
            message: 'Device is not connected. Open the app.' });
    }

    // Only one pending capture per device at a time
    if (pendingScreenRequests[deviceId]) {
        return res.status(409).json({ success: false, error: 'capture_in_progress',
            message: 'Another screen capture is already pending for this device.' });
    }

    serverLog('info', 'remote_control', 'screen-capture requested', { deviceId, entityId: eId });

    try {
        const screenData = await new Promise((resolve, reject) => {
            const timeoutHandle = setTimeout(() => {
                delete pendingScreenRequests[deviceId];
                reject(new Error('timeout'));
            }, 5000);
            pendingScreenRequests[deviceId] = { resolve, reject, timeoutHandle };
            io.to(`device:${deviceId}`).emit('device:screen-request', { requestedAt: now });
        });
        return res.json({ success: true, ...screenData });
    } catch (err) {
        if (err.message === 'timeout') {
            return res.status(504).json({ success: false, error: 'timeout',
                message: 'Device did not respond within 5 seconds. Is the Accessibility Service enabled?' });
        }
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/device/screen-result
 * App delivers the captured UI tree, resolving the pending long-poll.
 * Auth: deviceId + deviceSecret (device owner).
 * Body: { deviceId, deviceSecret, screen, timestamp, elements }
 */
app.post('/api/device/screen-result', (req, res) => {
    const deviceId = authDevice(req);
    if (!deviceId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { screen, timestamp, elements, truncated } = req.body;
    const pending = pendingScreenRequests[deviceId];
    if (!pending) {
        return res.json({ success: true, message: 'No pending request, result discarded' });
    }

    clearTimeout(pending.timeoutHandle);
    delete pendingScreenRequests[deviceId];
    pending.resolve({ screen, timestamp, elements, truncated: !!truncated });

    serverLog('info', 'remote_control', 'screen-result delivered', { deviceId,
        metadata: { screen, elementCount: Array.isArray(elements) ? elements.length : 0, truncated: !!truncated } });
    res.json({ success: true });
});

/**
 * POST /api/device/control
 * Bot or device owner sends a UI control command. Relayed to App via Socket.IO (fire-and-forget).
 * Body: { deviceId, entityId, botSecret, command, params } — bot auth
 *    or { deviceId, entityId, deviceSecret, command, params } — device owner auth (portal)
 */
app.post('/api/device/control', async (req, res) => {
    const { deviceId, entityId, botSecret, deviceSecret, command, params } = req.body;

    if (!deviceId || !command) {
        return res.status(400).json({ success: false, error: 'deviceId and command required' });
    }

    const VALID_COMMANDS = new Set(['tap', 'type', 'scroll', 'back', 'home', 'ime_action']);
    if (!VALID_COMMANDS.has(command)) {
        return res.status(400).json({ success: false, error: `Invalid command. Must be one of: ${[...VALID_COMMANDS].join(', ')}` });
    }

    const eId = parseInt(entityId) || 0;
    if (eId < 0) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }

    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    if (!isValidEntityId(device, eId)) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }

    // Auth: device owner (portal) OR bot
    const isOwner = deviceSecret && device.deviceSecret && safeEqual(deviceSecret, device.deviceSecret);
    if (!isOwner) {
        const entity = device.entities[eId];
        if (!entity || !entity.isBound) {
            return res.status(400).json({ success: false, error: 'Entity not bound' });
        }
        if (!botSecret || !safeEqual(botSecret, entity.botSecret)) {
            return res.status(403).json({ success: false, error: 'Invalid botSecret' });
        }
    }

    // Feature gate
    const prefs = await devicePrefs.getPrefs(deviceId);
    if (!prefs.remote_control_enabled) {
        return res.status(403).json({ success: false, error: 'remote_control_disabled',
            message: 'Remote control is not enabled. User must enable it in App Settings.' });
    }

    serverLog('info', 'remote_control', `control command: ${command}`, { deviceId, entityId: eId,
        metadata: { command, params } });

    const controlEntity = device.entities[eId];
    const entityName = controlEntity?.name || `Bot ${eId + 1}`;
    io.to(`device:${deviceId}`).emit('device:control-command', {
        command, params: params || {},
        entityId: eId, entityName
    });
    res.json({ success: true, message: `Command "${command}" sent to device` });
});

/**
 * POST /api/device/tts
 * Bot sends a text-to-speech command. Relayed to App via Socket.IO.
 * The Android app uses the built-in TextToSpeech engine to speak the text aloud,
 * even when the app is in the background (via a foreground service).
 *
 * Body (bot auth):
 *   { deviceId, entityId, botSecret, text, lang?, speed?, pitch? }
 * Body (device owner auth):
 *   { deviceId, entityId, deviceSecret, text, lang?, speed?, pitch? }
 *
 * Parameters:
 *   text   - (required) The text to speak aloud (max 500 chars)
 *   lang   - (optional) BCP-47 language tag, default "zh-TW"
 *   speed  - (optional) Speech rate 0.5–2.0, default 1.0
 *   pitch  - (optional) Speech pitch 0.5–2.0, default 1.0
 */
app.post('/api/device/tts', async (req, res) => {
    const { deviceId, entityId, botSecret, deviceSecret, text, lang, speed, pitch } = req.body;

    if (!deviceId || !text) {
        return res.status(400).json({ success: false, error: 'deviceId and text are required' });
    }

    if (typeof text !== 'string' || text.length > 500) {
        return res.status(400).json({ success: false, error: 'text must be a string of 500 characters or less' });
    }

    const eId = parseInt(entityId) || 0;
    if (eId < 0) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }

    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    if (!isValidEntityId(device, eId)) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }

    // Auth: device owner (portal) OR bot
    const isOwner = deviceSecret && device.deviceSecret && safeEqual(deviceSecret, device.deviceSecret);
    if (!isOwner) {
        const entity = device.entities[eId];
        if (!entity || !entity.isBound) {
            return res.status(400).json({ success: false, error: 'Entity not bound' });
        }
        if (!botSecret || !safeEqual(botSecret, entity.botSecret)) {
            return res.status(403).json({ success: false, error: 'Invalid botSecret' });
        }
    }

    // Validate optional params
    const ttsLang = (typeof lang === 'string' && lang.length <= 10) ? lang : 'zh-TW';
    const ttsSpeed = (typeof speed === 'number' && speed >= 0.5 && speed <= 2.0) ? speed : 1.0;
    const ttsPitch = (typeof pitch === 'number' && pitch >= 0.5 && pitch <= 2.0) ? pitch : 1.0;

    const ttsEntity = device.entities[eId];
    const entityName = ttsEntity?.name || `Bot ${eId + 1}`;

    serverLog('info', 'tts', `TTS command: "${text.slice(0, 80)}" lang=${ttsLang} speed=${ttsSpeed} pitch=${ttsPitch}`, {
        deviceId, entityId: eId,
        metadata: { lang: ttsLang, speed: ttsSpeed, pitch: ttsPitch, textLen: text.length }
    });

    // Emit via Socket.IO to the device
    io.to(`device:${deviceId}`).emit('device:tts', {
        text,
        lang: ttsLang,
        speed: ttsSpeed,
        pitch: ttsPitch,
        entityId: eId,
        entityName
    });

    // Also send FCM data message as fallback (in case Socket.IO is disconnected)
    if (typeof sendFcm === 'function') {
        sendFcm(deviceId, {
            title: entityName,
            body: text,
            category: 'tts',
            link: ''
        }).catch(() => {});
    }

    res.json({ success: true, message: `TTS command sent to device`, lang: ttsLang, speed: ttsSpeed, pitch: ttsPitch });
});

// Prune old notifications daily
setInterval(() => notifModule.pruneOldNotifications(), 24 * 60 * 60 * 1000);

// ============================================
// WEB PUSH NOTIFICATIONS (VAPID)
// ============================================
const webpush = require('web-push');
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || 'mailto:admin@eclawbot.com',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
    console.log('[WebPush] VAPID configured');
}

// Serve service worker at root scope
app.get('/sw.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/sw.js'));
});

app.get('/api/push/vapid-public-key', (req, res) => {
    if (!process.env.VAPID_PUBLIC_KEY) {
        return res.status(503).json({ success: false, error: 'Web Push not configured' });
    }
    res.json({ success: true, publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', async (req, res) => {
    const deviceId = authDevice(req);
    if (!deviceId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint || !subscription.keys) {
        return res.status(400).json({ success: false, error: 'subscription with endpoint and keys required' });
    }

    const ok = await notifModule.savePushSubscription(deviceId, subscription, req.headers['user-agent']);
    res.json({ success: ok });
});

app.delete('/api/push/unsubscribe', async (req, res) => {
    const deviceId = authDevice(req);
    if (!deviceId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ success: false, error: 'endpoint required' });

    await notifModule.removePushSubscription(endpoint);
    res.json({ success: true });
});

// Send Web Push to all subscriptions for a device
async function sendWebPush(deviceId, notif) {
    if (!process.env.VAPID_PUBLIC_KEY) return;
    try {
        const subs = await notifModule.getPushSubscriptions(deviceId);
        for (const sub of subs) {
            try {
                await webpush.sendNotification(
                    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                    JSON.stringify({
                        title: notif.title,
                        body: notif.body,
                        link: notif.link,
                        category: notif.category
                    })
                );
            } catch (e) {
                if (e.statusCode === 410 || e.statusCode === 404) {
                    await notifModule.removePushSubscription(sub.endpoint);
                }
            }
        }
    } catch (err) {
        console.warn('[WebPush] Send failed:', err.message);
    }
}

// ============================================
// FCM PUSH NOTIFICATIONS (Firebase Admin SDK)
// ============================================

// FCM token registration endpoint
app.post('/api/device/fcm-token', (req, res) => {
    // Support both old format (fcmToken) and new format (token + platform)
    const { deviceId, deviceSecret, fcmToken, token, platform } = req.body;
    const resolvedToken = token || fcmToken;
    const resolvedPlatform = platform || 'fcm';

    if (!deviceId || !deviceSecret || !resolvedToken) {
        return res.status(400).json({ success: false, error: 'deviceId, deviceSecret, and token (or fcmToken) required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    if (resolvedPlatform === 'apns') {
        // iOS APNs token
        device.apnsToken = resolvedToken;
        chatPool.query('ALTER TABLE devices ADD COLUMN IF NOT EXISTS apns_token TEXT').catch(() => {});
        chatPool.query('UPDATE devices SET apns_token = $1 WHERE device_id = $2', [resolvedToken, deviceId]).catch(() => {});
        if (process.env.DEBUG === 'true') console.log(`[PUSH] APNs token registered for device ${deviceId}`);
    } else {
        // Android FCM token (default)
        device.fcmToken = resolvedToken;
        chatPool.query('ALTER TABLE devices ADD COLUMN IF NOT EXISTS fcm_token TEXT').catch(() => {});
        chatPool.query('UPDATE devices SET fcm_token = $1 WHERE device_id = $2', [resolvedToken, deviceId]).catch(() => {});
        if (process.env.DEBUG === 'true') console.log(`[PUSH] FCM token registered for device ${deviceId}`);
    }

    res.json({ success: true, platform: resolvedPlatform });
});

// Send FCM push notification (enabled when FIREBASE_SERVICE_ACCOUNT is set)
let firebaseAdmin = null;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        firebaseAdmin = require('firebase-admin');
        firebaseAdmin.initializeApp({
            credential: firebaseAdmin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
        });
        console.log('[FCM] Firebase Admin initialized');
    }
} catch (e) {
    console.warn('[FCM] Firebase Admin init skipped:', e.message);
}

async function sendFcm(deviceId, notif) {
    if (!firebaseAdmin) return;
    try {
        const device = devices[deviceId];
        const token = device?.fcmToken;
        if (!token) return;

        await firebaseAdmin.messaging().send({
            token,
            data: {
                title: notif.title || '',
                body: notif.body || '',
                category: notif.category || '',
                link: notif.link || ''
            },
            android: {
                priority: 'high',
                notification: {
                    channelId: 'eclaw_chat',
                    sound: 'default'
                }
            }
        });
    } catch (e) {
        if (e.code === 'messaging/registration-token-not-registered') {
            delete devices[deviceId]?.fcmToken;
            chatPool.query('UPDATE devices SET fcm_token = NULL WHERE device_id = $1', [deviceId]).catch(() => {});
        }
        console.warn('[FCM] Send failed:', e.message);
    }
}

// ============================================
// SCHEDULER - Scheduled message delivery
// ============================================

// Schedule execution callback: sends message via the same path as /api/client/speak
async function executeScheduledMessage(schedule) {
    const { deviceId, entityId, message } = schedule;
    const device = devices[deviceId];
    if (!device) return { error: 'Device not found' };

    const entity = device.entities[entityId];
    if (!entity || !entity.isBound) return { error: `Entity ${entityId} not bound` };

    // Update entity state
    entity.message = `Received: "${message}"`;
    entity.lastUpdated = Date.now();

    const messageObj = {
        text: message,
        from: 'scheduled',
        timestamp: Date.now(),
        read: false
    };
    if (!entity.messageQueue) entity.messageQueue = [];
    entity.messageQueue.push(messageObj);
    saveChatMessage(deviceId, entityId, message, 'scheduled', true, false, null, null, schedule.id, schedule.label || null);

    // Notify device about scheduled message delivery
    notifyDevice(deviceId, {
        type: 'chat', category: 'scheduled',
        title: schedule.label || 'Scheduled Message',
        body: (message || '').slice(0, 100),
        link: 'chat.html',
        metadata: { entityId, scheduleId: schedule.id, label: schedule.label }
    }).catch(() => {});

    console.log(`[Scheduler] Sent to device ${deviceId} entity ${entityId}: "${message}"`);

    // Push to bot — channel callback or traditional webhook (Bot Push Parity Rule)
    let pushResult = { pushed: false, reason: 'no_webhook' };
    const apiBase = 'https://eclawbot.com';
    if (entity.bindingType === 'channel') {
        // Append missionHints to the message text so the bot receives real credentials
        // (webhook-handler only injects missionHints for entity_message/broadcast, not for regular 'message' events)
        const missionHintsText = getMissionApiHints(apiBase, deviceId, entityId, entity.botSecret);
        const enrichedMessage = message + missionHintsText;
        pushResult = await channelModule.pushToChannelCallback(deviceId, entityId, {
            event: 'message',
            from: 'scheduled',
            text: enrichedMessage,
            eclaw_context: {
                expectsReply: true,
                silentToken: '[SILENT]',
                missionHints: missionHintsText,
                identitySetupRequired: !entity.identity
            }
        }, entity.channelAccountId);
        if (pushResult.pushed) {
            messageObj.delivered = true;
            console.log(`[Scheduler] Channel push OK to device ${deviceId} entity ${entityId}`);
        }
    } else if (entity.webhook) {
        let pushMsg = `[ACTION REQUIRED] You MUST use exec tool with curl to call the API below. Your text reply is DISCARDED and the user will NEVER see it.\n`;
        pushMsg += `Run this command to reply (replace YOUR_REPLY_HERE with your response):\n`;
        pushMsg += `exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${entityId},"botSecret":"${entity.botSecret}","targetDeviceId":"${deviceId}","state":"IDLE","message":"YOUR_REPLY_HERE"}'\n\n`;
        pushMsg += `[SCHEDULED MESSAGE] Device ${deviceId} Entity ${entityId}\n`;
        pushMsg += `From: scheduled\n`;
        pushMsg += `Content: ${message}`;
        pushMsg += getMissionApiHints(apiBase, deviceId, entityId, entity.botSecret);
        pushMsg += buildIdentitySetupHint(entity, apiBase, deviceId, entityId, entity.botSecret);

        pushResult = await pushToBot(entity, deviceId, 'new_message', {
            message: pushMsg
        });

        // Retry once after 30s for 502/timeout (cold-start gateways on Zeabur)
        if (!pushResult.pushed && (pushResult.reason === 'http_502' || (pushResult.reason || '').includes('timeout'))) {
            serverLog('warn', 'scheduler', `[Scheduler] Schedule #${schedule.id} got ${pushResult.reason}, retrying in 30s`, { deviceId, entityId });
            await new Promise(r => setTimeout(r, 30000));
            pushResult = await pushToBot(entity, deviceId, 'new_message', { message: pushMsg });
            if (pushResult.pushed) {
                serverLog('info', 'scheduler', `[Scheduler] Schedule #${schedule.id} retry succeeded`, { deviceId, entityId });
            } else {
                serverLog('warn', 'scheduler', `[Scheduler] Schedule #${schedule.id} retry also failed: ${pushResult.reason}`, { deviceId, entityId });
            }
        }

        if (pushResult.pushed) {
            messageObj.delivered = true;
            console.log(`[Scheduler] Push OK to device ${deviceId} entity ${entityId}`);
        }
    }

    // XP: Set deadline for bot to respond; penalty applied if missed
    const SCHEDULE_RESPONSE_DEADLINE_MS = 5 * 60 * 1000; // 5 minutes
    entity._scheduleAwaitingResponse = {
        scheduleId: schedule.id,
        entityId: entityId,
        deadline: Date.now() + SCHEDULE_RESPONSE_DEADLINE_MS
    };

    // Check after deadline if bot responded
    setTimeout(() => {
        if (entity._scheduleAwaitingResponse && entity._scheduleAwaitingResponse.scheduleId === schedule.id) {
            // Bot didn't respond in time — penalty
            console.log(`[XP-PENALTY] Entity ${entityId} missed schedule #${schedule.id} deadline`);
            awardEntityXP(deviceId, entityId, XP_AMOUNTS.MISSED_SCHEDULE, `missed_schedule:${schedule.id}`);
            delete entity._scheduleAwaitingResponse;
        }
    }, SCHEDULE_RESPONSE_DEADLINE_MS + 1000);

    return {
        pushed: pushResult.pushed,
        mode: entity.bindingType === 'channel' ? 'channel' : (entity.webhook ? 'push' : 'polling'),
        reason: pushResult.pushed ? 'ok' : (pushResult.reason || 'unknown')
    };
}

// Init scheduler with chatPool (after DB is ready)
setTimeout(() => {
    scheduler.init(chatPool, executeScheduledMessage, serverLog);
}, 4000);

// ── Schedule API Routes ──

// GET /api/schedules - List schedules for a device
app.get('/api/schedules', async (req, res) => {
    const { deviceId, deviceSecret, status, limit, offset } = req.query;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    try {
        const schedules = await scheduler.getSchedules(deviceId, {
            status: status || undefined,
            limit: parseInt(limit) || 50,
            offset: parseInt(offset) || 0
        });
        res.json({ success: true, schedules });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/schedule-executions - Execution history for a device
app.get('/api/schedule-executions', async (req, res) => {
    const { deviceId, deviceSecret, limit, offset } = req.query;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    try {
        const executions = await scheduler.getExecutions(deviceId, {
            limit: parseInt(limit) || 50,
            offset: parseInt(offset) || 0
        });
        res.json({ success: true, schedules: executions });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/schedule-executions/:executionId/context - Get scheduled message + bot reply
app.get('/api/schedule-executions/:executionId/context', async (req, res) => {
    const { deviceId, deviceSecret } = req.query;
    const { executionId } = req.params;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    try {
        // Get the execution record
        const execResult = await chatPool.query(
            `SELECT * FROM schedule_executions WHERE id = $1 AND device_id = $2`,
            [executionId, deviceId]
        );
        if (execResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Execution not found' });
        }
        const execution = execResult.rows[0];

        // Find the scheduled chat message by schedule_id (exact match), fallback to time window
        let scheduledMsg;
        if (execution.schedule_id) {
            scheduledMsg = await chatPool.query(
                `SELECT * FROM chat_messages
                 WHERE device_id = $1 AND entity_id = $2 AND schedule_id = $3
                 ORDER BY created_at DESC LIMIT 1`,
                [deviceId, execution.entity_id, execution.schedule_id]
            );
        }
        // Fallback: time-based matching if no schedule_id or no result
        if (!scheduledMsg || scheduledMsg.rows.length === 0) {
            scheduledMsg = await chatPool.query(
                `SELECT * FROM chat_messages
                 WHERE device_id = $1 AND entity_id = $2 AND source = 'scheduled'
                 AND created_at BETWEEN ($3::timestamptz - INTERVAL '30 seconds') AND ($3::timestamptz + INTERVAL '30 seconds')
                 ORDER BY ABS(EXTRACT(EPOCH FROM (created_at - $3::timestamptz)))
                 LIMIT 1`,
                [deviceId, execution.entity_id, execution.executed_at]
            );
        }

        // Find bot replies: anchor from scheduled message time (more precise) or execution time
        const replyAnchor = scheduledMsg.rows.length > 0
            ? scheduledMsg.rows[0].created_at
            : execution.executed_at;
        const botReplies = await chatPool.query(
            `SELECT * FROM chat_messages
             WHERE device_id = $1 AND entity_id = $2 AND is_from_bot = true
             AND created_at > $3::timestamptz AND created_at < ($3::timestamptz + INTERVAL '10 minutes')
             ORDER BY created_at ASC
             LIMIT 5`,
            [deviceId, execution.entity_id, replyAnchor]
        );

        res.json({
            success: true,
            execution,
            scheduledMessage: scheduledMsg.rows[0] || null,
            botReplies: botReplies.rows
        });
    } catch (err) {
        console.error('[Schedule] Context error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/schedules - Create a new schedule (DEPRECATED → Kanban)
app.post('/api/schedules', async (req, res) => {
    const lang = req.headers['accept-language'] || '';
    const msg = lang.startsWith('zh')
        ? '此功能已停用，請使用看板任務作為替代方案。看板任務頁面已有完整生態，請讓 bot 將現有任務逐步轉移到看板任務頁面。'
        : 'This endpoint is deprecated. Please use the Kanban board instead. The Kanban board has a complete ecosystem — migrate existing items there gradually.';
    return res.status(410).json({ success: false, error: msg, deprecated: true, redirect: 'kanban' });
});

// PUT /api/schedules/:id - Update a schedule
app.put('/api/schedules/:id', async (req, res) => {
    const { deviceId, deviceSecret, ...updates } = req.body;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    try {
        const existing = await scheduler.getSchedule(parseInt(req.params.id));
        if (!existing || existing.deviceId !== deviceId) {
            return res.status(404).json({ success: false, error: 'Schedule not found' });
        }
        const schedule = await scheduler.updateSchedule(parseInt(req.params.id), updates);
        res.json({ success: true, schedule });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// PATCH /api/schedules/:id/toggle - Toggle pause/resume
app.patch('/api/schedules/:id/toggle', async (req, res) => {
    const { deviceId, deviceSecret } = req.body;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    try {
        const existing = await scheduler.getSchedule(parseInt(req.params.id));
        if (!existing || existing.deviceId !== deviceId) {
            return res.status(404).json({ success: false, error: 'Schedule not found' });
        }
        const schedule = await scheduler.togglePause(parseInt(req.params.id), deviceId);
        res.json({ success: true, schedule });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// DELETE /api/schedules/:id - Delete a schedule
app.delete('/api/schedules/:id', async (req, res) => {
    const { deviceId, deviceSecret } = req.body || {};
    const qDeviceId = deviceId || req.query.deviceId;
    const qDeviceSecret = deviceSecret || req.query.deviceSecret;
    if (!qDeviceId || !qDeviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[qDeviceId];
    if (!device || !safeEqual(device.deviceSecret, qDeviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    try {
        await scheduler.deleteSchedule(parseInt(req.params.id), qDeviceId);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// ── Bot Schedule API (read/write via botSecret or deviceSecret) ──

// GET /api/bot/schedules - Bot reads schedules
app.get('/api/bot/schedules', async (req, res) => {
    const { deviceId, entityId, botSecret, deviceSecret } = req.query;
    if (!deviceId || entityId === undefined || (!botSecret && !deviceSecret)) {
        return res.status(400).json({ success: false, error: 'deviceId, entityId, and botSecret or deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });
    const eId = parseInt(entityId);
    const entity = device.entities[eId];
    const authOk = (deviceSecret && safeEqual(device.deviceSecret, deviceSecret)) ||
                   (botSecret && entity && entity.isBound && safeEqual(entity.botSecret, botSecret));
    if (!entity || !entity.isBound || !authOk) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    try {
        const schedules = await scheduler.getSchedulesForBot(deviceId, eId);
        res.json({ success: true, schedules });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/bot/schedules - Bot creates a schedule (DEPRECATED → Kanban)
app.post('/api/bot/schedules', async (req, res) => {
    const lang = req.headers['accept-language'] || '';
    const msg = lang.startsWith('zh')
        ? '此功能已停用，請使用看板任務作為替代方案。看板任務頁面已有完整生態，請讓 bot 將現有任務逐步轉移到看板任務頁面。'
        : 'This endpoint is deprecated. Please use the Kanban board instead. The Kanban board has a complete ecosystem — migrate existing items there gradually.';
    return res.status(410).json({ success: false, error: msg, deprecated: true, redirect: 'kanban' });
});

// DELETE /api/bot/schedules/:id - Bot deletes a schedule
app.delete('/api/bot/schedules/:id', async (req, res) => {
    const { deviceId, entityId, botSecret, deviceSecret } = req.query;
    if (!deviceId || entityId === undefined || (!botSecret && !deviceSecret)) {
        return res.status(400).json({ success: false, error: 'deviceId, entityId, and botSecret or deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });
    const eId = parseInt(entityId);
    const entity = device.entities[eId];
    const authOk = (deviceSecret && safeEqual(device.deviceSecret, deviceSecret)) ||
                   (botSecret && entity && entity.isBound && safeEqual(entity.botSecret, botSecret));
    if (!entity || !entity.isBound || !authOk) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    try {
        await scheduler.deleteSchedule(parseInt(req.params.id), deviceId);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// Pre-compiled regex for detecting entity-to-entity source patterns (used in saveChatMessage)
const A2A_SOURCE_RE = /^entity:\d+:[A-Z]+->/;

// Save chat message to database, returns row ID (UUID) or null
// Deduplication: bot messages with identical text for the same entity within 10s are skipped
async function saveChatMessage(deviceId, entityId, text, source, isFromUser, isFromBot, mediaType = null, mediaUrl = null, scheduleId = null, scheduleLabel = null, backupUrl = null) {
    try {
        // Dedup: skip if the same BOT message was already saved recently
        // Bot dedup: prevents echo when bot calls multiple endpoints (broadcast + sync-message + transform)
        // User messages are NEVER deduped — users may intentionally send the same message twice
        if (text && isFromBot) {
            const dedup = await chatPool.query(
                `SELECT id FROM chat_messages
                 WHERE device_id = $1 AND entity_id = $2 AND text = $3
                 AND is_from_user = $4 AND is_from_bot = $5
                 AND created_at > NOW() - INTERVAL '10 seconds'
                 LIMIT 1`,
                [deviceId, entityId, text, isFromUser || false, isFromBot || false]
            );
            if (dedup.rows.length > 0) {
                console.log(`[Chat] Dedup: skipping duplicate ${isFromBot ? 'bot' : 'user'} message for entity ${entityId} (existing id=${dedup.rows[0].id}, source="${source}")`);
                return dedup.rows[0].id;
            }
        }

        const result = await chatPool.query(
            `INSERT INTO chat_messages (device_id, entity_id, text, source, is_from_user, is_from_bot, media_type, media_url, schedule_id, schedule_label, backup_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
            [deviceId, entityId, text, source, isFromUser || false, isFromBot || false, mediaType, mediaUrl, scheduleId, scheduleLabel, backupUrl]
        );
        const msgId = result.rows[0]?.id || null;

        // [A2A_CHAT_SAVE] Debug: log entity-to-entity chat message saves for debugging render issues
        if (msgId && source && A2A_SOURCE_RE.test(source)) {
            serverLog('info', 'speakto_push', `[A2A_CHAT_SAVE] id=${msgId} entity_id=${entityId} source=${source} is_from_user=${isFromUser || false} is_from_bot=${isFromBot || false}`, { deviceId, entityId });
        }

        // Emit via Socket.IO for real-time chat updates
        if (msgId && io) {
            io.to(`device:${deviceId}`).emit('chat:message', {
                id: msgId,
                device_id: deviceId,
                entity_id: entityId,
                text, source,
                is_from_user: isFromUser || false,
                is_from_bot: isFromBot || false,
                media_type: mediaType,
                media_url: mediaUrl,
                backup_url: backupUrl,
                schedule_id: scheduleId || null,
                schedule_label: scheduleLabel || null,
                created_at: Date.now()
            });
        }

        return msgId;
    } catch (err) {
        // Silently fail - chat history is non-critical
        if (!err.message.includes('does not exist')) {
            console.warn('[Chat] Failed to save message:', err.message);
        }
        return null;
    }
}

// Mark a chat message as delivered with target entity IDs (APPENDS, does not overwrite)
async function markChatMessageDelivered(chatMsgId, deliveredTo) {
    if (!chatMsgId) return;
    try {
        await chatPool.query(
            `UPDATE chat_messages SET is_delivered = true,
               delivered_to = CASE
                 WHEN delivered_to IS NULL OR delivered_to = '' THEN $2
                 ELSE delivered_to || ',' || $2
               END
             WHERE id = $1`,
            [chatMsgId, deliveredTo]
        );
    } catch (err) {
        // Silently fail
    }
}

// ============================================
// SERVER LOGS (PostgreSQL)
// ============================================

// Auto-create server_logs table
chatPool.query(`
    CREATE TABLE IF NOT EXISTS server_logs (
        id SERIAL PRIMARY KEY,
        level VARCHAR(8) NOT NULL DEFAULT 'info',
        category VARCHAR(32) NOT NULL,
        message TEXT NOT NULL,
        device_id TEXT,
        entity_id INTEGER,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_server_logs_created ON server_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_server_logs_category ON server_logs(category);
    CREATE INDEX IF NOT EXISTS idx_server_logs_device ON server_logs(device_id);
`).catch(() => {});

// Audit logging columns (Issue #177)
chatPool.query(`
    ALTER TABLE server_logs ADD COLUMN IF NOT EXISTS user_id UUID;
    ALTER TABLE server_logs ADD COLUMN IF NOT EXISTS ip_address INET;
    ALTER TABLE server_logs ADD COLUMN IF NOT EXISTS action VARCHAR(64);
    ALTER TABLE server_logs ADD COLUMN IF NOT EXISTS resource VARCHAR(128);
    ALTER TABLE server_logs ADD COLUMN IF NOT EXISTS result VARCHAR(16);
    CREATE INDEX IF NOT EXISTS idx_server_logs_user ON server_logs(user_id) WHERE user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_server_logs_action ON server_logs(action) WHERE action IS NOT NULL;
`).catch(() => {});

// Auto-create handshake_failures table
chatPool.query(`
    CREATE TABLE IF NOT EXISTS handshake_failures (
        id SERIAL PRIMARY KEY,
        device_id TEXT,
        entity_id INTEGER,
        webhook_url TEXT,
        error_type VARCHAR(64) NOT NULL,
        http_status INTEGER,
        error_message TEXT,
        request_payload JSONB,
        response_body TEXT,
        source VARCHAR(32) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_hf_created ON handshake_failures(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_hf_error_type ON handshake_failures(error_type);
    CREATE INDEX IF NOT EXISTS idx_hf_device ON handshake_failures(device_id);
`).catch(() => {});

// Fire-and-forget log writer (never blocks main flow)
function serverLog(level, category, message, opts = {}) {
    const { deviceId, entityId, metadata, userId, ipAddress, action, resource, result } = opts;
    chatPool.query(
        `INSERT INTO server_logs (level, category, message, device_id, entity_id, metadata, user_id, ip_address, action, resource, result)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [level, category, message, deviceId || null, entityId ?? null,
         metadata ? JSON.stringify(metadata) : null,
         userId || null, ipAddress || null, action || null, resource || null, result || null]
    ).catch(() => {}); // Never throw — logs are non-critical
}

// ── Crash handlers: log uncaught errors to /api/logs (category: crash) before dying ──
process.on('uncaughtException', async (err) => {
    console.error('[FATAL] Uncaught exception:', err);
    try {
        await chatPool.query(
            `INSERT INTO server_logs (level, category, message, metadata)
             VALUES ($1, $2, $3, $4)`,
            ['error', 'crash', `Uncaught exception: ${err.message}`,
             JSON.stringify({ stack: err.stack?.substring(0, 2000) })]
        );
    } catch (_) { /* DB write failed, nothing we can do */ }
    process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    console.error('[FATAL] Unhandled rejection:', reason);
    try {
        await chatPool.query(
            `INSERT INTO server_logs (level, category, message, metadata)
             VALUES ($1, $2, $3, $4)`,
            ['error', 'crash', `Unhandled rejection: ${msg}`,
             JSON.stringify({ stack: stack?.substring(0, 2000) })]
        );
    } catch (_) { /* DB write failed, nothing we can do */ }
    process.exit(1);
});

// Fire-and-forget handshake failure recorder
function logHandshakeFailure(opts) {
    const { deviceId, entityId, webhookUrl, errorType, httpStatus, errorMessage, requestPayload, responseBody, source } = opts;
    chatPool.query(
        `INSERT INTO handshake_failures (device_id, entity_id, webhook_url, error_type, http_status, error_message, request_payload, response_body, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [deviceId || null, entityId ?? null, webhookUrl || null, errorType, httpStatus || null,
         errorMessage || null, requestPayload ? JSON.stringify(requestPayload) : null, responseBody || null, source]
    ).catch(() => {});

    // Pre-warm Claude CLI proxy (so it's ready if bot calls /api/ai-support/binding)
    const proxyUrl = process.env.CLAUDE_CLI_PROXY_URL;
    if (proxyUrl) {
        fetch(proxyUrl + '/warmup', { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {});
    }
}

// ============================================================
// ENV VARS API — encrypted DB persistence + JIT approval
// ============================================================

// POST /api/device-vars — client syncs local vars to server (encrypted DB)
// Auth: deviceSecret
// Supports merge mode: when source is provided ("web" or "app"), merges with existing vars
// instead of replacing. Conflicting keys (same key, different value, different source)
// are split into KEY_Web and KEY_APP to avoid data loss.
app.post('/api/device-vars', async (req, res) => {
    const { deviceId, deviceSecret, vars, locked, source } = req.body;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    if (vars !== null && typeof vars !== 'object') {
        return res.status(400).json({ success: false, error: 'vars must be an object' });
    }
    if (!SEAL_KEY_HEX) {
        return res.status(500).json({ success: false, error: 'Encryption not configured' });
    }

    // Sanitize: only string keys + string values
    const incoming = {};
    for (const [k, v] of Object.entries(vars || {})) {
        if (typeof k === 'string' && k.length > 0 && typeof v === 'string') {
            incoming[k] = v;
        }
    }

    const isLocked = locked === true;
    const src = (source === 'web' || source === 'app') ? source : null;

    try {
        let merged = incoming;
        let mergedSources = {};
        let conflicts = [];

        // If source is provided, do merge instead of replace
        if (src) {
            const existing = await db.getDeviceVars(deviceId);
            let existingVars = {};
            let existingSources = {};

            if (existing) {
                try {
                    existingVars = decryptVars(existing.encrypted_vars, existing.iv, existing.auth_tag);
                    existingSources = existing.var_sources || {};
                } catch (e) {
                    console.error(`[Vars] Failed to decrypt existing vars for merge, starting fresh:`, e.message);
                }
            }

            merged = {};
            mergedSources = {};

            // 1. Keep keys from other source that are NOT in incoming
            for (const [k, v] of Object.entries(existingVars)) {
                const keySrc = existingSources[k] || null;
                if (keySrc && keySrc !== src && !(k in incoming)) {
                    // Key from the other platform, not present in incoming — preserve it
                    merged[k] = v;
                    mergedSources[k] = keySrc;
                }
            }

            // 2. Process incoming keys — detect conflicts
            for (const [k, v] of Object.entries(incoming)) {
                const existingVal = existingVars[k];
                const existingSrc = existingSources[k] || null;

                if (existingVal === undefined || existingVal === v || existingSrc === src || !existingSrc) {
                    // No conflict: new key, same value, same source, or no source info
                    merged[k] = v;
                    mergedSources[k] = src;
                } else {
                    // Conflict: same key, different value, different source
                    const otherSrc = existingSrc;
                    const webSuffix = '_Web';
                    const appSuffix = '_APP';

                    // Remove the unsuffixed key from merged (if carried over in step 1)
                    delete merged[k];
                    delete mergedSources[k];

                    // Create suffixed keys
                    const webKey = k + webSuffix;
                    const appKey = k + appSuffix;

                    if (src === 'web') {
                        merged[webKey] = v;
                        mergedSources[webKey] = 'web';
                        merged[appKey] = existingVal;
                        mergedSources[appKey] = 'app';
                    } else {
                        merged[webKey] = existingVal;
                        mergedSources[webKey] = 'web';
                        merged[appKey] = v;
                        mergedSources[appKey] = 'app';
                    }

                    conflicts.push({ key: k, webKey, appKey });
                }
            }

            // 3. Carry over suffixed keys from existing that still belong to the other source
            for (const [k, v] of Object.entries(existingVars)) {
                if (!(k in merged) && (k.endsWith('_Web') || k.endsWith('_APP'))) {
                    const keySrc = existingSources[k] || null;
                    if (keySrc && keySrc !== src) {
                        merged[k] = v;
                        mergedSources[k] = keySrc;
                    }
                }
            }
        } else {
            // Legacy mode (no source): replace all, no merge
            for (const k of Object.keys(incoming)) {
                mergedSources[k] = null;
            }
        }

        const varKeys = Object.keys(merged);
        const { encrypted, iv, authTag } = encryptVars(merged);
        await db.upsertDeviceVars(deviceId, encrypted, iv, authTag, varKeys, isLocked, mergedSources);

        const response = { success: true, count: varKeys.length };

        // Return merged vars so client can sync back
        if (src) {
            response.mergedVars = merged;
            response.sources = mergedSources;
            if (conflicts.length > 0) {
                response.conflicts = conflicts;
            }
        }

        res.json(response);
    } catch (err) {
        console.error(`[Vars] Failed to save vars for ${deviceId}:`, err.message);
        res.status(500).json({ success: false, error: 'Failed to save variables' });
    }
});

// GET /api/device-vars — bot reads vars (botSecret auth)
// Auth: botSecret (entity must be bound to the device)
app.get('/api/device-vars', async (req, res) => {
    const { deviceId, botSecret } = req.query;
    if (!deviceId || !botSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and botSecret required' });
    }
    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, error: 'Device not found' });
    }

    // Authenticate bot
    const allEntities = Object.values(device.entities || {});
    const botEntity = allEntities.find(e => e.isBound && safeEqual(e.botSecret, botSecret));
    if (!botEntity) {
        return res.status(403).json({ success: false, error: 'Invalid botSecret' });
    }

    // Check if vars exist in DB
    const row = await db.getDeviceVars(deviceId);
    if (!row) {
        return res.json({ success: true, vars: {}, hint: 'No vars saved — owner has not configured any variables' });
    }

    // Check lock
    if (row.is_locked) {
        return res.status(403).json({ success: false, error: 'locked', message: 'Variables are locked by owner' });
    }

    // Decrypt and return
    try {
        const vars = decryptVars(row.encrypted_vars, row.iv, row.auth_tag);
        return res.json({ success: true, vars });
    } catch (err) {
        console.error(`[Vars] Decrypt failed for ${deviceId}:`, err.message);
        return res.status(500).json({ success: false, error: 'Decryption failed' });
    }
});

// DELETE /api/device-vars/:key — client deletes a single var by key
// Auth: deviceSecret
app.delete('/api/device-vars/:key', async (req, res) => {
    const { deviceId, deviceSecret } = req.body;
    const keyName = req.params.key;
    if (!deviceId || !deviceSecret || !keyName) {
        return res.status(400).json({ success: false, error: 'deviceId, deviceSecret, and key required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    if (!SEAL_KEY_HEX) {
        return res.status(500).json({ success: false, error: 'Encryption not configured' });
    }
    try {
        const existing = await db.getDeviceVars(deviceId);
        if (!existing) {
            return res.status(404).json({ success: false, error: 'No variables found' });
        }
        let existingVars = {};
        let existingSources = {};
        try {
            existingVars = decryptVars(existing.encrypted_vars, existing.iv, existing.auth_tag);
            existingSources = existing.var_sources || {};
        } catch (e) {
            return res.status(500).json({ success: false, error: 'Failed to decrypt vars' });
        }
        if (!(keyName in existingVars)) {
            return res.status(404).json({ success: false, error: 'Variable not found' });
        }
        delete existingVars[keyName];
        delete existingSources[keyName];
        const { encrypted, iv, authTag } = encryptVars(existingVars);
        const varKeys = Object.keys(existingVars);
        await db.upsertDeviceVars(deviceId, encrypted, iv, authTag, varKeys, existing.is_locked || false, existingSources);
        res.json({ success: true, deletedKey: keyName });
    } catch (err) {
        console.error('[DeviceVars] Delete key error:', err);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// DELETE /api/device-vars — client clears all vars
// Auth: deviceSecret
app.delete('/api/device-vars', async (req, res) => {
    const { deviceId, deviceSecret } = req.body;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    await db.deleteDeviceVars(deviceId);
    res.json({ success: true });
});

// GET /api/logs — Query server logs for debugging
// Auth: requires deviceSecret of ANY device on the server (proves you're an admin/owner)
app.get('/api/logs', async (req, res) => {
    const { deviceId, deviceSecret, category, level, since, limit = 100 } = req.query;

    // Basic auth: must provide a valid deviceId+deviceSecret pair
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    try {
        let query = 'SELECT * FROM server_logs WHERE 1=1';
        const params = [];

        if (category) {
            params.push(category);
            query += ` AND category = $${params.length}`;
        }
        if (level) {
            params.push(level);
            query += ` AND level = $${params.length}`;
        }
        if (since) {
            params.push(new Date(parseInt(since)));
            query += ` AND created_at > $${params.length}`;
        }
        // Optional: filter by a specific device
        if (req.query.filterDevice) {
            params.push(req.query.filterDevice);
            query += ` AND device_id = $${params.length}`;
        }

        params.push(Math.min(parseInt(limit) || 100, 500));
        query += ` ORDER BY created_at DESC LIMIT $${params.length}`;

        const result = await chatPool.query(query, params);
        res.json({ success: true, count: result.rows.length, logs: result.rows.reverse() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/audit-logs — Admin-only audit log query (Issue #177)
app.get('/api/audit-logs', adminAuth, adminCheck, async (req, res) => {
    try {
        const { userId, action, category, since, until, limit = 100 } = req.query;
        let query = 'SELECT id, level, category, message, device_id, entity_id, user_id, ip_address, action, resource, result, created_at FROM server_logs WHERE 1=1';
        const params = [];

        if (userId) { params.push(userId); query += ` AND user_id = $${params.length}`; }
        if (action) { params.push(action); query += ` AND action = $${params.length}`; }
        if (category) { params.push(category); query += ` AND category = $${params.length}`; }
        if (since) { params.push(new Date(parseInt(since))); query += ` AND created_at > $${params.length}`; }
        if (until) { params.push(new Date(parseInt(until))); query += ` AND created_at < $${params.length}`; }

        params.push(Math.min(parseInt(limit) || 100, 500));
        query += ` ORDER BY created_at DESC LIMIT $${params.length}`;

        const result = await chatPool.query(query, params);
        res.json({ success: true, count: result.rows.length, logs: result.rows.reverse() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/handshake-failures — Query handshake failure records for analysis
app.get('/api/handshake-failures', async (req, res) => {
    const { deviceId, deviceSecret, error_type, source, since, limit = 100 } = req.query;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    try {
        let query = 'SELECT * FROM handshake_failures WHERE 1=1';
        const params = [];

        if (error_type) {
            params.push(error_type);
            query += ` AND error_type = $${params.length}`;
        }
        if (source) {
            params.push(source);
            query += ` AND source = $${params.length}`;
        }
        if (since) {
            params.push(new Date(parseInt(since)));
            query += ` AND created_at > $${params.length}`;
        }
        if (req.query.filterDevice) {
            params.push(req.query.filterDevice);
            query += ` AND device_id = $${params.length}`;
        }

        params.push(Math.min(parseInt(limit) || 100, 500));
        query += ` ORDER BY created_at DESC LIMIT $${params.length}`;

        const result = await chatPool.query(query, params);
        res.json({ success: true, count: result.rows.length, failures: result.rows.reverse() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// DEVICE TELEMETRY API — structured debug buffer (~1 MB / device)
// ============================================

// POST /api/device-telemetry — Device pushes telemetry entries
app.post('/api/device-telemetry', async (req, res) => {
    const { deviceId, deviceSecret, entries, appVersion, appVersionCode, platform } = req.body;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ success: false, error: 'entries array required' });
    }
    // Store appVersion/platform on device entities for AI Support and feedback
    if (appVersion && device) {
        for (const entity of Object.values(device.entities)) {
            if (entity) entity.appVersion = appVersion;
        }
        device.appVersion = appVersion;
        if (appVersionCode) device.appVersionCode = appVersionCode;
    }
    if (platform && device) {
        device.lastPlatform = platform;
    }
    // Cap batch size to 100 entries per request
    const batch = entries.slice(0, 100);
    const result = await telemetry.appendEntries(chatPool, deviceId, batch);
    res.json({
        success: true,
        accepted: result.accepted,
        dropped: result.dropped,
        bufferUsed: result.bufferUsed,
        maxBuffer: telemetry.MAX_BUFFER_BYTES
    });
});

// GET /api/device-telemetry — Read telemetry for debugging
app.get('/api/device-telemetry', async (req, res) => {
    const { deviceId, deviceSecret, type, page, action, since, until, limit } = req.query;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    const entries = await telemetry.getEntries(chatPool, deviceId, { type, page, action, since, until, limit });
    res.json({ success: true, count: entries.length, entries });
});

// GET /api/device-telemetry/summary — Quick overview of a device's buffer
app.get('/api/device-telemetry/summary', async (req, res) => {
    const { deviceId, deviceSecret } = req.query;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    const summary = await telemetry.getSummary(chatPool, deviceId);
    res.json({ success: true, ...summary });
});

// DELETE /api/device-telemetry — Clear a device's telemetry buffer
app.delete('/api/device-telemetry', async (req, res) => {
    const { deviceId, deviceSecret } = req.body;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    await telemetry.clearEntries(chatPool, deviceId);
    res.json({ success: true, message: 'Telemetry buffer cleared' });
});

// Mark user messages as read when bot responds
async function markMessagesAsRead(deviceId, entityId) {
    try {
        await chatPool.query(
            `UPDATE chat_messages SET read_at = NOW()
             WHERE device_id = $1 AND entity_id = $2
             AND is_from_user = true AND read_at IS NULL`,
            [deviceId, entityId]
        );
    } catch (err) {
        // Silently fail - read receipts are non-critical
    }
}

// GET /api/chat/history
app.get('/api/chat/history', async (req, res) => {
    const { deviceId, deviceSecret, limit = 500, before, since } = req.query;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'Missing credentials' });
    }

    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        // Also check JWT cookie
        const jwt = require('jsonwebtoken');
        const token = req.cookies && req.cookies.eclaw_session;
        if (token) {
            try {
                const decoded = jwt.verify(token, JWT_SECRET_FALLBACK);
                if (decoded.deviceId !== deviceId) {
                    return res.status(401).json({ success: false, error: 'Invalid credentials' });
                }
            } catch {
                return res.status(401).json({ success: false, error: 'Invalid credentials' });
            }
        } else {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
    }

    try {
        let query = `SELECT m.*, r.reaction_type AS user_reaction
            FROM chat_messages m
            LEFT JOIN message_reactions r ON r.message_id = m.id AND r.device_id = m.device_id
            WHERE m.device_id = $1`;
        const params = [deviceId];

        if (since) {
            query += ' AND m.created_at > $' + (params.length + 1);
            params.push(new Date(parseInt(since)));
        } else if (before) {
            query += ' AND m.created_at < $' + (params.length + 1);
            params.push(new Date(parseInt(before)));
        }

        query += ' ORDER BY m.created_at DESC LIMIT $' + (params.length + 1);
        params.push(parseInt(limit) || 500);

        const result = await chatPool.query(query, params);

        // Reverse to chronological order (query uses DESC to get latest N)
        res.json({
            success: true,
            messages: result.rows.reverse()
        });
    } catch (error) {
        console.error('[Chat] History error:', error);
        res.status(500).json({ success: false, error: 'Failed to get chat history' });
    }
});

/**
 * GET /api/chat/history-by-code — Get chat history involving a specific publicCode
 * Query: ?deviceId=X&deviceSecret=Y&publicCode=ABC123&limit=50
 */
app.get('/api/chat/history-by-code', async (req, res) => {
    let { deviceId, deviceSecret, publicCode, limit } = req.query;
    if (!deviceId && req.user) { deviceId = req.user.deviceId; deviceSecret = req.user.deviceSecret; }
    if (!deviceId || !deviceSecret || !publicCode) {
        return res.status(400).json({ success: false, error: 'Missing deviceId, deviceSecret, or publicCode' });
    }

    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        if (!req.user || req.user.deviceId !== deviceId) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
    }

    const code = publicCode.trim().toLowerCase();
    const maxLimit = Math.min(parseInt(limit) || 50, 200);

    try {
        // Cross-speak messages have source like "xdevice:{code}:{char}->{target}" or "->{code}"
        const result = await chatPool.query(
            `SELECT * FROM chat_messages
             WHERE device_id = $1
             AND (source ILIKE $2 OR source ILIKE $3)
             ORDER BY created_at DESC LIMIT $4`,
            [deviceId, `%xdevice:${code}:%`, `%->` + code, maxLimit]
        );
        res.json({ success: true, messages: result.rows.reverse() });
    } catch (error) {
        console.error('[Chat] History-by-code error:', error);
        res.status(500).json({ success: false, error: 'Failed to get chat history' });
    }
});

/**
 * GET /api/chat/share-history — Get cross-speak conversation for shareable chat link
 * Returns messages between the authenticated sender and the target entity (by publicCode).
 * Queries TWO sources:
 *   1. Target device: sender's cross-device messages (source contains sender deviceId)
 *   2. Sender device: auto-routed bot replies (source contains target publicCode)
 * This avoids leaking unrelated bot messages from the target device.
 * Auth: JWT cookie (eclaw_session) required.
 * Query: ?code=ABC123&limit=50&since=TIMESTAMP_MS
 */
app.get('/api/chat/share-history', async (req, res) => {
    if (!req.user || !req.user.deviceId) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const { code, limit, since } = req.query;
    if (!code) {
        return res.status(400).json({ success: false, error: 'code parameter required' });
    }

    // Resolve target entity by publicCode
    const target = publicCodeIndex[code];
    if (!target) {
        return res.status(404).json({ success: false, error: 'Entity not found' });
    }

    const maxLimit = Math.min(parseInt(limit) || 50, 200);
    const senderDeviceId = req.user.deviceId;

    try {
        // Query two sources to build the full conversation:
        // 1. Target device: sender's messages (source contains sender's deviceId)
        // 2. Sender device: auto-routed bot replies (source contains target publicCode like "xdevice:CODE:...")
        const senderPattern = `%${senderDeviceId}%`;
        const targetCodePattern = `%${code}%`;
        let query, params;
        if (since) {
            const sinceTs = new Date(parseInt(since));
            query = `(SELECT id, text, source, is_from_user, is_from_bot, media_type, media_url, created_at, is_delivered
                      FROM chat_messages
                      WHERE device_id = $1 AND entity_id = $2
                      AND source ILIKE $3
                      AND created_at > $6)
                     UNION ALL
                     (SELECT id, text, source, is_from_user, is_from_bot, media_type, media_url, created_at, is_delivered
                      FROM chat_messages
                      WHERE device_id = $5 AND is_from_bot = true
                      AND source ILIKE $4
                      AND created_at > $6)
                     ORDER BY created_at ASC LIMIT $7`;
            params = [target.deviceId, target.entityId, senderPattern, targetCodePattern, senderDeviceId, sinceTs, maxLimit];
        } else {
            query = `(SELECT id, text, source, is_from_user, is_from_bot, media_type, media_url, created_at, is_delivered
                      FROM chat_messages
                      WHERE device_id = $1 AND entity_id = $2
                      AND source ILIKE $3)
                     UNION ALL
                     (SELECT id, text, source, is_from_user, is_from_bot, media_type, media_url, created_at, is_delivered
                      FROM chat_messages
                      WHERE device_id = $5 AND is_from_bot = true
                      AND source ILIKE $4)
                     ORDER BY created_at ASC LIMIT $6`;
            params = [target.deviceId, target.entityId, senderPattern, targetCodePattern, senderDeviceId, maxLimit];
        }

        const result = await chatPool.query(query, params);
        const messages = result.rows;

        res.json({ success: true, messages });
    } catch (error) {
        console.error('[Chat] Share-history error:', error);
        res.status(500).json({ success: false, error: 'Failed to get chat history' });
    }
});

// ============================================
// MESSAGE REACTIONS (Like / Dislike)
// ============================================

/**
 * POST /api/chat/integrity-report
 * Receives chat display/data integrity mismatch reports from Web/Android.
 * Auto-logs, persists, and creates GitHub issues on new mismatches.
 * Body: { deviceId, deviceSecret, platform, layer, checkType, description, expected, actual, affectedIds, appVersion }
 */
app.post('/api/chat/integrity-report', async (req, res) => {
    const { deviceId, deviceSecret } = req.body;
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    try {
        const result = await chatIntegrity.report(chatPool, req.body, { serverLog });
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('[ChatIntegrity] Endpoint error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/message/:messageId/react
 * Toggle like/dislike on a bot message. Awards/deducts XP accordingly.
 * Body: { deviceId, deviceSecret, reaction: "like" | "dislike" | null }
 */
app.post('/api/message/:messageId/react', async (req, res) => {
    const { messageId } = req.params;
    const { deviceId, deviceSecret, reaction } = req.body;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'Missing credentials' });
    }

    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    if (reaction !== null && reaction !== 'like' && reaction !== 'dislike') {
        return res.status(400).json({ success: false, error: 'reaction must be "like", "dislike", or null' });
    }

    try {
        // Verify message exists, belongs to this device, and is from bot
        const msgResult = await chatPool.query(
            'SELECT id, device_id, entity_id, is_from_bot FROM chat_messages WHERE id = $1',
            [messageId]
        );
        if (msgResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Message not found' });
        }
        const msg = msgResult.rows[0];
        if (msg.device_id !== deviceId) {
            return res.status(403).json({ success: false, error: 'Not your message' });
        }
        if (!msg.is_from_bot) {
            return res.status(400).json({ success: false, error: 'Can only react to bot messages' });
        }

        // Get existing reaction (if any)
        const existingResult = await chatPool.query(
            'SELECT reaction_type FROM message_reactions WHERE message_id = $1 AND device_id = $2',
            [messageId, deviceId]
        );
        const oldReaction = existingResult.rows[0]?.reaction_type || null;

        // Skip if same reaction
        if (oldReaction === reaction) {
            const counts = await chatPool.query(
                'SELECT like_count, dislike_count FROM chat_messages WHERE id = $1',
                [messageId]
            );
            return res.json({
                success: true, reaction, unchanged: true,
                like_count: counts.rows[0]?.like_count || 0,
                dislike_count: counts.rows[0]?.dislike_count || 0
            });
        }

        // Calculate XP delta: reverse old reaction, apply new one
        let xpDelta = 0;
        if (oldReaction === 'like') xpDelta -= XP_AMOUNTS.MESSAGE_LIKED;     // reverse +5
        if (oldReaction === 'dislike') xpDelta -= XP_AMOUNTS.MESSAGE_DISLIKED; // reverse -5 (adds +5)
        if (reaction === 'like') xpDelta += XP_AMOUNTS.MESSAGE_LIKED;          // apply +5
        if (reaction === 'dislike') xpDelta += XP_AMOUNTS.MESSAGE_DISLIKED;    // apply -5

        // Update/insert/delete reaction
        if (reaction === null) {
            await chatPool.query(
                'DELETE FROM message_reactions WHERE message_id = $1 AND device_id = $2',
                [messageId, deviceId]
            );
        } else if (oldReaction) {
            await chatPool.query(
                'UPDATE message_reactions SET reaction_type = $3, created_at = NOW() WHERE message_id = $1 AND device_id = $2',
                [messageId, deviceId, reaction]
            );
        } else {
            await chatPool.query(
                'INSERT INTO message_reactions (message_id, device_id, reaction_type) VALUES ($1, $2, $3)',
                [messageId, deviceId, reaction]
            );
        }

        // Update counts on chat_messages
        const likeDelta = (reaction === 'like' ? 1 : 0) - (oldReaction === 'like' ? 1 : 0);
        const dislikeDelta = (reaction === 'dislike' ? 1 : 0) - (oldReaction === 'dislike' ? 1 : 0);
        await chatPool.query(
            `UPDATE chat_messages SET
                like_count = GREATEST(0, COALESCE(like_count, 0) + $2),
                dislike_count = GREATEST(0, COALESCE(dislike_count, 0) + $3)
             WHERE id = $1`,
            [messageId, likeDelta, dislikeDelta]
        );

        // Award/deduct XP
        let xpResult = null;
        if (xpDelta !== 0 && msg.entity_id != null) {
            const reason = reaction === 'like' ? 'message_liked' : reaction === 'dislike' ? 'message_disliked' : 'reaction_removed';
            xpResult = awardEntityXP(deviceId, msg.entity_id, xpDelta, reason);
        }

        // Get updated counts
        const updatedCounts = await chatPool.query(
            'SELECT like_count, dislike_count FROM chat_messages WHERE id = $1',
            [messageId]
        );

        const responseData = {
            success: true,
            reaction,
            like_count: updatedCounts.rows[0]?.like_count || 0,
            dislike_count: updatedCounts.rows[0]?.dislike_count || 0,
            xpResult
        };

        // Emit Socket.IO event for real-time UI update
        if (io) {
            io.to(`device:${deviceId}`).emit('chat:reaction', {
                messageId: parseInt(messageId),
                reaction,
                like_count: responseData.like_count,
                dislike_count: responseData.dislike_count
            });
        }

        res.json(responseData);
    } catch (error) {
        console.error('[Reactions] Error:', error);
        res.status(500).json({ success: false, error: 'Failed to process reaction' });
    }
});

// ============================================
// DEVICE FILE MANAGER - List all media files from chat history
// ============================================
app.get('/api/device/files', async (req, res) => {
    const { deviceId, deviceSecret, type, entityId, limit = 200, before } = req.query;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'Missing credentials' });
    }

    // Auth: deviceSecret or JWT cookie
    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        const jwt = require('jsonwebtoken');
        const token = req.cookies && req.cookies.eclaw_session;
        if (token) {
            try {
                const decoded = jwt.verify(token, JWT_SECRET_FALLBACK);
                if (decoded.deviceId !== deviceId) {
                    return res.status(401).json({ success: false, error: 'Invalid credentials' });
                }
            } catch {
                return res.status(401).json({ success: false, error: 'Invalid credentials' });
            }
        } else {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
    }

    try {
        const { since, until } = req.query;

        let query = `SELECT id, entity_id, text, source, is_from_user, is_from_bot,
                            media_type, media_url, created_at
                     FROM chat_messages
                     WHERE device_id = $1 AND media_url IS NOT NULL AND media_url != ''`;
        const params = [deviceId];

        // Filter by media type
        if (type === 'photo') {
            query += ` AND media_type = 'photo'`;
        } else if (type === 'voice') {
            query += ` AND media_type = 'voice'`;
        }

        // Filter by entity
        if (entityId !== undefined && entityId !== '') {
            params.push(parseInt(entityId));
            query += ` AND entity_id = $${params.length}`;
        }

        // Time range filtering
        if (since) {
            params.push(new Date(parseInt(since)));
            query += ` AND created_at >= $${params.length}`;
        }
        if (until) {
            params.push(new Date(parseInt(until)));
            query += ` AND created_at <= $${params.length}`;
        }

        // Pagination
        if (before) {
            params.push(new Date(parseInt(before)));
            query += ` AND created_at < $${params.length}`;
        }

        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
        params.push(parseInt(limit) || 200);

        const result = await chatPool.query(query, params);

        // Group files with the same media_url (broadcast files) into a single entry
        const urlMap = new Map();
        for (const row of result.rows) {
            const url = row.media_url;
            if (urlMap.has(url)) {
                const existing = urlMap.get(url);
                if (!existing.entityIds.includes(row.entity_id)) {
                    existing.entityIds.push(row.entity_id);
                }
                // Keep earliest created_at
                if (new Date(row.created_at) < new Date(existing.createdAt)) {
                    existing.createdAt = row.created_at;
                }
            } else {
                urlMap.set(url, {
                    id: row.id,
                    entityId: row.entity_id,
                    entityIds: [row.entity_id],
                    type: row.media_type,
                    url: url,
                    text: row.text,
                    source: row.source,
                    isFromUser: row.is_from_user,
                    isFromBot: row.is_from_bot,
                    createdAt: row.created_at
                });
            }
        }

        const files = Array.from(urlMap.values()).sort((a, b) =>
            new Date(b.createdAt) - new Date(a.createdAt)
        );

        res.json({
            success: true,
            files,
            count: files.length,
            hasMore: result.rows.length >= (parseInt(limit) || 200)
        });
    } catch (error) {
        console.error('[Files] List error:', error);
        res.status(500).json({ success: false, error: 'Failed to list files' });
    }
});

// ============================================
// DELETE DEVICE FILE (remove chat media record)
// ============================================
app.delete('/api/device/files/:fileId', async (req, res) => {
    const { fileId } = req.params;
    const deviceId = req.query.deviceId || req.body.deviceId;
    const deviceSecret = req.query.deviceSecret || req.body.deviceSecret;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'Missing credentials' });
    }

    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        const jwt = require('jsonwebtoken');
        const token = req.cookies && req.cookies.eclaw_session;
        if (token) {
            try {
                const decoded = jwt.verify(token, JWT_SECRET_FALLBACK);
                if (decoded.deviceId !== deviceId) {
                    return res.status(401).json({ success: false, error: 'Invalid credentials' });
                }
            } catch {
                return res.status(401).json({ success: false, error: 'Invalid credentials' });
            }
        } else {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
    }

    try {
        // Verify the file belongs to this device before deleting
        const check = await chatPool.query(
            'SELECT id, media_url FROM chat_messages WHERE id = $1 AND device_id = $2',
            [fileId, deviceId]
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'File not found' });
        }

        // Delete the chat message record (and any broadcast duplicates with same media_url)
        const mediaUrl = check.rows[0].media_url;
        const deleted = await chatPool.query(
            'DELETE FROM chat_messages WHERE device_id = $1 AND media_url = $2 RETURNING id',
            [deviceId, mediaUrl]
        );

        // Also delete from chat_uploads if it was a DB-stored file
        if (mediaUrl && mediaUrl.includes('/api/chat/file/')) {
            const uploadIdMatch = mediaUrl.match(/\/api\/chat\/file\/(\d+)/);
            if (uploadIdMatch) {
                await chatPool.query('DELETE FROM chat_uploads WHERE id = $1 AND device_id = $2',
                    [parseInt(uploadIdMatch[1]), deviceId]);
            }
        }

        serverLog(deviceId, 'file_delete', `Deleted file ${fileId} (${deleted.rowCount} records)`);
        res.json({ success: true, deletedCount: deleted.rowCount });
    } catch (error) {
        console.error('[Files] Delete error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete file' });
    }
});

// ============================================
// CHAT MEDIA UPLOAD (Flickr for photos, Base64 for voice, DB for files)
// ============================================
const mediaUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
    fileFilter: (req, file, cb) => {
        const imageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        const audioTypes = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/mpeg'];
        const videoTypes = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'];
        const mediaType = (req.body && req.body.mediaType) || '';
        if (mediaType === 'photo' && !imageTypes.includes(file.mimetype)) {
            cb(new Error('Unsupported image type: ' + file.mimetype));
        } else if (mediaType === 'voice' && !audioTypes.includes(file.mimetype)) {
            cb(new Error('Unsupported audio type: ' + file.mimetype));
        } else if (mediaType === 'video' && !videoTypes.includes(file.mimetype)) {
            cb(new Error('Unsupported video type: ' + file.mimetype));
        } else {
            cb(null, true); // "file" type accepts anything
        }
    }
});

// Auto-migrate: create chat_uploads table for file storage
chatPool.query(`
    CREATE TABLE IF NOT EXISTS chat_uploads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        device_id VARCHAR(64) NOT NULL,
        original_name TEXT NOT NULL,
        content_type VARCHAR(128) NOT NULL,
        file_data BYTEA NOT NULL,
        file_size BIGINT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
`).catch(err => console.error('[ChatUploads] Table creation error:', err.message));

// ============================================
// PHOTO CACHE - Backup for Flickr rate limits
// Max 5 photos per device, stored in memory
// ============================================
const photoCache = new Map();       // mediaId -> { buffer, contentType, deviceId, createdAt }
const devicePhotos = new Map();     // deviceId -> [mediaId, ...] (oldest first)
const flickrToBackup = new Map();   // flickrUrl -> mediaId (for auto-lookup in push)
const MAX_PHOTOS_PER_DEVICE = 5;

function cachePhoto(deviceId, buffer, contentType) {
    const mediaId = `${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;

    if (!devicePhotos.has(deviceId)) {
        devicePhotos.set(deviceId, []);
    }
    const deviceList = devicePhotos.get(deviceId);

    // Evict oldest if at limit
    while (deviceList.length >= MAX_PHOTOS_PER_DEVICE) {
        const oldId = deviceList.shift();
        // Remove flickrUrl mapping pointing to this old ID
        for (const [url, id] of flickrToBackup) {
            if (id === oldId) { flickrToBackup.delete(url); break; }
        }
        photoCache.delete(oldId);
        console.log(`[PhotoCache] Evicted ${oldId} for device ${deviceId}`);
    }

    photoCache.set(mediaId, { buffer, contentType, deviceId, createdAt: Date.now() });
    deviceList.push(mediaId);
    console.log(`[PhotoCache] Cached ${mediaId} for device ${deviceId} (${deviceList.length}/${MAX_PHOTOS_PER_DEVICE})`);
    return mediaId;
}

function getBackupUrl(flickrUrl) {
    const mediaId = flickrToBackup.get(flickrUrl);
    if (mediaId && photoCache.has(mediaId)) {
        return `https://eclawbot.com/api/media/${mediaId}`;
    }
    return null;
}

/**
 * GET /api/media/:id - Serve cached photo
 */
app.get('/api/media/:id', (req, res) => {
    const cached = photoCache.get(req.params.id);
    if (!cached) {
        return res.status(404).json({ error: 'Media not found or expired' });
    }
    res.set('Content-Type', cached.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(cached.buffer);
});

/**
 * GET /api/chat/file/:id - Serve uploaded file from DB
 */
app.get('/api/chat/file/:id', async (req, res) => {
    try {
        // First query metadata only (no file_data) to support Range requests efficiently
        const metaResult = await chatPool.query(
            'SELECT original_name, content_type, file_size FROM chat_uploads WHERE id = $1',
            [req.params.id]
        );
        if (metaResult.rows.length === 0) {
            return res.status(404).json({ error: 'File not found' });
        }
        const { original_name, content_type, file_size } = metaResult.rows[0];
        const totalSize = parseInt(file_size);

        res.set('Content-Type', content_type);
        res.set('Content-Disposition', `inline; filename="${encodeURIComponent(original_name)}"`);
        res.set('Cache-Control', 'public, max-age=86400');
        res.set('Accept-Ranges', 'bytes');

        const rangeHeader = req.headers.range;
        if (rangeHeader) {
            // Parse Range header (e.g. "bytes=0-1023")
            const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
            if (!match) {
                res.status(416).set('Content-Range', `bytes */${totalSize}`).end();
                return;
            }
            const start = parseInt(match[1]);
            const end = match[2] ? parseInt(match[2]) : totalSize - 1;
            if (start >= totalSize || end >= totalSize || start > end) {
                res.status(416).set('Content-Range', `bytes */${totalSize}`).end();
                return;
            }
            const chunkSize = end - start + 1;
            // PostgreSQL SUBSTRING on BYTEA is 1-indexed
            const dataResult = await chatPool.query(
                'SELECT SUBSTRING(file_data FROM $1 FOR $2) AS chunk FROM chat_uploads WHERE id = $3',
                [start + 1, chunkSize, req.params.id]
            );
            res.status(206);
            res.set('Content-Range', `bytes ${start}-${end}/${totalSize}`);
            res.set('Content-Length', chunkSize);
            res.send(dataResult.rows[0].chunk);
        } else {
            // No Range header — serve entire file
            const dataResult = await chatPool.query(
                'SELECT file_data FROM chat_uploads WHERE id = $1',
                [req.params.id]
            );
            res.set('Content-Length', totalSize);
            res.send(dataResult.rows[0].file_data);
        }
    } catch (err) {
        console.error('[ChatFile] Serve error:', err);
        res.status(500).json({ error: 'Failed to serve file' });
    }
});

/**
 * POST /api/chat/upload-media
 * Upload photo (→ Flickr), voice (→ base64), or file (→ DB) for chat messages
 * Body (multipart): file, deviceId, deviceSecret, mediaType ("photo" | "voice" | "file")
 * Max file size: 100MB
 */
app.post('/api/chat/upload-media', mediaUpload.single('file'), async (req, res) => {
    const { deviceId, deviceSecret, mediaType } = req.body;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'Missing credentials' });
    }

    const device = devices[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    try {
        let mediaUrl;
        let backupUrl = null;

        if (mediaType === 'photo') {
            if (!flickr.isAvailable()) {
                return res.status(503).json({ success: false, error: 'Photo upload service unavailable (Flickr not configured)' });
            }
            const result = await flickr.uploadPhoto(req.file.buffer, req.file.originalname || 'photo.jpg');
            if (!result.success) {
                return res.status(500).json({ success: false, error: 'Flickr upload failed: ' + result.error });
            }
            mediaUrl = result.url;

            // Cache photo on backend as backup (max 5 per device)
            const mediaId = cachePhoto(deviceId, req.file.buffer, req.file.mimetype);
            backupUrl = `https://eclawbot.com/api/media/${mediaId}`;
            flickrToBackup.set(result.url, mediaId);
            console.log(`[Upload] Photo cached: ${backupUrl}`);
        } else if (mediaType === 'voice') {
            const base64 = req.file.buffer.toString('base64');
            mediaUrl = `data:${req.file.mimetype};base64,${base64}`;
        } else if (mediaType === 'video' || mediaType === 'file') {
            // Store video/file in PostgreSQL
            const originalName = req.file.originalname || (mediaType === 'video' ? 'video.mp4' : 'file');
            const result = await chatPool.query(
                'INSERT INTO chat_uploads (device_id, original_name, content_type, file_data, file_size) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                [deviceId, originalName, req.file.mimetype, req.file.buffer, req.file.buffer.length]
            );
            const fileId = result.rows[0].id;
            mediaUrl = `https://eclawbot.com/api/chat/file/${fileId}`;
            console.log(`[Upload] ${mediaType === 'video' ? 'Video' : 'File'} stored: ${originalName} (${(req.file.buffer.length / 1024 / 1024).toFixed(2)} MB) -> ${fileId}`);
        } else {
            return res.status(400).json({ success: false, error: 'Invalid mediaType. Use "photo", "voice", "video", or "file"' });
        }

        const fileName = req.file.originalname || null;
        res.json({ success: true, mediaUrl, mediaType, backupUrl, fileName });
    } catch (err) {
        console.error('[Upload] Error:', err);
        res.status(500).json({ success: false, error: 'Upload failed: ' + err.message });
    }
});

// ============================================
// BOT FILE STORAGE API
// ============================================

// Auto-migrate: create bot_files table
chatPool.query(`
    CREATE TABLE IF NOT EXISTS bot_files (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        device_id VARCHAR(64) NOT NULL,
        entity_id INTEGER NOT NULL,
        filename VARCHAR(255) NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(device_id, entity_id, filename)
    );
    CREATE INDEX IF NOT EXISTS idx_bot_files_device_entity ON bot_files(device_id, entity_id);
`).catch(err => console.warn('[BotFiles] Table migration:', err.message));

const BOT_FILE_MAX_SIZE = 15 * 1024 * 1024; // 15MB per file
const BOT_FILE_MAX_COUNT = 20;       // 20 files per entity

function authenticateBot(deviceId, entityId, botSecret) {
    const device = devices[deviceId];
    if (!device) return false;
    const entity = (device.entities || {})[entityId];
    return entity && safeEqual(entity.botSecret, botSecret);
}

/**
 * PUT /api/bot/file - Create or update a file (upsert)
 */
app.put('/api/bot/file', express.json({ limit: '20mb' }), async (req, res) => {
    const { deviceId, entityId, botSecret, filename, content } = req.body;
    if (!deviceId || entityId == null || !botSecret || !filename) {
        return res.status(400).json({ success: false, error: 'Missing required fields: deviceId, entityId, botSecret, filename' });
    }
    if (!authenticateBot(deviceId, parseInt(entityId), botSecret)) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    const fileContent = content || '';
    if (Buffer.byteLength(fileContent, 'utf8') > BOT_FILE_MAX_SIZE) {
        return res.status(413).json({ success: false, error: `File too large (max ${BOT_FILE_MAX_SIZE / 1024}KB)` });
    }
    try {
        // Check file count limit
        const countResult = await chatPool.query(
            'SELECT COUNT(*) as cnt FROM bot_files WHERE device_id = $1 AND entity_id = $2',
            [deviceId, parseInt(entityId)]
        );
        const existingCount = parseInt(countResult.rows[0].cnt);
        // Check if this is an update (file already exists)
        const existing = await chatPool.query(
            'SELECT id FROM bot_files WHERE device_id = $1 AND entity_id = $2 AND filename = $3',
            [deviceId, parseInt(entityId), filename]
        );
        if (existing.rows.length === 0 && existingCount >= BOT_FILE_MAX_COUNT) {
            return res.status(429).json({ success: false, error: `File limit reached (max ${BOT_FILE_MAX_COUNT} files per entity)` });
        }
        const result = await chatPool.query(
            `INSERT INTO bot_files (device_id, entity_id, filename, content)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (device_id, entity_id, filename)
             DO UPDATE SET content = $4, updated_at = NOW()
             RETURNING id, filename, created_at, updated_at`,
            [deviceId, parseInt(entityId), filename, fileContent]
        );
        res.json({ success: true, file: result.rows[0] });
    } catch (err) {
        console.error('[BotFiles] PUT error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/bot/file - Read a single file
 */
app.get('/api/bot/file', async (req, res) => {
    const { deviceId, entityId, botSecret, filename } = req.query;
    if (!deviceId || entityId == null || !botSecret || !filename) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    if (!authenticateBot(deviceId, parseInt(entityId), botSecret)) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    try {
        const result = await chatPool.query(
            'SELECT filename, content, created_at, updated_at FROM bot_files WHERE device_id = $1 AND entity_id = $2 AND filename = $3',
            [deviceId, parseInt(entityId), filename]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: `File not found: "${filename}"` });
        }
        res.json({ success: true, file: result.rows[0] });
    } catch (err) {
        console.error('[BotFiles] GET error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/bot/files - List all files for an entity
 */
app.get('/api/bot/files', async (req, res) => {
    const { deviceId, entityId, botSecret } = req.query;
    if (!deviceId || entityId == null || !botSecret) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    if (!authenticateBot(deviceId, parseInt(entityId), botSecret)) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    try {
        const result = await chatPool.query(
            'SELECT filename, length(content) as size, created_at, updated_at FROM bot_files WHERE device_id = $1 AND entity_id = $2 ORDER BY updated_at DESC',
            [deviceId, parseInt(entityId)]
        );
        res.json({ success: true, files: result.rows, count: result.rows.length, maxCount: BOT_FILE_MAX_COUNT });
    } catch (err) {
        console.error('[BotFiles] LIST error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * DELETE /api/bot/file - Delete a file
 */
app.delete('/api/bot/file', async (req, res) => {
    const { deviceId, entityId, botSecret, filename } = req.body;
    if (!deviceId || entityId == null || !botSecret || !filename) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    if (!authenticateBot(deviceId, parseInt(entityId), botSecret)) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    try {
        const result = await chatPool.query(
            'DELETE FROM bot_files WHERE device_id = $1 AND entity_id = $2 AND filename = $3 RETURNING filename',
            [deviceId, parseInt(entityId), filename]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: `File not found: "${filename}"` });
        }
        res.json({ success: true, message: `File "${filename}" deleted` });
    } catch (err) {
        console.error('[BotFiles] DELETE error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

if (require.main === module) {
    httpServer.listen(port, '0.0.0.0', async () => {
        console.log(`Claw Backend v5.4 (Socket.IO + Notifications) running on port ${port}`);
        console.log(`Dynamic entity system: initial slots=${DEFAULT_INITIAL_SLOTS}, no upper limit`);
        console.log(`Persistence: ${usePostgreSQL ? 'PostgreSQL' : 'File Storage (Fallback)'}`);

        // Initialize Flickr client
        flickr.initFlickr();

        // Start gRPC server on PORT+1
        try {
            const grpcModule = require('./grpc-server')(devices, { serverLog });
            const grpcPort = parseInt(process.env.GRPC_PORT || (port + 1));
            grpcModule.startGrpcServer(grpcPort);
        } catch (err) {
            console.error('[gRPC] Failed to initialize:', err.message);
        }

        // Entity trash cleanup: purge expired items every 6 hours
        if (usePostgreSQL) {
            setInterval(async () => {
                try {
                    const count = await db.cleanupExpiredTrash();
                    if (count > 0) console.log(`[Trash] Cleaned up ${count} expired trash items`);
                } catch (err) {
                    console.error('[Trash] Cleanup error:', err.message);
                }
            }, 6 * 60 * 60 * 1000);

            // Cleanup orphaned pending cross-device messages older than 7 days
            setInterval(async () => {
                try {
                    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
                    await db.cleanupExpiredPendingMessages(cutoff);
                } catch (err) {
                    console.error('[PendingCleanup] Error:', err.message);
                }
            }, 6 * 60 * 60 * 1000);
        }
    });
}
// Force redeploy Mon Feb 17 2026 - fix startCommand: node index.js (no cd backend)

// ============================================
// BOT MESSAGE SYNC - Save Bot responses to device
// ============================================

/**
 * POST /api/bot/sync-message
 * Bot calls this to save its response to the device's message queue
 * This enables the Chat page to show Bot responses
 */
app.post('/api/bot/sync-message', async (req, res) => {
    const { deviceId, entityId, botSecret, message, fromLabel, mediaType, mediaUrl } = req.body;

    if (!deviceId || entityId === undefined || !botSecret || (!message && !mediaUrl)) {
        return res.status(400).json({
            success: false,
            error: "Missing required fields: deviceId, entityId, botSecret, message (or mediaUrl)"
        });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, error: "Device not found" });
    }

    const entity = device.entities[entityId];
    if (!entity || !entity.isBound) {
        return res.status(404).json({ success: false, error: "Entity not bound" });
    }

    // Verify botSecret
    if (!safeEqual(entity.botSecret, botSecret)) {
        return res.status(403).json({ success: false, error: "Invalid botSecret" });
    }

    // Create message object for the device's message queue
    const msgText = message || (mediaType === 'photo' ? '[Photo]' : '[Voice message]');
    const messageObj = {
        text: msgText,
        from: fromLabel || "bot",
        fromEntityId: entityId,
        fromCharacter: entity.character,
        timestamp: Date.now(),
        read: false,
        isFromBot: true,
        mediaType: mediaType || null,
        mediaUrl: mediaUrl || null
    };

    // Add to entity's message queue
    if (!entity.messageQueue) {
        entity.messageQueue = [];
    }
    entity.messageQueue.push(messageObj);
    saveChatMessage(deviceId, entityId, msgText, fromLabel || "bot", false, true, mediaType || null, mediaUrl || null);
    markMessagesAsRead(deviceId, entityId);

    // Also update entity.message for immediate display
    entity.message = msgText;
    entity.lastUpdated = Date.now();

    console.log(`[Bot Sync] Saved message to device ${deviceId} Entity ${entityId}: "${message.substring(0, 50)}..."`);

    res.json({
        success: true,
        message: "Message synced to device",
        messageId: messageObj.timestamp
    });
});

/**
 * GET /api/bot/pending-messages
 * Device polls this to get messages from the Bot
 */
// ============================================
// DEVICE GPS LOCATION
// ============================================

/**
 * POST /api/device/location/request
 * Bot/API requests the device's current GPS location.
 * Server notifies the App via Socket.IO; App then calls POST /api/device/location.
 * Auth: deviceId + deviceSecret OR deviceId + botSecret
 */
app.post('/api/device/location/request', (req, res) => {
    const { deviceId, deviceSecret, botSecret } = req.body;
    if (!deviceId) return res.status(400).json({ success: false, error: 'deviceId required' });

    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    // Auth: deviceSecret or botSecret
    const secretOk = deviceSecret && device.deviceSecret && safeEqual(device.deviceSecret, deviceSecret);
    const botOk = botSecret && Object.values(device.entities || {}).some(e => e.botSecret && safeEqual(e.botSecret, botSecret));
    if (!secretOk && !botOk) return res.status(403).json({ success: false, error: 'Invalid credentials' });

    // Create a pending request
    const requestId = `loc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (!device._locationRequests) device._locationRequests = {};
    device._locationRequests[requestId] = { requestedAt: Date.now(), status: 'pending' };

    // Notify App via Socket.IO
    io.to(`device:${deviceId}`).emit('location_request', { requestId });

    // Also send FCM if available
    if (typeof sendFcm === 'function') {
        sendFcm(deviceId, {
            type: 'location_request',
            title: 'Location Request',
            body: 'An entity is requesting your device location.',
            metadata: JSON.stringify({ requestId })
        }).catch(() => {});
    }

    res.json({
        success: true,
        requestId,
        message: 'Location request sent to device. Poll GET /api/device/location to retrieve.',
        currentLocation: device._lastLocation || null
    });
});

/**
 * POST /api/device/location
 * App reports its current GPS location (called after receiving location_request).
 * Auth: deviceId + deviceSecret
 */
app.post('/api/device/location', (req, res) => {
    const { deviceId, deviceSecret, latitude, longitude, accuracy, altitude, speed, bearing, provider, requestId } = req.body;
    if (!deviceId || !deviceSecret) return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    if (latitude === undefined || longitude === undefined) return res.status(400).json({ success: false, error: 'latitude and longitude required' });

    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });
    if (!safeEqual(device.deviceSecret, deviceSecret)) return res.status(403).json({ success: false, error: 'Invalid credentials' });

    // Validate coordinates
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return res.status(400).json({ success: false, error: 'Invalid coordinates' });
    }

    // Store location
    device._lastLocation = {
        latitude: lat,
        longitude: lng,
        accuracy: accuracy != null ? parseFloat(accuracy) : null,
        altitude: altitude != null ? parseFloat(altitude) : null,
        speed: speed != null ? parseFloat(speed) : null,
        bearing: bearing != null ? parseFloat(bearing) : null,
        provider: provider || null,
        updatedAt: Date.now()
    };

    // Mark request as fulfilled
    if (requestId && device._locationRequests && device._locationRequests[requestId]) {
        device._locationRequests[requestId].status = 'fulfilled';
        device._locationRequests[requestId].fulfilledAt = Date.now();
    }

    // Notify listeners via Socket.IO
    io.to(`device:${deviceId}`).emit('location_update', device._lastLocation);

    res.json({ success: true, location: device._lastLocation });
});

/**
 * GET /api/device/location
 * Retrieve the device's last known GPS location.
 * Auth: deviceId + deviceSecret OR deviceId + botSecret
 */
app.get('/api/device/location', (req, res) => {
    const { deviceId, deviceSecret, botSecret } = req.query;
    if (!deviceId) return res.status(400).json({ success: false, error: 'deviceId required' });

    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    // Auth: deviceSecret or botSecret
    const secretOk = deviceSecret && device.deviceSecret && safeEqual(device.deviceSecret, deviceSecret);
    const botOk = botSecret && Object.values(device.entities || {}).some(e => e.botSecret && safeEqual(e.botSecret, botSecret));
    if (!secretOk && !botOk) return res.status(403).json({ success: false, error: 'Invalid credentials' });

    if (!device._lastLocation) {
        return res.json({ success: true, location: null, message: 'No location data. Call POST /api/device/location/request to request from device.' });
    }

    res.json({ success: true, location: device._lastLocation });
});

// GPS RECOMMENDATIONS
require('./gps-recommendations')(app, { safeEqual, devices });

app.get('/api/bot/pending-messages', (req, res) => {
    const { deviceId, entityId } = req.query;

    if (!deviceId || entityId === undefined) {
        return res.status(400).json({ success: false, error: "deviceId and entityId required" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, error: "Device not found" });
    }

    const entity = device.entities[parseInt(entityId)];
    if (!entity || !entity.messageQueue) {
        return res.json({ messages: [], unreadCount: 0 });
    }

    // Get unread messages
    const unreadMessages = entity.messageQueue.filter(m => !m.read);

    // Mark all as read
    entity.messageQueue.forEach(m => m.read = true);

    res.json({
        messages: unreadMessages,
        unreadCount: unreadMessages.length,
        totalCount: entity.messageQueue.length
    });
});

// Export app for testing (Jest + Supertest)
module.exports = app;
module.exports.httpServer = httpServer;
module.exports.io = io;
module.exports.devices = devices;
module.exports.safeEqual = safeEqual;
