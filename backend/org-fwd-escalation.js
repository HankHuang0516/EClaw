/**
 * Org-chart inbound escalation timing ("緊迫盯人" supervisor escalation).
 *
 * Root cause (card_184f2a25c1f1a13ebae5ec3e): a channel message addressed to a
 * target entity (e.g. #1 Mac_F) was being relayed to that entity's superior
 * (#2 Mac_ClaudeAce 主管) IMMEDIATELY by orgChartForward() at the two inbound
 * call sites (speakTo / cross-speak delivery). The superior's channel then
 * treats the relayed message as an actionable prompt and "搶答" — answers a
 * message that was addressed to the subordinate, while the subordinate was
 * still actively handling it. Hank caught this in the web UI: he ticked
 * 「傳送給 ☑ Mac_F (#1)」 yet #2 replied to 「聽到請回答」.
 *
 * The fix: inbound forwarding to a superior is an ESCALATION, not a mirror.
 * The supervisor should only be pulled in when the target has gone SILENT past
 * a threshold (default ~30 min, mirroring Hank's chat-reply escalation norm and
 * the kanban L1/L2/L3 grace-window style). If the target replied (produced a
 * response) since it last received an inbound message, there is nothing to
 * escalate — the subordinate is doing its job.
 *
 * This module is a pure decision function (no I/O) so it can be unit-tested in
 * isolation, the same way org-fwd-filter.js is.
 */

// Default silence window before an unanswered inbound to the target escalates
// to its superior. ~30 min per Hank's chat-reply escalation norm. Overridable
// via ECLAW_ORG_ESCALATE_SILENCE_MIN for ops tuning.
const DEFAULT_ESCALATE_SILENCE_MS = (() => {
    const raw = parseInt(process.env.ECLAW_ORG_ESCALATE_SILENCE_MIN || '30', 10);
    const min = Number.isFinite(raw) && raw > 0 ? raw : 30;
    return min * 60 * 1000;
})();

/**
 * Decide whether an INBOUND message addressed to `target` should be escalated
 * to its superior right now.
 *
 * @param {object} args
 * @param {number} [args.targetLastReplyAt] - epoch ms when the target entity
 *        last produced a response (entity.lastUpdated). Undefined/null = the
 *        target has never replied.
 * @param {number} args.inboundAt - epoch ms when this inbound message arrived
 *        (typically Date.now() at the call site).
 * @param {number} [args.silenceMs] - silence threshold; defaults to
 *        DEFAULT_ESCALATE_SILENCE_MS.
 * @param {number} [args.now] - current epoch ms; defaults to Date.now().
 * @returns {{ escalate: boolean, reason: string }}
 */
function shouldEscalateInbound({ targetLastReplyAt, inboundAt, silenceMs, now } = {}) {
    const threshold = Number.isFinite(silenceMs) && silenceMs > 0
        ? silenceMs
        : DEFAULT_ESCALATE_SILENCE_MS;
    const nowMs = Number.isFinite(now) ? now : Date.now();
    const arrivedAt = Number.isFinite(inboundAt) ? inboundAt : nowMs;

    // If the target has replied AT OR AFTER this inbound arrived, the
    // subordinate is actively handling it — never escalate (this is the
    // 搶答 case the card is about).
    if (Number.isFinite(targetLastReplyAt) && targetLastReplyAt >= arrivedAt) {
        return { escalate: false, reason: 'target_replied_after_inbound' };
    }

    // Otherwise, escalate only once the target has stayed silent past the
    // threshold since this inbound arrived. Immediate forwarding (now within
    // the grace window) is suppressed — the subordinate gets first crack.
    if (nowMs - arrivedAt < threshold) {
        return { escalate: false, reason: 'within_grace_window' };
    }

    return { escalate: true, reason: 'target_silent_past_threshold' };
}

module.exports = {
    shouldEscalateInbound,
    DEFAULT_ESCALATE_SILENCE_MS,
};
