/**
 * One-time migration: Copy all legacy mission items + scheduled messages → kanban_cards
 *
 * Data sources:
 *   1. mission_dashboard.todo_list / mission_list / done_list  (JSONB)
 *   2. mission_items table                                      (normalised)
 *   3. scheduled_messages table                                  (scheduler)
 *
 * Original data is PRESERVED — this only INSERTs into kanban_cards.
 * Idempotent: uses `description LIKE '[migrated:...]'` tag to skip duplicates.
 */

'use strict';

// ── Priority mapping helpers ──

/** mission_dashboard JSONB priority string → kanban P0–P3 */
function mapDashboardPriority(p) {
    if (!p) return 'P2';
    const s = String(p).toUpperCase();
    if (s === 'CRITICAL') return 'P0';
    if (s === 'HIGH')     return 'P1';
    if (s === 'LOW')      return 'P3';
    return 'P2'; // MEDIUM or default
}

/** mission_items integer priority (1–4) → kanban P0–P3 */
function mapItemPriority(n) {
    if (n === 4) return 'P0'; // CRITICAL
    if (n === 3) return 'P1'; // HIGH
    if (n === 1) return 'P3'; // LOW
    return 'P2'; // MEDIUM (2) or default
}

/** list_type → kanban status */
function listTypeToStatus(listType) {
    if (listType === 'mission') return 'in_progress';
    if (listType === 'done')    return 'done';
    return 'todo'; // todo or default
}

/** schedule status → kanban status */
function scheduleStatusToKanban(status) {
    if (status === 'completed') return 'done';
    if (status === 'failed')    return 'done';
    if (status === 'active')    return 'in_progress';
    return 'todo'; // pending
}

// ── Migration tag helpers ──
function migrationTag(source, id) {
    return `[migrated:${source}:${id}]`;
}

// ── Main migration function ──
async function runMigration(pool) {
    const stats = {
        dashboard_items: { found: 0, inserted: 0, skipped: 0 },
        mission_items:   { found: 0, inserted: 0, skipped: 0 },
        schedules:       { found: 0, inserted: 0, skipped: 0 },
        errors: []
    };

    // ────────────────────────────────────────────
    // 1. Migrate mission_dashboard JSONB lists
    // ────────────────────────────────────────────
    console.log('[Migration] Step 1/3: Reading mission_dashboard JSONB …');
    const dashRows = await pool.query(
        `SELECT device_id, todo_list, mission_list, done_list FROM mission_dashboard`
    );

    for (const row of dashRows.rows) {
        const deviceId = row.device_id;
        const lists = [
            { items: row.todo_list    || [], status: 'todo' },
            { items: row.mission_list || [], status: 'in_progress' },
            { items: row.done_list    || [], status: 'done' },
        ];

        for (const { items, status } of lists) {
            for (const item of items) {
                stats.dashboard_items.found++;
                const srcId = item.id || `dash-${deviceId}-${stats.dashboard_items.found}`;
                const tag = migrationTag('dashboard', srcId);

                // Idempotency check
                const exists = await pool.query(
                    `SELECT 1 FROM kanban_cards WHERE device_id = $1 AND description LIKE $2 LIMIT 1`,
                    [deviceId, `%${tag}%`]
                );
                if (exists.rows.length > 0) {
                    stats.dashboard_items.skipped++;
                    continue;
                }

                const title = (item.title || '(no title)').substring(0, 255);
                const desc  = (item.description || '') + `\n${tag}`;
                const priority = mapDashboardPriority(item.priority);
                const assignedBots = item.assignedBot != null ? [Number(item.assignedBot)] : [];
                const createdBy = parseInt(item.createdBy) || 0;
                const createdAt = item.createdAt ? new Date(item.createdAt) : new Date();

                try {
                    await pool.query(
                        `INSERT INTO kanban_cards
                            (device_id, title, description, priority, status, assigned_bots, created_by, status_changed_at, created_at, updated_at)
                         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $8, $8)`,
                        [deviceId, title, desc.trim(), priority, status, JSON.stringify(assignedBots), createdBy, createdAt]
                    );
                    stats.dashboard_items.inserted++;
                } catch (err) {
                    stats.errors.push({ source: 'dashboard', deviceId, itemId: srcId, error: err.message });
                }
            }
        }
    }
    console.log(`[Migration] Step 1 done: ${stats.dashboard_items.inserted} inserted, ${stats.dashboard_items.skipped} skipped`);

    // ────────────────────────────────────────────
    // 2. Migrate mission_items table (dedup by UUID)
    // ────────────────────────────────────────────
    console.log('[Migration] Step 2/3: Reading mission_items table …');
    const itemRows = await pool.query(
        `SELECT id, device_id, list_type, title, description, priority, status, assigned_bot, eta, completed_at, created_by, created_at
         FROM mission_items`
    );

    for (const row of itemRows.rows) {
        stats.mission_items.found++;
        const tag = migrationTag('item', row.id);

        const exists = await pool.query(
            `SELECT 1 FROM kanban_cards WHERE device_id = $1 AND description LIKE $2 LIMIT 1`,
            [row.device_id, `%${tag}%`]
        );
        if (exists.rows.length > 0) {
            stats.mission_items.skipped++;
            continue;
        }

        // Also skip if same UUID was already migrated from dashboard JSONB
        const dashTag = migrationTag('dashboard', row.id);
        const dashExists = await pool.query(
            `SELECT 1 FROM kanban_cards WHERE device_id = $1 AND description LIKE $2 LIMIT 1`,
            [row.device_id, `%${dashTag}%`]
        );
        if (dashExists.rows.length > 0) {
            stats.mission_items.skipped++;
            continue;
        }

        const title = (row.title || '(no title)').substring(0, 255);
        const descParts = [row.description || ''];
        if (row.eta) descParts.push(`ETA: ${new Date(row.eta).toISOString()}`);
        if (row.completed_at) descParts.push(`Completed: ${new Date(row.completed_at).toISOString()}`);
        if (row.status && row.status !== 'PENDING') descParts.push(`Original status: ${row.status}`);
        descParts.push(tag);
        const desc = descParts.filter(Boolean).join('\n');

        const priority = mapItemPriority(row.priority);
        const kanbanStatus = listTypeToStatus(row.list_type);
        const assignedBots = row.assigned_bot != null ? [Number(row.assigned_bot)] : [];
        const createdBy = parseInt(row.created_by) || 0;
        const createdAt = row.created_at || new Date();

        try {
            await pool.query(
                `INSERT INTO kanban_cards
                    (device_id, title, description, priority, status, assigned_bots, created_by, status_changed_at, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $8, $8)`,
                [row.device_id, title, desc.trim(), priority, kanbanStatus, JSON.stringify(assignedBots), createdBy, createdAt]
            );
            stats.mission_items.inserted++;
        } catch (err) {
            stats.errors.push({ source: 'mission_items', deviceId: row.device_id, itemId: row.id, error: err.message });
        }
    }
    console.log(`[Migration] Step 2 done: ${stats.mission_items.inserted} inserted, ${stats.mission_items.skipped} skipped`);

    // ────────────────────────────────────────────
    // 3. Migrate scheduled_messages
    // ────────────────────────────────────────────
    console.log('[Migration] Step 3/3: Reading scheduled_messages table …');
    const schedRows = await pool.query(
        `SELECT id, device_id, entity_id, message, scheduled_at, repeat_type, cron_expr,
                status, created_at, executed_at, result, result_status, label, timezone, is_paused
         FROM scheduled_messages`
    );

    for (const row of schedRows.rows) {
        stats.schedules.found++;
        const tag = migrationTag('schedule', row.id);

        const exists = await pool.query(
            `SELECT 1 FROM kanban_cards WHERE device_id = $1 AND description LIKE $2 LIMIT 1`,
            [row.device_id, `%${tag}%`]
        );
        if (exists.rows.length > 0) {
            stats.schedules.skipped++;
            continue;
        }

        const title = (row.label || row.message || '(scheduled task)').substring(0, 255);
        const descParts = [];
        if (row.label && row.message && row.label !== row.message) {
            descParts.push(`Message: ${row.message}`);
        }
        if (row.result) descParts.push(`Last result: ${row.result}`);
        if (row.result_status) descParts.push(`Result status: ${row.result_status}`);
        descParts.push(tag);
        const desc = descParts.filter(Boolean).join('\n');

        const kanbanStatus = scheduleStatusToKanban(row.status);
        const assignedBots = row.entity_id != null ? [Number(row.entity_id)] : [];
        const createdBy = parseInt(row.entity_id) || 0;
        const createdAt = row.created_at || new Date();

        // Schedule fields
        const isRecurring = row.repeat_type === 'cron' || row.repeat_type === 'recurring';
        const scheduleEnabled = (row.status === 'active' || row.status === 'pending') && !row.is_paused;
        const scheduleType = isRecurring ? 'recurring' : 'once';

        try {
            await pool.query(
                `INSERT INTO kanban_cards
                    (device_id, title, description, priority, status, assigned_bots, created_by,
                     status_changed_at, created_at, updated_at,
                     schedule_enabled, schedule_type, schedule_cron, schedule_run_at,
                     schedule_timezone, schedule_last_run_at)
                 VALUES ($1, $2, $3, 'P2', $4, $5::jsonb, $6,
                         $7, $7, $7,
                         $8, $9, $10, $11,
                         $12, $13)`,
                [
                    row.device_id, title, desc.trim(), kanbanStatus, JSON.stringify(assignedBots), createdBy,
                    createdAt,
                    scheduleEnabled, scheduleType, row.cron_expr || null, row.scheduled_at || null,
                    row.timezone || 'Asia/Taipei', row.executed_at || null
                ]
            );
            stats.schedules.inserted++;
        } catch (err) {
            stats.errors.push({ source: 'schedules', deviceId: row.device_id, scheduleId: row.id, error: err.message });
        }
    }
    console.log(`[Migration] Step 3 done: ${stats.schedules.inserted} inserted, ${stats.schedules.skipped} skipped`);

    return stats;
}

// ── Verification function ──
async function verifyMigration(pool) {
    const report = {};

    // 1. Count source data
    const [dashRes, itemRes, schedRes] = await Promise.all([
        pool.query(`SELECT
            SUM(jsonb_array_length(COALESCE(todo_list, '[]'::jsonb))) AS todo_count,
            SUM(jsonb_array_length(COALESCE(mission_list, '[]'::jsonb))) AS mission_count,
            SUM(jsonb_array_length(COALESCE(done_list, '[]'::jsonb))) AS done_count
            FROM mission_dashboard`),
        pool.query(`SELECT COUNT(*) AS cnt FROM mission_items`),
        pool.query(`SELECT COUNT(*) AS cnt FROM scheduled_messages`),
    ]);

    report.sources = {
        dashboard_todo:    parseInt(dashRes.rows[0].todo_count) || 0,
        dashboard_mission: parseInt(dashRes.rows[0].mission_count) || 0,
        dashboard_done:    parseInt(dashRes.rows[0].done_count) || 0,
        mission_items:     parseInt(itemRes.rows[0].cnt) || 0,
        schedules:         parseInt(schedRes.rows[0].cnt) || 0,
    };
    report.sources.total = report.sources.dashboard_todo + report.sources.dashboard_mission +
                           report.sources.dashboard_done + report.sources.mission_items +
                           report.sources.schedules;

    // 2. Count migrated kanban cards (by tag)
    const [dashMigrated, itemMigrated, schedMigrated, totalKanban] = await Promise.all([
        pool.query(`SELECT COUNT(*) AS cnt FROM kanban_cards WHERE description LIKE '%[migrated:dashboard:%'`),
        pool.query(`SELECT COUNT(*) AS cnt FROM kanban_cards WHERE description LIKE '%[migrated:item:%'`),
        pool.query(`SELECT COUNT(*) AS cnt FROM kanban_cards WHERE description LIKE '%[migrated:schedule:%'`),
        pool.query(`SELECT COUNT(*) AS cnt FROM kanban_cards WHERE description LIKE '%[migrated:%'`),
    ]);

    report.migrated = {
        from_dashboard: parseInt(dashMigrated.rows[0].cnt) || 0,
        from_items:     parseInt(itemMigrated.rows[0].cnt) || 0,
        from_schedules: parseInt(schedMigrated.rows[0].cnt) || 0,
        total:          parseInt(totalKanban.rows[0].cnt) || 0,
    };

    // 3. Breakdown by device
    const perDevice = await pool.query(`
        SELECT device_id,
               COUNT(*) FILTER (WHERE description LIKE '%[migrated:dashboard:%') AS from_dashboard,
               COUNT(*) FILTER (WHERE description LIKE '%[migrated:item:%')      AS from_items,
               COUNT(*) FILTER (WHERE description LIKE '%[migrated:schedule:%')  AS from_schedules,
               COUNT(*) AS total
        FROM kanban_cards
        WHERE description LIKE '%[migrated:%'
        GROUP BY device_id
        ORDER BY total DESC
    `);
    report.per_device = perDevice.rows;

    // 4. Detect potential duplicates (dashboard item UUID also in mission_items)
    const overlapCheck = await pool.query(`
        SELECT COUNT(*) AS cnt FROM mission_items mi
        WHERE EXISTS (
            SELECT 1 FROM kanban_cards kc
            WHERE kc.device_id = mi.device_id
              AND kc.description LIKE '%[migrated:dashboard:' || mi.id::text || ']%'
        )
    `);
    report.dashboard_item_overlap = parseInt(overlapCheck.rows[0].cnt) || 0;
    report.note = 'dashboard_item_overlap = mission_items whose UUID was already migrated from dashboard JSONB (correctly skipped, not double-counted)';

    // 5. Expected vs actual
    // Actual unique items = dashboard items + (mission_items - overlap) + schedules
    report.expected_unique = report.sources.dashboard_todo + report.sources.dashboard_mission +
                             report.sources.dashboard_done +
                             (report.sources.mission_items - report.dashboard_item_overlap) +
                             report.sources.schedules;
    report.match = report.migrated.total === report.expected_unique;

    return report;
}

module.exports = { runMigration, verifyMigration };
