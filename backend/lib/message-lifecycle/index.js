/**
 * MessageLifecycle public API — Phase 2 Step 2 surface.
 *
 * Card: card_545ce5986b9c1332315ba303.
 * Spec: docs/specs/message-lifecycle-spec.md §4.
 *
 * Step 2 shipped the wheel + sweeper + cold-start primitives.
 * Step 3 (this card, card_1b1c1322) adds the transition engine + DB store +
 * backfill resolver + divergence detector. Callers `require('./lib/message-lifecycle')`
 * and pick what they need without reaching into individual files.
 */

const { createWheel, createInMemoryClient, deadlinesKey, DEFAULT_KEY_PREFIX } = require('./deadline-wheel');
const { createSweeper, DEFAULT_INTERVAL_MS } = require('./sweeper');
const { runColdStart, DEFAULT_STATE_TIMEOUTS_MS, COLD_START_PAGE_SIZE } = require('./cold-start');
const engine = require('./engine');
const store = require('./store');

module.exports = {
    // Step 2 — Redis deadline wheel
    createWheel,
    createInMemoryClient,
    createSweeper,
    runColdStart,
    deadlinesKey,
    DEFAULT_KEY_PREFIX,
    DEFAULT_INTERVAL_MS,
    DEFAULT_STATE_TIMEOUTS_MS,
    COLD_START_PAGE_SIZE,

    // Step 3 — transition engine (pure) + DB store + backfill + divergence
    engine,
    STATES: engine.STATES,
    APPLIED: engine.APPLIED,
    decideTransition: engine.decideTransition,
    store,
    // store convenience re-exports (the common dual-write surface)
    initTable: store.initTable,
    setPool: store.setPool,
    setWheel: store.setWheel,
    transition: store.transition,
    backfillLifecycle: store.backfillLifecycle,
    recordDivergence: store.recordDivergence,
    divergenceSummary: store.divergenceSummary,
    getLifecycle: store.getLifecycle,
    getEventLog: store.getEventLog,
};
