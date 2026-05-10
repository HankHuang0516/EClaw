package com.hank.clawlive.engine

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import com.hank.clawlive.data.model.CompanionDetail
import com.hank.clawlive.data.repository.CompanionRepository
import timber.log.Timber

/**
 * Spritesheet renderer: picks the row for the current state and the frame
 * index from elapsed time × fps, then blits one frame from the cached
 * spritesheet bitmap into the canvas at the entity's position.
 *
 * Layout convention (extends spec §2.1 stateAssets):
 *   - One row per state, in supportedStates order, top-to-bottom.
 *   - Each frame is `asset.frameWidth` × `asset.frameHeight` (default 128×128).
 *   - `stateAssets[STATE].row` overrides row index; `frames` = frame count.
 *   - `loop:false` clamps to last frame after one cycle (used for EXCITED).
 */
class SpritesheetCompanionDrawer(
    private val repository: CompanionRepository
) {
    private val paint = Paint().apply {
        isFilterBitmap = true
        isAntiAlias = true
    }

    /** Single state-start timestamp shared per draw call lookup, keyed by entity. */
    private val stateStartByEntity = mutableMapOf<Int, Pair<String, Long>>()

    /**
     * Returns true if this entity has a usable spritesheet companion and
     * something was drawn. Returning false lets the renderer fall back to
     * the procedural lobster drawer.
     */
    fun draw(
        canvas: Canvas,
        companion: CompanionDetail,
        entityId: Int,
        currentState: String,
        centerX: Float,
        centerY: Float,
        scale: Float
    ): Boolean {
        val sheet = repository.getSheet(companion.spritesheetUrl()) ?: return false
        val (frameW, frameH) = companion.spritesheetFrameSize()
        if (frameW <= 0 || frameH <= 0) return false

        val supported = companion.supportedStates
        val effectiveState = if (currentState in supported) currentState else "IDLE"
        val hint = companion.stateAsset(effectiveState) ?: return false

        // Row defaults to position in supportedStates if descriptor doesn't pin one.
        val row = if (hint.row > 0) hint.row else supported.indexOf(effectiveState).coerceAtLeast(0)
        val frames = hint.frames.coerceAtLeast(1)
        val fps = hint.fps.coerceAtLeast(1)

        // Reset frame timing on state change so non-looping animations replay.
        val now = System.currentTimeMillis()
        val prev = stateStartByEntity[entityId]
        val stateStart = if (prev?.first == effectiveState) prev.second else now.also {
            stateStartByEntity[entityId] = effectiveState to now
        }

        val elapsed = now - stateStart
        val rawIndex = (elapsed * fps / 1000L).toInt()
        val frameIndex = if (hint.loop) rawIndex % frames else rawIndex.coerceAtMost(frames - 1)

        val srcX = (frameIndex * frameW).coerceAtMost(sheet.width - frameW).coerceAtLeast(0)
        val srcY = (row * frameH).coerceAtMost(sheet.height - frameH).coerceAtLeast(0)

        if (srcX + frameW > sheet.width || srcY + frameH > sheet.height) {
            Timber.w("Spritesheet OOB: sheet=${sheet.width}x${sheet.height} src=($srcX,$srcY)+$frameW x $frameH")
            return false
        }

        // Render at 300×300 px base scaled by `scale` (matches procedural lobster footprint).
        val renderSize = 300f * scale
        val src = Rect(srcX, srcY, srcX + frameW, srcY + frameH)
        val dst = RectF(
            centerX - renderSize / 2f,
            centerY - renderSize / 2f,
            centerX + renderSize / 2f,
            centerY + renderSize / 2f
        )
        canvas.drawBitmap(sheet, src, dst, paint)
        return true
    }
}

/** Internal helper for the procedural path — exposes which params override colors. */
fun proceduralBodyColorOverride(companion: CompanionDetail?): Int? {
    if (companion == null) return null
    val params = companion.proceduralParams()
    val raw = params["bodyColor"]?.takeIf { it.isJsonPrimitive }?.asString ?: return null
    return runCatching { android.graphics.Color.parseColor(raw) }.getOrNull()
}
