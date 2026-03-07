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

module.exports = function (devices, { authMiddleware, serverLog, generateBotSecret, generatePublicCode, publicCodeIndex, saveChatMessage, io, saveData }) {
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
        if (!device || device.deviceSecret !== deviceSecret) {
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
        if (apiSecret && account.channel_api_secret !== apiSecret) {
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
        const expectedToken = req.query.token; // token embedded in callback_url for retrieval
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

            const { callback_url, callback_token } = req.body;
            if (!callback_url) {
                return res.status(400).json({ success: false, message: 'callback_url required' });
            }

            if (process.env.DEBUG === 'true') console.log(`[BIND] /register deviceId=${account.device_id} callback_url=${callback_url}`);

            await db.updateChannelCallback(account.channel_api_key, callback_url, callback_token || null);

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

            if (process.env.DEBUG === 'true') console.log(`[BIND] /register OK, entities:`, entities.map(e => `${e.entityId}(bound=${e.isBound},mine=${e.boundToThisAccount})`).join(', '));

            serverLog('info', 'channel', `Callback registered: ${callback_url}`, { deviceId: account.device_id });

            res.json({
                success: true,
                deviceId: account.device_id,
                accountId: account.id,
                entities,
                maxEntities: 8
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

            if (process.env.DEBUG === 'true') console.log(`[BIND] auth OK, accountId=${account.id}, deviceId=${account.device_id}`);

            const { name } = req.body;
            const rawEntityId = req.body.entityId;

            if (name && name.length > 20) {
                return res.status(400).json({ success: false, message: 'Name must be 20 characters or less' });
            }

            const deviceId = account.device_id;
            const device = devices[deviceId];
            if (!device) {
                if (process.env.DEBUG === 'true') console.log(`[BIND] device not found: ${deviceId}`);
                return res.status(404).json({ success: false, message: 'Device not found' });
            }

            let eId;
            if (rawEntityId !== undefined && rawEntityId !== null) {
                // Explicit entityId specified
                eId = parseInt(rawEntityId);
                if (isNaN(eId) || eId < 0 || eId > 7) {
                    if (process.env.DEBUG === 'true') console.log(`[BIND] invalid entityId: ${rawEntityId}`);
                    return res.status(400).json({ success: false, message: 'entityId must be 0-7' });
                }
                if (process.env.DEBUG === 'true') console.log(`[BIND] using explicit entityId=${eId}`);
            } else {
                // Auto-select: first slot bound to this channel account (reconnect), else first free slot
                eId = null;
                const slotKeys = Object.keys(device.entities).map(Number).sort();
                // Prefer reconnecting to the same account's existing slot
                for (const i of slotKeys) {
                    if (device.entities[i]?.isBound && device.entities[i]?.channelAccountId === account.id) {
                        eId = i;
                        if (process.env.DEBUG === 'true') console.log(`[BIND] auto-selected slot ${eId} (reconnect same account)`);
                        break;
                    }
                }
                // Fallback: first unbound slot
                if (eId === null) {
                    for (const i of slotKeys) {
                        if (device.entities[i] && !device.entities[i].isBound) {
                            eId = i;
                            if (process.env.DEBUG === 'true') console.log(`[BIND] auto-selected slot ${eId} (first free)`);
                            break;
                        }
                    }
                }
                // All slots full
                if (eId === null) {
                    const allEntities = slotKeys.map(i => ({
                        entityId: i,
                        name: device.entities[i].name || null,
                        character: device.entities[i].character,
                        bindingType: device.entities[i].bindingType || null,
                        isBound: device.entities[i].isBound || false,
                    }));
                    if (process.env.DEBUG === 'true') console.log(`[BIND] all slots full, returning entity list`);
                    return res.status(409).json({
                        success: false,
                        message: 'All entity slots are full. Set entityId in your channel config to override a specific slot (after unbinding it), or unbind an entity first.',
                        entities: allEntities,
                        hint: 'To unbind: DELETE /api/entity/:entityId with your deviceId + deviceSecret'
                    });
                }
            }

            const entity = device.entities[eId];
            if (!entity) {
                if (process.env.DEBUG === 'true') console.log(`[BIND] entity slot ${eId} not found`);
                return res.status(400).json({ success: false, message: `Entity slot ${eId} not available` });
            }

            if (process.env.DEBUG === 'true') console.log(`[BIND] entity ${eId} state: isBound=${entity.isBound}, bindingType=${entity.bindingType}, channelAccountId=${entity.channelAccountId}`);

            // If already bound via channel
            if (entity.isBound && entity.bindingType === 'channel') {
                if (entity.channelAccountId === account.id) {
                    // Same plugin — return existing credentials (idempotent)
                    if (process.env.DEBUG === 'true') console.log(`[BIND] entity ${eId} already bound to this account (idempotent), returning existing botSecret`);
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
                    if (process.env.DEBUG === 'true') console.log(`[BIND] entity ${eId} owned by different channelAccountId=${entity.channelAccountId}, rejecting`);
                    return res.status(409).json({
                        success: false,
                        message: 'Entity already bound by a different channel account. Unbind first via DELETE /api/entity/:entityId'
                    });
                }
            }

            // Don't allow binding over an existing non-channel binding
            if (entity.isBound) {
                if (process.env.DEBUG === 'true') console.log(`[BIND] entity ${eId} bound via non-channel method (bindingType=${entity.bindingType}), rejecting`);
                return res.status(409).json({
                    success: false,
                    message: 'Entity already bound. Unbind first via DELETE /api/entity/:entityId'
                });
            }

            // Bind the entity
            if (process.env.DEBUG === 'true') console.log(`[BIND] binding entity ${eId} via channel, name="${name || ''}"`);
            const botSecret = generateBotSecret();
            const publicCode = generatePublicCode();

            entity.isBound = true;
            entity.botSecret = botSecret;
            entity.publicCode = publicCode;
            entity.bindingType = 'channel';
            entity.channelAccountId = account.id;
            publicCodeIndex[publicCode] = { deviceId, entityId: eId };
            entity.name = name || null;
            entity.state = 'IDLE';
            entity.message = 'Connected via OpenClaw channel!';
            entity.lastUpdated = Date.now();

            saveData();
            serverLog('info', 'bind', `Entity ${eId} bound via channel plugin`, { deviceId, entityId: eId });
            if (process.env.DEBUG === 'true') console.log(`[BIND] entity ${eId} bound OK, publicCode=${publicCode}`);

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
            const { channel_api_key, deviceId, entityId, botSecret, message, state, mediaType, mediaUrl } = req.body;

            if (process.env.DEBUG === 'true') console.log(`[PUSH] /channel/message called, deviceId=${deviceId}, entityId=${entityId}, state=${state}, hasMsg=${!!message}`);

            if (!channel_api_key || !deviceId || entityId === undefined || !botSecret) {
                if (process.env.DEBUG === 'true') console.log('[PUSH] /channel/message missing required fields');
                return res.status(400).json({
                    success: false,
                    message: 'channel_api_key, deviceId, entityId, and botSecret required'
                });
            }

            // Verify channel API key exists
            const account = await db.getChannelAccountByKey(channel_api_key);
            if (!account) {
                return res.status(403).json({ success: false, message: 'Invalid channel API key' });
            }

            const eId = parseInt(entityId);
            const device = devices[deviceId];
            if (!device) {
                return res.status(404).json({ success: false, message: 'Device not found' });
            }

            const entity = device.entities[eId];
            if (!entity) {
                return res.status(404).json({ success: false, message: 'Entity not found' });
            }

            // Verify botSecret
            if (!entity.botSecret || botSecret !== entity.botSecret) {
                return res.status(403).json({ success: false, message: 'Invalid botSecret' });
            }

            // Update entity state
            const finalMessage = message || entity.message;
            if (state) entity.state = state;
            if (message) entity.message = message;
            entity.lastUpdated = Date.now();

            // Save to chat history
            if (message) {
                saveChatMessage(deviceId, eId, message, 'bot', false, true, mediaType || null, mediaUrl || null);
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

            serverLog('info', 'channel', `Channel message from Entity ${eId}`, { deviceId, entityId: eId });

            res.json({
                success: true,
                currentState: {
                    name: entity.name,
                    state: entity.state,
                    message: entity.message,
                    xp: entity.xp || 0,
                    level: entity.level || 1
                }
            });
        } catch (err) {
            console.error('[Channel] Message error:', err.message);
            res.status(500).json({ success: false, message: 'Internal error' });
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
            if (account.callback_token) {
                headers['Authorization'] = `Bearer ${account.callback_token}`;
            }

            const response = await fetch(account.callback_url, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    event: payload.event || 'message',
                    deviceId,
                    entityId,
                    conversationId: `${deviceId}:${entityId}`,
                    from: payload.from || 'client',
                    text: payload.text || '',
                    mediaType: payload.mediaType || null,
                    mediaUrl: payload.mediaUrl || null,
                    backupUrl: payload.backupUrl || null,
                    timestamp: Date.now(),
                    isBroadcast: payload.isBroadcast || false,
                    broadcastRecipients: payload.broadcastRecipients || null,
                    fromEntityId: payload.fromEntityId,
                    fromCharacter: payload.fromCharacter,
                    fromPublicCode: payload.fromPublicCode
                }),
                signal: AbortSignal.timeout(10000)
            });

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

    return {
        router,
        pushToChannelCallback
    };
};
