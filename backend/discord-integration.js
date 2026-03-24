/**
 * discord-integration.js
 * Native Discord slash command integration for EClaw entities.
 *
 * Flow:
 *  1. User registers Discord Application (app_id, public_key, bot_token) per entity
 *  2. EClaw provides POST /api/discord/interactions as the Interactions Endpoint URL
 *  3. Discord slash commands (/ask, /status, /mission) are verified + forwarded to entity webhook
 *  4. Deferred response (type:5 "thinking…") is returned to Discord immediately
 *  5. When the entity bot responds via POST /api/transform, a followup edit is sent to Discord
 */

'use strict';

const express = require('express');
const crypto = require('crypto');

// ── Ed25519 signature verification ──────────────────────────────────────────
// Discord signs every interaction request; reject anything that fails.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex'); // ASN.1 prefix for raw Ed25519 public key

function verifyDiscordSignature(publicKeyHex, signatureHex, timestamp, rawBody) {
    try {
        const keyDer = Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]);
        const keyObj = crypto.createPublicKey({ key: keyDer, format: 'der', type: 'spki' });
        const msg = Buffer.concat([Buffer.from(timestamp), Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody)]);
        return crypto.verify(null, msg, keyObj, Buffer.from(signatureHex, 'hex'));
    } catch {
        return false;
    }
}

// ── Discord REST helpers ─────────────────────────────────────────────────────
const DISCORD_API = 'https://discord.com/api/v10';

async function discordApi(method, path, botToken, body) {
    const opts = {
        method,
        headers: {
            'Authorization': `Bot ${botToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'EClawbot (https://eclawbot.com, 1.0)'
        }
    };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${DISCORD_API}${path}`, opts);
    const text = await resp.text();
    try { return { ok: resp.ok, status: resp.status, data: JSON.parse(text) }; }
    catch { return { ok: resp.ok, status: resp.status, data: text }; }
}

// Register application-level slash commands (global scope or guild-scoped)
async function registerSlashCommands(applicationId, botToken, guildId) {
    const commands = [
        {
            name: 'ask',
            description: 'Send a message to this EClaw entity',
            options: [{ name: 'message', description: 'Your message', type: 3, required: true }]
        },
        {
            name: 'status',
            description: 'Show the current status of this EClaw entity'
        },
        {
            name: 'mission',
            description: 'Create a mission task for this entity',
            options: [{ name: 'title', description: 'Mission title', type: 3, required: true }]
        }
    ];

    const route = guildId
        ? `/applications/${applicationId}/guilds/${guildId}/commands`
        : `/applications/${applicationId}/commands`;

    return discordApi('PUT', route, botToken, commands);
}

// Send or edit the deferred response (the "thinking..." placeholder)
async function sendInteractionFollowup(applicationId, interactionToken, content, embeds) {
    const body = { content: content || '', embeds: embeds || [] };
    return discordApi(
        'PATCH',
        `/webhooks/${applicationId}/${interactionToken}/messages/@original`,
        null, // no bot token needed for webhook followup
        body
    ).catch(() => null); // fire-and-forget; don't block
}

// ── Module factory ───────────────────────────────────────────────────────────
module.exports = function discordIntegration(devices, { db, authMiddleware, serverLog, pushToBot, apiBase }) {
    const router = express.Router();

    /**
     * Pending interaction map: entityKey → { token, applicationId, channelId, timestamp, guildId }
     * Cleaned up after 14 minutes (Discord interaction tokens expire at 15 min).
     */
    const pendingInteractions = new Map();
    const INTERACTION_TTL_MS = 14 * 60 * 1000;

    function entityKey(deviceId, entityId) { return `${deviceId}:${entityId}`; }

    function cleanupExpired() {
        const now = Date.now();
        for (const [key, val] of pendingInteractions.entries()) {
            if (now - val.timestamp > INTERACTION_TTL_MS) pendingInteractions.delete(key);
        }
    }
    setInterval(cleanupExpired, 60 * 1000);

    // ── Load all Discord bot configs from DB into a lookup map ───────────────
    // applicationId → { deviceId, entityId, botToken, publicKey, guildId }
    const appIndex = new Map();

    async function loadAppIndex() {
        try {
            const rows = await db.query('SELECT * FROM discord_bots');
            appIndex.clear();
            for (const r of rows.rows) {
                appIndex.set(r.application_id, r);
            }
        } catch (e) {
            // Table may not exist yet during first boot — silently skip
        }
    }
    loadAppIndex();

    // ── GET /api/discord/apps — list Discord apps for device ─────────────────
    router.get('/apps', authMiddleware, async (req, res) => {
        const deviceId = req.user?.deviceId;
        if (!deviceId) return res.status(401).json({ success: false, error: 'Unauthorized' });

        try {
            const rows = await db.query(
                'SELECT id, entity_id, application_id, guild_id, created_at FROM discord_bots WHERE device_id = $1 ORDER BY created_at DESC',
                [deviceId]
            );
            res.json({ success: true, apps: rows.rows });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── POST /api/discord/apps — register a Discord application to an entity ─
    router.post('/apps', authMiddleware, async (req, res) => {
        const deviceId = req.user?.deviceId;
        if (!deviceId) return res.status(401).json({ success: false, error: 'Unauthorized' });

        const { entityId, applicationId, publicKey, botToken, guildId } = req.body;
        if (!entityId == null || !applicationId || !publicKey || !botToken) {
            return res.status(400).json({ success: false, error: 'entityId, applicationId, publicKey, and botToken are required' });
        }
        if (!/^[0-9a-fA-F]{64}$/.test(publicKey)) {
            return res.status(400).json({ success: false, error: 'publicKey must be a 64-character hex string' });
        }

        const eId = parseInt(entityId);
        const device = devices[deviceId];
        if (!device) return res.status(404).json({ success: false, error: 'Device not found' });
        if (!device.entities[eId]) return res.status(404).json({ success: false, error: `Entity ${eId} not found` });

        try {
            await db.query(
                `INSERT INTO discord_bots (device_id, entity_id, application_id, public_key, bot_token, guild_id)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (device_id, entity_id) DO UPDATE
                 SET application_id = EXCLUDED.application_id,
                     public_key     = EXCLUDED.public_key,
                     bot_token      = EXCLUDED.bot_token,
                     guild_id       = EXCLUDED.guild_id,
                     created_at     = NOW()`,
                [deviceId, eId, applicationId, publicKey, botToken, guildId || null]
            );
            await loadAppIndex();

            // Register slash commands with Discord
            const cmdResult = await registerSlashCommands(applicationId, botToken, guildId || null);

            serverLog('info', 'discord', `Discord app registered: appId=${applicationId} entity=${eId}`, { deviceId, entityId: eId });
            res.json({
                success: true,
                interactionsEndpointUrl: `${apiBase}/api/discord/interactions`,
                commandsRegistered: cmdResult.ok,
                commandsStatus: cmdResult.status
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── DELETE /api/discord/apps/:entityId — remove Discord app ─────────────
    router.delete('/apps/:entityId', authMiddleware, async (req, res) => {
        const deviceId = req.user?.deviceId;
        if (!deviceId) return res.status(401).json({ success: false, error: 'Unauthorized' });

        const eId = parseInt(req.params.entityId);
        try {
            await db.query('DELETE FROM discord_bots WHERE device_id = $1 AND entity_id = $2', [deviceId, eId]);
            await loadAppIndex();
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── POST /api/discord/apps/:entityId/commands — (re)register slash commands
    router.post('/apps/:entityId/commands', authMiddleware, async (req, res) => {
        const deviceId = req.user?.deviceId;
        if (!deviceId) return res.status(401).json({ success: false, error: 'Unauthorized' });

        const eId = parseInt(req.params.entityId);
        try {
            const row = await db.query(
                'SELECT * FROM discord_bots WHERE device_id = $1 AND entity_id = $2',
                [deviceId, eId]
            );
            if (row.rows.length === 0) return res.status(404).json({ success: false, error: 'No Discord app registered for this entity' });

            const { application_id, bot_token, guild_id } = row.rows[0];
            const result = await registerSlashCommands(application_id, bot_token, guild_id);
            res.json({ success: result.ok, status: result.status, commands: result.data });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── POST /api/discord/interactions — Discord sends all interactions here ─
    // Note: express.json() already parsed the body in index.js.
    // We use req.rawBody (set by verify callback) or re-serialize for sig verification.
    router.post('/interactions', async (req, res) => {
        const signature = req.headers['x-signature-ed25519'];
        const timestamp = req.headers['x-signature-timestamp'];

        if (!signature || !timestamp) {
            return res.status(401).json({ error: 'Missing signature headers' });
        }

        const interaction = req.body;
        if (!interaction || !interaction.application_id) {
            return res.status(400).json({ error: 'Invalid request body' });
        }

        // Re-serialize for signature verification (Discord signs the raw JSON body)
        const rawBody = req.rawBody || JSON.stringify(interaction);

        // Look up the app config by application_id
        const appConfig = appIndex.get(interaction.application_id);
        if (!appConfig) {
            return res.status(401).json({ error: 'Unknown application' });
        }

        // Verify signature
        if (!verifyDiscordSignature(appConfig.public_key, signature, timestamp, rawBody)) {
            return res.status(401).json({ error: 'Invalid signature' });
        }

        // ── Type 1: PING — Discord verifies the endpoint ──────────────────
        if (interaction.type === 1) {
            return res.json({ type: 1 });
        }

        // ── Type 2: APPLICATION_COMMAND (slash command) ───────────────────
        if (interaction.type === 2) {
            const { device_id: deviceId, entity_id: dbEntityId } = appConfig;
            const eId = parseInt(dbEntityId);
            const device = devices[deviceId];
            const entity = device && device.entities[eId];

            if (!entity || !entity.isBound) {
                return res.json({
                    type: 4,
                    data: { content: '⚠️ This entity is not currently active.' }
                });
            }

            const commandName = interaction.data?.name;
            const options = interaction.data?.options || [];
            const getOpt = (name) => options.find(o => o.name === name)?.value || '';
            const user = interaction.member?.user || interaction.user;
            const username = user?.username || 'someone';

            // /status — immediate response (no deferred needed)
            if (commandName === 'status') {
                const stateEmoji = { 'IDLE': '😊', 'BUSY': '💼', 'SLEEPING': '😴' };
                const embed = {
                    title: entity.name || `Entity ${eId}`,
                    description: entity.message || '_No recent message_',
                    color: entity.state === 'IDLE' ? 0x6C63FF : entity.state === 'BUSY' ? 0xFFA000 : 0x607D8B,
                    fields: [
                        { name: 'State', value: `${stateEmoji[entity.state] || '🤖'} ${entity.state || 'IDLE'}`, inline: true },
                        { name: 'Character', value: entity.character || '?', inline: true },
                        { name: 'Level', value: String(entity.level || 1), inline: true }
                    ],
                    footer: { text: `EClawbot · ${entity.publicCode ? `@${entity.publicCode}` : ''}` }
                };
                if (entity.avatar && entity.avatar.startsWith('https://')) {
                    embed.thumbnail = { url: entity.avatar };
                }
                return res.json({ type: 4, data: { embeds: [embed] } });
            }

            // /ask and /mission — deferred response, then push to entity
            let pushMessage;
            if (commandName === 'ask') {
                const message = getOpt('message');
                pushMessage = `[Discord] ${username}: ${message}`;
            } else if (commandName === 'mission') {
                const title = getOpt('title');
                pushMessage = `[Discord Mission] ${username} created a mission: ${title}`;
            } else {
                return res.json({ type: 4, data: { content: '❓ Unknown command.' } });
            }

            // Store pending interaction before responding
            pendingInteractions.set(entityKey(deviceId, eId), {
                token: interaction.token,
                applicationId: interaction.application_id,
                channelId: interaction.channel_id,
                guildId: interaction.guild_id,
                timestamp: Date.now()
            });

            // Return deferred response immediately (Discord shows "bot is thinking…")
            res.json({ type: 5 });

            // Push message to entity webhook (fire-and-forget)
            setImmediate(async () => {
                try {
                    await pushToBot(entity, deviceId, 'new_message', { message: pushMessage });
                    serverLog('info', 'discord', `Slash /${commandName} pushed to entity ${eId}`, { deviceId, entityId: eId });
                } catch (e) {
                    serverLog('warn', 'discord', `Slash push failed: ${e.message}`, { deviceId, entityId: eId });
                    // Send error followup so Discord doesn't hang
                    await sendInteractionFollowup(
                        interaction.application_id, interaction.token,
                        '⚠️ Failed to reach entity. Please try again.'
                    );
                    pendingInteractions.delete(entityKey(deviceId, eId));
                }
            });

            return; // Response already sent above
        }

        // ── Type 3: MESSAGE_COMPONENT (button/select interaction) ─────────
        if (interaction.type === 3) {
            const { device_id: deviceId, entity_id: dbEntityId } = appConfig;
            const eId = parseInt(dbEntityId);
            const device = devices[deviceId];
            const entity = device && device.entities[eId];
            const customId = interaction.data?.custom_id || '';
            const user = interaction.member?.user || interaction.user;
            const username = user?.username || 'someone';

            if (!entity || !entity.isBound) {
                return res.json({ type: 4, data: { content: '⚠️ Entity is not active.' } });
            }

            pendingInteractions.set(entityKey(deviceId, eId), {
                token: interaction.token,
                applicationId: interaction.application_id,
                timestamp: Date.now()
            });

            res.json({ type: 5 });

            setImmediate(async () => {
                try {
                    await pushToBot(entity, deviceId, 'new_message', {
                        message: `[Discord Button] ${username} clicked: ${customId}`
                    });
                } catch (e) {
                    await sendInteractionFollowup(interaction.application_id, interaction.token, '⚠️ Action failed.');
                    pendingInteractions.delete(entityKey(deviceId, eId));
                }
            });

            return;
        }

        // Unknown interaction type
        res.status(400).json({ error: 'Unsupported interaction type' });
    });

    // ── handleTransformFollowup — called from index.js after transform saves ─
    // When an entity bot responds via /api/transform, we forward the reply to Discord.
    async function handleTransformFollowup(deviceId, entityId, message, entityName) {
        const key = entityKey(deviceId, entityId);
        const pending = pendingInteractions.get(key);
        if (!pending) return;

        pendingInteractions.delete(key);

        const embed = {
            description: message.length > 4096 ? message.slice(0, 4093) + '…' : message,
            color: 0x6C63FF,
            footer: { text: `${entityName || `Entity ${entityId}`} · EClawbot` }
        };

        try {
            await sendInteractionFollowup(pending.applicationId, pending.token, '', [embed]);
        } catch (e) {
            // Non-critical
        }
    }

    return { router, handleTransformFollowup };
};
