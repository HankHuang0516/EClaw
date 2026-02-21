// Claw Live Wallpaper Backend - Multi-Device Multi-Entity Support (v5.3)
// Each device has its own 4 entity slots (matrix architecture)
// v5.2 Changes (PostgreSQL):
//   - Bug #1 Fix: Added validation to prevent crashes from malformed requests
//   - Bug #2 Fix: Implemented PostgreSQL data persistence (fallback to file storage)
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const flickr = require('./flickr');
const gatekeeper = require('./gatekeeper');
const telemetry = require('./device-telemetry');
const feedbackModule = require('./device-feedback');
const scheduler = require('./scheduler');
const multer = require('multer');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
const cookieParser = require('cookie-parser');
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use('/mission', express.static(path.join(__dirname, 'public')));
app.use('/portal', express.static(path.join(__dirname, 'public/portal')));
app.use('/shared', express.static(path.join(__dirname, 'public/shared')));

// Telemetry auto-capture middleware (pool linked lazily after chatPool init)
let _telemetryPool = null;
const telemetryPoolProxy = {
    query: function (...args) {
        return _telemetryPool ? _telemetryPool.query(...args) : Promise.resolve({ rows: [] });
    }
};
app.use(telemetry.createMiddleware(telemetryPoolProxy, (deviceId) => devices[deviceId]));

// ============================================
// MATRIX ARCHITECTURE: devices[deviceId].entities[0-3]
// Each device has independent entity slots
// ============================================

const MAX_ENTITIES_PER_DEVICE = 4;

// Latest app version - update this with each release
// Bot will warn users if their app version is older than this
const LATEST_APP_VERSION = "1.0.21";

// Device registry - each device has its own entities
const devices = {};

// Pending binding codes (code -> { deviceId, entityId, expires })
const pendingBindings = {};

// Bot-to-bot loop prevention: counter resets ONLY when a human message arrives
// Key: "deviceId:entityId" -> count of bot-to-bot messages since last human message
const botToBotCounter = {};
const BOT2BOT_MAX_MESSAGES = 8; // max bot-to-bot messages before human must intervene

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
    for (let i = 0; i < 4; i++) {
        const key = `${deviceId}:${i}`;
        if (botToBotCounter[key]) botToBotCounter[key] = 0;
    }
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
const missionModule = require('./mission')(devices);
app.use('/api/mission', missionModule.router);
missionModule.initMissionDatabase();

// ============================================
// USER AUTHENTICATION (PostgreSQL)
// ============================================
const authModule = require('./auth')(devices, getOrCreateDevice);
app.use('/api/auth', authModule.router);
authModule.initAuthDatabase();

// ============================================
// SUBSCRIPTION & TAPPAY (PostgreSQL)
// ============================================
const subscriptionModule = require('./subscription')(devices, authModule.authMiddleware);
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

        // Device counts (in-memory)
        const deviceTotal = Object.keys(devices).length;
        let entityTotal = 0;
        let boundEntities = 0;
        for (const d of Object.values(devices)) {
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
            recentSignups: recentSignups.rows
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

        res.json({
            success: true,
            bindings: result.rows.map(r => ({
                botId: r.bot_id,
                botType: r.bot_type,
                deviceId: r.device_id,
                entityId: r.entity_id != null ? parseInt(r.entity_id) : null,
                userEmail: r.user_email || '(APP user)',
                boundAt: r.bound_at ? parseInt(r.bound_at) : null,
                subscriptionVerifiedAt: r.subscription_verified_at ? parseInt(r.subscription_verified_at) : null,
                botStatus: r.bot_status
            }))
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
                isTestDevice: dev ? isTestDeviceCheck(r.device_id, dev) : false
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

        res.json({
            success: true,
            bots: result.rows.map(r => ({
                botId: r.bot_id,
                botType: r.bot_type,
                status: r.status,
                assignedDeviceId: r.assigned_device_id,
                assignedEntityId: r.assigned_entity_id != null ? parseInt(r.assigned_entity_id) : null,
                assignedUserEmail: r.assigned_user_email || null,
                assignedAt: r.assigned_at ? parseInt(r.assigned_at) : null,
                createdAt: r.created_at ? parseInt(r.created_at) : null
            }))
        });
    } catch (err) {
        console.error('[Admin] Bots error:', err);
        res.status(500).json({ success: false, error: 'Failed to get bots' });
    }
});

// POST /api/admin/bots/create - Create new official bot (cookie-based admin auth)
app.post('/api/admin/bots/create', adminAuth, adminCheck, async (req, res) => {
    try {
        const { botId, botType, webhookUrl, token } = req.body;

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
            created_at: Date.now()
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
        appVersion: null // Device app version (e.g., "1.0.3")
    };
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
        // Initialize 4 entity slots
        for (let i = 0; i < MAX_ENTITIES_PER_DEVICE; i++) {
            devices[deviceId].entities[i] = createDefaultEntity(i);
        }
        console.log(`[Device] New device registered: ${deviceId}${opts.isTestDevice ? ' (TEST)' : ''}`);
    } else if (opts.isTestDevice && !devices[deviceId].isTestDevice) {
        // Mark existing device as test if requested
        devices[deviceId].isTestDevice = true;
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
function sendBindCredentialsToBot(webhookUrl, webhookToken, sessionKey, deviceId, entityId, botSecret, botType) {
    const skillDoc = loadSkillDoc();
    const apiBase = 'https://eclaw.up.railway.app';
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

    sendToSession(webhookUrl, webhookToken, sessionKey, msg)
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
    const deviceCount = Object.keys(devices).length;
    let boundCount = 0;
    for (const deviceId in devices) {
        for (let i = 0; i < MAX_ENTITIES_PER_DEVICE; i++) {
            if (devices[deviceId].entities[i]?.isBound) boundCount++;
        }
    }
    res.send(`Claw Backend Running! Devices: ${deviceCount}, Bound Entities: ${boundCount}`);
});

// Health check endpoint for Railway
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: Date.now() });
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

    // Generate bot secret for this binding
    const botSecret = generateBotSecret();

    // Mark as bound
    entity.isBound = true;
    entity.botSecret = botSecret;
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
        name: entity.name,
        deviceInfo: {
            deviceId: deviceId,
            entityId: entityId,
            status: "ONLINE"
        },
        versionInfo: getVersionInfo(deviceAppVersion),
        skills_documentation: loadSkillDoc()
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
                    isBound: true  // Always true since we only return bound entities
                });
            }
        }
    }

    // Log when a device-filtered request returns no entities but the device exists
    // This helps diagnose transient empty responses that cause client-side card disappearing (#16)
    if (filterDeviceId && entities.length === 0 && devices[filterDeviceId]) {
        serverLog('warn', 'entity_poll', `Device ${filterDeviceId} returned 0 bound entities (device exists in memory)`, {
            deviceId: filterDeviceId,
            metadata: { totalDeviceSlots: MAX_ENTITIES_PER_DEVICE }
        });
    }

    res.json({
        entities: entities,
        activeCount: entities.length,
        deviceCount: Object.keys(devices).length,
        maxEntitiesPerDevice: MAX_ENTITIES_PER_DEVICE
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
    }

    console.log(`[Transform] Device ${deviceId} Entity ${eId}: ${state || entity.state} - "${finalMessage || entity.message}"`);
    serverLog('info', 'transform', `${state || entity.state}: ${(finalMessage || entity.message || '').slice(0, 100)}`, { deviceId, entityId: eId, metadata: { state: state || entity.state } });

    res.json({
        success: true,
        deviceId: deviceId,
        entityId: eId,
        currentState: {
            name: entity.name,
            character: entity.character,
            state: entity.state,
            message: entity.message,
            parts: entity.parts
        },
        versionInfo: getVersionInfo(entity.appVersion)
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

    if (!Array.isArray(order) || order.length !== MAX_ENTITIES_PER_DEVICE) {
        return res.status(400).json({ success: false, error: `order must be array of ${MAX_ENTITIES_PER_DEVICE} slot indices` });
    }

    // Validate order is a valid permutation of [0..MAX_ENTITIES_PER_DEVICE-1]
    const sorted = [...order].sort();
    for (let i = 0; i < MAX_ENTITIES_PER_DEVICE; i++) {
        if (sorted[i] !== i) {
            return res.status(400).json({ success: false, error: 'order must be a valid permutation of [0,1,2,3]' });
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
    for (let i = 0; i < MAX_ENTITIES_PER_DEVICE; i++) {
        oldEntities[i] = device.entities[i] ? { ...device.entities[i] } : createDefaultEntity(i);
        const cacheKey = getBindingCacheKey(deviceId, i);
        if (officialBindingsCache[cacheKey]) {
            oldBindings[i] = { ...officialBindingsCache[cacheKey] };
        }
    }

    // Step 2: Apply the permutation
    // order[newSlot] = oldSlot → entity from oldSlot goes to newSlot
    const botsToNotify = [];

    for (let newSlot = 0; newSlot < MAX_ENTITIES_PER_DEVICE; newSlot++) {
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

    // Step 3: Persist binding changes to DB
    if (usePostgreSQL) {
        // Remove all old bindings for this device, re-insert with new entity IDs
        for (let i = 0; i < MAX_ENTITIES_PER_DEVICE; i++) {
            await db.removeOfficialBinding(deviceId, i);
        }
        for (let i = 0; i < MAX_ENTITIES_PER_DEVICE; i++) {
            const cacheKey = getBindingCacheKey(deviceId, i);
            const binding = officialBindingsCache[cacheKey];
            if (binding) {
                await db.saveOfficialBinding(binding);
            }
        }

        // Update personal bot assignments
        for (const info of botsToNotify) {
            if (info.binding) {
                const bot = officialBots[info.binding.bot_id];
                if (bot && bot.bot_type === 'personal' && bot.assigned_device_id === deviceId) {
                    bot.assigned_entity_id = info.newSlot;
                    await db.saveOfficialBot(bot);
                }
            }
        }
    }

    await saveData();

    // Step 4: Notify bots of their new entity IDs (fire-and-forget)
    for (const info of botsToNotify) {
        const { entity, oldSlot, newSlot } = info;
        const apiBase = 'https://eclaw.up.railway.app';
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

    // Usage enforcement
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
        console.warn('[Usage] Enforcement check failed, allowing:', usageErr.message);
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
            const apiBase = 'https://eclaw.up.railway.app';
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
    const { deviceId, fromEntityId, toEntityId, botSecret, text, mediaType, mediaUrl } = req.body;

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

    console.log(`[Entity] Device ${deviceId} Entity ${fromId} -> Entity ${toId}: "${speakToText}" (b2b remaining: ${b2bRemaining})`);

    // Update entity.message so Android app can display it
    // Format must match Android's parseEntityMessage regex: "entity:{ID}:{CHARACTER}: {message}"
    toEntity.message = `entity:${fromId}:${fromEntity.character}: ${speakToText}`;
    toEntity.lastUpdated = Date.now();

    // Fire-and-forget: push to target bot webhook (don't block response)
    const hasWebhook = !!toEntity.webhook;
    if (hasWebhook) {
        // Instruction-first push format with pre-filled curl templates
        const apiBase = 'https://eclaw.up.railway.app';
        const toRemaining = getBotToBotRemaining(deviceId, toId);
        let pushMsg = `[ACTION REQUIRED] You MUST use exec tool with curl to call the API. Your text reply is DISCARDED.\n`;
        pushMsg += `To update your wallpaper status (visible on user's phone):\n`;
        pushMsg += `exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${toId},"botSecret":"${toEntity.botSecret}","state":"IDLE","message":"YOUR_REPLY_HERE"}'\n\n`;
        pushMsg += `To reply directly to Entity ${fromId}:\n`;
        pushMsg += `exec: curl -s -X POST "${apiBase}/api/entity/speak-to" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","fromEntityId":${toId},"toEntityId":${fromId},"botSecret":"${toEntity.botSecret}","text":"YOUR_REPLY_HERE"}'\n\n`;
        pushMsg += `[BOT-TO-BOT] Remaining quota: ${toRemaining}/${BOT2BOT_MAX_MESSAGES}. If the other entity is just repeating emotions with no new info, do NOT reply — just update your wallpaper status.`;
        if (toRemaining <= 2) {
            pushMsg += ` WARNING: Quota almost exhausted, do NOT auto-reply.`;
        }
        pushMsg += `\n\n[MESSAGE] From: ${sourceLabel}\n`;
        pushMsg += `Content: ${speakToText}`;
        if (mediaType === 'photo') {
            pushMsg += `\n[Attachment: Photo]\nmedia_type: photo\nmedia_url: ${mediaUrl}`;
            const bkUrl = getBackupUrl(mediaUrl);
            if (bkUrl) pushMsg += `\nbackup_url: ${bkUrl}`;
        } else if (mediaType === 'voice') pushMsg += `\n[Attachment: Voice]\nmedia_type: voice\nmedia_url: ${mediaUrl}`;
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

    res.json({
        success: true,
        message: `Message sent from Entity ${fromId} to Entity ${toId}`,
        from: { entityId: fromId, character: fromEntity.character },
        to: { entityId: toId, character: toEntity.character },
        pushed: hasWebhook ? "pending" : false,
        mode: hasWebhook ? "push" : "polling",
        reason: hasWebhook ? "fire_and_forget" : "no_webhook",
        bindingType: bindingTypeTo
    });
});

/**
 * POST /api/entity/broadcast
 * Broadcast message from one entity to all other bound entities on the same device.
 * Body: { deviceId, fromEntityId, botSecret, text }
 *
 * Requires botSecret of the SENDING entity for authentication.
 * All other bound entities on the same device will receive the message.
 */
app.post('/api/entity/broadcast', async (req, res) => {
    const { deviceId, fromEntityId, botSecret, text, mediaType, mediaUrl } = req.body;

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
        if (i !== fromId && device.entities[i].isBound) {
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
            const apiBase = 'https://eclaw.up.railway.app';
            const toRemainingBcast = getBotToBotRemaining(deviceId, toId);
            let pushMsg = `[ACTION REQUIRED] You MUST use exec tool with curl to call the API. Your text reply is DISCARDED.\n`;
            pushMsg += `To update your wallpaper status (visible on user's phone):\n`;
            pushMsg += `exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${toId},"botSecret":"${toEntity.botSecret}","state":"IDLE","message":"YOUR_REPLY_HERE"}'\n\n`;
            pushMsg += `To reply directly to Entity ${fromId}:\n`;
            pushMsg += `exec: curl -s -X POST "${apiBase}/api/entity/speak-to" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","fromEntityId":${toId},"toEntityId":${fromId},"botSecret":"${toEntity.botSecret}","text":"YOUR_REPLY_HERE"}'\n\n`;
            pushMsg += `[BOT-TO-BOT BROADCAST] Remaining quota: ${toRemainingBcast}/${BOT2BOT_MAX_MESSAGES}. If the broadcast is just repeating emotions with no new info, do NOT reply — just update your wallpaper status.`;
            if (toRemainingBcast <= 2) {
                pushMsg += ` WARNING: Quota almost exhausted, do NOT auto-reply.`;
            }
            pushMsg += `\n\n[BROADCAST] From: ${sourceLabel}\n`;
            pushMsg += `Content: ${broadcastText}`;
            if (mediaType === 'photo') {
                pushMsg += `\n[Attachment: Photo]\nmedia_type: photo\nmedia_url: ${mediaUrl}`;
                const bkUrl = getBackupUrl(mediaUrl);
                if (bkUrl) pushMsg += `\nbackup_url: ${bkUrl}`;
            } else if (mediaType === 'voice') pushMsg += `\n[Attachment: Voice]\nmedia_type: voice\nmedia_url: ${mediaUrl}`;
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
        broadcast: targetIds.length > 1
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

    const { botId, botType, webhookUrl, token, botSecret, sessionKeyTemplate } = req.body;

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
        created_at: Date.now()
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

    const { webhookUrl, token, sessionKeyTemplate, status } = req.body;
    if (webhookUrl) bot.webhook_url = webhookUrl;
    if (token) bot.token = token;
    if (sessionKeyTemplate !== undefined) bot.session_key_template = sessionKeyTemplate;
    if (status && ['available', 'assigned', 'disabled'].includes(status)) bot.status = status;

    if (usePostgreSQL) await db.saveOfficialBot(bot);

    console.log(`[Admin] Updated official bot: ${botId}`);
    res.json({ success: true, bot: { bot_id: bot.bot_id, bot_type: bot.bot_type, status: bot.status } });
});

/**
 * DELETE /api/admin/official-bot/:botId
 * Remove an official bot from the pool.
 */
app.delete('/api/admin/official-bot/:botId', async (req, res) => {
    if (!verifyAdmin(req)) {
        return res.status(403).json({ success: false, error: 'Forbidden: admin token required' });
    }

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
    const handshake = await handshakeWithBot(freeBot.webhook_url, freeBot.token, preferredKey, deviceId, eId, 'free');

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
    device.entities[eId] = {
        ...createDefaultEntity(eId),
        botSecret: botSecret,
        isBound: true,
        name: existingNameFree || '免費版',
        state: 'IDLE',
        message: 'Connected!',
        lastUpdated: Date.now(),
        webhook: {
            url: freeBot.webhook_url,
            token: freeBot.token,
            sessionKey: sessionKey,
            registeredAt: Date.now()
        }
    };

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
    sendBindCredentialsToBot(freeBot.webhook_url, freeBot.token, sessionKey, deviceId, eId, botSecret, 'free');

    res.json({
        success: true,
        entityId: eId,
        botType: 'free',
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
    const handshake = await handshakeWithBot(personalBot.webhook_url, personalBot.token, preferredKey, deviceId, eId, 'personal');

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
            registeredAt: Date.now()
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
    sendBindCredentialsToBot(personalBot.webhook_url, personalBot.token, sessionKey, deviceId, eId, botSecret, 'personal');

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
        const handshake = await handshakeWithBot(bot.webhook_url, bot.token, preferredKey, deviceId, eId, bot.bot_type);

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
            registeredAt: Date.now()
        };
        entity.lastUpdated = Date.now();

        // Update binding cache + DB
        binding.session_key = newSessionKey;
        if (usePostgreSQL) await db.saveOfficialBinding(binding);

        await saveData();

        // Fire-and-forget: resend credentials + skills doc
        sendBindCredentialsToBot(bot.webhook_url, bot.token, newSessionKey, deviceId, eId, entity.botSecret, bot.bot_type);

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
 * POST /api/bot/register
 * Bot registers its webhook URL to receive push notifications.
 * Body: { deviceId, entityId, botSecret, webhook_url, token, session_key }
 */
app.post('/api/bot/register', async (req, res) => {
    const { deviceId, entityId, botSecret, webhook_url, token, session_key } = req.body;

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

    // Reject localhost/127.0.0.1 webhook URLs - these won't work from the cloud
    try {
        const urlObj = new URL(webhook_url);
        if (urlObj.hostname === 'localhost' || urlObj.hostname === '127.0.0.1' || urlObj.hostname === '0.0.0.0') {
            console.warn(`[Bot Register] Rejected localhost webhook: ${webhook_url}`);
            return res.status(400).json({
                success: false,
                message: "webhook_url cannot be localhost. Your bot appears to be deployed on a cloud server, " +
                    "but the webhook URL points to localhost which is unreachable from the internet. " +
                    "Please use your public URL instead (e.g. ZEABUR_WEB_URL environment variable).",
                hint: "If using Zeabur: webhook_url = process.env.ZEABUR_WEB_URL + '/tools/invoke'"
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
        const probeResponse = await fetch(finalUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${cleanToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(handshakePayload),
            signal: AbortSignal.timeout(5000) // 5s timeout - real failures return in < 1s; timeout = success
        });

        const responseText = await probeResponse.text().catch(() => '');

        if (!probeResponse.ok) {
            console.error(`[Bot Register] ✗ Handshake FAILED: ${finalUrl} returned HTTP ${probeResponse.status}`);
            console.error(`[Bot Register] Response: ${responseText}`);

            // Parse error for specific failure reasons
            let parsedError = null;
            try { parsedError = JSON.parse(responseText); } catch (e) { }
            const errorMessage = parsedError?.error?.message || responseText;

            if (probeResponse.status === 401) {
                return res.status(400).json({
                    success: false,
                    message: "Webhook handshake failed: gateway rejected the token (HTTP 401). " +
                        "Please verify that the token matches your OPENCLAW_GATEWAY_TOKEN.",
                    hint: "Re-read gateway config and use the correct token.",
                    debug: { probeUrl: finalUrl, httpStatus: probeResponse.status, tokenPreview }
                });
            }

            if (probeResponse.status === 404 || errorMessage.includes('not available') || errorMessage.includes('not found')) {
                return res.status(400).json({
                    success: false,
                    message: "Webhook handshake failed: gateway cannot execute 'sessions_send' tool. " +
                        `Server responded: "${errorMessage}". ` +
                        "OpenClaw 2.14+ blocks sessions_send by default. " +
                        "Please add the following to your .openclaw/openclaw.json and restart OpenClaw:\n" +
                        '{ "gateway": { "tools": { "allow": ["sessions_send"] } } }',
                    hint: "Edit .openclaw/openclaw.json to allow sessions_send, then restart OpenClaw.",
                    debug: { probeUrl: finalUrl, httpStatus: probeResponse.status, serverError: errorMessage }
                });
            }

            // Other errors - reject registration
            return res.status(400).json({
                success: false,
                message: `Webhook handshake failed: gateway returned HTTP ${probeResponse.status}. ` +
                    `Server responded: "${errorMessage}".`,
                hint: "Check your gateway logs for more details.",
                debug: { probeUrl: finalUrl, httpStatus: probeResponse.status, serverError: errorMessage }
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
            return res.status(400).json({
                success: false,
                message: `Webhook handshake failed: cannot reach gateway at ${finalUrl}. ` +
                    `Error: ${probeErr.message}. ` +
                    `Please verify that your bot server is running and the webhook URL is correct.`,
                hint: "If using Zeabur: ensure the service is deployed and the URL matches ZEABUR_WEB_URL.",
                debug: { probeUrl: finalUrl, error: probeErr.message }
            });
        }
    }

    // ── Handshake passed: store webhook info ──
    entity.webhook = {
        url: finalUrl,
        token: cleanToken,
        sessionKey: session_key,
        registeredAt: Date.now()
    };

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

    res.json({
        success: true,
        message: "Webhook registered. You will now receive push notifications.",
        deviceId: deviceId,
        entityId: eId,
        mode: "push",
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
 * Helper: Discover existing sessions on the OpenClaw gateway via sessions_list.
 * Returns array of session key strings, or empty array on failure.
 */
async function discoverSessions(url, token) {
    try {
        console.log(`[Session] Discovering sessions on gateway ${url}`);
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ tool: "sessions_list", args: {} })
        });

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
async function handshakeWithBot(url, token, preferredSessionKey, deviceId, entityId, botType) {
    const bindMsg = `[SYSTEM:BIND_HANDSHAKE] New binding: Device ${deviceId}, Entity ${entityId}, Type: ${botType}. Reply OK to confirm.`;

    // Step 1: Try preferred session key
    console.log(`[Handshake] Trying preferred session key: ${preferredSessionKey}...`);
    let result = await sendToSession(url, token, preferredSessionKey, bindMsg);

    if (result.success) {
        console.log(`[Handshake] ✓ Handshake OK with preferred key`);
        return { success: true, sessionKey: preferredSessionKey, botResponse: result.botResponse };
    }

    // Step 2: If session not found, discover existing sessions
    if (result.sessionNotFound) {
        console.log(`[Handshake] Preferred session not found, discovering sessions...`);
        const sessions = await discoverSessions(url, token);
        console.log(`[Handshake] Discovered ${sessions.length} sessions: ${JSON.stringify(sessions)}`);

        for (const sk of sessions) {
            console.log(`[Handshake] Trying discovered session: ${sk}...`);
            result = await sendToSession(url, token, sk, bindMsg);
            if (result.success) {
                console.log(`[Handshake] ✓ Handshake OK with discovered key: ${sk}`);
                return { success: true, sessionKey: sk, botResponse: result.botResponse };
            }
        }
    }

    console.error(`[Handshake] ✗ All session attempts failed. Bot gateway may not have active sessions.`);
    return { success: false, error: result.error || 'No working session found on gateway' };
}

/**
 * Helper: Send a message to a specific session and parse the response.
 */
async function sendToSession(url, token, sessionKey, message) {
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                tool: "sessions_send",
                args: { sessionKey, message }
            })
        });

        const text = await response.text().catch(() => '');

        if (!response.ok) {
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
        return { success: false, error: err.message };
    }
}

/**
 * Helper: Push notification to bot webhook
 * Supports OpenClaw format: POST to /tools/invoke with tool invocation payload
 */
async function pushToBot(entity, deviceId, eventType, payload) {
    if (!entity.webhook) {
        return { pushed: false, reason: "no_webhook" };
    }

    const { url, token, sessionKey } = entity.webhook;

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
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestPayload)
        });

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
                const sessions = await discoverSessions(url, token);
                if (sessions.length > 0) {
                    console.log(`[Push] Found ${sessions.length} sessions, trying first: ${sessions[0]}`);
                    // Try sending with the first discovered session
                    const retryPayload = {
                        ...requestPayload,
                        args: { ...requestPayload.args, sessionKey: sessions[0] }
                    };
                    const retryResponse = await fetch(url, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(retryPayload)
                    });
                    const retryText = await retryResponse.text().catch(() => '');
                    if (retryResponse.ok && !retryText.includes('No session found')) {
                        console.log(`[Push] ✓ Retry successful with discovered session: ${sessions[0]}`);
                        // Update entity webhook sessionKey so future pushes use the correct one
                        if (entity.webhook) {
                            entity.webhook.sessionKey = sessions[0];
                            console.log(`[Push] Updated entity sessionKey to: ${sessions[0]}`);
                        }
                        if (entity.pendingRename) { entity.pendingRename = null; }
                        return { pushed: true };
                    } else {
                        console.error(`[Push] ✗ Retry with discovered session failed: ${retryText.substring(0, 200)}`);
                        return { pushed: false, reason: 'session_discovery_retry_failed', error: retryText };
                    }
                } else {
                    console.error(`[Push] ✗ No sessions discovered on gateway`);
                    return { pushed: false, reason: 'no_sessions_available', error: responseText };
                }
            }

            if (entity.pendingRename) { entity.pendingRename = null; }
            return { pushed: true };
        } else {
            const errorText = await response.text().catch(() => '');
            console.error(`[Push] ✗ Device ${deviceId} Entity ${entity.entityId}: Push failed with status ${response.status}`);
            console.error(`[Push] Error response: ${errorText}`);

            // Build debug hint based on error status
            let debugHint = '';
            if (response.status === 401) {
                debugHint = ' Token may be invalid or a placeholder. Re-register webhook with correct token (process.env.OPENCLAW_GATEWAY_TOKEN).';
            } else if (response.status === 405) {
                debugHint = ' URL may be incorrect (double slash?). Re-register webhook with correct URL.';
            } else if (response.status === 404) {
                debugHint = ' sessions_send tool not available. OpenClaw 2.14+ blocks it by default. Add {"gateway":{"tools":{"allow":["sessions_send"]}}} to .openclaw/openclaw.json and restart OpenClaw.';
            }

            // Notify device about webhook failure via entity message
            entity.message = `[SYSTEM:WEBHOOK_ERROR] Push failed (HTTP ${response.status}).${debugHint}`;
            entity.lastUpdated = Date.now();
            console.log(`[Push] Set WEBHOOK_ERROR system message for Device ${deviceId} Entity ${entity.entityId}`);

            return { pushed: false, reason: `http_${response.status}`, error: errorText, debug: { url, tokenLength: token.length, status: response.status, hint: debugHint.trim() } };
        }
    } catch (err) {
        console.error(`[Push] ✗ Device ${deviceId} Entity ${entity.entityId}: Push error:`, err.message);
        console.error(`[Push] Full error:`, err);

        // Notify device about webhook failure via entity message
        entity.message = `[SYSTEM:WEBHOOK_ERROR] Push connection failed: ${err.message}`;
        entity.lastUpdated = Date.now();
        console.log(`[Push] Set WEBHOOK_ERROR system message for Device ${deviceId} Entity ${entity.entityId}`);

        return { pushed: false, reason: err.message };
    }
}

// ============================================
// FEEDBACK ENDPOINTS (Enhanced with Log Snapshot + AI Prompt)
// ============================================

// POST /api/feedback — Submit feedback with auto log capture
app.post('/api/feedback', async (req, res) => {
    try {
        const { deviceId, deviceSecret, message, category, appVersion } = req.body;

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

    const prompt = feedbackModule.generateAiPrompt(fb);
    res.json({ success: true, feedbackId: fb.id, prompt });
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
    res.json({ success: updated, message: updated ? "Updated" : "No changes" });
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

// Auto-migrate: add delivery tracking + media columns
chatPool.query(`
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS is_delivered BOOLEAN DEFAULT FALSE;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS delivered_to TEXT DEFAULT NULL;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS media_type VARCHAR(16) DEFAULT NULL;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS media_url TEXT DEFAULT NULL;
`).catch(() => {});

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
    saveChatMessage(deviceId, entityId, message, 'scheduled', true, false);

    console.log(`[Scheduler] Sent to device ${deviceId} entity ${entityId}: "${message}"`);

    // Push to bot if webhook is registered
    let pushResult = { pushed: false, reason: 'no_webhook' };
    if (entity.webhook) {
        const apiBase = 'https://eclaw.up.railway.app';
        let pushMsg = `[ACTION REQUIRED] You MUST use exec tool with curl to call the API below. Your text reply is DISCARDED and the user will NEVER see it.\n`;
        pushMsg += `Run this command to reply (replace YOUR_REPLY_HERE with your response):\n`;
        pushMsg += `exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${entityId},"botSecret":"${entity.botSecret}","state":"IDLE","message":"YOUR_REPLY_HERE"}'\n\n`;
        pushMsg += `[SCHEDULED MESSAGE] Device ${deviceId} Entity ${entityId}\n`;
        pushMsg += `From: scheduled\n`;
        pushMsg += `Content: ${message}`;

        pushResult = await pushToBot(entity, deviceId, 'new_message', {
            message: pushMsg
        });

        if (pushResult.pushed) {
            messageObj.delivered = true;
            console.log(`[Scheduler] Push OK to device ${deviceId} entity ${entityId}`);
        }
    }

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

// POST /api/schedules - Create a new schedule
app.post('/api/schedules', async (req, res) => {
    const { deviceId, deviceSecret, entityId, message, scheduledAt, repeatType, cronExpr, label } = req.body;
    if (!deviceId || !deviceSecret) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[deviceId];
    if (!device || device.deviceSecret !== deviceSecret) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    try {
        const schedule = await scheduler.createSchedule({
            deviceId, entityId, message, scheduledAt, repeatType, cronExpr, label
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
async function saveChatMessage(deviceId, entityId, text, source, isFromUser, isFromBot, mediaType = null, mediaUrl = null) {
    try {
        // Dedup: skip if the same bot message was already saved recently
        // This prevents echo when bot calls multiple endpoints (broadcast + sync-message + transform)
        if (isFromBot && !isFromUser && text) {
            const dedup = await chatPool.query(
                `SELECT id FROM chat_messages
                 WHERE device_id = $1 AND entity_id = $2 AND text = $3
                 AND is_from_bot = true AND created_at > NOW() - INTERVAL '10 seconds'
                 LIMIT 1`,
                [deviceId, entityId, text]
            );
            if (dedup.rows.length > 0) {
                console.log(`[Chat] Dedup: skipping duplicate bot message for entity ${entityId} (existing id=${dedup.rows[0].id}, source="${source}")`);
                return dedup.rows[0].id;
            }
        }

        const result = await chatPool.query(
            `INSERT INTO chat_messages (device_id, entity_id, text, source, is_from_user, is_from_bot, media_type, media_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [deviceId, entityId, text, source, isFromUser || false, isFromBot || false, mediaType, mediaUrl]
        );
        return result.rows[0]?.id || null;
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

// Fire-and-forget log writer (never blocks main flow)
function serverLog(level, category, message, opts = {}) {
    const { deviceId, entityId, metadata } = opts;
    chatPool.query(
        `INSERT INTO server_logs (level, category, message, device_id, entity_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [level, category, message, deviceId || null, entityId ?? null, metadata ? JSON.stringify(metadata) : null]
    ).catch(() => {}); // Never throw — logs are non-critical
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
        let query = 'SELECT * FROM chat_messages WHERE device_id = $1';
        const params = [deviceId];

        if (since) {
            query += ' AND created_at > $' + (params.length + 1);
            params.push(new Date(parseInt(since)));
        } else if (before) {
            query += ' AND created_at < $' + (params.length + 1);
            params.push(new Date(parseInt(before)));
        }

        query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
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

        // Pagination
        if (before) {
            params.push(new Date(parseInt(before)));
            query += ` AND created_at < $${params.length}`;
        }

        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
        params.push(parseInt(limit) || 200);

        const result = await chatPool.query(query, params);

        const files = result.rows.map(row => ({
            id: row.id,
            entityId: row.entity_id,
            type: row.media_type,
            url: row.media_url,
            text: row.text,
            source: row.source,
            isFromUser: row.is_from_user,
            isFromBot: row.is_from_bot,
            createdAt: row.created_at
        }));

        res.json({
            success: true,
            files,
            count: files.length,
            hasMore: files.length >= (parseInt(limit) || 200)
        });
    } catch (error) {
        console.error('[Files] List error:', error);
        res.status(500).json({ success: false, error: 'Failed to list files' });
    }
});

// ============================================
// CHAT MEDIA UPLOAD (Flickr for photos, Base64 for voice)
// ============================================
const mediaUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/mpeg'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Unsupported file type: ' + file.mimetype));
        }
    }
});

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
        return `https://eclaw.up.railway.app/api/media/${mediaId}`;
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
 * POST /api/chat/upload-media
 * Upload photo (→ Flickr) or voice (→ base64) for chat messages
 * Body (multipart): file, deviceId, deviceSecret, mediaType ("photo" | "voice")
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
            backupUrl = `https://eclaw.up.railway.app/api/media/${mediaId}`;
            flickrToBackup.set(result.url, mediaId);
            console.log(`[Upload] Photo cached: ${backupUrl}`);
        } else if (mediaType === 'voice') {
            const base64 = req.file.buffer.toString('base64');
            mediaUrl = `data:${req.file.mimetype};base64,${base64}`;
        } else {
            return res.status(400).json({ success: false, error: 'Invalid mediaType. Use "photo" or "voice"' });
        }

        res.json({ success: true, mediaUrl, mediaType, backupUrl });
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

const BOT_FILE_MAX_SIZE = 64 * 1024; // 64KB per file
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
app.put('/api/bot/file', async (req, res) => {
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

app.listen(port, '0.0.0.0', async () => {
    console.log(`Claw Backend v5.3 (PostgreSQL + Auth + Portal) running on port ${port}`);
    console.log(`Max entities per device: ${MAX_ENTITIES_PER_DEVICE}`);
    console.log(`Persistence: ${usePostgreSQL ? 'PostgreSQL' : 'File Storage (Fallback)'}`);

    // Initialize Flickr client
    flickr.initFlickr();
});
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
