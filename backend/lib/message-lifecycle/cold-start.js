/**
 * MessageLifecycle cold-start scan (spec §4.4 + §9.9).
 *
 * Card: card_545ce5986b9c1332315ba303 (Phase 2 Step 2 — cold-start).
 * Spec: docs/specs/message-lifecycle-spec.md §4.4 Redis-lost failure mode,
 *       §9.9 acceptance scenario.
 *
 * On boot (or whenever Redis is detected empty), scan message_lifecycle for
 * every row whose state is NOT 'user_seen' and whose pivot timestamp is
 * within timeout reach, then ZADD each one back into the deadline wheel.
 *
 * Pagination: the scan is keyset-paginated by (inbound_seen_at, message_id)
 * with LIMIT pageSize per query. This is required for the globe-user
 * generalization called out in card_545c: very large devices may accumulate
 * >10k stale lifecycle rows, and a single unbounded scan would block the
 * event loop and the PG pool.
 *
 * Per spec §4 preamble: Redis is cache, DB is source of truth — so this
 * function NEVER mutates message_lifecycle. It only reads.
 */

/**
 * Per-state timeout cap (ms). Used by the cold-start scan to compute each
 * row's deadline = state_changed_at + timeout_for(state).
 *
 * Values match spec §2.2 defaults; the dual-write Step 3 will make these
 * per-entity-class configurable. For Step 2 we use the conservative ceiling
 * (paid bot timeout) so the wheel never under-schedules — a row that is
 * actually under a smaller per-entity cap will simply fire its alert sooner
 * via Step 3's transition() path that schedules with the entity-specific
 * deadline.
 */
const DEFAULT_STATE_TIMEOUTS_MS = {
    inbound_seen: 180_000,   // 180s — paid bot ceiling per spec §2.2
    bot_acked: 60_000,       // 60s — channel ceiling
    push_delivered: 86_400_000, // 24h — best-effort engagement window
};

const COLD_START_PAGE_SIZE = 1000;
// Backstop so a malformed page-cursor or unbounded growth can never block
// boot indefinitely. 1M rows × 1000 pageSize = 1000 pages — well above any
// realistic load and small enough to abort cleanly.
const MAX_PAGES = 1000;

/**
 * Run the cold-start scan and repopulate the wheel.
 *
 * @param {object} options
 * @param {object} options.wheel   Deadline wheel (createWheel result).
 * @param {object} options.pool    pg.Pool — provides .query().
 * @param {object} [options.stateTimeouts] Override per-state timeout caps.
 * @param {number} [options.pageSize=1000] Rows per scan query.
 * @param {number} [options.maxPages=1000] Backstop on total pages scanned.
 * @param {()=>number} [options.now] Injected clock.
 * @param {(msg:string,...args:any[])=>void} [options.log] Log sink.
 * @returns {Promise<{scanned:number, scheduled:number, pages:number}>}
 */
async function runColdStart(options) {
    if (!options || !options.wheel || !options.pool) {
        throw new TypeError('runColdStart: { wheel, pool } are required');
    }
    const {
        wheel,
        pool,
        stateTimeouts = DEFAULT_STATE_TIMEOUTS_MS,
        pageSize = COLD_START_PAGE_SIZE,
        maxPages = MAX_PAGES,
        now = Date.now,
        log = (...args) => console.log(...args),
    } = options;

    if (!wheel.enabled) {
        log('[lifecycle-cold-start] wheel disabled (no Redis) — skipping cold-start scan');
        return { scanned: 0, scheduled: 0, pages: 0 };
    }

    const startNow = now();
    let scanned = 0;
    let scheduled = 0;
    let pages = 0;

    // Keyset cursor: (last_seen_at, last_message_id). Sorting by
    // inbound_seen_at + message_id gives a deterministic total order that
    // does not require an offset (which would degrade as the table grows).
    let cursorTs = null;
    let cursorId = null;

    while (pages < maxPages) {
        const params = [pageSize];
        let where = `state IN ('inbound_seen', 'bot_acked', 'push_delivered')`;
        if (cursorTs !== null) {
            params.push(cursorTs, cursorId);
            where += ` AND (inbound_seen_at, message_id) > ($2, $3)`;
        }
        const sql = `
            SELECT message_id,
                   state,
                   inbound_seen_at,
                   bot_acked_at,
                   push_delivered_at
              FROM message_lifecycle
             WHERE ${where}
             ORDER BY inbound_seen_at ASC, message_id ASC
             LIMIT $1
        `;
        let rows;
        try {
            const result = await pool.query(sql, params);
            rows = result.rows || [];
        } catch (err) {
            log('[lifecycle-cold-start] page query failed', err);
            return { scanned, scheduled, pages, error: err.message };
        }
        if (rows.length === 0) break;
        pages++;
        for (const row of rows) {
            scanned++;
            const pivot = pivotForState(row);
            if (pivot === null) {
                // Should not happen: NOT NULL on inbound_seen_at and the
                // per-state column is set whenever that state is reached.
                // Log + skip.
                log(`[lifecycle-cold-start] row ${row.message_id} missing pivot for state=${row.state} — skipped`);
                continue;
            }
            const timeoutMs = stateTimeouts[row.state] ?? DEFAULT_STATE_TIMEOUTS_MS[row.state] ?? 0;
            const deadlineMs = pivot.getTime() + timeoutMs;
            // Re-arm even if already past due — the sweeper's first post-restart
            // tick will fire the alert. This is the explicit §9.9 contract:
            // "any alerts that would have fired during the outage emit on the
            // first post-cold-start sweep cycle."
            try {
                await wheel.schedule(row.message_id, deadlineMs);
                scheduled++;
            } catch (err) {
                log(`[lifecycle-cold-start] wheel.schedule failed for ${row.message_id}`, err);
            }
        }
        const last = rows[rows.length - 1];
        cursorTs = last.inbound_seen_at;
        cursorId = last.message_id;
        if (rows.length < pageSize) break;
    }

    const elapsedMs = now() - startNow;
    log(`[lifecycle-cold-start] repopulated wheel: scanned=${scanned} scheduled=${scheduled} pages=${pages} elapsedMs=${elapsedMs}`);
    return { scanned, scheduled, pages };
}

function pivotForState(row) {
    switch (row.state) {
        case 'inbound_seen':
            return row.inbound_seen_at instanceof Date ? row.inbound_seen_at : null;
        case 'bot_acked':
            return row.bot_acked_at instanceof Date ? row.bot_acked_at : null;
        case 'push_delivered':
            return row.push_delivered_at instanceof Date ? row.push_delivered_at : null;
        default:
            return null;
    }
}

module.exports = {
    runColdStart,
    DEFAULT_STATE_TIMEOUTS_MS,
    COLD_START_PAGE_SIZE,
    // Exported for tests.
    _pivotForState: pivotForState,
};
