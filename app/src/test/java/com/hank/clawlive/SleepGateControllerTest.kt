package com.hank.clawlive

import com.hank.clawlive.data.model.CharacterState
import com.hank.clawlive.data.model.EntityStatus
import com.hank.clawlive.engine.MotionState
import com.hank.clawlive.engine.SleepGateController
import com.hank.clawlive.engine.WallpaperWanderController
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Walking child T5 — sleep gate unit tests (spec §7).
 * Pure JVM tests; no Android instrumentation required.
 */
class SleepGateControllerTest {

    private fun controller(seed: Int) =
        SleepGateController(WallpaperWanderController(random = Random(seed)))

    @Test
    fun sleepingEntityDoesNotMoveOnWanderTick() {
        val gate = controller(7)
        val entity = EntityStatus(entityId = 1, state = CharacterState.SLEEPING)
        val base = listOf(600f to 650f)

        val first = gate.tick(base, listOf(entity), 1000f, 1000f, enabled = true, nowMs = 0L)
        val after = gate.tick(base, listOf(entity), 1000f, 1000f, enabled = true, nowMs = 8000L)

        assertEquals("sleeping entity stays frozen across ticks", first, after)
        assertFalse(gate.isWalking(1))
        assertTrue(gate.isSleeping(1))
        assertEquals(MotionState.SLEEPING, gate.motionState(1))
    }

    @Test
    fun positionFrozenAcrossManyTicksWhileSleeping() {
        val gate = controller(13)
        val entity = EntityStatus(entityId = 2, state = CharacterState.SLEEPING)
        val base = listOf(420f to 380f)

        var positions = gate.tick(base, listOf(entity), 1000f, 1000f, enabled = true, nowMs = 0L)
        val frozen = positions[0]
        repeat(10) { step ->
            positions = gate.tick(base, listOf(entity), 1000f, 1000f, enabled = true, nowMs = (step + 1) * 1000L)
            assertEquals("x frozen at tick $step", frozen.first, positions[0].first)
            assertEquals("y frozen at tick $step", frozen.second, positions[0].second)
        }
    }

    @Test
    fun wakeReturnsToHomeWithoutAmbientWander() {
        val gate = controller(23)
        val sleepingEntity = EntityStatus(entityId = 3, state = CharacterState.SLEEPING)
        val base = listOf(500f to 500f)

        // Asleep: frozen.
        val asleepA = gate.tick(base, listOf(sleepingEntity), 1000f, 1000f, enabled = true, nowMs = 0L)
        val asleepB = gate.tick(base, listOf(sleepingEntity), 1000f, 1000f, enabled = true, nowMs = 3000L)
        assertEquals(asleepA, asleepB)
        assertTrue(gate.isSleeping(3))

        // Wake: same entityId now IDLE. Conscious walking keeps it at home until a message route arrives.
        val awakeEntity = EntityStatus(entityId = 3, state = CharacterState.IDLE)
        gate.tick(base, listOf(awakeEntity), 1000f, 1000f, enabled = true, nowMs = 4000L)
        val afterWake = gate.tick(base, listOf(awakeEntity), 1000f, 1000f, enabled = true, nowMs = 8000L)

        assertFalse(gate.isSleeping(3))
        assertEquals("woke entity holds its home x", base[0].first, afterWake[0].first)
        assertEquals("woke entity holds its home y", base[0].second, afterWake[0].second)
        assertEquals(MotionState.STOPPED, gate.motionState(3))
    }

    @Test
    fun speakToToSleepingReceiver_receiverStaysPut_senderApproaches() {
        val gate = controller(31)
        val sender = EntityStatus(entityId = 10, state = CharacterState.IDLE)
        val sleepingReceiver = EntityStatus(entityId = 11, state = CharacterState.SLEEPING)
        val base = listOf(200f to 500f, 800f to 500f) // sender left, receiver right

        // Seed both entities into the engine.
        val seeded = gate.tick(base, listOf(sender, sleepingReceiver), 1000f, 1000f, enabled = true, nowMs = 0L)
        val receiverFrozen = seeded[1]

        // Receiver is sleeping → pause request must NOT halt it (returns false, stays put).
        val receiverPaused = gate.requestReceiverPause(sleepingReceiver)
        assertFalse("sleeping receiver does not react to speakTo", receiverPaused)

        // Sender (awake) approaches receiver's screen-% position.
        val approachSet = gate.requestApproach(sender.entityId, sleepingReceiver, 0.8f, 0.5f)
        assertTrue("awake sender takes an approach target", approachSet)
        assertEquals(MotionState.MOVING_TO_TARGET, gate.motionState(sender.entityId))

        // Advance several ticks.
        var positions = seeded
        repeat(6) { step ->
            positions = gate.tick(
                base,
                listOf(sender, sleepingReceiver),
                1000f, 1000f,
                enabled = true,
                nowMs = (step + 1) * 1000L
            )
        }

        // Receiver stayed frozen the entire time.
        assertEquals("sleeping receiver x stayed put", receiverFrozen.first, positions[1].first)
        assertEquals("sleeping receiver y stayed put", receiverFrozen.second, positions[1].second)
        assertEquals(MotionState.SLEEPING, gate.motionState(sleepingReceiver.entityId))

        // Sender moved from its origin toward the receiver.
        assertNotEquals("sender moved toward receiver", seeded[0].first, positions[0].first)
        assertTrue("sender advanced rightward toward receiver", positions[0].first > seeded[0].first)
    }

    @Test
    fun sleepingSenderCannotApproach() {
        val gate = controller(41)
        val sleepingSender = EntityStatus(entityId = 20, state = CharacterState.SLEEPING)
        val receiver = EntityStatus(entityId = 21, state = CharacterState.IDLE)
        val base = listOf(300f to 300f, 700f to 300f)

        gate.tick(base, listOf(sleepingSender, receiver), 1000f, 1000f, enabled = true, nowMs = 0L)

        val approachSet = gate.requestApproach(sleepingSender.entityId, receiver, 0.7f, 0.3f)
        assertFalse("sleeping sender cannot approach", approachSet)
        assertEquals(MotionState.SLEEPING, gate.motionState(sleepingSender.entityId))
    }

    @Test
    fun awakeReceiverHaltsToListen() {
        val gate = controller(53)
        val receiver = EntityStatus(entityId = 30, state = CharacterState.IDLE)
        val base = listOf(500f to 500f)

        gate.tick(base, listOf(receiver), 1000f, 1000f, enabled = true, nowMs = 0L)
        val halted = gate.requestReceiverPause(receiver)

        assertTrue("awake receiver halts in place", halted)
        assertEquals(MotionState.STOPPED, gate.motionState(30))
        assertFalse(gate.isWalking(30))
    }
}
