package com.hank.clawlive

import com.hank.clawlive.data.model.CharacterState
import com.hank.clawlive.data.model.EntityStatus
import com.hank.clawlive.engine.WallpaperInteractionController
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WallpaperInteractionControllerTest {
    @Test
    fun collisionTriggersEffectAndBounceAway() {
        val controller = WallpaperInteractionController(
            collisionDistancePct = 0.2f,
            cooldownMs = 1_000L,
            effectDurationMs = 1_000L
        )
        val entities = listOf(
            EntityStatus(entityId = 1, state = CharacterState.IDLE),
            EntityStatus(entityId = 2, state = CharacterState.IDLE)
        )
        val positions = listOf(500f to 500f, 540f to 500f)

        val triggered = controller.apply(
            positions = positions,
            entities = entities,
            width = 1000f,
            height = 1000f,
            enabled = true,
            nowMs = 0L
        )
        assertEquals(1, triggered.effects.size)

        val bounced = controller.apply(
            positions = positions,
            entities = entities,
            width = 1000f,
            height = 1000f,
            enabled = true,
            nowMs = 250L
        )
        assertEquals(1, bounced.effects.size)
        assertTrue("first entity should bounce left", bounced.positions[0].first < positions[0].first)
        assertTrue("second entity should bounce right", bounced.positions[1].first > positions[1].first)
        assertTrue("effect should be visible mid-pulse", bounced.effects.first().alpha(250L) > 0f)
    }

    @Test
    fun disabledOrSleepingEntitiesDoNotInteract() {
        val controller = WallpaperInteractionController(collisionDistancePct = 0.2f)
        val positions = listOf(500f to 500f, 540f to 500f)
        val awake = listOf(
            EntityStatus(entityId = 1, state = CharacterState.IDLE),
            EntityStatus(entityId = 2, state = CharacterState.IDLE)
        )
        val sleeping = listOf(
            EntityStatus(entityId = 1, state = CharacterState.IDLE),
            EntityStatus(entityId = 2, state = CharacterState.SLEEPING)
        )

        val disabled = controller.apply(positions, awake, 1000f, 1000f, enabled = false, nowMs = 0L)
        assertEquals(positions, disabled.positions)
        assertEquals(0, disabled.effects.size)

        val blocked = controller.apply(positions, sleeping, 1000f, 1000f, enabled = true, nowMs = 0L)
        assertEquals(0, blocked.effects.size)
    }
}
