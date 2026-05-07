/**
 * Idle Dispatch Integration
 * Hooks into existing kanban card workflows to enable smart dispatching
 */

const { Pool } = require('pg');
const { smartDispatch, drainBotQueue } = require('./idle_dispatch_handler');
const { emit: emitKanbanEvent } = require('./lib/kanban-events');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

/**
 * Enhanced card creation with smart dispatch
 */
async function createCardWithSmartDispatch(cardData) {
    const { deviceId, title, description, assignedBots, createdBy, priority = 'P2' } = cardData;

    try {
        // Create the card first
        const result = await pool.query(`
            INSERT INTO kanban_cards (
                device_id, title, description, assigned_bots, created_by, priority,
                status, dispatch_mode, pending_dispatch
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'backlog', 'immediate', FALSE)
            RETURNING *
        `, [deviceId, title, description, JSON.stringify(assignedBots), createdBy, priority]);

        const card = result.rows[0];

        // Apply smart dispatch logic
        if (assignedBots && assignedBots.length > 0) {
            const dispatchResult = await smartDispatch(deviceId, card.id, assignedBots);

            if (dispatchResult.dispatched) {
                // Move to todo immediately
                await pool.query(`
                    UPDATE kanban_cards
                    SET status = 'todo'
                    WHERE device_id = $1 AND id = $2
                `, [deviceId, card.id]);

                console.log(`Card ${card.id} dispatched immediately: ${dispatchResult.reason}`);
            } else {
                console.log(`Card ${card.id} queued for later: ${dispatchResult.reason}`);
            }

            return {
                ...card,
                dispatchResult
            };
        }

        return card;

    } catch (error) {
        console.error('Create card with smart dispatch error:', error);
        throw error;
    }
}

/**
 * Hook into card status changes to trigger queue draining
 */
async function onCardStatusChange(deviceId, cardId, oldStatus, newStatus, assignedBots) {
    try {
        // If a card moves to 'done', try to drain the queue for assigned bots
        if (newStatus === 'done' && assignedBots && assignedBots.length > 0) {
            console.log(`Card ${cardId} completed, checking bot queues...`);

            for (const botId of assignedBots) {
                const drainResult = await drainBotQueue(deviceId, botId);
                if (drainResult.dispatched) {
                    console.log(`Drained queue for bot ${botId}: dispatched card ${drainResult.cardId}`);

                    // Log the auto-dispatch event
                    await pool.query(`
                        INSERT INTO kanban_comments (card_id, device_id, from_entity_id, text, is_system)
                        VALUES ($1, $2, 0, $3, TRUE)
                    `, [cardId, deviceId, `🔄 觸發自動派發：Bot ${botId} 完成任務後自動派發待機卡片 ${drainResult.cardId}`]);
                }
            }
        }
    } catch (error) {
        console.error('Card status change hook error:', error);
    }
}

/**
 * Automated cron card creation with smart dispatch
 */
async function createAutoCronCard(parentCardId, deviceId, assignedBots) {
    try {
        const parentCard = await pool.query(`
            SELECT title, description FROM kanban_cards
            WHERE device_id = $1 AND id = $2
        `, [deviceId, parentCardId]);

        if (parentCard.rows.length === 0) {
            throw new Error(`Parent card ${parentCardId} not found`);
        }

        const parent = parentCard.rows[0];
        const autoTitle = `[Auto] ${parent.title} (${new Date().toLocaleString('zh-TW', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        })})`;

        const autoCard = await createCardWithSmartDispatch({
            deviceId,
            title: autoTitle,
            description: `自動產生的子卡，來自排程母卡：${parent.title}\n\n${parent.description}`,
            assignedBots: assignedBots,
            createdBy: 1, // System
            priority: 'P1' // Auto cards get higher priority
        });

        // Mark as auto-generated and link to parent
        await pool.query(`
            UPDATE kanban_cards
            SET is_auto_generated = TRUE,
                parent_card_id = $1
            WHERE device_id = $2 AND id = $3
        `, [parentCardId, deviceId, autoCard.id]);

        console.log(`Auto cron card created: ${autoCard.id} for parent ${parentCardId}`);

        // Idle-dispatch hook (PR-C). emit() is a no-op when
        // IDLE_DISPATCH_HOOKS_ENABLED !== 'true'. Synchronous, never
        // throws (wrapped internally), and runs after the spawn + parent-
        // link UPDATE so listeners only see committed cron spawns.
        emitKanbanEvent('auto_cron_card_created', {
            cardId: autoCard.id,
            parentCardId,
            deviceId,
            assignedBots,
            ts: new Date().toISOString()
        });

        return autoCard;

    } catch (error) {
        console.error('Create auto cron card error:', error);
        throw error;
    }
}

/**
 * Periodic maintenance job for idle dispatch system
 */
async function idleDispatchMaintenance(deviceId) {
    try {
        console.log('Running idle dispatch maintenance...');

        // 1. Cleanup stuck queue
        const { cleanupStuckQueue, getQueueStatus } = require('./idle_dispatch_handler');
        const cleanupResult = await cleanupStuckQueue(deviceId);
        console.log(`Cleaned up ${cleanupResult.cleanedUp} stuck cards`);

        // 2. Get queue status
        const queueStatus = await getQueueStatus(deviceId);
        console.log('Current queue status:', JSON.stringify(queueStatus, null, 2));

        // 3. Check for overloaded bots and rebalance if needed
        if (queueStatus.byBot) {
            for (const botStatus of queueStatus.byBot) {
                if (botStatus.queued_count > 5) {
                    console.log(`Bot ${botStatus.primary_bot} has ${botStatus.queued_count} queued cards - consider rebalancing`);

                    // Could implement automatic rebalancing logic here
                    // For now, just log the issue
                }
            }
        }

        // 4. Report system health
        return {
            timestamp: new Date().toISOString(),
            cleanedUp: cleanupResult.cleanedUp,
            totalQueued: queueStatus.totalQueued || 0,
            healthStatus: queueStatus.totalQueued > 20 ? 'warning' : 'healthy'
        };

    } catch (error) {
        console.error('Idle dispatch maintenance error:', error);
        return {
            timestamp: new Date().toISOString(),
            error: error.message,
            healthStatus: 'error'
        };
    }
}

/**
 * Integration with existing EClaw notification system
 */
async function notifyBotOfNewCard(botEntityId, cardId, cardTitle, deviceId) {
    try {
        // This would integrate with the EClaw A2A messaging system
        // For now, we'll add a system comment to track the notification

        await pool.query(`
            INSERT INTO kanban_comments (card_id, device_id, from_entity_id, text, is_system)
            VALUES ($1, $2, 0, $3, TRUE)
        `, [cardId, deviceId, `📧 通知 Bot ${botEntityId}：新任務已自動派發`]);

        console.log(`Notified bot ${botEntityId} of new card ${cardId}: ${cardTitle}`);

        // In a full implementation, this would call:
        // await speakToBot(botEntityId, `新任務派發：${cardTitle}`, { cardId, urgent: false });

    } catch (error) {
        console.error('Bot notification error:', error);
    }
}

module.exports = {
    createCardWithSmartDispatch,
    onCardStatusChange,
    createAutoCronCard,
    idleDispatchMaintenance,
    notifyBotOfNewCard
};