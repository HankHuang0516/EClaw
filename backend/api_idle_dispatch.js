/**
 * Idle Dispatch API
 * REST endpoints for managing smart card dispatching
 */

const express = require('express');
const router = express.Router();
const {
    smartDispatch,
    drainBotQueue,
    cleanupStuckQueue,
    getQueueStatus,
    isBotBusy
} = require('./idle_dispatch_handler');

/**
 * POST /api/mission/idle-dispatch/smart-assign
 * Intelligently dispatch a card based on bot availability
 */
router.post('/smart-assign', async (req, res) => {
    try {
        const { deviceId, entityId, botSecret, cardId, assignedBots } = req.body;

        // Validate auth (simplified for prototype)
        if (!deviceId || !entityId || !botSecret) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }

        if (!cardId || !assignedBots) {
            return res.status(400).json({ success: false, error: 'cardId and assignedBots required' });
        }

        const result = await smartDispatch(deviceId, cardId, assignedBots);

        res.json({
            success: true,
            dispatched: result.dispatched,
            reason: result.reason,
            cardId: cardId,
            assignedBots: assignedBots
        });

    } catch (err) {
        console.error('Smart assign error:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * POST /api/mission/idle-dispatch/drain-queue
 * Drain the queue for a specific bot when they become idle
 */
router.post('/drain-queue', async (req, res) => {
    try {
        const { deviceId, entityId, botSecret, botEntityId } = req.body;

        // Validate auth
        if (!deviceId || !entityId || !botSecret) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }

        if (!botEntityId) {
            return res.status(400).json({ success: false, error: 'botEntityId required' });
        }

        const result = await drainBotQueue(deviceId, botEntityId);

        res.json({
            success: true,
            dispatched: result.dispatched,
            reason: result.reason,
            cardId: result.cardId || null,
            cardTitle: result.cardTitle || null,
            botEntityId: botEntityId
        });

    } catch (err) {
        console.error('Drain queue error:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * GET /api/mission/idle-dispatch/queue-status
 * Get current queue status for monitoring
 */
router.get('/queue-status', async (req, res) => {
    try {
        const { deviceId, entityId, botSecret } = req.query;

        // Validate auth
        if (!deviceId || !entityId || !botSecret) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }

        const status = await getQueueStatus(deviceId);

        res.json({
            success: true,
            queueStatus: status
        });

    } catch (err) {
        console.error('Queue status error:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * POST /api/mission/idle-dispatch/cleanup
 * Force cleanup of stuck queued cards
 */
router.post('/cleanup', async (req, res) => {
    try {
        const { deviceId, entityId, botSecret } = req.body;

        // Validate auth
        if (!deviceId || !entityId || !botSecret) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }

        const result = await cleanupStuckQueue(deviceId);

        res.json({
            success: true,
            cleanedUp: result.cleanedUp,
            error: result.error || null
        });

    } catch (err) {
        console.error('Cleanup error:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * GET /api/mission/idle-dispatch/bot-status/:botId
 * Check if a specific bot is busy
 */
router.get('/bot-status/:botId', async (req, res) => {
    try {
        const { botId } = req.params;
        const { deviceId, entityId, botSecret } = req.query;

        // Validate auth
        if (!deviceId || !entityId || !botSecret) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }

        // Validate botId is a real integer BEFORE it reaches the SQL int cast
        // (isBotBusy does `to_jsonb($2::int)`). A non-numeric path param would
        // otherwise parseInt → NaN → Postgres "invalid input syntax for type
        // integer: \"NaN\"" (logged as "Bot status error"). Reject up front.
        const botEntityId = Number.parseInt(botId, 10);
        if (!Number.isInteger(botEntityId)) {
            return res.status(400).json({ success: false, error: 'Invalid botId — must be an integer' });
        }

        const busy = await isBotBusy(deviceId, botEntityId);

        res.json({
            success: true,
            botEntityId,
            isBusy: busy,
            status: busy ? 'busy' : 'idle'
        });

    } catch (err) {
        console.error('Bot status error:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * Webhook endpoint for card status changes
 * POST /api/mission/idle-dispatch/on-card-done
 */
router.post('/on-card-done', async (req, res) => {
    try {
        const { deviceId, entityId, botSecret, cardId, assignedBots } = req.body;

        // Validate auth
        if (!deviceId || !entityId || !botSecret) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }

        if (!cardId || !assignedBots || assignedBots.length === 0) {
            return res.status(400).json({ success: false, error: 'cardId and assignedBots required' });
        }

        // Try to drain queue for each assigned bot
        const drainResults = [];
        for (const botId of assignedBots) {
            const result = await drainBotQueue(deviceId, botId);
            drainResults.push({
                botId,
                ...result
            });
        }

        res.json({
            success: true,
            triggeredByCard: cardId,
            drainResults: drainResults
        });

    } catch (err) {
        console.error('On card done error:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;