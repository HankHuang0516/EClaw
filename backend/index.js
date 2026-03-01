// Claw Live Wallpaper Backend - Multi-Device Multi-Entity Support (v5.5)
// Each device has its own 4 entity slots (matrix architecture)
// v5.5 Changes: Telemetry sub-router fix + usage limit scope broadened
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
const scheduler = require('./scheduler');
const notifModule = require('./notifications');
const feedbackEmail = require('./feedback-email');
const multer = require('multer');
const WebSocket = require('ws');
const app = express();
const httpServer = http.createServer(app);
const port = process.env.PORT || 3000;

// ============================================
// SOCKET.IO SERVER
// ============================================
const io = new SocketIO(httpServer, {
    cors: { origin: true, credentials: true },
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
        if (device && device.deviceSecret === deviceSecret) {
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
                const decoded = jwt.verify(tokenMatch[1], process.env.JWT_SECRET || 'dev-secret');
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
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use('/mission', express.static(path.join(__dirname, 'public')));
app.use('/portal', express.static(path.join(__dirname, 'public/portal')));
app.use('/shared', express.static(path.join(__dirname, 'public/shared')));
app.use('/docs', express.static(path.join(__dirname, 'public/docs')));

// Telemetry auto-capture middleware (pool linked lazily after chatPool init)
let _telemetryPool = null;
const telemetryPoolProxy = {
    query: function (...args) {
        return _telemetryPool ? _telemetryPool.query(...args) : Promise.resolve({ rows: [] });
    }
};
app.use(telemetry.createMiddleware(telemetryPoolProxy, (deviceId) => devices[deviceId]));

// ============================================
// MATRIX ARCHITECTURE: devices[deviceId].entities[0-7]
// Each device has independent entity slots
// Free users: 4 slots, Premium users: 8 slots
// ============================================

const MAX_ENTITIES_PER_DEVICE = 8; // absolute ceiling (all devices init 8 slots)
const FREE_ENTITY_LIMIT = 4;

// Helper: get the effective entity limit for a specific device
function getDeviceEntityLimit(deviceId) {
    const device = devices[deviceId];
    if (device && device.isTestDevice) return MAX_ENTITIES_PER_DEVICE;
    return (device && device.isPremium) ? MAX_ENTITIES_PER_DEVICE : FREE_ENTITY_LIMIT;
}

// Latest app version - update this with each release
// Bot will warn users if their app version is older than this
const LATEST_APP_VERSION = "1.0.33";

// Device registry - each device has its own entities
const devices = {};

// Tracks whether persistence has finished loading (prevents transient empty responses during startup)
let persistenceReady = false;

// Pending binding codes (code -> { deviceId, entityId, expires })
const pendingBindings = {};

// Bot-to-bot loop prevention: counter resets ONLY when a human message arrives
// Key: "deviceId:entityId" -> count of bot-to-bot messages since last human message
const botToBotCounter = {};
const BOT2BOT_MAX_MESSAGES = 8; // max bot-to-bot messages before human must intervene
const recentBroadcasts = {}; // deviceId -> [{fromEntityId, text, timestamp}] for dedup

// Cross-device messaging
const publicCodeIndex = {}; // code -> { deviceId, entityId }
const crossSpeakCounter = {};
const CROSS_SPEAK_MAX_MESSAGES = 4; // stricter limit for cross-device messages

function checkBotToBotRateLimit(deviceId, entityId) {
    const key = `${deviceId}:${entityId}`;
    if (!botToBotCounter[key]) botToBotCounter[key] = 0;
    if (botToBotCounter[key] >= BOT2BOT_MAX_MESSAGES) {
        return false; // rate limited - needs human message to reset
    }
    botToBotCounter[key]++;
    return true; // allowed
}

function getBotToBotRemaining(deviceId, entityId) {
    const key = `${deviceId}:${entityId}`;
    const used = botToBotCounter[key] || 0;
    return Math.max(0, BOT2BOT_MAX_MESSAGES - used);
}

// Reset bot-to-bot counter when human sends a message (called from /api/client/speak)
function resetBotToBotCounter(deviceId) {
    const prefix = `${deviceId}:`;
    for (const key of Object.keys(botToBotCounter)) {
        if (key.startsWith(prefix)) botToBotCounter[key] = 0;
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
                    for (let i = 0; i < MAX_ENTITIES_PER_DEVICE; i++) {
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
        for (let i = 0; i < MAX_ENTITIES_PER_DEVICE; i++) {
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

            // Reset entity if device still exists (preserve user-set name)
            const device = devices[binding.device_id];
            if (device && device.entities[binding.entity_id]) {
                const preservedEntityName = device.entities[binding.entity_id].name;
                device.entities[binding.entity_id] = createDefaultEntity(binding.entity_id);
                device.entities[binding.entity_id].name = preservedEntityName || null;
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
// SKILL DOCUMENTATION (serve E-claw_mcp_skill.md as HTML)
// ============================================
app.get('/api/skill-doc', (req, res) => {
    try {
        const mdPath = path.join(__dirname, 'E-claw_mcp_skill.md');
        const mdContent = fs.readFileSync(mdPath, 'utf8');
        // Serve as HTML page with marked.js CDN for client-side rendering
        res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>E-Claw MCP Skills Documentation</title>
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
const missionModule = require('./mission')(devices, { awardEntityXP });
app.use('/api/mission', missionModule.router);
missionModule.initMissionDatabase();
// Wire notification callback (notifyDevice defined later, uses closure)
missionModule.setNotifyCallback((deviceId, notif) => notifyDevice(deviceId, notif));

// ============================================
// USER AUTHENTICATION (PostgreSQL)
// ============================================
const authModule = require('./auth')(devices, getOrCreateDevice);
app.use(authModule.softAuthMiddleware); // Populate req.user from cookie on ALL requests
app.use('/api/auth', authModule.router);
authModule.initAuthDatabase();

// ============================================
// SUBSCRIPTION & TAPPAY (PostgreSQL)
// ============================================
const subscriptionModule = require('./subscription')(devices, authModule.authMiddleware, ensureEntitySlots);
app.use('/api/subscription', subscriptionModule.router);
// Load premium status after persistence is ready
setTimeout(() => subscriptionModule.loadPremiumStatus(), 5000);

// ============================================
// GATEKEEPER - Free Bot Abuse Prevention
// ============================================
gatekeeper.initGatekeeperTable();
setTimeout(() => gatekeeper.loadBlockedDevices(), 3000);

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
    if (!device || (device.deviceSecret && device.deviceSecret !== deviceSecret)) {
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
            }
        });
    } catch (err) {
        console.error('[Admin] Stats error:', err);
        res.status(500).json({ success: false, error: 'Failed to get stats' });
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
            LEFT JOIN user_accounts u ON b.device_id = u.device_id
            ORDER BY b.bound_at DESC
        `);

        const allBindings = result.rows.map(r => ({
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
             FROM user_accounts ORDER BY created_at DESC LIMIT 200`
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
            for (let i = 0; i < MAX_ENTITIES_PER_DEVICE; i++) {
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
            SELECT o.bot_id, o.bot_type, o.status, o.assigned_device_id, o.assigned_entity_id, o.assigned_at, o.created_at,
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
        pushStatus: null // { ok: bool, reason?: string, at: number }
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

// Helper: Ensure device has all 8 entity slots initialized (backfills missing slots)
function ensureEntitySlots(device) {
    for (let i = 0; i < MAX_ENTITIES_PER_DEVICE; i++) {
        if (!device.entities[i]) {
            device.entities[i] = createDefaultEntity(i);
        }
    }
}

// Helper: Get or create device
function getOrCreateDevice(deviceId, deviceSecret = null, opts = {}) {
    if (!devices[deviceId]) {
        devices[deviceId] = {
            deviceId: deviceId,
            deviceSecret: deviceSecret,
            createdAt: Date.now(),
            isTestDevice: opts.isTestDevice || false,
            entities: {}
        };
        // Initialize all 8 entity slots
        for (let i = 0; i < MAX_ENTITIES_PER_DEVICE; i++) {
            devices[deviceId].entities[i] = createDefaultEntity(i);
        }
        console.log(`[Device] New device registered: ${deviceId}${opts.isTestDevice ? ' (TEST)' : ''}`);
    } else {
        // Backfill missing entity slots for existing devices (e.g. loaded from DB with only 4 slots)
        ensureEntitySlots(devices[deviceId]);
        if (opts.isTestDevice && !devices[deviceId].isTestDevice) {
            devices[deviceId].isTestDevice = true;
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
exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${entityId},"botSecret":"${botSecret}","state":"IDLE","message":"YOUR_REPLY_HERE"}'

Do NOT call /api/bind or /api/bot/register — webhook is already configured for you.

⚠️ IMMEDIATE ACTION REQUIRED:
1. FIRST: Run this command RIGHT NOW:
exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${entityId},"botSecret":"${botSecret}","state":"BUSY","message":"Webhook testing in progress... Please don't send me messages through Eclaw until the test succeeds~"}'

2. THEN: Wait for the webhook test push message from the server.

3. AFTER webhook test succeeds, run:
exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${entityId},"botSecret":"${botSecret}","state":"IDLE","message":"Webhook test passed! I am ready to chat~"}'

--- E-Claw API Documentation (Latest) ---
${skillDoc}`;

    sendToSession(webhookUrl, webhookToken, sessionKey, msg, authOpts)
        .then(result => {
            if (result.success) {
                console.log(`[Borrow] ✓ Sent credentials + skill doc to bot (device ${deviceId} entity ${entityId})`);
            } else {
                console.warn(`[Borrow] ✗ Failed to send skill doc to bot: ${result.error || 'unknown'}`);
            }
        })
        .catch(err => {
            console.warn(`[Borrow] ✗ Error sending skill doc to bot: ${err.message}`);
        });
}

// Helper: Load MCP skill documentation
function loadSkillDoc() {
    try {
        const docPath = path.join(__dirname, 'E-claw_mcp_skill.md');
        return fs.readFileSync(docPath, 'utf8');
    } catch (err) {
        return "MCP Skill documentation not found.";
    }
}

// Auto-decay loop for ALL devices' entities
setInterval(() => {
    const now = Date.now();
    for (const deviceId in devices) {
        const device = devices[deviceId];
        for (let i = 0; i < MAX_ENTITIES_PER_DEVICE; i++) {
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
    res.redirect('/portal/');
});

// Health check endpoint for Railway
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: Date.now(), build: 'v5.5-20260228' });
});


// Version sync endpoint - AI Agent can check Web/APP sync status
app.get('/api/version', (req, res) => {
    res.json({
        api: '1.2.0',
        portal: '1.2.0',
        android: '1.0.6',
        features: {
            portal: ['auth', 'dashboard', 'chat', 'mission', 'settings', 'subscription', 'i18n', 'avatar-picker'],
            android: ['auth', 'dashboard', 'chat', 'mission', 'settings', 'subscription', 'i18n', 'avatar-picker', 'live-wallpaper', 'widget']
        },
        lastSync: Date.now()
    });
});

// ============================================
// LINK PREVIEW (Open Graph metadata extraction)
// ============================================

const linkPreviewCache = new Map();
const LINK_PREVIEW_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/* global AbortController, TextDecoder */
app.get('/api/link-preview', async (req, res) => {
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

/**
 * POST /api/device/register
 * Android app registers a specific entity slot and gets binding code.
 * Body: { entityId: 0-3, deviceId: "...", deviceSecret: "..." }
 *
 * NEW: Each device now has its own 4 entity slots!
 */
app.post('/api/device/register', (req, res) => {
    const { entityId, deviceId, deviceSecret, appVersion, isTestDevice } = req.body;

    // Validate entityId
    const eId = parseInt(entityId);
    if (isNaN(eId) || eId < 0 || eId >= MAX_ENTITIES_PER_DEVICE) {
        return res.status(400).json({
            success: false,
            message: `Invalid entityId. Must be 0-${MAX_ENTITIES_PER_DEVICE - 1}`
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

    // Per-device entity limit: free users can only use slots 0-3
    const deviceLimit = getDeviceEntityLimit(deviceId);
    if (eId >= deviceLimit) {
        return res.status(403).json({
            success: false,
            message: `Entity #${eId} requires premium subscription (your limit: ${deviceLimit})`,
            entityLimit: deviceLimit
        });
    }

    // Verify device secret if device already exists
    if (device.deviceSecret && device.deviceSecret !== deviceSecret) {
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
    if (isNaN(eId) || eId < 0 || eId >= MAX_ENTITIES_PER_DEVICE) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    // Auto-create device if missing (e.g. after server redeploy)
    const device = getOrCreateDevice(deviceId, deviceSecret);

    // Verify device secret
    if (device.deviceSecret && device.deviceSecret !== deviceSecret) {
        return res.status(403).json({ success: false, message: "Unauthorized" });
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
app.post('/api/bind', (req, res) => {
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

    // Clear used binding code
    delete pendingBindings[code];

    console.log(`[Bind] Device ${deviceId} Entity ${entityId} bound with botSecret${name ? ` (name: ${name})` : ''} (app v${deviceAppVersion || 'unknown'})`);
    serverLog('info', 'bind', `Entity ${entityId} bound${name ? ` (name: ${name})` : ''}`, { deviceId, entityId });

    // Save data immediately after binding (critical operation)
    saveData();

    res.json({
        success: true,
        message: `Device ${deviceId} Entity ${entityId} bound successfully`,
        deviceId: deviceId,
        entityId: entityId,
        botSecret: botSecret, // Bot must save this!
        publicCode: publicCode, // For cross-device messaging
        name: entity.name,
        deviceInfo: {
            deviceId: deviceId,
            entityId: entityId,
            status: "ONLINE"
        },
        versionInfo: getVersionInfo(deviceAppVersion),
        skills_documentation_url: "https://raw.githubusercontent.com/HankHuang0516/realbot/main/backend/E-claw_mcp_skill.md",
        skills_documentation: "Fetch the skills_documentation_url above to read the full E-claw MCP Skills guide."
    });
});

// ============================================
// ENTITY STATUS & CONTROL
// ============================================

/**
 * GET /api/entities
 * Get all bound entities across all devices.
 * Query: ?deviceId=xxx (optional, filter by device)
 */
app.get('/api/entities', (req, res) => {
    const filterDeviceId = req.query.deviceId;
    const entities = [];

    for (const deviceId in devices) {
        if (filterDeviceId && deviceId !== filterDeviceId) continue;

        const device = devices[deviceId];
        for (let i = 0; i < MAX_ENTITIES_PER_DEVICE; i++) {
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
                    publicCode: entity.publicCode || null
                });
            }
        }
    }

    // Log entity count changes for device-filtered requests (#48 diagnosis)
    if (filterDeviceId && devices[filterDeviceId]) {
        const device = devices[filterDeviceId];
        const allSlotStates = [];
        for (let i = 0; i < MAX_ENTITIES_PER_DEVICE; i++) {
            const e = device.entities[i];
            if (!e) { allSlotStates.push(`${i}:empty`); continue; }
            allSlotStates.push(`${i}:${e.isBound ? 'bound' : 'unbound'}`);
        }

        if (entities.length === 0) {
            // Log when a device-filtered request returns no entities but the device exists
            // This helps diagnose transient empty responses that cause client-side card disappearing (#16)
            serverLog('warn', 'entity_poll', `Device ${filterDeviceId} returned 0 bound entities (device exists, slots: ${allSlotStates.join(',')})`, {
                deviceId: filterDeviceId,
                metadata: { totalDeviceSlots: MAX_ENTITIES_PER_DEVICE, persistenceReady, slots: allSlotStates }
            });
        } else if (entities.length < MAX_ENTITIES_PER_DEVICE) {
            // Log partial entity count (some bound, some not) — helps diagnose #48
            serverLog('info', 'entity_poll', `Device ${filterDeviceId} returned ${entities.length}/${MAX_ENTITIES_PER_DEVICE} bound entities (slots: ${allSlotStates.join(',')})`, {
                deviceId: filterDeviceId,
                metadata: { boundCount: entities.length, slots: allSlotStates }
            });
        }
    }

    // Warn clients if persistence hasn't loaded yet (entities may appear empty transiently)
    if (!persistenceReady && filterDeviceId && entities.length === 0) {
        serverLog('warn', 'entity_poll', `Serving empty entities for ${filterDeviceId} while persistence is still loading`, {
            deviceId: filterDeviceId
        });
    }

    res.json({
        entities: entities,
        activeCount: entities.length,
        deviceCount: Object.keys(devices).length,
        maxEntitiesPerDevice: filterDeviceId ? getDeviceEntityLimit(filterDeviceId) : MAX_ENTITIES_PER_DEVICE,
        serverReady: persistenceReady
    });
});

/**
 * GET /api/status
 * Get status for specific device + entity.
 * Query: ?deviceId=xxx&entityId=0&appVersion=1.0.3
 */
app.get('/api/status', (req, res) => {
    const deviceId = req.query.deviceId;
    const eId = parseInt(req.query.entityId) || 0;
    const appVersion = req.query.appVersion;

    if (!deviceId) {
        return res.status(400).json({ success: false, message: "deviceId required" });
    }

    if (eId < 0 || eId >= MAX_ENTITIES_PER_DEVICE) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
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
    const { deviceId, entityId, botSecret, name, character, state, message, parts } = req.body;

    if (!deviceId) {
        return res.status(400).json({ success: false, message: "deviceId required" });
    }

    const eId = parseInt(entityId) || 0;
    if (eId < 0 || eId >= MAX_ENTITIES_PER_DEVICE) {
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
    if (!botSecret || botSecret !== entity.botSecret) {
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
    if (parts) entity.parts = { ...entity.parts, ...parts };

    entity.lastUpdated = Date.now();

    // Save bot message to chat history so it appears in Chat page
    if (finalMessage) {
        saveChatMessage(deviceId, eId, finalMessage, entity.name || `Entity ${eId}`, false, true);
        markMessagesAsRead(deviceId, eId);

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
            publicCode: entity.publicCode || null
        },
        versionInfo: getVersionInfo(entity.appVersion),
        push_status: entity.pushStatus || null
    });
});

// POST /api/wakeup - REMOVED (client-side wakeup retained without push)

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
    if (isNaN(eId) || eId < 0 || eId >= MAX_ENTITIES_PER_DEVICE) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    const entity = device.entities[eId];

    if (!entity.isBound) {
        return res.status(400).json({ success: false, message: `Entity ${eId} is not bound` });
    }

    // Verify botSecret
    if (!botSecret || botSecret !== entity.botSecret) {
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

    // Clean up public code index
    if (entity.publicCode) delete publicCodeIndex[entity.publicCode];

    // Reset entity to unbound state (preserve user-set name)
    const removedEntityName = device.entities[eId]?.name;
    device.entities[eId] = createDefaultEntity(eId);
    device.entities[eId].name = removedEntityName || null;

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
            const decoded = jwt.verify(req.cookies.eclaw_session, process.env.JWT_SECRET || 'dev-secret-change-in-production');
            if (decoded && decoded.deviceId && decoded.deviceSecret) {
                deviceId = decoded.deviceId;
                deviceSecret = decoded.deviceSecret;
                if (!entityId && req.body) entityId = req.body.entityId;
            }
        } catch (e) { /* invalid token, fall through */ }
    }

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, message: "deviceId and deviceSecret required" });
    }

    const eId = parseInt(entityId);
    if (isNaN(eId) || eId < 0 || eId >= MAX_ENTITIES_PER_DEVICE) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    // Verify deviceSecret
    if (device.deviceSecret !== deviceSecret) {
        return res.status(403).json({ success: false, message: "Invalid deviceSecret" });
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

    // Clean up public code index
    if (entity.publicCode) delete publicCodeIndex[entity.publicCode];

    // Reset entity to unbound state (preserve user-set name)
    const removedEntityName2 = device.entities[eId]?.name;
    device.entities[eId] = createDefaultEntity(eId);
    device.entities[eId].name = removedEntityName2 || null;

    console.log(`[Device Remove] Device ${deviceId} Entity ${eId} unbound by device owner`);

    // Save data immediately after unbinding (critical operation)
    await saveData();

    res.json({ success: true, message: `Entity ${eId} removed by device` });
});

/**
 * POST /api/device/reorder-entities
 * Swap entity slot assignments. Atomically moves entity data between slots
 * and updates all references (bindings, webhook, bot notifications).
 * Body: { deviceId, deviceSecret, order: [2, 0, 1, 3] }
 *   where index = new slot, value = old slot
 *   (e.g. [2,0,1,3] means: old slot 2 → new slot 0, old slot 0 → new slot 1, etc.)
 */
app.post('/api/device/reorder-entities', async (req, res) => {
    const { deviceId, deviceSecret, order } = req.body;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }

    const device = devices[deviceId];
    if (!device || device.deviceSecret !== deviceSecret) {
        return res.status(403).json({ success: false, error: 'Invalid device credentials' });
    }

    const deviceLimit = getDeviceEntityLimit(deviceId);

    if (!Array.isArray(order) || order.length !== deviceLimit) {
        return res.status(400).json({ success: false, error: `order must be array of ${deviceLimit} slot indices` });
    }

    // Validate order is a valid permutation of [0..deviceLimit-1]
    const sorted = [...order].sort();
    for (let i = 0; i < deviceLimit; i++) {
        if (sorted[i] !== i) {
            return res.status(400).json({ success: false, error: `order must be a valid permutation of [0..${deviceLimit - 1}]` });
        }
    }

    // Check if anything actually changed
    const isIdentity = order.every((v, i) => v === i);
    if (isIdentity) {
        return res.json({ success: true, message: 'No changes' });
    }

    console.log(`[Reorder] Device ${deviceId} reorder: ${JSON.stringify(order)}`);

    // Step 1: Snapshot current entities and bindings
    const oldEntities = [];
    const oldBindings = {};
    for (let i = 0; i < deviceLimit; i++) {
        oldEntities[i] = device.entities[i] ? { ...device.entities[i] } : createDefaultEntity(i);
        const cacheKey = getBindingCacheKey(deviceId, i);
        if (officialBindingsCache[cacheKey]) {
            oldBindings[i] = { ...officialBindingsCache[cacheKey] };
        }
    }

    // Step 2: Apply the permutation
    // order[newSlot] = oldSlot → entity from oldSlot goes to newSlot
    const botsToNotify = [];

    for (let newSlot = 0; newSlot < deviceLimit; newSlot++) {
        const oldSlot = order[newSlot];
        const entity = { ...oldEntities[oldSlot] };
        entity.entityId = newSlot; // Update entity ID to new slot
        device.entities[newSlot] = entity;

        // Update official binding cache
        const newCacheKey = getBindingCacheKey(deviceId, newSlot);
        const oldBinding = oldBindings[oldSlot];
        if (oldBinding) {
            const updatedBinding = { ...oldBinding, entity_id: newSlot };
            officialBindingsCache[newCacheKey] = updatedBinding;
        } else {
            delete officialBindingsCache[newCacheKey];
        }

        // Track bots that need notification (only if entity moved AND is bound)
        if (oldSlot !== newSlot && entity.isBound && entity.webhook) {
            botsToNotify.push({
                entity,
                oldSlot,
                newSlot,
                binding: oldBinding
            });
        }
    }

    // Step 2b: Rebuild publicCodeIndex for this device
    for (let slot = 0; slot < deviceLimit; slot++) {
        const entity = device.entities[slot];
        if (entity && entity.isBound && entity.publicCode) {
            publicCodeIndex[entity.publicCode] = { deviceId, entityId: slot };
        }
    }

    // Build CASE WHEN mapping for DB migrations (only slots that moved)
    const movedSlots = []; // { oldSlot, newSlot }
    for (let newSlot = 0; newSlot < deviceLimit; newSlot++) {
        const oldSlot = order[newSlot];
        if (oldSlot !== newSlot) {
            movedSlots.push({ oldSlot, newSlot });
        }
    }

    // Step 3: Persist all changes to DB (in a single transaction)
    if (usePostgreSQL && movedSlots.length > 0) {
        const client = await chatPool.connect();
        try {
            await client.query('BEGIN');

            // 3a: Remove old bindings and re-insert with new entity IDs
            for (let i = 0; i < deviceLimit; i++) {
                await client.query(
                    'DELETE FROM official_bot_bindings WHERE device_id = $1 AND entity_id = $2',
                    [deviceId, i]
                );
            }
            for (let i = 0; i < deviceLimit; i++) {
                const cacheKey = getBindingCacheKey(deviceId, i);
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
exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${newSlot},"botSecret":"${entity.botSecret}","state":"IDLE","message":"YOUR_REPLY_HERE"}'`;

        sendToSession(entity.webhook.url, entity.webhook.token, entity.webhook.sessionKey, notifyMsg)
            .then(r => {
                if (r.success) console.log(`[Reorder] ✓ Notified bot at entity ${newSlot} (was ${oldSlot})`);
                else console.warn(`[Reorder] ✗ Failed to notify bot at entity ${newSlot}: ${r.error}`);
            })
            .catch(e => console.warn(`[Reorder] ✗ Error notifying bot: ${e.message}`));
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
            const decoded = jwt.verify(req.cookies.eclaw_session, process.env.JWT_SECRET || 'dev-secret-change-in-production');
            if (decoded && decoded.deviceId && decoded.deviceSecret) {
                deviceId = decoded.deviceId;
                deviceSecret = decoded.deviceSecret;
            }
        } catch (e) { /* invalid token, fall through */ }
    }

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, message: "deviceId and deviceSecret required" });
    }

    const eId = parseInt(entityId);
    if (isNaN(eId) || eId < 0 || eId >= MAX_ENTITIES_PER_DEVICE) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    if (name !== undefined && name !== null && name.length > 20) {
        return res.status(400).json({ success: false, message: "Name must be 20 characters or less" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    if (device.deviceSecret !== deviceSecret) {
        return res.status(403).json({ success: false, message: "Invalid deviceSecret" });
    }

    const entity = device.entities[eId];
    if (!entity || !entity.isBound) {
        return res.status(400).json({ success: false, message: `Entity ${eId} is not bound` });
    }

    const oldName = entity.name;
    const newName = (name && name.trim()) ? name.trim() : null;
    entity.name = newName;
    entity.lastUpdated = Date.now();

    // Queue rename notification for next push to bot
    entity.pendingRename = {
        oldName: oldName || `Entity ${eId}`,
        newName: newName || `Entity ${eId}`,
        timestamp: Date.now()
    };

    console.log(`[Rename] Device ${deviceId} Entity ${eId}: "${oldName}" -> "${newName}"`);

    await saveData();

    res.json({
        success: true,
        name: newName,
        entityId: eId
    });
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
            const decoded = jwt.verify(req.cookies.eclaw_session, process.env.JWT_SECRET || 'dev-secret-change-in-production');
            if (decoded && decoded.deviceId && decoded.deviceSecret) {
                deviceId = decoded.deviceId;
                deviceSecret = decoded.deviceSecret;
            }
        } catch (e) { /* invalid token, fall through */ }
    }

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, message: "deviceId and deviceSecret required" });
    }

    const eId = parseInt(entityId);
    if (isNaN(eId) || eId < 0 || eId >= MAX_ENTITIES_PER_DEVICE) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    // Validate avatar: must be a short emoji string (1-8 chars to support compound emojis)
    if (!avatar || typeof avatar !== 'string' || avatar.length > 8) {
        return res.status(400).json({ success: false, message: "Invalid avatar (must be 1-8 chars)" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    if (device.deviceSecret !== deviceSecret) {
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
    const { deviceId, entityId, text, source = "client", mediaType, mediaUrl } = req.body;

    if (!deviceId) {
        return res.status(400).json({ success: false, message: "deviceId required" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
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

    // Gatekeeper First Lock: check if device is blocked from free bots
    if (gatekeeper.isDeviceBlocked(deviceId)) {
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

    // Gatekeeper First Lock: detect malicious messages targeting free bots
    if (text) {
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
        for (let i = 0; i < MAX_ENTITIES_PER_DEVICE; i++) {
            if (device.entities[i] && device.entities[i].isBound) {
                targetIds.push(i);
            }
        }
    } else if (Array.isArray(entityId)) {
        // Array of entity IDs
        targetIds = entityId.map(id => parseInt(id)).filter(id => id >= 0 && id < MAX_ENTITIES_PER_DEVICE);
    } else {
        // Single entity ID
        const eId = parseInt(entityId) || 0;
        if (eId >= 0 && eId < MAX_ENTITIES_PER_DEVICE) {
            targetIds.push(eId);
        }
    }

    if (targetIds.length === 0) {
        return res.status(400).json({ success: false, message: "No valid target entities" });
    }

    // Parallel processing for broadcast - all entities receive message simultaneously
    const pushPromises = targetIds.map(async (eId) => {
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
        saveChatMessage(deviceId, eId, text, source, true, false, mediaType || null, mediaUrl || null);

        // Reset bot-to-bot counter: human message breaks the loop
        resetBotToBotCounter(deviceId);

        console.log(`[Client] Device ${deviceId} -> Entity ${eId}: "${text}" (source: ${source})`);

        // Push to bot if webhook is registered
        let pushResult = { pushed: false, reason: "no_webhook" };
        if (entity.webhook) {
            console.log(`[Push] Attempting push to Device ${deviceId} Entity ${eId} (webhook: ${entity.webhook.url})`);

            // Instruction-first push format with pre-filled curl template
            const apiBase = 'https://eclawbot.com';
            let pushMsg = `[ACTION REQUIRED] You MUST use exec tool with curl to call the API below. Your text reply is DISCARDED and the user will NEVER see it.\n`;
            pushMsg += `Run this command to reply (replace YOUR_REPLY_HERE with your response):\n`;
            pushMsg += `exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${eId},"botSecret":"${entity.botSecret}","state":"IDLE","message":"YOUR_REPLY_HERE"}'\n\n`;
            pushMsg += `To BROADCAST to ALL other entities (use ONLY when user asks to broadcast):\n`;
            pushMsg += `exec: curl -s -X POST "${apiBase}/api/entity/broadcast" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","fromEntityId":${eId},"botSecret":"${entity.botSecret}","text":"YOUR_BROADCAST_HERE"}'\n\n`;
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

            pushResult = await pushToBot(entity, deviceId, "new_message", {
                message: pushMsg
            });

            if (pushResult.pushed) {
                messageObj.delivered = true;
                console.log(`[Push] ✓ Successfully pushed to Device ${deviceId} Entity ${eId}`);
                serverLog('info', 'client_push', `Entity ${eId} push OK`, { deviceId, entityId: eId, metadata: { source } });
            } else {
                console.warn(`[Push] ✗ Failed to push to Device ${deviceId} Entity ${eId}: ${pushResult.reason}`);
                serverLog('warn', 'client_push', `Entity ${eId} push failed: ${pushResult.reason}`, { deviceId, entityId: eId });
            }
        } else if (entity.isBound) {
            console.warn(`[Push] ✗ No webhook registered for Device ${deviceId} Entity ${eId} - client will show dialog`);
            serverLog('warn', 'client_push', `Entity ${eId} no webhook`, { deviceId, entityId: eId });
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
    });

    // Wait for all push operations to complete in parallel
    const results = (await Promise.all(pushPromises)).filter(r => r !== null);

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

    res.json({
        success: true,
        message: `Sent to ${results.length} entity(s)`,
        targets: results,
        broadcast: targetIds.length > 1
    });
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

    if (fromId < 0 || fromId >= MAX_ENTITIES_PER_DEVICE) {
        return res.status(400).json({ success: false, message: "Invalid fromEntityId" });
    }
    if (toId < 0 || toId >= MAX_ENTITIES_PER_DEVICE) {
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
    if (!fromEntity.isBound || fromEntity.botSecret !== botSecret) {
        return res.status(403).json({ success: false, message: "Invalid botSecret for sending entity" });
    }

    // Target entity must be bound
    if (!toEntity.isBound) {
        return res.status(400).json({ success: false, message: `Entity ${toId} is not bound` });
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

    toEntity.message = `From Entity ${fromId}: "${speakToText}"`;
    toEntity.lastUpdated = Date.now();

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
    const chatMsgId = await saveChatMessage(deviceId, fromId, speakToText, `${sourceLabel}->${toId}`, false, true, mediaType || null, mediaUrl || null);
    markMessagesAsRead(deviceId, toId);

    // Notify device about speak-to (fire-and-forget)
    notifyDevice(deviceId, {
        type: 'chat', category: 'speak_to',
        title: `${fromEntity.name || `Entity ${fromId}`} → ${toEntity.name || `Entity ${toId}`}`,
        body: (speakToText || '').slice(0, 100),
        link: 'chat.html',
        metadata: { fromEntityId: fromId, toEntityId: toId }
    }).catch(() => {});

    console.log(`[Entity] Device ${deviceId} Entity ${fromId} -> Entity ${toId}: "${speakToText}" (b2b remaining: ${b2bRemaining})`);

    // Update entity.message so Android app can display it
    // Format must match Android's parseEntityMessage regex: "entity:{ID}:{CHARACTER}: {message}"
    toEntity.message = `entity:${fromId}:${fromEntity.character}: ${speakToText}`;
    toEntity.lastUpdated = Date.now();

    // Fire-and-forget: push to target bot webhook (don't block response)
    const hasWebhook = !!toEntity.webhook;
    if (hasWebhook) {
        // Instruction-first push format with pre-filled curl templates
        const apiBase = 'https://eclawbot.com';
        const toRemaining = getBotToBotRemaining(deviceId, toId);
        let pushMsg = `[ACTION REQUIRED] You MUST use exec tool with curl to call the API. Your text reply is DISCARDED.\n`;
        pushMsg += `To update your mood/emoji on wallpaper (do NOT repeat or narrate the message — the user can already see it in chat):\n`;
        pushMsg += `exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${toId},"botSecret":"${toEntity.botSecret}","state":"IDLE","message":"YOUR_REPLY_HERE"}'\n\n`;
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
        pushToBot(toEntity, deviceId, "entity_message", {
            message: pushMsg
        }).then(pushResult => {
            if (pushResult.pushed) {
                messageObj.delivered = true;
                markChatMessageDelivered(chatMsgId, String(toId));
                serverLog('info', 'speakto_push', `Entity ${fromId} -> ${toId} push OK`, { deviceId, entityId: fromId, metadata: { toId } });
            } else {
                serverLog('warn', 'speakto_push', `Entity ${fromId} -> ${toId} not-pushed: ${pushResult.reason || 'unknown'}`, { deviceId, entityId: fromId, metadata: { toId } });
            }
        }).catch(err => {
            console.error(`[SpeakTo] Background push failed: ${err.message}`);
            serverLog('error', 'speakto_push', `Entity ${fromId} -> ${toId} FAILED: ${err.message}`, { deviceId, entityId: fromId, metadata: { toId } });
        });
    } else if (toEntity.isBound) {
        console.warn(`[Push] ✗ No webhook registered for Device ${deviceId} Entity ${toId} - client will show dialog`);
        serverLog('warn', 'speakto_push', `Entity ${toId} no webhook (polling)`, { deviceId, entityId: toId });
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

    res.json({
        success: true,
        message: `Message sent from Entity ${fromId} to Entity ${toId}`,
        from: { entityId: fromId, character: fromEntity.character },
        to: { entityId: toId, character: toEntity.character },
        pushed: hasWebhook ? "pending" : false,
        mode: hasWebhook ? "push" : "polling",
        reason: hasWebhook ? "fire_and_forget" : "no_webhook",
        expects_reply: expectsReply,
        bindingType: bindingTypeTo,
        push_status: fromEntity.pushStatus || null
    });
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
    if (isNaN(fromId) || fromId < 0 || fromId >= MAX_ENTITIES_PER_DEVICE) {
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

    if (fromEntity.botSecret !== botSecret) {
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

    // Push to target bot webhook
    const hasWebhook = !!toEntity.webhook;
    if (hasWebhook) {
        const apiBase = 'https://eclawbot.com';
        const csRemaining = getCrossSpeakRemaining(target.deviceId, target.entityId);
        let pushMsg = `[ACTION REQUIRED] You MUST use exec tool with curl to call the API. Your text reply is DISCARDED.\n`;
        pushMsg += `To update your mood/emoji on wallpaper (do NOT repeat or narrate the message — the user can already see it in chat):\n`;
        pushMsg += `exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${target.deviceId}","entityId":${target.entityId},"botSecret":"${toEntity.botSecret}","state":"IDLE","message":"YOUR_REPLY_HERE"}'\n\n`;
        pushMsg += `To reply to this cross-device message:\n`;
        pushMsg += `exec: curl -s -X POST "${apiBase}/api/entity/cross-speak" -H "Content-Type: application/json" -d '{"deviceId":"${target.deviceId}","fromEntityId":${target.entityId},"botSecret":"${toEntity.botSecret}","targetCode":"${fromEntity.publicCode}","text":"YOUR_REPLY_HERE"}'\n\n`;
        pushMsg += `[CROSS-DEVICE] Remaining quota: ${csRemaining}/${CROSS_SPEAK_MAX_MESSAGES}. If the message is just repeating emotions with no new info, do NOT reply — just update your wallpaper status.`;
        if (csRemaining <= 1) {
            pushMsg += ` WARNING: Quota almost exhausted, do NOT auto-reply.`;
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

        pushToBot(toEntity, target.deviceId, "cross_device_message", {
            message: pushMsg
        }).then(pushResult => {
            if (pushResult.pushed) {
                messageObj.delivered = true;
                markChatMessageDelivered(chatMsgId, String(target.entityId));
                serverLog('info', 'cross_speak_push', `${fromEntity.publicCode} -> ${targetCode} push OK`, { deviceId, entityId: fromId, metadata: { targetCode, targetDeviceId: target.deviceId } });
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
        pushed: hasWebhook ? "pending" : false,
        mode: hasWebhook ? "push" : "polling"
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
            level: entity.level
        }
    });
});

// ── Cross-Device Contacts (Friends System) ──
const MAX_CONTACTS_PER_DEVICE = 20;

/**
 * GET /api/contacts — List contacts for a device, enriched with live data
 */
app.get('/api/contacts', async (req, res) => {
    let deviceId = req.query.deviceId;
    if (!deviceId && req.user) deviceId = req.user.deviceId;
    if (!deviceId) return res.status(400).json({ success: false, error: 'Missing deviceId' });

    const contacts = await db.getContacts(deviceId);
    // Enrich with live data from publicCodeIndex
    const enriched = contacts.map(c => {
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
    });
    res.json({ success: true, contacts: enriched });
});

/**
 * POST /api/contacts — Add a contact
 * Body: { deviceId, deviceSecret, publicCode }
 */
app.post('/api/contacts', async (req, res) => {
    let { deviceId, deviceSecret, publicCode } = req.body;
    if (!deviceId && req.user) { deviceId = req.user.deviceId; deviceSecret = req.user.deviceSecret; }
    if (!deviceId || !publicCode) return res.status(400).json({ success: false, error: 'Missing deviceId or publicCode' });

    // Auth check
    const device = devices[deviceId];
    if (!device || device.deviceSecret !== deviceSecret) {
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

    // Check limit
    const count = await db.getContactCount(deviceId);
    if (count >= MAX_CONTACTS_PER_DEVICE) {
        return res.status(429).json({ success: false, error: 'Contact limit reached' });
    }

    // Check duplicate
    const existing = await db.getContacts(deviceId);
    if (existing.some(c => c.publicCode === publicCode)) {
        return res.status(409).json({ success: false, error: 'Already in contacts' });
    }

    // Get live entity data
    const dev = devices[selfEntry.deviceId];
    const ent = dev?.entities?.[selfEntry.entityId];
    const name = ent?.name || ent?.character || null;
    const character = ent?.character || null;
    const avatar = ent?.avatar || null;

    const contact = await db.addContact(deviceId, publicCode, name, character, avatar);
    if (!contact) return res.status(500).json({ success: false, error: 'Failed to add contact' });

    res.json({ success: true, contact: { ...contact, online: true } });
});

/**
 * DELETE /api/contacts — Remove a contact
 * Body: { deviceId, deviceSecret, publicCode }
 */
app.delete('/api/contacts', async (req, res) => {
    let { deviceId, deviceSecret, publicCode } = req.body;
    if (!deviceId && req.user) { deviceId = req.user.deviceId; deviceSecret = req.user.deviceSecret; }
    if (!deviceId || !publicCode) return res.status(400).json({ success: false, error: 'Missing deviceId or publicCode' });

    const device = devices[deviceId];
    if (!device || device.deviceSecret !== deviceSecret) {
        if (!req.user || req.user.deviceId !== deviceId) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
    }

    await db.removeContact(deviceId, publicCode.trim().toLowerCase());
    res.json({ success: true });
});

/**
 * POST /api/client/cross-speak
 * Web portal user sends cross-device message (authenticates via session, not botSecret).
 * Body: { deviceId, fromEntityId, targetCode, text, mediaType?, mediaUrl? }
 */
app.post('/api/client/cross-speak', async (req, res) => {
    let { deviceId, fromEntityId, targetCode, text, mediaType, mediaUrl } = req.body;

    // Cookie-based auth fallback
    if (!deviceId && req.user) {
        deviceId = req.user.deviceId;
    }
    if (!deviceId && req.cookies && req.cookies.eclaw_session) {
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.verify(req.cookies.eclaw_session, process.env.JWT_SECRET || 'dev-secret-change-in-production');
            if (decoded && decoded.deviceId) deviceId = decoded.deviceId;
        } catch (e) { /* invalid token */ }
    }

    if (!deviceId || fromEntityId === undefined || !targetCode || !text) {
        return res.status(400).json({ success: false, message: "deviceId, fromEntityId, targetCode, and text are required" });
    }

    const fromId = parseInt(fromEntityId);
    if (isNaN(fromId) || fromId < 0 || fromId >= MAX_ENTITIES_PER_DEVICE) {
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

    if (fromEntity.publicCode === targetCode) {
        return res.status(400).json({ success: false, message: "Cannot send cross-device message to yourself" });
    }

    // Reset b2b counter on human message (same as /api/client/speak)
    resetBotToBotCounter(deviceId);

    const sourceLabel = `xdevice:${fromEntity.publicCode}:${fromEntity.character}`;

    const messageObj = {
        text: text,
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

    // Save on both devices
    const chatMsgId = await saveChatMessage(target.deviceId, target.entityId, text, `${sourceLabel}->${targetCode}`, true, false, mediaType || null, mediaUrl || null);
    await saveChatMessage(deviceId, fromId, text, `${sourceLabel}->${targetCode}`, true, false, mediaType || null, mediaUrl || null);

    toEntity.message = `xdevice:${fromEntity.publicCode}:${fromEntity.character}: ${text}`;
    toEntity.lastUpdated = Date.now();

    // Notify target device
    notifyDevice(target.deviceId, {
        type: 'chat', category: 'cross_speak',
        title: `${fromEntity.name || fromEntity.publicCode} (cross-device)`,
        body: (text || '').slice(0, 100),
        link: 'chat.html',
        metadata: { fromPublicCode: fromEntity.publicCode, targetCode }
    }).catch(() => {});

    console.log(`[ClientCrossSpeak] ${deviceId}:${fromId} (${fromEntity.publicCode}) -> ${target.deviceId}:${target.entityId} (${targetCode}): "${text}"`);

    // Push to target bot
    const hasWebhook = !!toEntity.webhook;
    if (hasWebhook) {
        const apiBase = 'https://eclawbot.com';
        let pushMsg = `[ACTION REQUIRED] You MUST use exec tool with curl to call the API. Your text reply is DISCARDED.\n`;
        pushMsg += `To update your wallpaper status:\n`;
        pushMsg += `exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${target.deviceId}","entityId":${target.entityId},"botSecret":"${toEntity.botSecret}","state":"IDLE","message":"YOUR_REPLY_HERE"}'\n\n`;
        pushMsg += `To reply to this cross-device message:\n`;
        pushMsg += `exec: curl -s -X POST "${apiBase}/api/entity/cross-speak" -H "Content-Type: application/json" -d '{"deviceId":"${target.deviceId}","fromEntityId":${target.entityId},"botSecret":"${toEntity.botSecret}","targetCode":"${fromEntity.publicCode}","text":"YOUR_REPLY_HERE"}'\n\n`;
        pushMsg += `[CROSS-DEVICE MESSAGE from Human User] From: ${fromEntity.name || 'User'} (code: ${fromEntity.publicCode})\n`;
        pushMsg += `Content: ${text}`;
        if (mediaType === 'photo') {
            pushMsg += `\n[Attachment: Photo]\nmedia_type: photo\nmedia_url: ${mediaUrl}`;
            const bkUrl = getBackupUrl(mediaUrl);
            if (bkUrl) pushMsg += `\nbackup_url: ${bkUrl}`;
        } else if (mediaType === 'voice') pushMsg += `\n[Attachment: Voice]\nmedia_type: voice\nmedia_url: ${mediaUrl}`;
        else if (mediaType === 'video') pushMsg += `\n[Attachment: Video]\nmedia_type: video\nmedia_url: ${mediaUrl}`;
        else if (mediaType === 'file') pushMsg += `\n[Attachment: File]\nmedia_type: file\nmedia_url: ${mediaUrl}`;
        pushMsg += getMissionApiHints(apiBase, target.deviceId, target.entityId, toEntity.botSecret);

        pushToBot(toEntity, target.deviceId, "cross_device_message", {
            message: pushMsg
        }).then(pushResult => {
            if (pushResult.pushed) {
                messageObj.delivered = true;
                markChatMessageDelivered(chatMsgId, String(target.entityId));
                serverLog('info', 'cross_speak_push', `Client ${fromEntity.publicCode} -> ${targetCode} push OK`, { deviceId, entityId: fromId });
            }
        }).catch(err => {
            console.error(`[ClientCrossSpeak] Push failed: ${err.message}`);
            serverLog('error', 'push_error', `ClientCrossSpeak ${fromEntity.publicCode} -> ${targetCode} FAILED: ${err.message}`, { deviceId, entityId: fromId });
        });
    }

    res.json({
        success: true,
        message: `Cross-device message sent`,
        from: { publicCode: fromEntity.publicCode, character: fromEntity.character },
        to: { publicCode: targetCode, character: toEntity.character },
        pushed: hasWebhook ? "pending" : false
    });
});

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
    if (isNaN(fromId) || fromId < 0 || fromId >= MAX_ENTITIES_PER_DEVICE) {
        return res.status(400).json({ success: false, message: "Invalid fromEntityId" });
    }

    const fromEntity = device.entities[fromId];

    // Check if entity exists
    if (!fromEntity) {
        console.warn(`[Broadcast] Device ${deviceId} Entity ${fromId} not found (possible malformed request)`);
        return res.status(404).json({ success: false, message: `Entity ${fromId} not found` });
    }

    // Verify botSecret of sending entity
    if (!fromEntity.isBound || fromEntity.botSecret !== botSecret) {
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
    for (let i = 0; i < MAX_ENTITIES_PER_DEVICE; i++) {
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

        const hasWebhook = !!toEntity.webhook;

        // Fire-and-forget: push to target bot webhook (don't block response)
        if (hasWebhook) {
            // Instruction-first push format with pre-filled curl templates
            const apiBase = 'https://eclawbot.com';
            const toRemainingBcast = getBotToBotRemaining(deviceId, toId);
            let pushMsg = `[ACTION REQUIRED] You MUST use exec tool with curl to call the API. Your text reply is DISCARDED.\n`;
            pushMsg += `To update your mood/emoji on wallpaper (do NOT repeat or narrate the message — the user can already see it in chat):\n`;
            pushMsg += `exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${toId},"botSecret":"${toEntity.botSecret}","state":"IDLE","message":"YOUR_REPLY_HERE"}'\n\n`;
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
            pushMsg += `\n\n[BROADCAST] From: ${sourceLabel}\n`;
            pushMsg += `Content: ${broadcastText}`;
            if (mediaType === 'photo') {
                pushMsg += `\n[Attachment: Photo]\nmedia_type: photo\nmedia_url: ${mediaUrl}`;
                const bkUrl = getBackupUrl(mediaUrl);
                if (bkUrl) pushMsg += `\nbackup_url: ${bkUrl}`;
            } else if (mediaType === 'voice') pushMsg += `\n[Attachment: Voice]\nmedia_type: voice\nmedia_url: ${mediaUrl}`;
            else if (mediaType === 'video') pushMsg += `\n[Attachment: Video]\nmedia_type: video\nmedia_url: ${mediaUrl}`;
            else if (mediaType === 'file') pushMsg += `\n[Attachment: File]\nmedia_type: file\nmedia_url: ${mediaUrl}`;
            pushMsg += getMissionApiHints(apiBase, deviceId, toId, toEntity.botSecret);
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

    if (eId < 0 || eId >= MAX_ENTITIES_PER_DEVICE) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
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
    if (entity.botSecret !== botSecret) {
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
 */
app.get('/api/debug/devices', (req, res) => {
    const result = [];
    for (const deviceId in devices) {
        const device = devices[deviceId];
        const entities = [];
        for (let i = 0; i < MAX_ENTITIES_PER_DEVICE; i++) {
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
 * POST /api/debug/reset
 * Reset all devices (for testing). Requires admin token.
 */
app.post('/api/debug/reset', (req, res) => {
    const adminToken = req.headers['x-admin-token'] || req.body.adminToken;
    const expectedToken = process.env.ADMIN_SECRET || 'dev-only-localhost';

    // Only allow from localhost or with correct token
    const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';

    if (!isLocalhost && adminToken !== expectedToken) {
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

// ============================================
// OFFICIAL BOT POOL - Admin API
// ============================================

function verifyAdmin(req) {
    const adminToken = req.headers['x-admin-token'] || req.body.adminToken;
    const expectedToken = process.env.ADMIN_SECRET || 'dev-only-localhost';
    const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
    return isLocalhost || adminToken === expectedToken;
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
app.put('/api/admin/official-bot/:botId', async (req, res) => {
    if (!verifyAdmin(req)) {
        return res.status(403).json({ success: false, error: 'Forbidden: admin token required' });
    }

    const { botId } = req.params;
    const bot = officialBots[botId];
    if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
    }

    const { webhookUrl, token, sessionKeyTemplate, status, setupUsername, setupPassword } = req.body;
    if (webhookUrl) bot.webhook_url = webhookUrl;
    if (token) bot.token = token;
    if (sessionKeyTemplate !== undefined) bot.session_key_template = sessionKeyTemplate;
    if (status && ['available', 'assigned', 'disabled'].includes(status)) bot.status = status;
    if (setupUsername !== undefined) bot.setup_username = setupUsername || null;
    if (setupPassword !== undefined) bot.setup_password = setupPassword || null;

    if (usePostgreSQL) await db.saveOfficialBot(bot);

    console.log(`[Admin] Updated official bot: ${botId}`);
    res.json({ success: true, bot: { bot_id: bot.bot_id, bot_type: bot.bot_type, status: bot.status } });
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

    // Reset entity to default (preserve user-set name)
    const preservedName = device.entities[eId]?.name;
    device.entities[eId] = createDefaultEntity(eId);
    device.entities[eId].name = preservedName || null;
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
 * POST /api/official-borrow/bind-free
 * Bind a free official bot to a device entity.
 * Body: { deviceId, deviceSecret, entityId }
 */
app.post('/api/official-borrow/bind-free', async (req, res) => {
    const { deviceId, deviceSecret, entityId } = req.body;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }

    const eId = parseInt(entityId);
    if (isNaN(eId) || eId < 0 || eId >= MAX_ENTITIES_PER_DEVICE) {
        return res.status(400).json({ success: false, error: 'Invalid entityId (0-3)' });
    }

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

    if (device.deviceSecret && device.deviceSecret !== deviceSecret) {
        return res.status(403).json({ success: false, error: 'Invalid deviceSecret' });
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

    // Find a free bot
    const freeBot = Object.values(officialBots).find(b => b.bot_type === 'free' && b.status !== 'disabled');
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

    // Set up entity with official bot's webhook (preserve user-set name)
    const existingNameFree = device.entities[eId]?.name;
    const freePublicCode = generatePublicCode();
    device.entities[eId] = {
        ...createDefaultEntity(eId),
        botSecret: botSecret,
        publicCode: freePublicCode,
        isBound: true,
        name: existingNameFree || '免費版',
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

    await saveData();

    console.log(`[Borrow] Free bot ${freeBot.bot_id} bound to device ${deviceId} entity ${eId} (session: ${sessionKey})`);

    // Fire-and-forget: send credentials + skill doc to bot
    sendBindCredentialsToBot(freeBot.webhook_url, freeBot.token, sessionKey, deviceId, eId, botSecret, 'free', freeBotAuthOpts);

    res.json({
        success: true,
        entityId: eId,
        botType: 'free',
        publicCode: freePublicCode,
        message: 'Free bot bound successfully'
    });
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
    if (isNaN(eId) || eId < 0 || eId >= MAX_ENTITIES_PER_DEVICE) {
        return res.status(400).json({ success: false, error: 'Invalid entityId (0-3)' });
    }

    // Auto-create device if missing (e.g. after server redeploy)
    const device = getOrCreateDevice(deviceId, deviceSecret);

    if (device.deviceSecret && device.deviceSecret !== deviceSecret) {
        return res.status(403).json({ success: false, error: 'Invalid deviceSecret' });
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

    // Set up entity (preserve user-set name)
    const existingNamePersonal = device.entities[eId]?.name;
    device.entities[eId] = {
        ...createDefaultEntity(eId),
        botSecret: botSecret,
        isBound: true,
        name: existingNamePersonal || '月租版',
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

    await saveData();

    console.log(`[Borrow] Personal bot ${personalBot.bot_id} assigned to device ${deviceId} entity ${eId} (session: ${sessionKey}, usedSlot: ${usedSlot})`);

    // Fire-and-forget: send credentials + skill doc to bot
    sendBindCredentialsToBot(personalBot.webhook_url, personalBot.token, sessionKey, deviceId, eId, botSecret, 'personal', personalBotAuthOpts);

    res.json({
        success: true,
        entityId: eId,
        botType: 'personal',
        botId: personalBot.bot_id,
        usedSlot: usedSlot,
        message: usedSlot ? 'Personal bot bound using existing paid slot' : 'Personal bot bound successfully'
    });
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
    if (device.deviceSecret && device.deviceSecret !== deviceSecret) {
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
    if (isNaN(eId) || eId < 0 || eId >= MAX_ENTITIES_PER_DEVICE) {
        return res.status(400).json({ success: false, error: 'Invalid entityId (0-3)' });
    }

    // Auto-create device if missing (e.g. after server redeploy)
    const device = getOrCreateDevice(deviceId, deviceSecret);

    if (device.deviceSecret && device.deviceSecret !== deviceSecret) {
        return res.status(403).json({ success: false, error: 'Invalid deviceSecret' });
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

    // Reset entity
    device.entities[eId] = createDefaultEntity(eId);
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
    const device = devices[deviceId];
    if (!device || device.deviceSecret !== deviceSecret) {
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
    if (isNaN(eId) || eId < 0 || eId >= MAX_ENTITIES_PER_DEVICE) {
        return res.status(400).json({ success: false, error: 'Invalid entityId (0-3)' });
    }

    const device = devices[deviceId];
    if (!device || device.deviceSecret !== deviceSecret) {
        return res.status(403).json({ success: false, error: 'Invalid device credentials' });
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
    if (eId < 0 || eId >= MAX_ENTITIES_PER_DEVICE) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    const entity = device.entities[eId];

    if (!entity.isBound) {
        return res.status(400).json({
            success: false,
            message: `Entity ${eId} is not bound yet. Bind first using /api/bind`
        });
    }

    // Verify botSecret
    if (!botSecret || botSecret !== entity.botSecret) {
        return res.status(403).json({ success: false, message: "Invalid botSecret" });
    }

    // Validate required fields
    if (!webhook_url || !token || !session_key) {
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
    } catch (e) {
        return res.status(400).json({
            success: false,
            message: "Invalid webhook_url format"
        });
    }

    // Reject placeholder/unresolved token values
    const tokenStr = token.trim();
    const placeholderPattern = /^\[.*\]$|^\{.*\}$|^\$\{.*\}$|^<.*>$|^__.*__$|^process\.env\.|^your[-_]|^xxx|^test$/i;
    if (placeholderPattern.test(tokenStr) || tokenStr.includes('gateway token') || tokenStr.includes('your-') || tokenStr.includes('TOKEN_HERE') || tokenStr.includes('REDACTED') || tokenStr.includes('PLACEHOLDER')) {
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
    if (cleanToken.toLowerCase().startsWith('bearer ')) {
        cleanToken = cleanToken.substring(7).trim(); // Remove "Bearer " (7 chars)
        console.log(`[Bot Register] Cleaned token: removed "Bearer " prefix`);
    }

    // Normalize webhook URL: fix double slashes in path (e.g. https://x.com//tools/invoke)
    const urlObj2 = new URL(webhook_url);
    urlObj2.pathname = urlObj2.pathname.replace(/\/\/+/g, '/');
    const finalUrl = urlObj2.toString().replace(/\/$/, '');

    const tokenPreview = cleanToken.length > 8 ? cleanToken.substring(0, 4) + '...' + cleanToken.substring(cleanToken.length - 4) : '***';

    // ── Handshake: dry-run test of sessions_send via /tools/invoke ──
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
    if (eId < 0 || eId >= MAX_ENTITIES_PER_DEVICE) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    const entity = device.entities[eId];

    if (!botSecret || botSecret !== entity.botSecret) {
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
    if (eId < 0 || eId >= MAX_ENTITIES_PER_DEVICE) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    const entity = device.entities[eId];

    if (!botSecret || botSecret !== entity.botSecret) {
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
    if (eId < 0 || eId >= MAX_ENTITIES_PER_DEVICE) {
        return res.status(400).json({ success: false, message: "Invalid entityId" });
    }

    const device = devices[deviceId];
    if (!device) {
        return res.status(404).json({ success: false, message: "Device not found" });
    }

    const entity = device.entities[eId];

    // botSecret required for authentication
    if (!botSecret || botSecret !== entity.botSecret) {
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
async function gatewayFetch(url, token, body, options = {}) {
    const { setupUsername, setupPassword, timeout, signal } = options;

    if (setupUsername && setupPassword) {
        // WebSocket transport for gateways with SETUP_PASSWORD
        return gatewayWsFetch(url, token, body, options);
    }

    // HTTP transport (existing behavior for gateways without SETUP_PASSWORD)
    const headers = { 'Content-Type': 'application/json' };
    headers['Authorization'] = `Bearer ${token}`;

    return fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: signal || (timeout ? AbortSignal.timeout(timeout) : undefined)
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
async function sendToSession(url, token, sessionKey, message, authOpts = {}) {
    try {
        const response = await gatewayFetch(url, token, {
            tool: "sessions_send",
            args: { sessionKey, message }
        }, authOpts);

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
    let hints = `\n\n[AVAILABLE TOOLS — Mission Dashboard]\n`;
    hints += `Read tasks/notes/rules/skills: exec: curl -s "${apiBase}/api/mission/dashboard?deviceId=${deviceId}&botSecret=${botSecret}&entityId=${entityId}"\n`;
    hints += `Read notes: exec: curl -s "${apiBase}/api/mission/notes?deviceId=${deviceId}&botSecret=${botSecret}&entityId=${entityId}"\n`;
    hints += `Mark TODO done: exec: curl -s -X POST "${apiBase}/api/mission/todo/done" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${entityId},"botSecret":"${botSecret}","title":"TASK_TITLE"}'\n`;
    hints += `Add note: exec: curl -s -X POST "${apiBase}/api/mission/note/add" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${entityId},"botSecret":"${botSecret}","title":"TITLE","content":"CONTENT"}'\n`;
    return hints;
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

    const requestPayload = {
        tool: "sessions_send",
        args: {
            sessionKey: effectiveSessionKey,
            message: messageContent
        }
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
            entity.message = `[SYSTEM:WEBHOOK_ERROR] Push failed (HTTP ${response.status}).${debugHint}`;
            entity.lastUpdated = Date.now();
            console.log(`[Push] Set WEBHOOK_ERROR system message for Device ${deviceId} Entity ${entity.entityId}`);

            entity.pushStatus = { ok: false, reason: `http_${response.status}`, at: Date.now() };
            return { pushed: false, reason: `http_${response.status}`, error: errorText, debug: { url, tokenLength: token.length, status: response.status, hint: debugHint.trim() } };
        }
    } catch (err) {
        console.error(`[Push] ✗ Device ${deviceId} Entity ${entity.entityId}: Push error:`, err.message);
        console.error(`[Push] Full error:`, err);
        serverLog('error', 'push_error', `Entity ${entity.entityId} push exception: ${err.message}`, { deviceId, entityId: entity.entityId });

        // Notify device about webhook failure via entity message
        entity.message = `[SYSTEM:WEBHOOK_ERROR] Push connection failed: ${err.message}`;
        entity.lastUpdated = Date.now();
        console.log(`[Push] Set WEBHOOK_ERROR system message for Device ${deviceId} Entity ${entity.entityId}`);

        entity.pushStatus = { ok: false, reason: err.message, at: Date.now() };
        return { pushed: false, reason: err.message };
    }
}

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
    if (!sourceDevice || sourceDevice.deviceSecret !== sourceDeviceSecret) {
        return res.status(401).json({ success: false, message: "Invalid source device credentials" });
    }
    const targetDevice = getOrCreateDevice(targetDeviceId, targetDeviceSecret);
    if (targetDevice.deviceSecret && targetDevice.deviceSecret !== targetDeviceSecret) {
        return res.status(401).json({ success: false, message: "Invalid target device credentials" });
    }
    if (!targetDevice.deviceSecret) targetDevice.deviceSecret = targetDeviceSecret;

    const transferred = [];
    const dbMigrated = {};
    try {
        // 1. Transfer in-memory entities + official bindings
        for (let eId = 0; eId < MAX_ENTITIES_PER_DEVICE; eId++) {
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
    if (!device || device.deviceSecret !== deviceSecret) {
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
    if (!device || device.deviceSecret !== deviceSecret) {
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
    if (!device || device.deviceSecret !== deviceSecret) {
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
    if (!device || device.deviceSecret !== deviceSecret) {
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
    if (!device || device.deviceSecret !== deviceSecret) {
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
    if (!device || device.deviceSecret !== deviceSecret) {
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
    if (!device || device.deviceSecret !== deviceSecret) {
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
        if (!device || device.deviceSecret !== deviceSecret) {
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
    if (!device || device.deviceSecret !== deviceSecret) {
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
telemetry.initTelemetryTable(chatPool);
feedbackModule.initFeedbackTable(chatPool);
feedbackModule.initFeedbackPhotosTable(chatPool);
notifModule.initNotificationTables(chatPool);
chatIntegrity.initIntegrityTable(chatPool);

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
// Increase body limit for chat (images can be large)
app.use('/api/ai-support/chat/submit', express.json({ limit: '10mb' }));
app.use('/api/ai-support/chat', express.json({ limit: '10mb' }));
app.use('/api/ai-support', aiSupportModule.router);
aiSupportModule.initSupportTable();

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
        if (device && device.deviceSecret === deviceSecret) return deviceId;
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
    const { deviceId, deviceSecret, fcmToken } = req.body;
    if (!deviceId || !deviceSecret || !fcmToken) {
        return res.status(400).json({ success: false, error: 'deviceId, deviceSecret, fcmToken required' });
    }
    const device = devices[deviceId];
    if (!device || device.deviceSecret !== deviceSecret) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    // Store in memory (persisted to DB via auto-save)
    device.fcmToken = fcmToken;

    // Also store in DB immediately
    chatPool.query(
        'ALTER TABLE devices ADD COLUMN IF NOT EXISTS fcm_token TEXT'
    ).catch(() => {});
    chatPool.query(
        'UPDATE devices SET fcm_token = $1 WHERE device_id = $2',
        [fcmToken, deviceId]
    ).catch(() => {});

    console.log(`[FCM] Token registered for device ${deviceId}`);
    res.json({ success: true });
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

    // Push to bot if webhook is registered
    let pushResult = { pushed: false, reason: 'no_webhook' };
    if (entity.webhook) {
        const apiBase = 'https://eclawbot.com';
        let pushMsg = `[ACTION REQUIRED] You MUST use exec tool with curl to call the API below. Your text reply is DISCARDED and the user will NEVER see it.\n`;
        pushMsg += `Run this command to reply (replace YOUR_REPLY_HERE with your response):\n`;
        pushMsg += `exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${entityId},"botSecret":"${entity.botSecret}","state":"IDLE","message":"YOUR_REPLY_HERE"}'\n\n`;
        pushMsg += `[SCHEDULED MESSAGE] Device ${deviceId} Entity ${entityId}\n`;
        pushMsg += `From: scheduled\n`;
        pushMsg += `Content: ${message}`;
        pushMsg += getMissionApiHints(apiBase, deviceId, entityId, entity.botSecret);

        pushResult = await pushToBot(entity, deviceId, 'new_message', {
            message: pushMsg
        });

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
        mode: entity.webhook ? 'push' : 'polling',
        reason: pushResult.pushed ? 'ok' : (pushResult.reason || 'unknown')
    };
}

// Init scheduler with chatPool (after DB is ready)
setTimeout(() => {
    scheduler.init(chatPool, executeScheduledMessage);
}, 4000);

// ── Schedule API Routes ──

// GET /api/schedules - List schedules for a device
app.get('/api/schedules', async (req, res) => {
    const { deviceId, deviceSecret, status, limit, offset } = req.query;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || device.deviceSecret !== deviceSecret) {
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
    if (!device || device.deviceSecret !== deviceSecret) {
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
    if (!device || device.deviceSecret !== deviceSecret) {
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

// POST /api/schedules - Create a new schedule
app.post('/api/schedules', async (req, res) => {
    const { deviceId, deviceSecret, entityId, message, scheduledAt, repeatType, cronExpr, label, timezone } = req.body;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || device.deviceSecret !== deviceSecret) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    try {
        const schedule = await scheduler.createSchedule({
            deviceId, entityId, message, scheduledAt, repeatType, cronExpr, label, timezone
        });
        res.json({ success: true, schedule });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// PUT /api/schedules/:id - Update a schedule
app.put('/api/schedules/:id', async (req, res) => {
    const { deviceId, deviceSecret, ...updates } = req.body;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || device.deviceSecret !== deviceSecret) {
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

// DELETE /api/schedules/:id - Delete a schedule
app.delete('/api/schedules/:id', async (req, res) => {
    const { deviceId, deviceSecret } = req.body || {};
    const qDeviceId = deviceId || req.query.deviceId;
    const qDeviceSecret = deviceSecret || req.query.deviceSecret;
    if (!qDeviceId || !qDeviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[qDeviceId];
    if (!device || device.deviceSecret !== qDeviceSecret) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    try {
        await scheduler.deleteSchedule(parseInt(req.params.id), qDeviceId);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// ── Bot Schedule API (read/write via botSecret) ──

// GET /api/bot/schedules - Bot reads schedules
app.get('/api/bot/schedules', async (req, res) => {
    const { deviceId, entityId, botSecret } = req.query;
    if (!deviceId || entityId === undefined || !botSecret) {
        return res.status(400).json({ success: false, error: 'deviceId, entityId, and botSecret required' });
    }
    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });
    const eId = parseInt(entityId);
    const entity = device.entities[eId];
    if (!entity || !entity.isBound || entity.botSecret !== botSecret) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    try {
        const schedules = await scheduler.getSchedulesForBot(deviceId, eId);
        res.json({ success: true, schedules });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/bot/schedules - Bot creates a schedule
app.post('/api/bot/schedules', async (req, res) => {
    const { deviceId, entityId, botSecret, message, scheduledAt, repeatType, cronExpr, label } = req.body;
    if (!deviceId || entityId === undefined || !botSecret) {
        return res.status(400).json({ success: false, error: 'deviceId, entityId, and botSecret required' });
    }
    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });
    const eId = parseInt(entityId);
    const entity = device.entities[eId];
    if (!entity || !entity.isBound || entity.botSecret !== botSecret) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    try {
        const schedule = await scheduler.createSchedule({
            deviceId, entityId: eId, message, scheduledAt, repeatType, cronExpr, label
        });
        res.json({ success: true, schedule });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// DELETE /api/bot/schedules/:id - Bot deletes a schedule
app.delete('/api/bot/schedules/:id', async (req, res) => {
    const { deviceId, entityId, botSecret } = req.query;
    if (!deviceId || entityId === undefined || !botSecret) {
        return res.status(400).json({ success: false, error: 'deviceId, entityId, and botSecret required' });
    }
    const device = devices[deviceId];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });
    const eId = parseInt(entityId);
    const entity = device.entities[eId];
    if (!entity || !entity.isBound || entity.botSecret !== botSecret) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    try {
        await scheduler.deleteSchedule(parseInt(req.params.id), deviceId);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// Save chat message to database, returns row ID (UUID) or null
// Deduplication: bot messages with identical text for the same entity within 10s are skipped
async function saveChatMessage(deviceId, entityId, text, source, isFromUser, isFromBot, mediaType = null, mediaUrl = null, scheduleId = null, scheduleLabel = null) {
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
            `INSERT INTO chat_messages (device_id, entity_id, text, source, is_from_user, is_from_bot, media_type, media_url, schedule_id, schedule_label)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
            [deviceId, entityId, text, source, isFromUser || false, isFromBot || false, mediaType, mediaUrl, scheduleId, scheduleLabel]
        );
        const msgId = result.rows[0]?.id || null;

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
    const { deviceId, entityId, metadata } = opts;
    chatPool.query(
        `INSERT INTO server_logs (level, category, message, device_id, entity_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [level, category, message, deviceId || null, entityId ?? null, metadata ? JSON.stringify(metadata) : null]
    ).catch(() => {}); // Never throw — logs are non-critical
}

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

// GET /api/logs — Query server logs for debugging
// Auth: requires deviceSecret of ANY device on the server (proves you're an admin/owner)
app.get('/api/logs', async (req, res) => {
    const { deviceId, deviceSecret, category, level, since, limit = 100 } = req.query;

    // Basic auth: must provide a valid deviceId+deviceSecret pair
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || device.deviceSecret !== deviceSecret) {
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

// GET /api/handshake-failures — Query handshake failure records for analysis
app.get('/api/handshake-failures', async (req, res) => {
    const { deviceId, deviceSecret, error_type, source, since, limit = 100 } = req.query;

    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || device.deviceSecret !== deviceSecret) {
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
    const { deviceId, deviceSecret, entries } = req.body;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || device.deviceSecret !== deviceSecret) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ success: false, error: 'entries array required' });
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
    if (!device || device.deviceSecret !== deviceSecret) {
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
    if (!device || device.deviceSecret !== deviceSecret) {
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
    if (!device || device.deviceSecret !== deviceSecret) {
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
    if (!device || device.deviceSecret !== deviceSecret) {
        // Also check JWT cookie
        const jwt = require('jsonwebtoken');
        const token = req.cookies && req.cookies.eclaw_session;
        if (token) {
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret-change-in-production');
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
    if (!device || device.deviceSecret !== deviceSecret) {
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
    if (!device || device.deviceSecret !== deviceSecret) {
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
    if (!device || device.deviceSecret !== deviceSecret) {
        const jwt = require('jsonwebtoken');
        const token = req.cookies && req.cookies.eclaw_session;
        if (token) {
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret-change-in-production');
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
    if (!device || device.deviceSecret !== deviceSecret) {
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
    return entity && entity.botSecret === botSecret;
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
        console.log(`Max entities per device: ${MAX_ENTITIES_PER_DEVICE}`);
        console.log(`Persistence: ${usePostgreSQL ? 'PostgreSQL' : 'File Storage (Fallback)'}`);

        // Initialize Flickr client
        flickr.initFlickr();
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
    if (entity.botSecret !== botSecret) {
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
