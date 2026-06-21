package com.hank.clawlive.engine

import android.graphics.PointF
import com.hank.clawlive.data.model.CharacterState
import com.hank.clawlive.data.model.EntityStatus

/**
 * Walking child T5 — sleep gate (spec §7).
 *
 * Pure-Kotlin, testable wrapper around T1's [MotionController] / [WallpaperWanderController].
 * It does not own positions; the underlying wander engine remains the single source of
 * coordinate truth (screen-percent, 0.0..1.0). The gate only decides, per server-reported
 * [CharacterState], whether motion ticks and motion commands are allowed to reach the engine.
 *
 * Rules enforced (spec §7.1):
 *  - A `SLEEPING` entity is excluded from the wander engine: its position freezes at the last
 *    known coordinate and it does not move across ticks.
 *  - On wake (`CharacterState` flips away from `SLEEPING`) the entity re-enters wander
 *    immediately (spec §7.2 step 1; the wake animation in §7.2 step 3 is a renderer concern).
 *  - speakTo asymmetry (spec §7.1 row "SpeakTo receiver-pause"): a sleeping *receiver* does NOT
 *    halt or take a target — it stays put. A non-sleeping *sender* still approaches and stops at
 *    the sleeping entity's position, "dropping off" the message.
 *
 * The gate never writes back to [EntityStatus.state]; motion is a client-side overlay
 * (spec §2.2 implementer rule).
 */
class SleepGateController(
    private val delegate: WallpaperWanderController = WallpaperWanderController()
) {
    /** Last sleep snapshot, keyed by entityId. Used to detect wake edges and gate commands. */
    private val sleeping = mutableMapOf<Int, Boolean>()

    fun reset() {
        sleeping.clear()
        delegate.reset()
    }

    /** True iff the entity is currently gated as sleeping. */
    fun isSleeping(entityId: Int): Boolean = sleeping[entityId] == true

    /**
     * Advance the wander engine for one draw tick while applying the sleep gate.
     *
     * Sleeping entities have their position frozen (the underlying engine already pins a
     * `SLEEPING` entity to its last position; the gate additionally records the sleep edge so
     * command routing — [requestApproach] / [requestReceiverPause] — can honor the asymmetry).
     *
     * @return per-entity device-pixel positions, index-aligned with [entities] (same contract as
     *   [WallpaperWanderController.positionsFor]).
     */
    fun tick(
        basePositions: List<Pair<Float, Float>>,
        entities: List<EntityStatus>,
        width: Float,
        height: Float,
        enabled: Boolean,
        purposeful: Boolean = true,
        nowMs: Long = System.currentTimeMillis()
    ): List<Pair<Float, Float>> {
        val activeIds = entities.map { it.entityId }.toSet()
        sleeping.keys.toList().forEach { id -> if (id !in activeIds) sleeping.remove(id) }
        entities.forEach { sleeping[it.entityId] = it.state == CharacterState.SLEEPING }
        return delegate.positionsFor(
            basePositions = basePositions,
            entities = entities,
            width = width,
            height = height,
            enabled = enabled,
            purposeful = purposeful,
            nowMs = nowMs
        )
    }

    /** Current motion state for the entity (delegates to the wander engine). */
    fun motionState(entityId: Int): MotionState = delegate.motionState(entityId)

    /** Current screen-percent position for the entity (delegates to the wander engine). */
    fun position(entityId: Int): PointF = delegate.position(entityId)

    fun isWalking(entityId: Int): Boolean = delegate.isWalking(entityId)

    /**
     * Sender side of a speakTo (spec §7.1): the sender approaches [receiver] and stops on arrival.
     * Honored even when the receiver is sleeping — the message is still "delivered" visually.
     *
     * A *sleeping* sender cannot approach; the request is dropped (gate).
     *
     * @return true if the approach target was set, false if the sender was gated by sleep.
     */
    fun requestApproach(
        senderId: Int,
        receiver: EntityStatus,
        receiverXPct: Float,
        receiverYPct: Float,
        onArrive: (() -> Unit)? = null
    ): Boolean {
        if (isSleeping(senderId)) return false
        // Walk to the receiver regardless of whether the receiver is awake.
        delegate.setTarget(senderId, receiverXPct, receiverYPct, onArrive)
        return true
    }

    /**
     * Receiver side of a speakTo (spec §2.4 / §7.1): an awake receiver halts in place to listen.
     * A sleeping receiver does NOT react — it stays put (no STOPPED transition, no target).
     *
     * @return true if the receiver was halted, false if it was sleeping and stayed put.
     */
    fun requestReceiverPause(receiver: EntityStatus): Boolean {
        if (receiver.state == CharacterState.SLEEPING) {
            sleeping[receiver.entityId] = true
            return false
        }
        delegate.stop(receiver.entityId)
        return true
    }
}
