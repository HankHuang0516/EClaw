package com.hank.clawlive

import com.hank.clawlive.engine.WallpaperRenderDiagnostics
import com.hank.clawlive.engine.WallpaperRenderDiagnostics.CompanionDrawOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WallpaperRenderDiagnosticsTest {
    @Test
    fun recordsFrameActivityWithoutMessageContent() {
        val diagnostics = WallpaperRenderDiagnostics()

        diagnostics.recordFrame(walkingEntityCount = 2, activeBubbleCount = 1)

        val snapshot = diagnostics.snapshot()
        assertEquals(1, snapshot.framesDrawn)
        assertEquals(2, snapshot.lastWalkingEntityCount)
        assertEquals(1, snapshot.lastActiveBubbleCount)
        assertTrue(snapshot.spritesheetErrorsByEntity.isEmpty())
        assertTrue(snapshot.spritesheetUnsupportedByEntity.isEmpty())
    }

    @Test
    fun repeatedSpritesheetFailuresReduceDecorativeEffectsUntilDrawSucceeds() {
        val diagnostics = WallpaperRenderDiagnostics(reduceEffectsThreshold = 2)

        diagnostics.recordCompanionDraw(7, CompanionDrawOutcome.ERROR)
        assertFalse(diagnostics.shouldReduceEffects(7))

        diagnostics.recordCompanionDraw(7, CompanionDrawOutcome.UNSUPPORTED)
        assertTrue(diagnostics.shouldReduceEffects(7))
        assertTrue(diagnostics.snapshot().reducedEffectsEntityIds.contains(7))

        diagnostics.recordCompanionDraw(7, CompanionDrawOutcome.DRAWN)
        assertFalse(diagnostics.shouldReduceEffects(7))
        assertFalse(diagnostics.snapshot().reducedEffectsEntityIds.contains(7))
    }
}
