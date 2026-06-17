/**
 * Org-chart forward noise filter.
 *
 * orgChartForward() in index.js silently routes any bot message up the org
 * chart to the user's superior. Sibling bots whose webhook handler crashes
 * (JSON parse errors), or that send bare "[<name> 回應超時]" status markers,
 * or that ack-the-ack with one-word replies, were flooding the user's
 * channel with low-signal noise. This filter drops those before the silent
 * push happens.
 */

const ORG_FWD_NOISE_PATTERNS = [
    /^\s*Unexpected (non-whitespace character after JSON|token .* in JSON|end of JSON)/i,
    /^\s*SyntaxError: Unexpected/i,
    /^\s*at position \d+/i,
    /^\s*line \d+ column \d+/i,
    /^\s*\[[^\]]{1,40}回應超時\]\s*$/,
    /^\s*\[[^\]]{1,40}response timeout\]\s*$/i,
    // [SILENT] is optional here so that getSilentTransformSuppressionReason
    // can pre-strip the token before evaluating the trailer (test:
    // `@#6 [SILENT] #6 sign-off FWD echo` → strip mention + [SILENT] →
    // `#6 sign-off FWD echo` should still classify as low-signal).
    /^\s*(?:\[SILENT\]\s*)?#?\d+\s+sign[- ]off\s+FWD\s+echo\b/i,
    /^\s*(ping|pong|ack|ok|received|noted)\s*[.!]*\s*$/i,
    // ACK / FWD-ACK nonce responses — these are no-op acknowledgements
    /^\s*ACK\s+<\/?nonce>\s*$/i,
    /^\s*\[📢\s*FWD\s+from\s+#\d+\]\s+ACK\s+<\/?nonce>\s*$/i,

    // ── System / automation / kanban notification echoes (card_ef4f729385089025431ea8f1) ──
    // The kanban notify path (backend/kanban.js notifyEntities) pushes
    // platform-generated status/automation notices to the *assigned* bot. When
    // that bot's agent echoes / acks the notice back, the echo travels up the
    // org chart (index.js:9807 orgChartForward) and floods the supervisor.
    // These are NOT decision-needing content — they're system status noise, so
    // suppress them before the upward forward. Matched by the stable
    // leading-emoji + template markers used across every locale in
    // backend/i18n/kanban-notifications.js (statusChanged / cardCreated /
    // automationTrigger / scheduleOnce / scheduleRecurring / staleNudge /
    // reviewerNotify / reviewerMovedToReview) plus the in-card system comment
    // prefix (📌 狀態更新) and the model-health FWD echo line.
    //
    // Anchored to the leading icon so a bot's *own* free-text status report
    // ("Card 7a03c4 moved to in_progress, ETA 2h") still forwards normally —
    // only the verbatim system-template strings are dropped.
    /^\s*📌\s*狀態更新/,                       // in-card system comment echo (kanban.js:2170)
    /^\s*(?:➡️?|⬅️?)️?\s/u,             // statusChanged: leading "{➡️|⬅️} Task status changed …"
    /^\s*📋\s/,                               // cardCreated  ("📋 New task assigned / 新任務指派 / …")
    /^\s*🗓️?\s/u,                       // schedule*/automationTrigger ("🗓️ Schedule/Automation triggered …")
    /^\s*⏰\s/,                               // staleNudge   ("⏰ Task nudge / 任務催促 / …")
    /^\s*🔍\s/,                               // reviewerNotify / reviewerMovedToReview ("🔍 …")
    /^\s*⏸️?\s/u,                        // screenshot-gate auto-close hold notice (kanban.js:3996/4001)
    /^\s*♻️?\s*Card reopened/iu,         // card reopened echo (kanban.js:2405/2408)
    // model-health FWD echoes (background traffic, by design): "[📢 FWD … MODEL_HEALTH/ACK]"
    /^\s*\[📢\s*FWD\b.*\b(MODEL_HEALTH|ACK)\b/i,
];

const ORG_FWD_MIN_BODY_LEN = 12;

function isLowSignalFwd(message) {
    if (!message) return true;
    const trimmed = String(message).trim();
    if (trimmed.length < ORG_FWD_MIN_BODY_LEN) return true;
    return ORG_FWD_NOISE_PATTERNS.some(re => re.test(trimmed));
}

module.exports = {
    isLowSignalFwd,
    ORG_FWD_NOISE_PATTERNS,
    ORG_FWD_MIN_BODY_LEN,
};
