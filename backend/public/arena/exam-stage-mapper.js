/**
 * exam-stage-mapper.js — pure function that maps an arena exam socket
 * event to a companion-avatar emotion state. Extracted so it can be
 * unit-tested without booting Socket.IO or the DOM.
 *
 * Globe-user: the mapping is content-agnostic — works for any entity's
 * petdx companion (or the neutral SVG fallback) for any deviceId in
 * any region. No locale-specific or device-specific branches.
 *
 * Emotion states (5):
 *   ready      — exam loaded, waiting for the bot to fetch first test
 *   focused    — bot is actively running a test
 *   celebrate  — last completed test passed (score > 0)
 *   concerned  — last completed test failed (score == 0)
 *   proud      — whole exam finished; final 'done' state
 *
 * Card scope reference: card_eda0e8f889c677f8d468a8b5 — Stage-by-stage
 * exam animations using entity 大頭貼 — emotional value.
 *
 * @param {object} msg  arena socket message ({event, testIndex?, score?, maxScore?, totalScore?})
 * @param {object} prev previous emotion state ({emotion, score, totalScore})
 * @returns {string|null} new emotion id, or null when the event does not
 *                       trigger a transition (caller leaves current state).
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.ArenaExamStageMapper = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const EMOTIONS = ['ready', 'focused', 'celebrate', 'concerned', 'proud'];

    function mapEvent(msg, prev) {
        if (!msg || typeof msg !== 'object') return null;
        const event = msg.event;
        if (!event) return null;

        // Final state — overrides everything else
        if (event === 'exam_complete') return 'proud';

        // Per-test final result
        if (event === 'session_complete' && msg.testIndex != null) {
            const score = Number(msg.score);
            // Treat NaN as 0 so a malformed event still routes to 'concerned'
            // rather than leaving the previous emotion stale.
            return (Number.isFinite(score) && score > 0) ? 'celebrate' : 'concerned';
        }

        // Active mid-test action
        if (event === 'action' && msg.testIndex != null) {
            return 'focused';
        }

        // Setup events that imply the exam is live but no action yet
        if (event === 'timer_started' || event === 'model_set') {
            // Don't downgrade celebrate/concerned/proud back to focused —
            // model_set / timer_started can fire after the first action when
            // the bot reports its model late.
            if (prev && (prev.emotion === 'celebrate' || prev.emotion === 'concerned' || prev.emotion === 'proud')) {
                return null;
            }
            return 'focused';
        }

        return null;
    }

    /**
     * Returns the initial state to show before any socket events arrive.
     * Defaults to 'ready' (idle bounce). Page can override via examData
     * status if it loaded a completed exam: pass {status: 'completed'} to
     * get 'proud' immediately.
     */
    function initialState(examData) {
        if (examData && examData.status === 'completed') return 'proud';
        return 'ready';
    }

    return {
        EMOTIONS: EMOTIONS,
        mapEvent: mapEvent,
        initialState: initialState,
    };
}));
