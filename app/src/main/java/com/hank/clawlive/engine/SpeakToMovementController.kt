package com.hank.clawlive.engine

import android.graphics.PointF
import com.hank.clawlive.data.model.CharacterState
import kotlin.math.hypot

/**
 * Walking child T3 — speakTo movement (sender → receiver, both stop).
 *
 * Pure-Kotlin orchestration on top of the T1 [MotionController] interface (spec §2.5);
 * this class re-uses [MotionController.setTarget] / [MotionController.stop] /
 * [MotionController.resumeWander] and never re-implements stepping math (spec §2.5
 * "T2-T5 must consume — do not re-implement").
 *
 * Behaviour (spec §2.4 + §8.2 T3):
 *  - On a `speakTo` from sender → receiver entity, the **sender** starts an
 *    ACCELERATED walk toward the receiver's current coordinates and the **receiver**
 *    [MotionController.stop]s in place immediately (LISTENING overlay is a separate
 *    overlay controller, out of scope here — spec O-3 / §2.5).
 *  - The sender re-targets every tick while moving so it tracks a receiver that
 *    is still drifting (spec §2.4 row "sender of speakTo ... re-target every frame").
 *  - When the sender arrives **within 1 entity-unit** of the receiver, BOTH entities
 *    are STOPPED (the sender via the T1 onArrive→STOPPED path; the receiver was
 *    already STOPPED). Arrival is detected in pixel space against [arrivalRadiusPx].
 *  - speakTo **to the USER** (no receiver entity): the sender just [MotionController.stop]s
 *    in place — there is no movement target (scope: "sender just stops in place").
 *  - speakTo **to self**: motion no-op (spec §8.2 T3-4).
 *  - speakTo while receiver is SLEEPING: the receiver does NOT stop (stays SLEEPING);
 *    the sender still walks to the receiver's coordinates and stops there (spec T3-3 / T5-4).
 *  - Conversation end (no follow-up within [graceMs]): BOTH peers [MotionController.resumeWander]
 *    (spec §8.2 T3-5). A fresh speakTo before the grace elapses cancels the pending resume.
 *
 * ## Coordinate / unit assumptions
 *  - Positions are screen-percent floats in `[0,1]` (spec §4.1), matching T1.
 *  - **1 entity-unit = 1 entity sprite width** for arrival in this card (per task scope).
 *    The parent SPEC §3 proposes `sprite_width × 1.5` for halo *spacing*; arrival
 *    "stand next to" distance here is deliberately the tighter 1 sprite width so the
 *    sender ends up adjacent to the receiver. The multiplier is captured in
 *    [ENTITY_UNIT_SPRITE_WIDTH_MULTIPLIER] so a follow-on card can widen it without
 *    touching call sites.
 *  - Arrival is measured in pixel space (consistent with T1 §4.3) so it is correct
 *    under non-square surfaces.
 */
class SpeakToMovementController(
    private val motion: MotionController,
    /**
     * Live screen-percent position read for an entity, as `(xPct, yPct)` in `[0,1]`.
     * Defaults to the T1 [MotionController.position] (a `PointF`); split out as a pure-float
     * provider so the testable arrival/track math never round-trips through the Android
     * `PointF` stub (every other unit test in this module stays android-free).
     */
    private val positionProvider: (Int) -> Pair<Float, Float> = { id ->
        val p = motion.position(id)
        p.x to p.y
    },
    /** Sender walk speed is accelerated relative to the normal walk-to-target speed. */
    private val approachSpeedPctPerSecond: Float = ACCELERATED_APPROACH_SPEED_PCT_PER_SECOND,
    /** Grace period after a conversation ends before both peers resume wander (spec §2.4 / T3-5). */
    private val graceMs: Long = RESUME_GRACE_MS
) {
    /** Routing target of an in-flight speakTo conversation. */
    sealed class SpeakToTarget {
        /** Receiver is another entity; sender walks to it. */
        data class Entity(val entityId: Int) : SpeakToTarget()

        /** Receiver is the human user (or no entity); sender only stops in place. */
        object User : SpeakToTarget()
    }

    private data class Conversation(
        val senderId: Int,
        val target: SpeakToTarget,
        var senderArrived: Boolean,
        var endRequestedAtMs: Long?
    )

    /** Keyed by sender entityId — one in-flight conversation per sender. */
    private val conversations = mutableMapOf<Int, Conversation>()

    /** True once the sender has stopped within 1 entity-unit of its receiver. */
    fun isSenderArrived(senderId: Int): Boolean = conversations[senderId]?.senderArrived == true

    /** True while a speakTo from [senderId] is still being handled (walking, listening, or grace). */
    fun hasActiveConversation(senderId: Int): Boolean = conversations.containsKey(senderId)

    fun reset() {
        conversations.clear()
    }

    /**
     * Begin a speakTo. Sender accelerates toward the receiver; receiver stops in place
     * (unless sleeping / unless the receiver is the user).
     *
     * @param senderId entity that issued the speakTo
     * @param target   the receiver — another [SpeakToTarget.Entity] or [SpeakToTarget.User]
     * @param receiverState the receiver's [CharacterState] (only meaningful for [SpeakToTarget.Entity]);
     *                      a SLEEPING receiver is not stopped (spec T3-3).
     * @param width   surface width in px (for sprite-width → percent target framing)
     * @param height  surface height in px
     */
    fun onSpeakTo(
        senderId: Int,
        target: SpeakToTarget,
        receiverState: CharacterState = CharacterState.IDLE,
        width: Float = 0f,
        height: Float = 0f
    ) {
        // T3-4: speakTo self is a motion no-op (bubble handled elsewhere).
        if (target is SpeakToTarget.Entity && target.entityId == senderId) {
            return
        }

        when (target) {
            is SpeakToTarget.User -> {
                // Scope: sender just stops in place — no movement target.
                motion.stop(senderId)
                conversations[senderId] = Conversation(
                    senderId = senderId,
                    target = target,
                    senderArrived = true, // nothing to walk to; treat as "arrived" (in place)
                    endRequestedAtMs = null
                )
            }

            is SpeakToTarget.Entity -> {
                val receiverId = target.entityId
                // Receiver halts in place immediately (spec §2.4) — unless asleep (T3-3).
                if (receiverState != CharacterState.SLEEPING) {
                    motion.stop(receiverId)
                }

                conversations[senderId] = Conversation(
                    senderId = senderId,
                    target = target,
                    senderArrived = false,
                    endRequestedAtMs = null
                )

                // Sender accelerates toward the receiver's current coordinates.
                retargetSenderToReceiver(senderId, receiverId, width, height)
            }
        }
    }

    /**
     * Per-tick update. Re-targets the still-walking sender at the receiver's live position
     * and flips both peers to STOPPED once the sender is within 1 entity-unit. Also drives
     * the resume-wander grace timer.
     *
     * @param spriteWidthPx rendered sprite bounding-box width in px (defines the entity-unit).
     */
    fun update(width: Float, height: Float, spriteWidthPx: Float, nowMs: Long) {
        if (conversations.isEmpty()) return

        conversations.values.toList().forEach { convo ->
            // Drive the resume-after-grace timer first (independent of arrival).
            val endAt = convo.endRequestedAtMs
            if (endAt != null && nowMs >= endAt + graceMs) {
                finishConversation(convo)
                return@forEach
            }

            val target = convo.target
            if (target !is SpeakToTarget.Entity) return@forEach
            if (convo.senderArrived) return@forEach

            val receiverId = target.entityId
            // Re-target every tick so the sender tracks a still-drifting receiver (spec §2.4).
            retargetSenderToReceiver(convo.senderId, receiverId, width, height)

            if (withinOneEntityUnit(convo.senderId, receiverId, width, height, spriteWidthPx)) {
                // Arrival: BOTH stop. Sender stops here; receiver was already stopped
                // (or is intentionally left SLEEPING per T3-3).
                motion.stop(convo.senderId)
                convo.senderArrived = true
            }
        }
    }

    /**
     * Signal that the conversation from [senderId] is winding down (bubble TTL expired,
     * no pending TX). After [graceMs] with no new speakTo, both peers resume wander (T3-5).
     * A fresh [onSpeakTo] for the same sender cancels the pending resume.
     */
    fun onConversationEnding(senderId: Int, nowMs: Long) {
        val convo = conversations[senderId] ?: return
        convo.endRequestedAtMs = nowMs
    }

    private fun finishConversation(convo: Conversation) {
        motion.resumeWander(convo.senderId)
        val target = convo.target
        if (target is SpeakToTarget.Entity) {
            motion.resumeWander(target.entityId)
        }
        conversations.remove(convo.senderId)
    }

    private fun retargetSenderToReceiver(senderId: Int, receiverId: Int, width: Float, height: Float) {
        val (rx, ry) = positionProvider(receiverId)
        // Accelerate the sender: re-issue the target each tick. setTarget keeps motion state
        // in MOVING_TO_TARGET; the (faster) approach speed is applied by the wallpaper service
        // via approachSpeedPctPerSecond().
        motion.setTarget(senderId, rx, ry)
    }

    private fun withinOneEntityUnit(
        senderId: Int,
        receiverId: Int,
        width: Float,
        height: Float,
        spriteWidthPx: Float
    ): Boolean {
        if (width <= 0f || height <= 0f) return false
        val (sx, sy) = positionProvider(senderId)
        val (rx, ry) = positionProvider(receiverId)
        val dxPx = (sx - rx) * width
        val dyPx = (sy - ry) * height
        val distancePx = hypot(dxPx, dyPx)
        return distancePx <= arrivalRadiusPx(spriteWidthPx)
    }

    /** 1 entity-unit in px. See class doc: 1 entity-unit = 1 sprite width for arrival in this card. */
    fun arrivalRadiusPx(spriteWidthPx: Float): Float =
        spriteWidthPx * ENTITY_UNIT_SPRITE_WIDTH_MULTIPLIER

    /** Approach speed for the accelerated sender walk (consumed by the wallpaper service). */
    fun approachSpeedPctPerSecond(): Float = approachSpeedPctPerSecond

    companion object {
        /**
         * 1 entity-unit = sprite_width × this. Task scope pins arrival to 1 sprite width;
         * parent SPEC §3 proposes 1.5 for halo *spacing* (a separate concern, T4).
         */
        const val ENTITY_UNIT_SPRITE_WIDTH_MULTIPLIER = 1.0f

        /**
         * Accelerated approach speed. ~2× the normal walk-to-target speed (T1 default 0.12)
         * so the sender visibly hurries over to the receiver (spec §4.3 "feels purposeful").
         */
        const val ACCELERATED_APPROACH_SPEED_PCT_PER_SECOND = 0.24f

        /** Resume-wander grace after conversation end (spec §2.4 / §8.2 T3-5). */
        const val RESUME_GRACE_MS = 1500L
    }
}
