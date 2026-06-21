package com.hank.clawlive

import com.hank.clawlive.data.model.CharacterState
import com.hank.clawlive.data.model.EntityStatus
import com.hank.clawlive.engine.MotionState
import com.hank.clawlive.engine.WalkFacingDirection
import com.hank.clawlive.engine.WallpaperWanderController
import kotlin.math.abs
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WallpaperWanderControllerTest {
    @Test
    fun idleEntitiesStayAtHomeWithoutConversation() {
        val controller = WallpaperWanderController(random = Random(7))
        val entities = listOf(
            EntityStatus(entityId = 1, state = CharacterState.IDLE),
            EntityStatus(entityId = 2, state = CharacterState.IDLE)
        )
        val base = listOf(250f to 500f, 750f to 500f)

        controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, nowMs = 0L)
        val after = controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, nowMs = 9000L)

        assertEquals(base, after)
        assertFalse(controller.isWalking(1))
        assertFalse(controller.isWalking(2))
        assertEquals(MotionState.STOPPED, controller.motionState(1))
    }

    @Test
    fun speakToConversationMovesSenderAndReceiverTowardCenter() {
        val controller = WallpaperWanderController(random = Random(11))
        val entities = listOf(
            EntityStatus(entityId = 1, state = CharacterState.IDLE),
            EntityStatus(entityId = 2, state = CharacterState.IDLE)
        )
        val base = listOf(150f to 500f, 850f to 500f)

        controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, nowMs = 0L)
        val after = controller.positionsFor(
            base,
            entities,
            1000f,
            1000f,
            enabled = true,
            nowMs = 1000L,
            conversationEntityIds = setOf(1, 2),
            entityUnitPx = 220f
        )

        assertTrue("sender should move right toward center", after[0].first > base[0].first)
        assertTrue("receiver should move left toward center", after[1].first < base[1].first)
        assertTrue(controller.isWalking(1))
        assertTrue(controller.isWalking(2))
        assertEquals(WalkFacingDirection.RIGHT, controller.facingDirection(1))
        assertEquals(WalkFacingDirection.LEFT, controller.facingDirection(2))
    }

    @Test
    fun multiReceiverConversationKeepsOneEntityUnitSpacing() {
        val controller = WallpaperWanderController(targetSpeedPctPerSecond = 1f, random = Random(13))
        val entities = (1..4).map { EntityStatus(entityId = it, state = CharacterState.IDLE) }
        val base = listOf(100f to 500f, 300f to 500f, 700f to 500f, 900f to 500f)

        controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, nowMs = 0L)
        val gathered = controller.positionsFor(
            base,
            entities,
            1000f,
            1000f,
            enabled = true,
            nowMs = 1000L,
            conversationEntityIds = setOf(1, 2, 3, 4),
            entityUnitPx = 180f
        )

        for (i in gathered.indices) {
            for (j in i + 1 until gathered.size) {
                val dx = abs(gathered[i].first - gathered[j].first)
                val dy = abs(gathered[i].second - gathered[j].second)
                assertTrue("entities should not overlap: $i/$j", dx >= 179f || dy >= 179f)
            }
        }
    }

    @Test
    fun entitiesReturnHomeAfterConversationEnds() {
        val controller = WallpaperWanderController(targetSpeedPctPerSecond = 1f, random = Random(17))
        val entities = listOf(
            EntityStatus(entityId = 1, state = CharacterState.IDLE),
            EntityStatus(entityId = 2, state = CharacterState.IDLE)
        )
        val base = listOf(150f to 500f, 850f to 500f)

        controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, nowMs = 0L)
        controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, nowMs = 1000L, conversationEntityIds = setOf(1, 2), entityUnitPx = 220f)
        val returned = controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, nowMs = 2000L)

        assertEquals(base[0].first, returned[0].first, 0.001f)
        assertEquals(base[1].first, returned[1].first, 0.001f)
        assertFalse(controller.isWalking(1))
        assertFalse(controller.isWalking(2))
    }

    @Test
    fun disabledWalkingReturnsBasePositionAndDoesNotWalk() {
        val controller = WallpaperWanderController(random = Random(3))
        val entity = EntityStatus(entityId = 2, state = CharacterState.IDLE)
        val base = listOf(250f to 300f)

        controller.positionsFor(base, listOf(entity), 1000f, 1000f, enabled = true, nowMs = 0L)
        val positions = controller.positionsFor(
            base,
            listOf(entity),
            1000f,
            1000f,
            enabled = false,
            nowMs = 5000L,
            conversationEntityIds = setOf(2)
        )

        assertEquals(base, positions)
        assertFalse(controller.isWalking(2))
    }

    @Test
    fun sleepingEntityDoesNotJoinConversationMotion() {
        val controller = WallpaperWanderController(random = Random(23))
        val entities = listOf(
            EntityStatus(entityId = 1, state = CharacterState.IDLE),
            EntityStatus(entityId = 2, state = CharacterState.SLEEPING)
        )
        val base = listOf(200f to 500f, 800f to 500f)

        val first = controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, nowMs = 0L)
        val after = controller.positionsFor(
            base,
            entities,
            1000f,
            1000f,
            enabled = true,
            nowMs = 1000L,
            conversationEntityIds = setOf(1, 2)
        )

        assertTrue(after[0].first > first[0].first)
        assertEquals(first[1], after[1])
        assertEquals(MotionState.SLEEPING, controller.motionState(2))
    }

    @Test
    fun walkingStateConstantMatchesPetdxDescriptorStateName() {
        assertEquals("WALKING", WallpaperWanderController.WALKING_STATE_ASSET)
    }
}
