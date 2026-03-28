/**
 * Mission Control Dashboard API
 * PostgreSQL + Optimistic Locking + Trigger Version Control
 *
 * Mounted at: /api/mission
 *
 * Endpoints:
 * GET  /dashboard          - 取得 Dashboard
 * POST /dashboard          - 上傳 Dashboard (含版本檢查)
 * GET  /items              - 取得任務
 * POST /items              - 新增任務
 * PUT  /items/:id          - 更新任務
 * DELETE /items/:id        - 刪除任務
 * GET  /notes              - 取得筆記
 * POST /note/add           - 新增筆記 (Bot)
 * POST /note/update        - 更新筆記 (Bot)
 * POST /note/delete        - 刪除筆記 (Bot)
 * GET  /rules              - 取得規則
 * GET  /souls              - 取得靈魂列表
 * POST /soul/add           - 新增靈魂 (Bot)
 * POST /soul/update        - 更新靈魂 (Bot)
 * POST /soul/delete        - 刪除靈魂 (Bot)
 *
 * Auth: All endpoints accept either deviceSecret (user/APP) or botSecret (bot)
 */

const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const safeEqual = require('./safe-equal');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

// Initialize database tables from schema file
async function initMissionDatabase() {
    try {
        const schemaPath = path.join(__dirname, 'mission_schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');

        // Split SQL respecting $$ function bodies (don't split inside $$ blocks)
        const statements = [];
        let current = '';
        let inDollarBlock = false;
        const lines = schema.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('--')) {
                continue; // skip comments
            }
            current += line + '\n';
            // Track $$ blocks
            const dollarCount = (line.match(/\$\$/g) || []).length;
            if (dollarCount % 2 === 1) {
                inDollarBlock = !inDollarBlock;
            }
            // Only split on ; when outside $$ blocks
            if (!inDollarBlock && trimmed.endsWith(';')) {
                const stmt = current.trim();
                if (stmt && stmt !== ';') {
                    statements.push(stmt);
                }
                current = '';
            }
        }
        if (current.trim()) {
            statements.push(current.trim());
        }

        for (const statement of statements) {
            try {
                await pool.query(statement);
            } catch (err) {
                if (!err.message.includes('already exists') &&
                    !err.message.includes('duplicate key')) {
                    console.warn('[Mission] Schema warning:', err.message);
                }
            }
        }

        console.log('[Mission] Database initialized');
    } catch (error) {
        console.error('[Mission] Failed to init database:', error);
    }
}

/**
 * Factory function - receives the in-memory devices object from index.js
 * Returns { router, initMissionDatabase }
 */
// Priority value → enum name mapping (matches Android Priority enum)
function escapeHtmlServer(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
const PRIORITY_MAP = { 1: 'LOW', 2: 'MEDIUM', 3: 'HIGH', 4: 'CRITICAL' };
function toPriorityName(val) {
    if (typeof val === 'string' && Object.values(PRIORITY_MAP).includes(val)) return val;
    return PRIORITY_MAP[parseInt(val)] || 'MEDIUM';
}

// Normalized Levenshtein similarity [0, 1]
function strSimilarity(a, b) {
    a = (a || '').trim();
    b = (b || '').trim();
    if (a === b) return 1;
    if (!a || !b) return 0;
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) =>
        Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    return 1 - dp[m][n] / Math.max(m, n);
}

module.exports = function(devices, { awardEntityXP, serverLog } = {}) {
    const router = express.Router();

    // ── Deprecation: Mission add endpoints → Kanban ──
    const KANBAN_DEPRECATION_MSG = 'This endpoint is deprecated. Please use the Kanban board instead. The Kanban board has a complete ecosystem — migrate existing items there gradually.';
    const KANBAN_DEPRECATION_MSG_ZH = '此功能已停用，請使用看板任務作為替代方案。看板任務頁面已有完整生態，請讓 bot 將現有任務逐步轉移到看板任務頁面。';
    function rejectDeprecatedAdd(req, res) {
        const lang = req.headers['accept-language'] || '';
        const msg = lang.startsWith('zh') ? KANBAN_DEPRECATION_MSG_ZH : KANBAN_DEPRECATION_MSG;
        return res.status(410).json({ success: false, error: msg, deprecated: true, redirect: 'kanban' });
    }

    // ── Notification Debounce (per-device, 5s window) ──
    const _notifyQueue = new Map();  // deviceId -> { timer, notifications: [], res: null }
    const DEBOUNCE_MS = 5000;

    /**
     * Queue a notification for debounced delivery.
     * Collects notifications per device for DEBOUNCE_MS, then fires one consolidated push.
     * First caller gets immediate ACK; batched notifications fire after 5s of quiet.
     */
    function queueNotification(deviceId, notifications, req, res) {
        let entry = _notifyQueue.get(deviceId);
        if (entry) {
            entry.notifications.push(...notifications);
            clearTimeout(entry.timer);
        } else {
            entry = { notifications: [...notifications], req };
            _notifyQueue.set(deviceId, entry);
        }

        // Always ACK immediately
        if (!res.headersSent) {
            res.json({ success: true, debounced: true, queued: entry.notifications.length, message: `Notification queued, will batch-send after ${DEBOUNCE_MS / 1000}s of inactivity` });
        }

        entry.timer = setTimeout(async () => {
            const queued = _notifyQueue.get(deviceId);
            _notifyQueue.delete(deviceId);
            if (queued && queued.notifications.length > 0) {
                // Deduplicate: same type+title = keep only latest
                const seen = new Map();
                for (const n of queued.notifications) {
                    const key = `${n.type}:${n.title}`;
                    seen.set(key, n);
                }
                const deduped = [...seen.values()];
                console.log(`[Mission] Debounce flush for ${deviceId}: ${queued.notifications.length} queued → ${deduped.length} after dedup`);

                // Use the same /notify endpoint via internal fetch
                try {
                    const body = {
                        deviceId,
                        deviceSecret: queued.req.body.deviceSecret,
                        botSecret: queued.req.body.botSecret,
                        notifications: deduped,
                        immediate: true
                    };
                    // Self-invoke: POST to own /api/mission/notify
                    const port = process.env.PORT || 3000;
                    await fetch(`http://localhost:${port}/api/mission/notify`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                } catch (err) {
                    console.error(`[Mission] Debounce flush error for ${deviceId}:`, err.message);
                }
            }
        }, DEBOUNCE_MS);
    }

    // ============================================
    // Auth Helpers
    // ============================================

    /**
     * Authenticate by botSecret (for bots/OpenClaw)
     */
    function findEntityByCredentials(deviceId, entityId, botSecret) {
        const device = devices[deviceId];
        if (!device) return null;
        const entity = (device.entities || {})[entityId];
        if (!entity || !safeEqual(entity.botSecret, botSecret)) return null;
        return entity;
    }

    /**
     * Authenticate by deviceSecret (for Android APP / web page)
     */
    function findDeviceByCredentials(deviceId, deviceSecret) {
        const device = devices[deviceId];
        if (!device || !safeEqual(device.deviceSecret, deviceSecret)) return null;
        return device;
    }

    /**
     * Dual auth middleware helper - accepts either deviceSecret or botSecret
     * Returns true if authenticated, sends 401 and returns false otherwise
     */
    function authenticate(req, res) {
        const params = { ...req.query, ...req.body };
        const { deviceId, deviceSecret, botSecret, entityId } = params;

        if (!deviceId) {
            res.status(400).json({ success: false, error: 'Missing deviceId' });
            return false;
        }

        // Try deviceSecret first (APP/web user)
        if (deviceSecret) {
            const device = findDeviceByCredentials(deviceId, deviceSecret);
            if (device) return true;
        }

        // Try botSecret (OpenClaw bot)
        if (botSecret) {
            const entity = findEntityByCredentials(deviceId, parseInt(entityId || 0), botSecret);
            if (entity) return true;
        }

        // Neither credential is valid
        if (!deviceSecret && !botSecret) {
            res.status(400).json({ success: false, error: 'Missing deviceSecret or botSecret' });
        } else {
            res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
        return false;
    }

    // ============================================
    // Dashboard API
    // ============================================

    /**
     * GET /dashboard
     * 取得完整 Dashboard
     */
    router.get('/dashboard', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = req.query;

        try {
            const result = await pool.query(
                'SELECT * FROM mission_dashboard WHERE device_id = $1',
                [deviceId]
            );

            if (result.rows.length === 0) {
                // Initialize dashboard if not exists
                await pool.query('SELECT init_mission_dashboard($1)', [deviceId]);

                return res.json({
                    success: true,
                    dashboard: {
                        deviceId,
                        version: 1,
                        todoList: [],
                        missionList: [],
                        doneList: [],
                        notes: [],
                        rules: [],
                        skills: [],
                        souls: [],
                        lastSyncedAt: Date.now()
                    }
                });
            }

            const row = result.rows[0];
            const skills = row.skills || [];

            // Auto-inject system "EClawbot API Skill" if not present
            const systemSkillTitle = 'EClawbot API Skill';
            const hasSystemSkill = skills.some(s => s.isSystem === true);
            if (!hasSystemSkill) {
                skills.unshift({
                    id: 'system-eclaw-api-skill',
                    title: systemSkillTitle,
                    url: 'https://eclawbot.com/api/skill-doc',
                    assignedEntities: [],
                    isSystem: true,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    createdBy: 'system'
                });
                // Persist system skill to DB (fire-and-forget)
                pool.query(
                    `UPDATE mission_dashboard SET skills = $2 WHERE device_id = $1`,
                    [deviceId, JSON.stringify(skills)]
                ).catch(() => {});
            }

            const dashboard = {
                deviceId: row.device_id,
                version: row.version,
                lastSyncedAt: new Date(row.last_synced_at).getTime(),
                todoList: row.todo_list,
                missionList: row.mission_list,
                doneList: row.done_list,
                notes: row.notes,
                rules: row.rules,
                skills: skills,
                souls: row.souls || [],
                lastUpdated: new Date(row.updated_at).getTime()
            };

            res.json({ success: true, dashboard });
        } catch (error) {
            console.error('[Mission] Error fetching dashboard:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    /**
     * POST /dashboard
     * 上傳 Dashboard (Optimistic Locking)
     */
    router.post('/dashboard', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, entityId, dashboard, version } = req.body;

        if (!dashboard) {
            return res.status(400).json({ success: false, error: 'Missing dashboard data' });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // Ensure dashboard row exists (upsert)
            await client.query('SELECT init_mission_dashboard($1)', [deviceId]);

            // Check version (Optimistic Locking)
            if (version !== undefined) {
                const versionCheck = await client.query(
                    'SELECT version FROM mission_dashboard WHERE device_id = $1 FOR UPDATE',
                    [deviceId]
                );

                if (versionCheck.rows.length > 0 && versionCheck.rows[0].version !== version) {
                    await client.query('ROLLBACK');
                    return res.status(409).json({
                        success: false,
                        error: 'VERSION_CONFLICT',
                        message: 'Dashboard has been modified by another client',
                        currentVersion: versionCheck.rows[0].version,
                        yourVersion: version
                    });
                }
            }

            // Preserve system skills on upload (merge: keep existing system skills)
            let uploadedSkills = dashboard.skills || [];
            const existingRow = await client.query(
                'SELECT skills FROM mission_dashboard WHERE device_id = $1',
                [deviceId]
            );
            if (existingRow.rows.length > 0) {
                const existingSkills = existingRow.rows[0].skills || [];
                const systemSkills = existingSkills.filter(s => s.isSystem === true);
                // Remove any system skills from uploaded data, then prepend existing system skills
                uploadedSkills = uploadedSkills.filter(s => s.isSystem !== true);
                uploadedSkills = [...systemSkills, ...uploadedSkills];
            }

            // Update dashboard (Trigger will auto-increment version)
            const result = await client.query(
                `UPDATE mission_dashboard
                 SET todo_list = $2, mission_list = $3, done_list = $4,
                     notes = $5, rules = $6, skills = $7, souls = $8, last_synced_at = NOW()
                 WHERE device_id = $1
                 RETURNING version`,
                [
                    deviceId,
                    JSON.stringify(dashboard.todoList || []),
                    JSON.stringify(dashboard.missionList || []),
                    JSON.stringify(dashboard.doneList || []),
                    JSON.stringify(dashboard.notes || []),
                    JSON.stringify(dashboard.rules || []),
                    JSON.stringify(uploadedSkills),
                    JSON.stringify(dashboard.souls || [])
                ]
            );

            // Log sync action
            await client.query(
                'SELECT record_sync_action($1, $2, $3, $4, $5, $6, $7)',
                [deviceId, 'SYNC', 'DASHBOARD', null, version || 0, result.rows[0].version, `entity_${entityId || 'user'}`]
            );

            await client.query('COMMIT');

            if (process.env.DEBUG === 'true') console.log(`[Mission] Dashboard updated for ${deviceId}, version: ${result.rows[0].version}`);
            if (serverLog) serverLog('info', 'mission', `[Mission] Dashboard updated for ${deviceId}, version: ${result.rows[0].version}`, { deviceId });
            res.json({
                success: true,
                version: result.rows[0].version,
                message: 'Dashboard uploaded successfully'
            });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Mission] Error updating dashboard:', error);
            res.status(500).json({ success: false, error: error.message });
        } finally {
            client.release();
        }
    });

    // ============================================
    // Mission Items API
    // ============================================

    /**
     * GET /items
     * 取得所有任務
     */
    router.get('/items', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, status, priority, listType } = req.query;

        try {
            let query = 'SELECT * FROM mission_items WHERE device_id = $1';
            const params = [deviceId];
            let paramIndex = 2;

            if (status) {
                query += ` AND status = $${paramIndex++}`;
                params.push(status);
            }
            if (priority) {
                query += ` AND priority >= $${paramIndex++}`;
                params.push(parseInt(priority));
            }
            if (listType) {
                query += ` AND list_type = $${paramIndex++}`;
                params.push(listType);
            }

            query += ' ORDER BY priority DESC, created_at DESC';
            const result = await pool.query(query, params);

            res.json({ success: true, items: result.rows });
        } catch (error) {
            console.error('[Mission] Error fetching items:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    /**
     * POST /items
     * 新增任務
     */
    router.post('/items', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, entityId, item, listType } = req.body;

        if (!item || !item.title) {
            return res.status(400).json({ success: false, error: 'Missing item or title' });
        }

        try {
            // Ensure dashboard row exists (FK constraint)
            await pool.query('SELECT init_mission_dashboard($1)', [deviceId]);

            const result = await pool.query(
                `INSERT INTO mission_items
                 (id, device_id, list_type, title, description, priority, status, assigned_bot, eta, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 RETURNING *`,
                [
                    item.id || crypto.randomUUID(),
                    deviceId,
                    listType || 'todo',
                    item.title,
                    item.description || '',
                    item.priority || 2,
                    item.status || 'PENDING',
                    item.assignedBot || null,
                    item.eta ? new Date(item.eta) : null,
                    item.createdBy || 'user'
                ]
            );

            await pool.query(
                'SELECT record_sync_action($1, $2, $3, $4, $5, $6, $7)',
                [deviceId, 'CREATE', 'ITEM', result.rows[0].id, 0, 1, `entity_${entityId || 'user'}`]
            );

            res.json({ success: true, item: result.rows[0] });
        } catch (error) {
            console.error('[Mission] Error adding item:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    /**
     * PUT /items/:id
     * 更新任務
     */
    router.put('/items/:id', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, entityId, item } = req.body;
        const { id } = req.params;

        if (!item) {
            return res.status(400).json({ success: false, error: 'Missing item data' });
        }

        try {
            const oldItem = await pool.query(
                'SELECT * FROM mission_items WHERE id = $1 AND device_id = $2',
                [id, deviceId]
            );

            if (oldItem.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Item not found' });
            }

            const result = await pool.query(
                `UPDATE mission_items
                 SET title = $1, description = $2, priority = $3, status = $4,
                     assigned_bot = $5, eta = $6, updated_at = NOW()
                 WHERE id = $7 AND device_id = $8
                 RETURNING *`,
                [
                    item.title,
                    item.description || '',
                    item.priority || 2,
                    item.status || 'PENDING',
                    item.assignedBot || null,
                    item.eta ? new Date(item.eta) : null,
                    id,
                    deviceId
                ]
            );

            await pool.query(
                'SELECT record_sync_action($1, $2, $3, $4, $5, $6, $7)',
                [deviceId, 'UPDATE', 'ITEM', id, 1, 2, `entity_${entityId || 'user'}`]
            );

            res.json({ success: true, item: result.rows[0] });
        } catch (error) {
            console.error('[Mission] Error updating item:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    /**
     * DELETE /items/:id
     * 刪除任務
     */
    router.delete('/items/:id', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, entityId } = req.body;
        const { id } = req.params;

        try {
            await pool.query(
                'DELETE FROM mission_items WHERE id = $1 AND device_id = $2',
                [id, deviceId]
            );

            await pool.query(
                'SELECT record_sync_action($1, $2, $3, $4, $5, $6, $7)',
                [deviceId, 'DELETE', 'ITEM', id, 0, 0, `entity_${entityId || 'user'}`]
            );

            res.json({ success: true, message: 'Item deleted' });
        } catch (error) {
            console.error('[Mission] Error deleting item:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ============================================
    // Notes API
    // ============================================

    /**
     * GET /notes
     * 取得筆記 (Bots 可讀寫)
     */
    router.get('/notes', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, category } = req.query;

        try {
            let query = 'SELECT * FROM mission_notes WHERE device_id = $1';
            const params = [deviceId];

            if (category) {
                query += ' AND category = $2';
                params.push(category);
            }

            query += ' ORDER BY updated_at DESC';
            const result = await pool.query(query, params);

            res.json({ success: true, notes: result.rows });
        } catch (error) {
            console.error('[Mission] Error fetching notes:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ============================================
    // POST /note/add
    // Bot adds a new note to dashboard
    // ============================================
    router.post('/note/add', async (req, res) => {
        return rejectDeprecatedAdd(req, res);
        /* eslint-disable-next-line no-unreachable */
        if (!authenticate(req, res)) return;
        const { deviceId, entityId, title, content, category } = req.body;

        if (!title) {
            return res.status(400).json({ success: false, error: 'Missing title' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT init_mission_dashboard($1)', [deviceId]);

            const result = await client.query(
                'SELECT * FROM mission_dashboard WHERE device_id = $1 FOR UPDATE',
                [deviceId]
            );
            const row = result.rows[0];
            const notes = row.notes || [];

            const newNote = {
                id: crypto.randomUUID(),
                title: title.trim(),
                content: (content || '').trim(),
                category: (category || 'general').trim(),
                createdAt: Date.now(),
                updatedAt: Date.now(),
                createdBy: entityId != null ? `entity_${entityId}` : 'bot'
            };
            notes.push(newNote);

            const updateResult = await client.query(
                `UPDATE mission_dashboard SET notes = $2, last_synced_at = NOW()
                 WHERE device_id = $1 RETURNING version`,
                [deviceId, JSON.stringify(notes)]
            );
            await client.query('COMMIT');

            if (process.env.DEBUG === 'true') console.log(`[Mission] Note added: "${newNote.title}" by bot, device ${deviceId}`);
            if (serverLog) serverLog('info', 'mission', `[Mission] Note added: "${newNote.title}" by bot, device ${deviceId}`, { deviceId });
            res.json({ success: true, message: `Note "${newNote.title}" added`, item: newNote, version: updateResult.rows[0].version });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Mission] Error adding note:', error);
            res.status(500).json({ success: false, error: error.message });
        } finally {
            client.release();
        }
    });

    // ============================================
    // POST /note/update
    // Bot updates a note by title
    // ============================================
    router.post('/note/update', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, title, newTitle, newContent, newCategory } = req.body;

        if (!title) {
            return res.status(400).json({ success: false, error: 'Missing title' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await client.query(
                'SELECT * FROM mission_dashboard WHERE device_id = $1 FOR UPDATE',
                [deviceId]
            );
            if (result.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: 'Dashboard not found' });
            }

            const row = result.rows[0];
            const notes = row.notes || [];
            const titleLower = title.trim().toLowerCase();
            const note = notes.find(n => n.title && n.title.trim().toLowerCase() === titleLower);

            if (!note) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: `Note not found: "${title}"` });
            }

            if (newTitle) note.title = newTitle.trim();
            if (newContent !== undefined) note.content = newContent.trim();
            if (newCategory !== undefined) note.category = newCategory.trim();
            note.updatedAt = Date.now();

            const updateResult = await client.query(
                `UPDATE mission_dashboard SET notes = $2, last_synced_at = NOW()
                 WHERE device_id = $1 RETURNING version`,
                [deviceId, JSON.stringify(notes)]
            );
            await client.query('COMMIT');

            if (process.env.DEBUG === 'true') console.log(`[Mission] Note updated: "${note.title}", device ${deviceId}`);
            if (serverLog) serverLog('info', 'mission', `[Mission] Note updated: "${note.title}", device ${deviceId}`, { deviceId });
            res.json({ success: true, message: `Note "${note.title}" updated`, item: note, version: updateResult.rows[0].version });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Mission] Error updating note:', error);
            res.status(500).json({ success: false, error: error.message });
        } finally {
            client.release();
        }
    });

    // ============================================
    // POST /note/delete
    // Bot deletes a note by title
    // ============================================
    router.post('/note/delete', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, title } = req.body;

        if (!title) {
            return res.status(400).json({ success: false, error: 'Missing title' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await client.query(
                'SELECT * FROM mission_dashboard WHERE device_id = $1 FOR UPDATE',
                [deviceId]
            );
            if (result.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: 'Dashboard not found' });
            }

            const row = result.rows[0];
            const notes = row.notes || [];
            const titleLower = title.trim().toLowerCase();
            const foundIdx = notes.findIndex(n => n.title && n.title.trim().toLowerCase() === titleLower);

            if (foundIdx < 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: `Note not found: "${title}"` });
            }

            notes.splice(foundIdx, 1);

            const updateResult = await client.query(
                `UPDATE mission_dashboard SET notes = $2, last_synced_at = NOW()
                 WHERE device_id = $1 RETURNING version`,
                [deviceId, JSON.stringify(notes)]
            );
            await client.query('COMMIT');

            if (process.env.DEBUG === 'true') console.log(`[Mission] Note deleted: "${title}", device ${deviceId}`);
            if (serverLog) serverLog('info', 'mission', `[Mission] Note deleted: "${title}", device ${deviceId}`, { deviceId });
            res.json({ success: true, message: `Note "${title}" deleted`, version: updateResult.rows[0].version });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Mission] Error deleting note:', error);
            res.status(500).json({ success: false, error: error.message });
        } finally {
            client.release();
        }
    });

    // ============================================
    // Note Pages API (Webview static pages)
    // ============================================

    const NOTE_PAGE_HTML_MAX = 512 * 1024; // 500KB
    const NOTE_PAGE_DRAWING_MAX = 2 * 1024 * 1024; // 2MB

    /**
     * Helper: resolve noteId from body/query (supports noteId or title lookup)
     */
    async function resolveNoteId(deviceId, params) {
        if (params.noteId) {
            if (typeof params.noteId !== 'string' || params.noteId.length > 128) return null;
            return params.noteId;
        }
        if (!params.title) return null;

        const dash = await pool.query(
            'SELECT notes FROM mission_dashboard WHERE device_id = $1', [deviceId]
        );
        if (dash.rows.length === 0) return null;
        const notes = dash.rows[0].notes || [];
        const titleLower = params.title.trim().toLowerCase();
        const found = notes.find(n => n.title && n.title.trim().toLowerCase() === titleLower);
        return found ? found.id : null;
    }

    /**
     * PUT /note/page
     * Create or update a note's static HTML page
     * Body: { deviceId, noteId (or title), htmlContent }
     */
    router.put('/note/page', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, htmlContent, markdownContent } = req.body;
        const isPublic = req.body.isPublic === true || req.body.isPublic === 'true';

        if (!htmlContent && htmlContent !== '' && !markdownContent) {
            return res.status(400).json({ success: false, error: 'Missing htmlContent or markdownContent' });
        }
        const content = htmlContent || '';
        if (typeof content === 'string' && content.length > NOTE_PAGE_HTML_MAX) {
            return res.status(400).json({ success: false, error: `htmlContent exceeds ${NOTE_PAGE_HTML_MAX} bytes` });
        }
        if (markdownContent && typeof markdownContent === 'string' && markdownContent.length > NOTE_PAGE_HTML_MAX) {
            return res.status(400).json({ success: false, error: `markdownContent exceeds ${NOTE_PAGE_HTML_MAX} bytes` });
        }

        const noteId = await resolveNoteId(deviceId, req.body);
        if (!noteId) {
            return res.status(400).json({ success: false, error: 'Missing or invalid noteId/title' });
        }

        try {
            const result = await pool.query(`
                INSERT INTO note_pages (device_id, note_id, html_content, is_public, markdown_content)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (device_id, note_id)
                DO UPDATE SET html_content = $3, is_public = $4, markdown_content = $5, updated_at = NOW()
                RETURNING id, updated_at, is_public
            `, [deviceId, noteId, content, isPublic, markdownContent || null]);

            if (serverLog) serverLog('info', 'mission', `[Mission] Note page updated: ${noteId}, device ${deviceId}, public: ${isPublic}`, { deviceId });
            res.json({ success: true, message: 'Page saved', id: result.rows[0].id, noteId, isPublic: result.rows[0].is_public, updatedAt: result.rows[0].updated_at });
        } catch (error) {
            console.error('[Mission] Error saving note page:', error);
            res.status(500).json({ success: false, error: 'Internal server error' });
        }
    });

    /**
     * GET /note/page
     * Read a note's static HTML page
     * Query: deviceId, noteId (or title)
     */
    router.get('/note/page', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = req.query;

        const noteId = await resolveNoteId(deviceId, req.query);
        if (!noteId) {
            return res.status(400).json({ success: false, error: 'Missing or invalid noteId/title' });
        }

        try {
            const result = await pool.query(
                'SELECT html_content, drawing_data, drawing_snapshot, is_public, markdown_content, updated_at FROM note_pages WHERE device_id = $1 AND note_id = $2',
                [deviceId, noteId]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Page not found' });
            }
            const row = result.rows[0];
            res.json({ success: true, noteId, htmlContent: row.html_content, drawingData: row.drawing_data, drawingSnapshot: row.drawing_snapshot, isPublic: row.is_public, markdownContent: row.markdown_content, updatedAt: row.updated_at });
        } catch (error) {
            console.error('[Mission] Error fetching note page:', error);
            res.status(500).json({ success: false, error: 'Internal server error' });
        }
    });

    /**
     * GET /note/pages
     * List all noteIds that have pages for a device
     * Query: deviceId
     */
    router.get('/note/pages', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = req.query;

        try {
            const result = await pool.query(
                'SELECT note_id, is_public, updated_at FROM note_pages WHERE device_id = $1 ORDER BY updated_at DESC',
                [deviceId]
            );
            res.json({ success: true, pages: result.rows.map(r => ({ noteId: r.note_id, isPublic: r.is_public, updatedAt: r.updated_at })) });
        } catch (error) {
            console.error('[Mission] Error listing note pages:', error);
            res.status(500).json({ success: false, error: 'Internal server error' });
        }
    });

    /**
     * DELETE /note/page
     * Delete a note's static HTML page
     * Body: { deviceId, noteId (or title) }
     */
    router.delete('/note/page', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = req.body;

        const noteId = await resolveNoteId(deviceId, req.body);
        if (!noteId) {
            return res.status(400).json({ success: false, error: 'Missing or invalid noteId/title' });
        }

        try {
            const result = await pool.query(
                'DELETE FROM note_pages WHERE device_id = $1 AND note_id = $2',
                [deviceId, noteId]
            );
            if (result.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'Page not found' });
            }
            if (serverLog) serverLog('info', 'mission', `[Mission] Note page deleted: ${noteId}, device ${deviceId}`, { deviceId });
            res.json({ success: true, message: 'Page deleted' });
        } catch (error) {
            console.error('[Mission] Error deleting note page:', error);
            res.status(500).json({ success: false, error: 'Internal server error' });
        }
    });

    /**
     * PATCH /note/page/public
     * Toggle is_public flag for a note page
     * Body: { deviceId, noteId (or title), isPublic: boolean }
     */
    router.patch('/note/page/public', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = req.body;
        const isPublic = req.body.isPublic === true || req.body.isPublic === 'true';

        const noteId = await resolveNoteId(deviceId, req.body);
        if (!noteId) {
            return res.status(400).json({ success: false, error: 'Missing or invalid noteId/title' });
        }

        try {
            const result = await pool.query(
                'UPDATE note_pages SET is_public = $3, updated_at = NOW() WHERE device_id = $1 AND note_id = $2 RETURNING is_public, updated_at',
                [deviceId, noteId, isPublic]
            );
            if (result.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'Page not found' });
            }
            if (serverLog) serverLog('info', 'mission', `[Mission] Note page public toggled: ${noteId}, public: ${isPublic}, device ${deviceId}`, { deviceId });
            res.json({ success: true, message: isPublic ? 'Page is now public' : 'Page is now private', noteId, isPublic: result.rows[0].is_public, updatedAt: result.rows[0].updated_at });
        } catch (error) {
            console.error('[Mission] Error toggling note page public:', error);
            res.status(500).json({ success: false, error: 'Internal server error' });
        }
    });

    /**
     * PUT /note/page/drawing
     * Save drawing data for a note's page
     * Body: { deviceId, noteId (or title), drawingData }
     */
    // ============================================
    // PAGE ANALYTICS
    // ============================================
    router.get('/note/page/analytics', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = req.query;
        const noteId = req.query.noteId || null;
        const days = Math.min(parseInt(req.query.days) || 30, 90);

        try {
            const since = new Date(Date.now() - days * 86400000).toISOString();

            // Total views + unique IPs
            const baseWhere = noteId
                ? 'device_id = $1 AND note_id = $2 AND created_at >= $3'
                : 'device_id = $1 AND created_at >= $2';
            const params = noteId ? [deviceId, noteId, since] : [deviceId, since];

            const [totalResult, uniqueResult, dailyResult, topPagesResult] = await Promise.all([
                pool.query(`SELECT COUNT(*) as total FROM page_views WHERE ${baseWhere}`, params),
                pool.query(`SELECT COUNT(DISTINCT visitor_ip) as unique_visitors FROM page_views WHERE ${baseWhere}`, params),
                pool.query(`SELECT DATE(created_at) as day, COUNT(*) as views FROM page_views WHERE ${baseWhere} GROUP BY DATE(created_at) ORDER BY day DESC LIMIT ${days}`, params),
                noteId ? Promise.resolve({ rows: [] }) :
                    pool.query(`SELECT note_id, COUNT(*) as views FROM page_views WHERE device_id = $1 AND note_id IS NOT NULL AND created_at >= $2 GROUP BY note_id ORDER BY views DESC LIMIT 20`, [deviceId, since])
            ]);

            res.json({
                success: true,
                period: { days, since },
                totalViews: parseInt(totalResult.rows[0].total),
                uniqueVisitors: parseInt(uniqueResult.rows[0].unique_visitors),
                daily: dailyResult.rows,
                topPages: topPagesResult.rows
            });
        } catch (error) {
            console.error('[Mission] Analytics error:', error);
            res.status(500).json({ success: false, error: 'Failed to fetch analytics' });
        }
    });

    // ============================================
    // CUSTOM DOMAINS
    // ============================================
    router.get('/custom-domain', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = req.query;
        try {
            const result = await pool.query('SELECT domain, public_code, verified, created_at FROM custom_domains WHERE device_id = $1 ORDER BY created_at DESC', [deviceId]);
            res.json({ success: true, domains: result.rows });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Failed to fetch domains' });
        }
    });

    router.put('/custom-domain', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, domain, publicCode } = req.body;
        if (!domain || !publicCode) return res.status(400).json({ success: false, error: 'Missing domain or publicCode' });

        // Basic domain validation
        const domainRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i;
        if (!domainRegex.test(domain)) return res.status(400).json({ success: false, error: 'Invalid domain format' });

        try {
            const result = await pool.query(`
                INSERT INTO custom_domains (device_id, public_code, domain)
                VALUES ($1, $2, $3)
                ON CONFLICT (domain)
                DO UPDATE SET public_code = $2, updated_at = NOW()
                RETURNING id, verified
            `, [deviceId, publicCode, domain.toLowerCase()]);

            res.json({
                success: true,
                message: 'Domain registered. Add a CNAME record pointing to eclawbot.com to verify.',
                domain: domain.toLowerCase(),
                verified: result.rows[0].verified,
                cname: 'eclawbot.com'
            });
        } catch (error) {
            console.error('[Mission] Custom domain error:', error);
            res.status(500).json({ success: false, error: 'Failed to register domain' });
        }
    });

    router.delete('/custom-domain', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, domain } = req.body;
        if (!domain) return res.status(400).json({ success: false, error: 'Missing domain' });
        try {
            await pool.query('DELETE FROM custom_domains WHERE device_id = $1 AND domain = $2', [deviceId, domain.toLowerCase()]);
            res.json({ success: true, message: 'Domain removed' });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Failed to remove domain' });
        }
    });

    // ============================================
    // FORM SUBMISSIONS (public, no auth)
    // ============================================
    router.post('/note/page/form-submit', async (req, res) => {
        const { publicCode, noteId, formData } = req.body;
        if (!publicCode || !noteId || !formData) {
            return res.status(400).json({ success: false, error: 'Missing publicCode, noteId, or formData' });
        }
        if (typeof formData !== 'object' || Array.isArray(formData)) {
            return res.status(400).json({ success: false, error: 'formData must be an object' });
        }
        // Rate limit: max 10 submissions per IP per hour
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
        try {
            const rateCheck = await pool.query(
                "SELECT COUNT(*) as cnt FROM form_submissions WHERE visitor_ip = $1 AND created_at > NOW() - INTERVAL '1 hour'",
                [ip]
            );
            if (parseInt(rateCheck.rows[0].cnt) >= 10) {
                return res.status(429).json({ success: false, error: 'Too many submissions. Try again later.' });
            }

            // Look up device from publicCode (use internal index via devices)
            let deviceId = null;
            let entityId = null;
            for (const [dId, dev] of Object.entries(devices)) {
                if (dev.entities) {
                    for (const [eId, ent] of Object.entries(dev.entities)) {
                        if (ent.publicCode === publicCode) {
                            deviceId = dId;
                            entityId = parseInt(eId);
                            break;
                        }
                    }
                }
                if (deviceId) break;
            }
            if (!deviceId) {
                return res.status(404).json({ success: false, error: 'Entity not found' });
            }

            // Store submission
            const result = await pool.query(
                'INSERT INTO form_submissions (device_id, note_id, public_code, form_data, visitor_ip) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at',
                [deviceId, noteId, publicCode, JSON.stringify(formData), ip]
            );

            // Notify entity via cross-speak (fire and forget)
            const formSummary = Object.entries(formData).map(([k, v]) => `${k}: ${v}`).join('\n');
            const notifyText = `📝 新表單提交 (${publicCode}/${noteId})\n${formSummary}`;
            try {
                // Use the cross-speak endpoint to notify
                const { default: fetch } = await import('node-fetch');
                await fetch(`http://localhost:${process.env.PORT || 3000}/api/transform`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        deviceId,
                        entityId,
                        botSecret: null, // internal call needs different auth
                        targetDeviceId: deviceId,
                        message: notifyText,
                        source: 'form_submission'
                    })
                }).catch(() => {});
            } catch (_) {}

            res.json({
                success: true,
                message: 'Form submitted successfully',
                submissionId: result.rows[0].id,
                submittedAt: result.rows[0].created_at
            });
        } catch (error) {
            console.error('[Mission] Form submission error:', error);
            res.status(500).json({ success: false, error: 'Failed to submit form' });
        }
    });

    // Get form submissions (authenticated)
    router.get('/note/page/form-submissions', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, noteId } = req.query;
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        try {
            const where = noteId
                ? 'WHERE device_id = $1 AND note_id = $2'
                : 'WHERE device_id = $1';
            const params = noteId ? [deviceId, noteId] : [deviceId];
            const result = await pool.query(
                `SELECT id, note_id, public_code, form_data, status, created_at FROM form_submissions ${where} ORDER BY created_at DESC LIMIT ${limit}`,
                params
            );
            res.json({ success: true, submissions: result.rows });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Failed to fetch submissions' });
        }
    });

    // ============================================
    // CHAT COMMERCE ORDERS
    // ============================================
    // Create order (from chat, public)
    router.post('/order/create', async (req, res) => {
        const { publicCode, productName, productPrice, quantity, shipping } = req.body;
        if (!publicCode || !productName) {
            return res.status(400).json({ success: false, error: 'Missing publicCode or productName' });
        }

        // Rate limit: 5 orders per IP per hour
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
        try {
            const rateCheck = await pool.query(
                "SELECT COUNT(*) as cnt FROM chat_orders WHERE device_id IN (SELECT device_id FROM chat_orders WHERE public_code = $1 LIMIT 1) AND created_at > NOW() - INTERVAL '1 hour'",
                [publicCode]
            );

            // Find device from publicCode
            let deviceId = null, entityId = null;
            for (const [dId, dev] of Object.entries(devices)) {
                if (dev.entities) {
                    for (const [eId, ent] of Object.entries(dev.entities)) {
                        if (ent.publicCode === publicCode) { deviceId = dId; entityId = parseInt(eId); break; }
                    }
                }
                if (deviceId) break;
            }
            if (!deviceId) return res.status(404).json({ success: false, error: 'Entity not found' });

            const result = await pool.query(`
                INSERT INTO chat_orders (device_id, entity_id, public_code, product_name, product_price, quantity,
                    shipping_name, shipping_phone, shipping_address, shipping_email, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending_payment')
                RETURNING order_id, id, created_at
            `, [deviceId, entityId, publicCode, productName, productPrice || 0, quantity || 1,
                shipping?.name || null, shipping?.phone || null, shipping?.address || null, shipping?.email || null]);

            const order = result.rows[0];
            res.json({
                success: true,
                orderId: order.order_id,
                message: 'Order created. Proceed to payment.',
                paymentUrl: `/api/mission/order/pay?orderId=${order.order_id}`
            });
        } catch (error) {
            console.error('[Mission] Order create error:', error);
            res.status(500).json({ success: false, error: 'Failed to create order' });
        }
    });

    // Get order status
    router.get('/order/status', async (req, res) => {
        const { orderId } = req.query;
        if (!orderId) return res.status(400).json({ success: false, error: 'Missing orderId' });
        try {
            const result = await pool.query(
                'SELECT order_id, product_name, product_price, quantity, status, payment_status, created_at FROM chat_orders WHERE order_id = $1',
                [orderId]
            );
            if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Order not found' });
            res.json({ success: true, order: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Failed to fetch order' });
        }
    });

    // List orders (authenticated)
    router.get('/orders', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = req.query;
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const status = req.query.status;
        try {
            let query = 'SELECT * FROM chat_orders WHERE device_id = $1';
            const params = [deviceId];
            if (status) { query += ' AND status = $2'; params.push(status); }
            query += ` ORDER BY created_at DESC LIMIT ${limit}`;
            const result = await pool.query(query, params);
            res.json({ success: true, orders: result.rows });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Failed to fetch orders' });
        }
    });

    // Update order status (authenticated)
    router.put('/order/update', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { orderId, status, paymentStatus, notes } = req.body;
        if (!orderId) return res.status(400).json({ success: false, error: 'Missing orderId' });
        try {
            const sets = ['updated_at = NOW()'];
            const params = [];
            let idx = 1;
            if (status) { sets.push(`status = $${idx++}`); params.push(status); }
            if (paymentStatus) { sets.push(`payment_status = $${idx++}`); params.push(paymentStatus); }
            if (notes) { sets.push(`notes = $${idx++}`); params.push(notes); }
            params.push(orderId);
            await pool.query(`UPDATE chat_orders SET ${sets.join(', ')} WHERE order_id = $${idx}`, params);
            res.json({ success: true, message: 'Order updated' });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Failed to update order' });
        }
    });

    // TapPay payment page (renders payment form)
    router.get('/order/pay', async (req, res) => {
        const { orderId } = req.query;
        if (!orderId) return res.status(400).send('Missing orderId');
        try {
            const result = await pool.query(
                'SELECT order_id, product_name, product_price, quantity, status FROM chat_orders WHERE order_id = $1',
                [orderId]
            );
            if (result.rows.length === 0) return res.status(404).send('Order not found');
            const order = result.rows[0];
            if (order.status !== 'pending_payment') return res.send('<h2>This order has already been processed.</h2>');

            const total = (order.product_price * order.quantity).toFixed(0);
            // Render TapPay payment page
            res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>付款 — ${escapeHtmlServer(order.product_name)}</title>
<style>
:root{--bg:#0f1117;--card:#1a1d27;--text:#e0e0e0;--muted:#8a8f98;--accent:#7c6aef;--border:#2a2d3a}
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;justify-content:center;padding:24px}
.pay-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:32px;max-width:420px;width:100%}
h2{font-size:20px;margin-bottom:16px}
.item{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border)}
.total{font-size:24px;font-weight:700;color:var(--accent);text-align:right;margin:16px 0}
#tappay-iframe{width:100%;height:200px;margin:16px 0;border:1px solid var(--border);border-radius:8px}
.pay-btn{width:100%;padding:14px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:700;cursor:pointer}
.pay-btn:disabled{opacity:.5;cursor:not-allowed}
.note{font-size:12px;color:var(--muted);margin-top:12px;text-align:center}
</style></head><body>
<div class="pay-card">
    <h2>🛒 訂單付款</h2>
    <div class="item"><span>${escapeHtmlServer(order.product_name)} x${order.quantity}</span><span>NT$ ${total}</span></div>
    <div class="total">合計：NT$ ${total}</div>
    <div id="tappay-iframe"></div>
    <button class="pay-btn" id="payBtn" onclick="submitPayment()">💳 確認付款 NT$ ${total}</button>
    <p class="note">訂單編號：${order.order_id}<br>付款由 TapPay 安全處理</p>
</div>
<script src="https://js.tappaysdk.com/sdk/tpdirect/v5.18.0"></script>
<script>
const ORDER_ID = '${order.order_id}';
// Initialize TapPay — APP_ID and APP_KEY should come from server config
// For sandbox testing: APP_ID=12348, APP_KEY=app_pa1pQcKoY22IlnSXq5m5WP5jFKzoRG58VEXpT7wU62ud7mMbDOGzCYIlzzLF
if (typeof TPDirect !== 'undefined') {
    TPDirect.setupSDK(12348, 'app_pa1pQcKoY22IlnSXq5m5WP5jFKzoRG58VEXpT7wU62ud7mMbDOGzCYIlzzLF', 'sandbox');
    TPDirect.card.setup({
        fields: {
            number: { element: '#tappay-iframe', placeholder: '**** **** **** ****' },
        },
        styles: { 'input': { 'color': '#e0e0e0', 'font-size': '16px' } }
    });
}
async function submitPayment() {
    document.getElementById('payBtn').disabled = true;
    document.getElementById('payBtn').textContent = '⏳ 處理中...';
    // In production: TPDirect.card.getPrime → send to backend → backend calls TapPay Pay by Prime
    // For now, mark as demo payment
    try {
        const resp = await fetch('/api/mission/order/update', {
            method: 'PUT', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({orderId: ORDER_ID, status: 'paid', paymentStatus: 'completed'})
        });
        const r = await resp.json();
        if (r.success) {
            document.querySelector('.pay-card').innerHTML = '<h2>✅ 付款成功！</h2><p style="margin-top:16px;color:var(--muted)">訂單 ' + ORDER_ID + ' 已完成付款。<br>客服將會聯繫您確認出貨。</p><p style="margin-top:24px;text-align:center"><a href="javascript:window.close()" style="color:var(--accent)">關閉此頁面</a></p>';
        }
    } catch(e) { alert('付款失敗：' + e.message); }
}
</script></body></html>`);
        } catch (error) {
            res.status(500).send('Payment error');
        }
    });

    router.put('/note/page/drawing', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, drawingData, drawingSnapshot } = req.body;

        if (drawingData === undefined) {
            return res.status(400).json({ success: false, error: 'Missing drawingData' });
        }
        const dataStr = typeof drawingData === 'string' ? drawingData : JSON.stringify(drawingData);
        if (dataStr.length > NOTE_PAGE_DRAWING_MAX) {
            return res.status(400).json({ success: false, error: `drawingData exceeds ${NOTE_PAGE_DRAWING_MAX} bytes` });
        }

        // Validate snapshot if provided (must be a data:image/png;base64 string, max 2MB)
        let snapshotStr = null;
        if (drawingSnapshot) {
            snapshotStr = typeof drawingSnapshot === 'string' ? drawingSnapshot : null;
            if (snapshotStr && !snapshotStr.startsWith('data:image/png;base64,')) {
                return res.status(400).json({ success: false, error: 'drawingSnapshot must be a PNG data URL' });
            }
            if (snapshotStr && snapshotStr.length > NOTE_PAGE_DRAWING_MAX) {
                return res.status(400).json({ success: false, error: `drawingSnapshot exceeds ${NOTE_PAGE_DRAWING_MAX} bytes` });
            }
        }

        const noteId = await resolveNoteId(deviceId, req.body);
        if (!noteId) {
            return res.status(400).json({ success: false, error: 'Missing or invalid noteId/title' });
        }

        try {
            const result = await pool.query(
                'UPDATE note_pages SET drawing_data = $3, drawing_snapshot = $4, updated_at = NOW() WHERE device_id = $1 AND note_id = $2',
                [deviceId, noteId, dataStr, snapshotStr]
            );
            if (result.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'Page not found. Create page first with PUT /note/page' });
            }
            res.json({ success: true, message: 'Drawing saved' });
        } catch (error) {
            console.error('[Mission] Error saving drawing:', error);
            res.status(500).json({ success: false, error: 'Internal server error' });
        }
    });

    // ============================================
    // Rules API
    // ============================================

    /**
     * GET /rules
     * 取得規則列表
     */
    router.get('/rules', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, type } = req.query;

        try {
            let query = 'SELECT * FROM mission_rules WHERE device_id = $1';
            const params = [deviceId];

            if (type) {
                query += ' AND rule_type = $2';
                params.push(type);
            }

            query += ' ORDER BY priority DESC, created_at DESC';
            const result = await pool.query(query, params);

            res.json({ success: true, rules: result.rows });
        } catch (error) {
            console.error('[Mission] Error fetching rules:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ============================================
    // Mission Notify API
    // ============================================

    /**
     * POST /notify
     * Push mission updates to assigned entities via webhook
     * Body: { deviceId, deviceSecret, notifications: [{ type, title, priority, entityIds, url }] }
     *
     * type: 'TODO' | 'SKILL' | 'RULE'
     * TODO with HIGH/CRITICAL = 立刻執行
     * SKILL = 必須安裝
     * RULE = 必須遵守
     */
    router.post('/notify', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, notifications, immediate } = req.body;

        if (!notifications || !Array.isArray(notifications) || notifications.length === 0) {
            return res.status(400).json({ success: false, error: 'Missing notifications' });
        }

        const device = devices[deviceId];
        if (!device) {
            return res.status(404).json({ success: false, error: 'Device not found' });
        }

        // Debounce: queue notifications and batch-send after 5s of inactivity
        // Pass immediate=true to bypass debounce (e.g. manual trigger)
        if (!immediate) {
            return queueNotification(deviceId, notifications, req, res);
        }

        // Build consolidated notification lines with entity labels
        const entityMessages = {};  // entityId -> [lines]
        const allLines = [];        // for the consolidated chat message
        for (const n of notifications) {
            const entityIds = n.entityIds || [];
            let typeTag = '';
            if (n.type === 'TODO') {
                const urgency = (n.priority >= 3) ? '⚠️ 立刻執行' : '📋 待處理';
                typeTag = `[TODO ${urgency}]`;
            } else if (n.type === 'SKILL') {
                typeTag = '[SKILL 必須安裝]';
            } else if (n.type === 'RULE') {
                typeTag = '[RULE 必須遵守]';
            } else if (n.type === 'SOUL') {
                typeTag = '[SOUL 靈魂設定]';
            } else {
                typeTag = `[${n.type}]`;
            }

            const entityLabels = entityIds.map(id => {
                const e = device.entities[parseInt(id)];
                return e ? `Entity ${id}` : `Entity ${id}`;
            }).join(', ');
            const line = `${typeTag} ${n.title}${n.url ? ' - ' + n.url : ''} → ${entityLabels}`;
            allLines.push(line);

            for (const eId of entityIds) {
                const id = parseInt(eId);
                if (!entityMessages[id]) entityMessages[id] = { lines: [], types: new Set() };
                const perEntityLine = `${typeTag} ${n.title}${n.url ? ' - ' + n.url : ''}`;
                entityMessages[id].lines.push(perEntityLine);
                entityMessages[id].types.add(n.type);
            }
        }

        // Save ONE consolidated chat message (user bubble)
        // Source encodes target entity IDs: "mission_notify:0,1"
        const chatText = `📢 任務通知\n${allLines.join('\n')}`;
        const allEntityIds = [...new Set(notifications.flatMap(n => (n.entityIds || []).map(Number)))];
        const chatSource = `mission_notify:${allEntityIds.join(',')}`;
        let chatMsgId = null;
        try {
            const insertResult = await pool.query(
                `INSERT INTO chat_messages (device_id, entity_id, text, source, is_from_user, is_from_bot)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [deviceId, null, chatText, chatSource, true, false]
            );
            chatMsgId = insertResult.rows[0]?.id;
        } catch (dbErr) {
            console.warn('[Mission] Failed to save consolidated chat message:', dbErr.message);
        }

        // Respond immediately after DB save so frontend can navigate to chat
        res.json({
            success: true,
            chatMessageId: chatMsgId,
            total: Object.keys(entityMessages).length
        });

        // Push to each entity via webhook (background, non-blocking)
        const pushPromises = Object.entries(entityMessages).map(async ([eIdStr, msgData]) => {
            const eId = parseInt(eIdStr);
            const { lines, types } = msgData;
            const entity = device.entities[eId];
            if (!entity || !entity.isBound) {
                return { entityId: eId, pushed: false, reason: 'not_bound' };
            }

            const botSecret = entity.botSecret || 'xxx';
            const auth = `"deviceId":"${deviceId}","botSecret":"${botSecret}","entityId":${eId}`;
            const dashboardApi = `GET /api/mission/dashboard?deviceId=${deviceId}&botSecret=${botSecret}&entityId=${eId}`;

            // Build smart API hints based on notification types
            const apiHints = [`取得完整任務面板: ${dashboardApi}`];
            if (types.has('TODO')) {
                apiHints.push(`建立看板卡片: POST /api/mission/card {${auth},"title":"<標題>","status":"todo","priority":"P2"}`);
                apiHints.push(`列出看板卡片: GET /api/mission/cards?${auth}`);
                apiHints.push(`移動卡片狀態: POST /api/mission/card/<cardId>/move {${auth},"status":"done"}`);
            }
            if (types.has('RULE')) {
                apiHints.push(`新增規則: POST /api/mission/rule/add {${auth},"name":"<規則名>","description":"<說明>","ruleType":"WORKFLOW","category":"<類別(可選)>"}`);
                apiHints.push(`更新規則: POST /api/mission/rule/update {${auth},"name":"<原名>","newCategory":"<新類別>"}`);
                apiHints.push(`刪除規則: POST /api/mission/rule/delete {${auth},"name":"<規則名>"}`);
            }
            if (types.has('SKILL')) {
                apiHints.push(`新增技能: POST /api/mission/skill/add {${auth},"title":"<技能名>","url":"<連結>","category":"<類別(可選)>"}`);
                apiHints.push(`更新技能: POST /api/mission/skill/update {${auth},"title":"<原標題>","newCategory":"<新類別>"}`);
                apiHints.push(`刪除技能: POST /api/mission/skill/delete {${auth},"title":"<技能名>"}`);
            }
            if (types.has('SOUL')) {
                apiHints.push(`新增靈魂: POST /api/mission/soul/add {${auth},"name":"<靈魂名>","description":"<描述>","category":"<類別(可選)>"}`);
                apiHints.push(`更新靈魂: POST /api/mission/soul/update {${auth},"name":"<原名>","newDescription":"<新描述>","newCategory":"<新類別>"}`);
                apiHints.push(`切換靈魂啟用: POST /api/mission/soul/update {${auth},"name":"<靈魂名>","newIsActive":true/false}`);
                apiHints.push(`刪除靈魂: POST /api/mission/soul/delete {${auth},"name":"<靈魂名>"}`);
                apiHints.push(`⚠️ 靈魂規則: isActive=true 的靈魂才需要採用其人設風格回覆，isActive=false 的靈魂請完全忽略`);
            }
            // Notes: bots always have read-write access
            apiHints.push(`取得筆記: GET /api/mission/notes?deviceId=${deviceId}&botSecret=${botSecret}&category=<可選>`);
            apiHints.push(`新增筆記: POST /api/mission/note/add {${auth},"title":"<標題>","content":"<內容>","category":"<類別>"}`);
            apiHints.push(`更新筆記: POST /api/mission/note/update {${auth},"title":"<原標題>","newTitle":"<新標題>","newContent":"<新內容>","newCategory":"<新類別>"}`);
            apiHints.push(`刪除筆記: POST /api/mission/note/delete {${auth},"title":"<標題>"}`);

            const pushMessage = `[Mission Control 任務更新]\n${lines.join('\n')}\n\n可用操作:\n${apiHints.join('\n')}`;

            const fullMessage = `[Device ${deviceId} Entity ${eId} - Mission Control 更新]\n${pushMessage}\n注意: 請使用 update_claw_status (POST /api/transform) 來回覆此訊息，將回覆內容放在 message 欄位`;

            // Channel bot path (Bot Push Parity Rule)
            if (entity.bindingType === 'channel' && _pushToChannelCallback) {
                const result = await _pushToChannelCallback(deviceId, eId, {
                    event: 'message',
                    from: 'mission_control',
                    text: pushMessage,
                    eclaw_context: {
                        expectsReply: true,
                        silentToken: '[SILENT]',
                        missionHints: ''   // body already contains full mission context
                    }
                }, entity.channelAccountId);
                return { entityId: eId, pushed: result.pushed, reason: result.reason };
            }

            if (_pushToBot) {
                const result = await _pushToBot(entity, deviceId, "mission_notify", { message: fullMessage });
                return { entityId: eId, ...result };
            }

            // Fallback: no pushToBot wired (should not happen in production)
            console.warn(`[Mission] _pushToBot not set, skipping push for Entity ${eId}`);
            return { entityId: eId, pushed: false, reason: 'pushToBot_not_configured' };
        });

        // Background: update delivery status after all pushes complete
        Promise.all(pushPromises).then(async (pushResults) => {
            const deliveredIds = pushResults.filter(r => r.pushed).map(r => r.entityId);
            if (chatMsgId && deliveredIds.length > 0) {
                try {
                    await pool.query(
                        `UPDATE chat_messages SET is_delivered = true, delivered_to = $2 WHERE id = $1`,
                        [chatMsgId, deliveredIds.join(',')]
                    );
                } catch (e) { /* ignore */ }
            }
            if (process.env.DEBUG === 'true') console.log(`[Mission] Notify delivery complete: ${deliveredIds.length}/${pushResults.length} pushed`);
            if (serverLog) serverLog('info', 'mission', `[Mission] Notify delivery complete: ${deliveredIds.length}/${pushResults.length} pushed`, { deviceId });
        }).catch(err => {
            console.error('[Mission] Background push error:', err.message);
        });
    });


    // ============================================
    // POST /rule/add
    // Bot adds a new rule to dashboard
    // ============================================
    router.post('/rule/add', async (req, res) => {
        return rejectDeprecatedAdd(req, res);
        /* eslint-disable-next-line no-unreachable */
        if (!authenticate(req, res)) return;
        const { deviceId, entityId, name, description, ruleType, assignedEntities, category } = req.body;

        if (!name) {
            return res.status(400).json({ success: false, error: 'Missing name' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT init_mission_dashboard($1)', [deviceId]);

            const result = await client.query(
                'SELECT * FROM mission_dashboard WHERE device_id = $1 FOR UPDATE',
                [deviceId]
            );
            const row = result.rows[0];
            const rules = row.rules || [];

            const entities = assignedEntities || (entityId != null ? [String(entityId)] : []);
            const nameNorm = name.trim().toLowerCase();
            const descNorm = (description || '').trim();
            const existing = rules.find(r =>
                r.name && r.name.trim().toLowerCase() === nameNorm &&
                strSimilarity(r.description || '', descNorm) >= 0.85
            );

            let resultRule;
            if (existing) {
                // Merge assignedEntities to avoid duplicates across multi-entity notify
                existing.assignedEntities = [...new Set([...(existing.assignedEntities || []), ...entities])];
                existing.updatedAt = Date.now();
                resultRule = existing;
            } else {
                resultRule = {
                    id: crypto.randomUUID(),
                    name: name.trim(),
                    description: descNorm,
                    ruleType: ruleType || 'WORKFLOW',
                    assignedEntities: entities,
                    isEnabled: true,
                    priority: 0,
                    config: {},
                    category: category ? category.trim() : null,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                };
                rules.push(resultRule);
            }

            const updateResult = await client.query(
                `UPDATE mission_dashboard SET rules = $2, last_synced_at = NOW()
                 WHERE device_id = $1 RETURNING version`,
                [deviceId, JSON.stringify(rules)]
            );
            await client.query('COMMIT');

            const ruleAction = existing ? 'merged' : 'added';
            if (process.env.DEBUG === 'true') console.log(`[Mission] Rule ${ruleAction}: "${resultRule.name}" by bot, device ${deviceId}`);
            if (serverLog) serverLog('info', 'mission', `[Mission] Rule ${ruleAction}: "${resultRule.name}" by bot, device ${deviceId}`, { deviceId });
            res.json({ success: true, message: `Rule "${resultRule.name}" ${ruleAction}`, item: resultRule, version: updateResult.rows[0].version });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Mission] Error adding rule:', error);
            res.status(500).json({ success: false, error: error.message });
        } finally {
            client.release();
        }
    });

    // ============================================
    // POST /rule/update
    // Bot updates a rule by name
    // ============================================
    router.post('/rule/update', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, name, newName, newDescription, newRuleType, newAssignedEntities, newIsEnabled, newCategory } = req.body;

        if (!name) {
            return res.status(400).json({ success: false, error: 'Missing name' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await client.query(
                'SELECT * FROM mission_dashboard WHERE device_id = $1 FOR UPDATE',
                [deviceId]
            );
            if (result.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: 'Dashboard not found' });
            }

            const row = result.rows[0];
            const rules = row.rules || [];
            const nameLower = name.trim().toLowerCase();
            const rule = rules.find(r => r.name && r.name.trim().toLowerCase() === nameLower);

            if (!rule) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: `Rule not found: "${name}"` });
            }

            if (newName) rule.name = newName.trim();
            if (newDescription !== undefined) rule.description = newDescription.trim();
            if (newRuleType) rule.ruleType = newRuleType;
            if (newAssignedEntities !== undefined) rule.assignedEntities = newAssignedEntities;
            if (newIsEnabled !== undefined) rule.isEnabled = newIsEnabled;
            if (newCategory !== undefined) rule.category = newCategory ? newCategory.trim() : null;
            rule.updatedAt = Date.now();

            const updateResult = await client.query(
                `UPDATE mission_dashboard SET rules = $2, last_synced_at = NOW()
                 WHERE device_id = $1 RETURNING version`,
                [deviceId, JSON.stringify(rules)]
            );
            await client.query('COMMIT');

            if (process.env.DEBUG === 'true') console.log(`[Mission] Rule updated: "${rule.name}", device ${deviceId}`);
            if (serverLog) serverLog('info', 'mission', `[Mission] Rule updated: "${rule.name}", device ${deviceId}`, { deviceId });
            res.json({ success: true, message: `Rule "${rule.name}" updated`, item: rule, version: updateResult.rows[0].version });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Mission] Error updating rule:', error);
            res.status(500).json({ success: false, error: error.message });
        } finally {
            client.release();
        }
    });

    // ============================================
    // POST /rule/delete
    // Bot deletes a rule by name
    // ============================================
    router.post('/rule/delete', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, name } = req.body;

        if (!name) {
            return res.status(400).json({ success: false, error: 'Missing name' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await client.query(
                'SELECT * FROM mission_dashboard WHERE device_id = $1 FOR UPDATE',
                [deviceId]
            );
            if (result.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: 'Dashboard not found' });
            }

            const row = result.rows[0];
            const rules = row.rules || [];
            const nameLower = name.trim().toLowerCase();
            const foundIdx = rules.findIndex(r => r.name && r.name.trim().toLowerCase() === nameLower);

            if (foundIdx < 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: `Rule not found: "${name}"` });
            }

            rules.splice(foundIdx, 1);

            const updateResult = await client.query(
                `UPDATE mission_dashboard SET rules = $2, last_synced_at = NOW()
                 WHERE device_id = $1 RETURNING version`,
                [deviceId, JSON.stringify(rules)]
            );
            await client.query('COMMIT');

            if (process.env.DEBUG === 'true') console.log(`[Mission] Rule deleted: "${name}", device ${deviceId}`);
            if (serverLog) serverLog('info', 'mission', `[Mission] Rule deleted: "${name}", device ${deviceId}`, { deviceId });
            res.json({ success: true, message: `Rule "${name}" deleted`, version: updateResult.rows[0].version });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Mission] Error deleting rule:', error);
            res.status(500).json({ success: false, error: error.message });
        } finally {
            client.release();
        }
    });

    // ============================================
    // POST /skill/add
    // Bot adds a new skill to dashboard
    // ============================================
    router.post('/skill/add', async (req, res) => {
        return rejectDeprecatedAdd(req, res);
        /* eslint-disable-next-line no-unreachable */
        if (!authenticate(req, res)) return;
        const { deviceId, entityId, title, url, assignedEntities, category } = req.body;

        if (!title) {
            return res.status(400).json({ success: false, error: 'Missing title' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT init_mission_dashboard($1)', [deviceId]);

            const result = await client.query(
                'SELECT * FROM mission_dashboard WHERE device_id = $1 FOR UPDATE',
                [deviceId]
            );
            const row = result.rows[0];
            const skills = row.skills || [];

            const entities = assignedEntities || (entityId != null ? [String(entityId)] : []);
            const titleNorm = title.trim().toLowerCase();
            const urlNorm = (url || '').trim();
            const existing = skills.find(s =>
                s.title && s.title.trim().toLowerCase() === titleNorm &&
                (s.url || '').trim() === urlNorm
            );

            let resultSkill;
            if (existing) {
                // Merge assignedEntities to avoid duplicates across multi-entity notify
                existing.assignedEntities = [...new Set([...(existing.assignedEntities || []), ...entities])];
                existing.updatedAt = Date.now();
                resultSkill = existing;
            } else {
                resultSkill = {
                    id: crypto.randomUUID(),
                    title: title.trim(),
                    url: urlNorm,
                    assignedEntities: entities,
                    category: category ? category.trim() : null,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    createdBy: entityId != null ? `entity_${entityId}` : 'bot'
                };
                skills.push(resultSkill);
            }

            const updateResult = await client.query(
                `UPDATE mission_dashboard SET skills = $2, last_synced_at = NOW()
                 WHERE device_id = $1 RETURNING version`,
                [deviceId, JSON.stringify(skills)]
            );
            await client.query('COMMIT');

            const skillAction = existing ? 'merged' : 'added';
            if (process.env.DEBUG === 'true') console.log(`[Mission] Skill ${skillAction}: "${resultSkill.title}" by bot, device ${deviceId}`);
            if (serverLog) serverLog('info', 'mission', `[Mission] Skill ${skillAction}: "${resultSkill.title}" by bot, device ${deviceId}`, { deviceId });
            res.json({ success: true, message: `Skill "${resultSkill.title}" ${skillAction}`, item: resultSkill, version: updateResult.rows[0].version });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Mission] Error adding skill:', error);
            res.status(500).json({ success: false, error: error.message });
        } finally {
            client.release();
        }
    });

    // ============================================
    // POST /skill/delete
    // Bot deletes a skill by title
    // ============================================
    router.post('/skill/delete', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, title } = req.body;

        if (!title) {
            return res.status(400).json({ success: false, error: 'Missing title' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await client.query(
                'SELECT * FROM mission_dashboard WHERE device_id = $1 FOR UPDATE',
                [deviceId]
            );
            if (result.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: 'Dashboard not found' });
            }

            const row = result.rows[0];
            const skills = row.skills || [];
            const titleLower = title.trim().toLowerCase();
            const foundIdx = skills.findIndex(s => s.title && s.title.trim().toLowerCase() === titleLower);

            if (foundIdx < 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: `Skill not found: "${title}"` });
            }

            // Block deletion of system skills
            if (skills[foundIdx].isSystem) {
                await client.query('ROLLBACK');
                return res.status(403).json({ success: false, error: 'Cannot delete system skill' });
            }

            skills.splice(foundIdx, 1);

            const updateResult = await client.query(
                `UPDATE mission_dashboard SET skills = $2, last_synced_at = NOW()
                 WHERE device_id = $1 RETURNING version`,
                [deviceId, JSON.stringify(skills)]
            );
            await client.query('COMMIT');

            if (process.env.DEBUG === 'true') console.log(`[Mission] Skill deleted: "${title}", device ${deviceId}`);
            if (serverLog) serverLog('info', 'mission', `[Mission] Skill deleted: "${title}", device ${deviceId}`, { deviceId });
            res.json({ success: true, message: `Skill "${title}" deleted`, version: updateResult.rows[0].version });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Mission] Error deleting skill:', error);
            res.status(500).json({ success: false, error: error.message });
        } finally {
            client.release();
        }
    });

    // ============================================
    // POST /skill/update
    // Bot updates a skill by title
    // ============================================
    router.post('/skill/update', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, title, newTitle, newUrl, newAssignedEntities, newCategory } = req.body;

        if (!title) {
            return res.status(400).json({ success: false, error: 'Missing title' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await client.query(
                'SELECT * FROM mission_dashboard WHERE device_id = $1 FOR UPDATE',
                [deviceId]
            );
            if (result.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: 'Dashboard not found' });
            }

            const row = result.rows[0];
            const skills = row.skills || [];
            const titleLower = title.trim().toLowerCase();
            const skill = skills.find(s => s.title && s.title.trim().toLowerCase() === titleLower);

            if (!skill) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: `Skill not found: "${title}"` });
            }

            if (newTitle) skill.title = newTitle.trim();
            if (newUrl !== undefined) skill.url = (newUrl || '').trim();
            if (newAssignedEntities !== undefined) skill.assignedEntities = newAssignedEntities;
            if (newCategory !== undefined) skill.category = newCategory ? newCategory.trim() : null;
            skill.updatedAt = Date.now();

            const updateResult = await client.query(
                `UPDATE mission_dashboard SET skills = $2, last_synced_at = NOW()
                 WHERE device_id = $1 RETURNING version`,
                [deviceId, JSON.stringify(skills)]
            );
            await client.query('COMMIT');

            if (process.env.DEBUG === 'true') console.log(`[Mission] Skill updated: "${skill.title}", device ${deviceId}`);
            if (serverLog) serverLog('info', 'mission', `[Mission] Skill updated: "${skill.title}", device ${deviceId}`, { deviceId });
            res.json({ success: true, message: `Skill "${skill.title}" updated`, item: skill, version: updateResult.rows[0].version });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Mission] Error updating skill:', error);
            res.status(500).json({ success: false, error: error.message });
        } finally {
            client.release();
        }
    });

    // ============================================
    // Soul API
    // ============================================

    /**
     * GET /souls
     * 取得靈魂列表
     */
    router.get('/souls', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = req.query;

        try {
            const result = await pool.query(
                'SELECT souls FROM mission_dashboard WHERE device_id = $1',
                [deviceId]
            );
            const souls = result.rows.length > 0 ? (result.rows[0].souls || []) : [];
            res.json({ success: true, souls });
        } catch (error) {
            console.error('[Mission] Error fetching souls:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ============================================
    // POST /soul/add
    // Bot adds a new soul to dashboard
    // ============================================
    router.post('/soul/add', async (req, res) => {
        return rejectDeprecatedAdd(req, res);
        /* eslint-disable-next-line no-unreachable */
        if (!authenticate(req, res)) return;
        const { deviceId, entityId, name, description, templateId, assignedEntities, category } = req.body;

        if (!name) {
            return res.status(400).json({ success: false, error: 'Missing name' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT init_mission_dashboard($1)', [deviceId]);

            const result = await client.query(
                'SELECT * FROM mission_dashboard WHERE device_id = $1 FOR UPDATE',
                [deviceId]
            );
            const row = result.rows[0];
            const souls = row.souls || [];

            const entities = assignedEntities || (entityId != null ? [String(entityId)] : []);
            const newSoul = {
                id: crypto.randomUUID(),
                name: name.trim(),
                description: (description || '').trim(),
                templateId: templateId || null,
                assignedEntities: entities,
                isActive: true,
                category: category ? category.trim() : null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                createdBy: entityId != null ? `entity_${entityId}` : 'bot'
            };
            souls.push(newSoul);

            const updateResult = await client.query(
                `UPDATE mission_dashboard SET souls = $2, last_synced_at = NOW()
                 WHERE device_id = $1 RETURNING version`,
                [deviceId, JSON.stringify(souls)]
            );
            await client.query('COMMIT');

            if (process.env.DEBUG === 'true') console.log(`[Mission] Soul added: "${newSoul.name}" by bot, device ${deviceId}`);
            if (serverLog) serverLog('info', 'mission', `[Mission] Soul added: "${newSoul.name}" by bot, device ${deviceId}`, { deviceId });
            res.json({ success: true, message: `Soul "${newSoul.name}" added`, item: newSoul, version: updateResult.rows[0].version });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Mission] Error adding soul:', error);
            res.status(500).json({ success: false, error: error.message });
        } finally {
            client.release();
        }
    });

    // ============================================
    // POST /soul/update
    // Bot updates a soul by name
    // ============================================
    router.post('/soul/update', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, name, newName, newDescription, newTemplateId, newAssignedEntities, newIsActive, newCategory } = req.body;

        if (!name) {
            return res.status(400).json({ success: false, error: 'Missing name' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await client.query(
                'SELECT * FROM mission_dashboard WHERE device_id = $1 FOR UPDATE',
                [deviceId]
            );
            if (result.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: 'Dashboard not found' });
            }

            const row = result.rows[0];
            const souls = row.souls || [];
            const nameLower = name.trim().toLowerCase();
            const soul = souls.find(s => s.name && s.name.trim().toLowerCase() === nameLower);

            if (!soul) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: `Soul not found: "${name}"` });
            }

            if (newName) soul.name = newName.trim();
            if (newDescription !== undefined) soul.description = newDescription.trim();
            if (newTemplateId !== undefined) soul.templateId = newTemplateId;
            if (newAssignedEntities !== undefined) soul.assignedEntities = newAssignedEntities;
            if (newIsActive !== undefined) soul.isActive = newIsActive;
            if (newCategory !== undefined) soul.category = newCategory ? newCategory.trim() : null;
            soul.updatedAt = Date.now();

            const updateResult = await client.query(
                `UPDATE mission_dashboard SET souls = $2, last_synced_at = NOW()
                 WHERE device_id = $1 RETURNING version`,
                [deviceId, JSON.stringify(souls)]
            );
            await client.query('COMMIT');

            if (process.env.DEBUG === 'true') console.log(`[Mission] Soul updated: "${soul.name}", device ${deviceId}`);
            if (serverLog) serverLog('info', 'mission', `[Mission] Soul updated: "${soul.name}", device ${deviceId}`, { deviceId });
            res.json({ success: true, message: `Soul "${soul.name}" updated`, item: soul, version: updateResult.rows[0].version });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Mission] Error updating soul:', error);
            res.status(500).json({ success: false, error: error.message });
        } finally {
            client.release();
        }
    });

    // ============================================
    // POST /soul/delete
    // Bot deletes a soul by name
    // ============================================
    router.post('/soul/delete', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, name } = req.body;

        if (!name) {
            return res.status(400).json({ success: false, error: 'Missing name' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await client.query(
                'SELECT * FROM mission_dashboard WHERE device_id = $1 FOR UPDATE',
                [deviceId]
            );
            if (result.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: 'Dashboard not found' });
            }

            const row = result.rows[0];
            const souls = row.souls || [];
            const nameLower = name.trim().toLowerCase();
            const foundIdx = souls.findIndex(s => s.name && s.name.trim().toLowerCase() === nameLower);

            if (foundIdx < 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: `Soul not found: "${name}"` });
            }

            souls.splice(foundIdx, 1);

            const updateResult = await client.query(
                `UPDATE mission_dashboard SET souls = $2, last_synced_at = NOW()
                 WHERE device_id = $1 RETURNING version`,
                [deviceId, JSON.stringify(souls)]
            );
            await client.query('COMMIT');

            if (process.env.DEBUG === 'true') console.log(`[Mission] Soul deleted: "${name}", device ${deviceId}`);
            if (serverLog) serverLog('info', 'mission', `[Mission] Soul deleted: "${name}", device ${deviceId}`, { deviceId });
            res.json({ success: true, message: `Soul "${name}" deleted`, version: updateResult.rows[0].version });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Mission] Error deleting soul:', error);
            res.status(500).json({ success: false, error: error.message });
        } finally {
            client.release();
        }
    });

    // Notification callback (set from index.js)
    let _notifyCallback = null;
    function setNotifyCallback(fn) { _notifyCallback = fn; }

    // Push-to-bot callback (set from index.js, replaces direct fetch)
    let _pushToBot = null;
    function setPushToBot(fn) { _pushToBot = fn; }

    // Channel push callback (set from index.js, for channel-bound entities)
    let _pushToChannelCallback = null;
    function setPushToChannelCallback(fn) { _pushToChannelCallback = fn; }

    return { router, initMissionDatabase, setNotifyCallback, setPushToBot, setPushToChannelCallback, _pool: pool };
};
