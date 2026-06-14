/**
 * MessageLifecycle sweeper loop (spec §4.3).
 *
 * Card: card_545ce5986b9c1332315ba303 (Phase 2 Step 2 — sweeper).
 * Spec: docs/specs/message-lifecycle-spec.md §4.3.
 *
 * The sweeper polls the deadline wheel every N ms (default 5000 — env
 * LIFECYCLE_SWEEP_INTERVAL_MS) and hands every popped message_id to a
 * caller-supplied handler. The handler decides whether to emit a stuck
 * alert, advance the lifecycle row, or requeue.
 *
 * This module is intentionally thin: it owns the timer + concurrency
 * discipline + cancellation, but NOT the policy decision (alert? requeue?
 * advance?). Policy lives in Step 3 (dual-write) and Step 6 (divergence
 * detector). Decoupling them lets Step 2 ship a verifiable loop without
 * the SLO formula choices.
 *
 * Concurrency: at most one onDue invocation per tick. If onDue is slow, the
 * next tick is delayed until the previous one completes. This is the spec
 * §4.3 contract — "at-least-once duplication is absorbed by alert dedup".
 */

const DEFAULT_INTERVAL_MS = 5000;

function parseInterval(envValue) {
    const n = Number(envValue);
    if (Number.isFinite(n) && n >= 100) return Math.floor(n);
    return DEFAULT_INTERVAL_MS;
}

/**
 * Create a sweeper.
 *
 * @param {object} options
 * @param {object} options.wheel  A deadline-wheel created via createWheel().
 * @param {(id:string)=>Promise<void>} options.onDue
 *   Handler invoked with each due message_id. Errors are swallowed and
 *   logged so one bad row never wedges the loop.
 * @param {number} [options.intervalMs] Tick interval. Defaults to
 *   process.env.LIFECYCLE_SWEEP_INTERVAL_MS or 5000.
 * @param {number} [options.maxBatch=500] Per-tick popDue cap.
 * @param {()=>number} [options.now] Injected clock — used by tests to make
 *   "due" deterministic. Production passes Date.now.
 * @param {(msg:string,err?:Error)=>void} [options.logError] Error logger.
 */
function createSweeper(options) {
    if (!options || typeof options.onDue !== 'function') {
        throw new TypeError('createSweeper: onDue handler is required');
    }
    if (!options.wheel || typeof options.wheel.popDue !== 'function') {
        throw new TypeError('createSweeper: wheel with popDue is required');
    }

    const {
        wheel,
        onDue,
        intervalMs = parseInterval(process.env.LIFECYCLE_SWEEP_INTERVAL_MS),
        maxBatch = 500,
        now = Date.now,
        logError = (msg, err) => console.error(msg, err),
    } = options;

    let timer = null;
    let running = false;
    let stopped = false;
    let tickInFlight = null;

    async function tick() {
        if (stopped) return;
        try {
            const dueIds = await wheel.popDue(now(), maxBatch);
            for (const id of dueIds) {
                if (stopped) break;
                try {
                    await onDue(id);
                } catch (err) {
                    logError(`[lifecycle-sweeper] onDue handler failed for ${id}`, err);
                }
            }
        } catch (err) {
            logError('[lifecycle-sweeper] popDue failed', err);
        }
    }

    function scheduleNext() {
        if (stopped) return;
        timer = setTimeout(async () => {
            tickInFlight = tick();
            await tickInFlight;
            tickInFlight = null;
            scheduleNext();
        }, intervalMs);
        if (typeof timer.unref === 'function') timer.unref();
    }

    return {
        start() {
            if (running || stopped) return;
            running = true;
            scheduleNext();
        },
        async stop() {
            stopped = true;
            running = false;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (tickInFlight) {
                try { await tickInFlight; } catch { /* swallow */ }
            }
        },
        /**
         * Force a single tick synchronously (used by tests to avoid timer
         * flakiness). Not for production.
         */
        async _tickOnce() {
            await tick();
        },
        get intervalMs() { return intervalMs; },
        get isRunning() { return running && !stopped; },
    };
}

module.exports = {
    createSweeper,
    DEFAULT_INTERVAL_MS,
};
