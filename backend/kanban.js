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
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const safeEqual = require('./safe-equal');
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
const STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'];
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
        for (const stmt of statements) {
            try {
                await pool.query(stmt);
            } catch (err) {
                if (!err.message.includes('already exists') &&
                    !err.message.includes('duplicate key')) {
                    console.warn('[Kanban] Schema warning:', err.message);
                }
            }
        }
        console.log('[Kanban] Database initialized');
    } catch (error) {
        console.error('[Kanban] Failed to init database:', error);
    }
}

/**
 * Factory: receives in-memory devices object from index.js
 */
module.exports = function (devices, { awardEntityXP, serverLog, pushToEntity } = {}) {
    const router = express.Router();

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
    async function addSystemComment(cardId, deviceId, text) {
        await pool.query(
            `INSERT INTO kanban_comments (card_id, device_id, from_entity_id, text, is_system)
             VALUES ($1, $2, -1, $3, true)`,
            [cardId, deviceId, text]
        );
    }

    // ── Helper: push notification to entity (non-blocking) ──
    async function notifyEntities(deviceId, entityIds, message) {
        if (!pushToEntity) return;
        for (const eid of entityIds) {
            try {
                await pushToEntity(deviceId, eid, message);
            } catch (e) {
                console.warn(`[Kanban] Failed to push to entity ${eid}:`, e.message);
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
            doneRetentionMs: parseInt(row.done_retention_ms) || 86400000,
            archived: row.archived || false,
            createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
            updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
            // Aggregated counts (if present from JOIN)
            commentCount: parseInt(row.comment_count) || 0,
            noteCount: parseInt(row.note_count) || 0,
            fileCount: parseInt(row.file_count) || 0,
        };

        // Schedule fields
        if (row.schedule_enabled) {
            card.schedule = {
                enabled: row.schedule_enabled,
                type: row.schedule_type,
                cronExpression: row.schedule_cron || null,
                runAt: row.schedule_run_at ? new Date(row.schedule_run_at).getTime() : null,
                timezone: row.schedule_timezone || 'Asia/Taipei',
                lastRunAt: row.schedule_last_run_at ? new Date(row.schedule_last_run_at).getTime() : null,
                nextRunAt: row.schedule_next_run_at ? new Date(row.schedule_next_run_at).getTime() : null,
            };
        }

        return card;
    }

    // ============================================
    // POST /card — Create card
    // ============================================
    router.post('/card', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, title, description, priority, status, assignedBots, entityId } = req.body;

        if (!title || !title.trim()) {
            return res.status(400).json({ success: false, error: 'Missing title' });
        }

        const cardPriority = PRIORITIES.includes(priority) ? priority : 'P2';
        const cardStatus = STATUSES.includes(status) ? status : 'backlog';
        const bots = Array.isArray(assignedBots) ? assignedBots.map(Number) : [];
        const createdBy = parseInt(entityId || 0);

        try {
            const result = await pool.query(
                `INSERT INTO kanban_cards (device_id, title, description, priority, status, assigned_bots, created_by, status_changed_at)
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW())
                 RETURNING *`,
                [deviceId, title.trim(), description || '', cardPriority, cardStatus, JSON.stringify(bots), createdBy]
            );

            const card = serializeCard(result.rows[0]);
            await bumpVersion(deviceId);

            // System comment
            await addSystemComment(card.id, deviceId, `📋 卡片建立 — 狀態: ${STATUS_LABELS[cardStatus]}，指派給: ${bots.map(b => `#${b}`).join(', ') || '未指派'}`);

            // Push notify assigned bots if status != backlog
            if (cardStatus !== 'backlog' && bots.length > 0) {
                const msg = `📋 新任務指派：${PRIORITY_COLORS[cardPriority]} [${cardPriority}] ${title.trim()}\n狀態: ${STATUS_LABELS[cardStatus]}`;
                notifyEntities(deviceId, bots, msg);
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
        const { status: filterStatus, assignedBot, priority: filterPriority } = req.query;

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

            // Order: P0 first, then by status position, then newest first
            query += ` ORDER BY 
                CASE c.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 END,
                CASE c.status WHEN 'in_progress' THEN 0 WHEN 'review' THEN 1 WHEN 'todo' THEN 2 WHEN 'backlog' THEN 3 WHEN 'done' THEN 4 END,
                c.created_at DESC`;

            const result = await pool.query(query, params);
            const cards = result.rows.map(serializeCard);

            // Group by status for kanban view
            const board = {};
            for (const s of STATUSES) board[s] = [];
            for (const card of cards) {
                if (board[card.status]) board[card.status].push(card);
            }

            res.json({ success: true, cards, board, total: cards.length });
        } catch (err) {
            console.error('[Kanban] List cards error:', err);
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
        const cardId = req.params.id;

        try {
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
        const { deviceId, title, description, priority, assignedBots } = req.body;
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
                updates.push(`assigned_bots = $${paramIdx++}::jsonb`);
                params.push(JSON.stringify(assignedBots.map(Number)));
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
    // POST /card/:id/move — Move card status
    // ============================================
    router.post('/card/:id/move', async (req, res) => {
        if (!authenticate(req, res)) return;
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
                const msg = `${direction} 任務狀態變更：[${card.title}]\n${STATUS_LABELS[oldStatus]} → ${STATUS_LABELS[newStatus]}`;
                notifyEntities(deviceId, bots, msg);
            }

            await bumpVersion(deviceId);

            // Award XP for moving to done
            if (newStatus === 'done' && awardEntityXP) {
                for (const bot of bots) {
                    try { await awardEntityXP(deviceId, bot, 25); } catch (e) { /* ignore */ }
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
        const { deviceId, staleThresholdMs, doneRetentionMs } = req.body;
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

            const result = await pool.query(
                `UPDATE kanban_cards SET 
                    schedule_enabled = $1,
                    schedule_type = $2,
                    schedule_cron = $3,
                    schedule_run_at = $4,
                    schedule_timezone = $5,
                    schedule_next_run_at = $6,
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

    /**
     * Scan for stale cards (TODO / In Progress / Review) that exceeded staleThresholdMs.
     * Push nudge to assigned bots + system comment. Respects min 1hr nudge gap.
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
                const statusLabel = STATUS_LABELS[card.status] || card.status;
                const elapsedMs = Date.now() - new Date(card.status_changed_at).getTime();
                const elapsedHrs = Math.round(elapsedMs / 3600000 * 10) / 10;

                await addSystemComment(card.id, card.device_id,
                    `⏰ 催促：此卡片已在「${statusLabel}」停留 ${elapsedHrs} 小時，請 ${bots.map(b => `#${b}`).join(', ') || '負責人'} 繼續推進`);

                await pool.query(
                    `UPDATE kanban_cards SET last_stale_nudge_at = NOW() WHERE id = $1`,
                    [card.id]
                );

                if (bots.length > 0) {
                    const msg = `⏰ 任務催促：[${card.title}]\n已在「${statusLabel}」停留 ${elapsedHrs} 小時，請繼續推進`;
                    notifyEntities(card.device_id, bots, msg);
                }

                console.log(`[Kanban] Nudged card ${card.id} (${card.title}) — ${elapsedHrs}h in ${statusLabel}`);
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
                        const msg = `🗓️ 排程觸發：[${card.title}]\n請開始執行此任務`;
                        notifyEntities(card.device_id, bots, msg);
                    }

                    try { await bumpVersion(card.device_id); } catch (e) { /* ignore */ }
                    console.log(`[Kanban] Once-trigger: ${card.id} (${card.title}) → ${newStatus}`);

                } else if (schedType === 'recurring') {
                    // Recurring: if Done, move back to TODO; notify; compute next run
                    let newStatus = card.status;
                    if (card.status === 'done') {
                        newStatus = 'todo';
                    }

                    // Compute next run
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
                        const msg = `🗓️ 排程觸發：[${card.title}]\n${statusMsg}請繼續推進此任務`;
                        notifyEntities(card.device_id, bots, msg);
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

    return { router, initKanbanDatabase, startBackgroundTimers, stopBackgroundTimers };
};
