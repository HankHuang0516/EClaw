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

    // ── Auth helper: validate channel API key + secret ──
    async function channelAuth(req, res) {
        const apiKey = req.body.channel_api_key || req.headers['x-channel-api-key'];
        const apiSecret = req.body.channel_api_secret || req.headers['x-channel-api-secret'];

        if (!apiKey || !apiSecret) {
            res.status(401).json({ success: false, message: 'channel_api_key and channel_api_secret required' });
            return null;
        }

        const account = await db.getChannelAccountByKey(apiKey);
        if (!account || account.channel_api_secret !== apiSecret) {
            res.status(403).json({ success: false, message: 'Invalid channel credentials' });
            return null;
        }

        return account;
    }

    // ============================================
    // POST /provision — User generates channel API key
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

            // Check if channel account already exists
            const existing = await db.getChannelAccountByDevice(deviceId);
            if (existing) {
                return res.json({
                    success: true,
                    message: 'Channel account already exists',
                    channel_api_key: existing.channel_api_key,
                    channel_api_secret: existing.channel_api_secret,
                    created_at: existing.created_at
                });
            }

            // Generate prefixed API key pair
            const apiKey = 'eck_' + crypto.randomBytes(32).toString('hex');
            const apiSecret = 'ecs_' + crypto.randomBytes(32).toString('hex');

            const account = await db.createChannelAccount(deviceId, apiKey, apiSecret);
            if (!account) {
                return res.status(500).json({ success: false, message: 'Failed to create channel account' });
            }

            serverLog('info', 'channel', `Channel account provisioned`, { deviceId });

            res.json({
                success: true,
                channel_api_key: apiKey,
                channel_api_secret: apiSecret,
                instructions: 'Add these to your OpenClaw config under channels.eclaw.accounts.default'
            });
        } catch (err) {
            console.error('[Channel] Provision error:', err.message);
            res.status(500).json({ success: false, message: 'Internal error' });
        }
    });

    // ============================================
    // POST /register — Plugin registers callback URL
    // ============================================
    router.post('/register', async (req, res) => {
        try {
            const account = await channelAuth(req, res);
            if (!account) return;

            const { callback_url, callback_token } = req.body;
            if (!callback_url) {
                return res.status(400).json({ success: false, message: 'callback_url required' });
            }

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
                        bindingType: e.bindingType || null
                    });
                }
            }

            serverLog('info', 'channel', `Callback registered: ${callback_url}`, { deviceId: account.device_id });

            res.json({
                success: true,
                deviceId: account.device_id,
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
    // ============================================
    router.post('/bind', async (req, res) => {
        try {
            const account = await channelAuth(req, res);
            if (!account) return;

            const { entityId, name } = req.body;
            const eId = parseInt(entityId);
            if (isNaN(eId) || eId < 0 || eId > 7) {
                return res.status(400).json({ success: false, message: 'entityId must be 0-7' });
            }

            if (name && name.length > 20) {
                return res.status(400).json({ success: false, message: 'Name must be 20 characters or less' });
            }

            const deviceId = account.device_id;
            const device = devices[deviceId];
            if (!device) {
                return res.status(404).json({ success: false, message: 'Device not found' });
            }

            const entity = device.entities[eId];
            if (!entity) {
                return res.status(400).json({ success: false, message: `Entity slot ${eId} not available` });
            }

            // If already bound via channel, return existing credentials
            if (entity.isBound && entity.bindingType === 'channel') {
                return res.json({
                    success: true,
                    message: 'Entity already bound via channel',
                    deviceId,
                    entityId: eId,
                    botSecret: entity.botSecret,
                    publicCode: entity.publicCode,
                    bindingType: 'channel'
                });
            }

            // Don't allow binding over an existing non-channel binding
            if (entity.isBound) {
                return res.status(409).json({
                    success: false,
                    message: 'Entity already bound. Unbind first via DELETE /api/entity/:entityId'
                });
            }

            // Bind the entity
            const botSecret = generateBotSecret();
            const publicCode = generatePublicCode();

            entity.isBound = true;
            entity.botSecret = botSecret;
            entity.publicCode = publicCode;
            entity.bindingType = 'channel';
            publicCodeIndex[publicCode] = { deviceId, entityId: eId };
            entity.name = name || null;
            entity.state = 'IDLE';
            entity.message = 'Connected via OpenClaw channel!';
            entity.lastUpdated = Date.now();

            saveData();
            serverLog('info', 'bind', `Entity ${eId} bound via channel plugin`, { deviceId, entityId: eId });

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

            if (!channel_api_key || !deviceId || entityId === undefined || !botSecret) {
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
    async function pushToChannelCallback(deviceId, entityId, payload) {
        const account = await db.getChannelAccountByDevice(deviceId);
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
