/**
 * telegram-integration.js
 * Telegram Bot polling adapter for EClaw entities (PoC).
 *
 * Flow:
 *  1. Device stores TELEGRAM_BOT_TOKEN + TELEGRAM_TARGET_ENTITY_ID + TELEGRAM_ALLOWED_USERS in vault
 *  2. On boot (and every 5 min thereafter) we scan device_vars for the trio and start a long-poll worker
 *  3. Worker GET /getUpdates with timeout=30 → for each update, whitelist-check sender then pushToBot
 *  4. handleTransformFollowup forwards bot replies back to the most-recent chat_id via sendMessage
 *
 * PoC scope (intentional gaps tracked in card_406e612942ff062a06fc47be):
 *   - In-memory pendingChats; lost on restart
 *   - One bot per device; first-vault wins
 *   - No /status, /mission slash commands yet — plain text only, all goes to TARGET_ENTITY
 *   - No webhook mode; long-polling only (matches Hank: "Telegram polling 先做")
 */

'use strict';

const express = require('express');

const TELEGRAM_API = 'https://api.telegram.org';
const POLL_TIMEOUT_S = 30;
const VAULT_REFRESH_MS = 5 * 60 * 1000;

// ── Telegram REST helpers ────────────────────────────────────────────────────
async function tgApi(botToken, method, body) {
    const opts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
    };
    const resp = await fetch(`${TELEGRAM_API}/bot${botToken}/${method}`, opts);
    const text = await resp.text();
    try { return { ok: resp.ok, status: resp.status, data: JSON.parse(text) }; }
    catch { return { ok: resp.ok, status: resp.status, data: text }; }
}

// ── Update normalizer (pure function, unit-tested) ───────────────────────────
// Returns { senderId, senderName, text, chatId, isCommand } or null when un-handleable.
function normalizeUpdate(update) {
    if (!update || typeof update !== 'object') return null;
    const msg = update.message || update.edited_message;
    if (!msg || !msg.from || !msg.chat) return null;
    const text = (msg.text || msg.caption || '').toString();
    if (!text) return null;
    return {
        senderId: msg.from.id,
        senderName: msg.from.username || msg.from.first_name || `tg_${msg.from.id}`,
        text,
        chatId: msg.chat.id,
        isCommand: text.startsWith('/'),
        updateId: update.update_id
    };
}

// ── Whitelist check (pure) ───────────────────────────────────────────────────
// allowedCsv = "111,222,333"  → set of strings; empty means ALLOW NONE.
function isAllowed(allowedCsv, senderId) {
    if (!allowedCsv || typeof allowedCsv !== 'string') return false;
    const allowed = new Set(allowedCsv.split(',').map(s => s.trim()).filter(Boolean));
    return allowed.has(String(senderId));
}

// ── Module factory ───────────────────────────────────────────────────────────
module.exports = function telegramIntegration(devices, { db, decryptVars, serverLog, pushToBot }) {
    const router = express.Router();

    // deviceId → { token, targetEntityId, allowedUsers, abort, lastUpdateId, latestChatId }
    const workers = new Map();

    function entityKey(deviceId, entityId) { return `${deviceId}:${entityId}`; }

    // entityKey → chatId of most recent inbound message (for outbound followups).
    const pendingChats = new Map();

    // ── Read vault for a device; return {token,target,allowed} or null ───────
    async function readDeviceTelegramVars(deviceId) {
        if (!db || !db.getDeviceVars) return null;
        const row = await db.getDeviceVars(deviceId);
        if (!row || !row.encrypted_vars || row.is_locked) return null;
        let vars;
        try { vars = decryptVars(row.encrypted_vars, row.iv, row.auth_tag); }
        catch { return null; }
        const token = vars.TELEGRAM_BOT_TOKEN;
        const target = vars.TELEGRAM_TARGET_ENTITY_ID;
        const allowed = vars.TELEGRAM_ALLOWED_USERS || '';
        if (!token || target === undefined) return null;
        return { token, targetEntityId: parseInt(target), allowedUsers: String(allowed) };
    }

    // ── Worker: long-poll loop for one device ────────────────────────────────
    async function pollLoop(deviceId) {
        const w = workers.get(deviceId);
        if (!w) return;
        while (!w.abort.aborted) {
            try {
                const result = await tgApi(w.token, 'getUpdates', {
                    offset: w.lastUpdateId + 1,
                    timeout: POLL_TIMEOUT_S,
                    allowed_updates: ['message', 'edited_message']
                });
                if (!result.ok || !result.data || !result.data.ok) {
                    serverLog('warn', 'telegram', `getUpdates failed for ${deviceId}: ${result.status}`, { deviceId });
                    await sleep(5000);
                    continue;
                }
                const updates = result.data.result || [];
                for (const update of updates) {
                    w.lastUpdateId = Math.max(w.lastUpdateId, update.update_id);
                    await handleUpdate(deviceId, update);
                }
            } catch (e) {
                serverLog('warn', 'telegram', `pollLoop error for ${deviceId}: ${e.message}`, { deviceId });
                await sleep(5000);
            }
        }
        serverLog('info', 'telegram', `pollLoop stopped for ${deviceId}`, { deviceId });
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ── Handle one Telegram update ───────────────────────────────────────────
    async function handleUpdate(deviceId, update) {
        const w = workers.get(deviceId);
        if (!w) return;
        const norm = normalizeUpdate(update);
        if (!norm) return;

        // Whitelist gate
        if (!isAllowed(w.allowedUsers, norm.senderId)) {
            await tgApi(w.token, 'sendMessage', {
                chat_id: norm.chatId,
                text: `⚠️ Not authorized. Your Telegram user_id is ${norm.senderId}; ask the device owner to add it to TELEGRAM_ALLOWED_USERS.`
            });
            serverLog('info', 'telegram', `Rejected unauthorized sender ${norm.senderId}`, { deviceId });
            return;
        }

        const device = devices[deviceId];
        const entity = device && device.entities[w.targetEntityId];
        if (!entity || !entity.isBound) {
            await tgApi(w.token, 'sendMessage', {
                chat_id: norm.chatId,
                text: '⚠️ Target entity is not active on this device.'
            });
            return;
        }

        // /start handler
        if (norm.text.trim() === '/start') {
            await tgApi(w.token, 'sendMessage', {
                chat_id: norm.chatId,
                text: `✅ Connected to ${entity.name || `Entity ${w.targetEntityId}`}. Send any message to talk.`
            });
            return;
        }

        // Strip leading slash command for /ask
        let pushText = norm.text;
        if (norm.isCommand) {
            const m = norm.text.match(/^\/(\w+)(?:\s+(.*))?$/s);
            if (m && m[1] === 'ask' && m[2]) pushText = m[2];
            else if (m && m[1] !== 'ask') {
                await tgApi(w.token, 'sendMessage', {
                    chat_id: norm.chatId,
                    text: `Unknown command /${m[1]}. Send a plain message or use /ask <text>.`
                });
                return;
            }
        }

        const message = `[Telegram] ${norm.senderName}: ${pushText}`;
        pendingChats.set(entityKey(deviceId, w.targetEntityId), {
            chatId: norm.chatId,
            timestamp: Date.now()
        });

        try {
            await pushToBot(entity, deviceId, 'new_message', { message });
            serverLog('info', 'telegram', `Pushed update from ${norm.senderName} → entity ${w.targetEntityId}`, { deviceId });
        } catch (e) {
            serverLog('warn', 'telegram', `pushToBot failed: ${e.message}`, { deviceId });
            await tgApi(w.token, 'sendMessage', {
                chat_id: norm.chatId,
                text: '⚠️ Failed to reach entity. Try again shortly.'
            });
        }
    }

    // ── Start / stop / refresh workers ───────────────────────────────────────
    async function startWorker(deviceId, vars) {
        if (workers.has(deviceId)) return;
        workers.set(deviceId, {
            token: vars.token,
            targetEntityId: vars.targetEntityId,
            allowedUsers: vars.allowedUsers,
            abort: { aborted: false },
            lastUpdateId: 0,
            latestChatId: null
        });
        serverLog('info', 'telegram', `Started Telegram worker for ${deviceId} → entity ${vars.targetEntityId}`, { deviceId });
        pollLoop(deviceId).catch(e => serverLog('error', 'telegram', `pollLoop crashed: ${e.message}`, { deviceId }));
    }

    function stopWorker(deviceId) {
        const w = workers.get(deviceId);
        if (!w) return;
        w.abort.aborted = true;
        workers.delete(deviceId);
    }

    async function refreshAllWorkers() {
        if (!db || !db.query) return;
        try {
            const rows = await db.query('SELECT device_id FROM device_vars WHERE is_locked = false');
            const known = new Set(workers.keys());
            for (const r of rows.rows) {
                const deviceId = r.device_id;
                const vars = await readDeviceTelegramVars(deviceId);
                if (!vars) {
                    if (workers.has(deviceId)) stopWorker(deviceId);
                    continue;
                }
                const w = workers.get(deviceId);
                if (w && (w.token !== vars.token || w.targetEntityId !== vars.targetEntityId)) {
                    stopWorker(deviceId);
                }
                if (!workers.has(deviceId)) await startWorker(deviceId, vars);
                else {
                    // Still alive — update whitelist in case it changed
                    workers.get(deviceId).allowedUsers = vars.allowedUsers;
                }
                known.delete(deviceId);
            }
            // Devices that no longer have vault config should stop
            for (const stale of known) stopWorker(stale);
        } catch (e) {
            serverLog('warn', 'telegram', `refreshAllWorkers failed: ${e.message}`, {});
        }
    }

    // ── Outbound: bot reply → Telegram sendMessage ───────────────────────────
    async function handleTransformFollowup(deviceId, entityId, message) {
        const key = entityKey(deviceId, entityId);
        const pending = pendingChats.get(key);
        if (!pending) return;
        const w = workers.get(deviceId);
        if (!w) return;
        // Telegram message limit is 4096 chars
        const text = message.length > 4096 ? message.slice(0, 4093) + '…' : message;
        try {
            await tgApi(w.token, 'sendMessage', { chat_id: pending.chatId, text });
        } catch (e) {
            serverLog('warn', 'telegram', `sendMessage failed: ${e.message}`, { deviceId, entityId });
        }
    }

    // ── Status endpoint for diagnostics ──────────────────────────────────────
    router.get('/status', (req, res) => {
        const summary = [];
        for (const [deviceId, w] of workers.entries()) {
            summary.push({
                deviceId,
                targetEntityId: w.targetEntityId,
                allowedUserCount: (w.allowedUsers || '').split(',').filter(Boolean).length,
                lastUpdateId: w.lastUpdateId
            });
        }
        res.json({ success: true, workers: summary });
    });

    // Boot: kick off first refresh + interval
    refreshAllWorkers();
    const intervalHandle = setInterval(refreshAllWorkers, VAULT_REFRESH_MS);

    return {
        router,
        handleTransformFollowup,
        // Test hooks (exported for jest)
        _internal: { normalizeUpdate, isAllowed, workers, pendingChats, refreshAllWorkers, intervalHandle }
    };
};

// Export pure functions at the module level for direct testing
module.exports.normalizeUpdate = normalizeUpdate;
module.exports.isAllowed = isAllowed;
