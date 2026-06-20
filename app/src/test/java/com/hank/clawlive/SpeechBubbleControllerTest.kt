package com.hank.clawlive

import com.hank.clawlive.engine.SpeechBubbleController
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechBubbleControllerTest {

    /** T2-1 (STOPPED) — bubble anchors above a static sprite at the entity coords. */
    @Test
    fun bubbleAnchorsAboveEntityCoords() {
        val controller = SpeechBubbleController()
        controller.show(entityId = 1, text = "hi", nowMs = 0L)

        val placement = controller.placementFor(
            entityId = 1,
            entityXPct = 0.5f,
            entityYPct = 0.5f,
            spriteHeightPct = 0.10f,
            nowMs = 0L
        )

        assertNotNull(placement)
        // anchored at the sprite center X, and ABOVE the sprite center (smaller Y).
        assertEquals(0.5f, placement!!.anchorXPct, 0.0001f)
        assertTrue("bubble should sit above the sprite", placement.anchorYPct < 0.5f)
        assertFalse(placement.flippedBelow)
        assertEquals("hi", placement.text)
    }

    /** T2-2 — bubble follows the entity when the sprite walks (re-anchored each frame). */
    @Test
    fun bubblePositionUpdatesWhenEntityMoves() {
        val controller = SpeechBubbleController()
        controller.show(entityId = 2, text = "walking", nowMs = 0L)

        val before = controller.placementFor(2, 0.2f, 0.5f, 0.10f, nowMs = 100L)!!
        // entity walks to the right and up
        val after = controller.placementFor(2, 0.7f, 0.3f, 0.10f, nowMs = 200L)!!

        assertEquals(0.2f, before.anchorXPct, 0.0001f)
        assertEquals(0.7f, after.anchorXPct, 0.0001f)
        assertTrue("bubble X follows sprite X", after.anchorXPct > before.anchorXPct)
        assertTrue("bubble Y follows sprite Y", after.anchorYPct < before.anchorYPct)
    }

    /** T2-1 lifecycle — bubble expires and is gone after its TTL. */
    @Test
    fun bubbleExpiresAfterTimeout() {
        val controller = SpeechBubbleController(defaultTtlMs = 4_000L)
        controller.show(entityId = 3, text = "x", nowMs = 0L)

        // floor TTL is 2s for a short message; still visible just before.
        assertTrue(controller.isVisible(3, nowMs = 1_999L))
        assertNotNull(controller.placementFor(3, 0.5f, 0.5f, 0.1f, nowMs = 1_999L))

        // after TTL: gone.
        assertFalse(controller.isVisible(3, nowMs = 2_001L))
        assertNull(controller.placementFor(3, 0.5f, 0.5f, 0.1f, nowMs = 2_001L))
        assertEquals(0, controller.activeCount(nowMs = 2_001L))
    }

    /** Reduce-motion / disabled-walk: a static (non-walking) entity still anchors. */
    @Test
    fun staticEntityStillAnchorsWhenWalkDisabled() {
        val controller = SpeechBubbleController()
        controller.show(entityId = 4, text = "still", nowMs = 0L)

        // Same coords across frames (no wander) — bubble must still resolve.
        val first = controller.placementFor(4, 0.4f, 0.6f, 0.10f, nowMs = 0L)!!
        val later = controller.placementFor(4, 0.4f, 0.6f, 0.10f, nowMs = 500L)!!

        assertEquals(first.anchorXPct, later.anchorXPct, 0.0001f)
        assertEquals(first.anchorYPct, later.anchorYPct, 0.0001f)
        assertEquals(0.4f, first.anchorXPct, 0.0001f)
    }

    /** §5.4 — near the top edge the bubble flips below the sprite (tail points up). */
    @Test
    fun bubbleFlipsBelowWhenNearTopEdge() {
        val controller = SpeechBubbleController()
        controller.show(entityId = 5, text = "top", nowMs = 0L)

        val placement = controller.placementFor(
            entityId = 5,
            entityXPct = 0.5f,
            entityYPct = 0.02f, // sprite hugging the top
            spriteHeightPct = 0.10f,
            nowMs = 0L
        )!!

        assertTrue("should flip below near top", placement.flippedBelow)
        assertTrue("flipped bubble sits below the sprite center", placement.anchorYPct > 0.02f)
    }

    /** §5.3 — TTL scales with message length, capped at the default max. */
    @Test
    fun ttlScalesWithMessageLengthAndCaps() {
        val controller = SpeechBubbleController(defaultTtlMs = 8_000L)

        // 600-char message → would be 36s, capped to 8s (T2-4).
        val long = "a".repeat(600)
        controller.show(entityId = 6, text = long, nowMs = 0L)
        assertTrue(controller.isVisible(6, nowMs = 7_999L))
        assertFalse(controller.isVisible(6, nowMs = 8_001L))
    }

    /** §5.3 / O-7 — a new message resets the TTL rather than letting the old one expire. */
    @Test
    fun newMessageResetsTtl() {
        val controller = SpeechBubbleController()
        controller.show(entityId = 7, text = "first", nowMs = 0L)
        // refresh near end of life
        controller.show(entityId = 7, text = "second", nowMs = 1_500L)

        // original would have expired at 2_000L; refreshed one lives to 3_500L.
        assertTrue(controller.isVisible(7, nowMs = 3_000L))
        val placement = controller.placementFor(7, 0.5f, 0.5f, 0.1f, nowMs = 3_000L)!!
        assertEquals("second", placement.text)
    }

    /** Fade alpha ramps from 1.0 to 0.0 across the fade-out window. */
    @Test
    fun alphaRampsDownDuringFadeOut() {
        val controller = SpeechBubbleController(defaultTtlMs = 4_000L, fadeOutMs = 1_000L)
        controller.show(entityId = 8, text = "fade", nowMs = 0L, ttlMsOverride = 4_000L)

        val full = controller.placementFor(8, 0.5f, 0.5f, 0.1f, nowMs = 1_000L)!!
        val mid = controller.placementFor(8, 0.5f, 0.5f, 0.1f, nowMs = 3_500L)!!

        assertEquals("fully opaque while not fading", 1.0f, full.alpha, 0.0001f)
        assertTrue("alpha is ramping down", mid.alpha < 1.0f && mid.alpha > 0.0f)
    }

    /** Blank text clears any existing bubble (no empty bubbles render). */
    @Test
    fun blankTextClearsBubble() {
        val controller = SpeechBubbleController()
        controller.show(entityId = 9, text = "hello", nowMs = 0L)
        assertTrue(controller.isVisible(9, nowMs = 0L))

        controller.show(entityId = 9, text = "   ", nowMs = 100L)
        assertFalse(controller.isVisible(9, nowMs = 100L))
    }
}
