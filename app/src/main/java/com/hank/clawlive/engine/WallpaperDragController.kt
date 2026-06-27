package com.hank.clawlive.engine

import kotlin.math.hypot

/**
 * Pure-Kotlin state machine for the LIVE wallpaper drag-to-reposition (HARD PIN)
 * gesture. The WallpaperService.Engine.onTouchEvent is thin glue over this so
 * the hit-test / long-press / drag / commit decisions are unit-testable without
 * an emulator (the Engine inner class itself is not instantiable in JVM tests).
 *
 * Gesture contract (owner decision: dropped position = HARD PIN):
 *  - ACTION_DOWN on (or near) a rendered entity arms a long-press. A short tap
 *    that lifts before the long-press elapses is NOT a drag (the Engine still
 *    runs its tap=wake behavior).
 *  - Moving beyond the touch slop BEFORE the long-press fires cancels the
 *    pending drag (it was a home-screen page swipe), and the gesture is not
 *    consumed.
 *  - Once the long-press fires the entity enters DRAG: every move follows the
 *    finger; on lift the drop point is persisted as the entity's pinned
 *    custom position.
 */
class WallpaperDragController {

    private enum class Phase { IDLE, PENDING, DRAGGING }

    private var phase = Phase.IDLE
    private var entityId = -1
    private var downX = 0f
    private var downY = 0f
    private var curX = 0f
    private var curY = 0f

    val isDragging: Boolean get() = phase == Phase.DRAGGING

    /** Entity currently being dragged, or null when not dragging. */
    val draggingEntityId: Int? get() = if (phase == Phase.DRAGGING) entityId else null

    /** Result of a pointer-down: did it land on a draggable entity? */
    data class DownResult(val hitEntity: Boolean, val entityId: Int)

    /** Outcome of a move event. */
    sealed class MoveResult {
        /** IDLE, or PENDING still within slop — caller does nothing. */
        object Ignored : MoveResult()
        /** PENDING exceeded slop (page swipe) — caller cancels the long-press timer. */
        object PendingCancelled : MoveResult()
        /** DRAGGING — caller redraws the entity following the finger. */
        data class Drag(val entityId: Int, val x: Float, val y: Float) : MoveResult()
    }

    /** Emitted on lift after a real drag so the caller can persist the pin. */
    data class DragCommit(val entityId: Int, val xPercent: Float, val yPercent: Float)

    /**
     * Hit-test [rendered] (entityId -> screen px center) for the nearest entity
     * within [hitRadiusPx]; if found, arm a pending drag. Returns whether an
     * entity was hit (the caller should then post a long-press timer + consume).
     */
    fun onDown(
        x: Float,
        y: Float,
        rendered: Map<Int, Pair<Float, Float>>,
        hitRadiusPx: Float
    ): DownResult {
        val hit = nearestEntityWithin(x, y, rendered, hitRadiusPx)
        if (hit == null) {
            phase = Phase.IDLE
            entityId = -1
            return DownResult(false, -1)
        }
        phase = Phase.PENDING
        entityId = hit
        downX = x
        downY = y
        curX = x
        curY = y
        return DownResult(true, hit)
    }

    /**
     * Promote a PENDING press to DRAGGING (the long-press elapsed). Returns the
     * entity id now being dragged, or null if there was nothing pending (e.g. it
     * was cancelled or already lifted).
     */
    fun onLongPress(): Int? {
        if (phase != Phase.PENDING) return null
        phase = Phase.DRAGGING
        return entityId
    }

    /**
     * Process a move. While DRAGGING returns [MoveResult.Drag] with the follow
     * position. While PENDING, a move beyond [slopPx] cancels the pending drag
     * (it was a page swipe) and returns [MoveResult.PendingCancelled]; a small
     * jitter within slop returns [MoveResult.Ignored] and keeps waiting for the
     * long-press. IDLE returns [MoveResult.Ignored].
     */
    fun onMove(x: Float, y: Float, slopPx: Float): MoveResult {
        return when (phase) {
            Phase.DRAGGING -> {
                curX = x
                curY = y
                MoveResult.Drag(entityId, x, y)
            }
            Phase.PENDING -> {
                if (hypot((x - downX).toDouble(), (y - downY).toDouble()) > slopPx) {
                    cancel()
                    MoveResult.PendingCancelled
                } else {
                    MoveResult.Ignored
                }
            }
            Phase.IDLE -> MoveResult.Ignored
        }
    }

    /**
     * Process a lift. After a real drag returns the drop point as percentages so
     * the caller can persist it as the pinned custom_pos; otherwise returns null
     * (the caller runs its tap behavior). Always resets state.
     */
    fun onUp(width: Float, height: Float): DragCommit? {
        val wasDragging = phase == Phase.DRAGGING
        val id = entityId
        val xPx = curX
        val yPx = curY
        cancel()
        if (!wasDragging || id < 0 || width <= 0f || height <= 0f) return null
        return DragCommit(
            entityId = id,
            xPercent = (xPx / width).coerceIn(0.05f, 0.95f),
            yPercent = (yPx / height).coerceIn(0.05f, 0.95f)
        )
    }

    /** Reset to IDLE (cancel a pending/active gesture). */
    fun cancel() {
        phase = Phase.IDLE
        entityId = -1
    }

    private fun nearestEntityWithin(
        x: Float,
        y: Float,
        rendered: Map<Int, Pair<Float, Float>>,
        hitRadiusPx: Float
    ): Int? {
        var bestId: Int? = null
        var bestDist = Float.MAX_VALUE
        for ((id, pos) in rendered) {
            val d = hypot((x - pos.first).toDouble(), (y - pos.second).toDouble()).toFloat()
            if (d <= hitRadiusPx && d < bestDist) {
                bestDist = d
                bestId = id
            }
        }
        return bestId
    }

    companion object {
        const val LONG_PRESS_MS = 400L
        const val DEFAULT_HIT_RADIUS_FACTOR = 0.12f
    }
}
