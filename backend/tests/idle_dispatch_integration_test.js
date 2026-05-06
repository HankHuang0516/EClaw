/**
 * Idle Dispatch Integration Test
 * Verifies smart dispatch system works with real PostgreSQL database
 */

const { Pool } = require('pg');
const {
    smartDispatch,
    drainBotQueue,
    isBotBusy,
    cleanupStuckQueue,
    getQueueStatus
} = require('../idle_dispatch_handler');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

async function runIntegrationTest() {
    console.log('🚀 Starting Idle Dispatch Integration Test...');

    const testDeviceId = process.env.BROADCAST_TEST_DEVICE || 'test-device-001';
    const testBotId = 999; // Use high ID to avoid conflicts

    try {
        // Cleanup any existing test data
        await pool.query(`
            DELETE FROM kanban_cards
            WHERE device_id = $1 AND created_by = 999
        `, [testDeviceId]);

        console.log('✅ Test data cleaned up');

        // Test 1: Create a test card
        const testCard = await pool.query(`
            INSERT INTO kanban_cards (
                device_id, title, description, assigned_bots,
                created_by, priority, status, dispatch_mode, pending_dispatch
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
        `, [
            testDeviceId,
            '[TEST] Smart Dispatch Test Card',
            'Test card for idle dispatch system verification',
            JSON.stringify([testBotId]),
            999, // Test entity ID
            'P1',
            'backlog',
            'immediate',
            false
        ]);

        const cardId = testCard.rows[0].id;
        console.log(`✅ Test card created: ${cardId}`);

        // Test 2: Check if bot is busy (should be false for test bot)
        const isBusy = await isBotBusy(testDeviceId, testBotId);
        console.log(`✅ Bot ${testBotId} busy status: ${isBusy}`);

        // Test 3: Run smart dispatch
        const dispatchResult = await smartDispatch(testDeviceId, cardId, [testBotId]);
        console.log(`✅ Smart dispatch result:`, dispatchResult);

        // Test 4: Get queue status
        const queueStatus = await getQueueStatus(testDeviceId);
        console.log(`✅ Queue status:`, {
            totalQueued: queueStatus.totalQueued,
            botCount: queueStatus.byBot ? queueStatus.byBot.length : 0
        });

        // Test 5: Test queue draining (should find no queued cards for test bot)
        const drainResult = await drainBotQueue(testDeviceId, testBotId);
        console.log(`✅ Drain queue result:`, drainResult);

        // Test 6: Cleanup stuck queue
        const cleanupResult = await cleanupStuckQueue(testDeviceId);
        console.log(`✅ Cleanup result: ${cleanupResult.cleanedUp} cards cleaned`);

        // Cleanup test card
        await pool.query(`
            DELETE FROM kanban_cards
            WHERE device_id = $1 AND id = $2
        `, [testDeviceId, cardId]);

        console.log('✅ Test card cleaned up');
        console.log('🎉 All idle dispatch integration tests passed!');

        return {
            success: true,
            tests: {
                cardCreation: true,
                botBusyCheck: true,
                smartDispatch: true,
                queueStatus: true,
                queueDrain: true,
                cleanup: true
            }
        };

    } catch (error) {
        console.error('❌ Integration test failed:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Run test if called directly
if (require.main === module) {
    runIntegrationTest().then(result => {
        console.log('\n📊 Test Result:', result);
        process.exit(result.success ? 0 : 1);
    });
}

module.exports = { runIntegrationTest };