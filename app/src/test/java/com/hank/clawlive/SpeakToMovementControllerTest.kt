package com.hank.clawlive

import android.graphics.PointF
import com.hank.clawlive.data.model.CharacterState
import com.hank.clawlive.engine.MotionController
import com.hank.clawlive.engine.MotionState
import com.hank.clawlive.engine.SpeakToMovementController
import kotlin.math.hypot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * T3 speakTo movement tests. Uses a lightweight in-test [MotionController] fake so the
 * assertions are deterministic and isolated from T1's random wander timing, while still
 * exercising the exact interface T3 consumes (spec §2.5).
 *
 * The fake exposes coordinates as pure `(Float, Float)` via [FakeMotion.posOf] / the
 * injected position provider, so neither the controller nor the assertions touch the
 * Android `PointF` stub (every other unit test in this module is android-free).
 */
class SpeakToMovementControllerTest {

    /** Deterministic MotionController: linear step toward target at a fixed pct/sec. */
    private class FakeMotion(
        private val width: Float,
        private val height: Float,
        private val stepPctPerTick: Float = 0.1f
    ) : MotionController {
        private data class S(
            var x: Float,
            var y: Float,
            var tx: Float,
            var ty: Float,
            var state: MotionState
        )

        private val states = mutableMapOf<Int, S>()

        fun place(id: Int, x: Float, y: Float) {
            states[id] = S(x, y, x, y, MotionState.WANDERING)
        }

        /** Pure-float position read used by the controller's provider and by assertions. */
        fun posOf(id: Int): Pair<Float, Float> {
            val s = states[id] ?: return 0.5f to 0.5f
            return s.x to s.y
        }

        /** Advance one tick: any MOVING_TO_TARGET entity steps toward its target. */
        fun tick() {
            states.values.forEach { s ->
                if (s.state != MotionState.MOVING_TO_TARGET) return@forEach
                val dxPx = (s.tx - s.x) * width
                val dyPx = (s.ty - s.y) * height
                val distPx = hypot(dxPx, dyPx)
                val stepPx = stepPctPerTick * minOf(width, height)
                if (distPx <= stepPx || distPx == 0f) {
                    s.x = s.tx; s.y = s.ty
                } else {
                    val f = stepPx / distPx
                    s.x += (s.tx - s.x) * f
                    s.y += (s.ty - s.y) * f
                }
            }
        }

        // Required by the interface but unused in these tests — the controller reads
        // coordinates through the injected pure-float provider (posOf) instead, so the
        // Android PointF stub is never constructed.
        override fun position(entityId: Int): PointF =
            throw UnsupportedOperationException("use posOf() in tests")

        override fun motionState(entityId: Int): MotionState =
            states[entityId]?.state ?: MotionState.STOPPED

        override fun setTarget(entityId: Int, xPct: Float, yPct: Float, onArrive: (() -> Unit)?) {
            val s = states.getOrPut(entityId) { S(0.5f, 0.5f, xPct, yPct, MotionState.WANDERING) }
            s.tx = xPct; s.ty = yPct; s.state = MotionState.MOVING_TO_TARGET
        }

        override fun stop(entityId: Int) {
            states.getOrPut(entityId) { S(0.5f, 0.5f, 0.5f, 0.5f, MotionState.STOPPED) }.state =
                MotionState.STOPPED
        }

        override fun clearStop(entityId: Int) {
            states[entityId]?.let { if (it.state == MotionState.STOPPED) it.state = MotionState.WANDERING }
        }

        override fun resumeWander(entityId: Int) {
            states.getOrPut(entityId) { S(0.5f, 0.5f, 0.5f, 0.5f, MotionState.WANDERING) }.state =
                MotionState.WANDERING
        }
    }

    private val W = 1000f
    private val H = 1000f
    private val SPRITE = 60f // 1 entity-unit = 1 sprite width = 60px

    @Test
    fun senderWalksTowardReceiverAndReceiverStopsImmediately() {
        val motion = FakeMotion(W, H)
        val sut = SpeakToMovementController(motion, positionProvider = motion::posOf)
        motion.place(1, 0.1f, 0.1f) // sender A
        motion.place(2, 0.8f, 0.8f) // receiver B

        sut.onSpeakTo(1, SpeakToMovementController.SpeakToTarget.Entity(2), CharacterState.IDLE, W, H)

        // Receiver halts immediately (spec §2.4).
        assertEquals(MotionState.STOPPED, motion.motionState(2))
        // Sender is moving toward receiver.
        assertEquals(MotionState.MOVING_TO_TARGET, motion.motionState(1))

        val before = motion.posOf(1)
        motion.tick()
        sut.update(W, H, SPRITE, nowMs = 100L)
        val after = motion.posOf(1)
        val movedTowardReceiver = hypot((after.first - 0.8f), (after.second - 0.8f)) <
            hypot((before.first - 0.8f), (before.second - 0.8f))
        assertTrue("sender should move toward receiver", movedTowardReceiver)
    }

    @Test
    fun bothStopWhenSenderArrivesWithinOneEntityUnit() {
        val motion = FakeMotion(W, H)
        val sut = SpeakToMovementController(motion, positionProvider = motion::posOf)
        motion.place(1, 0.05f, 0.05f)
        motion.place(2, 0.9f, 0.9f)

        sut.onSpeakTo(1, SpeakToMovementController.SpeakToTarget.Entity(2), CharacterState.IDLE, W, H)

        var t = 0L
        repeat(60) {
            motion.tick()
            t += 50
            sut.update(W, H, SPRITE, nowMs = t)
        }

        assertTrue("sender should have arrived", sut.isSenderArrived(1))
        assertEquals("sender stops on arrival", MotionState.STOPPED, motion.motionState(1))
        assertEquals("receiver stays stopped", MotionState.STOPPED, motion.motionState(2))

        // Within 1 entity-unit (1 sprite width) in px.
        val s = motion.posOf(1)
        val r = motion.posOf(2)
        val distPx = hypot((s.first - r.first) * W, (s.second - r.second) * H)
        assertTrue(
            "arrival distance $distPx must be <= 1 entity-unit (${sut.arrivalRadiusPx(SPRITE)}px)",
            distPx <= sut.arrivalRadiusPx(SPRITE)
        )
    }

    @Test
    fun speakToUserMakesSenderStopInPlaceWithNoTarget() {
        val motion = FakeMotion(W, H)
        val sut = SpeakToMovementController(motion, positionProvider = motion::posOf)
        motion.place(1, 0.3f, 0.4f)

        sut.onSpeakTo(1, SpeakToMovementController.SpeakToTarget.User, width = W, height = H)

        assertEquals("speakTo-user = stop in place", MotionState.STOPPED, motion.motionState(1))
        assertTrue(sut.hasActiveConversation(1))
        assertTrue("no walking target, already in place", sut.isSenderArrived(1))

        // Position must not drift on subsequent ticks.
        val before = motion.posOf(1)
        repeat(5) { motion.tick(); sut.update(W, H, SPRITE, nowMs = it * 50L) }
        val after = motion.posOf(1)
        assertEquals(before.first, after.first, 0.0001f)
        assertEquals(before.second, after.second, 0.0001f)
    }

    @Test
    fun speakToSelfIsMotionNoOp() {
        val motion = FakeMotion(W, H)
        val sut = SpeakToMovementController(motion, positionProvider = motion::posOf)
        motion.place(1, 0.5f, 0.5f)

        sut.onSpeakTo(1, SpeakToMovementController.SpeakToTarget.Entity(1), CharacterState.IDLE, W, H)

        assertFalse("self speakTo opens no conversation", sut.hasActiveConversation(1))
        assertEquals("self speakTo leaves motion untouched", MotionState.WANDERING, motion.motionState(1))
    }

    @Test
    fun bothResumeWanderAfterGraceTimeout() {
        val motion = FakeMotion(W, H)
        val sut = SpeakToMovementController(motion, positionProvider = motion::posOf)
        motion.place(1, 0.05f, 0.05f)
        motion.place(2, 0.9f, 0.9f)

        sut.onSpeakTo(1, SpeakToMovementController.SpeakToTarget.Entity(2), CharacterState.IDLE, W, H)
        var t = 0L
        repeat(60) { motion.tick(); t += 50; sut.update(W, H, SPRITE, nowMs = t) }
        assertTrue(sut.isSenderArrived(1))

        // Conversation ends.
        sut.onConversationEnding(1, nowMs = t)

        // Before grace elapses: still stopped, still tracked.
        sut.update(W, H, SPRITE, nowMs = t + 1000L)
        assertEquals(MotionState.STOPPED, motion.motionState(1))
        assertTrue(sut.hasActiveConversation(1))

        // After grace (1500ms): both resume wander, conversation cleared.
        sut.update(W, H, SPRITE, nowMs = t + 1500L)
        assertEquals(MotionState.WANDERING, motion.motionState(1))
        assertEquals(MotionState.WANDERING, motion.motionState(2))
        assertFalse(sut.hasActiveConversation(1))
    }

    @Test
    fun sleepingReceiverIsNotStoppedButSenderStillApproaches() {
        val motion = FakeMotion(W, H)
        val sut = SpeakToMovementController(motion, positionProvider = motion::posOf)
        motion.place(1, 0.05f, 0.05f)
        motion.place(2, 0.9f, 0.9f) // sleeping receiver stays WANDERING-state in fake (i.e. not forced STOPPED)

        sut.onSpeakTo(1, SpeakToMovementController.SpeakToTarget.Entity(2), CharacterState.SLEEPING, W, H)

        // Receiver was NOT stopped (T3-3): the controller skipped stop() for a sleeping receiver.
        assertEquals(MotionState.WANDERING, motion.motionState(2))
        // Sender still has a movement target.
        assertEquals(MotionState.MOVING_TO_TARGET, motion.motionState(1))

        var t = 0L
        repeat(60) { motion.tick(); t += 50; sut.update(W, H, SPRITE, nowMs = t) }
        assertTrue("sender still walks over to sleeping receiver and stops", sut.isSenderArrived(1))
        assertEquals(MotionState.STOPPED, motion.motionState(1))
    }

    @Test
    fun freshSpeakToBeforeGraceCancelsPendingResume() {
        val motion = FakeMotion(W, H)
        val sut = SpeakToMovementController(motion, positionProvider = motion::posOf)
        motion.place(1, 0.05f, 0.05f)
        motion.place(2, 0.9f, 0.9f)
        motion.place(3, 0.2f, 0.9f)

        sut.onSpeakTo(1, SpeakToMovementController.SpeakToTarget.Entity(2), CharacterState.IDLE, W, H)
        sut.onConversationEnding(1, nowMs = 1000L)

        // New speakTo to C cancels the pending resume by replacing the conversation.
        sut.onSpeakTo(1, SpeakToMovementController.SpeakToTarget.Entity(3), CharacterState.IDLE, W, H)

        // Even past the old grace window, sender must not have resumed wander.
        sut.update(W, H, SPRITE, nowMs = 1000L + SpeakToMovementController.RESUME_GRACE_MS + 10L)
        assertTrue(sut.hasActiveConversation(1))
        assertEquals(MotionState.MOVING_TO_TARGET, motion.motionState(1))
    }

    @Test
    fun arrivalRadiusEqualsOneSpriteWidth() {
        val motion = FakeMotion(W, H)
        val sut = SpeakToMovementController(motion, positionProvider = motion::posOf)
        assertEquals(60f, sut.arrivalRadiusPx(60f), 0.0001f)
        assertEquals(
            1.0f,
            SpeakToMovementController.ENTITY_UNIT_SPRITE_WIDTH_MULTIPLIER,
            0.0001f
        )
    }
}
