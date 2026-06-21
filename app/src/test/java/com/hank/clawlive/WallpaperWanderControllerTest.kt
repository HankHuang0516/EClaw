package com.hank.clawlive

import com.hank.clawlive.data.model.CharacterState
import com.hank.clawlive.data.model.EntityStatus
import com.hank.clawlive.engine.AmbientWanderGoal
import com.hank.clawlive.engine.MotionState
import com.hank.clawlive.engine.WalkFacingDirection
import com.hank.clawlive.engine.WallpaperWanderController
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WallpaperWanderControllerTest {
    @Test
    fun enabledWanderMovesEntityAtSlowSpeed() {
        val controller = WallpaperWanderController(random = Random(7))
        val entity = EntityStatus(entityId = 1, state = CharacterState.IDLE)
        val base = listOf(500f to 500f)

        controller.positionsFor(base, listOf(entity), 1000f, 1000f, enabled = true, nowMs = 0L)
        val after = controller.positionsFor(base, listOf(entity), 1000f, 1000f, enabled = true, nowMs = 4000L)

        assertNotEquals("walking should update x", base[0].first, after[0].first)
        assertNotEquals("walking should update y", base[0].second, after[0].second)
        assertTrue("controller reports walking while moving", controller.isWalking(1))
    }

    @Test
    fun purposefulWanderFirstRetargetMovesTowardCompanion() {
        val controller = WallpaperWanderController(random = Random(41))
        val left = EntityStatus(entityId = 1, state = CharacterState.IDLE)
        val right = EntityStatus(entityId = 2, state = CharacterState.IDLE)
        val entities = listOf(left, right)
        val base = listOf(200f to 500f, 800f to 500f)

        controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, purposeful = true, nowMs = 0L)
        val after = controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, purposeful = true, nowMs = 9000L)

        assertEquals(AmbientWanderGoal.VISIT_COMPANION, controller.ambientGoal(1))
        assertTrue("left companion should head toward the right companion", after[0].first > base[0].first)
    }

    @Test
    fun purposefulWanderCanBeDisabledForClassicRandomMode() {
        val controller = WallpaperWanderController(random = Random(43))
        val left = EntityStatus(entityId = 1, state = CharacterState.IDLE)
        val right = EntityStatus(entityId = 2, state = CharacterState.IDLE)
        val entities = listOf(left, right)
        val base = listOf(200f to 500f, 800f to 500f)

        controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, purposeful = false, nowMs = 0L)
        controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, purposeful = false, nowMs = 9000L)

        assertEquals(AmbientWanderGoal.RANDOM, controller.ambientGoal(1))
    }

    @Test
    fun facingDirectionFollowsHorizontalTargetDirection() {
        val controller = WallpaperWanderController(random = Random(5))
        val entity = EntityStatus(entityId = 1, state = CharacterState.IDLE)
        val base = listOf(500f to 500f)

        controller.positionsFor(base, listOf(entity), 1000f, 1000f, enabled = true, nowMs = 0L)
        controller.setTarget(1, 0.1f, 0.5f)
        controller.positionsFor(base, listOf(entity), 1000f, 1000f, enabled = true, nowMs = 1000L)
        assertEquals(WalkFacingDirection.LEFT, controller.facingDirection(1))

        controller.setTarget(1, 0.9f, 0.5f)
        controller.positionsFor(base, listOf(entity), 1000f, 1000f, enabled = true, nowMs = 2000L)
        assertEquals(WalkFacingDirection.RIGHT, controller.facingDirection(1))
    }

    @Test
    fun disabledWanderReturnsBasePositionAndDoesNotWalk() {
        val controller = WallpaperWanderController(random = Random(3))
        val entity = EntityStatus(entityId = 2, state = CharacterState.IDLE)
        val base = listOf(250f to 300f)

        controller.positionsFor(base, listOf(entity), 1000f, 1000f, enabled = true, nowMs = 0L)
        val positions = controller.positionsFor(base, listOf(entity), 1000f, 1000f, enabled = false, nowMs = 5000L)

        assertEquals(base, positions)
        assertFalse(controller.isWalking(2))
    }

    @Test
    fun sleepingEntityDoesNotMoveEvenWhenEnabled() {
        val controller = WallpaperWanderController(random = Random(11))
        val entity = EntityStatus(entityId = 3, state = CharacterState.SLEEPING)
        val base = listOf(600f to 650f)

        val first = controller.positionsFor(base, listOf(entity), 1000f, 1000f, enabled = true, nowMs = 0L)
        val after = controller.positionsFor(base, listOf(entity), 1000f, 1000f, enabled = true, nowMs = 9000L)

        assertEquals(first, after)
        assertFalse(controller.isWalking(3))
    }

    @Test
    fun wanderStaysInsideSafeWallpaperBounds() {
        val controller = WallpaperWanderController(random = Random(23))
        val entity = EntityStatus(entityId = 4, state = CharacterState.IDLE)
        var positions = listOf(1f to 1f)

        repeat(20) { step ->
            positions = controller.positionsFor(positions, listOf(entity), 1000f, 1000f, enabled = true, nowMs = step * 1000L)
            val (x, y) = positions[0]
            assertTrue("x in safe bounds: $x", x in 80f..920f)
            assertTrue("y in safe bounds: $y", y in 120f..820f)
        }
    }

    @Test
    fun walkingStateConstantMatchesPetdxDescriptorStateName() {
        assertEquals("WALKING", WallpaperWanderController.WALKING_STATE_ASSET)
    }

    @Test
    fun motionControllerTargetMovesInScreenPercentAndStopsOnArrival() {
        val controller = WallpaperWanderController(random = Random(31))
        val entity = EntityStatus(entityId = 5, state = CharacterState.IDLE)
        val base = listOf(500f to 500f)
        var arrived = false

        controller.positionsFor(base, listOf(entity), 1000f, 1000f, enabled = true, nowMs = 0L)
        controller.setTarget(5, 0.8f, 0.5f) { arrived = true }

        var positions = base
        repeat(4) { step ->
            positions = controller.positionsFor(
                base,
                listOf(entity),
                1000f,
                1000f,
                enabled = true,
                nowMs = (step + 1) * 1000L
            )
        }

        assertTrue(arrived)
        assertEquals(MotionState.STOPPED, controller.motionState(5))
        assertEquals(800f, positions[0].first, 0.001f)
        assertEquals(500f, positions[0].second, 0.001f)
    }

    @Test
    fun stopAndResumeExposeMotionStateForFollowOnCards() {
        val controller = WallpaperWanderController(random = Random(37))
        val entity = EntityStatus(entityId = 6, state = CharacterState.IDLE)
        val base = listOf(500f to 500f)

        controller.positionsFor(base, listOf(entity), 1000f, 1000f, enabled = true, nowMs = 0L)
        controller.stop(6)

        assertEquals(MotionState.STOPPED, controller.motionState(6))
        assertFalse(controller.isWalking(6))

        controller.resumeWander(6)

        assertEquals(MotionState.WANDERING, controller.motionState(6))
    }
}
