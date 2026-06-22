package com.hank.clawlive

import com.hank.clawlive.engine.ClawRenderer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for [ClawRenderer.shouldFallbackForStuckSpritesheet] — the
 * grace-window decision that fixes the v1.1.5 pure-black regression
 * (card_f9b2cc2d).
 *
 * Root cause: a spritesheet companion whose bitmap is missing from the cache
 * returns DrawResult.LOADING, which paints nothing this frame. After a cold
 * engine (re)create (the descriptor is restored from snapshot but the sheet is
 * not) or a cache eviction / failed reload, that LOADING persists for many
 * ticks — so every spritesheet entity stays invisible and, with no custom
 * background (canvas is solid black), the wallpaper is pure black with no text
 * and no exception. The fix keeps a short no-paint grace for genuinely brief
 * loads (no flash to the default lobster, preserving card_9e52c7b) but, once
 * LOADING has persisted past the grace, draws the procedural fallback so an
 * entity is never invisible for more than the grace window.
 *
 * These run on the host JVM — the decision is a pure Long-arithmetic function
 * on the companion object, with no Android dependencies.
 */
class SpritesheetLoadingGraceTest {

    @Test
    fun `brief loading within grace does not fall back`() {
        val start = 10_000L
        // One 33ms draw tick, and ~half the grace: still painting nothing so a
        // quick disk-decode load never flashes the procedural lobster.
        assertFalse(ClawRenderer.shouldFallbackForStuckSpritesheet(start, start + 33))
        assertFalse(ClawRenderer.shouldFallbackForStuckSpritesheet(start, start + 374))
    }

    @Test
    fun `sustained loading past grace falls back to procedural`() {
        val start = 10_000L
        assertTrue(
            ClawRenderer.shouldFallbackForStuckSpritesheet(
                start,
                start + ClawRenderer.SPRITESHEET_LOADING_GRACE_MS + 1
            )
        )
        // The 25-second field report (Hank's repro) must fall back, not stay black.
        assertTrue(ClawRenderer.shouldFallbackForStuckSpritesheet(start, start + 25_000))
    }

    @Test
    fun `grace boundary is inclusive`() {
        val start = 0L
        assertTrue(
            ClawRenderer.shouldFallbackForStuckSpritesheet(
                start + 1, // since>0 so it is tracked
                1 + ClawRenderer.SPRITESHEET_LOADING_GRACE_MS
            )
        )
        assertFalse(
            ClawRenderer.shouldFallbackForStuckSpritesheet(
                start + 1,
                ClawRenderer.SPRITESHEET_LOADING_GRACE_MS // exactly grace-1 elapsed
            )
        )
    }

    @Test
    fun `untracked entity (since=0) never falls back`() {
        // since==0 means "not currently tracked"; never treat epoch 0 as an
        // ancient loading-start that would force an immediate (wrong) fallback.
        assertFalse(ClawRenderer.shouldFallbackForStuckSpritesheet(0L, 10_000L))
    }

    @Test
    fun `grace window is the documented 750ms`() {
        assertEquals(750L, ClawRenderer.SPRITESHEET_LOADING_GRACE_MS)
    }
}
