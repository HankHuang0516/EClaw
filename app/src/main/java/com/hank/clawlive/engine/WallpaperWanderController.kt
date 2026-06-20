package com.hank.clawlive.engine

import android.graphics.PointF
import com.hank.clawlive.data.model.CharacterState
import com.hank.clawlive.data.model.EntityStatus
import kotlin.math.hypot
import kotlin.math.min
import kotlin.random.Random

interface MotionController {
    fun position(entityId: Int): PointF
    fun motionState(entityId: Int): MotionState
    fun setTarget(entityId: Int, xPct: Float, yPct: Float, onArrive: (() -> Unit)? = null)
    fun stop(entityId: Int)
    fun clearStop(entityId: Int)
    fun resumeWander(entityId: Int)
}

enum class MotionState {
    WANDERING,
    MOVING_TO_TARGET,
    STOPPED,
    SLEEPING
}

/**
 * Lightweight per-device wallpaper wander engine.
 *
 * The controller keeps only in-memory screen-percent positions/targets; the persisted
 * switch lives in LayoutPreferences so the feature remains device-level, not
 * per-entity. It is deterministic enough for tests via injectable time/random,
 * but cheap enough for the wallpaper draw loop (O(entityCount), no allocations
 * beyond the returned position list).
 */
class WallpaperWanderController(
    private val wanderSpeedPctPerSecond: Float = DEFAULT_WANDER_SPEED_PCT_PER_SECOND,
    private val targetSpeedPctPerSecond: Float = DEFAULT_TARGET_SPEED_PCT_PER_SECOND,
    private val random: Random = Random.Default
) : MotionController {
    private data class WanderState(
        var xPct: Float,
        var yPct: Float,
        var targetXPct: Float,
        var targetYPct: Float,
        var lastUpdateMs: Long,
        var idleUntilMs: Long,
        var retargetAtMs: Long,
        var moving: Boolean,
        var motionState: MotionState,
        var onArrive: (() -> Unit)? = null
    )

    private val states = mutableMapOf<Int, WanderState>()

    fun reset() {
        states.clear()
    }

    fun isWalking(entityId: Int): Boolean = states[entityId]?.moving == true

    override fun position(entityId: Int): PointF {
        val state = states[entityId] ?: return PointF(0.5f, 0.5f)
        return PointF(state.xPct, state.yPct)
    }

    override fun motionState(entityId: Int): MotionState {
        return states[entityId]?.motionState ?: MotionState.STOPPED
    }

    override fun setTarget(entityId: Int, xPct: Float, yPct: Float, onArrive: (() -> Unit)?) {
        val state = commandState(entityId)
        state.targetXPct = xPct.coerceIn(MIN_X_PCT, MAX_X_PCT)
        state.targetYPct = yPct.coerceIn(MIN_Y_PCT, MAX_Y_PCT)
        state.motionState = MotionState.MOVING_TO_TARGET
        state.moving = false
        state.onArrive = onArrive
    }

    override fun stop(entityId: Int) {
        val state = commandState(entityId)
        state.motionState = MotionState.STOPPED
        state.moving = false
        state.onArrive = null
    }

    override fun clearStop(entityId: Int) {
        val state = states[entityId] ?: return
        if (state.motionState == MotionState.STOPPED) {
            state.motionState = MotionState.WANDERING
            state.idleUntilMs = 0L
        }
    }

    override fun resumeWander(entityId: Int) {
        val state = commandState(entityId)
        state.motionState = MotionState.WANDERING
        state.moving = false
        state.idleUntilMs = 0L
        state.onArrive = null
    }

    fun positionsFor(
        basePositions: List<Pair<Float, Float>>,
        entities: List<EntityStatus>,
        width: Float,
        height: Float,
        enabled: Boolean,
        nowMs: Long = System.currentTimeMillis()
    ): List<Pair<Float, Float>> {
        if (!enabled || width <= 0f || height <= 0f) {
            states.clear()
            return basePositions
        }

        val activeIds = entities.map { it.entityId }.toSet()
        states.keys.toList().forEach { id -> if (id !in activeIds) states.remove(id) }

        return entities.mapIndexed { index, entity ->
            val base = basePositions.getOrNull(index) ?: (width / 2f to height / 2f)
            if (entity.state == CharacterState.SLEEPING) {
                val state = stateFor(entity.entityId, base, width, height, nowMs)
                state.motionState = MotionState.SLEEPING
                state.moving = false
                state.xPct * width to state.yPct * height
            } else {
                advance(entity.entityId, base, width, height, nowMs)
            }
        }
    }

    private fun advance(
        entityId: Int,
        base: Pair<Float, Float>,
        width: Float,
        height: Float,
        nowMs: Long
    ): Pair<Float, Float> {
        val state = stateFor(entityId, base, width, height, nowMs)
        if (state.motionState == MotionState.SLEEPING) {
            state.motionState = MotionState.WANDERING
            state.idleUntilMs = 0L
        }

        val dtSeconds = ((nowMs - state.lastUpdateMs).coerceIn(0L, 1000L)) / 1000f
        state.lastUpdateMs = nowMs

        when (state.motionState) {
            MotionState.STOPPED,
            MotionState.SLEEPING -> {
                state.moving = false
                return state.xPct * width to state.yPct * height
            }
            MotionState.MOVING_TO_TARGET -> {
                val arrived = moveTowardTarget(state, width, height, targetSpeedPctPerSecond, dtSeconds)
                if (arrived) {
                    state.motionState = MotionState.STOPPED
                    val callback = state.onArrive
                    state.onArrive = null
                    callback?.invoke()
                }
                return state.xPct * width to state.yPct * height
            }
            MotionState.WANDERING -> Unit
        }

        if (nowMs < state.idleUntilMs) {
            state.moving = false
            return state.xPct * width to state.yPct * height
        }

        if (nowMs >= state.retargetAtMs) {
            retarget(state, nowMs)
        }

        if (moveTowardTarget(state, width, height, wanderSpeedPctPerSecond, dtSeconds)) {
            state.moving = false
            state.idleUntilMs = nowMs + randomLong(0L, MAX_IDLE_MS)
            retarget(state, state.idleUntilMs)
        }

        coerceToSafeBounds(state)
        return state.xPct * width to state.yPct * height
    }

    private fun stateFor(
        entityId: Int,
        base: Pair<Float, Float>,
        width: Float,
        height: Float,
        nowMs: Long
    ): WanderState {
        val state = states.getOrPut(entityId) {
            val x = (base.first / width).coerceIn(MIN_X_PCT, MAX_X_PCT)
            val y = (base.second / height).coerceIn(MIN_Y_PCT, MAX_Y_PCT)
            val target = randomTarget()
            WanderState(
                xPct = x,
                yPct = y,
                targetXPct = target.first,
                targetYPct = target.second,
                lastUpdateMs = nowMs,
                idleUntilMs = nowMs + randomLong(0L, MAX_IDLE_MS),
                retargetAtMs = nowMs + randomLong(MIN_RETARGET_MS, MAX_RETARGET_MS),
                moving = false,
                motionState = MotionState.WANDERING
            )
        }
        coerceToSafeBounds(state)
        return state
    }

    private fun commandState(entityId: Int): WanderState {
        return states.getOrPut(entityId) {
            WanderState(
                xPct = 0.5f,
                yPct = 0.5f,
                targetXPct = 0.5f,
                targetYPct = 0.5f,
                lastUpdateMs = 0L,
                idleUntilMs = 0L,
                retargetAtMs = 0L,
                moving = false,
                motionState = MotionState.STOPPED
            )
        }
    }

    private fun moveTowardTarget(
        state: WanderState,
        width: Float,
        height: Float,
        speedPctPerSecond: Float,
        dtSeconds: Float
    ): Boolean {
        val dxPx = (state.targetXPct - state.xPct) * width
        val dyPx = (state.targetYPct - state.yPct) * height
        val distancePx = hypot(dxPx, dyPx)
        val stepPx = speedPctPerSecond * min(width, height) * dtSeconds

        if (distancePx <= stepPx || distancePx < ARRIVAL_EPSILON_PX) {
            state.xPct = state.targetXPct
            state.yPct = state.targetYPct
            state.moving = false
            return true
        }

        if (stepPx > 0f) {
            val fraction = (stepPx / distancePx).coerceAtMost(1f)
            state.xPct += (state.targetXPct - state.xPct) * fraction
            state.yPct += (state.targetYPct - state.yPct) * fraction
            state.moving = true
        }
        coerceToSafeBounds(state)
        return false
    }

    private fun retarget(state: WanderState, fromMs: Long) {
        val target = randomTarget()
        state.targetXPct = target.first
        state.targetYPct = target.second
        state.retargetAtMs = fromMs + randomLong(MIN_RETARGET_MS, MAX_RETARGET_MS)
    }

    private fun randomTarget(): Pair<Float, Float> {
        return randomFloat(MIN_X_PCT, MAX_X_PCT) to randomFloat(MIN_Y_PCT, MAX_Y_PCT)
    }

    private fun randomFloat(min: Float, max: Float): Float {
        if (max <= min) return min
        return min + random.nextFloat() * (max - min)
    }

    private fun randomLong(min: Long, max: Long): Long {
        if (max <= min) return min
        return min + random.nextLong(max - min + 1)
    }

    private fun coerceToSafeBounds(state: WanderState) {
        state.xPct = state.xPct.coerceIn(MIN_X_PCT, MAX_X_PCT)
        state.yPct = state.yPct.coerceIn(MIN_Y_PCT, MAX_Y_PCT)
    }

    companion object {
        const val DEFAULT_WANDER_SPEED_PCT_PER_SECOND = 0.04f
        const val DEFAULT_TARGET_SPEED_PCT_PER_SECOND = 0.12f
        private const val ARRIVAL_EPSILON_PX = 1f
        private const val MAX_IDLE_MS = 3000L
        private const val MIN_RETARGET_MS = 3000L
        private const val MAX_RETARGET_MS = 8000L
        private const val MIN_X_PCT = 0.08f
        private const val MAX_X_PCT = 0.92f
        private const val MIN_Y_PCT = 0.12f
        private const val MAX_Y_PCT = 0.82f
        const val WALKING_STATE_ASSET = "WALKING"
    }
}
