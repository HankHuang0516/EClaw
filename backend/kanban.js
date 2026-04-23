/**
 * Mission Center v2 — Kanban Board API
 *
 * Mounted at: /api/mission  (alongside existing mission.js routes)
 *
 * Cards CRUD:
 *   POST   /card          — Create card
 *   GET    /cards          — List cards (filter by status, archived)
 *   GET    /card/:id       — Get card detail (with comments, notes, files)
 *   PUT    /card/:id       — Update card fields
 *   DELETE /card/:id       — Archive card
 *
 * Status transition:
 *   POST   /card/:id/move  — Move card to new status + reassign
 *
 * Comments (留言板):
 *   GET    /card/:id/comments
 *   POST   /card/:id/comment
 *
 * Notes (筆記區):
 *   GET    /card/:id/notes
 *   POST   /card/:id/note
 *
 * Files (檔案區):
 *   POST   /card/:id/file       (URL-based, not multipart for now)
 *   GET    /card/:id/files
 *
 * Config:
 *   PUT    /card/:id/config     — Update staleThresholdMs / doneRetentionMs
 *
 * Archived:
 *   GET    /cards/archived      — List archived cards (paginated)
 */

const express = require('express');
const { Pool } = require('pg');
const _crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const safeEqual = require('./safe-equal');
const { newCardId } = require('./entity-id');
const { tKanban, statusLabel } = require('./i18n/kanban-notifications');

// Cache device→language to avoid repeated lookups
const deviceLangCache = new Map();
const DEVICE_LANG_TTL_MS = 60_000;
async function getDeviceLanguage(deviceId) {
    const cached = deviceLangCache.get(deviceId);
    if (cached && cached.expires > Date.now()) return cached.lang;
    try {
        const result = await pool.query(
            'SELECT language FROM user_accounts WHERE device_id = $1 LIMIT 1',
            [deviceId]
        );
        const lang = result.rows[0]?.language || 'en';
        deviceLangCache.set(deviceId, { lang, expires: Date.now() + DEVICE_LANG_TTL_MS });
        return lang;
    } catch (err) {
        console.warn('[Kanban] getDeviceLanguage failed for', deviceId, ':', err.message);
        return 'en';
    }
}
let CronExpressionParser;
try {
    ({ CronExpressionParser } = require('cron-parser'));
} catch (e) {
    console.warn('[Kanban] cron-parser not available — schedule features disabled');
    CronExpressionParser = null;
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

// Valid statuses in order
const STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done', 'blocked'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const STATUS_LABELS = {
    backlog: 'Backlog',
    todo: 'TODO',
    in_progress: 'In Progress',
    review: 'Review',
    done: 'Done'
};
const PRIORITY_COLORS = { P0: '🔴', P1: '🟠', P2: '🔵', P3: '⚪' };

// ── Schema init ──
async function initKanbanDatabase() {
    try {
        const schemaPath = path.join(__dirname, 'kanban_schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        // Remove SQL comments before splitting (-- line comments and block separators)
        const cleaned = schema.replace(/--[^\n]*/g, '').replace(/\n\s*\n/g, '\n');
        const statements = cleaned
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 5);
        console.log(`[Kanban] Schema init: ${statements.length} statements to execute`);
        let ok = 0, skipped = 0, failed = 0;
        for (let i = 0; i < statements.length; i++) {
            const stmt = statements[i];
            const preview = stmt.split('\n')[0].trim().substring(0, 60);
            try {
                await pool.query(stmt);
                ok++;
                console.log(`[Kanban] Schema [${i+1}/${statements.length}] OK: ${preview}`);
            } catch (err) {
                if (err.message.includes('already exists') || err.message.includes('duplicate key')) {
                    skipped++;
                } else {
                    failed++;
                    console.error(`[Kanban] Schema [${i+1}/${statements.length}] FAILED: ${preview}`);
                    console.error(`[Kanban]   Error: ${err.message}`);
                }
            }
        }
        console.log(`[Kanban] Database initialized: ${ok} OK, ${skipped} skipped (already exist), ${failed} failed`);
    } catch (error) {
        console.error('[Kanban] Failed to init database:', error);
    }
}

/**
 * Factory: receives in-memory devices object from index.js
 */
module.exports = function (devices, { awardEntityXP, serverLog, pushToEntity, pushToChannelCallback, saveChatMessage, getMissionApiHints, pushToBot, orgChart } = {}) {
    const router = express.Router();

    // Health check
    router.get("/kanban-health", (req, res) => res.json({ ok: true, module: "kanban", cron: !!CronExpressionParser }));

    // ── Auth helpers (same as mission.js) ──
    function findEntityByCredentials(deviceId, entityId, botSecret) {
        const device = devices[deviceId];
        if (!device) return null;
        const entity = (device.entities || {})[entityId];
        if (!entity || !safeEqual(entity.botSecret, botSecret)) return null;
        return entity;
    }

    function findDeviceByCredentials(deviceId, deviceSecret) {
        const device = devices[deviceId];
        if (!device || !safeEqual(device.deviceSecret, deviceSecret)) return null;
        return device;
    }

    function authenticate(req, res) {
        const params = { ...req.query, ...req.body };
        const { deviceId, deviceSecret, botSecret, entityId } = params;

        if (!deviceId) {
            res.status(400).json({ success: false, error: 'Missing deviceId' });
            return false;
        }

        if (deviceSecret) {
            const device = findDeviceByCredentials(deviceId, deviceSecret);
            if (device) return true;
        }

        if (botSecret) {
            const entity = findEntityByCredentials(deviceId, parseInt(entityId || 0), botSecret);
            if (entity) return true;
        }

        if (!deviceSecret && !botSecret) {
            res.status(400).json({ success: false, error: 'Missing deviceSecret or botSecret' });
        } else {
            console.warn('[Kanban] Auth failed:', { deviceId, hasDeviceSecret: !!deviceSecret, hasBotSecret: !!botSecret, entityId });
            res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
        return false;
    }

    // ── Helper: bump dashboard version (to trigger frontend refresh) ──
    async function bumpVersion(deviceId) {
        try {
            await pool.query(
                `UPDATE mission_dashboard SET updated_at = NOW() WHERE device_id = $1`,
                [deviceId]
            );
        } catch (e) {
            console.warn('[Kanban] Failed to bump version:', e.message);
        }
    }

    // ── Helper: add system comment to card ──
    // Bumps kanban_cards.updated_at so "Recently Updated" sort surfaces the card.
    async function addSystemComment(cardId, deviceId, text) {
        await pool.query(
            `INSERT INTO kanban_comments (card_id, device_id, from_entity_id, text, is_system)
             VALUES ($1, $2, -1, $3, true)`,
            [cardId, deviceId, text]
        );
        await pool.query(
            `UPDATE kanban_cards SET updated_at = NOW() WHERE id = $1 AND device_id = $2`,
            [cardId, deviceId]
        );
    }

    // ── Helper: push notification to entity via channel callback + save to chat ──
    async function notifyEntities(deviceId, entityIds, message, options = {}) {
        const { description, cardId } = options;
        if (!pushToChannelCallback && !pushToEntity && !pushToBot) {
            console.warn('[Kanban] No push callback available — notifications will not be delivered');
            return;
        }

        const API_BASE = 'https://eclawbot.com';
        const SOURCE_TAG = 'kanban_notify';

        for (const eid of entityIds) {
            try {
                const device = devices[deviceId];
                const entity = device?.entities?.[eid];
                if (!entity) {
                    console.warn(`[Kanban] Entity ${eid} not found on device ${deviceId}`);
                    continue;
                }

                // ── 1. Save to chat history (chat.html visibility) ──
                // If cardId is provided, attach { kind: 'kanban_ref', id } to the `card`
                // column so chat.html can render a clickable "view card" button that
                // opens the entity modal without the user navigating to the kanban page.
                let chatMsgId = null;
                if (saveChatMessage) {
                    try {
                        const cardRef = cardId ? { kind: 'kanban_ref', id: cardId } : null;
                        chatMsgId = await saveChatMessage(
                            deviceId, eid, message,
                            SOURCE_TAG,
                            false,  // is_from_user
                            false,  // is_from_bot (platform notification)
                            null, null,   // mediaType, mediaUrl
                            null, null,   // scheduleId, scheduleLabel
                            null, null,   // backupUrl, mentions
                            cardRef       // card
                        );
                        console.log(`[Kanban] Saved kanban notify to chat history: msgId=${chatMsgId} entity=${eid}`);
                    } catch (e) {
                        console.error(`[Kanban] Failed to save chat message for entity ${eid}:`, e.message);
                    }
                }

                // ── 2. Build standard Mission + Kanban API hints ──
                // Note: getMissionApiHints already embeds [AVAILABLE TOOLS — Kanban Board]
                // (read/move/comment/disable schedule/enable schedule), so we no longer
                // append a second Kanban Board block here.
                const kanbanHints = getMissionApiHints
                    ? getMissionApiHints(API_BASE, deviceId, eid, entity.botSecret)
                    : '';

                // ── 3. Build full message with description ──
                const descBlock = description
                    ? `\n\n[TASK DESCRIPTION]\n${description}\n[/TASK DESCRIPTION]`
                    : '';

                // ── 4. Push to bot (channel or webhook, with standard hints) ──
                if (entity.bindingType === 'channel' && pushToChannelCallback) {
                    const result = await pushToChannelCallback(deviceId, eid, {
                        event: 'kanban_notification',
                        from: 'kanban',
                        text: message + descBlock,
                        eclaw_context: {
                            silentToken: '[SILENT]',
                            missionHints: kanbanHints,
                        }
                    }, entity.channelAccountId);
                    console.log(`[Kanban] Channel push to entity ${eid}: ${result.pushed ? 'OK' : result.reason}`);

                } else if (entity.webhook && pushToBot) {
                    // Non-channel: build full push message with standard hints (same as speak-to webhook path)
                    const pushMsg = [
                        `[KANBAN NOTIFICATION] ${message}`,
                        descBlock,
                        `[NOTIFICATION — NO REPLY EXPECTED] This is a Kanban task notification. Take action on the card as needed.`,
                        kanbanHints,
                    ].filter(Boolean).join('\n');

                    const pushResult = await pushToBot(entity, deviceId, 'kanban_notification', { message: pushMsg });
                    console.log(`[Kanban] Webhook push to entity ${eid}: ${pushResult.pushed ? 'OK' : pushResult.reason}`);

                    // Mark delivered if push succeeded
                    if (pushResult.pushed && chatMsgId) {
                        // No markChatMessageDelivered reference here — just log
                        console.log(`[Kanban] Webhook delivered to entity ${eid}, chatMsgId=${chatMsgId}`);
                    }

                } else if (pushToEntity) {
                    // Legacy fallback
                    const pushMsg = `[KANBAN NOTIFICATION] ${message}${descBlock}${kanbanHints}`;
                    await pushToEntity(deviceId, eid, pushMsg);
                    console.log(`[Kanban] Legacy push to entity ${eid}`);
                }

            } catch (e) {
                console.error(`[Kanban] Failed to push to entity ${eid}:`, e.message);
            }
        }
    }

    // ── Helper: compute next cron run time ──
    function computeNextRun(cronExpression, timezone) {
        try {
            if (!CronExpressionParser) return null;
            const expr = CronExpressionParser.parse(cronExpression, { tz: timezone || 'Asia/Taipei' });
            return expr.next().toDate();
        } catch (e) {
            console.warn('[Kanban] Invalid cron expression:', cronExpression, e.message);
            return null;
        }
    }

    // ── Helper: serialize card row to API response ──
    function serializeCard(row) {
        const card = {
            id: row.id,
            title: row.title,
            description: row.description || '',
            priority: row.priority,
            status: row.status,
            assignedBots: row.assigned_bots || [],
            createdBy: row.created_by,
            statusChangedAt: row.status_changed_at ? new Date(row.status_changed_at).getTime() : null,
            staleThresholdMs: parseInt(row.stale_threshold_ms) || 10800000,
            doneRetentionMs: parseInt(row.done_retention_ms) || 604800000,
            archived: row.archived || false,
            createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
            updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
            reviewerEntityId: row.reviewer_entity_id != null ? parseInt(row.reviewer_entity_id) : null,
            // Aggregated counts (if present from JOIN)
            commentCount: parseInt(row.comment_count) || 0,
            noteCount: parseInt(row.note_count) || 0,
            fileCount: parseInt(row.file_count) || 0,
        };

        // Schedule fields — always include if schedule was ever configured
        if (row.schedule_enabled || row.schedule_type || row.schedule_last_run_at) {
            card.schedule = {
                enabled: !!row.schedule_enabled,
                type: row.schedule_type || null,
                cronExpression: row.schedule_cron || null,
                runAt: row.schedule_run_at ? new Date(row.schedule_run_at).getTime() : null,
                timezone: row.schedule_timezone || 'Asia/Taipei',
                lastRunAt: row.schedule_last_run_at ? new Date(row.schedule_last_run_at).getTime() : null,
                nextRunAt: row.schedule_next_run_at ? new Date(row.schedule_next_run_at).getTime() : null,
            };
        }

        // Automation fields
        if (row.is_automation) card.isAutomation = true;
        if (row.parent_card_id) card.parentCardId = row.parent_card_id;
        if (row.is_auto_generated) card.isAutoGenerated = true;
        if (row.last_run_result) card.lastRunResult = row.last_run_result;
        if (row.active_child_id) card.activeChildId = row.active_child_id;

        return card;
    }

    // ============================================
    // POST /card — Create card
    // ============================================
    router.post('/card', async (req, res) => {
        if (!authenticate(req, res)) return;
        const _p = { ...req.query, ...req.body }; console.log('[Kanban] POST /card called', { deviceId: _p.deviceId, entityId: _p.entityId, cardId: req.params?.id });
        const { deviceId, title, description, priority, status, assignedBots, entityId, reviewerEntityId, isAutomation, schedule } = req.body;

        if (!title || !title.trim()) {
            return res.status(400).json({ success: false, error: 'Missing title' });
        }

        const bots = Array.isArray(assignedBots) ? assignedBots.map(Number) : [];
        if (bots.length === 0) {
            return res.status(400).json({ success: false, error: 'At least one entity must be assigned' });
        }

        // #1700: Validate assigned entities are bound (rental entities allowed per design decision #15)
        const device = devices[deviceId];
        if (device) {
            for (const botId of bots) {
                const entity = device.entities?.[botId];
                if (!entity || !entity.isBound) {
                    return res.status(400).json({
                        success: false,
                        error: `Entity #${botId} is not bound`,
                        hint: 'Use POST /api/bind to bind the entity first',
                    });
                }
                // Rental entities (leased_out on owner side) are allowed for kanban assign
                // per design decision #15: ✅ kanban assigned_bots
            }
        }

        const cardPriority = PRIORITIES.includes(priority) ? priority : 'P2';
        const cardStatus = STATUSES.includes(status) ? status : 'backlog';
        const createdBy = parseInt(entityId || 0);
        let reviewer = reviewerEntityId != null ? parseInt(reviewerEntityId) : null;

        // Org chart: auto-set reviewer from hierarchy if not explicitly set
        if (reviewer == null && orgChart && bots.length > 0) {
            try {
                const orgData = await orgChart.getOrgChart(deviceId);
                if (orgData.options.kanbanReviewer && orgData.hierarchy && orgData.hierarchy.USER) {
                    const superior = orgChart.getSuperior(orgData.hierarchy, bots[0]);
                    if (superior != null && superior !== 'USER' && typeof superior === 'number') {
                        const device = devices[deviceId];
                        if (device && device.entities?.[superior]?.isBound) {
                            reviewer = superior;
                            console.log(`[Kanban] Org chart auto-set reviewer #${reviewer} for card assigned to [${bots.join(',')}]`);
                        }
                    }
                }
            } catch (err) {
                console.error('[Kanban] Org chart reviewer auto-set error:', err.message);
            }
        }

        // Inline automation + schedule support
        const wantAutomation = !!isAutomation;
        let schedEnabled = false, schedType = null, schedCron = null, schedRunAt = null, schedTz = 'Asia/Taipei', schedNextRunAt = null;

        if (schedule && typeof schedule === 'object') {
            schedType = (schedule.type === 'once' || schedule.type === 'recurring') ? schedule.type : null;
            schedTz = schedule.timezone || 'Asia/Taipei';
            schedEnabled = schedule.enabled !== false && !!schedType;

            if (schedEnabled && schedType === 'once') {
                if (!schedule.runAt) {
                    return res.status(400).json({ success: false, error: 'Missing schedule.runAt for once schedule' });
                }
                schedRunAt = new Date(schedule.runAt);
                if (isNaN(schedRunAt.getTime())) {
                    return res.status(400).json({ success: false, error: 'Invalid schedule.runAt timestamp' });
                }
                schedNextRunAt = schedRunAt;
            }

            if (schedEnabled && schedType === 'recurring') {
                if (!schedule.cron && !schedule.cronExpression) {
                    return res.status(400).json({ success: false, error: 'Missing schedule.cron for recurring schedule' });
                }
                schedCron = schedule.cron || schedule.cronExpression;
                schedNextRunAt = computeNextRun(schedCron, schedTz);
                if (!schedNextRunAt) {
                    return res.status(400).json({ success: false, error: 'Invalid cron expression' });
                }
            }
        }

        // recurring schedule → auto-promote to automation
        const finalAutomation = wantAutomation || (schedEnabled && schedType === 'recurring');

        try {
            const result = await pool.query(
                `INSERT INTO kanban_cards (id, device_id, title, description, priority, status, assigned_bots, created_by, reviewer_entity_id, status_changed_at,
                    is_automation, schedule_enabled, schedule_type, schedule_cron, schedule_run_at, schedule_timezone, schedule_next_run_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, NOW(),
                    $10, $11, $12, $13, $14, $15, $16)
                 RETURNING *`,
                [newCardId(), deviceId, title.trim(), description || '', cardPriority, cardStatus, JSON.stringify(bots), createdBy, reviewer,
                    finalAutomation, schedEnabled, schedType, schedCron, schedRunAt, schedTz, schedNextRunAt]
            );

            const card = serializeCard(result.rows[0]);
            await bumpVersion(deviceId);

            // System comment
            await addSystemComment(card.id, deviceId, `📋 卡片建立 — 狀態: ${STATUS_LABELS[cardStatus]}，指派給: ${bots.map(b => `#${b}`).join(', ') || '未指派'}`);

            // Push notify assigned bots if status != backlog
            if (cardStatus !== 'backlog' && bots.length > 0) {
                const lang = await getDeviceLanguage(deviceId);
                const msg = tKanban(lang, 'cardCreated', {
                    priorityIcon: PRIORITY_COLORS[cardPriority],
                    priority: cardPriority,
                    title: title.trim(),
                    status: statusLabel(lang, cardStatus)
                });
                notifyEntities(deviceId, bots, msg, { description, cardId: card.id });
            }

            if (awardEntityXP) {
                try { await awardEntityXP(deviceId, createdBy, 10); } catch (e) { /* ignore */ }
            }

            res.json({ success: true, card });
        } catch (err) {
            console.error('[Kanban] Create card error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // GET /cards — List cards
    // ============================================
    router.get('/cards', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = { ...req.query, ...req.body };
        const { status: filterStatus, assignedBot, priority: filterPriority, automation, q: searchQuery, since, until } = req.query;

        try {
            let query = `
                SELECT c.*,
                    COALESCE(cm.cnt, 0) AS comment_count,
                    COALESCE(n.cnt, 0) AS note_count,
                    COALESCE(f.cnt, 0) AS file_count
                FROM kanban_cards c
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_comments GROUP BY card_id) cm ON cm.card_id = c.id
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_notes GROUP BY card_id) n ON n.card_id = c.id
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_files GROUP BY card_id) f ON f.card_id = c.id
                WHERE c.device_id = $1 AND c.archived = false
            `;
            const params = [deviceId];
            let paramIdx = 2;

            // #1703: Automation filter — default excludes automation cards
            // ?automation=all → show everything (explicit opt-in)
            // ?automation=true → only automation cards
            // ?automation=false or absent → only manual cards (new default)
            if (automation === 'all') {
                // no filter — show everything
            } else if (automation === 'true') {
                query += ` AND c.is_automation = true`;
            } else {
                // Default: exclude automation cards
                query += ` AND (c.is_automation = false OR c.is_automation IS NULL)`;
            }

            if (filterStatus && STATUSES.includes(filterStatus)) {
                query += ` AND c.status = $${paramIdx++}`;
                params.push(filterStatus);
            }

            if (assignedBot !== undefined) {
                query += ` AND c.assigned_bots @> $${paramIdx++}::jsonb`;
                params.push(JSON.stringify([parseInt(assignedBot)]));
            }

            if (filterPriority && PRIORITIES.includes(filterPriority)) {
                query += ` AND c.priority = $${paramIdx++}`;
                params.push(filterPriority);
            }

            // Funnel filters added 2026-04-23:
            // ?q=text  → ILIKE match on title (simple text search)
            // ?since=ISO8601 / ?until=ISO8601  → updated_at range
            if (searchQuery && typeof searchQuery === 'string' && searchQuery.trim()) {
                query += ` AND c.title ILIKE $${paramIdx++}`;
                params.push(`%${searchQuery.trim()}%`);
            }
            if (since) {
                const sinceDate = new Date(since);
                if (!isNaN(sinceDate.getTime())) {
                    query += ` AND c.updated_at >= $${paramIdx++}`;
                    params.push(sinceDate);
                }
            }
            if (until) {
                const untilDate = new Date(until);
                if (!isNaN(untilDate.getTime())) {
                    query += ` AND c.updated_at <= $${paramIdx++}`;
                    params.push(untilDate);
                }
            }

            // Order: P0 first, then by status position, then most-recently-updated first.
            // Changed 2026-04-23 from created_at DESC to updated_at DESC so cards move
            // to the top when they receive new comments/notes/status changes.
            query += ` ORDER BY
                CASE c.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 END,
                CASE c.status WHEN 'in_progress' THEN 0 WHEN 'review' THEN 1 WHEN 'todo' THEN 2 WHEN 'backlog' THEN 3 WHEN 'done' THEN 4 END,
                c.updated_at DESC NULLS LAST`;

            const result = await pool.query(query, params);
            const cards = result.rows.map(serializeCard);

            // Group by status for kanban view
            const board = {};
            for (const s of STATUSES) board[s] = [];
            for (const card of cards) {
                if (board[card.status]) board[card.status].push(card);
            }

            // #1703: Summary counts for manual vs automation cards
            const summaryResult = await pool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE is_automation = true) AS automation_count,
                    COUNT(*) FILTER (WHERE is_automation = false OR is_automation IS NULL) AS manual_count
                FROM kanban_cards WHERE device_id = $1 AND archived = false
            `, [deviceId]);
            const summaryRow = summaryResult.rows[0] || {};
            const byStatus = {};
            for (const s of STATUSES) byStatus[s] = board[s].length;

            res.json({
                success: true, cards, board, total: cards.length,
                summary: {
                    total: cards.length,
                    manual: parseInt(summaryRow.manual_count || 0),
                    automation: parseInt(summaryRow.automation_count || 0),
                    byStatus,
                },
            });
        } catch (err) {
            console.error('[Kanban] List cards error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // GET /cards/projections — Projected run times for automation cards
    // ============================================
    router.get('/cards/projections', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, windowHours } = { ...req.query, ...req.body };
        const hours = Math.min(parseInt(windowHours) || 24, 72);
        const windowStart = Date.now() - 3600000; // 1h ago
        const windowEnd = Date.now() + (hours - 1) * 3600000;

        if (!CronExpressionParser) {
            return res.json({ success: true, projections: {} });
        }

        try {
            const result = await pool.query(
                `SELECT id, schedule_cron, schedule_timezone FROM kanban_cards
                 WHERE device_id = $1 AND is_automation = true AND archived = false
                   AND schedule_enabled = true AND schedule_cron IS NOT NULL
                 LIMIT 100`,
                [deviceId]
            );

            const projections = {};
            for (const row of result.rows) {
                try {
                    const expr = CronExpressionParser.parse(row.schedule_cron, {
                        tz: row.schedule_timezone || 'Asia/Taipei',
                        currentDate: new Date(windowStart),
                    });
                    const times = [];
                    let iter = 0;
                    while (iter++ < 200) {
                        const next = expr.next().toDate();
                        if (next.getTime() > windowEnd) break;
                        times.push(next.getTime());
                    }
                    projections[row.id] = times;
                } catch (e) {
                    projections[row.id] = [];
                }
            }

            res.json({ success: true, projections });
        } catch (err) {
            console.error('[Kanban] Projections error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // GET /cards/summary — Board summary (counts + recent activity)
    // ============================================
    router.get('/cards/summary', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = { ...req.query, ...req.body };

        try {
            // Status counts (non-archived)
            const countsResult = await pool.query(
                `SELECT status, COUNT(*) AS cnt
                 FROM kanban_cards
                 WHERE device_id = $1 AND archived = false AND (is_automation = false OR is_automation IS NULL)
                 GROUP BY status`,
                [deviceId]
            );
            const statusCounts = {};
            let totalActive = 0;
            for (const s of STATUSES) statusCounts[s] = 0;
            for (const row of countsResult.rows) {
                statusCounts[row.status] = parseInt(row.cnt);
                totalActive += parseInt(row.cnt);
            }
            console.log('[Kanban] summary statusCounts:', statusCounts);

            // Automation count
            const autoResult = await pool.query(
                `SELECT COUNT(*) AS cnt FROM kanban_cards
                 WHERE device_id = $1 AND archived = false AND is_automation = true`,
                [deviceId]
            );
            const automationCount = parseInt(autoResult.rows[0]?.cnt) || 0;

            // Stale cards (exceeded threshold)
            const staleResult = await pool.query(
                `SELECT COUNT(*) AS cnt FROM kanban_cards
                 WHERE device_id = $1 AND archived = false
                   AND status IN ('todo', 'in_progress', 'review')
                   AND EXTRACT(EPOCH FROM (NOW() - status_changed_at)) * 1000 > stale_threshold_ms`,
                [deviceId]
            );
            const staleCount = parseInt(staleResult.rows[0]?.cnt) || 0;

            // Recent activity (last 5 status changes)
            const recentResult = await pool.query(
                `SELECT id, title, status, priority, assigned_bots, status_changed_at, is_auto_generated
                 FROM kanban_cards
                 WHERE device_id = $1 AND archived = false
                 ORDER BY status_changed_at DESC
                 LIMIT 5`,
                [deviceId]
            );
            const recentActivity = recentResult.rows.map(r => ({
                id: r.id,
                title: r.title,
                status: r.status,
                priority: r.priority,
                assignedBots: r.assigned_bots || [],
                isAutoGenerated: r.is_auto_generated || false,
                statusChangedAt: r.status_changed_at ? new Date(r.status_changed_at).getTime() : null
            }));

            // Archived count (for reference)
            const archivedResult = await pool.query(
                `SELECT COUNT(*) AS cnt FROM kanban_cards WHERE device_id = $1 AND archived = true`,
                [deviceId]
            );
            const archivedCount = parseInt(archivedResult.rows[0]?.cnt) || 0;

            console.log(`[Kanban] summary: active=${totalActive}, automation=${automationCount}, stale=${staleCount}, archived=${archivedCount}`);

            res.json({
                success: true,
                summary: {
                    statusCounts,
                    totalActive,
                    automationCount,
                    staleCount,
                    archivedCount,
                    recentActivity
                }
            });
        } catch (err) {
            console.error('[Kanban] Summary error:', err.message, err.stack);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // GET /cards/archived — Archived cards (paginated)
    // ============================================
    router.get('/cards/archived', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = { ...req.query, ...req.body };
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;

        try {
            const countResult = await pool.query(
                `SELECT COUNT(*) FROM kanban_cards WHERE device_id = $1 AND archived = true`,
                [deviceId]
            );
            const total = parseInt(countResult.rows[0].count);

            const result = await pool.query(
                `SELECT c.*,
                    COALESCE(cm.cnt, 0) AS comment_count,
                    COALESCE(n.cnt, 0) AS note_count,
                    COALESCE(f.cnt, 0) AS file_count
                FROM kanban_cards c
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_comments GROUP BY card_id) cm ON cm.card_id = c.id
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_notes GROUP BY card_id) n ON n.card_id = c.id
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_files GROUP BY card_id) f ON f.card_id = c.id
                WHERE c.device_id = $1 AND c.archived = true
                ORDER BY c.archived_at DESC NULLS LAST
                LIMIT $2 OFFSET $3`,
                [deviceId, limit, offset]
            );

            res.json({
                success: true,
                cards: result.rows.map(serializeCard),
                total,
                page,
                pages: Math.ceil(total / limit)
            });
        } catch (err) {
            console.error('[Kanban] Archived cards error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // GET /card/:id — Card detail
    // ============================================
    router.get('/card/:id', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = { ...req.query, ...req.body };
        const rawId = req.params.id;

        try {
            // Resolve short-ID prefixes to the full card ID, scoped to this device.
            // Users commonly mention cards in chat with 8-hex shorthand (e.g. `card_7b7dd9e3`);
            // fall back to a prefix match only when the raw id is an obvious shorthand
            // (hex-only, ≤ 12 chars, optionally with a `card_` prefix).
            let cardId = rawId;
            const shortBody = /^card_([a-f0-9]{6,12})$/i.test(rawId)
                ? rawId.slice(5)
                : (/^[a-f0-9]{6,12}$/i.test(rawId) ? rawId : null);
            if (shortBody) {
                const match = await pool.query(
                    `SELECT id FROM kanban_cards
                     WHERE device_id = $1
                       AND (id = $2 OR id LIKE $3 OR id LIKE $4)
                     ORDER BY created_at DESC
                     LIMIT 2`,
                    [deviceId, rawId, shortBody + '%', 'card_' + shortBody + '%']
                );
                if (match.rows.length === 1) cardId = match.rows[0].id;
                // If 2+ cards share this prefix we fall through to the exact-match
                // query below, which will return 404 and force the caller to
                // disambiguate with a longer id.
            }

            const cardResult = await pool.query(
                `SELECT c.*,
                    COALESCE(cm.cnt, 0) AS comment_count,
                    COALESCE(n.cnt, 0) AS note_count,
                    COALESCE(f.cnt, 0) AS file_count
                FROM kanban_cards c
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_comments GROUP BY card_id) cm ON cm.card_id = c.id
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_notes GROUP BY card_id) n ON n.card_id = c.id
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_files GROUP BY card_id) f ON f.card_id = c.id
                WHERE c.id = $1 AND c.device_id = $2`,
                [cardId, deviceId]
            );

            if (cardResult.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const card = serializeCard(cardResult.rows[0]);

            // Fetch comments (latest 50)
            const commentsResult = await pool.query(
                `SELECT * FROM kanban_comments WHERE card_id = $1 ORDER BY created_at ASC LIMIT 50`,
                [cardId]
            );
            card.comments = commentsResult.rows.map(r => ({
                id: r.id,
                fromEntityId: r.from_entity_id,
                text: r.text,
                isSystem: r.is_system,
                createdAt: new Date(r.created_at).getTime()
            }));

            // Fetch notes
            const notesResult = await pool.query(
                `SELECT * FROM kanban_notes WHERE card_id = $1 ORDER BY created_at DESC`,
                [cardId]
            );
            card.notes = notesResult.rows.map(r => ({
                id: r.id,
                title: r.title,
                content: r.content,
                fromEntityId: r.from_entity_id,
                createdAt: new Date(r.created_at).getTime(),
                updatedAt: new Date(r.updated_at).getTime()
            }));

            // Fetch files
            const filesResult = await pool.query(
                `SELECT * FROM kanban_files WHERE card_id = $1 ORDER BY created_at DESC`,
                [cardId]
            );
            card.files = filesResult.rows.map(r => ({
                id: r.id,
                filename: r.filename,
                url: r.url,
                mimeType: r.mime_type,
                fileSize: r.file_size ? parseInt(r.file_size) : null,
                uploadedBy: r.uploaded_by,
                createdAt: new Date(r.created_at).getTime()
            }));

            res.json({ success: true, card });
        } catch (err) {
            console.error('[Kanban] Get card error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // PUT /card/:id — Update card fields
    // ============================================
    router.put('/card/:id', async (req, res) => {
        if (!authenticate(req, res)) return;
        const _p = { ...req.query, ...req.body }; console.log('[Kanban] PUT /card/:id called', { deviceId: _p.deviceId, entityId: _p.entityId, cardId: req.params?.id });
        const { deviceId, title, description, priority, assignedBots, reviewerEntityId } = req.body;
        const cardId = req.params.id;

        try {
            // Check card exists and belongs to device
            const existing = await pool.query(
                `SELECT * FROM kanban_cards WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );
            if (existing.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const updates = [];
            const params = [];
            let paramIdx = 1;

            if (title !== undefined) {
                updates.push(`title = $${paramIdx++}`);
                params.push(title.trim());
            }
            if (description !== undefined) {
                updates.push(`description = $${paramIdx++}`);
                params.push(description);
            }
            if (priority !== undefined && PRIORITIES.includes(priority)) {
                updates.push(`priority = $${paramIdx++}`);
                params.push(priority);
            }
            if (assignedBots !== undefined && Array.isArray(assignedBots)) {
                if (assignedBots.length === 0) {
                    return res.status(400).json({ success: false, error: 'At least one entity must be assigned' });
                }
                // #1700: Validate bind status on update (rental entities allowed)
                const updateDevice = devices[deviceId];
                if (updateDevice) {
                    for (const botId of assignedBots.map(Number)) {
                        const entity = updateDevice.entities?.[botId];
                        if (!entity || !entity.isBound) {
                            return res.status(400).json({ success: false, error: `Entity #${botId} is not bound` });
                        }
                    }
                }
                updates.push(`assigned_bots = $${paramIdx++}::jsonb`);
                params.push(JSON.stringify(assignedBots.map(Number)));
            }
            if (reviewerEntityId !== undefined) {
                updates.push(`reviewer_entity_id = $${paramIdx++}`);
                params.push(reviewerEntityId != null ? parseInt(reviewerEntityId) : null);
            }

            if (updates.length === 0) {
                return res.status(400).json({ success: false, error: 'Nothing to update' });
            }

            updates.push(`updated_at = NOW()`);
            params.push(cardId);
            params.push(deviceId);

            const result = await pool.query(
                `UPDATE kanban_cards SET ${updates.join(', ')}
                 WHERE id = $${paramIdx++} AND device_id = $${paramIdx++}
                 RETURNING *`,
                params
            );

            await bumpVersion(deviceId);
            res.json({ success: true, card: serializeCard(result.rows[0]) });
        } catch (err) {
            console.error('[Kanban] Update card error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // DELETE /card/:id — Archive card
    // ============================================
    router.delete('/card/:id', async (req, res) => {
        if (!authenticate(req, res)) return;
        const _p = { ...req.query, ...req.body }; console.log('[Kanban] DELETE /card/:id called', { deviceId: _p.deviceId, entityId: _p.entityId, cardId: req.params?.id });
        const { deviceId } = { ...req.query, ...req.body };
        const cardId = req.params.id;

        try {
            const result = await pool.query(
                `UPDATE kanban_cards SET archived = true, archived_at = NOW(), updated_at = NOW()
                 WHERE id = $1 AND device_id = $2
                 RETURNING *`,
                [cardId, deviceId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            await addSystemComment(cardId, deviceId, '🗄️ 卡片已歸檔');
            await bumpVersion(deviceId);

            res.json({ success: true, message: 'Card archived' });
        } catch (err) {
            console.error('[Kanban] Archive card error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // POST /card/:id/restore — Un-archive a card (bring it back to the board)
    // ============================================
    router.post('/card/:id/restore', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = { ...req.query, ...req.body };
        const cardId = req.params.id;

        try {
            // Restore to 'backlog' so it doesn't immediately re-archive if it was 'done'.
            const result = await pool.query(
                `UPDATE kanban_cards
                 SET archived = false, archived_at = NULL, status = 'backlog',
                     status_changed_at = NOW(), updated_at = NOW()
                 WHERE id = $1 AND device_id = $2 AND archived = true
                 RETURNING *`,
                [cardId, deviceId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Archived card not found' });
            }

            await addSystemComment(cardId, deviceId, '♻️ 卡片已還原至 Backlog');
            await bumpVersion(deviceId);

            res.json({ success: true, card: serializeCard(result.rows[0]) });
        } catch (err) {
            console.error('[Kanban] Restore card error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // POST /card/:id/move — Move card status
    // ============================================
    router.post('/card/:id/move', async (req, res) => {
        if (!authenticate(req, res)) return;
        const _p = { ...req.query, ...req.body }; console.log('[Kanban] POST /card/:id/move called', { deviceId: _p.deviceId, entityId: _p.entityId, cardId: req.params?.id });
        const { deviceId, newStatus, assignedBots } = req.body;
        const cardId = req.params.id;

        if (!newStatus || !STATUSES.includes(newStatus)) {
            return res.status(400).json({ success: false, error: `Invalid status. Must be one of: ${STATUSES.join(', ')}` });
        }

        try {
            const existing = await pool.query(
                `SELECT * FROM kanban_cards WHERE id = $1 AND device_id = $2 AND archived = false`,
                [cardId, deviceId]
            );
            if (existing.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found or archived' });
            }

            const card = existing.rows[0];
            const oldStatus = card.status;

            // Done cards cannot be moved back
            if (oldStatus === 'done') {
                return res.status(400).json({ success: false, error: 'Done cards cannot be moved. Create a new card instead.' });
            }

            // Same status = no-op
            if (oldStatus === newStatus) {
                return res.status(400).json({ success: false, error: 'Card is already in this status' });
            }

            const bots = Array.isArray(assignedBots) ? assignedBots.map(Number) : (card.assigned_bots || []);
            if (bots.length === 0) {
                return res.status(400).json({ success: false, error: 'At least one entity must be assigned' });
            }

            const result = await pool.query(
                `UPDATE kanban_cards 
                 SET status = $1, assigned_bots = $2::jsonb, status_changed_at = NOW(), 
                     last_stale_nudge_at = NULL, updated_at = NOW()
                 WHERE id = $3 AND device_id = $4
                 RETURNING *`,
                [newStatus, JSON.stringify(bots), cardId, deviceId]
            );

            const updatedCard = serializeCard(result.rows[0]);

            // System comment
            const botLabel = bots.map(b => `#${b}`).join(', ') || '未指派';
            await addSystemComment(cardId, deviceId,
                `📌 狀態更新：${STATUS_LABELS[oldStatus]} → ${STATUS_LABELS[newStatus]}，指派給: ${botLabel}`);

            // Push notify new assigned bots
            if (bots.length > 0) {
                const direction = STATUSES.indexOf(newStatus) > STATUSES.indexOf(oldStatus) ? '➡️' : '⬅️';
                const lang = await getDeviceLanguage(deviceId);
                const msg = tKanban(lang, 'statusChanged', {
                    direction,
                    title: card.title,
                    from: statusLabel(lang, oldStatus),
                    to: statusLabel(lang, newStatus)
                });
                notifyEntities(deviceId, bots, msg, { description: card.description, cardId });
            }

            await bumpVersion(deviceId);

            // Award XP for moving to done
            if (newStatus === 'done' && awardEntityXP) {
                for (const bot of bots) {
                    try { await awardEntityXP(deviceId, bot, 25); } catch (e) { /* ignore */ }
                }
            }

            // If this is an auto-generated child card moving to Done → update parent
            if (newStatus === 'done' && card.is_auto_generated && card.parent_card_id) {
                console.log(`[Kanban] Child card ${cardId} done, updating parent ${card.parent_card_id}`);
                try {
                    const resultSummary = `✅ ${card.title} — Done`;
                    await pool.query(
                        `UPDATE kanban_cards SET 
                            last_run_result = $1, active_child_id = NULL, updated_at = NOW()
                         WHERE id = $2 AND device_id = $3`,
                        [resultSummary, card.parent_card_id, deviceId]
                    );
                    await addSystemComment(card.parent_card_id, deviceId,
                        `✅ 子卡完成: ${card.title}`);
                    console.log(`[Kanban] Parent ${card.parent_card_id} updated: lastRunResult="${resultSummary}", activeChildId=null`);
                } catch (parentErr) {
                    console.error(`[Kanban] Failed to update parent card ${card.parent_card_id}:`, parentErr.message);
                }
            }

            res.json({ success: true, card: updatedCard, transition: { from: oldStatus, to: newStatus } });
        } catch (err) {
            console.error('[Kanban] Move card error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // GET /card/:id/comments — List comments
    // ============================================
    router.get('/card/:id/comments', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = { ...req.query, ...req.body };
        const cardId = req.params.id;
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
        const offset = Math.max(0, parseInt(req.query.offset) || 0);

        try {
            // Verify card belongs to device
            const cardCheck = await pool.query(
                `SELECT id FROM kanban_cards WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );
            if (cardCheck.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const result = await pool.query(
                `SELECT * FROM kanban_comments WHERE card_id = $1 ORDER BY created_at ASC LIMIT $2 OFFSET $3`,
                [cardId, limit, offset]
            );

            const comments = result.rows.map(r => ({
                id: r.id,
                fromEntityId: r.from_entity_id,
                text: r.text,
                isSystem: r.is_system,
                createdAt: new Date(r.created_at).getTime()
            }));

            res.json({ success: true, comments, total: comments.length });
        } catch (err) {
            console.error('[Kanban] List comments error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // POST /card/:id/comment — Add comment
    // ============================================
    router.post('/card/:id/comment', async (req, res) => {
        if (!authenticate(req, res)) return;
        const _p = { ...req.query, ...req.body }; console.log('[Kanban] POST /card/:id/comment called', { deviceId: _p.deviceId, entityId: _p.entityId, cardId: req.params?.id });
        const { deviceId, text, entityId, fromEntityId } = req.body;
        const cardId = req.params.id;
        const eId = parseInt(fromEntityId ?? entityId ?? 0);

        if (!text || !text.trim()) {
            return res.status(400).json({ success: false, error: 'Missing text' });
        }

        try {
            const cardCheck = await pool.query(
                `SELECT id, assigned_bots FROM kanban_cards WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );
            if (cardCheck.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const result = await pool.query(
                `INSERT INTO kanban_comments (card_id, device_id, from_entity_id, text, is_system)
                 VALUES ($1, $2, $3, $4, false)
                 RETURNING *`,
                [cardId, deviceId, eId, text.trim()]
            );

            // Bump card updated_at so "Recently Updated" sort surfaces the card.
            await pool.query(
                `UPDATE kanban_cards SET updated_at = NOW() WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );

            const comment = {
                id: result.rows[0].id,
                fromEntityId: result.rows[0].from_entity_id,
                text: result.rows[0].text,
                isSystem: false,
                createdAt: new Date(result.rows[0].created_at).getTime()
            };

            await bumpVersion(deviceId);

            res.json({ success: true, comment });
        } catch (err) {
            console.error('[Kanban] Add comment error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // GET /card/:id/notes — List notes
    // ============================================
    router.get('/card/:id/notes', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = { ...req.query, ...req.body };
        const cardId = req.params.id;

        try {
            const cardCheck = await pool.query(
                `SELECT id FROM kanban_cards WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );
            if (cardCheck.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const result = await pool.query(
                `SELECT * FROM kanban_notes WHERE card_id = $1 ORDER BY created_at DESC`,
                [cardId]
            );

            const notes = result.rows.map(r => ({
                id: r.id,
                title: r.title,
                content: r.content,
                fromEntityId: r.from_entity_id,
                createdAt: new Date(r.created_at).getTime(),
                updatedAt: new Date(r.updated_at).getTime()
            }));

            res.json({ success: true, notes });
        } catch (err) {
            console.error('[Kanban] List notes error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // POST /card/:id/note — Add note
    // ============================================
    router.post('/card/:id/note', async (req, res) => {
        if (!authenticate(req, res)) return;
        const _p = { ...req.query, ...req.body }; console.log('[Kanban] POST /card/:id/note called', { deviceId: _p.deviceId, entityId: _p.entityId, cardId: req.params?.id });
        const { deviceId, title, content, entityId, fromEntityId } = req.body;
        const cardId = req.params.id;
        const eId = parseInt(fromEntityId ?? entityId ?? 0);

        if (!content || !content.trim()) {
            return res.status(400).json({ success: false, error: 'Missing content' });
        }

        try {
            const cardCheck = await pool.query(
                `SELECT id FROM kanban_cards WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );
            if (cardCheck.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const result = await pool.query(
                `INSERT INTO kanban_notes (card_id, device_id, title, content, from_entity_id)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING *`,
                [cardId, deviceId, (title || '').trim(), content.trim(), eId]
            );

            // Bump card updated_at so "Recently Updated" sort surfaces the card.
            await pool.query(
                `UPDATE kanban_cards SET updated_at = NOW() WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );

            const note = {
                id: result.rows[0].id,
                title: result.rows[0].title,
                content: result.rows[0].content,
                fromEntityId: result.rows[0].from_entity_id,
                createdAt: new Date(result.rows[0].created_at).getTime(),
                updatedAt: new Date(result.rows[0].updated_at).getTime()
            };

            await bumpVersion(deviceId);
            res.json({ success: true, note });
        } catch (err) {
            console.error('[Kanban] Add note error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // GET /card/:id/files — List files
    // ============================================
    router.get('/card/:id/files', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = { ...req.query, ...req.body };
        const cardId = req.params.id;

        try {
            const cardCheck = await pool.query(
                `SELECT id FROM kanban_cards WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );
            if (cardCheck.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const result = await pool.query(
                `SELECT * FROM kanban_files WHERE card_id = $1 ORDER BY created_at DESC`,
                [cardId]
            );

            const files = result.rows.map(r => ({
                id: r.id,
                filename: r.filename,
                url: r.url,
                mimeType: r.mime_type,
                fileSize: r.file_size ? parseInt(r.file_size) : null,
                uploadedBy: r.uploaded_by,
                createdAt: new Date(r.created_at).getTime()
            }));

            res.json({ success: true, files });
        } catch (err) {
            console.error('[Kanban] List files error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // POST /card/:id/file — Add file (URL-based)
    // ============================================
    router.post('/card/:id/file', async (req, res) => {
        if (!authenticate(req, res)) return;
        const _p = { ...req.query, ...req.body }; console.log('[Kanban] POST /card/:id/file called', { deviceId: _p.deviceId, entityId: _p.entityId, cardId: req.params?.id });
        const { deviceId, filename, url, mimeType, fileSize, entityId } = req.body;
        const cardId = req.params.id;
        const uploadedBy = parseInt(entityId || 0);

        if (!filename || !url) {
            return res.status(400).json({ success: false, error: 'Missing filename or url' });
        }

        try {
            const cardCheck = await pool.query(
                `SELECT id FROM kanban_cards WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );
            if (cardCheck.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const result = await pool.query(
                `INSERT INTO kanban_files (card_id, device_id, filename, url, mime_type, file_size, uploaded_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 RETURNING *`,
                [cardId, deviceId, filename, url, mimeType || null, fileSize || null, uploadedBy]
            );

            // Bump card updated_at so "Recently Updated" sort surfaces the card.
            await pool.query(
                `UPDATE kanban_cards SET updated_at = NOW() WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );

            const file = {
                id: result.rows[0].id,
                filename: result.rows[0].filename,
                url: result.rows[0].url,
                mimeType: result.rows[0].mime_type,
                fileSize: result.rows[0].file_size ? parseInt(result.rows[0].file_size) : null,
                uploadedBy: result.rows[0].uploaded_by,
                createdAt: new Date(result.rows[0].created_at).getTime()
            };

            await bumpVersion(deviceId);
            res.json({ success: true, file });
        } catch (err) {
            console.error('[Kanban] Add file error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // PUT /card/:id/config — Update thresholds
    // ============================================
    router.put('/card/:id/config', async (req, res) => {
        if (!authenticate(req, res)) return;
        const _p = { ...req.query, ...req.body }; console.log('[Kanban] PUT /card/:id/config called', { deviceId: _p.deviceId, entityId: _p.entityId, cardId: req.params?.id });
        const { deviceId, staleThresholdMs, doneRetentionMs, isAutomation } = req.body;
        const cardId = req.params.id;

        try {
            const updates = [];
            const params = [];
            let paramIdx = 1;

            if (staleThresholdMs !== undefined) {
                const val = parseInt(staleThresholdMs);
                if (isNaN(val) || val < 600000) { // min 10 minutes
                    return res.status(400).json({ success: false, error: 'staleThresholdMs must be >= 600000 (10 min)' });
                }
                updates.push(`stale_threshold_ms = $${paramIdx++}`);
                params.push(val);
            }
            if (doneRetentionMs !== undefined) {
                const val = parseInt(doneRetentionMs);
                if (isNaN(val) || val < 3600000) { // min 1 hour
                    return res.status(400).json({ success: false, error: 'doneRetentionMs must be >= 3600000 (1 hr)' });
                }
                updates.push(`done_retention_ms = $${paramIdx++}`);
                params.push(val);
            }
            if (isAutomation !== undefined) {
                updates.push(`is_automation = $${paramIdx++}`);
                params.push(!!isAutomation);
                console.log(`[Kanban] Config: set is_automation=${!!isAutomation} for card ${cardId}`);
            }

            if (updates.length === 0) {
                return res.status(400).json({ success: false, error: 'Nothing to update' });
            }

            updates.push(`updated_at = NOW()`);
            params.push(cardId);
            params.push(deviceId);

            const result = await pool.query(
                `UPDATE kanban_cards SET ${updates.join(', ')}
                 WHERE id = $${paramIdx++} AND device_id = $${paramIdx++}
                 RETURNING *`,
                params
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            res.json({ success: true, card: serializeCard(result.rows[0]) });
        } catch (err) {
            console.error('[Kanban] Config card error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // PUT /card/:id/schedule — Set schedule
    // ============================================
    router.put('/card/:id/schedule', async (req, res) => {
        if (!authenticate(req, res)) return;
        const _p = { ...req.query, ...req.body }; console.log('[Kanban] PUT /card/:id/schedule called', { deviceId: _p.deviceId, entityId: _p.entityId, cardId: req.params?.id });
        const { deviceId, enabled, type, cronExpression, runAt, timezone } = req.body;
        const cardId = req.params.id;

        try {
            const existing = await pool.query(
                `SELECT * FROM kanban_cards WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );
            if (existing.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const schedEnabled = enabled !== false;
            const schedType = (type === 'once' || type === 'recurring') ? type : null;
            const tz = timezone || 'Asia/Taipei';

            if (schedEnabled && !schedType) {
                return res.status(400).json({ success: false, error: 'Schedule type must be "once" or "recurring"' });
            }

            let nextRunAt = null;

            if (schedEnabled && schedType === 'once') {
                if (!runAt) {
                    return res.status(400).json({ success: false, error: 'Missing runAt for once schedule' });
                }
                nextRunAt = new Date(runAt);
                if (isNaN(nextRunAt.getTime())) {
                    return res.status(400).json({ success: false, error: 'Invalid runAt timestamp' });
                }
            }

            if (schedEnabled && schedType === 'recurring') {
                if (!cronExpression) {
                    return res.status(400).json({ success: false, error: 'Missing cronExpression for recurring schedule' });
                }
                // Validate cron expression
                nextRunAt = computeNextRun(cronExpression, tz);
                if (!nextRunAt) {
                    return res.status(400).json({ success: false, error: 'Invalid cronExpression' });
                }
            }

            // recurring schedule → auto-promote to automation card
            const autoPromote = schedEnabled && schedType === 'recurring';

            const result = await pool.query(
                `UPDATE kanban_cards SET
                    schedule_enabled = $1,
                    schedule_type = $2,
                    schedule_cron = $3,
                    schedule_run_at = $4,
                    schedule_timezone = $5,
                    schedule_next_run_at = $6,
                    ${autoPromote ? 'is_automation = TRUE,' : ''}
                    updated_at = NOW()
                 WHERE id = $7 AND device_id = $8
                 RETURNING *`,
                [
                    schedEnabled,
                    schedType,
                    schedType === 'recurring' ? cronExpression : null,
                    schedType === 'once' ? nextRunAt : null,
                    tz,
                    nextRunAt,
                    cardId,
                    deviceId
                ]
            );

            if (autoPromote && !existing.rows[0].is_automation) {
                console.log(`[Kanban] Auto-promoted card ${cardId} to automation (recurring schedule)`);
            }

            const card = serializeCard(result.rows[0]);
            await bumpVersion(deviceId);

            const schedLabel = schedType === 'once'
                ? `一次性排程：${nextRunAt.toISOString()}`
                : `重複排程：${cronExpression} (${tz})`;
            await addSystemComment(cardId, deviceId,
                `🗓️ ${schedEnabled ? '排程已設定' : '排程已停用'} — ${schedEnabled ? schedLabel : ''}`);

            res.json({ success: true, card });
        } catch (err) {
            console.error('[Kanban] Schedule card error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // GET /card/:id/children — List child cards (automation history)
    // ============================================
    router.get('/card/:id/children', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = { ...req.query, ...req.body };
        const parentId = req.params.id;

        try {
            const parentCheck = await pool.query(
                `SELECT id, is_automation FROM kanban_cards WHERE id = $1 AND device_id = $2`,
                [parentId, deviceId]
            );
            if (parentCheck.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const result = await pool.query(
                `SELECT c.*,
                    COALESCE(cm.cnt, 0) AS comment_count,
                    COALESCE(n.cnt, 0) AS note_count,
                    COALESCE(f.cnt, 0) AS file_count
                FROM kanban_cards c
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_comments GROUP BY card_id) cm ON cm.card_id = c.id
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_notes GROUP BY card_id) n ON n.card_id = c.id
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_files GROUP BY card_id) f ON f.card_id = c.id
                WHERE c.parent_card_id = $1 AND c.device_id = $2
                ORDER BY c.created_at DESC`,
                [parentId, deviceId]
            );

            const children = result.rows.map(serializeCard);
            console.log(`[Kanban] GET /card/${parentId}/children: ${children.length} child cards`);
            res.json({ success: true, children, total: children.length });
        } catch (err) {
            console.error('[Kanban] List children error:', err.message, err.stack);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // Background Timers: Stale Nudge + Auto-Archive + Schedule
    // ============================================

    let bgTimer = null;
    const BG_CHECK_INTERVAL = 5 * 60 * 1000;        // Unified check every 5 minutes
    const MIN_NUDGE_GAP_MS = 60 * 60 * 1000;        // Minimum 1 hour between nudges

    /**
     * Unified background tick: stale nudge + auto-archive + schedule triggers.
     */
    async function backgroundTick() {
        await checkStaleCards();
        await checkDoneAutoArchive();
        await checkScheduleTriggers();
    }

    // #1701: Escalation thresholds (can be overridden per-card via config.escalationPolicy)
    const DEFAULT_ESCALATE_MS = 6 * 3600 * 1000;  // 6 hours → priority upgrade
    const DEFAULT_BLOCK_MS = 12 * 3600 * 1000;     // 12 hours → move to blocked

    /**
     * Scan for stale cards (TODO / In Progress / Review) that exceeded staleThresholdMs.
     * #1701: Three escalation levels:
     *   1. Nudge (>staleThreshold, default 3h) — system comment + notification
     *   2. Escalate (>6h) — auto-upgrade priority (P2→P1) + notify reviewer
     *   3. Block (>12h) — move to blocked status + system comment
     * Also checks for orphaned rental bot assignments.
     */
    async function checkStaleCards() {
        try {
            const result = await pool.query(`
                SELECT * FROM kanban_cards
                WHERE archived = false
                  AND status IN ('todo', 'in_progress', 'review')
                  AND EXTRACT(EPOCH FROM (NOW() - status_changed_at)) * 1000 > stale_threshold_ms
                  AND (last_stale_nudge_at IS NULL
                       OR EXTRACT(EPOCH FROM (NOW() - last_stale_nudge_at)) * 1000 > $1)
            `, [MIN_NUDGE_GAP_MS]);

            if (result.rows.length === 0) return;

            console.log(`[Kanban] Stale check: ${result.rows.length} card(s) need nudging`);

            for (const card of result.rows) {
                const bots = card.assigned_bots || [];
                const cardStatusLabel = STATUS_LABELS[card.status] || card.status;
                const elapsedMs = Date.now() - new Date(card.status_changed_at).getTime();
                const elapsedHrs = Math.round(elapsedMs / 3600000 * 10) / 10;

                // Parse per-card escalation config (if set)
                const config = card.config || {};
                const esc = config.escalationPolicy || {};
                const escalateAfterMs = esc.escalateAfterMs || DEFAULT_ESCALATE_MS;
                const blockAfterMs = esc.blockAfterMs || DEFAULT_BLOCK_MS;
                const notifyEntityId = esc.notifyEntityId || card.reviewer_entity_id;

                // #1701 Level 3: Block (>12h default)
                if (elapsedMs >= blockAfterMs && card.status !== 'blocked') {
                    await pool.query(
                        `UPDATE kanban_cards SET status = 'blocked', status_changed_at = NOW(), last_stale_nudge_at = NOW(), updated_at = NOW() WHERE id = $1`,
                        [card.id]
                    );
                    await addSystemComment(card.id, card.device_id,
                        `🚫 自動封鎖：此卡片已停滯 ${elapsedHrs} 小時，已自動移至「blocked」，請人工介入`);
                    if (notifyEntityId != null) {
                        const _lang = await getDeviceLanguage(card.device_id);
                        notifyEntities(card.device_id, [notifyEntityId],
                            `🚫 卡片「${card.title}」已停滯 ${elapsedHrs}h，自動 blocked，需人工介入`,
                            { cardId: card.id });
                    }
                    if (serverLog) serverLog('warn', 'kanban', `[Stale] Card ${card.id} auto-blocked after ${elapsedHrs}h`, { deviceId: card.device_id });
                    continue;
                }

                // #1701 Level 2: Escalate priority (>6h default)
                if (elapsedMs >= escalateAfterMs) {
                    const PRIORITY_UPGRADE = { P3: 'P2', P2: 'P1', P1: 'P0', P0: 'P0' };
                    const newPriority = PRIORITY_UPGRADE[card.priority] || card.priority;
                    if (newPriority !== card.priority) {
                        await pool.query(
                            `UPDATE kanban_cards SET priority = $1, last_stale_nudge_at = NOW(), updated_at = NOW() WHERE id = $2`,
                            [newPriority, card.id]
                        );
                        await addSystemComment(card.id, card.device_id,
                            `⬆️ 自動升級：停滯 ${elapsedHrs} 小時，優先級 ${card.priority} → ${newPriority}`);
                        if (notifyEntityId != null) {
                            notifyEntities(card.device_id, [notifyEntityId],
                                `⬆️ 卡片「${card.title}」停滯 ${elapsedHrs}h，已自動升級至 ${newPriority}`,
                                { cardId: card.id });
                        }
                        if (serverLog) serverLog('info', 'kanban', `[Stale] Card ${card.id} escalated ${card.priority}→${newPriority}`, { deviceId: card.device_id });
                        continue;
                    }
                }

                // Level 1: Standard nudge
                await addSystemComment(card.id, card.device_id,
                    `⏰ 催促：此卡片已在「${cardStatusLabel}」停留 ${elapsedHrs} 小時，請 ${bots.map(b => `#${b}`).join(', ') || '負責人'} 繼續推進`);

                await pool.query(
                    `UPDATE kanban_cards SET last_stale_nudge_at = NOW() WHERE id = $1`,
                    [card.id]
                );

                if (bots.length > 0) {
                    const lang = await getDeviceLanguage(card.device_id);
                    const msg = tKanban(lang, 'staleNudge', {
                        title: card.title,
                        status: statusLabel(lang, card.status),
                        hours: elapsedHrs
                    });
                    notifyEntities(card.device_id, bots, msg, { description: card.description, cardId: card.id });
                }

                console.log(`[Kanban] Nudged card ${card.id} (${card.title}) — ${elapsedHrs}h in ${card.status}`);
            }
        } catch (err) {
            console.error('[Kanban] Stale check error:', err.message);
        }
    }

    /**
     * Scan for Done cards that exceeded doneRetentionMs → auto-archive.
     * Recurring schedule cards in Done are NOT auto-archived (they restart on next trigger).
     */
    async function checkDoneAutoArchive() {
        try {
            const result = await pool.query(`
                SELECT * FROM kanban_cards
                WHERE archived = false
                  AND status = 'done'
                  AND EXTRACT(EPOCH FROM (NOW() - status_changed_at)) * 1000 > done_retention_ms
                  AND (schedule_enabled = false OR schedule_type != 'recurring' OR schedule_enabled IS NULL)
            `);

            if (result.rows.length === 0) return;

            console.log(`[Kanban] Auto-archive: ${result.rows.length} done card(s) expired`);

            for (const card of result.rows) {
                await pool.query(
                    `UPDATE kanban_cards SET archived = true, archived_at = NOW(), updated_at = NOW()
                     WHERE id = $1`,
                    [card.id]
                );

                await addSystemComment(card.id, card.device_id,
                    `🗄️ 自動歸檔 — Done 超過保留時間（${Math.round(parseInt(card.done_retention_ms) / 3600000)}h）`);

                try { await bumpVersion(card.device_id); } catch (e) { /* ignore */ }

                console.log(`[Kanban] Auto-archived card ${card.id} (${card.title})`);
            }
        } catch (err) {
            console.error('[Kanban] Auto-archive check error:', err.message);
        }
    }

    /**
     * Scan for schedule-enabled cards whose next_run_at has passed → trigger them.
     * - once: push notify + move to in_progress, then disable schedule
     * - recurring: push notify + system comment, move Done→TODO if needed, compute next run
     */
    async function checkScheduleTriggers() {
        try {
            const result = await pool.query(`
                SELECT * FROM kanban_cards
                WHERE archived = false
                  AND schedule_enabled = true
                  AND schedule_next_run_at IS NOT NULL
                  AND schedule_next_run_at <= NOW()
            `);

            if (result.rows.length === 0) return;

            console.log(`[Kanban] Schedule triggers: ${result.rows.length} card(s) due`);

            for (const card of result.rows) {
                const bots = card.assigned_bots || [];
                const schedType = card.schedule_type;

                if (schedType === 'once') {
                    // One-time: move to in_progress if in backlog/todo, notify, disable schedule
                    let newStatus = card.status;
                    if (card.status === 'backlog' || card.status === 'todo') {
                        newStatus = 'in_progress';
                    }

                    await pool.query(
                        `UPDATE kanban_cards SET 
                            status = $1, status_changed_at = NOW(),
                            schedule_enabled = false, schedule_last_run_at = NOW(),
                            last_stale_nudge_at = NULL, updated_at = NOW()
                         WHERE id = $2`,
                        [newStatus, card.id]
                    );

                    await addSystemComment(card.id, card.device_id,
                        `🗓️ 排程觸發（一次性）— 狀態: ${STATUS_LABELS[card.status]} → ${STATUS_LABELS[newStatus]}`);

                    if (bots.length > 0) {
                        const lang = await getDeviceLanguage(card.device_id);
                        const msg = tKanban(lang, 'scheduleOnce', { title: card.title });
                        notifyEntities(card.device_id, bots, msg, { description: card.description, cardId: card.id });
                    }

                    try { await bumpVersion(card.device_id); } catch (e) { /* ignore */ }
                    console.log(`[Kanban] Once-trigger: ${card.id} (${card.title}) → ${newStatus}`);

                } else if (schedType === 'recurring' && card.is_automation) {
                    // ── Automation card: spawn child card ──
                    console.log(`[Kanban] Automation trigger: ${card.id} (${card.title}), checking active child`);

                    // Check if there's already an active child (not done, not archived)
                    if (card.active_child_id) {
                        const activeCheck = await pool.query(
                            `SELECT id, status, archived FROM kanban_cards WHERE id = $1`,
                            [card.active_child_id]
                        );
                        const activeChild = activeCheck.rows[0];
                        if (activeChild && activeChild.status !== 'done' && !activeChild.archived) {
                            // Skip — active child still running
                            const nextRun = computeNextRun(card.schedule_cron, card.schedule_timezone);
                            await pool.query(
                                `UPDATE kanban_cards SET schedule_last_run_at = NOW(), schedule_next_run_at = $1, updated_at = NOW() WHERE id = $2`,
                                [nextRun, card.id]
                            );
                            await addSystemComment(card.id, card.device_id,
                                `⏭️ 排程觸發跳過 — 子卡 ${card.active_child_id} 仍在執行中（${activeChild.status}）`);
                            console.log(`[Kanban] Automation skip: active child ${card.active_child_id} still ${activeChild.status}`);
                            continue;
                        }
                    }

                    // Generate timestamp for child title
                    const now = new Date();
                    const tz = card.schedule_timezone || 'Asia/Taipei';
                    let timeLabel;
                    try {
                        timeLabel = now.toLocaleString('en-US', { timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
                    } catch (e) {
                        timeLabel = now.toISOString().slice(5, 16).replace('T', ' ');
                    }
                    const childTitle = `[Auto] ${card.title} (${timeLabel})`;

                    // Create child card (inherit reviewerEntityId from parent)
                    const childResult = await pool.query(
                        `INSERT INTO kanban_cards (id, device_id, title, description, priority, status, assigned_bots, created_by,
                            status_changed_at, stale_threshold_ms, done_retention_ms, parent_card_id, is_auto_generated, reviewer_entity_id)
                         VALUES ($1, $2, $3, $4, $5, 'todo', $6::jsonb, $7, NOW(), $8, $9, $10, true, $11)
                         RETURNING *`,
                        [newCardId(), card.device_id, childTitle, card.description || '', card.priority,
                         JSON.stringify(bots), card.created_by,
                         card.stale_threshold_ms, card.done_retention_ms, card.id,
                         card.reviewer_entity_id || null]
                    );
                    const childCard = childResult.rows[0];
                    console.log(`[Kanban] Automation child created: ${childCard.id} (${childTitle})`);

                    // Update parent: lastRunAt, nextRunAt, activeChildId
                    const nextRun = computeNextRun(card.schedule_cron, tz);
                    await pool.query(
                        `UPDATE kanban_cards SET 
                            schedule_last_run_at = NOW(), schedule_next_run_at = $1,
                            active_child_id = $2, updated_at = NOW()
                         WHERE id = $3`,
                        [nextRun, childCard.id, card.id]
                    );

                    // System comments
                    await addSystemComment(card.id, card.device_id,
                        `🗓️ 排程觸發 — 建立子卡: ${childTitle}，下次執行: ${nextRun ? nextRun.toISOString() : '未知'}`);
                    await addSystemComment(childCard.id, card.device_id,
                        `📋 由自動化母卡 [${card.title}] 自動建立`);

                    // Push notify assigned bots
                    if (bots.length > 0) {
                        const lang = await getDeviceLanguage(card.device_id);
                        const msg = tKanban(lang, 'automationTrigger', {
                            title: card.title,
                            childTitle
                        });
                        notifyEntities(card.device_id, bots, msg, { description: card.description, cardId: childCard.id });
                    }

                    try { await bumpVersion(card.device_id); } catch (e) { /* ignore */ }
                    console.log(`[Kanban] Automation-trigger: ${card.id} → child ${childCard.id}, next: ${nextRun?.toISOString()}`);

                } else if (schedType === 'recurring') {
                    // ── Normal recurring card: move self ──
                    let newStatus = card.status;
                    if (card.status === 'done') {
                        newStatus = 'todo';
                    }

                    const nextRun = computeNextRun(card.schedule_cron, card.schedule_timezone);

                    await pool.query(
                        `UPDATE kanban_cards SET 
                            status = $1, status_changed_at = NOW(),
                            schedule_last_run_at = NOW(), schedule_next_run_at = $2,
                            last_stale_nudge_at = NULL, updated_at = NOW()
                         WHERE id = $3`,
                        [newStatus, nextRun, card.id]
                    );

                    const statusMsg = card.status !== newStatus
                        ? `狀態: ${STATUS_LABELS[card.status]} → ${STATUS_LABELS[newStatus]}，`
                        : '';
                    await addSystemComment(card.id, card.device_id,
                        `🗓️ 排程觸發（重複）— ${statusMsg}下次執行: ${nextRun ? nextRun.toISOString() : '未知'}`);

                    if (bots.length > 0) {
                        const lang = await getDeviceLanguage(card.device_id);
                        const msg = card.status !== newStatus
                            ? tKanban(lang, 'scheduleRecurringWithStatus', {
                                title: card.title,
                                from: statusLabel(lang, card.status),
                                to: statusLabel(lang, newStatus)
                            })
                            : tKanban(lang, 'scheduleRecurring', { title: card.title });
                        notifyEntities(card.device_id, bots, msg, { description: card.description, cardId: card.id });
                    }

                    try { await bumpVersion(card.device_id); } catch (e) { /* ignore */ }
                    console.log(`[Kanban] Recurring-trigger: ${card.id} (${card.title}) → ${newStatus}, next: ${nextRun?.toISOString()}`);
                }
            }
        } catch (err) {
            console.error('[Kanban] Schedule trigger error:', err.message);
        }
    }

    /**
     * Start background timer (unified). Call after DB init.
     */
    function startBackgroundTimers() {
        if (bgTimer) return; // Already running

        // Run initial check after 30s (let server fully start)
        setTimeout(backgroundTick, 30000);

        bgTimer = setInterval(backgroundTick, BG_CHECK_INTERVAL);
        console.log(`[Kanban] Background timer started (interval: ${BG_CHECK_INTERVAL / 1000}s — stale + archive + schedule)`);
    }

    /**
     * Stop background timer (for graceful shutdown).
     */
    function stopBackgroundTimers() {
        if (bgTimer) { clearInterval(bgTimer); bgTimer = null; }
        console.log('[Kanban] Background timer stopped');
    }

    /**
     * Auto-move active child cards to "review" when Bot transforms with state=IDLE.
     * Called from index.js transform handler.
     * Only affects isAutoGenerated child cards assigned to the given entityId.
     */
    /**
     * Auto-move active child cards to "review" when Bot transforms with state=IDLE.
     * If the card has a reviewerEntityId, notify the reviewer with the bot's reply.
     * @param {string} deviceId
     * @param {number} entityId - the bot that just replied
     * @param {string} [transformMessage] - the bot's transform reply text
     */
    async function autoReviewOnTransform(deviceId, entityId, transformMessage) {
        try {
            // Find active cards assigned to this entity that are in todo/in_progress
            // Supports both auto-generated child cards AND manually created cards with reviewer
            const result = await pool.query(
                `SELECT c.id, c.title, c.status, c.parent_card_id, c.assigned_bots, c.reviewer_entity_id
                 FROM kanban_cards c
                 WHERE c.device_id = $1
                   AND (c.is_auto_generated = true OR c.reviewer_entity_id IS NOT NULL)
                   AND c.archived = false
                   AND c.status IN ('todo', 'in_progress')
                   AND c.assigned_bots::jsonb @> $2::jsonb`,
                [deviceId, JSON.stringify([entityId])]
            );

            if (result.rows.length === 0) return;

            for (const card of result.rows) {
                const reviewerId = card.reviewer_entity_id;

                // Move directly to done (not review) — avoids blocking next schedule trigger
                await pool.query(
                    `UPDATE kanban_cards 
                     SET status = 'done', status_changed_at = NOW(), 
                         last_stale_nudge_at = NULL, updated_at = NOW()
                     WHERE id = $1 AND device_id = $2`,
                    [card.id, deviceId]
                );

                // Add system comment with the bot's reply
                const msgPreview = transformMessage ? `\n回覆內容：${transformMessage.slice(0, 200)}` : '';
                await addSystemComment(card.id, deviceId,
                    `✅ Bot #${entityId} 已回報完成，自動結案${msgPreview}`);

                console.log(`[Kanban] Auto-done: child card ${card.id} (${card.title}) marked done by entity ${entityId}${reviewerId != null ? `, reviewer: #${reviewerId}` : ''}`);

                // Award XP for completing task
                if (awardEntityXP) {
                    try { await awardEntityXP(deviceId, entityId, 25); } catch (e) { /* ignore */ }
                }

                // Notify reviewer if set — send the bot's reply for review
                if (reviewerId != null) {
                    const lang = await getDeviceLanguage(deviceId);
                    const reply = transformMessage
                        ? `\n${transformMessage.slice(0, 300)}`
                        : tKanban(lang, 'reviewerNoReply');
                    const reviewMsg = tKanban(lang, 'reviewerNotify', {
                        title: card.title,
                        entityId,
                        reply
                    });
                    notifyEntities(deviceId, [reviewerId], reviewMsg, { cardId: card.id });
                    console.log(`[Kanban] Notified reviewer #${reviewerId} for card ${card.id}`);
                }
            }
        } catch (err) {
            console.error(`[Kanban] autoReviewOnTransform error:`, err.message);
        }
    }

    return { router, initKanbanDatabase, startBackgroundTimers, stopBackgroundTimers, autoReviewOnTransform };
};
