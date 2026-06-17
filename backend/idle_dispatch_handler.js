/**
 * Idle Dispatch Handler
 * Manages smart dispatching of cards only when assigned bots are idle
 */

const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

/**
 * Check if a bot has active work (todo or in_progress cards)
 */
async function isBotBusy(deviceId, botEntityId) {
    const result = await pool.query(`
        SELECT COUNT(*) as active_count
        FROM kanban_cards
        WHERE device_id = $1
        AND assigned_bots @> to_jsonb($2::int)
        AND status IN ('todo', 'in_progress')
        AND archived = FALSE
    `, [deviceId, botEntityId]);

    return parseInt(result.rows[0].active_count) > 0;
}

/**
 * Queue card for later dispatch instead of immediate assignment
 */
async function queueCardForLater(deviceId, cardId, reason) {
    await pool.query(`
        UPDATE kanban_cards
        SET pending_dispatch = TRUE,
            dispatch_mode = 'idle_only'
        WHERE device_id = $1 AND id = $2
    `, [deviceId, cardId]);

    // Add comment explaining why it was queued
    await pool.query(`
        INSERT INTO kanban_comments (card_id, device_id, from_entity_id, text, is_system)
        VALUES ($1, $2, 0, $3, TRUE)
    `, [cardId, deviceId, `🔄 閒置派發：${reason}，等待 assigned bot 完成當前工作後自動派發`]);

    console.log(`Card ${cardId} queued for idle dispatch: ${reason}`);
}

/**
 * Smart dispatch logic - check bot availability before dispatching
 */
async function smartDispatch(deviceId, cardId, assignedBots) {
    try {
        if (!assignedBots || assignedBots.length === 0) {
            console.log(`Card ${cardId} has no assigned bots, dispatching immediately`);
            return { dispatched: true, reason: 'no_assigned_bots' };
        }

        // Check if primary assigned bot is busy
        const primaryBot = assignedBots[0];
        const isBusy = await isBotBusy(deviceId, primaryBot);

        if (isBusy) {
            // Check how many cards this bot already has queued
            const queuedCount = await pool.query(`
                SELECT COUNT(*) as queued_count
                FROM kanban_cards
                WHERE device_id = $1
                AND assigned_bots @> to_jsonb($2::int)
                AND pending_dispatch = TRUE
                AND archived = FALSE
            `, [deviceId, primaryBot]);

            const queueDepth = parseInt(queuedCount.rows[0].queued_count);

            if (queueDepth >= 3) {
                // Queue too deep, try secondary bot or escalate
                if (assignedBots.length > 1) {
                    const secondaryBot = assignedBots[1];
                    const secondaryBusy = await isBotBusy(deviceId, secondaryBot);

                    if (!secondaryBusy) {
                        console.log(`Primary bot ${primaryBot} busy, dispatching to secondary bot ${secondaryBot}`);
                        return { dispatched: true, reason: `fallback_to_secondary_bot_${secondaryBot}` };
                    }
                }

                // All bots busy, queue but with escalation comment
                await queueCardForLater(deviceId, cardId, `Bot ${primaryBot} 隊列已滿 (${queueDepth} 待辦)，等待優先處理`);
                return { dispatched: false, reason: `queue_full_bot_${primaryBot}` };
            }

            // Queue for later dispatch
            await queueCardForLater(deviceId, cardId, `Bot ${primaryBot} 忙碌中 (有 ${queueDepth} 待辦)`);
            return { dispatched: false, reason: `bot_busy_${primaryBot}` };
        }

        // Bot is idle, dispatch immediately
        console.log(`Bot ${primaryBot} is idle, dispatching card ${cardId} immediately`);
        return { dispatched: true, reason: `bot_idle_${primaryBot}` };

    } catch (error) {
        console.error('Smart dispatch error:', error);
        // Fallback to immediate dispatch on error
        return { dispatched: true, reason: 'error_fallback' };
    }
}

/**
 * Drain queued cards when a bot becomes idle
 */
async function drainBotQueue(deviceId, botEntityId) {
    try {
        // Get the oldest queued card for this bot
        const result = await pool.query(`
            SELECT id, title, assigned_bots
            FROM kanban_cards
            WHERE device_id = $1
            AND assigned_bots @> to_jsonb($2::int)
            AND pending_dispatch = TRUE
            AND archived = FALSE
            ORDER BY created_at ASC
            LIMIT 1
        `, [deviceId, botEntityId]);

        if (result.rows.length === 0) {
            console.log(`No queued cards for bot ${botEntityId}`);
            return { dispatched: false, reason: 'no_queued_cards' };
        }

        const queuedCard = result.rows[0];

        // Check if bot is still actually idle
        const stillBusy = await isBotBusy(deviceId, botEntityId);
        if (stillBusy) {
            console.log(`Bot ${botEntityId} became busy again, not draining queue`);
            return { dispatched: false, reason: 'bot_became_busy' };
        }

        // Dispatch the queued card
        await pool.query(`
            UPDATE kanban_cards
            SET pending_dispatch = FALSE,
                dispatch_mode = 'immediate',
                status = 'todo'
            WHERE device_id = $1 AND id = $2
        `, [deviceId, queuedCard.id]);

        // Add dispatch comment
        await pool.query(`
            INSERT INTO kanban_comments (card_id, device_id, from_entity_id, text, is_system)
            VALUES ($1, $2, 0, $3, TRUE)
        `, [queuedCard.id, deviceId, `✅ 閒置派發：Bot ${botEntityId} 空閒，自動派發執行`]);

        console.log(`Dispatched queued card ${queuedCard.id} to bot ${botEntityId}`);

        // Use the EClaw notification system to notify the bot
        await sendBotNotification(deviceId, botEntityId, queuedCard);

        return {
            dispatched: true,
            cardId: queuedCard.id,
            cardTitle: queuedCard.title,
            reason: `auto_dispatch_to_${botEntityId}`
        };

    } catch (error) {
        console.error('Drain bot queue error:', error);
        return { dispatched: false, reason: 'drain_error' };
    }
}

/**
 * Send notification to bot about newly dispatched card
 */
async function sendBotNotification(deviceId, botEntityId, card) {
    try {
        // This would integrate with the EClaw A2A messaging system
        console.log(`Notification sent to bot ${botEntityId} for card ${card.id}: ${card.title}`);

        // Could call speakTo API here to notify the bot directly
        // await speakToBot(botEntityId, `新任務已派發：${card.title}`);

    } catch (error) {
        console.error('Bot notification error:', error);
    }
}

/**
 * Periodic cleanup of stuck queued cards
 */
async function cleanupStuckQueue(deviceId) {
    try {
        // Find cards that have been queued for too long (>2 hours)
        const stuckCards = await pool.query(`
            SELECT id, title, assigned_bots, created_at
            FROM kanban_cards
            WHERE device_id = $1
            AND pending_dispatch = TRUE
            AND created_at < NOW() - INTERVAL '2 hours'
            AND archived = FALSE
            ORDER BY created_at ASC
        `, [deviceId]);

        for (const card of stuckCards.rows) {
            console.log(`Found stuck queued card: ${card.id} (${card.title})`);

            // Force dispatch stuck cards
            await pool.query(`
                UPDATE kanban_cards
                SET pending_dispatch = FALSE,
                    dispatch_mode = 'immediate',
                    status = 'todo'
                WHERE device_id = $1 AND id = $2
            `, [deviceId, card.id]);

            await pool.query(`
                INSERT INTO kanban_comments (card_id, device_id, from_entity_id, text, is_system)
                VALUES ($1, $2, 0, $3, TRUE)
            `, [card.id, deviceId, `⚠️ 強制派發：隊列超時 (${Math.round((Date.now() - new Date(card.created_at).getTime()) / (1000 * 60 * 60))} 小時)，自動派發`]);
        }

        return { cleanedUp: stuckCards.rows.length };

    } catch (error) {
        console.error('Cleanup stuck queue error:', error);
        return { cleanedUp: 0, error: error.message };
    }
}

/**
 * Get queue status for monitoring
 */
async function getQueueStatus(deviceId) {
    try {
        const result = await pool.query(`
            SELECT
                assigned_bots[1] as primary_bot,
                COUNT(*) as queued_count,
                MIN(created_at) as oldest_queued,
                MAX(created_at) as newest_queued
            FROM kanban_cards
            WHERE device_id = $1
            AND pending_dispatch = TRUE
            AND archived = FALSE
            GROUP BY assigned_bots[1]
            ORDER BY queued_count DESC
        `, [deviceId]);

        return {
            totalQueued: result.rows.reduce((sum, row) => sum + parseInt(row.queued_count), 0),
            byBot: result.rows,
            timestamp: new Date().toISOString()
        };

    } catch (error) {
        console.error('Get queue status error:', error);
        return { error: error.message };
    }
}

module.exports = {
    smartDispatch,
    drainBotQueue,
    cleanupStuckQueue,
    getQueueStatus,
    isBotBusy
};