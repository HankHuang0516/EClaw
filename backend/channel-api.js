const safeEqual = require('./safe-equal');
const mentionParser = require('./mention-parser');
const bcrypt = require('bcrypt');

/**
 * Channel API Module — OpenClaw Channel Plugin Integration
 *
 * Mounted at: /api/channel
 *
 * Endpoints:
 * POST   /provision    - User generates channel API key for their device (JWT auth)
 * POST   /register     - Plugin registers callback URL (apiKey + apiSecret auth)
 * DELETE /register     - Plugin unregisters callback
 * POST   /bind         - Plugin binds an entity (bypasses 6-digit code)
 * POST   /message      - Plugin sends bot reply to user (apiKey + botSecret auth)
 *
 * This module enables E-Claw to act as a native channel provider in the OpenClaw
 * ecosystem, alongside Telegram, Discord, Slack, etc.
 */

const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const { URL } = require('url');
const dnsLookup = require('util').promisify(require('dns').lookup);
const { enrichContext, materializeChannelText } = require('./push-context');
const { scanReferences, buildReferencesBlock } = require('./reference-parser');
const { resolveReferences } = require('./reference-resolver');

// ── SSRF protection: reject private/internal callback URLs ──
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

function isPrivateHost(hostname) {
    if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1') return true;
    if (hostname === '127.0.0.1' || hostname.startsWith('10.') || hostname.startsWith('192.168.')) return true;
    const m172 = hostname.match(/^172\.(\d+)\./);
    if (m172 && +m172[1] >= 16 && +m172[1] <= 31) return true;
    if (hostname.startsWith('169.254.')) return true;
    return false;
}

async function assertPublicCallbackUrl(callbackUrl) {
    let parsed;
    try {
        parsed = new URL(callbackUrl);
    } catch {
        throw new Error('Invalid callback URL');
    }
    const hostname = parsed.hostname;
    if (isPrivateHost(hostname)) throw new Error('callback_url must not point to a private/internal address');
    const { address } = await dnsLookup(hostname);
    if (isPrivateIp(address)) throw new Error('callback_url must not resolve to a private/internal IP');
}

module.exports = function (devices, { authMiddleware, serverLog, generateBotSecret, generatePublicCode, publicCodeIndex, saveChatMessage, io, saveData, createDefaultEntity, apiBase, awardEntityXP, XP_AMOUNTS, notifyDevice, deliverToEntity, gatekeeperCheckText, resolveSpeakToTarget, checkBotToBotRateLimit, checkCrossSpeakRateLimit, crossDeviceSettings, devicePrefs, recentBroadcasts: _recentBroadcasts, BOT2BOT_MAX_MESSAGES: _BOT2BOT_MAX_MESSAGES, db: dbRef, getMissionApiHints, buildIdentitySetupHint, buildBroadcastRecipientBlock, chatPool }) {
    const pushContextHelpers = { getMissionApiHints, buildIdentitySetupHint, buildBroadcastRecipientBlock };
    // Late-bound kanban auto-review hook (set after kanbanModule init)
    let kanbanAutoReview = null;
    function setKanbanAutoReview(fn) { kanbanAutoReview = fn; }

    // Late-bound org chart forward hook (set after orgChartForward defined in index.js)
    let orgChartForwardFn = null;
    function setOrgChartForward(fn) { orgChartForwardFn = fn; }
    const router = express.Router();

    // ── In-memory test sink (for self-testing without ngrok) ──
    // { slotId: [{ token, receivedAt, payload }, ...] }
    const testSinkStore = {};

    // ── Auth helper: validate deviceId + deviceSecret ──
    function deviceAuth(req, res) {
        const deviceId = req.body?.deviceId || req.query?.deviceId;
        const deviceSecret = req.body?.deviceSecret || req.query?.deviceSecret;
        if (!deviceId || !deviceSecret) {
            res.status(401).json({ success: false, message: 'deviceId and deviceSecret required' });
            return null;
        }
        const device = devices[deviceId];
        if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
            res.status(403).json({ success: false, message: 'Invalid device credentials' });
            return null;
        }
        return { deviceId, device };
    }

    // ── Auth helper: validate channel API key (secret optional for backward compat) ──
    async function channelAuth(req, res) {
        const apiKey = req.body.channel_api_key || req.headers['x-channel-api-key'];
        const apiSecret = req.body.channel_api_secret || req.headers['x-channel-api-secret'];

        if (!apiKey) {
            res.status(401).json({ success: false, message: 'channel_api_key required' });
            return null;
        }

        const account = await db.getChannelAccountByKey(apiKey);
        if (!account) {
            res.status(403).json({ success: false, message: 'Invalid channel_api_key' });
            return null;
        }

        // If secret provided, validate it (backward compat with old clients)
        if (apiSecret && !safeEqual(account.channel_api_secret, apiSecret)) {
            res.status(403).json({ success: false, message: 'Invalid channel credentials' });
            return null;
        }

        return account;
    }

    // ============================================
    // GET /provision — List all channel accounts for device
    // ============================================
    router.get('/provision', authMiddleware, async (req, res) => {
        try {
            const deviceId = req.query.deviceId || req.user?.deviceId;
            if (!deviceId) {
                return res.status(400).json({ success: false, message: 'deviceId required' });
            }

            const accounts = await db.getChannelAccountsByDevice(deviceId);
            res.json({
                success: true,
                accounts: accounts.map(a => ({
                    id: a.id,
                    channel_api_key: a.channel_api_key,
                    has_callback: !!a.callback_url,
                    e2ee_capable: !!a.e2ee_capable,
                    status: a.status,
                    created_at: a.created_at
                }))
            });
        } catch (err) {
            console.error('[Channel] List accounts error:', err.message);
            res.status(500).json({ success: false, message: 'Internal error' });
        }
    });

    // ============================================
    // POST /provision — User generates a new channel API key
    // Multiple accounts per device are allowed (one per plugin)
    // ============================================
    router.post('/provision', authMiddleware, async (req, res) => {
        try {
            const deviceId = req.body.deviceId || req.user?.deviceId;
            if (!deviceId) {
                return res.status(400).json({ success: false, message: 'deviceId required' });
            }

            const device = devices[deviceId];
            if (!device) {
                return res.status(404).json({ success: false, message: 'Device not found' });
            }

            // Generate new prefixed API key pair
            const apiKey = 'eck_' + crypto.randomBytes(32).toString('hex');
            const apiSecret = 'ecs_' + crypto.randomBytes(32).toString('hex');

            const account = await db.createChannelAccount(deviceId, apiKey, apiSecret);
            if (!account) {
                return res.status(500).json({ success: false, message: 'Failed to create channel account' });
            }

            serverLog('info', 'channel', `Channel account provisioned (id=${account.id})`, { deviceId });

            // Notify all connected clients for this device
            io.to(deviceId).emit('channelAccountsUpdated');

            res.json({
                success: true,
                id: account.id,
                channel_api_key: apiKey,
                channel_api_secret: apiSecret,
                instructions: 'Add these to your OpenClaw config under channels.eclaw.accounts.<name>'
            });
        } catch (err) {
            console.error('[Channel] Provision error:', err.message);
            res.status(500).json({ success: false, message: 'Internal error' });
        }
    });

    // ============================================
    // DELETE /account/:id — Revoke a channel account
    // ============================================
    router.delete('/account/:id', authMiddleware, async (req, res) => {
        try {
            const deviceId = req.body.deviceId || req.user?.deviceId;
            const accountId = parseInt(req.params.id);
            if (!deviceId || isNaN(accountId)) {
                return res.status(400).json({ success: false, message: 'deviceId and valid account id required' });
            }

            const account = await db.getChannelAccountById(accountId);
            if (!account || account.device_id !== deviceId) {
                return res.status(404).json({ success: false, message: 'Channel account not found' });
            }

            // Unbind any entities still linked to this account
            const device = devices[deviceId];
            if (device) {
                for (const eid of Object.keys(device.entities).map(Number)) {
                    const entity = device.entities[eid];
                    if (entity && entity.channelAccountId === accountId) {
                        entity.isBound = false;
                        entity.botSecret = null;
                        entity.publicCode = null;
                        entity.bindingType = null;
                        entity.channelAccountId = null;
                        entity.state = 'IDLE';
                        entity.message = null;
                        serverLog('info', 'unbind', `Entity ${eid} unbound (channel account ${accountId} revoked)`, { deviceId, entityId: eid });
                    }
                }
                saveData();
            }

            await db.deleteChannelAccount(accountId);
            serverLog('info', 'channel', `Channel account ${accountId} revoked`, { deviceId });

            // Notify all connected clients for this device
            io.to(deviceId).emit('channelAccountsUpdated');

            res.json({ success: true });
        } catch (err) {
            console.error('[Channel] Delete account error:', err.message);
            res.status(500).json({ success: false, message: 'Internal error' });
        }
    });

    // ============================================
    // POST /provision-device — Provision channel account using device credentials
    // (For automation / testing — no JWT required)
    // ============================================
    router.post('/provision-device', async (req, res) => {
        try {
            const auth = deviceAuth(req, res);
            if (!auth) return;
            const { deviceId } = auth;

            const apiKey = 'eck_' + crypto.randomBytes(32).toString('hex');
            const apiSecret = 'ecs_' + crypto.randomBytes(32).toString('hex');

            // Ensure device exists in PostgreSQL (FK constraint on channel_accounts.device_id)
            // Device may only exist in memory if /device/register was called without any subsequent bind
            if (devices[deviceId]) {
                await db.saveDeviceData(deviceId, devices[deviceId]);
            }

            const account = await db.createChannelAccount(deviceId, apiKey, apiSecret);
            if (!account) {
                return res.status(500).json({ success: false, message: 'Failed to create channel account' });
            }

            serverLog('info', 'channel', `Channel account provisioned via device auth (id=${account.id})`, { deviceId });

            res.json({
                success: true,
                id: account.id,
                channel_api_key: apiKey,
                channel_api_secret: apiSecret
            });
        } catch (err) {
            console.error('[Channel] Provision-device error:', err.message);
            res.status(500).json({ success: false, message: 'Internal error' });
        }
    });

    // ============================================
    // POST /test-sink — Callback receiver for self-testing (no ngrok needed)
    // The server calls this URL when it would push to a channel plugin.
    // Query param: ?slot=<slotId>  —  groups payloads by test slot
    // Auth: Bearer {callback_token} in Authorization header
    // ============================================
    router.post('/test-sink', (req, res) => {
        const slot = req.query.slot || 'default';
        const _expectedToken = req.query.token; // token embedded in callback_url for retrieval
        const authHeader = req.headers.authorization || '';
        const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

        if (!testSinkStore[slot]) testSinkStore[slot] = [];
        testSinkStore[slot].push({
            receivedAt: Date.now(),
            bearerToken,
            payload: req.body
        });

        // Keep only last 20 per slot
        if (testSinkStore[slot].length > 20) {
            testSinkStore[slot] = testSinkStore[slot].slice(-20);
        }

        res.json({ success: true, slot, count: testSinkStore[slot].length });
    });

    // GET /test-sink — Retrieve stored payloads (auth: deviceId + deviceSecret)
    router.get('/test-sink', (req, res) => {
        const auth = deviceAuth(req, res);
        if (!auth) return;

        const slot = req.query.slot || 'default';
        res.json({
            success: true,
            slot,
            payloads: testSinkStore[slot] || []
        });
    });

    // DELETE /test-sink — Clear stored payloads (auth: deviceId + deviceSecret)
    router.delete('/test-sink', (req, res) => {
        const auth = deviceAuth(req, res);
        if (!auth) return;

        const slot = req.query.slot || 'default';
        testSinkStore[slot] = [];
        res.json({ success: true, slot, cleared: true });
    });

    // ============================================
    // POST /register — Plugin registers callback URL
    // ============================================
    router.post('/register', async (req, res) => {
        try {
            if (process.env.DEBUG === 'true') console.log('[BIND] /register called, apiKey prefix:', (req.body.channel_api_key || '').slice(0, 12));
            const account = await channelAuth(req, res);
            if (!account) return;

            let { callback_url, callback_token, callback_username, callback_password, e2ee_capable } = req.body;
            if (!callback_url) {
                return res.status(400).json({ success: false, message: 'callback_url required' });
            }

            // Auto-upgrade HTTP to HTTPS for non-localhost URLs to avoid
            // 301/302 redirects that convert POST→GET and lose the request body
            if (callback_url.startsWith('http://') && !callback_url.includes('localhost') && !callback_url.includes('127.0.0.1')) {
                callback_url = callback_url.replace('http://', 'https://');
            }

            // SSRF protection: reject private/internal callback URLs
            try {
                await assertPublicCallbackUrl(callback_url);
            } catch (e) {
                return res.status(400).json({ success: false, message: e.message });
            }

            if (process.env.DEBUG === 'true') serverLog('info', 'bind', `[BIND] /register callback_url=${callback_url}`, { deviceId: account.device_id });

            await db.updateChannelCallback(account.channel_api_key, callback_url, callback_token || null, callback_username || null, callback_password || null);

            // E2EE awareness (Issue #212): persist channel encryption capability
            if (e2ee_capable !== undefined) {
                await db.updateChannelE2eeCapable(account.id, !!e2ee_capable);
                // Propagate to all entities bound to this channel account
                const device = devices[account.device_id];
                if (device) {
                    const newStatus = e2ee_capable ? 'e2ee' : 'transport';
                    for (const eid of Object.keys(device.entities).map(Number)) {
                        const e = device.entities[eid];
                        if (e && e.channelAccountId === account.id) {
                            e.encryptionStatus = newStatus;
                        }
                    }
                    saveData();
                }
            }

            const device = devices[account.device_id];
            const entities = [];
            if (device) {
                for (const eid of Object.keys(device.entities).map(Number)) {
                    const e = device.entities[eid];
                    entities.push({
                        entityId: eid,
                        isBound: e.isBound || false,
                        name: e.name || null,
                        character: e.character,
                        bindingType: e.bindingType || null,
                        // true if this entity is bound to this specific channel account
                        boundToThisAccount: e.channelAccountId === account.id
                    });
                }
            }

            const entitySummary = entities.map(e => `${e.entityId}(bound=${e.isBound},mine=${e.boundToThisAccount})`).join(', ');
            if (process.env.DEBUG === 'true') serverLog('info', 'bind', `[BIND] /register OK, entities: ${entitySummary}`, { deviceId: account.device_id });

            serverLog('info', 'channel', `Callback registered: ${callback_url}`, { deviceId: account.device_id });

            res.json({
                success: true,
                deviceId: account.device_id,
                accountId: account.id,
                entities,
                totalEntities: Object.keys(device?.entities || {}).length
            });
        } catch (err) {
            console.error('[Channel] Register error:', err.message);
            res.status(500).json({ success: false, message: 'Internal error' });
        }
    });

    // ============================================
    // DELETE /register — Plugin unregisters callback
    // ============================================
    router.delete('/register', async (req, res) => {
        try {
            const account = await channelAuth(req, res);
            if (!account) return;

            await db.clearChannelCallback(account.channel_api_key);
            serverLog('info', 'channel', `Callback unregistered`, { deviceId: account.device_id });

            res.json({ success: true });
        } catch (err) {
            console.error('[Channel] Unregister error:', err.message);
            res.status(500).json({ success: false, message: 'Internal error' });
        }
    });

    // ============================================
    // POST /bind — Plugin binds an entity
    // If entityId is omitted, auto-selects the first free slot.
    // If all slots are full, returns 409 with entity list so the plugin can guide the user.
    // ============================================
    router.post('/bind', async (req, res) => {
        try {
            if (process.env.DEBUG === 'true') console.log('[BIND] /channel/bind called, apiKey prefix:', (req.body.channel_api_key || '').slice(0, 12), 'entityId:', req.body.entityId);
            const account = await channelAuth(req, res);
            if (!account) return;

            if (process.env.DEBUG === 'true') serverLog('info', 'bind', `[BIND] auth OK, accountId=${account.id}`, { deviceId: account.device_id });

            const { name } = req.body;
            const rawEntityId = req.body.entityId;

            if (name && name.length > 20) {
                return res.status(400).json({ success: false, message: 'Name must be 20 characters or less' });
            }

            const deviceId = account.device_id;
            const device = devices[deviceId];
            if (!device) {
                if (process.env.DEBUG === 'true') serverLog('warn', 'bind', `[BIND] device not found: ${deviceId}`, { deviceId });
                return res.status(404).json({ success: false, message: 'Device not found' });
            }

            let eId;
            if (rawEntityId !== undefined && rawEntityId !== null) {
                // Explicit entityId specified
                eId = parseInt(rawEntityId);
                if (isNaN(eId) || eId < 0 || !device.entities.hasOwnProperty(eId)) {
                    if (process.env.DEBUG === 'true') serverLog('warn', 'bind', `[BIND] invalid entityId: ${rawEntityId}, existing=[${Object.keys(device.entities)}]`, { deviceId });
                    return res.status(400).json({ success: false, message: `entityId ${rawEntityId} does not exist on this device. Available: [${Object.keys(device.entities)}]` });
                }
                if (process.env.DEBUG === 'true') serverLog('info', 'bind', `[BIND] using explicit entityId=${eId}`, { deviceId, entityId: eId });
            } else {
                // Auto-select: first slot bound to this channel account (reconnect), else first free slot
                eId = null;
                const slotKeys = Object.keys(device.entities).map(Number).sort();
                // Prefer reconnecting to the same account's existing slot
                for (const i of slotKeys) {
                    if (device.entities[i]?.isBound && device.entities[i]?.channelAccountId === account.id) {
                        eId = i;
                        if (process.env.DEBUG === 'true') serverLog('info', 'bind', `[BIND] auto-selected slot ${eId} (reconnect same account)`, { deviceId, entityId: eId });
                        break;
                    }
                }
                // Fallback: first unbound slot
                if (eId === null) {
                    for (const i of slotKeys) {
                        if (device.entities[i] && !device.entities[i].isBound) {
                            eId = i;
                            if (process.env.DEBUG === 'true') serverLog('info', 'bind', `[BIND] auto-selected slot ${eId} (first free)`, { deviceId, entityId: eId });
                            break;
                        }
                    }
                }
                // All slots full — auto-create a new empty slot (dynamic entity system)
                if (eId === null) {
                    if (!device.nextEntityId) {
                        device.nextEntityId = Math.max(-1, ...Object.keys(device.entities).map(Number)) + 1;
                    }
                    eId = device.nextEntityId++;
                    device.entities[eId] = createDefaultEntity(eId);
                    console.log(`[DynamicEntity] Channel auto-expand: deviceId=${deviceId}, newEntityId=${eId}, totalSlots=${Object.keys(device.entities).length}`);
                    if (process.env.DEBUG === 'true') serverLog('info', 'bind', `[BIND] auto-created new slot ${eId} (all existing slots full)`, { deviceId, entityId: eId });
                }
            }

            const entity = device.entities[eId];
            if (!entity) {
                if (process.env.DEBUG === 'true') serverLog('warn', 'bind', `[BIND] entity slot ${eId} not found`, { deviceId, entityId: eId });
                return res.status(400).json({ success: false, message: `Entity slot ${eId} not available` });
            }

            if (process.env.DEBUG === 'true') serverLog('info', 'bind', `[BIND] entity ${eId} state: isBound=${entity.isBound}, bindingType=${entity.bindingType}, channelAccountId=${entity.channelAccountId}`, { deviceId, entityId: eId });

            // If already bound via channel
            if (entity.isBound && entity.bindingType === 'channel') {
                if (entity.channelAccountId === account.id) {
                    // Same plugin — return existing credentials (idempotent)
                    if (process.env.DEBUG === 'true') serverLog('info', 'bind', `[BIND] entity ${eId} already bound to this account (idempotent), reconnecting`, { deviceId, entityId: eId });
                    return res.json({
                        success: true,
                        message: 'Entity already bound via channel',
                        deviceId,
                        entityId: eId,
                        botSecret: entity.botSecret,
                        publicCode: entity.publicCode,
                        bindingType: 'channel'
                    });
                } else {
                    // Different plugin already owns this entity
                    if (process.env.DEBUG === 'true') serverLog('warn', 'bind', `[BIND] entity ${eId} owned by different channelAccountId=${entity.channelAccountId}, rejecting`, { deviceId, entityId: eId });
                    return res.status(409).json({
                        success: false,
                        message: 'Entity already bound by a different channel account. Unbind first via DELETE /api/entity/:entityId'
                    });
                }
            }

            // Don't allow binding over an existing non-channel binding
            if (entity.isBound) {
                if (process.env.DEBUG === 'true') serverLog('warn', 'bind', `[BIND] entity ${eId} bound via non-channel method (bindingType=${entity.bindingType}), rejecting`, { deviceId, entityId: eId });
                return res.status(409).json({
                    success: false,
                    message: 'Entity already bound. Unbind first via DELETE /api/entity/:entityId'
                });
            }

            // Bind the entity
            if (process.env.DEBUG === 'true') serverLog('info', 'bind', `[BIND] binding entity ${eId} via channel, name="${name || ''}"`, { deviceId, entityId: eId });
            const botSecret = generateBotSecret();
            const publicCode = generatePublicCode();

            entity.isBound = true;
            entity.botSecret = botSecret;
            entity.publicCode = publicCode;
            entity.bindingType = 'channel';
            entity.channelAccountId = account.id;
            entity.encryptionStatus = account.e2ee_capable ? 'e2ee' : 'transport';
            publicCodeIndex[publicCode] = { deviceId, entityId: eId };
            entity.name = name || null;
            entity.state = 'IDLE';
            entity.message = 'Connected via OpenClaw channel!';
            entity.lastUpdated = Date.now();

            // Dynamic entity auto-expand after channel bind
            const hasEmpty = Object.values(device.entities).some(e => !e.isBound);
            let newChannelSlot = null;
            if (!hasEmpty) {
                if (!device.nextEntityId) {
                    device.nextEntityId = Math.max(-1, ...Object.keys(device.entities).map(Number)) + 1;
                }
                newChannelSlot = device.nextEntityId++;
                device.entities[newChannelSlot] = createDefaultEntity(newChannelSlot);
                console.log(`[DynamicEntity] Channel auto-expand after bind: deviceId=${deviceId}, newSlotId=${newChannelSlot}, totalSlots=${Object.keys(device.entities).length}`);
            }

            saveData();

            if (newChannelSlot !== null) {
                io.to(deviceId).emit('entityAdded', { entityId: newChannelSlot, totalSlots: Object.keys(device.entities).length });
            }
            serverLog('info', 'bind', `Entity ${eId} bound via channel plugin`, { deviceId, entityId: eId });
            if (process.env.DEBUG === 'true') serverLog('info', 'bind', `[BIND] entity ${eId} bound OK, publicCode=${publicCode}`, { deviceId, entityId: eId });

            // Send ECLAW_READY init push so bot gets credentials immediately
            // (fire-and-forget; don't block response if push fails)
            const initText = [
                '[SYSTEM:ECLAW_READY] E-Claw channel binding established.',
                `deviceId: ${deviceId} | entityId: ${eId} | botSecret: ${botSecret}`,
                '',
                '[AVAILABLE TOOLS — Mission Dashboard]',
                `Read tasks/notes/rules/skills: exec: curl -s "${apiBase}/api/mission/dashboard?deviceId=${deviceId}&botSecret=${botSecret}&entityId=${eId}"`,
                `Read notes: exec: curl -s "${apiBase}/api/mission/notes?deviceId=${deviceId}&botSecret=${botSecret}&entityId=${eId}"`,
                `Read chat history (scope: msgs to/from your entityId only — NOT full device transcript): exec: curl -s "${apiBase}/api/chat/history?deviceId=${deviceId}&botSecret=${botSecret}&entityId=${eId}&limit=100"`,
                `Create kanban card: exec: curl -s -X POST "${apiBase}/api/mission/card" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${eId},"botSecret":"${botSecret}","title":"TASK_TITLE","status":"todo"}'`,
                `Add note: exec: curl -s -X POST "${apiBase}/api/mission/note/add" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${eId},"botSecret":"${botSecret}","title":"TITLE","content":"CONTENT"}'`,
                `Update wallpaper: exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${eId},"botSecret":"${botSecret}","state":"IDLE","message":"hello"}'`
            ].join('\n');

            pushToChannelCallback(deviceId, eId, {
                event: 'message',
                from: 'system',
                text: initText
            }, account.id).catch(err => {
                if (process.env.DEBUG === 'true') serverLog('warn', 'bind', `[BIND] ECLAW_READY push failed: ${err.message}`, { deviceId, entityId: eId });
            });

            res.json({
                success: true,
                deviceId,
                entityId: eId,
                botSecret,
                publicCode,
                bindingType: 'channel'
            });
        } catch (err) {
            console.error('[Channel] Bind error:', err.message);
            res.status(500).json({ success: false, message: 'Internal error' });
        }
    });

    // ============================================
    // POST /message — Plugin sends bot reply to user
    // ============================================
    router.post('/message', async (req, res) => {
        try {
            const { channel_api_key, deviceId, entityId, botSecret, message, state, mediaType, mediaUrl, targetDeviceId, card, senderHint, aboutCardId } = req.body;
            let { speakTo, broadcast } = req.body;

            if (process.env.DEBUG === 'true') serverLog('info', 'client_push', `[PUSH] /channel/message called, state=${state}, hasMsg=${!!message}`, { deviceId, entityId: entityId !== undefined ? parseInt(entityId) : 'auto' });

            // Validate optional senderHint — bridges pass this so the server resolves
            // routing centrally instead of each bridge implementing its own logic.
            // Same shape and precedence as /api/transform (issue #2285): explicit
            // speakTo/broadcast win, senderHint is the lowest-precedence fallback.
            if (senderHint !== undefined && senderHint !== null) {
                if (typeof senderHint !== 'object' || Array.isArray(senderHint)) {
                    return res.status(400).json({ success: false, message: 'senderHint must be an object' });
                }
                const allowedKinds = new Set(['entity', 'user', 'broadcast', 'unknown']);
                if (senderHint.kind && !allowedKinds.has(senderHint.kind)) {
                    return res.status(400).json({
                        success: false,
                        message: `senderHint.kind must be one of: ${[...allowedKinds].join(', ')}`
                    });
                }
            }

            if (!channel_api_key || !deviceId || !botSecret) {
                if (process.env.DEBUG === 'true') serverLog('warn', 'client_push', `[PUSH] /channel/message missing required fields`, { deviceId });
                return res.status(400).json({
                    success: false,
                    message: 'channel_api_key, deviceId, and botSecret required'
                });
            }

            // Verify channel API key exists
            const account = await db.getChannelAccountByKey(channel_api_key);
            if (!account) {
                return res.status(403).json({ success: false, message: 'Invalid channel API key' });
            }

            // Validate optional rich card payload (backward compatible — card is always optional)
            // Mirrors the validation in POST /api/transform so both bot-auth paths behave identically.
            let validatedCard = null;
            if (card !== undefined && card !== null) {
                if (typeof card !== 'object' || Array.isArray(card)) {
                    return res.status(400).json({ success: false, message: 'card must be an object' });
                }
                if (!Array.isArray(card.buttons) || card.buttons.length === 0) {
                    return res.status(400).json({ success: false, message: 'card.buttons must be a non-empty array' });
                }
                if (card.buttons.length > 10) {
                    return res.status(400).json({ success: false, message: 'card.buttons max 10' });
                }
                const allowedStyles = new Set(['primary', 'secondary', 'danger']);
                const sanitizedButtons = [];
                const seenIds = new Set();
                for (const btn of card.buttons) {
                    if (!btn || typeof btn !== 'object') {
                        return res.status(400).json({ success: false, message: 'each card button must be an object' });
                    }
                    const id = String(btn.id || '').trim();
                    const label = String(btn.label || '').trim();
                    if (!id || !label) {
                        return res.status(400).json({ success: false, message: 'card button requires id and label' });
                    }
                    if (id.length > 64 || label.length > 80) {
                        return res.status(400).json({ success: false, message: 'card button id/label too long' });
                    }
                    if (seenIds.has(id)) {
                        return res.status(400).json({ success: false, message: `duplicate card button id: ${id}` });
                    }
                    seenIds.add(id);
                    const style = allowedStyles.has(btn.style) ? btn.style : 'secondary';
                    sanitizedButtons.push({ id, label, style });
                }
                const askId = card.ask_id ? String(card.ask_id).slice(0, 128) : require('crypto').randomUUID();
                validatedCard = { ask_id: askId, buttons: sanitizedButtons };
            }

            const device = devices[deviceId];
            if (!device) {
                return res.status(404).json({ success: false, message: 'Device not found' });
            }

            // Resolve entityId: auto-detect from botSecret if not provided
            let eId;
            let entityIdCorrected = false;
            if (entityId === undefined || entityId === null) {
                eId = Object.keys(device.entities).map(Number)
                    .find(i => device.entities[i]?.isBound && device.entities[i].botSecret && safeEqual(device.entities[i].botSecret, botSecret));
                if (eId === undefined) {
                    return res.status(403).json({ success: false, message: 'Invalid botSecret — no matching entity found' });
                }
            } else {
                const requestedId = parseInt(entityId) || 0;
                const requestedEntity = device.entities[requestedId];
                if (requestedEntity && requestedEntity.isBound && requestedEntity.botSecret && safeEqual(requestedEntity.botSecret, botSecret)) {
                    eId = requestedId;
                } else {
                    const correctId = Object.keys(device.entities).map(Number)
                        .find(i => device.entities[i]?.isBound && device.entities[i].botSecret && safeEqual(device.entities[i].botSecret, botSecret));
                    if (correctId === undefined) {
                        return res.status(403).json({ success: false, message: 'Invalid botSecret' });
                    }
                    eId = correctId;
                    entityIdCorrected = true;
                }
            }

            const entity = device.entities[eId];

            // Update entity state
            const finalMessage = message || entity.message;
            if (state) entity.state = state;
            if (message) entity.message = message;
            entity.lastUpdated = Date.now();

            // ── @-mention auto-fill (PR #2300, parity with /api/transform) ──
            // /api/transform has had this since #1619 (2026-04-06). LLM channel
            // bridges (claude / codex / hermes) embed routing intent in text
            // (`@#6 hello`) but used to silently drop it here because this
            // endpoint was originally designed as a "thin pipe" relaying state.
            //
            // Same precedence as /api/transform: explicit speakTo / broadcast
            // wins, in-text @-mention fills next, senderHint is last.
            let transformMentionContext = null;
            if (message) {
                const tParse = mentionParser.parseMentions(message, {
                    senderDeviceId: deviceId,
                    devices,
                    publicCodeIndex
                });
                transformMentionContext = mentionParser.toContextPayload(tParse);
                if (transformMentionContext) {
                    if (tParse.hasAll && !broadcast && !(speakTo && speakTo.length > 0)) {
                        broadcast = true;
                    } else if (tParse.mentions.length > 0 && !broadcast && !(speakTo && speakTo.length > 0)) {
                        speakTo = tParse.mentions.map(m => m.publicCode);
                    }
                }
            }

            // ── senderHint resolution (channel-bridge centralization, issue #2285) ──
            // Lowest precedence — only fills speakTo/broadcast when neither was
            // explicitly set on the request body. Channel bridges pass senderHint
            // derived from the inbound payload's "from*" fields so the server
            // (not the bridge) decides where the bot's reply routes.
            let senderHintResolution = null;
            const noTargetYet = !broadcast && !(speakTo && Array.isArray(speakTo) && speakTo.length > 0);
            if (senderHint && noTargetYet && message) {
                const kind = senderHint.kind || 'unknown';
                if (kind === 'broadcast') {
                    broadcast = true;
                    senderHintResolution = { kind, applied: 'broadcast' };
                } else if (kind === 'entity') {
                    let resolvedCode = null;
                    if (senderHint.publicCode && typeof senderHint.publicCode === 'string') {
                        const code = senderHint.publicCode.trim();
                        if (publicCodeIndex && publicCodeIndex[code]) {
                            resolvedCode = code;
                        } else {
                            for (const i of Object.keys(device.entities).map(Number)) {
                                if (device.entities[i]?.publicCode === code) { resolvedCode = code; break; }
                            }
                        }
                    }
                    if (!resolvedCode && Number.isFinite(Number(senderHint.entityId))) {
                        const hintId = Number(senderHint.entityId);
                        const target = device.entities[hintId];
                        if (target && target.publicCode) resolvedCode = target.publicCode;
                    }
                    if (resolvedCode) {
                        speakTo = [resolvedCode];
                        senderHintResolution = { kind, applied: 'speakTo', publicCode: resolvedCode };
                    } else {
                        senderHintResolution = { kind, applied: 'none', reason: 'unresolved_sender' };
                    }
                } else {
                    senderHintResolution = { kind, applied: 'none' };
                }
            } else if (senderHint) {
                senderHintResolution = {
                    kind: senderHint.kind || 'unknown',
                    applied: 'none',
                    reason: noTargetYet ? 'no_message' : 'explicit_won'
                };
            }

            // Save to chat history
            // Check for pending cross-device context first, so local copy also shows routing direction
            const pendingCross = message ? (entity.messageQueue && entity.messageQueue.findLast(m => m.crossDevice)) : null;
            const hasCrossRoute = !!(pendingCross && pendingCross.fromDeviceId);
            // Skip silent tokens — internal signals should not appear in chat
            const isSilentMsg = message && /^\[SILENT\]$/i.test(message.trim());
            // Skip self chat save when speakTo/broadcast is present — deliverToEntity will save with routing source
            const hasDelivery = (broadcast || (speakTo && Array.isArray(speakTo) && speakTo.length > 0));
            if (message && !isSilentMsg) {
                if (!hasDelivery) {
                    // If replying to a cross-device message, tag local copy with routing info
                    const localSource = hasCrossRoute
                        ? `xdevice:${entity.publicCode}:${entity.character}->${pendingCross.fromPublicCode || pendingCross.fromDeviceId}`
                        : (entity.name || `Entity ${eId}`);
                    await saveChatMessage(deviceId, eId, message, localSource, false, true, mediaType || null, mediaUrl || null, null, null, null, null, validatedCard);
                }

                // XP: Award for channel bot reply (same logic as /api/transform)
                if (awardEntityXP && XP_AMOUNTS) {
                    const now = Date.now();
                    const replyXpCooldown = 30000; // 30 seconds
                    if (!entity._lastReplyXpAt || now - entity._lastReplyXpAt > replyXpCooldown) {
                        entity._lastReplyXpAt = now;
                        awardEntityXP(deviceId, eId, XP_AMOUNTS.BOT_REPLY, 'channel_bot_reply');
                    }
                }
            }

            // [CROSS-DEVICE ROUTING] — explicit targetDeviceId OR auto-route from pending cross-device message
            if (targetDeviceId && message) {
                // Explicit routing — bot specifies which device to route reply to
                const targetDev = devices[targetDeviceId];
                if (targetDev) {
                    const replySource = `xdevice:${entity.publicCode}:${entity.character}->${targetDeviceId}`;
                    await saveChatMessage(targetDeviceId, 0, message, replySource, false, true);
                    serverLog('info', 'cross_speak_push', `[EXPLICIT_ROUTE] Channel routed reply to ${targetDeviceId}`, {
                        deviceId, entityId: eId,
                        metadata: { targetDeviceId, fromPublicCode: entity.publicCode }
                    });
                    if (notifyDevice) {
                        notifyDevice(targetDeviceId, {
                            type: 'chat', category: 'cross_speak',
                            title: `${entity.name || entity.publicCode || `Entity ${eId}`} replied`,
                            body: (message || '').slice(0, 100),
                            link: 'chat.html',
                            metadata: { fromPublicCode: entity.publicCode, entityId: 0 }
                        }).catch(() => {});
                    }
                } else {
                    serverLog('warn', 'cross_speak_push', `[EXPLICIT_ROUTE] targetDeviceId ${targetDeviceId} not found`, { deviceId, entityId: eId });
                }
            } else if (hasCrossRoute) {
                const replySource = `xdevice:${entity.publicCode}:${entity.character}->${pendingCross.fromPublicCode || pendingCross.fromDeviceId}`;
                const senderEntityId = pendingCross.fromEntityId >= 0 ? pendingCross.fromEntityId : 0;
                await saveChatMessage(pendingCross.fromDeviceId, senderEntityId, message, replySource, false, true);
                serverLog('info', 'cross_speak_push', `[CROSS_ROUTE] Channel auto-routed reply to sender ${pendingCross.fromDeviceId}:${senderEntityId}`, {
                    deviceId, entityId: eId,
                    metadata: { senderDeviceId: pendingCross.fromDeviceId, senderEntityId, fromPublicCode: pendingCross.fromPublicCode }
                });

                // Notify sender device about the reply
                if (notifyDevice) {
                    notifyDevice(pendingCross.fromDeviceId, {
                        type: 'chat', category: 'cross_speak',
                        title: `${entity.name || entity.publicCode || `Entity ${eId}`} replied`,
                        body: (message || '').slice(0, 100),
                        link: 'chat.html',
                        metadata: { fromPublicCode: entity.publicCode, entityId: senderEntityId }
                    }).catch(() => {});
                }

                // Consume the cross-device message so it doesn't trigger again
                const crossIdx = entity.messageQueue.findLastIndex(m => m.crossDevice);
                if (crossIdx >= 0) entity.messageQueue.splice(crossIdx, 1);
            }

            // Emit real-time update via Socket.IO
            io.to(`device:${deviceId}`).emit('entity:update', {
                deviceId,
                entityId: eId,
                name: entity.name,
                character: entity.character,
                state: entity.state,
                message: entity.message,
                parts: entity.parts,
                lastUpdated: entity.lastUpdated,
                xp: entity.xp || 0,
                level: entity.level || 1
            });

            serverLog('info', 'transform', `${state || entity.state}: ${(message || '').slice(0, 100)}`, { deviceId, entityId: eId, metadata: { state: state || entity.state, via: 'channel' } });

            // Auto-move kanban child cards to done (same as /api/transform).
            // START/progress heartbeats must use BUSY/PROCESSING/WORKING without closing cards.
            const kanbanBusyStates = new Set(['BUSY', 'PROCESSING', 'WORKING', 'IN_PROGRESS', 'IN-PROGRESS']);
            const isKanbanBusyState = kanbanBusyStates.has(String(state || '').trim().toUpperCase());
            if (!isKanbanBusyState && message && kanbanAutoReview) {
                kanbanAutoReview(deviceId, eId, message, aboutCardId).catch(err => {
                    console.error(`[Channel] autoReviewOnTransform failed:`, err.message);
                });
            }

            // Org chart: auto-forward channel bot response to superior entity (fire-and-forget)
            if (finalMessage && entity && orgChartForwardFn) {
                orgChartForwardFn(entity, deviceId, finalMessage).catch(() => {});
            }

            // ── speakTo / broadcast delivery ──
            const warnings = [];
            let deliveryResults = null;
            // Mirror of the /api/transform fallback: set when delivery writes a
            // chat row. If still false after the delivery block yet delivery was
            // requested, we save the sender's copy so the message isn't lost.
            let deliverySaved = false;
            if (entityIdCorrected) {
                warnings.push(`entityId mismatch: auto-corrected to ${eId}.`);
            }

            if ((speakTo || broadcast) && message && !isSilentMsg && deliverToEntity && resolveSpeakToTarget) {
                if (speakTo && broadcast) {
                    warnings.push('Both speakTo and broadcast provided — broadcast takes priority, speakTo ignored.');
                }

                const gkResult = gatekeeperCheckText ? gatekeeperCheckText(deviceId, eId, message, entity.botSecret) : { text: message };
                const deliveryText = gkResult.text;

                if (broadcast) {
                    // Broadcast to all other bound entities on device (or targetDeviceId)
                    const broadcastDeviceId = (targetDeviceId && targetDeviceId !== deviceId) ? targetDeviceId : deviceId;
                    const broadcastDevice = devices[broadcastDeviceId];
                    if (!broadcastDevice) {
                        warnings.push(`Broadcast target device ${broadcastDeviceId} not found.`);
                    } else if (!checkBotToBotRateLimit || !checkBotToBotRateLimit(broadcastDeviceId, eId)) {
                        warnings.push('Bot-to-bot limit reached. Broadcast skipped.');
                        deliveryResults = { broadcast: true, rateLimited: true, sentCount: 0, targets: [] };
                    } else {
                        const targetIds = [];
                        for (const i of Object.keys(broadcastDevice.entities).map(Number)) {
                            if (i !== eId && broadcastDevice.entities[i] && broadcastDevice.entities[i].isBound) {
                                targetIds.push(i);
                            }
                        }
                        if (targetIds.length === 0) {
                            deliveryResults = { broadcast: true, sentCount: 0, targets: [] };
                        } else {
                            const sourceLabel = `entity:${eId}:${entity.character}`;
                            const broadcastChatMsgId = await saveChatMessage(broadcastDeviceId, eId, deliveryText, `${sourceLabel}->${targetIds.join(',')}`, false, true, null, null, null, null, null, null, validatedCard);
                            deliverySaved = true;
                            const bcastPrefs = devicePrefs ? await devicePrefs.getPrefs(broadcastDeviceId) : {};
                            const showRecipientInfo = bcastPrefs.broadcast_recipient_info !== false;
                            const results = await Promise.all(targetIds.map(toId =>
                                deliverToEntity({
                                    senderDeviceId: deviceId, fromId: eId, fromEntity: entity,
                                    targetDeviceId: broadcastDeviceId, toId, toEntity: broadcastDevice.entities[toId],
                                    text: deliveryText, expectsReply: true, isBroadcast: true,
                                    broadcastTargetIds: targetIds, broadcastChatMsgId, showRecipientInfo,
                                    isCrossDevice: broadcastDeviceId !== deviceId,
                                    card: validatedCard
                                })
                            ));
                            deliveryResults = { broadcast: true, sentCount: results.length, targets: results };
                        }
                    }
                } else if (speakTo && Array.isArray(speakTo) && speakTo.length > 0) {
                    const results = [];
                    for (const code of speakTo) {
                        const target = resolveSpeakToTarget(code, deviceId);
                        if (!target) { results.push({ publicCode: code, success: false, reason: 'not_found' }); continue; }
                        const tDevice = devices[target.deviceId];
                        if (!tDevice) { results.push({ publicCode: code, success: false, reason: 'device_not_found' }); continue; }
                        const toEntity = tDevice.entities[target.entityId];
                        if (!toEntity || !toEntity.isBound) { results.push({ publicCode: code, success: false, reason: 'not_bound' }); continue; }
                        if (entity.publicCode === code || (target.deviceId === deviceId && target.entityId === eId)) {
                            results.push({ publicCode: code, success: false, reason: 'self_target' }); continue;
                        }
                        const isCrossDevice = target.deviceId !== deviceId;
                        if (isCrossDevice && crossDeviceSettings) {
                            const xdSettings = await crossDeviceSettings.getSettings(target.deviceId, target.entityId);
                            const senderCode = entity.publicCode;
                            if (dbRef && await dbRef.isBlocked(target.deviceId, senderCode)) { results.push({ publicCode: code, success: false, reason: 'blocked' }); continue; }
                            if (xdSettings.blacklist.length > 0 && xdSettings.blacklist.includes(senderCode)) { results.push({ publicCode: code, success: false, reason: 'blacklisted' }); continue; }
                            if (xdSettings.whitelist_enabled && xdSettings.whitelist.length > 0 && !xdSettings.whitelist.includes(senderCode)) { results.push({ publicCode: code, success: false, reason: 'not_whitelisted' }); continue; }
                            if (!checkCrossSpeakRateLimit || !checkCrossSpeakRateLimit(deviceId, eId)) { results.push({ publicCode: code, success: false, reason: 'cross_device_rate_limited' }); continue; }
                        } else if (!isCrossDevice) {
                            if (!checkBotToBotRateLimit || !checkBotToBotRateLimit(deviceId, eId)) { results.push({ publicCode: code, success: false, reason: 'rate_limited' }); continue; }
                        }
                        const result = await deliverToEntity({
                            senderDeviceId: deviceId, fromId: eId, fromEntity: entity,
                            targetDeviceId: target.deviceId, toId: target.entityId, toEntity,
                            text: deliveryText, expectsReply: true, isCrossDevice,
                            card: validatedCard
                        });
                        results.push({ publicCode: code, success: true, ...result });
                        deliverySaved = true;
                    }
                    deliveryResults = { speakTo: true, results };
                }
            }

            // Fallback: delivery was requested but no target resolved — save
            // sender's copy so chat UI still shows the message. Mirror of the
            // same logic in /api/transform.
            const hasDeliveryRequested = (broadcast || (speakTo && Array.isArray(speakTo) && speakTo.length > 0));
            if (hasDeliveryRequested && !deliverySaved && message && !isSilentMsg) {
                const localSource = hasCrossRoute
                    ? `xdevice:${entity.publicCode}:${entity.character}->${pendingCross.fromPublicCode || pendingCross.fromDeviceId}`
                    : (entity.name || `Entity ${eId}`);
                const reasons = deliveryResults && deliveryResults.results ? deliveryResults.results.map(r => r.reason || 'ok').join(',') : 'none';
                serverLog('warn', 'chat_save', `[CHAT_FALLBACK_CHANNEL] all targets failed for entity ${eId}; saving sender copy. reasons=[${reasons}] speakTo=${JSON.stringify(speakTo || null)} broadcast=${!!broadcast}`, { deviceId, entityId: eId, metadata: { path: 'fallback_channel', reasons, hadSpeakTo: !!speakTo, hadBroadcast: !!broadcast } });
                await saveChatMessage(deviceId, eId, message, localSource, false, true, mediaType || null, mediaUrl || null, null, null, null, null, validatedCard);
                warnings.push('All delivery targets failed; message saved to sender chat only.');
            }

            const response = {
                success: true,
                entityId: eId,
                currentState: {
                    name: entity.name,
                    state: entity.state,
                    message: entity.message,
                    xp: entity.xp || 0,
                    level: entity.level || 1
                }
            };
            if (deliveryResults) response.delivery = deliveryResults;
            if (warnings.length > 0) response.warnings = warnings;
            if (transformMentionContext) response.mentions = transformMentionContext;
            if (senderHintResolution) response.senderHintResolution = senderHintResolution;
            res.json(response);
        } catch (err) {
            console.error('[Channel] Message error:', err.message);
            res.status(500).json({ success: false, message: 'Internal error' });
        }
    });

    // ── POST /api/channel/card-action ──
    // Called by frontend (chat UI) when the user taps a rich-card button.
    // Body: { deviceId, entityId, botSecret, ask_id, action_id }
    // Validates auth, marks the message card as resolved, and pushes a
    // `card_action` webhook event back to the channel callback so the bot
    // can react to the user's choice.
    router.post('/card-action', async (req, res) => {
        try {
            const { deviceId, entityId, botSecret, deviceSecret, ask_id, action_id } = req.body || {};
            if (!deviceId || !ask_id || !action_id) {
                return res.status(400).json({ success: false, message: 'deviceId, ask_id and action_id are required' });
            }

            const device = devices[deviceId];
            if (!device) {
                return res.status(404).json({ success: false, message: 'Device not found' });
            }

            // Auth: accept botSecret (per entity), deviceSecret (whole device), or JWT cookie
            let eId;
            let authed = false;
            if (botSecret) {
                if (entityId !== undefined && entityId !== null) {
                    const requested = parseInt(entityId);
                    const ent = device.entities[requested];
                    if (ent && ent.isBound && ent.botSecret && safeEqual(ent.botSecret, botSecret)) {
                        eId = requested;
                        authed = true;
                    }
                }
                if (!authed) {
                    const found = Object.keys(device.entities).map(Number)
                        .find(i => device.entities[i]?.isBound && device.entities[i].botSecret && safeEqual(device.entities[i].botSecret, botSecret));
                    if (found !== undefined) { eId = found; authed = true; }
                }
            }
            if (!authed && deviceSecret && device.deviceSecret && safeEqual(device.deviceSecret, deviceSecret)) {
                authed = true;
            }
            if (!authed && req.user && req.user.deviceId === deviceId) {
                authed = true;
            }
            if (!authed) {
                return res.status(403).json({ success: false, message: 'Invalid credentials' });
            }

            // If eId wasn't determined via botSecret, use entityId hint or default to 0
            if (eId === undefined) {
                if (entityId !== undefined && entityId !== null) {
                    const requested = parseInt(entityId);
                    if (!isNaN(requested) && device.entities[requested]) eId = requested;
                }
                if (eId === undefined) {
                    eId = Object.keys(device.entities).map(Number).find(i => device.entities[i]?.isBound);
                    if (eId === undefined) eId = 0;
                }
            }

            const entity = device.entities[eId];

            // Look up the chat message that owns this ask_id so we can mark it resolved
            let matchedRow = null;
            if (chatPool) {
                try {
                    const result = await chatPool.query(
                        `SELECT id, card, card_resolved_action
                         FROM chat_messages
                         WHERE device_id = $1 AND card IS NOT NULL
                           AND (card->>'ask_id') = $2
                         ORDER BY created_at DESC LIMIT 1`,
                        [deviceId, String(ask_id)]
                    );
                    matchedRow = result.rows[0] || null;
                } catch (err) {
                    serverLog('warn', 'channel', `card-action lookup failed: ${err.message}`, { deviceId, entityId: eId });
                }
            }

            if (!matchedRow) {
                return res.status(404).json({ success: false, message: 'Card not found for this ask_id' });
            }

            // Validate that action_id is one of the buttons on the card
            const buttons = (matchedRow.card && matchedRow.card.buttons) || [];
            const button = buttons.find(b => b && b.id === action_id);
            if (!button) {
                return res.status(400).json({ success: false, message: 'Invalid action_id for this card' });
            }

            // Idempotent: if already resolved, return the existing resolution instead of resending webhook
            if (matchedRow.card_resolved_action) {
                return res.json({
                    success: true,
                    already_resolved: true,
                    ask_id,
                    action_id: matchedRow.card_resolved_action
                });
            }

            // Mark message as resolved
            if (chatPool) {
                try {
                    await chatPool.query(
                        `UPDATE chat_messages
                           SET card_resolved_action = $1,
                               card_resolved_at = NOW()
                         WHERE id = $2`,
                        [String(action_id), matchedRow.id]
                    );
                } catch (err) {
                    serverLog('warn', 'channel', `card-action persist failed: ${err.message}`, { deviceId, entityId: eId });
                }
            }

            // Broadcast the resolution over Socket.IO so other open chat tabs
            // disable their buttons immediately.
            if (io) {
                io.to(`device:${deviceId}`).emit('chat:card_resolved', {
                    message_id: matchedRow.id,
                    ask_id,
                    action_id,
                    label: button.label
                });
            }

            // Push a card_action webhook back to the channel bot (fire-and-forget)
            pushToChannelCallback(deviceId, eId, {
                event: 'card_action',
                from: 'user',
                ask_id,
                action_id,
                text: `[card_action] ${button.label}`
            }, entity.channelAccountId).catch(err => {
                serverLog('warn', 'channel', `card-action webhook push failed: ${err.message}`, { deviceId, entityId: eId });
            });

            serverLog('info', 'channel', `Card action: ask_id=${ask_id} action_id=${action_id} entity=${eId}`, {
                deviceId, entityId: eId,
                metadata: { ask_id, action_id }
            });

            return res.json({
                success: true,
                ask_id,
                action_id,
                label: button.label,
                message_id: matchedRow.id
            });
        } catch (err) {
            console.error('[Channel] card-action error:', err.message);
            return res.status(500).json({ success: false, message: 'Internal error' });
        }
    });

    // ── Helper: Push structured message to channel callback ──
    // channelAccountId: the specific account bound to this entity (preferred)
    // Falls back to device-level lookup for legacy entities without channelAccountId
    async function pushToChannelCallback(deviceId, entityId, payload, channelAccountId) {
        let account;
        if (channelAccountId) {
            account = await db.getChannelAccountById(channelAccountId);
        } else {
            account = await db.getChannelAccountByDevice(deviceId);
        }
        if (!account || !account.callback_url) {
            return { pushed: false, reason: 'no_channel_callback' };
        }

        try {
            const headers = { 'Content-Type': 'application/json' };
            if (account.callback_username && account.callback_password) {
                // Railway WEB_PASSWORD: Basic Auth for gateway + custom header for webhook token routing
                headers['Authorization'] = 'Basic ' + Buffer.from(`${account.callback_username}:${account.callback_password}`).toString('base64');
                if (account.callback_token) {
                    headers['X-Callback-Token'] = account.callback_token;
                }
            } else if (account.callback_token) {
                headers['Authorization'] = `Bearer ${account.callback_token}`;
            }

            // Centralised context inlining — see backend/push-context.js.
            const targetDevice = devices[deviceId];
            const targetEntity = targetDevice && targetDevice.entities
                ? targetDevice.entities[entityId]
                : null;

            // 智慧引用 / Smart Chip expansion — scan the outgoing text for
            // card_/review_/src:// references and append a [REFERENCES] block
            // so the receiving bot truly understands what is being cited
            // instead of guessing from the opaque ID. See backend/reference-*.js.
            let referencesBlock = null;
            try {
                const parsedRefs = scanReferences(payload.text || '');
                if (parsedRefs.length > 0 && chatPool) {
                    const resolved = await resolveReferences(chatPool, deviceId, parsedRefs);
                    referencesBlock = buildReferencesBlock(resolved);
                }
            } catch (refErr) {
                serverLog('warn', 'channel', `reference expansion failed: ${refErr.message}`, { deviceId, entityId });
            }

            const enrichedCtx = enrichContext(payload.eclaw_context, {
                helpers: pushContextHelpers,
                apiBase,
                targetEntity,
                targetDevice,
                targetDeviceId: deviceId,
                targetEntityId: entityId,
                broadcastRecipients: payload.broadcastRecipients,
            });
            if (referencesBlock) enrichedCtx.referencesBlock = referencesBlock;
            const materializedText = materializeChannelText(payload, enrichedCtx);

            const bodyStr = JSON.stringify({
                event: payload.event || 'message',
                deviceId,
                entityId,
                conversationId: `${deviceId}:${entityId}`,
                from: payload.from || 'client',
                text: materializedText,
                card: payload.card || null,
                ask_id: payload.ask_id || (payload.card && payload.card.ask_id) || null,
                action_id: payload.action_id || null,
                mediaType: payload.mediaType || null,
                mediaUrl: payload.mediaUrl || null,
                backupUrl: payload.backupUrl || null,
                timestamp: Date.now(),
                isBroadcast: payload.isBroadcast || false,
                broadcastRecipients: payload.broadcastRecipients || null,
                fromEntityId: payload.fromEntityId,
                fromCharacter: payload.fromCharacter,
                fromPublicCode: payload.fromPublicCode,
                eclaw_context: enrichedCtx,
                contextInlined: true,
                e2ee: !!account.e2ee_capable
            });

            // Use redirect: 'manual' to preserve POST method on 301/302/303 redirects.
            // Default fetch behavior converts POST→GET on these status codes, losing the body.
            let response = await fetch(account.callback_url, {
                method: 'POST',
                headers,
                body: bodyStr,
                redirect: 'manual',
                signal: AbortSignal.timeout(10000)
            });

            // Follow redirect manually, preserving POST method and body
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                if (location) {
                    response = await fetch(location, {
                        method: 'POST',
                        headers,
                        body: bodyStr,
                        redirect: 'manual',
                        signal: AbortSignal.timeout(10000)
                    });
                }
            }

            if (response.ok) {
                serverLog('info', 'channel', `Callback push OK for Entity ${entityId}`, { deviceId, entityId });
                return { pushed: true };
            } else {
                const errText = await response.text().catch(() => '');
                serverLog('warn', 'channel', `Callback push failed HTTP ${response.status}`, { deviceId, entityId, metadata: { status: response.status, error: errText.substring(0, 200) } });
                return { pushed: false, reason: `http_${response.status}` };
            }
        } catch (err) {
            serverLog('error', 'channel', `Callback push error: ${err.message}`, { deviceId, entityId });
            return { pushed: false, reason: err.message };
        }
    }

    // ============================================
    // Channel Registration Management (Phase 1)
    // Auth: deviceId + deviceSecret (owner-scope)
    // ============================================

    const VALID_PERMISSIONS = new Set(['speak', 'state', 'a2a', 'broadcast']);
    const BCRYPT_ROUNDS = 10;

    function validateAllowedEntities(raw) {
        if (!Array.isArray(raw)) return 'allowedEntities must be an array';
        for (const entry of raw) {
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
                return 'each allowedEntities entry must be an object';
            }
            if (typeof entry.entity_id !== 'number' || !Number.isInteger(entry.entity_id) || entry.entity_id < 0) {
                return 'allowedEntities[].entity_id must be a non-negative integer';
            }
            if (!Array.isArray(entry.permissions)) return 'allowedEntities[].permissions must be an array';
            for (const p of entry.permissions) {
                if (!VALID_PERMISSIONS.has(p)) {
                    return `unknown permission: ${p}. Allowed: ${[...VALID_PERMISSIONS].join(', ')}`;
                }
            }
        }
        return null;
    }

    // POST /api/channel/registrations — create new channel registration
    router.post('/registrations', async (req, res) => {
        const auth = deviceAuth(req, res);
        if (!auth) return;
        const { deviceId } = auth;

        const { channelName, allowedEntities } = req.body;
        if (!channelName || typeof channelName !== 'string' || channelName.trim().length === 0) {
            return res.status(400).json({ success: false, error: 'channelName required' });
        }
        const name = channelName.trim().slice(0, 128);
        const entities = allowedEntities || [];
        const validationErr = validateAllowedEntities(entities);
        if (validationErr) return res.status(400).json({ success: false, error: validationErr });

        try {
            const pool = dbRef._getPool();
            // Check for existing active registration
            const existing = await pool.query(
                `SELECT id FROM channel_registrations WHERE channel_name=$1 AND device_id=$2 AND revoked_at IS NULL`,
                [name, deviceId]
            );
            if (existing.rowCount > 0) {
                return res.status(409).json({ success: false, error: 'channel registration already exists; use rotate-key or PATCH to modify' });
            }

            const rawKey = crypto.randomBytes(32).toString('hex');
            const keyHash = await bcrypt.hash(rawKey, BCRYPT_ROUNDS);

            await pool.query(
                `INSERT INTO channel_registrations (channel_name, device_id, key_hash, allowed_entities)
                 VALUES ($1, $2, $3, $4)`,
                [name, deviceId, keyHash, JSON.stringify(entities)]
            );

            serverLog('info', 'channel', `Channel registration created: ${name}`, { deviceId, metadata: { channelName: name } });
            return res.status(201).json({ success: true, channelName: name, channelKey: rawKey, allowedEntities: entities });
        } catch (err) {
            serverLog('error', 'channel', `Create registration failed: ${err.message}`, { deviceId });
            return res.status(500).json({ success: false, error: 'internal error' });
        }
    });

    // GET /api/channel/registrations — list active registrations for device
    router.get('/registrations', async (req, res) => {
        const auth = deviceAuth(req, res);
        if (!auth) return;
        const { deviceId } = auth;

        try {
            const pool = dbRef._getPool();
            const rows = await pool.query(
                `SELECT id, channel_name, allowed_entities, created_at, last_seen_at
                 FROM channel_registrations
                 WHERE device_id=$1 AND revoked_at IS NULL
                 ORDER BY created_at DESC`,
                [deviceId]
            );
            return res.json({
                success: true,
                registrations: rows.rows.map(r => ({
                    id: r.id,
                    channelName: r.channel_name,
                    allowedEntities: r.allowed_entities,
                    createdAt: r.created_at,
                    lastSeenAt: r.last_seen_at
                }))
            });
        } catch (err) {
            serverLog('error', 'channel', `List registrations failed: ${err.message}`, { deviceId });
            return res.status(500).json({ success: false, error: 'internal error' });
        }
    });

    // PATCH /api/channel/registrations/:name — update ACL
    router.patch('/registrations/:name', async (req, res) => {
        const auth = deviceAuth(req, res);
        if (!auth) return;
        const { deviceId } = auth;
        const name = req.params.name;

        const { allowedEntities } = req.body;
        if (!Array.isArray(allowedEntities)) {
            return res.status(400).json({ success: false, error: 'allowedEntities array required' });
        }
        const validationErr = validateAllowedEntities(allowedEntities);
        if (validationErr) return res.status(400).json({ success: false, error: validationErr });

        try {
            const pool = dbRef._getPool();
            const result = await pool.query(
                `UPDATE channel_registrations SET allowed_entities=$1
                 WHERE channel_name=$2 AND device_id=$3 AND revoked_at IS NULL`,
                [JSON.stringify(allowedEntities), name, deviceId]
            );
            if (result.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'registration not found' });
            }
            serverLog('info', 'channel', `Channel registration updated: ${name}`, { deviceId });
            return res.json({ success: true, channelName: name, allowedEntities });
        } catch (err) {
            serverLog('error', 'channel', `Update registration failed: ${err.message}`, { deviceId });
            return res.status(500).json({ success: false, error: 'internal error' });
        }
    });

    // DELETE /api/channel/registrations/:name — revoke channel key
    router.delete('/registrations/:name', async (req, res) => {
        const auth = deviceAuth(req, res);
        if (!auth) return;
        const { deviceId } = auth;
        const name = req.params.name;

        try {
            const pool = dbRef._getPool();
            const result = await pool.query(
                `UPDATE channel_registrations SET revoked_at=NOW()
                 WHERE channel_name=$1 AND device_id=$2 AND revoked_at IS NULL`,
                [name, deviceId]
            );
            if (result.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'registration not found' });
            }
            serverLog('info', 'channel', `Channel registration revoked: ${name}`, { deviceId });
            return res.json({ success: true, channelName: name, revokedAt: new Date().toISOString() });
        } catch (err) {
            serverLog('error', 'channel', `Revoke registration failed: ${err.message}`, { deviceId });
            return res.status(500).json({ success: false, error: 'internal error' });
        }
    });

    // POST /api/channel/registrations/:name/rotate-key — generate new key, old key immediately invalid
    router.post('/registrations/:name/rotate-key', async (req, res) => {
        const auth = deviceAuth(req, res);
        if (!auth) return;
        const { deviceId } = auth;
        const name = req.params.name;

        try {
            const pool = dbRef._getPool();
            const rawKey = crypto.randomBytes(32).toString('hex');
            const keyHash = await bcrypt.hash(rawKey, BCRYPT_ROUNDS);

            const result = await pool.query(
                `UPDATE channel_registrations SET key_hash=$1, last_seen_at=NULL
                 WHERE channel_name=$2 AND device_id=$3 AND revoked_at IS NULL
                 RETURNING id`,
                [keyHash, name, deviceId]
            );
            if (result.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'registration not found' });
            }
            serverLog('info', 'channel', `Channel key rotated: ${name}`, { deviceId });
            return res.json({ success: true, channelName: name, channelKey: rawKey });
        } catch (err) {
            serverLog('error', 'channel', `Rotate key failed: ${err.message}`, { deviceId });
            return res.status(500).json({ success: false, error: 'internal error' });
        }
    });

    // ── verifyChannelKey: called by /api/transform to authenticate channel key path ──
    // Returns { registration, entityEntry } or throws { status, error }
    async function verifyChannelKey({ channelKey, deviceId, entityId }) {
        const pool = dbRef._getPool();
        const rows = await pool.query(
            `SELECT id, channel_name, key_hash, allowed_entities
             FROM channel_registrations
             WHERE device_id=$1 AND revoked_at IS NULL`,
            [deviceId]
        );

        for (const row of rows.rows) {
            const match = await bcrypt.compare(channelKey, row.key_hash);
            if (!match) continue;

            // Update last_seen_at (fire-and-forget)
            pool.query(
                `UPDATE channel_registrations SET last_seen_at=NOW() WHERE id=$1`,
                [row.id]
            ).catch(() => {});

            // Check entity is in allowed_entities
            const allowed = Array.isArray(row.allowed_entities) ? row.allowed_entities : [];
            const entityEntry = allowed.find(e => e.entity_id === entityId);
            if (!entityEntry) {
                const err = new Error(`Entity ${entityId} not in allowedEntities for channel ${row.channel_name}`);
                err.status = 403;
                err.code = 'entity_not_allowed';
                throw err;
            }

            return { registration: row, entityEntry };
        }

        const err = new Error('Invalid channel key');
        err.status = 403;
        err.code = 'invalid_channel_key';
        throw err;
    }

    return {
        router,
        pushToChannelCallback,
        setKanbanAutoReview,
        setOrgChartForward,
        verifyChannelKey
    };
};
