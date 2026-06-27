package com.hank.clawlive

import com.hank.clawlive.engine.WallpaperDragController
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the live-wallpaper drag-to-reposition (HARD PIN) state machine
 * (card wallpaper-drag-pin, A). The WallpaperService.Engine.onTouchEvent is thin
 * glue over this controller, so the hit-test / long-press / drag / commit
 * decisions are testable without an emulator. The pre-fix engine had NO drag at
 * all (only ACTION_UP = wake), so this whole behavior is new.
 */
class WallpaperDragControllerTest {

    // entityId -> rendered screen-px center
    private val rendered = mapOf(1 to (500f to 500f), 2 to (200f to 800f))

    @Test
    fun longPressThenDragPersistsDropPointAsPin() {
        val c = WallpaperDragController()
        val down = c.onDown(505f, 505f, rendered, hitRadiusPx = 120f)
        assertTrue("press landed on an entity", down.hitEntity)
        assertEquals(1, down.entityId)
        assertFalse("a short press is not yet a drag", c.isDragging)

        assertEquals("long-press promotes to drag", 1, c.onLongPress())
        assertTrue(c.isDragging)
        assertEquals(1, c.draggingEntityId)

        val move = c.onMove(600f, 700f, slopPx = 20f)
        assertTrue(move is WallpaperDragController.MoveResult.Drag)

        // Drop on a 1000x1000 surface → percentage drop point.
        val commit = c.onUp(1000f, 1000f)
        assertNotNull("a real drag commits a pin", commit)
        assertEquals(1, commit!!.entityId)
        assertEquals(0.6f, commit.xPercent, 0.0001f)
        assertEquals(0.7f, commit.yPercent, 0.0001f)
        assertFalse("gesture resets after lift", c.isDragging)
    }

    @Test
    fun shortTapDoesNotCommitPin() {
        val c = WallpaperDragController()
        c.onDown(505f, 505f, rendered, 120f)
        // No long-press; lift immediately (this is a tap = wake in the engine).
        val commit = c.onUp(1000f, 1000f)
        assertNull("a tap without long-press must not pin", commit)
        assertFalse(c.isDragging)
    }

    @Test
    fun moveBeyondSlopBeforeLongPressCancelsPending() {
        val c = WallpaperDragController()
        c.onDown(505f, 505f, rendered, 120f)
        // 55px move > 20px slop → page-swipe, cancel the pending drag.
        val r = c.onMove(560f, 505f, slopPx = 20f)
        assertEquals(WallpaperDragController.MoveResult.PendingCancelled, r)
        assertNull("long-press is a no-op after cancel", c.onLongPress())
        assertFalse(c.isDragging)
        assertNull(c.onUp(1000f, 1000f))
    }

    @Test
    fun smallJitterWithinSlopKeepsPending() {
        val c = WallpaperDragController()
        c.onDown(505f, 505f, rendered, 120f)
        val r = c.onMove(510f, 508f, slopPx = 20f) // < slop
        assertEquals(WallpaperDragController.MoveResult.Ignored, r)
        // long-press can still fire — the press is still pending.
        assertEquals(1, c.onLongPress())
        assertTrue(c.isDragging)
    }

    @Test
    fun touchMissingAllEntitiesDoesNotArm() {
        val c = WallpaperDragController()
        val down = c.onDown(900f, 100f, rendered, hitRadiusPx = 50f)
        assertFalse(down.hitEntity)
        assertNull(c.onLongPress())
        assertFalse(c.isDragging)
    }

    @Test
    fun hitTestPicksNearestEntityWithinRadius() {
        val c = WallpaperDragController()
        // Near entity 2 (200,800).
        val down = c.onDown(220f, 790f, rendered, hitRadiusPx = 120f)
        assertTrue(down.hitEntity)
        assertEquals(2, down.entityId)
    }

    @Test
    fun cancelDuringDragProducesNoCommit() {
        val c = WallpaperDragController()
        c.onDown(505f, 505f, rendered, 120f)
        c.onLongPress()
        c.onMove(600f, 700f, 20f)
        c.cancel()
        assertFalse(c.isDragging)
        assertNull(c.onUp(1000f, 1000f))
    }
}
