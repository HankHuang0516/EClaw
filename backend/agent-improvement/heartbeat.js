// OODA-R Phase 1 #4 — anti-laziness heartbeat sweeper.
// Card: card_337040389de34bcb65cf0cb0
//
// Detects cards that are silently stuck:
//   - in_progress > 2h with no new comment      → post a "what's next?" prompt
//   - in_progress > 24h with no new comment     → move to blocked + system note
//
// Pure-function selectors + a single startSweeper() that wires the interval.
// The selectors are the unit-testable seam; the action layer below them is
// thin glue around the kanban pool + addSystemComment helper.

'use strict';

const PROMPT_AFTER_MS = 2 * 60 * 60 * 1000;       // 2h
const ESCALATE_AFTER_MS = 24 * 60 * 60 * 1000;    // 24h
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;          // 5min

/**
 * @typedef {Object} CardActivity
 * @property {string} cardId
 * @property {string} deviceId
 * @property {string} title
 * @property {string} status              expect 'in_progress'
 * @property {string|number|Date} statusChangedAt
 * @property {string|number|Date|null} lastNonSystemCommentAt   null if none
 * @property {string|number|Date|null} lastHeartbeatPromptAt    null if never
 * @property {string|number|Date|null} lastEscalateAt           null if never
 */

function tsOf(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (v instanceof Date) return v.getTime();
    return Date.parse(v) || 0;
}

/**
 * @param {CardActivity} card
 * @param {number} nowMs
 * @returns {'idle' | 'prompt_due' | 'escalate_due'}
 */
function classifyCard(card, nowMs) {
    if (!card || card.status !== 'in_progress') return 'idle';

    const lastActivityTs = Math.max(
        tsOf(card.statusChangedAt),
        tsOf(card.lastNonSystemCommentAt),
    );
    if (lastActivityTs === 0) return 'idle';

    const age = nowMs - lastActivityTs;
    if (age >= ESCALATE_AFTER_MS) {
        // Dedupe: don't escalate twice (most recent escalate within 12h → already handled).
        const lastEsc = tsOf(card.lastEscalateAt);
        if (lastEsc > 0 && (nowMs - lastEsc) < (12 * 60 * 60 * 1000)) return 'idle';
        return 'escalate_due';
    }
    if (age >= PROMPT_AFTER_MS) {
        // Dedupe: don't prompt twice within 2h of the previous prompt.
        const lastPrompt = tsOf(card.lastHeartbeatPromptAt);
        if (lastPrompt > 0 && (nowMs - lastPrompt) < PROMPT_AFTER_MS) return 'idle';
        return 'prompt_due';
    }
    return 'idle';
}

/**
 * Partition a list of candidate cards into the two actionable buckets.
 * @param {CardActivity[]} cards
 * @param {number} nowMs
 * @returns {{ prompt: CardActivity[], escalate: CardActivity[] }}
 */
function classifyBatch(cards, nowMs) {
    const prompt = [];
    const escalate = [];
    if (!Array.isArray(cards)) return { prompt, escalate };
    for (const c of cards) {
        const v = classifyCard(c, nowMs);
        if (v === 'prompt_due') prompt.push(c);
        else if (v === 'escalate_due') escalate.push(c);
    }
    return { prompt, escalate };
}

const PROMPT_TEXT = '⏰ OODA-R heartbeat: 此卡 in_progress >2h 沒有新進度 comment。\n→ 下一步是甚麼？(寫一行也行：blocker / 進度 / 預估時程)';
const ESCALATE_TEXT = '🚧 OODA-R escalation: 此卡 in_progress >24h 沒有新進度。已自動轉 blocked，等實際 blocker 釐清後再 move 回 in_progress。';

/**
 * Wire the sweeper. Caller provides:
 *   pool                — pg pool
 *   addSystemComment    — async (cardId, deviceId, text) => void
 *   movecard            — async (cardId, deviceId, newStatus) => void   (used for escalate)
 *   getNow              — () => number, defaults to Date.now (test override)
 * Returns the interval handle so the caller can stopSweeper().
 */
function startSweeper({ pool, addSystemComment, moveCard, getNow }, intervalMs = SWEEP_INTERVAL_MS) {
    const now = getNow || (() => Date.now());

    async function tick() {
        try {
            const r = await pool.query(`
                SELECT
                    c.id AS "cardId",
                    c.device_id AS "deviceId",
                    c.title AS "title",
                    c.status AS "status",
                    c.status_changed_at AS "statusChangedAt",
                    (SELECT MAX(created_at)
                       FROM kanban_comments
                       WHERE card_id = c.id AND is_system = false) AS "lastNonSystemCommentAt",
                    (SELECT MAX(created_at)
                       FROM kanban_comments
                       WHERE card_id = c.id AND is_system = true
                         AND text LIKE '⏰ OODA-R heartbeat%') AS "lastHeartbeatPromptAt",
                    (SELECT MAX(created_at)
                       FROM kanban_comments
                       WHERE card_id = c.id AND is_system = true
                         AND text LIKE '🚧 OODA-R escalation%') AS "lastEscalateAt"
                FROM kanban_cards c
                WHERE c.status = 'in_progress' AND c.archived = false
            `);
            const { prompt, escalate } = classifyBatch(r.rows, now());
            for (const c of prompt) {
                try { await addSystemComment(c.cardId, c.deviceId, PROMPT_TEXT); }
                catch (e) { console.error('[Heartbeat] prompt error', c.cardId, e.message); }
            }
            for (const c of escalate) {
                try {
                    await addSystemComment(c.cardId, c.deviceId, ESCALATE_TEXT);
                    if (typeof moveCard === 'function') {
                        await moveCard(c.cardId, c.deviceId, 'blocked');
                    }
                } catch (e) { console.error('[Heartbeat] escalate error', c.cardId, e.message); }
            }
        } catch (e) {
            console.error('[Heartbeat] tick error', e.message);
        }
    }

    const handle = setInterval(tick, intervalMs);
    handle.unref && handle.unref();
    // fire once immediately so a freshly booted process catches an existing stale card
    tick().catch(() => {});
    return handle;
}

function stopSweeper(handle) {
    if (handle) clearInterval(handle);
}

module.exports = {
    PROMPT_AFTER_MS,
    ESCALATE_AFTER_MS,
    SWEEP_INTERVAL_MS,
    PROMPT_TEXT,
    ESCALATE_TEXT,
    classifyCard,
    classifyBatch,
    startSweeper,
    stopSweeper,
};
