package com.hank.clawlive.engine

import kotlin.math.ceil
import kotlin.math.sqrt

/**
 * Single source of truth for where an entity sits when it has NO saved custom
 * position. Both the live wallpaper renderer (ClawRenderer) and the settings
 * preview/editor Views (WallpaperPreviewView / LayoutEditorView) MUST resolve a
 * missing custom_pos through here so the configured-vs-displayed position stays
 * in parity.
 *
 * Historic desync (card wallpaper-drag-pin, B1): the live renderer fell back to
 * screen-center (0.5, 0.5) when an entity had no custom_pos, while the preview
 * used this grid — so an entity with no saved position rendered center on the
 * wallpaper but in a grid cell in the editor. Both now call
 * [resolveBasePositionPercent], so the fallback is identical by construction.
 *
 * Returns percentage coordinates in [0,1]; multiply by canvas width/height for
 * pixels. Pure Kotlin (no Android deps) so it is unit-testable.
 */
object WallpaperLayoutDefaults {

    /**
     * Default position for an entity by its slot [index] within a layout of
     * [count] entities. Uses ceil(sqrt(n)) columns; the last (possibly short)
     * row is horizontally centered.
     */
    fun resolveBasePositionPercent(index: Int, count: Int): Pair<Float, Float> {
        if (count <= 0) return 0.5f to 0.5f
        val cols = ceil(sqrt(count.toDouble())).toInt().coerceAtLeast(1)
        val rows = ceil(count.toDouble() / cols).toInt()
        val paddingX = 0.1f
        val paddingY = 0.15f
        val usableW = 1f - 2 * paddingX
        val usableH = 1f - 2 * paddingY
        val colStep = usableW / cols
        val rowStep = usableH / rows
        val row = index / cols
        val col = index % cols
        val itemsInLastRow = count - (rows - 1) * cols
        val x = if (row == rows - 1 && itemsInLastRow < cols) {
            paddingX + (usableW - itemsInLastRow * colStep) / 2f + col * colStep + colStep / 2f
        } else {
            paddingX + col * colStep + colStep / 2f
        }
        val y = paddingY + row * rowStep + rowStep / 2f
        return x to y
    }
}
