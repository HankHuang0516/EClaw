/**
 * Unit tests for org-fwd-escalation — the "緊迫盯人" supervisor escalation gate.
 *
 * Card: card_184f2a25c1f1a13ebae5ec3e
 * Bug: a message addressed to target #1 (Mac_F) was relayed to its superior #2
 * (Mac_ClaudeAce 主管) immediately, so #2 "搶答" the message. The gate must:
 *   - NOT escalate an inbound message while it is within the grace window
 *     (subordinate gets first crack)
 *   - NOT escalate if the target replied at/after the inbound arrived
 *   - escalate only once the target stays silent past the threshold
 */

const { shouldEscalateInbound, DEFAULT_ESCALATE_SILENCE_MS } = require('../../org-fwd-escalation');

const MIN = 60 * 1000;

describe('shouldEscalateInbound()', () => {
    describe('the 搶答 case — message addressed to #1 must NOT reach #2 immediately', () => {
        it('does NOT escalate immediately after an inbound to a never-replied target', () => {
            const inboundAt = 1_000_000;
            const decision = shouldEscalateInbound({
                targetLastReplyAt: undefined, // #1 has not replied yet
                inboundAt,
                silenceMs: 30 * MIN,
                now: inboundAt + 1, // ~immediate, the original bug trigger
            });
            expect(decision.escalate).toBe(false);
            expect(decision.reason).toBe('within_grace_window');
        });

        it('does NOT escalate if the target replied AT or AFTER the inbound arrived', () => {
            const inboundAt = 1_000_000;
            const decision = shouldEscalateInbound({
                targetLastReplyAt: inboundAt + 5 * MIN, // #1 actively handled it
                inboundAt,
                silenceMs: 30 * MIN,
                now: inboundAt + 40 * MIN, // even long after, #1 replied → no escalation
            });
            expect(decision.escalate).toBe(false);
            expect(decision.reason).toBe('target_replied_after_inbound');
        });

        it('does NOT escalate while still inside the grace window even with no reply', () => {
            const inboundAt = 1_000_000;
            const decision = shouldEscalateInbound({
                targetLastReplyAt: inboundAt - 10 * MIN, // last reply was BEFORE this inbound
                inboundAt,
                silenceMs: 30 * MIN,
                now: inboundAt + 29 * MIN, // just under threshold
            });
            expect(decision.escalate).toBe(false);
            expect(decision.reason).toBe('within_grace_window');
        });
    });

    describe('timeout escalation — #1 silent past threshold DOES reach #2', () => {
        it('escalates once the target stays silent past the threshold (never replied)', () => {
            const inboundAt = 1_000_000;
            const decision = shouldEscalateInbound({
                targetLastReplyAt: undefined,
                inboundAt,
                silenceMs: 30 * MIN,
                now: inboundAt + 31 * MIN,
            });
            expect(decision.escalate).toBe(true);
            expect(decision.reason).toBe('target_silent_past_threshold');
        });

        it('escalates if the only reply predates this inbound and grace has elapsed', () => {
            const inboundAt = 1_000_000;
            const decision = shouldEscalateInbound({
                targetLastReplyAt: inboundAt - 1, // stale reply, before the inbound
                inboundAt,
                silenceMs: 30 * MIN,
                now: inboundAt + 30 * MIN, // exactly at threshold counts as past grace
            });
            expect(decision.escalate).toBe(true);
            expect(decision.reason).toBe('target_silent_past_threshold');
        });

        it('a reply exactly at the inbound timestamp suppresses escalation', () => {
            const inboundAt = 1_000_000;
            const decision = shouldEscalateInbound({
                targetLastReplyAt: inboundAt, // tie → treated as "replied"
                inboundAt,
                silenceMs: 30 * MIN,
                now: inboundAt + 60 * MIN,
            });
            expect(decision.escalate).toBe(false);
            expect(decision.reason).toBe('target_replied_after_inbound');
        });
    });

    describe('defaults & guards', () => {
        it('defaults to ~30 min silence threshold', () => {
            expect(DEFAULT_ESCALATE_SILENCE_MS).toBe(30 * MIN);
        });

        it('falls back to the default threshold when silenceMs is invalid', () => {
            const inboundAt = 1_000_000;
            // 20 min after inbound with default 30 min → still within grace
            const decision = shouldEscalateInbound({
                targetLastReplyAt: undefined,
                inboundAt,
                silenceMs: 0, // invalid → default
                now: inboundAt + 20 * MIN,
            });
            expect(decision.escalate).toBe(false);
            expect(decision.reason).toBe('within_grace_window');
        });

        it('treats a missing inboundAt as "now" (no immediate escalation)', () => {
            const now = 5_000_000;
            const decision = shouldEscalateInbound({
                targetLastReplyAt: undefined,
                inboundAt: undefined,
                silenceMs: 30 * MIN,
                now,
            });
            expect(decision.escalate).toBe(false);
            expect(decision.reason).toBe('within_grace_window');
        });
    });
});
