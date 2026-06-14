/**
 * MessageLifecycle public API — Phase 2 Step 2 surface.
 *
 * Card: card_545ce5986b9c1332315ba303.
 * Spec: docs/specs/message-lifecycle-spec.md §4.
 *
 * Step 2 ships the wheel + sweeper + cold-start primitives. Wiring them
 * into the boot path of `backend/index.js` is Step 3's job (dual-write).
 * This index file is here so Step 3 can `require('./lib/message-lifecycle')`
 * and pick what it needs without reaching into individual files.
 */

const { createWheel, createInMemoryClient, deadlinesKey, DEFAULT_KEY_PREFIX } = require('./deadline-wheel');
const { createSweeper, DEFAULT_INTERVAL_MS } = require('./sweeper');
const { runColdStart, DEFAULT_STATE_TIMEOUTS_MS, COLD_START_PAGE_SIZE } = require('./cold-start');

module.exports = {
    createWheel,
    createInMemoryClient,
    createSweeper,
    runColdStart,
    deadlinesKey,
    DEFAULT_KEY_PREFIX,
    DEFAULT_INTERVAL_MS,
    DEFAULT_STATE_TIMEOUTS_MS,
    COLD_START_PAGE_SIZE,
};
