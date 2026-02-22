// ============================================
// SCHEDULER MODULE - Scheduled message delivery
// Persists schedules in PostgreSQL, executes via node-cron
// NOT related to heartbeat - this is user-initiated scheduling
// ============================================

const cron = require('node-cron');

// In-memory schedule store (synced with DB)
let schedules = {};
let activeJobs = {};  // cron job handles keyed by schedule ID
let _pool = null;
let _executeCallback = null; // callback(schedule) => Promise<result>

// ── DB Schema ──
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_messages (
    id SERIAL PRIMARY KEY,
    device_id TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    repeat_type TEXT DEFAULT 'once',
    cron_expr TEXT,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    executed_at TIMESTAMPTZ,
    result TEXT,
    result_status TEXT,
    label TEXT,
    timezone TEXT
);

CREATE INDEX IF NOT EXISTS idx_sched_device ON scheduled_messages(device_id);
CREATE INDEX IF NOT EXISTS idx_sched_status ON scheduled_messages(status);
`;

// ── Initialize ──
async function init(pool, executeCallback) {
    _pool = pool;
    _executeCallback = executeCallback;

    try {
        await pool.query(CREATE_TABLE_SQL);
        // Migration: add timezone column if missing
        await pool.query(`ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS timezone TEXT`).catch(() => {});
        console.log('[Scheduler] Table ready');
    } catch (err) {
        console.error('[Scheduler] Table creation failed:', err.message);
        return;
    }

    // Load pending schedules from DB
    await loadSchedules();
    console.log(`[Scheduler] Loaded ${Object.keys(schedules).length} schedule(s)`);

    // Start the per-minute checker for one-time schedules
    cron.schedule('* * * * *', () => {
        checkOneTimeSchedules();
    });
}

// ── Load from DB ──
async function loadSchedules() {
    if (!_pool) return;
    try {
        const { rows } = await _pool.query(
            `SELECT * FROM scheduled_messages WHERE status IN ('pending', 'active') ORDER BY scheduled_at ASC`
        );
        schedules = {};
        for (const row of rows) {
            schedules[row.id] = rowToSchedule(row);
            // Re-arm recurring jobs
            if (row.repeat_type !== 'once' && row.cron_expr && row.status === 'active') {
                armCronJob(schedules[row.id]);
            }
        }
    } catch (err) {
        console.error('[Scheduler] Load failed:', err.message);
    }
}

function rowToSchedule(row) {
    return {
        id: row.id,
        deviceId: row.device_id,
        entityId: row.entity_id,
        message: row.message,
        scheduledAt: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
        repeatType: row.repeat_type || 'once',
        cronExpr: row.cron_expr || null,
        status: row.status,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        executedAt: row.executed_at ? new Date(row.executed_at).toISOString() : null,
        result: row.result || null,
        resultStatus: row.result_status || null,
        label: row.label || null,
        timezone: row.timezone || null
    };
}

// ── Create Schedule ──
async function createSchedule({ deviceId, entityId, message, scheduledAt, repeatType = 'once', cronExpr = null, label = null, timezone = null }) {
    if (!_pool) throw new Error('Scheduler not initialized');

    // Validate
    if (!deviceId || entityId === undefined || !message) {
        throw new Error('deviceId, entityId, and message are required');
    }

    const parsedEntityId = parseInt(entityId);
    if (isNaN(parsedEntityId) || parsedEntityId < 0 || parsedEntityId > 3) {
        throw new Error('entityId must be 0-3');
    }

    // For one-time schedules, require scheduledAt in the future
    if (repeatType === 'once') {
        if (!scheduledAt) throw new Error('scheduledAt is required for one-time schedules');
        const scheduledTime = new Date(scheduledAt);
        if (isNaN(scheduledTime.getTime())) throw new Error('Invalid scheduledAt date');
        if (scheduledTime.getTime() < Date.now() - 60000) throw new Error('scheduledAt must be in the future');
    }

    // For recurring schedules, validate cron expression
    if (repeatType !== 'once') {
        if (!cronExpr) throw new Error('cronExpr is required for recurring schedules');
        if (!cron.validate(cronExpr)) throw new Error('Invalid cron expression');
    }

    const status = repeatType === 'once' ? 'pending' : 'active';

    const { rows } = await _pool.query(
        `INSERT INTO scheduled_messages (device_id, entity_id, message, scheduled_at, repeat_type, cron_expr, status, label, timezone)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [deviceId, parsedEntityId, message, scheduledAt || null, repeatType, cronExpr, status, label, timezone]
    );

    const schedule = rowToSchedule(rows[0]);
    schedules[schedule.id] = schedule;

    // Arm cron job for recurring schedules
    if (repeatType !== 'once' && cronExpr) {
        armCronJob(schedule);
    }

    console.log(`[Scheduler] Created schedule #${schedule.id}: ${repeatType} for device ${deviceId} entity ${parsedEntityId}`);
    return schedule;
}

// ── Update Schedule ──
async function updateSchedule(id, updates) {
    if (!_pool) throw new Error('Scheduler not initialized');

    const schedule = schedules[id];
    if (!schedule) throw new Error('Schedule not found');

    const allowedFields = ['message', 'scheduledAt', 'repeatType', 'cronExpr', 'status', 'entityId', 'label'];
    const setClauses = [];
    const values = [];
    let paramIdx = 1;

    for (const key of allowedFields) {
        if (updates[key] !== undefined) {
            const dbKey = key === 'scheduledAt' ? 'scheduled_at'
                : key === 'repeatType' ? 'repeat_type'
                : key === 'cronExpr' ? 'cron_expr'
                : key === 'entityId' ? 'entity_id'
                : key === 'resultStatus' ? 'result_status'
                : key;
            setClauses.push(`${dbKey} = $${paramIdx}`);
            values.push(updates[key]);
            paramIdx++;
        }
    }

    if (setClauses.length === 0) return schedule;

    values.push(id);
    const { rows } = await _pool.query(
        `UPDATE scheduled_messages SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
        values
    );

    if (rows.length === 0) throw new Error('Schedule not found');

    const updated = rowToSchedule(rows[0]);
    schedules[updated.id] = updated;

    // Re-arm cron job if needed
    disarmCronJob(id);
    if (updated.repeatType !== 'once' && updated.cronExpr && updated.status === 'active') {
        armCronJob(updated);
    }

    return updated;
}

// ── Delete Schedule ──
async function deleteSchedule(id, deviceId) {
    if (!_pool) throw new Error('Scheduler not initialized');

    // Verify ownership
    const schedule = schedules[id];
    if (!schedule) throw new Error('Schedule not found');
    if (deviceId && schedule.deviceId !== deviceId) throw new Error('Not authorized');

    disarmCronJob(id);
    delete schedules[id];

    await _pool.query(`DELETE FROM scheduled_messages WHERE id = $1`, [id]);
    console.log(`[Scheduler] Deleted schedule #${id}`);
    return true;
}

// ── Get Schedules for a device ──
async function getSchedules(deviceId, { status, limit = 50, offset = 0 } = {}) {
    if (!_pool) return [];

    let query = `SELECT * FROM scheduled_messages WHERE device_id = $1`;
    const params = [deviceId];

    if (status) {
        query += ` AND status = $2`;
        params.push(status);
    }

    query += ` ORDER BY CASE WHEN status = 'pending' THEN 0 WHEN status = 'active' THEN 1 ELSE 2 END, scheduled_at ASC NULLS LAST`;
    query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const { rows } = await _pool.query(query, params);
    return rows.map(rowToSchedule);
}

// ── Get single schedule ──
async function getSchedule(id) {
    if (!_pool) return null;
    const { rows } = await _pool.query(`SELECT * FROM scheduled_messages WHERE id = $1`, [id]);
    return rows.length > 0 ? rowToSchedule(rows[0]) : null;
}

// ── Check one-time schedules (runs every minute) ──
async function checkOneTimeSchedules() {
    const now = Date.now();

    for (const [id, schedule] of Object.entries(schedules)) {
        if (schedule.status !== 'pending' || schedule.repeatType !== 'once') continue;
        if (!schedule.scheduledAt) continue;

        const scheduledTime = new Date(schedule.scheduledAt).getTime();
        if (scheduledTime <= now) {
            console.log(`[Scheduler] Executing one-time schedule #${id}`);
            await executeSchedule(schedule);
        }
    }
}

// ── Arm a cron job for recurring schedules ──
function armCronJob(schedule) {
    if (activeJobs[schedule.id]) return; // already armed

    try {
        const cronOptions = {};
        if (schedule.timezone) cronOptions.timezone = schedule.timezone;
        const job = cron.schedule(schedule.cronExpr, async () => {
            console.log(`[Scheduler] Executing recurring schedule #${schedule.id}`);
            await executeSchedule(schedule, true);
        }, cronOptions);
        activeJobs[schedule.id] = job;
    } catch (err) {
        console.error(`[Scheduler] Failed to arm cron job for #${schedule.id}:`, err.message);
    }
}

// ── Disarm a cron job ──
function disarmCronJob(id) {
    if (activeJobs[id]) {
        activeJobs[id].stop();
        delete activeJobs[id];
    }
}

// ── Execute a schedule ──
async function executeSchedule(schedule, isRecurring = false) {
    try {
        let result = null;
        if (_executeCallback) {
            result = await _executeCallback(schedule);
        }

        const resultText = result ? (typeof result === 'string' ? result : JSON.stringify(result)) : 'executed';
        const resultStatus = (result && result.error) ? 'error' : 'success';

        if (isRecurring) {
            // For recurring, just record execution but keep active
            await _pool.query(
                `UPDATE scheduled_messages SET executed_at = NOW(), result = $1, result_status = $2 WHERE id = $3`,
                [resultText.substring(0, 2000), resultStatus, schedule.id]
            );
            schedule.executedAt = new Date().toISOString();
            schedule.result = resultText.substring(0, 2000);
            schedule.resultStatus = resultStatus;
        } else {
            // For one-time, mark as completed
            await _pool.query(
                `UPDATE scheduled_messages SET status = 'completed', executed_at = NOW(), result = $1, result_status = $2 WHERE id = $3`,
                [resultText.substring(0, 2000), resultStatus, schedule.id]
            );
            schedule.status = 'completed';
            schedule.executedAt = new Date().toISOString();
            schedule.result = resultText.substring(0, 2000);
            schedule.resultStatus = resultStatus;
            // Remove from active tracking (but keep in DB for history)
            delete schedules[schedule.id];
        }

        console.log(`[Scheduler] Schedule #${schedule.id} executed: ${resultStatus}`);
    } catch (err) {
        console.error(`[Scheduler] Execution failed for #${schedule.id}:`, err.message);

        try {
            await _pool.query(
                `UPDATE scheduled_messages SET executed_at = NOW(), result = $1, result_status = 'error' WHERE id = $2`,
                [err.message.substring(0, 2000), schedule.id]
            );
            schedule.result = err.message.substring(0, 2000);
            schedule.resultStatus = 'error';
            if (!isRecurring) {
                await _pool.query(`UPDATE scheduled_messages SET status = 'failed' WHERE id = $1`, [schedule.id]);
                schedule.status = 'failed';
                delete schedules[schedule.id];
            }
        } catch (_) { }
    }
}

// ── Bot API: list schedules for a device (read-only for bots) ──
async function getSchedulesForBot(deviceId, entityId) {
    if (!_pool) return [];
    let query = `SELECT * FROM scheduled_messages WHERE device_id = $1`;
    const params = [deviceId];
    if (entityId !== undefined) {
        query += ` AND entity_id = $2`;
        params.push(parseInt(entityId));
    }
    query += ` ORDER BY scheduled_at ASC NULLS LAST LIMIT 100`;
    const { rows } = await _pool.query(query, params);
    return rows.map(rowToSchedule);
}

module.exports = {
    init,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    getSchedules,
    getSchedule,
    getSchedulesForBot
};
