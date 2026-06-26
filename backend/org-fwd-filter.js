/**
 * Org-chart forward noise filter.
 *
 * orgChartForward() in index.js silently routes any bot message up the org
 * chart to the user's superior. Sibling bots whose webhook handler crashes
 * (JSON parse errors), or that send bare "[<name> 回應超時]" status markers,
 * or that ack-the-ack with one-word replies, were flooding the user's
 * channel with low-signal noise. This filter drops those before the silent
 * push happens.
 *
 * The patterns are grouped by KIND so callers can not only decide *whether* to
 * suppress (isLowSignalFwd) but also *why* (classifyLowSignalFwd) — the latter
 * feeds the "drop-but-surface" suppression-transparency log (card_59f41e5b) so
 * the dashboard can show the user what was filtered and which category it was.
 */

// Each entry: [reasonLabel, regex]. Order matters only for classification (the
// first matching group wins); isLowSignalFwd is order-independent (any match →
// true). The flat ORG_FWD_NOISE_PATTERNS below is derived from this list so the
// boolean filter and the classifier can never drift apart.

const ORG_FWD_NOISE_GROUPS = [
    // ── JSON parse / stack-trace crash fragments (the original Mac_E flood) ──
    ['json_crash', /^\s*Unexpected (non-whitespace character after JSON|token .* in JSON|end of JSON)/i],
    ['json_crash', /^\s*SyntaxError: Unexpected/i],
    ['json_crash', /^\s*at position \d+/i],
    ['json_crash', /^\s*line \d+ column \d+/i],

    // ── Bare timeout markers (the Hermes empty-FWD loop) ──
    ['timeout_marker', /^\s*\[[^\]]{1,40}回應超時\]\s*$/],
    ['timeout_marker', /^\s*\[[^\]]{1,40}response timeout\]\s*$/i],

    // ── One-word / control acks (the ack-of-ack loop) ──
    // [SILENT] is optional here so that getSilentTransformSuppressionReason
    // can pre-strip the token before evaluating the trailer (test:
    // `@#6 [SILENT] #6 sign-off FWD echo` → strip mention + [SILENT] →
    // `#6 sign-off FWD echo` should still classify as low-signal).
    ['ack', /^\s*(?:\[SILENT\]\s*)?#?\d+\s+sign[- ]off\s+FWD\s+echo\b/i],
    ['ack', /^\s*(ping|pong|ack|ok|received|noted)\s*[.!]*\s*$/i],
    // ACK / FWD-ACK nonce responses — these are no-op acknowledgements
    ['ack', /^\s*ACK\s+<\/?nonce>\s*$/i],
    ['ack', /^\s*\[📢\s*FWD\s+from\s+#\d+\]\s+ACK\s+<\/?nonce>\s*$/i],
    // Chinese bot-to-bot pure ack (card_59f41e5b). The optional [📢 FWD from #N]
    // wrapper mirrors the PERMISSION_HANDOFF pattern; the trailing class only
    // allows whitespace/punctuation + an optional 🦞 mascot, so a *real* status
    // report that merely STARTS with 收到 but carries content ("收到，正在處理
    // card_…，預計 30 分鐘內回報") fails the `$` anchor and still forwards.
    // NB: 🦞 is wrapped as (?:🦞)? — a bare `🦞?` (no /u flag) would quantify
    // only the low surrogate and wrongly REQUIRE the high surrogate.
    ['ack', /^\s*(?:\[📢\s*FWD\s+from\s+#\d+\]\s*)?(?:收到|已收到|了解|好的|OK|okay)[\s，,。.!！~]*(?:🦞)?\s*$/i],

    // ── System / automation / kanban notification echoes (card_ef4f729385089025431ea8f1) ──
    // The kanban notify path (backend/kanban.js notifyEntities) pushes
    // platform-generated status/automation notices to the *assigned* bot. When
    // that bot's agent echoes / acks the notice back, the echo travels up the
    // org chart (index.js orgChartForward) and floods the supervisor.
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
    ['kanban_echo', /^\s*📌\s*狀態更新/],                       // in-card system comment echo (kanban.js:2170)
    ['kanban_echo', /^\s*(?:➡️?|⬅️?)️?\s/u],             // statusChanged: leading "{➡️|⬅️} Task status changed …"
    ['kanban_echo', /^\s*📋\s/],                               // cardCreated  ("📋 New task assigned / 新任務指派 / …")
    ['kanban_echo', /^\s*🗓️?\s/u],                       // schedule*/automationTrigger ("🗓️ Schedule/Automation triggered …")
    ['kanban_echo', /^\s*⏰\s/],                               // staleNudge   ("⏰ Task nudge / 任務催促 / …")
    ['kanban_echo', /^\s*🔍\s/],                               // reviewerNotify / reviewerMovedToReview ("🔍 …")
    ['kanban_echo', /^\s*⏸️?\s/u],                        // screenshot-gate auto-close hold notice (kanban.js:3996/4001)
    ['kanban_echo', /^\s*♻️?\s*Card reopened/iu],         // card reopened echo (kanban.js:2405/2408)

    // ── Model-health FWD echoes (background traffic, by design) ──
    // "[📢 FWD … MODEL_HEALTH/ACK]"
    ['model_health', /^\s*\[📢\s*FWD\b.*\b(MODEL_HEALTH|ACK)\b/i],

    // ── Codex/openclaw runtime machine-noise forwards (card_77c4b9e2) ──
    // #6's openclaw/codex runtime auto-emits these lifecycle templates:
    //   • #N_<KIND>_HANDOFF — a FALSE alarm fired when a benign post-exec
    //     cleanup WARN ("Failed to terminate MCP process group N: Operation not
    //     permitted") is misread as a real exec blocker; observed re-firing
    //     ~1/min. The runtime emits several KINDs of the SAME machine-noise
    //     class — #N_PERMISSION_HANDOFF and (card_59f41e5b) #N_RESOURCE_HANDOFF —
    //     so the token is generalized to #\d+_[A-Z]+_HANDOFF to cover any future
    //     <KIND> without another fix-forward.
    //   • "Codex #N status heartbeat" / bridge-lifecycle notices — periodic
    //     keep-alive status, no decision content.
    // The emitter is REMOTE (the process behind CODEX_COMMANDS_URL, not this
    // repo) and re-evaluates per exec, stateless — so it cannot be silenced
    // from chat and must be dropped HERE before the upward org-chart forward,
    // exactly like the MODEL_HEALTH/ACK echoes above. The leading
    // "[📢 FWD from #N]" wrapper is optional because the raw machine token can
    // arrive already prefixed. Anchored at line start so a bot's OWN prose that
    // merely mentions "heartbeat"/"handoff" in a sentence still forwards, and
    // a genuine permission gate (different leading text) is never swallowed.
    // Reason label kept as 'permission_handoff' for stability across the family.
    ['permission_handoff', /^\s*(?:\[📢\s*FWD\s+from\s+#\d+\]\s*)?#\d+_[A-Z]+_HANDOFF\b/i],
    ['heartbeat', /^\s*(?:\[📢\s*FWD\s+from\s+#\d+\]\s*)?Codex\s+#?\d*\s*status heartbeat\b/i],
    ['heartbeat', /^\s*(?:\[📢\s*FWD\s+from\s+#\d+\]\s*)?Codex\s+(?:bridge error|watchdog|bridge status)\b/i],
    ['heartbeat', /^\s*(?:\[📢\s*FWD\s+from\s+#\d+\]\s*)?EClaw progress update\b/i],
    // Chinese peer watchdog-narration heartbeat echo (card_59f41e5b + fix-forward).
    // #5 (and peers) bounce keep-alive "watchdog narration" echoes up the org
    // chart — e.g. "收到，#6 last output 66m29s 前，bridge alive，沉默超 1h。等
    // owner 處置。🦞" / "#6 watchdog 45m 到期，已進 resource handoff。🦞". The
    // earlier approach END-ANCHORED the body to a hand-maintained whitelist of
    // heartbeat tokens, but #5's LLM keeps inventing new narration words ("沉默超
    // 1h", "Codex 沉默中", …) that aren't in the list, so the `$` anchor broke and
    // the echo SLIPPED THROUGH (verified live: classifyLowSignalFwd("收到，#6 last
    // output 66m29s 前，bridge alive，沉默超 1h。等 owner 處置。🦞") === null).
    // This robust SHAPE heuristic does NOT enumerate the body vocabulary. One
    // regex suppresses iff ALL hold:
    //   1. after an optional "[📢 FWD from #N]" prefix the message STARTS with an
    //      ack (收到/已收到/了解) or an entity ref (#N), and
    //   2. it CONTAINS ≥1 heartbeat-domain keyword (watchdog/handoff/bridge/last
    //      output/仍在跑/還在跑/餘量/僅餘/沉默/在線/resource/到期/觸發/心跳/codex…),
    //      and
    //   3. it ENDS with the 🦞 sign-off (peers' machine heartbeats always do), and
    //   4. it carries NO actionable-content marker (a card id, PR #, URL, or a
    //      work verb 我修/修好/完成/我發現/待 review).
    // (1)+(2) say "looks like a heartbeat"; (3)+(4) are the false-positive guards
    // that keep a REAL escalation forwarding — a genuine owner-ping won't append
    // 🦞 and a real status report carries a card/PR/verb. The whole feature hinges
    // on never eating a real escalation, so a borderline non-🦞 heartbeat narration
    // deliberately FORWARDS (annoying noise ≪ an eaten escalation). NB: [\s\S]
    // (not the /s flag) handles multi-line bodies; 🦞 is matched as a literal
    // surrogate pair (no /u flag, consistent with the other patterns here).
    ['heartbeat', /^\s*(?:\[📢\s*FWD\s+from\s+#\d+\]\s*)?(?:收到|已收到|了解|#\d+\b)(?=[\s\S]*(?:watchdog|handoff|bridge|last\s*output|仍在跑|還在跑|餘量|僅餘|沉默|沈默|在線|resource|到期|觸發|心跳|heartbeat|codex))(?![\s\S]*(?:card_[0-9a-f]{6}|PR\s*#?\d|https?:\/\/|我修|修好|完成|我發現|待\s*review))[\s\S]*🦞[\s，,。.!！~]*$/i],

    // ── Standalone lobster mascot ping (card_59f41e5b) ──
    // A bare 🦞 (optionally FWD-wrapped) carries no information.
    ['lobster', /^\s*(?:\[📢\s*FWD\s+from\s+#\d+\]\s*)?🦞\s*$/],
];

// Flat list preserved for backward compatibility (and existing imports).
const ORG_FWD_NOISE_PATTERNS = ORG_FWD_NOISE_GROUPS.map(([, re]) => re);

const ORG_FWD_MIN_BODY_LEN = 12;

/**
 * Classify a candidate org-chart forward into a low-signal reason label, or
 * return null if it carries real signal and should forward.
 *
 * Reason labels: 'json_crash' | 'timeout_marker' | 'ack' | 'kanban_echo' |
 * 'model_health' | 'permission_handoff' | 'heartbeat' | 'lobster' |
 * 'low_signal'. The last ('low_signal') is the catch-all for empty / too-short
 * bodies that match no specific pattern.
 *
 * isLowSignalFwd(message) === (classifyLowSignalFwd(message) != null), by
 * construction — the boolean filter and the classifier share one source of
 * truth so they can never disagree.
 */
function classifyLowSignalFwd(message) {
    if (!message) return 'low_signal';
    const trimmed = String(message).trim();
    // Specific patterns first, so even a short body gets a meaningful label
    // (e.g. '已收到。' → 'ack' rather than the generic 'low_signal').
    for (const [reason, re] of ORG_FWD_NOISE_GROUPS) {
        if (re.test(trimmed)) return reason;
    }
    // Catch-all: anything too short to be actionable.
    if (trimmed.length < ORG_FWD_MIN_BODY_LEN) return 'low_signal';
    return null;
}

function isLowSignalFwd(message) {
    return classifyLowSignalFwd(message) != null;
}

module.exports = {
    isLowSignalFwd,
    classifyLowSignalFwd,
    ORG_FWD_NOISE_PATTERNS,
    ORG_FWD_NOISE_GROUPS,
    ORG_FWD_MIN_BODY_LEN,
};
