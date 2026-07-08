package com.hank.clawlive

import com.hank.clawlive.engine.WallpaperLayoutDefaults
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Parity guard (card wallpaper-drag-pin, B1). The live renderer used to fall
 * back to screen-center (0.5, 0.5) for an entity with no custom_pos, while the
 * settings preview/editor used this grid — so a no-custom-pos entity rendered
 * center on the wallpaper but in a grid cell in the editor. Both now resolve a
 * missing position through [WallpaperLayoutDefaults]; these assert it is the
 * grid, NOT the center.
 */
class WallpaperLayoutDefaultsTest {

    @Test
    fun fallbackIsGridNotCenterForMultiEntity() {
        // 4 entities → 2x2 grid; slot 0 is the top-left cell, never screen-center.
        val (x0, y0) = WallpaperLayoutDefaults.resolveBasePositionPercent(0, 4)
        assertTrue("top-left x must be left of center (not 0.5)", x0 < 0.5f)
        assertTrue("top-left y must be above center (not 0.5)", y0 < 0.5f)
    }

    @Test
    fun matchesDocumentedGridFormulaForFourEntities() {
        // cols=2, rows=2, paddingX=0.1, paddingY=0.15 → colStep=0.4, rowStep=0.35
        val (x0, y0) = WallpaperLayoutDefaults.resolveBasePositionPercent(0, 4)
        assertEquals(0.3f, x0, 0.001f)
        assertEquals(0.325f, y0, 0.001f)

        val (x3, y3) = WallpaperLayoutDefaults.resolveBasePositionPercent(3, 4)
        assertEquals(0.7f, x3, 0.001f)
        assertEquals(0.675f, y3, 0.001f)
    }

    @Test
    fun singleEntityCentersHorizontally() {
        val (x, _) = WallpaperLayoutDefaults.resolveBasePositionPercent(0, 1)
        assertEquals(0.5f, x, 0.001f)
    }

    @Test
    fun emptyLayoutFallsBackToCenter() {
        val (x, y) = WallpaperLayoutDefaults.resolveBasePositionPercent(0, 0)
        assertEquals(0.5f, x, 0.001f)
        assertEquals(0.5f, y, 0.001f)
    }
}
