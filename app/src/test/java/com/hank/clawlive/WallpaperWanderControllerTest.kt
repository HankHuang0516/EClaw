package com.hank.clawlive

import com.hank.clawlive.data.model.CharacterState
import com.hank.clawlive.data.model.EntityStatus
import com.hank.clawlive.data.model.WalkActionConfig
import com.hank.clawlive.engine.MotionState
import com.hank.clawlive.engine.WalkFacingDirection
import com.hank.clawlive.engine.WallpaperWanderController
import kotlin.math.abs
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
    fun freeWalkingRoamsAwayFromHomeWhenConsciousModeOff() {
        // 行走功能 (free walking / ambient): with conscious mode OFF (purposeful = false)
        // entities must roam continuously, not stay frozen at their home positions.
        // Regression guard for the #3617 wiring that left advance() unreachable.
        val controller = WallpaperWanderController(random = Random(5))
        val entities = listOf(
            EntityStatus(entityId = 1, state = CharacterState.IDLE),
            EntityStatus(entityId = 2, state = CharacterState.IDLE)
        )
        val base = listOf(250f to 500f, 750f to 500f)

        controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, purposeful = false, nowMs = 0L)
        var maxDisplacement = 0f
        var t = 0L
        repeat(60) {
            t += 500L
            val pos = controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, purposeful = false, nowMs = t)
            for (i in pos.indices) {
                val dx = pos[i].first - base[i].first
                val dy = pos[i].second - base[i].second
                maxDisplacement = maxOf(maxDisplacement, kotlin.math.hypot(dx.toDouble(), dy.toDouble()).toFloat())
            }
        }

        assertTrue(
            "free walking (conscious OFF) must roam away from home, got max=$maxDisplacement",
            maxDisplacement > 20f
        )
    }

    @Test
    fun consciousModeKeepsEntitiesHomeWithoutConversation() {
        // 有意識的行走 (conscious / event-only, purposeful = true): entities idle at home
        // and never ambient-roam without a chat event.
        val controller = WallpaperWanderController(random = Random(5))
        val entities = listOf(EntityStatus(entityId = 1, state = CharacterState.IDLE))
        val base = listOf(250f to 500f)

        controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, purposeful = true, nowMs = 0L)
        var t = 0L
        repeat(60) {
            t += 500L
            val pos = controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, purposeful = true, nowMs = t)
            assertEquals("conscious mode must stay at home x", base[0].first, pos[0].first, 0.001f)
            assertEquals("conscious mode must stay at home y", base[0].second, pos[0].second, 0.001f)
        }
    }

    @Test
    fun freeWalkingHoldsPositionDuringRandomActionAndRoamsBetween() {
        // 行走功能 (free walking): every 10-30s the entity performs a ~3s stationary random
        // action — during that window its position MUST NOT change (it freezes while the
        // gesture plays), and it MUST roam (advance) between actions.
        // Pre-fix bug: the pause was armed only on arrival, which the 0.04/s wander almost
        // never reached before the 3-8s retarget, so the entity moved nonstop and never held.
        val controller = WallpaperWanderController(random = Random(5))
        val entities = listOf(EntityStatus(entityId = 1, state = CharacterState.IDLE))
        val base = listOf(250f to 500f)

        controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, purposeful = false, nowMs = 0L)
        var t = 0L
        var prev: Pair<Float, Float>? = null
        var sawActionHold = false
        var sawRoamMove = false
        repeat(400) { // 40s at 100ms ticks -> at least one 10-30s action cadence
            t += 100L
            val pos = controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, purposeful = false, nowMs = t)[0]
            val acting = controller.isPerformingAction(1)
            val previous = prev
            if (previous != null) {
                val moved = pos.first != previous.first || pos.second != previous.second
                if (acting) {
                    assertFalse("position must NOT change during a stationary random action (t=$t)", moved)
                    sawActionHold = true
                } else if (moved) {
                    sawRoamMove = true
                }
            }
            prev = pos
        }

        assertTrue("expected at least one stationary action window within 40s", sawActionHold)
        assertTrue("entity must roam (advance) between actions", sawRoamMove)
    }

    @Test
    fun freeWalkingRandomActionCadenceIsIndependentPerEntityAndWithinRange() {
        val controller = WallpaperWanderController(random = Random(19))
        val entities = listOf(
            EntityStatus(entityId = 1, state = CharacterState.IDLE),
            EntityStatus(entityId = 2, state = CharacterState.IDLE)
        )
        val base = listOf(250f to 500f, 750f to 500f)
        val actionStarts = mutableMapOf<Int, MutableList<Long>>(
            1 to mutableListOf(),
            2 to mutableListOf()
        )
        val wasActing = mutableMapOf(1 to false, 2 to false)

        controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, purposeful = false, nowMs = 0L)
        var t = 0L
        repeat(700) {
            t += 100L
            controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, purposeful = false, nowMs = t)
            entities.forEach { entity ->
                val acting = controller.isPerformingAction(entity.entityId)
                if (acting && wasActing[entity.entityId] == false) {
                    actionStarts.getValue(entity.entityId).add(t)
                }
                wasActing[entity.entityId] = acting
            }
        }

        val first = actionStarts.getValue(1)
        val second = actionStarts.getValue(2)
        assertTrue("entity 1 should perform at least two actions", first.size >= 2)
        assertTrue("entity 2 should perform at least two actions", second.size >= 2)
        assertNotEquals("entities should not share the same first action time", first.first(), second.first())
        (first.zipWithNext() + second.zipWithNext()).forEach { (prev, next) ->
            val delta = next - prev
            assertTrue("action interval should be >= 9.9s with tick rounding, got $delta", delta >= 9_900L)
            assertTrue("action interval should be <= 30.1s with tick rounding, got $delta", delta <= 30_100L)
        }
    }

    @Test
    fun walkConfigFiltersNegativeActionsBeforeRandomSelection() {
        val controller = WallpaperWanderController(random = Random(23))
        val entities = listOf(EntityStatus(entityId = 1, state = CharacterState.IDLE))
        val base = listOf(250f to 500f)
        val config = WalkActionConfig(
            weights = mapOf("fail" to 100f),
            allowNegative = false,
            negativeActions = listOf("fail", "sad", "sick", "angry")
        )

        controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, purposeful = false, nowMs = 0L)
        var actionKey: String? = null
        var t = 0L
        repeat(310) {
            t += 100L
            controller.positionsFor(
                base,
                entities,
                1000f,
                1000f,
                enabled = true,
                purposeful = false,
                nowMs = t,
                walkActionConfigsByEntity = mapOf(1 to config)
            )
            if (controller.isPerformingAction(1) && actionKey == null) {
                actionKey = controller.actionStateKey(1)
            }
        }

        assertTrue("expected an action inside the 30s max interval", actionKey != null)
        assertNotEquals("failed", actionKey)
    }

    @Test
    fun walkConfigAllowsNegativeActionsWhenEntityOptsIn() {
        val controller = WallpaperWanderController(random = Random(29))
        val entities = listOf(EntityStatus(entityId = 1, state = CharacterState.IDLE))
        val base = listOf(250f to 500f)
        val config = WalkActionConfig(
            weights = mapOf("fail" to 1f),
            allowNegative = true,
            negativeActions = listOf("fail", "sad", "sick", "angry")
        )

        controller.positionsFor(base, entities, 1000f, 1000f, enabled = true, purposeful = false, nowMs = 0L)
        var actionKey: String? = null
        var t = 0L
        repeat(310) {
            t += 100L
            controller.positionsFor(
                base,
                entities,
                1000f,
                1000f,
                enabled = true,
                purposeful = false,
                nowMs = t,
                walkActionConfigsByEntity = mapOf(1 to config)
            )
            if (controller.isPerformingAction(1) && actionKey == null) {
                actionKey = controller.actionStateKey(1)
            }
        }

        assertEquals("failed", actionKey)
    }

    @Test
    fun walkingStateConstantMatchesPetdxDescriptorStateName() {
        assertEquals("WALKING", WallpaperWanderController.WALKING_STATE_ASSET)
    }

    @Test
    fun pinnedEntityStaysExactlyAtBaseAcrossManyTicksEvenInFreeWalking() {
        // HARD PIN (owner decision): a pinned entity must NOT drift or retarget,
        // even with free walking (purposeful = false) ON — the mode that
        // otherwise roams (see freeWalkingRoamsAwayFromHome). The un-pinned peer
        // is left free. Fails on old code (no pinnedEntityIds suppression).
        val controller = WallpaperWanderController(random = Random(5))
        val entities = listOf(
            EntityStatus(entityId = 1, state = CharacterState.IDLE),
            EntityStatus(entityId = 2, state = CharacterState.IDLE)
        )
        val base = listOf(250f to 500f, 750f to 500f)

        controller.positionsFor(
            base, entities, 1000f, 1000f,
            enabled = true, purposeful = false, nowMs = 0L, pinnedEntityIds = setOf(1)
        )
        var t = 0L
        repeat(120) {
            t += 500L
            val pos = controller.positionsFor(
                base, entities, 1000f, 1000f,
                enabled = true, purposeful = false, nowMs = t, pinnedEntityIds = setOf(1)
            )
            assertEquals("pinned entity must hold base x", base[0].first, pos[0].first, 0.0001f)
            assertEquals("pinned entity must hold base y", base[0].second, pos[0].second, 0.0001f)
        }
        assertFalse("pinned entity never walks", controller.isWalking(1))
        assertEquals(MotionState.STOPPED, controller.motionState(1))
    }

    @Test
    fun pinnedEntityIgnoresConversationGatherWhilePeerStillGathers() {
        // A pinned entity is fully stationary; it does NOT join a conversation
        // gather, but an un-pinned peer in the same conversation still moves.
        val controller = WallpaperWanderController(random = Random(11))
        val entities = listOf(
            EntityStatus(entityId = 1, state = CharacterState.IDLE),
            EntityStatus(entityId = 2, state = CharacterState.IDLE)
        )
        val base = listOf(150f to 500f, 850f to 500f)

        controller.positionsFor(
            base, entities, 1000f, 1000f,
            enabled = true, nowMs = 0L, pinnedEntityIds = setOf(1)
        )
        val after = controller.positionsFor(
            base, entities, 1000f, 1000f,
            enabled = true, nowMs = 1000L,
            conversationEntityIds = setOf(1, 2), entityUnitPx = 220f, pinnedEntityIds = setOf(1)
        )

        assertEquals("pinned sender stays put", base[0].first, after[0].first, 0.0001f)
        assertEquals("pinned sender stays put (y)", base[0].second, after[0].second, 0.0001f)
        assertTrue("un-pinned receiver still gathers toward center", after[1].first < base[1].first)
    }
}
