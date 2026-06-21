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
    /**
     * Distinct outcomes for one draw call. The renderer uses these to decide
     * whether to fall back to the procedural lobster — only UNSUPPORTED and
     * ERROR do; LOADING means "sheet is being fetched on the IO scope, just
     * skip this paint and the next 33 ms tick will pick it up". Mixing
     * LOADING with the lobster fallback is what produced the post-companion-
     * change flicker reported on 2026-05-12.
     */
    enum class DrawResult { DRAWN, LOADING, UNSUPPORTED, ERROR }

    private val paint = Paint().apply {
        isFilterBitmap = true
        isAntiAlias = true
    }

    /** Single state-start timestamp shared per draw call lookup, keyed by entity. */
    private val stateStartByEntity = mutableMapOf<Int, Pair<String, Long>>()

    /**
     * Renders one spritesheet frame for the entity. Return value tells the
     * renderer how to handle the outcome — see [DrawResult].
     */
    fun draw(
        canvas: Canvas,
        companion: CompanionDetail,
        entityId: Int,
        currentState: String,
        centerX: Float,
        centerY: Float,
        scale: Float,
        facingDirection: WalkFacingDirection = WalkFacingDirection.RIGHT
    ): DrawResult {
        val sheetUrl = companion.spritesheetUrl()
        if (sheetUrl.isNullOrBlank()) return DrawResult.UNSUPPORTED
        // Cache miss on the main thread schedules an async load and returns
        // null this frame. That's LOADING, not failure — falling back to
        // lobster here is the flicker bug.
        val sheet = repository.getSheet(sheetUrl) ?: return DrawResult.LOADING
        val (frameW, frameH) = companion.spritesheetFrameSize()
        if (frameW <= 0 || frameH <= 0) return DrawResult.UNSUPPORTED

        val supported = companion.supportedStates
        val effectiveState = if (currentState in supported) currentState else "IDLE"
        val hint = companion.stateAsset(effectiveState) ?: return DrawResult.UNSUPPORTED
        val animation = companion.spritesheetAnimation(effectiveState)

        // Row defaults to position in supportedStates if descriptor doesn't pin one.
        val row = animation?.row ?: if (hint.row > 0) hint.row else supported.indexOf(effectiveState).coerceAtLeast(0)
        val frameDurations = animation?.frameDurationsMs?.takeIf { it.isNotEmpty() }
            ?: List(hint.frames.coerceAtLeast(1)) { (1000 / hint.fps.coerceAtLeast(1)).coerceAtLeast(1) }
        val frames = frameDurations.size

        // Reset frame timing on state change so non-looping animations replay.
        val now = System.currentTimeMillis()
        val prev = stateStartByEntity[entityId]
        val stateStart = if (prev?.first == effectiveState) prev.second else now.also {
            stateStartByEntity[entityId] = effectiveState to now
        }

        val elapsed = now - stateStart
        val frameIndex = computeFrameIndex(elapsed, frameDurations, hint.loop)

        val srcX = (frameIndex * frameW).coerceAtMost(sheet.width - frameW).coerceAtLeast(0)
        val srcY = (row * frameH).coerceAtMost(sheet.height - frameH).coerceAtLeast(0)

        if (srcX + frameW > sheet.width || srcY + frameH > sheet.height) {
            Timber.w("Spritesheet OOB: sheet=${sheet.width}x${sheet.height} src=($srcX,$srcY)+$frameW x $frameH")
            return DrawResult.ERROR
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
        canvas.save()
        if (facingDirection == WalkFacingDirection.LEFT) {
            canvas.scale(-1f, 1f, centerX, centerY)
        }
        canvas.drawBitmap(sheet, src, dst, paint)
        canvas.restore()
        return DrawResult.DRAWN
    }

    private fun computeFrameIndex(elapsedMs: Long, frameDurationsMs: List<Int>, loop: Boolean): Int {
        val total = frameDurationsMs.sum().coerceAtLeast(1)
        val t = if (loop) {
            ((elapsedMs % total) + total) % total
        } else {
            elapsedMs.coerceAtMost(total.toLong())
        }.toInt()

        var acc = 0
        for (i in frameDurationsMs.indices) {
            acc += frameDurationsMs[i].coerceAtLeast(1)
            if (t < acc) return i
        }
        return frameDurationsMs.lastIndex.coerceAtLeast(0)
    }
}

/** Internal helper for the procedural path — exposes which params override colors. */
fun proceduralBodyColorOverride(companion: CompanionDetail?): Int? {
    if (companion == null) return null
    val params = companion.proceduralParams()
    val raw = params["bodyColor"]?.takeIf { it.isJsonPrimitive }?.asString ?: return null
    return runCatching { android.graphics.Color.parseColor(raw) }.getOrNull()
}
